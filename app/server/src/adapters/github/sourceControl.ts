import { randomBytes } from 'node:crypto';
import { mapLimit } from '../../core/concurrency.ts';
import { CherryPickConflictError, ProviderUnavailableError } from '../../core/domain/errors.ts';
import type {
  Avatar,
  MergeState,
  Person,
  Project,
  PullRequest,
  ReleaseBranch,
  Repository,
  Review,
} from '../../core/domain/types.ts';
import type { CreateReleaseBranchInput, SourceControl } from '../../core/ports/sourceControl.ts';
import { compareVersionsDesc, literalPrefix } from '../../core/usecases/releaseNaming.ts';
import { isHttpStatus, JsonClient, type FetchLike } from '../http-json.ts';

interface GhUser {
  id: number;
  login: string;
  name?: string | null;
}

interface GhPull {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: GhUser | null;
  base: { ref: string };
  head: { ref: string };
}

interface GqlActor {
  login: string;
  databaseId?: number;
  name?: string | null;
}

interface GqlPull {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  baseRefName: string;
  headRefName: string;
  totalCommentsCount: number | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: GqlActor | null;
  repository: { name: string };
  reviewRequests: { nodes: { requestedReviewer: GqlActor | Record<string, never> | null }[] };
  latestOpinionatedReviews: { nodes: { state: string; author: GqlActor | null }[] };
}

interface GhCommit {
  sha: string;
  message?: string;
  commit?: { message: string };
  parents: { sha: string }[];
  tree?: { sha: string };
}

const CONCURRENCY = 8;
const OPEN_PAGE = 50;
const OPEN_MAX_PAGES = 6;
const GHOST: Person = { id: 'ghost', name: 'ghost' };

