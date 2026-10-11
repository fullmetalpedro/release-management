import type { Avatar, Person, Project, PullRequest, ReleaseBranch, Repository } from '../domain/types.ts';

export interface CreateReleaseBranchInput {
  repository: Repository;
  name: string;
  baseBranch: string;
  // Na ordem em que devem ser aplicados.
  pullRequestIds: number[];
}

export interface SourceControl {
  currentUser(): Promise<Person>;
  // Foto da pessoa, ou undefined quando o provedor não tem uma.
  getAvatar(avatarKey: string): Promise<Avatar | undefined>;
  listProjects(): Promise<Project[]>;
  listRepositories(projectId: string): Promise<Repository[]>;
  countOpenPullRequests(projectId: string): Promise<number>;
  listOpenPullRequests(projectId: string): Promise<PullRequest[]>;
  listMergedPullRequests(repository: Repository, targetBranch: string): Promise<PullRequest[]>;
  getPullRequests(repository: Repository, ids: number[]): Promise<PullRequest[]>;
  // Dos nomes pedidos, os que existem como branch no repositório, na mesma ordem.
  existingBranches(repository: Repository, names: string[]): Promise<string[]>;
  // Mais recente primeiro.
  listReleaseBranches(repository: Repository): Promise<ReleaseBranch[]>;
  // Ids dos PRs cujos commits estão em `branch` e não em `comparedTo`.
  listPullRequestIdsInBranch(repository: Repository, branch: string, comparedTo: string): Promise<number[]>;
  // Ids dos PRs que já chegaram a `branch` desde `since` (ISO).
  listPullRequestIdsMergedInto(repository: Repository, branch: string, since: string): Promise<number[]>;
  // Tudo ou nada: lança CherryPickConflictError sem deixar a branch criada.
  createReleaseBranch(input: CreateReleaseBranchInput): Promise<ReleaseBranch>;
}
