import { AzureDevOpsClient, basicFromPat, bearer, type FetchLike } from './adapters/azure-devops/client.ts';
import { AzureDevOpsSourceControl } from './adapters/azure-devops/sourceControl.ts';
import { AzureDevOpsWorkTracking } from './adapters/azure-devops/workTracking.ts';
import { GitHubSourceControl } from './adapters/github/sourceControl.ts';
import { JiraWorkTracking, NoWorkTracking } from './adapters/jira/workTracking.ts';
import { MemorySourceControl, MemoryWorkTracking } from './adapters/memory/memoryAdapters.ts';
import { createWorld } from './adapters/memory/world.ts';
import { connectionOf, type Capability, type PatConnection, type Session, type SessionStore } from './adapters/session/sessionStore.ts';
import type { AppConfig } from './config.ts';
import { ConnectionExpiredError, NotAuthenticatedError, ValidationError, WriteNotAllowedError } from './core/domain/errors.ts';
import type { IdentityProvider, TokenSet } from './core/ports/identityProvider.ts';
import type { SourceControl } from './core/ports/sourceControl.ts';
import type { WorkTracking } from './core/ports/workTracking.ts';
import { msg } from './i18n.ts';

export interface Connection {
  sourceControl: SourceControl;
  workTracking: WorkTracking;
}

// Uma organização de onde vêm PRs, para quem agrega todas (a caixa de entrada).
export interface SourceEntry {
  id: string;
  provider: 'azure-devops' | 'github';
  account: string;
  // Token já recusado: a entrada aparece só como aviso, sem chamar o provedor.
  expired: boolean;
  connection?: Connection;
}

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

