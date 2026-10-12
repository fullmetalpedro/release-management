export type ProviderId = 'azure-devops' | 'github' | 'jira';
import { localeTag, t } from './i18n';
export type BoardColumnId = 'dependsOnMe' | 'review' | 'conflict' | 'ready';

export interface PersonView {
  name: string;
  isMe: boolean;
  avatarKey?: string;
}

export interface Me {
  user: { name: string; email?: string; avatarKey?: string };
  demo: boolean;
  mode: 'microsoft' | 'demo' | 'pat';
  loginProvider: 'microsoft';
  organization: string;
  // De onde vêm os PRs e de onde vêm as tasks; sem tracker (GitHub sem Jira) não há tasks a vincular.
  source: { provider: ProviderId; name: string } | null;
  tracker: { provider: ProviderId; name: string } | null;
  accounts: { provider: ProviderId; connected: boolean; active?: boolean; handle?: string; account?: string }[];
}

export interface ProjectView {
  id: string;
  name: string;
  openPullRequests: number;
}

export interface PullRequestCard {
  id: number;
  provider: ProviderId;
  title: string;
  repository: { id: string; name: string };
  targetBranch: string;
  author: PersonView;
  createdAt: string;
  commentCount: number;
  conflictCount: number;
  approvals: number;
  reviewers: number;
  approved: boolean;
  reason?: 'reviewer' | 'waiting-author';
  requiredReviewer: boolean;
  webUrl: string;
}

export interface Board {
  syncedAt: string;
  openCount: number;
  columns: Record<BoardColumnId, PullRequestCard[]>;
  repositories: { id: string; name: string }[];
}

export interface LanePullRequest {
  id: number;
  title: string;
  author: PersonView;
  mergedAt?: string;
  webUrl: string;
}

export interface ReleaseView {
  name: string;
  isLatest: boolean;
  createdAt?: string;
  createdBy?: PersonView;
  baseBranch?: string;
  webUrl: string;
}

export interface ReleaseLane {
  syncedAt: string;
  repository: { id: string; name: string };
  merged: LanePullRequest[];
  suggestedBranch: string;
  baseBranch: string;
  release: (ReleaseView & { pullRequests: LanePullRequest[] }) | null;
}

export type WorkItemKind = 'pbi' | 'task' | 'bug' | 'other';
export type WorkItemStateCategory = 'todo' | 'in-progress' | 'testing' | 'done' | 'removed';

export interface WorkItemSummary {
  id: number;
  // Chave legível, quando a plataforma tem uma (PROJ-7 no Jira).
  key?: string;
  title: string;
  kind: WorkItemKind;
  state: { name: string; category: WorkItemStateCategory };
  webUrl: string;
}

export interface WorkItem extends WorkItemSummary {
  parent?: WorkItemSummary;
}

export interface ReleaseDetails {
  syncedAt: string;
  repository: { id: string; name: string };
  release: ReleaseView | null;
  summary: { pullRequests: number; tasks: number; pbis: number; unlinked: number };
  groups: {
    pbi: WorkItemSummary;
    tasks: number;
    pullRequests: number;
    rows: { task: WorkItemSummary | null; pullRequest: LanePullRequest }[];
  }[];
  unlinked: (LanePullRequest & { suggestedTerm: string })[];
}

export interface CreatedRelease {
  name: string;
  pullRequests: number;
  repository: string;
  webUrl: string;
}

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(payload.code ?? 'error'),
      String(payload.message ?? t('errors.http', { status: response.status })),
      payload,
    );
  }
  return payload as T;
}

const repo = (projectId: string, repositoryId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`;

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  logout: () => request<void>('POST', '/auth/logout'),
  setActiveSource: (provider: ProviderId) => request<void>('POST', '/auth/active', { provider }),
  projects: () => request<ProjectView[]>('GET', '/api/projects'),
  board: (projectId: string) => request<Board>('GET', `/api/projects/${encodeURIComponent(projectId)}/board`),
  lanes: (projectId: string) =>
    request<{ syncedAt: string; lanes: ReleaseLane[] }>('GET', `/api/projects/${encodeURIComponent(projectId)}/lanes`),
  lane: (projectId: string, repositoryId: string) =>
    request<ReleaseLane>('GET', `${repo(projectId, repositoryId)}/lane`),
  release: (projectId: string, repositoryId: string, branch?: string) =>
    request<ReleaseDetails>(
      'GET',
      `${repo(projectId, repositoryId)}/release${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
    ),
  createRelease: (projectId: string, repositoryId: string, name: string, pullRequestIds: number[]) =>
    request<CreatedRelease>('POST', `${repo(projectId, repositoryId)}/releases`, { name, pullRequestIds }),
  searchWorkItems: (projectId: string, term: string) =>
    request<WorkItem[]>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/work-items?q=${encodeURIComponent(term)}`,
    ),
  linkWorkItem: (projectId: string, repositoryId: string, pullRequestId: number, workItemId: number) =>
    request<void>('PUT', `${repo(projectId, repositoryId)}/pull-requests/${pullRequestId}/work-items/${workItemId}`),
  unlinkWorkItem: (projectId: string, repositoryId: string, pullRequestId: number, workItemId: number) =>
    request<void>(
      'DELETE',
      `${repo(projectId, repositoryId)}/pull-requests/${pullRequestId}/work-items/${workItemId}`,
    ),
};
