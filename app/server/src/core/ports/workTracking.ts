import type { PullRequestRef, WorkItem } from '../domain/types.ts';

export interface WorkTracking {
  listWorkItemsForPullRequest(ref: PullRequestRef): Promise<WorkItem[]>;
  // Tasks e bugs cujo título contém o termo (ou cujo id é o termo).
  searchWorkItems(projectId: string, term: string): Promise<WorkItem[]>;
  linkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void>;
  unlinkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void>;
}
