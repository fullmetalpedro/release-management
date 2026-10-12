import { CherryPickConflictError, NotFoundError, ProviderUnavailableError, ValidationError } from '../../core/domain/errors.ts';
import type {
  Person,
  Project,
  PullRequest,
  PullRequestRef,
  ReleaseBranch,
  Repository,
  WorkItem,
  WorkItemSummary,
} from '../../core/domain/types.ts';
import type { CreateReleaseBranchInput, SourceControl } from '../../core/ports/sourceControl.ts';
import type { WorkTracking } from '../../core/ports/workTracking.ts';
import type { MemoryWorkItem, World } from './world.ts';
import { msg } from '../../i18n.ts';

export interface MemoryFaults {
  // Simula o provedor fora do ar na listagem do board.
  failSync?: boolean;
  // PRs cujo cherry-pick conflita.
  conflictingPullRequestIds?: number[];
  latencyMs?: number;
}

export class MemorySourceControl implements SourceControl {
  constructor(
    private readonly world: World,
    private readonly faults: MemoryFaults = {},
  ) {}

  private async delay() {
    if (this.faults.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.faults.latencyMs));
  }

  async currentUser(): Promise<Person> {
    return this.world.me;
  }

  async getAvatar(): Promise<undefined> {
    return undefined;
  }

  async listProjects(): Promise<Project[]> {
    return this.world.projects;
  }

  async listRepositories(projectId: string): Promise<Repository[]> {
    return this.world.repositories.filter((r) => r.projectId === projectId);
  }

  async countOpenPullRequests(projectId: string): Promise<number> {
    return this.openOf(projectId).length;
  }

  async listOpenPullRequests(projectId: string): Promise<PullRequest[]> {
    await this.delay();
    if (this.faults.failSync) throw new ProviderUnavailableError('azure-devops', msg('providerDown', { provider: 'Azure DevOps' }));
    return this.openOf(projectId);
  }

  async listMergedPullRequests(repository: Repository, targetBranch: string): Promise<PullRequest[]> {
    await this.delay();
    return this.world.pullRequests.filter(
      (pr) => pr.repository.id === repository.id && pr.status === 'merged' && pr.targetBranch === targetBranch,
    );
  }

  async getPullRequests(repository: Repository, ids: number[]): Promise<PullRequest[]> {
    return this.world.pullRequests.filter((pr) => pr.repository.id === repository.id && ids.includes(pr.id));
  }

  async existingBranches(_repository: Repository, names: string[]): Promise<string[]> {
    return names.filter((name) => name === 'main' || name === 'develop');
  }

  async listReleaseBranches(repository: Repository): Promise<ReleaseBranch[]> {
    return this.world.releases
      .filter((release) => release.repositoryId === repository.id)
      .map((release) => ({
        name: release.name,
        repository,
        createdAt: release.createdAt,
        createdBy: release.createdBy,
        baseBranch: release.baseBranch,
        webUrl: `https://dev.azure.com/demo/${repository.projectId}/_git/${repository.name}?version=GB${encodeURIComponent(release.name)}`,
      }));
  }

  async listPullRequestIdsInBranch(repository: Repository, branch: string): Promise<number[]> {
    const release = this.world.releases.find((r) => r.repositoryId === repository.id && r.name === branch);
    return release?.pullRequestIds ?? [];
  }

  async listPullRequestIdsMergedInto(): Promise<number[]> {
    return [];
  }

  async createReleaseBranch(input: CreateReleaseBranchInput): Promise<ReleaseBranch> {
    await new Promise((resolve) => setTimeout(resolve, this.faults.latencyMs ?? 0));
    const conflicting = input.pullRequestIds.find((id) => this.faults.conflictingPullRequestIds?.includes(id));
    if (conflicting !== undefined) throw new CherryPickConflictError(conflicting, input.baseBranch);

    // Como nos provedores de verdade, criar uma branch que já existe falha.
    if (this.world.releases.some((r) => r.repositoryId === input.repository.id && r.name === input.name)) {
      throw new ValidationError(msg('branchExists', { branch: input.name }));
    }
    this.world.releases.push({
      name: input.name,
      repositoryId: input.repository.id,
      createdAt: new Date().toISOString(),
      createdBy: this.world.me,
      baseBranch: input.baseBranch,
      pullRequestIds: [...input.pullRequestIds],
    });
    const [created] = (await this.listReleaseBranches(input.repository)).filter((b) => b.name === input.name);
    return created!;
  }

  private openOf(projectId: string) {
    return this.world.pullRequests.filter((pr) => pr.status === 'open' && pr.repository.projectId === projectId);
  }
}

export class MemoryWorkTracking implements WorkTracking {
  constructor(private readonly world: World) {}

  async listWorkItemsForPullRequest(ref: PullRequestRef): Promise<WorkItem[]> {
    return this.world.workItems
      .filter((item) => item.pullRequestIds.includes(ref.pullRequestId))
      .map((item) => this.toWorkItem(item));
  }

  async searchWorkItems(projectId: string, term: string): Promise<WorkItem[]> {
    const normalized = term.toLowerCase();
    return this.world.workItems
      .filter((item) => item.projectId === projectId && (item.kind === 'task' || item.kind === 'bug'))
      .filter((item) => String(item.id) === term || item.title.toLowerCase().includes(normalized))
      .sort((a, b) => b.id - a.id)
      .slice(0, 8)
      .map((item) => this.toWorkItem(item));
  }

  async linkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void> {
    const item = this.find(workItemId);
    if (!item.pullRequestIds.includes(ref.pullRequestId)) item.pullRequestIds.push(ref.pullRequestId);
  }

  async unlinkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void> {
    const item = this.find(workItemId);
    item.pullRequestIds = item.pullRequestIds.filter((id) => id !== ref.pullRequestId);
  }

  private find(id: number): MemoryWorkItem {
    const item = this.world.workItems.find((w) => w.id === id);
    if (!item) throw new NotFoundError(msg('workItemNotFound', { id }));
    return item;
  }

  private toSummary(item: MemoryWorkItem): WorkItemSummary {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      state: item.state,
      webUrl: `https://dev.azure.com/demo/_workitems/edit/${item.id}`,
    };
  }

  private toWorkItem(item: MemoryWorkItem): WorkItem {
    const parent = this.world.workItems.find((w) => w.id === item.parentId);
    return { ...this.toSummary(item), parent: parent && this.toSummary(parent) };
  }
}
