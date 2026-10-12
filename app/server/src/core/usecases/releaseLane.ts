import { mapLimit, withLock } from '../concurrency.ts';
import { NotFoundError, ProviderUnavailableError, ValidationError } from '../domain/errors.ts';
import type { Person, PullRequest, ReleaseBranch, Repository } from '../domain/types.ts';
import type { SourceControl } from '../ports/sourceControl.ts';
import { toPersonView, type PersonView } from './board.ts';
import { compareVersionsDesc, isValidBranchName, nextReleaseName } from './releaseNaming.ts';
import { msg } from '../../i18n.ts';

export interface BranchingConfig {
  developBranch: string;
  // Candidatas a base da release, em ordem de preferência (repositórios antigos usam master).
  baseBranches: string[];
  // Regex (texto) que diz quais branches são release.
  releasePattern: string;
  // Nome sugerido para a primeira release de um repositório que ainda não tem nenhuma.
  firstRelease: string;
}

export async function resolveBaseBranch(
  sourceControl: SourceControl,
  repository: Repository,
  branching: BranchingConfig,
): Promise<string> {
  const [first] = await sourceControl.existingBranches(repository, branching.baseBranches);
  return first ?? branching.baseBranches[0] ?? 'main';
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

export function toLanePullRequest(pr: PullRequest, me: Person): LanePullRequest {
  return {
    id: pr.id,
    title: pr.title,
    author: toPersonView(pr.author, me),
    mergedAt: pr.closedAt,
    webUrl: pr.webUrl,
  };
}

export function toReleaseView(branch: ReleaseBranch, me: Person, isLatest: boolean): ReleaseView {
  return {
    name: branch.name,
    isLatest,
    createdAt: branch.createdAt,
    createdBy: branch.createdBy && toPersonView(branch.createdBy, me),
    baseBranch: branch.baseBranch,
    webUrl: branch.webUrl,
  };
}

export async function findRepository(
  sourceControl: SourceControl,
  projectId: string,
  repositoryId: string,
): Promise<Repository> {
  const repositories = await sourceControl.listRepositories(projectId);
  const repository = repositories.find((r) => r.id === repositoryId);
  if (!repository) throw new NotFoundError(msg('repositoryNotFound'));
  return repository;
}

export async function sortedReleaseBranches(sourceControl: SourceControl, repository: Repository) {
  const branches = await sourceControl.listReleaseBranches(repository);
  return [...branches].sort((a, b) => compareVersionsDesc(a.name, b.name));
}

// PRs de uma release: o que ela tem a mais que a base; se já voltou para a base, o que tem a mais que a release anterior.
export async function pullRequestIdsOfRelease(
  sourceControl: SourceControl,
  repository: Repository,
  branches: ReleaseBranch[],
  index: number,
  baseBranch: string,
): Promise<number[]> {
  const branch = branches[index]!;
  const againstBase = await sourceControl.listPullRequestIdsInBranch(repository, branch.name, baseBranch);
  const previous = branches[index + 1];
  if (againstBase.length > 0 || !previous) return againstBase;
  return sourceControl.listPullRequestIdsInBranch(repository, branch.name, previous.name);
}

const byMergeDateDesc = (a: PullRequest, b: PullRequest) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '');

export async function getReleaseLane(
  deps: { sourceControl: SourceControl; now?: () => Date },
  input: { projectId: string; repositoryId: string; branching: BranchingConfig },
): Promise<ReleaseLane> {
  const { sourceControl } = deps;
  const [me, repository] = await Promise.all([
    sourceControl.currentUser(),
    findRepository(sourceControl, input.projectId, input.repositoryId),
  ]);
  return laneOf(sourceControl, me, repository, input.branching, deps.now?.() ?? new Date());
}

const LANES_IN_PARALLEL = 4;

// Todas as raias do projeto de uma vez, para trocar de repositório no board sem nova sincronização.
// Um repositório que falha fica de fora e é buscado sozinho quando o usuário o escolher.
export async function getReleaseLanes(
  deps: { sourceControl: SourceControl; now?: () => Date },
  input: { projectId: string; branching: BranchingConfig },
): Promise<{ syncedAt: string; lanes: ReleaseLane[] }> {
  const { sourceControl } = deps;
  const now = deps.now?.() ?? new Date();
  const [me, repositories] = await Promise.all([
    sourceControl.currentUser(),
    sourceControl.listRepositories(input.projectId),
  ]);
  const lanes = await mapLimit(repositories, LANES_IN_PARALLEL, async (repository) => {
    try {
      return await laneOf(sourceControl, me, repository, input.branching, now);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return undefined;
      throw error;
    }
  });
  return { syncedAt: now.toISOString(), lanes: lanes.filter((lane) => lane !== undefined) };
}