const OPEN_PULLS = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${OPEN_PAGE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt mergeable baseRefName headRefName totalCommentsCount reviewDecision
        author { login ... on User { databaseId name } }
        repository { name }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login databaseId name } } } }
        latestOpinionatedReviews(first: 20) { nodes { state author { login ... on User { databaseId name } } } }
      }
    }
  }
}`;

function fromActor(actor: GqlActor | null): Person {
  if (!actor?.login) return GHOST;
  const id = actor.databaseId ? String(actor.databaseId) : actor.login;
  return { id, name: actor.name || actor.login, avatarKey: actor.databaseId ? id : undefined };
}

function fromUser(user: GhUser | null): Person {
  if (!user) return GHOST;
  return { id: String(user.id), name: user.name || user.login, avatarKey: String(user.id) };
}

export function toMergeState(mergeable: GqlPull['mergeable']): MergeState {
  if (mergeable === 'CONFLICTING') return 'conflicts';
  return mergeable === 'MERGEABLE' ? 'clean' : 'unknown';
}

// Quem já opinou entra com o voto; quem foi chamado e ainda não opinou entra como pendente.
export function toReviews(pull: Pick<GqlPull, 'reviewRequests' | 'latestOpinionatedReviews'>): Review[] {
  const reviews = new Map<string, Review>();
  for (const review of pull.latestOpinionatedReviews.nodes) {
    const reviewer = fromActor(review.author);
    reviews.set(reviewer.id, {
      reviewer,
      // "Changes requested" devolve a bola ao autor.
      decision: review.state === 'APPROVED' ? 'approved' : review.state === 'CHANGES_REQUESTED' ? 'waiting-author' : 'pending',
      required: false,
    });
  }
  for (const request of pull.reviewRequests.nodes) {
    const actor = request.requestedReviewer;
    if (!actor || !('login' in actor)) continue;
    const reviewer = fromActor(actor as GqlActor);
    // Pedir revisão de novo zera o voto anterior da pessoa.
    reviews.set(reviewer.id, { reviewer, decision: 'pending', required: false });
  }
  return [...reviews.values()];
}

// "Merge pull request #12 from …" (merge commit) ou "título (#12)" (squash) na primeira linha.
export function pullRequestIdsFromMessages(messages: (string | undefined)[]): number[] {
  const ids = new Set<number>();
  for (const message of messages) {
    const firstLine = message?.split('\n')[0] ?? '';
    const match = firstLine.match(/^Merge pull request #(\d+)/) ?? firstLine.match(/\(#(\d+)\)\s*$/);
    if (match) ids.add(Number(match[1]));
  }
  return [...ids];
}

export interface GitHubOptions {
  owner: string;
  releasePattern: string;
  developBranch: string;
}

// O dono (organização ou usuário) faz o papel de projeto: é ele que agrupa os repositórios.
export class GitHubSourceControl implements SourceControl {
  private readonly client: JsonClient;
  private me?: Promise<Person>;

  constructor(
    private readonly options: GitHubOptions,
    getToken: () => Promise<string>,
    fetchImpl?: FetchLike,
    retryDelayMs?: number,
  ) {
    this.client = new JsonClient({
      provider: 'github',
      label: 'GitHub',
      baseUrl: 'https://api.github.com',
      fetchImpl,
      retryDelayMs,
      headers: async () => ({
        Authorization: `Bearer ${await getToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'release-management',
      }),
    });
  }

  private repo(repository: Repository) {
    return `/repos/${encodeURIComponent(repository.projectId)}/${encodeURIComponent(repository.name)}`;
  }

  currentUser(): Promise<Person> {
    this.me ??= this.client.get<GhUser & { email?: string | null }>('/user').then((user) => ({
      ...fromUser(user),
      email: user.email ?? user.login,
    }));
    return this.me;
  }

  async getAvatar(avatarKey: string): Promise<Avatar | undefined> {
    if (!/^\d{1,12}$/.test(avatarKey)) return undefined;
    // Fotos do GitHub são públicas; não levam o token.
    const response = await fetch(`https://avatars.githubusercontent.com/u/${avatarKey}?s=96`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    const contentType = response?.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response?.ok || !contentType.startsWith('image/')) return undefined;
    return { contentType, data: Buffer.from(await response.arrayBuffer()) };
  }

  async listProjects(): Promise<Project[]> {
    return [{ id: this.options.owner, name: this.options.owner }];
  }

  async listRepositories(projectId: string): Promise<Repository[]> {
    const owner = encodeURIComponent(projectId);
    type Repo = { name: string; archived?: boolean; disabled?: boolean; owner: { login: string } };
    let repos: Repo[];
    try {
      repos = await this.client.get<Repo[]>(`/orgs/${owner}/repos`, { per_page: 100, sort: 'pushed' });
    } catch (error) {
      // O dono é uma conta pessoal, não uma organização.
      if (!isHttpStatus(error, 404)) throw error;
      const mine = await this.client.get<Repo[]>('/user/repos', { per_page: 100, affiliation: 'owner', sort: 'pushed' });
      repos = mine.filter((repo) => repo.owner.login.toLowerCase() === projectId.toLowerCase());
    }
    return repos
      .filter((repo) => !repo.archived && !repo.disabled)
      .map((repo) => ({ id: repo.name, name: repo.name, projectId }));
  }

  private openQuery(projectId: string) {
    return `is:pr is:open archived:false user:${projectId}`;
  }

  async countOpenPullRequests(projectId: string): Promise<number> {
    const data = await this.graphql<{ search: { issueCount: number } }>(
      'query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }',
      { q: this.openQuery(projectId) },
    );
    return data.search.issueCount;
  }

  async listOpenPullRequests(projectId: string): Promise<PullRequest[]> {
    const pulls: GqlPull[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < OPEN_MAX_PAGES; page++) {
      const data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (GqlPull | Record<string, never>)[] } } =
        await this.graphql(OPEN_PULLS, { q: this.openQuery(projectId), cursor });
      pulls.push(...data.search.nodes.filter((node): node is GqlPull => 'number' in node));
      if (!data.search.pageInfo.hasNextPage) break;
      cursor = data.search.pageInfo.endCursor;
    }
    return pulls.map((pull) => {
      const reviews = toReviews(pull);
      const approvals = reviews.filter((r) => r.decision === 'approved').length;
      return {
        provider: 'github',
        id: pull.number,
        title: pull.title,
        repository: { id: pull.repository.name, name: pull.repository.name, projectId },
        sourceBranch: pull.headRefName,
        targetBranch: pull.baseRefName,
        author: fromActor(pull.author),
        createdAt: pull.createdAt,
        status: 'open',
        isDraft: pull.isDraft,
        mergeState: toMergeState(pull.mergeable),
        // O GitHub diz que há conflito, mas não em quantos arquivos.
        conflictCount: pull.mergeable === 'CONFLICTING' ? 1 : 0,
        commentCount: pull.totalCommentsCount ?? 0,
        reviews,
        // Com proteção de branch, quem decide se as aprovações bastam é o GitHub.
        requiredApprovals: pull.reviewDecision === 'APPROVED' ? Math.max(approvals, 1) : undefined,
        blockedByPolicy: pull.reviewDecision === 'REVIEW_REQUIRED' || pull.reviewDecision === 'CHANGES_REQUESTED',
        webUrl: pull.url,
      } satisfies PullRequest;
    });
  }

  async listMergedPullRequests(repository: Repository, targetBranch: string): Promise<PullRequest[]> {
    const pulls = await this.client.get<GhPull[]>(`${this.repo(repository)}/pulls`, {
      state: 'closed',
      base: targetBranch,
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    return pulls.filter((pull) => pull.merged_at).map((pull) => this.toPullRequest(pull, repository));
  }

  async getPullRequests(repository: Repository, ids: number[]): Promise<PullRequest[]> {
    const found = await mapLimit(ids, CONCURRENCY, async (id) => {
      try {
        return await this.client.get<GhPull>(`${this.repo(repository)}/pulls/${id}`);
      } catch (error) {
        // "#12" numa mensagem de commit pode ser uma issue, não um PR.
        if (isHttpStatus(error, 404)) return undefined;
        throw error;
      }
    });
    return found.filter((pull) => pull !== undefined).map((pull) => this.toPullRequest(pull, repository));
  }

  async existingBranches(repository: Repository, names: string[]): Promise<string[]> {
    const found = await mapLimit(names, CONCURRENCY, async (name) => {
      try {
        await this.client.get(`${this.repo(repository)}/branches/${encodeURIComponent(name)}`);
        return true;
      } catch (error) {
        if (isHttpStatus(error, 404)) return false;
        throw error;
      }
    });
    return names.filter((_, index) => found[index]);
  }

  async listReleaseBranches(repository: Repository): Promise<ReleaseBranch[]> {
    const pattern = new RegExp(this.options.releasePattern);
    const prefix = literalPrefix(this.options.releasePattern);
    let refs: { ref: string }[];
    try {
      refs = await this.client.get<{ ref: string }[]>(`${this.repo(repository)}/git/matching-refs/heads/${prefix}`);
    } catch (error) {
      // Repositório vazio.
      if (isHttpStatus(error, 404, 409)) return [];
      throw error;
    }
    const names = refs
      .map((ref) => ref.ref.replace('refs/heads/', ''))
      .filter((name) => pattern.test(name))
      .sort(compareVersionsDesc);
    return mapLimit(names, CONCURRENCY, async (name) => ({
      name,
      repository,
      // O GitHub não guarda quem criou a branch nem quando; só dá para dizer de onde ela saiu.
      baseBranch: names.indexOf(name) < 3 ? await this.detectBase(repository, name) : undefined,
      webUrl: this.branchUrl(repository, name),
    }));
  }

  async listPullRequestIdsInBranch(repository: Repository, branch: string, comparedTo: string): Promise<number[]> {
    try {
      const comparison = await this.client.get<{ commits: GhCommit[] }>(
        `${this.repo(repository)}/compare/${encodeURIComponent(comparedTo)}...${encodeURIComponent(branch)}`,
        { per_page: 250 },
      );
      return pullRequestIdsFromMessages(comparison.commits.map((commit) => commit.commit?.message));
    } catch (error) {
      if (isHttpStatus(error, 404)) return [];
      throw error;
    }
  }

  async listPullRequestIdsMergedInto(repository: Repository, branch: string, since: string): Promise<number[]> {
    try {
      const commits = await this.client.get<GhCommit[]>(`${this.repo(repository)}/commits`, {
        sha: branch,
        since,
        per_page: 100,
      });
      return pullRequestIdsFromMessages(commits.map((commit) => commit.commit?.message));
    } catch (error) {
      if (isHttpStatus(error, 404, 409)) return [];
      throw error;
    }
  }

  // O GitHub não tem cherry-pick na API. Para cada PR: um commit temporário com a árvore atual da release e,
  // como pai, o pai do commit do PR; mesclar o commit do PR nele dá exatamente "release + mudanças do PR".
  // Essa árvore vira o commit de verdade em cima da release. A branch final só é criada se todos passarem.
  async createReleaseBranch(input: CreateReleaseBranchInput): Promise<ReleaseBranch> {
    const { repository, name, baseBranch, pullRequestIds } = input;
    const repo = this.repo(repository);
    const temp = `rm-tmp/${randomBytes(4).toString('hex')}`;
    let tempCreated = false;

    try {
      const base = await this.client.get<{ object: { sha: string } }>(`${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
      let tip = base.object.sha;
      let tipTree = (await this.client.get<GhCommit>(`${repo}/git/commits/${tip}`)).tree!.sha;

      for (const pullRequestId of pullRequestIds) {
        const pull = await this.client.get<GhPull>(`${repo}/pulls/${pullRequestId}`);
        if (!pull.merge_commit_sha) {
          throw new ProviderUnavailableError('github', `O PR #${pullRequestId} não tem commit de merge`);
        }
        const picked = await this.client.get<GhCommit>(`${repo}/git/commits/${pull.merge_commit_sha}`);
        const parent = picked.parents[0]?.sha;
        if (!parent) throw new ProviderUnavailableError('github', `O commit do PR #${pullRequestId} não tem pai`);

        const staging = await this.client.json<GhCommit>(`${repo}/git/commits`, {
          method: 'POST',
          body: { message: `release-management: preparar #${pullRequestId}`, tree: tipTree, parents: [parent] },
        });
        if (tempCreated) {
          await this.client.json(`${repo}/git/refs/heads/${temp}`, { method: 'PATCH', body: { sha: staging.sha, force: true } });
        } else {
          await this.client.json(`${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${temp}`, sha: staging.sha } });
          tempCreated = true;
        }

        const merge = await this.client.send(`${repo}/merges`, {
          method: 'POST',
          body: { base: temp, head: pull.merge_commit_sha, commit_message: `release-management: aplicar #${pullRequestId}` },
        });
        if (merge.status === 409) throw new CherryPickConflictError(pullRequestId, baseBranch);
        if (merge.status !== 201 && merge.status !== 204) {
          const detail = (await merge.json().catch(() => ({}))) as { message?: string };
          throw new ProviderUnavailableError('github', detail.message ?? `Não foi possível aplicar o PR #${pullRequestId}`, merge.status);
        }
        // 204: a release já contém essas mudanças; não há commit novo a criar.
        if (merge.status === 204) continue;
        const merged = (await merge.json()) as { commit: { tree: { sha: string } } };

        const original = picked.message ?? '';
        const firstLine = original.split('\n')[0] ?? '';
        // A mensagem precisa carregar o número do PR: é por ela que a release é reconhecida depois.
        const message = pullRequestIdsFromMessages([original]).includes(pullRequestId)
          ? original
          : original.replace(firstLine, `${firstLine} (#${pullRequestId})`);
        const commit = await this.client.json<GhCommit>(`${repo}/git/commits`, {
          method: 'POST',
          body: { message, tree: merged.commit.tree.sha, parents: [tip] },
        });
        tip = commit.sha;
        tipTree = merged.commit.tree.sha;
      }

      await this.client.json(`${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha: tip } });
    } finally {
      if (tempCreated) {
        // Limpeza é melhor esforço: uma branch temporária sobrando não invalida o resultado.
        await this.client.send(`${repo}/git/refs/heads/${temp}`, { method: 'DELETE' }).catch(() => undefined);
      }
    }

    return {
      name,
      repository,
      createdAt: new Date().toISOString(),
      createdBy: await this.currentUser(),
      baseBranch,
      webUrl: this.branchUrl(repository, name),
    };
  }

  // Sem commits a mais que develop, a release saiu de develop.
  private async detectBase(repository: Repository, branch: string): Promise<string | undefined> {
    try {
      const comparison = await this.client.get<{ ahead_by: number }>(
        `${this.repo(repository)}/compare/${encodeURIComponent(this.options.developBranch)}...${encodeURIComponent(branch)}`,
        { per_page: 1 },
      );
      return comparison.ahead_by === 0 ? this.options.developBranch : undefined;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return undefined;
      throw error;
    }
  }

  private branchUrl(repository: Repository, branch: string) {
    return `https://github.com/${repository.projectId}/${repository.name}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }

  private toPullRequest(pull: GhPull, repository: Repository): PullRequest {
    return {
      provider: 'github',
      id: pull.number,
      title: pull.title,
      repository,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      author: fromUser(pull.user),
      createdAt: pull.created_at,
      closedAt: pull.merged_at ?? undefined,
      status: pull.merged_at ? 'merged' : 'open',
      isDraft: pull.draft ?? false,
      mergeState: 'unknown',
      conflictCount: 0,
      commentCount: 0,
      reviews: [],
      webUrl: pull.html_url,
    };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await this.client.json<{ data?: T; errors?: { message: string }[] }>('/graphql', {
      method: 'POST',
      readOnly: true,
      body: { query, variables },
    });
    if (!result.data) {
      throw new ProviderUnavailableError('github', result.errors?.map((e) => e.message).join(' ') ?? 'O GitHub não devolveu dados');
    }
    return result.data;
  }
}