// Decide, por sessão, quais adapters atendem as portas do núcleo.
export class ConnectionRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly refreshing = new Map<string, Promise<TokenSet>>();
  private readonly demoWorld = createWorld();

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
    private readonly identityProvider?: IdentityProvider,
  ) {}

  for(session: Session): Connection {
    let connection = this.connections.get(session.id);
    if (!connection) {
      connection =
        session.mode === 'demo'
          ? this.demoConnection()
          : session.mode === 'pat'
            ? this.patConnection(session)
            : this.azureDevOps(this.config.organization, async () => bearer(await this.accessToken(session.id)));
      this.connections.set(session.id, connection);
    }
    return connection;
  }

  // Todas as organizações da sessão que fornecem PRs, cada uma com os próprios adapters. `fetchImpl` permite que
  // quem agrega limite as requisições somando todas elas. Sem modo token, a sessão tem uma organização só.
  sources(session: Session, fetchImpl?: FetchLike): SourceEntry[] {
    if (session.mode !== 'pat') {
      const account = session.mode === 'demo' ? 'demo' : this.config.organization;
      return [{ id: `azure-devops:${account.toLowerCase()}`, provider: 'azure-devops', account, expired: false, connection: this.for(session) }];
    }
    return Object.entries(session.connections ?? {})
      .filter(([, connection]) => connection.provider !== 'jira')
      .sort(([, a], [, b]) => a.provider.localeCompare(b.provider) || a.account.localeCompare(b.account))
      .map(([id, connection]) => ({
        id,
        provider: connection.provider as SourceEntry['provider'],
        account: connection.account,
        expired: !!connection.expiredAt,
        connection: connection.expiredAt ? undefined : this.sourceConnection(session, id, fetchImpl),
      }));
  }

  forget(sessionId: string) {
    this.connections.delete(sessionId);
  }

  private demoConnection(): Connection {
    return {
      sourceControl: new MemorySourceControl(this.demoWorld, this.config.demoFaults),
      workTracking: new MemoryWorkTracking(this.demoWorld),
    };
  }

  // Abre o token de uma conexão no instante do uso; se ela sumiu da sessão, a chamada falha como não autenticada.
  private token(sessionId: string, id: string): string {
    const connection = connectionOf(this.sessions.get(sessionId), id);
    if (!connection) throw new NotAuthenticatedError();
    if (connection.expiredAt) throw new ConnectionExpiredError(id, connection.account);
    return this.sessions.open(connection.sealedToken);
  }

  // No modo token, a conexão ativa fornece os PRs.
  private patConnection(session: Session): Connection {
    return this.sourceConnection(session, session.activeConnection);
  }

  // Os adapters de uma organização. As tarefas vêm do próprio Azure DevOps ou, com o GitHub, do Jira (se estiver
  // conectado).
  private sourceConnection(session: Session, id: string | undefined, fetchImpl?: FetchLike): Connection {
    const connections = session.connections ?? {};
    const { branching } = this.config;
    const active = connectionOf(session, id);

    if (id && active?.provider === 'azure-devops') {
      const { sourceControl, workTracking } = this.azureDevOps(active.account, async () => basicFromPat(this.token(session.id, id)), fetchImpl);
      const verify = () => sourceControl.listProjects();
      return { sourceControl: expiringAs(id, active, sourceControl, verify), workTracking: expiringAs(id, active, workTracking, verify) };
    }
    if (id && active?.provider === 'github') {
      const [jiraId, jira] = Object.entries(connections).find(([, connection]) => connection.provider === 'jira') ?? [];
      const github = new GitHubSourceControl(
        { owner: active.account, releasePattern: branching.releasePattern, developBranch: branching.developBranch },
        async () => this.token(session.id, id),
        fetchImpl,
      );
      const tracking =
        jiraId && jira?.cloudId && jira.email
          ? new JiraWorkTracking({ site: jira.account, cloudId: jira.cloudId, email: jira.email }, async () => this.token(session.id, jiraId))
          : undefined;
      return {
        sourceControl: expiringAs(id, active, github, () => github.listRepositories(active.account)),
        workTracking: tracking ? expiringAs(jiraId!, jira!, tracking, () => tracking.currentUser()) : new NoWorkTracking(),
      };
    }
    throw new ValidationError(msg('connectSource'));
  }

  private azureDevOps(organization: string, authorization: () => Promise<string>, fetchImpl?: FetchLike): Connection {
    const client = new AzureDevOpsClient(organization, authorization, fetchImpl);
    return {
      sourceControl: new AzureDevOpsSourceControl(client, {
        releasePattern: this.config.branching.releasePattern,
        developBranch: this.config.branching.developBranch,
      }),
      workTracking: new AzureDevOpsWorkTracking(client),
    };
  }

  private async accessToken(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session?.tokens || !this.identityProvider) throw new NotAuthenticatedError();
    if (session.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.tokens.accessToken;
    if (!session.tokens.refreshToken) throw new NotAuthenticatedError();

    // Várias chamadas em paralelo compartilham o mesmo refresh.
    let pending = this.refreshing.get(sessionId);
    if (!pending) {
      pending = this.identityProvider
        .refresh(session.tokens.refreshToken)
        .then((tokens) => {
          this.sessions.updateTokens(sessionId, tokens);
          return tokens;
        })
        .finally(() => this.refreshing.delete(sessionId));
      this.refreshing.set(sessionId, pending);
    }
    return (await pending).accessToken;
  }
}

// Métodos das portas que escrevem no provedor, e a ação que cada um representa.
const WRITES: Partial<Record<string, Capability>> = {
  createReleaseBranch: 'createRelease',
  linkPullRequest: 'linkWorkItems',
  unlinkPullRequest: 'linkWorkItems',
};

// Um token recusado pelo provedor vira a expiração daquela conexão, e não da sessão: o erro diz qual conexão caiu.
// Numa escrita, a recusa pode ser só falta de permissão de escrita (token só de leitura); `verify` faz uma leitura
// que separa os dois casos: se ela passa, só a ação fica bloqueada e a conexão continua valendo.
export function expiringAs<T extends object>(id: string, connection: PatConnection, target: T, verify?: () => Promise<unknown>): T {
  const expired = (error: unknown): never => {
    throw error instanceof NotAuthenticatedError ? new ConnectionExpiredError(id, connection.account) : error;
  };
  const refusedWrite = async (error: unknown, capability: Capability): Promise<never> => {
    if (!(error instanceof NotAuthenticatedError) || !verify) return expired(error);
    try {
      await verify();
    } catch (check) {
      return expired(check);
    }
    throw new WriteNotAllowedError(id, connection.account, capability);
  };
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      const capability = typeof property === 'string' ? WRITES[property] : undefined;
      const onError = capability ? (error: unknown) => refusedWrite(error, capability) : expired;
      return (...args: unknown[]) => {
        try {
          const result = value.apply(object, args);
          return result instanceof Promise ? result.catch(onError) : result;
        } catch (error) {
          return onError(error);
        }
      };
    },
  });
}
