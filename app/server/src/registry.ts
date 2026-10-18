import { AzureDevOpsClient, basicFromPat, bearer } from './adapters/azure-devops/client.ts';
import { AzureDevOpsSourceControl } from './adapters/azure-devops/sourceControl.ts';
import { AzureDevOpsWorkTracking } from './adapters/azure-devops/workTracking.ts';
import { GitHubSourceControl } from './adapters/github/sourceControl.ts';
import { JiraWorkTracking, NoWorkTracking } from './adapters/jira/workTracking.ts';
import { MemorySourceControl, MemoryWorkTracking } from './adapters/memory/memoryAdapters.ts';
import { createWorld } from './adapters/memory/world.ts';
import { connectionOf, type PatConnection, type Session, type SessionStore } from './adapters/session/sessionStore.ts';
import type { AppConfig } from './config.ts';
import { ConnectionExpiredError, NotAuthenticatedError, ValidationError } from './core/domain/errors.ts';
import type { IdentityProvider, TokenSet } from './core/ports/identityProvider.ts';
import type { SourceControl } from './core/ports/sourceControl.ts';
import type { WorkTracking } from './core/ports/workTracking.ts';
import { msg } from './i18n.ts';

export interface Connection {
  sourceControl: SourceControl;
  workTracking: WorkTracking;
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

  // No modo token, a conexão ativa fornece os PRs. As tarefas vêm do próprio Azure DevOps ou,
  // com o GitHub ativo, do Jira (se estiver conectado).
  private patConnection(session: Session): Connection {
    const connections = session.connections ?? {};
    const { branching } = this.config;
    const id = session.activeConnection;
    const active = connectionOf(session, id);

    if (id && active?.provider === 'azure-devops') {
      const { sourceControl, workTracking } = this.azureDevOps(active.account, async () => basicFromPat(this.token(session.id, id)));
      return { sourceControl: expiringAs(id, active, sourceControl), workTracking: expiringAs(id, active, workTracking) };
    }
    if (id && active?.provider === 'github') {
      const [jiraId, jira] = Object.entries(connections).find(([, connection]) => connection.provider === 'jira') ?? [];
      return {
        sourceControl: expiringAs(
          id,
          active,
          new GitHubSourceControl(
            { owner: active.account, releasePattern: branching.releasePattern, developBranch: branching.developBranch },
            async () => this.token(session.id, id),
          ),
        ),
        workTracking:
          jiraId && jira?.cloudId && jira.email
            ? expiringAs(
                jiraId,
                jira,
                new JiraWorkTracking({ site: jira.account, cloudId: jira.cloudId, email: jira.email }, async () =>
                  this.token(session.id, jiraId),
                ),
              )
            : new NoWorkTracking(),
      };
    }
    throw new ValidationError(msg('connectSource'));
  }

  private azureDevOps(organization: string, authorization: () => Promise<string>): Connection {
    const client = new AzureDevOpsClient(organization, authorization);
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

// Um token recusado pelo provedor vira a expiração daquela conexão, e não da sessão: o erro diz qual conexão caiu.
export function expiringAs<T extends object>(id: string, connection: PatConnection, target: T): T {
  const expired = (error: unknown) => {
    throw error instanceof NotAuthenticatedError ? new ConnectionExpiredError(id, connection.account) : error;
  };
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result = value.apply(object, args);
          return result instanceof Promise ? result.catch(expired) : result;
        } catch (error) {
          return expired(error);
        }
      };
    },
  });
}
