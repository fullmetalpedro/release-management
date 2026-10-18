import { z } from 'zod';
import { localeTag, t } from './i18n';

// Formato de tudo o que o servidor responde. Os tipos da interface saem destes esquemas, e cada resposta é
// conferida contra eles ao chegar: um proxy no caminho pode devolver 200 com uma página de erro ou um JSON de outra
// coisa, e isso vira erro de sincronização em vez de quebrar a tela.

// Campo que pode faltar. O servidor omite; null é aceito e tratado igual.
const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? undefined);

const providerId = z.enum(['azure-devops', 'github', 'jira']);
export type ProviderId = z.infer<typeof providerId>;
export type BoardColumnId = 'dependsOnMe' | 'review' | 'conflict' | 'ready';

const repositoryRef = z.object({ id: z.string(), name: z.string() });
const projectRef = z.object({ id: z.string(), name: z.string() });

const personView = z.object({ name: z.string(), isMe: z.boolean(), avatarKey: optional(z.string()) });
export type PersonView = z.infer<typeof personView>;

const platform = z.object({ provider: providerId, name: z.string() });
const me = z.object({
  user: z.object({ name: z.string(), email: optional(z.string()), avatarKey: optional(z.string()) }),
  demo: z.boolean(),
  mode: z.enum(['microsoft', 'demo', 'pat']),
  organization: z.string(),
  // De onde vêm os PRs e de onde vêm as tasks; sem tracker (GitHub sem Jira) não há tasks a vincular.
  source: platform.nullable(),
  tracker: platform.nullable(),
  // Uma linha por organização conectada (modo token), agrupadas por plataforma; plataforma sem nenhuma aparece uma
  // vez, desconectada.
  accounts: z.array(
    z.object({
      id: optional(z.string()),
      provider: providerId,
      connected: z.boolean(),
      active: optional(z.boolean()),
      handle: optional(z.string()),
      account: optional(z.string()),
      // O provedor recusou o token: a organização pede para reconectar.
      expiredAt: optional(z.string()),
    }),
  ),
});
export type Me = z.infer<typeof me>;
export type Account = Me['accounts'][number];

const projectView = z.object({ id: z.string(), name: z.string(), openPullRequests: z.number() });
export type ProjectView = z.infer<typeof projectView>;

const pullRequestCard = z.object({
  id: z.number(),
  provider: providerId,
  title: z.string(),
  repository: repositoryRef,
  targetBranch: z.string(),
  author: personView,
  createdAt: z.string(),
  commentCount: z.number(),
  conflictCount: z.number(),
  approvals: z.number(),
  reviewers: z.number(),
  approved: z.boolean(),
  noReviewers: z.boolean(),
  reason: optional(z.enum(['reviewer', 'waiting-author'])),
  requiredReviewer: z.boolean(),
  waitingSince: z.string(),
  hasVotes: z.boolean(),
  webUrl: z.string(),
  // Só no board de todos os projetos: de qual projeto é o PR.
  project: optional(projectRef),
});
export type PullRequestCard = z.infer<typeof pullRequestCard>;

const cards = z.array(pullRequestCard).default([]);
const board = z.object({
  syncedAt: z.string(),
  columns: z.object({ dependsOnMe: cards, review: cards, conflict: cards, ready: cards }),
  repositories: z.array(repositoryRef),
});
export type Board = z.infer<typeof board>;

const allProjectsBoard = z.object({
  syncedAt: z.string(),
  projects: z.array(projectRef),
  items: z.array(
    pullRequestCard.extend({ column: z.enum(['dependsOnMe', 'review', 'conflict', 'ready']), project: projectRef }),
  ),
  failed: z.array(z.object({ project: projectRef, reason: z.string() })),
  skipped: z.number(),
});
export type AllProjectsBoard = z.infer<typeof allProjectsBoard>;

// O que depende de mim em todas as organizações conectadas. Uma organização expirada ou fora do ar vem em
// `connections` com o status, e os itens dela ficam de fora.
const inbox = z.object({
  syncedAt: z.string(),
  items: z.array(
    pullRequestCard.extend({
      column: z.enum(['dependsOnMe', 'review', 'conflict', 'ready']),
      project: projectRef,
      connectionId: z.string(),
      account: z.string(),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.string(),
      provider: z.enum(['azure-devops', 'github']),
      account: z.string(),
      status: z.enum(['ok', 'expired', 'failed']),
      reason: optional(z.string()),
      expiredAt: optional(z.string()),
      count: z.number(),
      failedProjects: z.array(z.object({ project: z.string(), reason: z.string() })),
      skippedProjects: z.number(),
    }),
  ),
});
export type Inbox = z.infer<typeof inbox>;
export type InboxItem = Inbox['items'][number];

const lanePullRequest = z.object({
  id: z.number(),
  title: z.string(),
  author: personView,
  mergedAt: optional(z.string()),
  webUrl: z.string(),
});
export type LanePullRequest = z.infer<typeof lanePullRequest>;

const releaseView = z.object({
  name: z.string(),
  isLatest: z.boolean(),
  createdAt: optional(z.string()),
  createdBy: optional(personView),
  baseBranch: optional(z.string()),
  webUrl: z.string(),
});
export type ReleaseView = z.infer<typeof releaseView>;

