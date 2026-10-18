import { mapLimit } from '../concurrency.ts';
import { ConnectionExpiredError, NotAuthenticatedError } from '../domain/errors.ts';
import type { PullRequest } from '../domain/types.ts';
import type { SourceControl } from '../ports/sourceControl.ts';
import { classify, toCard, type BoardColumnId, type PullRequestCard } from './board.ts';
import { listProjects } from './projects.ts';

// Acima disso o board pede para escolher um projeto, em vez de abrir uma requisição por projeto da organização.
export const ALL_PROJECTS_LIMIT = 20;
// Requisições simultâneas ao provedor.
const CONCURRENCY = 4;

export interface ProjectRef {
  id: string;
  name: string;
}

export interface AllProjectsCard extends PullRequestCard {
  column: BoardColumnId;
  project: ProjectRef;
}

export interface AllProjectsBoard {
  syncedAt: string;
  // Projetos com PR aberto que entraram no board, na ordem do seletor.
  projects: ProjectRef[];
  // Cards de todos os projetos carregados; dentro de cada projeto, na ordem do provedor.
  items: AllProjectsCard[];
  // Projetos que não carregaram: os demais aparecem normalmente.
  failed: { project: ProjectRef; reason: string }[];
  // Projetos com PR aberto que ficaram de fora pelo limite.
  skipped: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Os PRs abertos de todos os projetos da conexão. Não depende da sessão: a caixa de entrada chama uma vez por conexão.
export async function getAllProjectsBoard(
  deps: { sourceControl: SourceControl; now?: () => Date; reasonOf?: (error: unknown) => string },
  allowed: string[] = [],
): Promise<AllProjectsBoard> {
  // Um passo de cada vez: assim nunca passam de CONCURRENCY requisições em andamento.
  const me = await deps.sourceControl.currentUser();
  const withPullRequests = (await listProjects(deps, allowed)).filter((project) => project.openPullRequests > 0);
  const selected = withPullRequests.slice(0, ALL_PROJECTS_LIMIT).map(({ id, name }) => ({ id, name }));

  type Result = { project: ProjectRef; pullRequests: PullRequest[] } | { project: ProjectRef; reason: string };
  const results = await mapLimit(selected, CONCURRENCY, async (project): Promise<Result> => {
    try {
      return { project, pullRequests: await deps.sourceControl.listOpenPullRequests(project.id) };
    } catch (error) {
      // Token recusado ou sessão vencida valem para a conexão inteira, não para um projeto.
      if (error instanceof ConnectionExpiredError || error instanceof NotAuthenticatedError) throw error;
      return { project, reason: (deps.reasonOf ?? messageOf)(error) };
    }
  });

  const items: AllProjectsCard[] = [];
  const failed: AllProjectsBoard['failed'] = [];
  for (const result of results) {
    if (!('pullRequests' in result)) {
      failed.push({ project: result.project, reason: result.reason });
      continue;
    }
    for (const pr of result.pullRequests) {
      const { column, reason } = classify(pr, me);
      items.push({ ...toCard(pr, me, reason), column, project: result.project });
    }
  }

  return {
    syncedAt: (deps.now?.() ?? new Date()).toISOString(),
    projects: selected,
    items,
    failed,
    skipped: withPullRequests.length - selected.length,
  };
}