async function laneOf(
  sourceControl: SourceControl,
  me: Person,
  repository: Repository,
  branching: BranchingConfig,
  now: Date,
): Promise<ReleaseLane> {
  const [branches, candidates, baseBranch] = await Promise.all([
    sortedReleaseBranches(sourceControl, repository),
    sourceControl.listMergedPullRequests(repository, branching.developBranch),
    resolveBaseBranch(sourceControl, repository, branching),
  ]);

  // As três releases mais recentes cobrem o que ainda não voltou para a base.
  const recent = branches.slice(0, 3);
  const idsPerRelease = await Promise.all(
    recent.map((_, i) => pullRequestIdsOfRelease(sourceControl, repository, branches, i, baseBranch)),
  );

  const oldest = candidates.reduce<string | undefined>(
    (min, pr) => (pr.closedAt && (!min || pr.closedAt < min) ? pr.closedAt : min),
    undefined,
  );
  const inBase = oldest
    ? await sourceControl.listPullRequestIdsMergedInto(repository, baseBranch, oldest)
    : [];
  const released = new Set<number>([...inBase, ...idsPerRelease.flat()]);

  const latest = branches[0];
  const latestIds = idsPerRelease[0] ?? [];
  const latestPullRequests = latest ? await sourceControl.getPullRequests(repository, latestIds) : [];

  return {
    syncedAt: now.toISOString(),
    repository: { id: repository.id, name: repository.name },
    merged: candidates
      .filter((pr) => !released.has(pr.id))
      .sort(byMergeDateDesc)
      .map((pr) => toLanePullRequest(pr, me)),
    suggestedBranch: nextReleaseName(latest?.name, branching.firstRelease),
    baseBranch,
    release: latest
      ? {
          ...toReleaseView(latest, me, true),
          pullRequests: latestPullRequests.sort(byMergeDateDesc).map((pr) => toLanePullRequest(pr, me)),
        }
      : null,
  };
}

export async function createRelease(
  deps: { sourceControl: SourceControl },
  input: {
    projectId: string;
    repositoryId: string;
    name: string;
    pullRequestIds: number[];
    branching: BranchingConfig;
  },
): Promise<{ name: string; pullRequests: number; repository: string; webUrl: string }> {
  const { sourceControl } = deps;
  const name = input.name.trim();
  if (!isValidBranchName(name)) throw new ValidationError(msg('invalidBranchName'));
  // Fora do padrão a branch seria criada, mas nunca reconhecida como release.
  if (!new RegExp(input.branching.releasePattern).test(name)) {
    throw new ValidationError(msg('branchOutsidePattern', { branch: name }));
  }
  const ids = [...new Set(input.pullRequestIds)];
  if (ids.length === 0) throw new ValidationError(msg('selectAtLeastOnePr'));

  const repository = await findRepository(sourceControl, input.projectId, input.repositoryId);
  // Uma criação por vez em cada repositório: dois pedidos simultâneos com o mesmo nome passariam juntos pela
  // verificação de "já existe" e os dois tentariam criar a branch.
  return withLock(`release:${repository.projectId}/${repository.id}`, () =>
    createInRepository(sourceControl, repository, name, ids, input.branching),
  );
}

async function createInRepository(
  sourceControl: SourceControl,
  repository: Repository,
  name: string,
  ids: number[],
  branching: BranchingConfig,
): Promise<{ name: string; pullRequests: number; repository: string; webUrl: string }> {
  const existing = await sourceControl.listReleaseBranches(repository);
  if (existing.some((b) => b.name === name)) throw new ValidationError(msg('branchExists', { branch: name }));

  const pullRequests = await sourceControl.getPullRequests(repository, ids);
  if (pullRequests.length !== ids.length || pullRequests.some((pr) => pr.status !== 'merged')) {
    throw new ValidationError(msg('onlyMergedPrs'));
  }
  // Aplicar na ordem em que foram mergeados reduz conflitos entre os próprios PRs.
  const ordered = [...pullRequests].sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));

  const branch = await sourceControl.createReleaseBranch({
    repository,
    name,
    baseBranch: await resolveBaseBranch(sourceControl, repository, branching),
    pullRequestIds: ordered.map((pr) => pr.id),
  });
  return { name: branch.name, pullRequests: ordered.length, repository: repository.name, webUrl: branch.webUrl };
}