const releaseLane = z.object({
  syncedAt: z.string(),
  repository: repositoryRef,
  merged: z.array(lanePullRequest),
  suggestedBranch: z.string(),
  baseBranch: z.string(),
  release: releaseView.extend({ pullRequests: z.array(lanePullRequest) }).nullable(),
});
export type ReleaseLane = z.infer<typeof releaseLane>;

const releaseLanes = z.object({ syncedAt: z.string(), lanes: z.array(releaseLane) });

// Tipo ou estado que esta versão da interface ainda não conhece cai no genérico, em vez de invalidar a resposta.
const workItemKind = z.enum(['pbi', 'task', 'bug', 'other']).catch('other');
const workItemStateCategory = z.enum(['todo', 'in-progress', 'testing', 'done', 'removed']).catch('todo');
export type WorkItemKind = z.infer<typeof workItemKind>;
export type WorkItemStateCategory = z.infer<typeof workItemStateCategory>;

const workItemSummary = z.object({
  id: z.number(),
  // Chave legível, quando a plataforma tem uma (PROJ-7 no Jira).
  key: optional(z.string()),
  title: z.string(),
  kind: workItemKind,
  state: z.object({ name: z.string(), category: workItemStateCategory }),
  webUrl: z.string(),
});
export type WorkItemSummary = z.infer<typeof workItemSummary>;

const workItem = workItemSummary.extend({ parent: optional(workItemSummary) });
export type WorkItem = z.infer<typeof workItem>;

const releaseDetails = z.object({
  syncedAt: z.string(),
  repository: repositoryRef,
  release: releaseView.nullable(),
  summary: z.object({ pullRequests: z.number(), tasks: z.number(), pbis: z.number(), unlinked: z.number() }),
  groups: z.array(
    z.object({
      pbi: workItemSummary,
      tasks: z.number(),
      pullRequests: z.number(),
      rows: z.array(z.object({ task: workItemSummary.nullable(), pullRequest: lanePullRequest })),
    }),
  ),
  unlinked: z.array(lanePullRequest.extend({ suggestedTerm: z.string() })),
});
export type ReleaseDetails = z.infer<typeof releaseDetails>;

const createdRelease = z.object({ name: z.string(), pullRequests: z.number(), repository: z.string(), webUrl: z.string() });
export type CreatedRelease = z.infer<typeof createdRelease>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function request<T = void>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        // As mensagens de erro do servidor voltam no idioma da interface.
        'Accept-Language': localeTag(),
        // O servidor exige este cabeçalho nas escritas (proteção contra CSRF).
        ...(method !== 'GET' ? { 'X-Requested-With': 'fetch' } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', t('errors.offline'));
  }
  if (response.status === 204) return undefined as T;
  const parsed: unknown = await response.json().catch(() => undefined);
  const payload = isObject(parsed) ? parsed : {};
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(payload.code ?? 'error'),
      String(payload.message ?? t('errors.http', { status: response.status })),
      payload,
    );
  }
  if (!schema) return parsed as T;
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    console.warn(`Resposta inesperada de ${path}:`, z.prettifyError(checked.error));
    throw new ApiError(response.status, 'bad-response', t('errors.badResponse'));
  }
  return checked.data;
}

const get = <T,>(path: string, schema: z.ZodType<T>) => request('GET', path, undefined, schema);

const repo = (projectId: string, repositoryId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`;

export const api = {
  me: () => get('/api/me', me),
  logout: () => request('POST', '/auth/logout'),
  setActiveConnection: (connectionId: string) => request('POST', '/auth/active', { connectionId }),
  removeConnection: (connectionId: string) => request('DELETE', `/auth/connections/${encodeURIComponent(connectionId)}`),
  projects: () => get('/api/projects', z.array(projectView)),
  board: (projectId: string) => get(`/api/projects/${encodeURIComponent(projectId)}/board`, board),
  allProjectsBoard: () => get('/api/board/all', allProjectsBoard),
  inbox: () => get('/api/inbox', inbox),
  lanes: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/lanes`, releaseLanes),
  lane: (projectId: string, repositoryId: string) =>
    get(`${repo(projectId, repositoryId)}/lane`, releaseLane),
  release: (projectId: string, repositoryId: string, branch?: string) =>
    get(
      `${repo(projectId, repositoryId)}/release${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
      releaseDetails,
    ),
  createRelease: (projectId: string, repositoryId: string, name: string, pullRequestIds: number[]) =>
    request('POST', `${repo(projectId, repositoryId)}/releases`, { name, pullRequestIds }, createdRelease),
  searchWorkItems: (projectId: string, term: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/work-items?q=${encodeURIComponent(term)}`, z.array(workItem)),
  linkWorkItem: (projectId: string, repositoryId: string, pullRequestId: number, workItemId: number) =>
    request('PUT', `${repo(projectId, repositoryId)}/pull-requests/${pullRequestId}/work-items/${workItemId}`),
  unlinkWorkItem: (projectId: string, repositoryId: string, pullRequestId: number, workItemId: number) =>
    request(
      'DELETE',
      `${repo(projectId, repositoryId)}/pull-requests/${pullRequestId}/work-items/${workItemId}`,
    ),
};
