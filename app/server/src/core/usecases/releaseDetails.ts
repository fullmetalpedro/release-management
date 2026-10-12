import { NotFoundError } from '../domain/errors.ts';
import type { PullRequestRef, WorkItem, WorkItemSummary } from '../domain/types.ts';
import type { SourceControl } from '../ports/sourceControl.ts';
import type { WorkTracking } from '../ports/workTracking.ts';
import {
  findRepository,
  pullRequestIdsOfRelease,
  resolveBaseBranch,
  sortedReleaseBranches,
  toLanePullRequest,
  toReleaseView,
  type BranchingConfig,
  type LanePullRequest,
  type ReleaseView,
} from './releaseLane.ts';
import { msg } from '../../i18n.ts';

export interface ReleaseRow {
  task: WorkItemSummary | null;
  pullRequest: LanePullRequest;
}

export interface ReleaseGroup {
  pbi: WorkItemSummary;
  tasks: number;
  pullRequests: number;
  rows: ReleaseRow[];
}

export interface UnlinkedPullRequest extends LanePullRequest {
  suggestedTerm: string;
}

export interface ReleaseDetails {
  syncedAt: string;
  repository: { id: string; name: string };
  release: ReleaseView | null;
  summary: { pullRequests: number; tasks: number; pbis: number; unlinked: number };
  groups: ReleaseGroup[];
  unlinked: UnlinkedPullRequest[];
}

const STOPWORDS = new Set(['para', 'com', 'sem', 'por', 'dos', 'das', 'uma', 'the', 'and', 'for', 'with']);

// Termo inicial da busca de tasks: a palavra mais longa do título, sem o prefixo de commit convencional.
export function suggestSearchTerm(title: string): string {
  const withoutPrefix = title.replace(/^\s*\w+(\([^)]*\))?!?:\s*/, '');
  const words = withoutPrefix
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
  return words.reduce((longest, w) => (w.length > longest.length ? w : longest), '');
}

export function groupByWorkItem(
  entries: { pullRequest: LanePullRequest; workItems: WorkItem[] }[],
): Pick<ReleaseDetails, 'groups' | 'unlinked' | 'summary'> {
  const groups = new Map<number, ReleaseGroup>();
  const unlinked: UnlinkedPullRequest[] = [];

  for (const { pullRequest, workItems } of entries) {
    if (workItems.length === 0) {
      unlinked.push({ ...pullRequest, suggestedTerm: suggestSearchTerm(pullRequest.title) });
      continue;
    }
    for (const item of workItems) {
      const { parent, ...self } = item;
      const pbi = parent ?? self;
      let group = groups.get(pbi.id);
      if (!group) {
        group = { pbi, tasks: 0, pullRequests: 0, rows: [] };
        groups.set(pbi.id, group);
      }
      group.rows.push({ task: parent ? self : null, pullRequest });
    }
  }

  const list = [...groups.values()].sort((a, b) => a.pbi.id - b.pbi.id);
  const allTasks = new Set<number>();
  for (const group of list) {
    group.rows.sort((a, b) => (a.task?.id ?? 0) - (b.task?.id ?? 0));
    const tasks = new Set(group.rows.flatMap((r) => (r.task ? [r.task.id] : [])));
    tasks.forEach((id) => allTasks.add(id));
    group.tasks = tasks.size;
    group.pullRequests = new Set(group.rows.map((r) => r.pullRequest.id)).size;
  }

  return {
    groups: list,
    unlinked,
    summary: { pullRequests: entries.length, tasks: allTasks.size, pbis: list.length, unlinked: unlinked.length },
  };
}

export async function getReleaseDetails(
  deps: { sourceControl: SourceControl; workTracking: WorkTracking; now?: () => Date },
  input: { projectId: string; repositoryId: string; branch?: string; branching: BranchingConfig },
): Promise<ReleaseDetails> {
  const { sourceControl, workTracking } = deps;
  const [me, repository] = await Promise.all([
    sourceControl.currentUser(),
    findRepository(sourceControl, input.projectId, input.repositoryId),
  ]);
  const syncedAt = (deps.now?.() ?? new Date()).toISOString();
  const repositoryView = { id: repository.id, name: repository.name };

  const branches = await sortedReleaseBranches(sourceControl, repository);
  const index = input.branch ? branches.findIndex((b) => b.name === input.branch) : 0;
  const branch = branches[index];
  if (!branch) {
    if (input.branch) throw new NotFoundError(msg('branchNotFound', { branch: input.branch }));
    return {
      syncedAt,
      repository: repositoryView,
      release: null,
      summary: { pullRequests: 0, tasks: 0, pbis: 0, unlinked: 0 },
      groups: [],
      unlinked: [],
    };
  }

  const baseBranch = await resolveBaseBranch(sourceControl, repository, input.branching);
  const ids = await pullRequestIdsOfRelease(sourceControl, repository, branches, index, baseBranch);
  const pullRequests = await sourceControl.getPullRequests(repository, ids);
  const entries = await Promise.all(
    pullRequests
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .map(async (pr) => {
        const ref: PullRequestRef = {
          projectId: input.projectId,
          repositoryId: repository.id,
          pullRequestId: pr.id,
          title: pr.title,
          sourceBranch: pr.sourceBranch,
          webUrl: pr.webUrl,
        };
        return {
          pullRequest: toLanePullRequest(pr, me),
          workItems: await workTracking.listWorkItemsForPullRequest(ref),
        };
      }),
  );

  return {
    syncedAt,
    repository: repositoryView,
    release: toReleaseView(branch, me, index === 0),
    ...groupByWorkItem(entries),
  };
}
