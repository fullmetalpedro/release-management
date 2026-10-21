import { ConnectionExpiredError, NotAuthenticatedError } from '../domain/errors.ts';
import type { SourceControl } from '../ports/sourceControl.ts';
import { getAllProjectsBoard, type AllProjectsCard } from './allProjectsBoard.ts';

// Requisições simultâneas ao provedor, somando todas as organizações da caixa de entrada.
export const INBOX_CONCURRENCY = 6;

export interface InboxSource {
  id: string;
  provider: 'azure-devops' | 'github';
  account: string;
  expired: boolean;
  sourceControl?: SourceControl;
}

export interface InboxItem extends AllProjectsCard {
  connectionId: string;
  account: string;
}

export interface InboxConnection {
  id: string;
  provider: InboxSource['provider'];
  account: string;
  // ok: os PRs da organização estão na lista. expired: o token foi recusado e a organização pede para reconectar.
  // failed: o provedor falhou e a organização ficou de fora desta vez.
  status: 'ok' | 'expired' | 'failed';
  reason?: string;
  // Quando o token foi recusado (ISO), para o aviso dizer desde quando.
  expiredAt?: string;
  count: number;
  // Projetos que não carregaram ou que passaram do limite do board de todos os projetos.
  failedProjects: { project: string; reason: string }[];
  skippedProjects: number;
}

export interface Inbox {
  syncedAt: string;
  items: InboxItem[];
  connections: InboxConnection[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// "Depende de mim" de todas as organizações e projetos. Uma organização que falha ou expira vira aviso e não derruba
// as outras; `onExpired` deixa quem chama marcar a conexão como expirada.
export async function getInbox(
  sources: InboxSource[],
  options: { now?: () => Date; reasonOf?: (error: unknown) => string; onExpired?: (id: string) => void; allowed?: string[] } = {},
): Promise<Inbox> {
  const reasonOf = options.reasonOf ?? messageOf;
  const results = await Promise.all(
    sources.map(async (source): Promise<{ connection: InboxConnection; items: InboxItem[] }> => {
      const base = { id: source.id, provider: source.provider, account: source.account, count: 0, failedProjects: [], skippedProjects: 0 };
      if (source.expired || !source.sourceControl) return { connection: { ...base, status: 'expired' }, items: [] };
      try {
        const board = await getAllProjectsBoard({ sourceControl: source.sourceControl, now: options.now, reasonOf }, options.allowed);
        const items = board.items
          .filter((item) => item.column === 'dependsOnMe')
          .map((item) => ({ ...item, connectionId: source.id, account: source.account }));
        return {
          connection: {
            ...base,
            status: 'ok',
            count: items.length,
            failedProjects: board.failed.map(({ project, reason }) => ({ project: project.name, reason })),
            skippedProjects: board.skipped,
          },
          items,
        };
      } catch (error) {
        if (error instanceof ConnectionExpiredError) {
          options.onExpired?.(error.connectionId);
          return { connection: { ...base, status: 'expired' }, items: [] };
        }
        // Sessão vencida (login Microsoft) vale para tudo: quem chama encerra a sessão.
        if (error instanceof NotAuthenticatedError) throw error;
        return { connection: { ...base, status: 'failed', reason: reasonOf(error) }, items: [] };
      }
    }),
  );

  return {
    syncedAt: (options.now?.() ?? new Date()).toISOString(),
    items: results.flatMap((result) => result.items),
    connections: results.map((result) => result.connection),
  };
}
