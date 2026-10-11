import { NotFoundError, ValidationError } from '../domain/errors.ts';
import type { PullRequestRef, WorkItem } from '../domain/types.ts';
import type { SourceControl } from '../ports/sourceControl.ts';
import type { WorkTracking } from '../ports/workTracking.ts';
import { findRepository } from './releaseLane.ts';

export async function searchWorkItems(
  deps: { workTracking: WorkTracking },
  input: { projectId: string; term: string },
): Promise<WorkItem[]> {
  const term = input.term.trim();
  if (term.length < 2 && !/^\d+$/.test(term)) return [];
  return deps.workTracking.searchWorkItems(input.projectId, term);
}

interface Deps {
  sourceControl: SourceControl;
  workTracking: WorkTracking;
}

// Completa a referência com os dados do PR: a ferramenta de tarefas pode precisar do título e do endereço.
async function describe(deps: Deps, workItemId: number, ref: PullRequestRef): Promise<PullRequestRef> {
  if (!Number.isInteger(workItemId) || workItemId <= 0) throw new ValidationError('Work item inválido');
  if (!Number.isInteger(ref.pullRequestId) || ref.pullRequestId <= 0) throw new ValidationError('PR inválido');
  if (!ref.projectId || !ref.repositoryId) throw new ValidationError('Projeto e repositório são obrigatórios');
  const repository = await findRepository(deps.sourceControl, ref.projectId, ref.repositoryId);
  const [pullRequest] = await deps.sourceControl.getPullRequests(repository, [ref.pullRequestId]);
  if (!pullRequest) throw new NotFoundError(`PR #${ref.pullRequestId} não encontrado`);
  return { ...ref, title: pullRequest.title, sourceBranch: pullRequest.sourceBranch, webUrl: pullRequest.webUrl };
}

export async function linkWorkItem(deps: Deps, workItemId: number, ref: PullRequestRef) {
  await deps.workTracking.linkPullRequest(workItemId, await describe(deps, workItemId, ref));
}

export async function unlinkWorkItem(deps: Deps, workItemId: number, ref: PullRequestRef) {
  await deps.workTracking.unlinkPullRequest(workItemId, await describe(deps, workItemId, ref));
}
