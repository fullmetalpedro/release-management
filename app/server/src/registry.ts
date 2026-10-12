import { AzureDevOpsClient, basicFromPat, bearer } from './adapters/azure-devops/client.ts';
import { AzureDevOpsSourceControl } from './adapters/azure-devops/sourceControl.ts';
import { AzureDevOpsWorkTracking } from './adapters/azure-devops/workTracking.ts';
import { GitHubSourceControl } from './adapters/github/sourceControl.ts';
import { JiraWorkTracking, NoWorkTracking } from './adapters/jira/workTracking.ts';
import { MemorySourceControl, MemoryWorkTracking } from './adapters/memory/memoryAdapters.ts';
import { createWorld } from './adapters/memory/world.ts';
import type { PatProvider, Session, SessionStore } from './adapters/session/sessionStore.ts';
import type { AppConfig } from './config.ts';
import { NotAuthenticatedError, ValidationError } from './core/domain/errors.ts';
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
  private token(sessionId: string, provider: PatProvider): string {
    const connection = this.sessions.get(sessionId)?.connections?.[provider];
    if (!connection) throw new NotAuthenticatedError();
    return this.sessions.open(connection.sealedToken);
  }

  // No modo token, a plataforma ativa fornece os PRs. As tarefas vêm do próprio Azure DevOps ou,
  // com o GitHub ativo, do Jira (se estiver conectado).
  private patConnection(session: Session): Connection {
    const connections = session.connections ?? {};
    const { branching } = this.config;

    if (session.activeSource === 'azure-devops' && connections['azure-devops']) {
      return this.azureDevOps(connections['azure-devops'].account, async () =>
        basicFromPat(this.token(session.id, 'azure-devops')),
      );
    }
    if (session.activeSource === 'github' && connections.github) {
      const jira = connections.jira;
      return {
        sourceControl: new GitHubSourceControl(
          { owner: connections.github.account, releasePattern: branching.releasePattern, developBranch: branching.developBranch },
          async () => this.token(session.id, 'github'),
        ),
        workTracking:
          jira?.cloudId && jira.email
            ? new JiraWorkTracking({ site: jira.account, cloudId: jira.cloudId, email: jira.email }, async () =>
                this.token(session.id, 'jira'),
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
