import { randomBytes } from 'node:crypto';
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
  ReviewDecision,
} from '../../core/domain/types.ts';
import type { CreateReleaseBranchInput, SourceControl } from '../../core/ports/sourceControl.ts';
import { compareVersionsDesc, literalPrefix } from '../../core/usecases/releaseNaming.ts';
import { AzureDevOpsHttpError, isTransientStatus, mapLimit, type AzureDevOpsClient } from './client.ts';
import { msg } from '../../i18n.ts';

interface List<T> {
  value: T[];
}

interface AdoIdentity {
  id: string;
  displayName: string;
  uniqueName?: string;
  descriptor?: string;
  _links?: { avatar?: { href?: string } };
}

interface AdoReviewer extends AdoIdentity {
  vote: number;
  isRequired?: boolean;
  isContainer?: boolean;
}

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  status: string;
  isDraft?: boolean;
  createdBy: AdoIdentity;
  creationDate: string;
  closedDate?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  reviewers?: AdoReviewer[];
  repository: { id: string; name: string; project: { id: string } };
}

interface AdoThread {
  isDeleted?: boolean;
  publishedDate?: string;
  comments?: { commentType?: string; isDeleted?: boolean; publishedDate?: string }[];
  // Threads de sistema: o tipo e os índices das pessoas envolvidas, que apontam para `identities`.
  properties?: Record<string, { $value?: unknown } | undefined>;
  identities?: Record<string, AdoIdentity | undefined>;
}

// Quando cada pessoa votou pela última vez e quando foi incluída como revisora, por id.
export interface ReviewerActivity {
  votedAt: Map<string, string>;
  addedAt: Map<string, string>;
}

interface AdoCommit {
  commitId: string;
  comment?: string;
}

interface AdoPolicyEvaluation {
  status: string;
  configuration?: {
    isEnabled?: boolean;
    isBlocking?: boolean;
    settings?: { minimumApproverCount?: number };
  };
}

interface AdoRef {
  name: string;
  objectId: string;
  creator?: AdoIdentity;
}

interface AdoCherryPick {
  cherryPickId: number;
  status: 'queued' | 'inProgress' | 'completed' | 'failed' | 'abandoned';
  detailedStatus?: { conflict?: boolean; failureMessage?: string };
}

const ZERO_SHA = '0'.repeat(40);
const HEADS = 'refs/heads/';
const CONCURRENCY = 8;
// Quantos commits recentes de cada branch entram na comparação.
const COMMIT_WINDOW = 1000;
const PREVIEW = '7.1-preview.1';

const stripHeads = (ref: string) => (ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref);

const AVATAR_KEY = /^[A-Za-z0-9]+\.[A-Za-z0-9_-]{8,400}$/;

// O descritor da identidade é a chave da foto; em revisores ele só aparece no fim do link do avatar.
export function avatarKeyOf(identity: AdoIdentity): string | undefined {
  const key = identity.descriptor ?? identity._links?.avatar?.href?.split('/').pop()?.split('?')[0];
  return key && AVATAR_KEY.test(key) ? key : undefined;
}

export function toPerson(identity: AdoIdentity): Person {
  return {
    id: identity.id,
    name: identity.displayName,
    email: identity.uniqueName,
    avatarKey: avatarKeyOf(identity),
  };
}

export function toDecision(vote: number): ReviewDecision {
  if (vote >= 5) return 'approved';
  if (vote === -10) return 'rejected';
  if (vote === -5) return 'waiting-author';
  return 'pending';
}

export function toMergeState(status: string | undefined): MergeState {
  if (status === 'conflicts') return 'conflicts';
  if (status === 'succeeded') return 'clean';
  return 'unknown';
}

// Resume as políticas de branch avaliadas para um PR.
export function summarizePolicies(evaluations: AdoPolicyEvaluation[]): { requiredApprovals?: number; blockedByPolicy: boolean } {
  const blocking = evaluations.filter((e) => e.configuration?.isEnabled !== false && e.configuration?.isBlocking);
  const minimums = blocking.flatMap((e) => e.configuration?.settings?.minimumApproverCount ?? []);
  return {
    requiredApprovals: minimums.length > 0 ? Math.max(...minimums) : undefined,
    blockedByPolicy: blocking.some((e) => e.status !== 'approved' && e.status !== 'notApplicable'),
  };
}

const isAfter = (date: string, than: string | undefined) => !than || Date.parse(date) > Date.parse(than);

// As threads de sistema registram cada voto ("VoteUpdate") e cada inclusão de revisor ("ReviewersUpdate").
// Quem entrou na criação do PR não ganha thread: fica sem data, e vale a criação.
export function reviewerActivity(threads: AdoThread[]): ReviewerActivity {
  const activity: ReviewerActivity = { votedAt: new Map(), addedAt: new Map() };
  for (const thread of threads) {
    const props = thread.properties ?? {};
    const type = props.CodeReviewThreadType?.$value;
    const date = thread.publishedDate ?? thread.comments?.[0]?.publishedDate;
    if (!date || (type !== 'VoteUpdate' && type !== 'ReviewersUpdate')) continue;
    const target = type === 'VoteUpdate' ? activity.votedAt : activity.addedAt;
    const keys = Object.keys(props).filter((key) =>
      type === 'VoteUpdate' ? key === 'CodeReviewVotedByIdentity' : key.startsWith('CodeReviewReviewersUpdatedAddedIdentity'),
    );
    for (const key of keys) {
      for (const index of String(props[key]?.$value ?? '').match(/\d+/g) ?? []) {
        const id = thread.identities?.[index]?.id;
        if (id && isAfter(date, target.get(id))) target.set(id, date);
      }
    }
  }
  return activity;
}

export function pullRequestIdsFromCommits(commits: { comment?: string }[]): number[] {
  const ids = new Set<number>();
  for (const commit of commits) {
    const match = commit.comment?.match(/Merged PR (\d+)/);
    if (match) ids.add(Number(match[1]));
  }
  return [...ids];
}

export interface AzureDevOpsSourceControlOptions {
  releasePattern: string;
  developBranch: string;
  cherryPickPollMs?: number;
  cherryPickTimeoutMs?: number;
}

export class AzureDevOpsSourceControl implements SourceControl {
  private me?: Promise<Person>;

  constructor(
    private readonly client: AzureDevOpsClient,
    private readonly options: AzureDevOpsSourceControlOptions,
  ) {}

  currentUser(): Promise<Person> {
    this.me ??= this.client
      .get<{
        authenticatedUser: {
          id: string;
          providerDisplayName: string;
          subjectDescriptor?: string;
          properties?: { Account?: { $value?: string } };
        };
      }>(
        '/_apis/connectionData',
        { apiVersion: '7.1-preview.1' },
      )
      .then(({ authenticatedUser: user }) => ({
        id: user.id,
        name: user.providerDisplayName,
        email: user.properties?.Account?.$value,
        avatarKey: avatarKeyOf({ id: user.id, displayName: '', descriptor: user.subjectDescriptor }),
      }))
      .catch((error) => {
        // Uma falha passageira não fica guardada: a próxima chamada tenta de novo.
        this.me = undefined;
        throw error;
      });
    return this.me;
  }

  async getAvatar(avatarKey: string): Promise<Avatar | undefined> {
    // A chave vira parte da URL: só segue adiante o que tem forma de descritor.
    if (!AVATAR_KEY.test(avatarKey)) return undefined;
    return this.client.getImage(`/_apis/GraphProfile/MemberAvatars/${avatarKey}`);
  }

  async listProjects(): Promise<Project[]> {
    const { value } = await this.client.get<List<{ id: string; name: string }>>('/_apis/projects', {
      query: { $top: 500, stateFilter: 'wellFormed' },
    });
    return value.map((p) => ({ id: p.id, name: p.name }));
  }

  async listRepositories(projectId: string): Promise<Repository[]> {
    const { value } = await this.client.get<List<{ id: string; name: string; isDisabled?: boolean }>>(
      `/${encodeURIComponent(projectId)}/_apis/git/repositories`,
    );
    return value.filter((r) => !r.isDisabled).map((r) => ({ id: r.id, name: r.name, projectId }));
  }

  async countOpenPullRequests(projectId: string): Promise<number> {
    return (await this.fetchActive(projectId)).length;
  }

  async listOpenPullRequests(projectId: string): Promise<PullRequest[]> {
    const active = await this.fetchActive(projectId);
    // O limite vale por PR: no máximo CONCURRENCY PRs com as suas leituras em andamento ao mesmo tempo.
    return mapLimit(active, CONCURRENCY, async (pr) => {
      const [threads, conflictCount, policies, lastPushAt] = await Promise.all([
        this.readThreads(pr),
        pr.mergeStatus === 'conflicts' ? this.countConflicts(pr) : 0,
        this.policiesOf(pr),
        this.lastPushOf(pr),
      ]);
      const pullRequest = this.toPullRequest(pr, { commentCount: threads.commentCount, conflictCount }, threads.activity);
      return { ...pullRequest, lastPushAt, ...policies };
    });
  }

  async listMergedPullRequests(repository: Repository, targetBranch: string): Promise<PullRequest[]> {
    const { value } = await this.client.get<List<AdoPullRequest>>(
      `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/pullrequests`,
      {
        query: {
          'searchCriteria.status': 'completed',
          'searchCriteria.targetRefName': HEADS + targetBranch,
          $top: 100,
        },
      },
    );
    return value.map((pr) => this.toPullRequest(pr));
  }

  async getPullRequests(repository: Repository, ids: number[]): Promise<PullRequest[]> {
    const found = await mapLimit(ids, CONCURRENCY, async (id) => {
      try {
        return await this.client.get<AdoPullRequest>(
          `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/pullrequests/${id}`,
        );
      } catch (error) {
        // Um "Merged PR N" na mensagem pode apontar para um PR de outro repositório.
        if (error instanceof AzureDevOpsHttpError && error.status === 404) return undefined;
        throw error;
      }
    });
    return found.filter((pr) => pr !== undefined).map((pr) => this.toPullRequest(pr));
  }

  async existingBranches(repository: Repository, names: string[]): Promise<string[]> {
    const found = await mapLimit(names, CONCURRENCY, async (name) => {
      const refs = await this.listRefs(repository, name);
      return refs.some((ref) => ref.name === HEADS + name);
    });
    return names.filter((_, index) => found[index]);
  }

  async listReleaseBranches(repository: Repository): Promise<ReleaseBranch[]> {
    const pattern = new RegExp(this.options.releasePattern);
    const candidates = await this.listRefs(repository, literalPrefix(this.options.releasePattern));
    const refs = candidates.filter((ref) => pattern.test(stripHeads(ref.name)));
    const sorted = refs.sort((a, b) => compareVersionsDesc(a.name, b.name));
    return mapLimit(sorted, CONCURRENCY, async (ref) => {
      const name = stripHeads(ref.name);
      // Data e origem custam chamadas extras: só para as releases que aparecem na tela.
      const detailed = sorted.indexOf(ref) < 3;
      const [creation, baseBranch] = detailed
        ? await Promise.all([this.branchCreation(repository, ref.name), this.detectBase(repository, name)])
        : [undefined, undefined];
      return {
        name,
        repository,
        createdAt: creation?.date,
        createdBy: creation?.by ?? (ref.creator && toPerson(ref.creator)),
        baseBranch,
        webUrl: this.branchUrl(repository, name),
      };
    });
  }

  async listPullRequestIdsInBranch(repository: Repository, branch: string, comparedTo: string): Promise<number[]> {
    // A diferença é feita aqui, por id de commit, em vez de depender da comparação do servidor.
    const [inBranch, inBase] = await Promise.all([
      this.recentCommits(repository, branch),
      this.recentCommits(repository, comparedTo),
    ]);
    const known = new Set(inBase.map((commit) => commit.commitId));
    return pullRequestIdsFromCommits(inBranch.filter((commit) => !known.has(commit.commitId)));
  }

  async listPullRequestIdsMergedInto(repository: Repository, branch: string, since: string): Promise<number[]> {
    return pullRequestIdsFromCommits(await this.recentCommits(repository, branch, since));
  }

  async createReleaseBranch(input: CreateReleaseBranchInput): Promise<ReleaseBranch> {
    const { repository, name, baseBranch, pullRequestIds } = input;
    const repoPath = `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}`;
    const run = randomBytes(4).toString('hex');
    const tempRefs: string[] = [];

    try {
      // Cada cherry-pick gera uma branch temporária em cima da anterior; a release só nasce se todos passarem.
      let onto = HEADS + baseBranch;
      for (const [index, pullRequestId] of pullRequestIds.entries()) {
        const generated = `${HEADS}rm-tmp/${run}/${index}`;
        // Anotada antes do pedido: se ele estourar o tempo, a branch pode ter sido criada e ainda precisa sair.
        tempRefs.push(generated);
        const started = await this.client.post<AdoCherryPick>(`${repoPath}/cherryPicks`, {
          apiVersion: PREVIEW,
          body: { generatedRefName: generated, ontoRefName: onto, source: { pullRequestId } },
        });
        const finished = await this.waitForCherryPick(repoPath, started);
        if (finished.status !== 'completed') {
          if (finished.detailedStatus?.conflict) throw new CherryPickConflictError(pullRequestId, baseBranch);
          throw new ProviderUnavailableError(
            'azure-devops',
            finished.detailedStatus?.failureMessage ?? msg('cherryPickFailed', { id: pullRequestId }),
          );
        }
        onto = generated;
      }

      const [tip] = await this.listRefs(repository, stripHeads(onto));
      if (!tip) throw new ProviderUnavailableError('azure-devops', msg('cherryPickResultMissing'));
      await this.updateRefs(repoPath, [{ name: HEADS + name, oldObjectId: ZERO_SHA, newObjectId: tip.objectId }]);
    } finally {
      await this.deleteRefs(repository, repoPath, tempRefs);
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

  private async waitForCherryPick(repoPath: string, started: AdoCherryPick): Promise<AdoCherryPick> {
    const pollMs = this.options.cherryPickPollMs ?? 1000;
    const deadline = Date.now() + (this.options.cherryPickTimeoutMs ?? 90_000);
    let current = started;
    while (current.status === 'queued' || current.status === 'inProgress') {
      if (Date.now() > deadline) {
        throw new ProviderUnavailableError('azure-devops', msg('cherryPickTimeout'));
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      current = await this.client.get<AdoCherryPick>(`${repoPath}/cherryPicks/${started.cherryPickId}`, {
        apiVersion: PREVIEW,
      });
    }
    return current;
  }

  private async updateRefs(repoPath: string, updates: { name: string; oldObjectId: string; newObjectId: string }[]) {
    const { value } = await this.client.post<List<{ success: boolean; updateStatus?: string; name: string }>>(
      `${repoPath}/refs`,
      { body: updates },
    );
    const failed = value.find((r) => !r.success);
    if (failed) {
      throw new ProviderUnavailableError(
        'azure-devops',
        failed.updateStatus
          ? msg('refUpdateFailed', { branch: stripHeads(failed.name), status: failed.updateStatus })
          : msg('refUpdateFailedUnknown', { branch: stripHeads(failed.name) }),
      );
    }
  }

  private async deleteRefs(repository: Repository, repoPath: string, names: string[]) {
    if (names.length === 0) return;
    try {
      const existing = await this.listRefs(repository, stripHeads(names[0]!).replace(/\/\d+$/, '/'));
      const updates = existing
        .filter((ref) => names.includes(ref.name))
        .map((ref) => ({ name: ref.name, oldObjectId: ref.objectId, newObjectId: ZERO_SHA }));
      if (updates.length > 0) await this.updateRefs(repoPath, updates);
    } catch {
      // Limpeza é melhor esforço: uma branch temporária sobrando não invalida o resultado.
    }
  }

  private async recentCommits(repository: Repository, branch: string, since?: string): Promise<AdoCommit[]> {
    try {
      const { value } = await this.client.get<List<AdoCommit>>(
        `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/commits`,
        {
          query: {
            'searchCriteria.itemVersion.version': branch,
            'searchCriteria.itemVersion.versionType': 'branch',
            'searchCriteria.fromDate': since,
            $top: COMMIT_WINDOW,
          },
        },
      );
      return value;
    } catch (error) {
      // Branch inexistente (repositório sem main, por exemplo).
      if (error instanceof AzureDevOpsHttpError && (error.status === 404 || error.status === 400)) return [];
      throw error;
    }
  }

  private async listRefs(repository: Repository, headsPrefix: string): Promise<AdoRef[]> {
    const { value } = await this.client.get<List<AdoRef>>(
      `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/refs`,
      { query: { filter: `heads/${headsPrefix}` } },
    );
    return value;
  }

  private async fetchActive(projectId: string): Promise<AdoPullRequest[]> {
    const { value } = await this.client.get<List<AdoPullRequest>>(`/${encodeURIComponent(projectId)}/_apis/git/pullrequests`, {
      query: { 'searchCriteria.status': 'active', $top: 500 },
    });
    return value;
  }

  // Uma leitura só serve à contagem de comentários e às datas de voto e de inclusão dos revisores.
  private async readThreads(pr: AdoPullRequest): Promise<{ commentCount: number; activity?: ReviewerActivity }> {
    try {
      const { value } = await this.client.get<List<AdoThread>>(
        `/${encodeURIComponent(pr.repository.project.id)}/_apis/git/repositories/${encodeURIComponent(pr.repository.id)}/pullRequests/${pr.pullRequestId}/threads`,
      );
      const commentCount = value.filter(
        (thread) => !thread.isDeleted && thread.comments?.some((c) => c.commentType === 'text' && !c.isDeleted),
      ).length;
      return { commentCount, activity: reviewerActivity(value) };
    } catch (error) {
      if (error instanceof AzureDevOpsHttpError) return { commentCount: 0 };
      throw error;
    }
  }

  // Cada push no PR vira uma iteração; a última diz quando chegou o código atual.
  private async lastPushOf(pr: AdoPullRequest): Promise<string | undefined> {
    try {
      const { value } = await this.client.get<List<{ id: number; createdDate?: string }>>(
        `/${encodeURIComponent(pr.repository.project.id)}/_apis/git/repositories/${encodeURIComponent(pr.repository.id)}/pullRequests/${pr.pullRequestId}/iterations`,
      );
      return value.reduce<string | undefined>(
        (last, iteration) => (iteration.createdDate && isAfter(iteration.createdDate, last) ? iteration.createdDate : last),
        undefined,
      );
    } catch (error) {
      // Sem as iterações, o card cai na data de criação.
      if (error instanceof AzureDevOpsHttpError) return undefined;
      throw error;
    }
  }

  private async policiesOf(pr: AdoPullRequest) {
    try {
      const projectId = pr.repository.project.id;
      const { value } = await this.client.get<List<AdoPolicyEvaluation>>(`/${encodeURIComponent(projectId)}/_apis/policy/evaluations`, {
        apiVersion: PREVIEW,
        query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}` },
      });
      return summarizePolicies(value);
    } catch (error) {
      // Sem acesso às políticas, vale a regra dos revisores. Limite de requisições e falha do provedor sobem
      // como erro: classificar o PR sem as políticas o colocaria na coluna errada.
      if (error instanceof AzureDevOpsHttpError && !isTransientStatus(error.status)) return {};
      throw error;
    }
  }

  private async countConflicts(pr: AdoPullRequest): Promise<number> {
    try {
      const { value } = await this.client.get<List<unknown>>(
        `/${encodeURIComponent(pr.repository.project.id)}/_apis/git/repositories/${encodeURIComponent(pr.repository.id)}/pullRequests/${pr.pullRequestId}/conflicts`,
        { apiVersion: PREVIEW },
      );
      return Math.max(value.length, 1);
    } catch (error) {
      if (error instanceof AzureDevOpsHttpError) return 1;
      throw error;
    }
  }

  private async branchCreation(repository: Repository, refName: string): Promise<{ date: string; by: Person } | undefined> {
    try {
      const { value } = await this.client.get<List<{ date: string; pushedBy: AdoIdentity }>>(
        `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/pushes`,
        { query: { 'searchCriteria.refName': refName, $top: 100 } },
      );
      const first = value.at(-1);
      return first && { date: first.date, by: toPerson(first.pushedBy) };
    } catch (error) {
      if (error instanceof AzureDevOpsHttpError) return undefined;
      throw error;
    }
  }

  // Sem commits a mais que develop, a release saiu de develop; caso contrário foi montada sobre a base.
  private async detectBase(repository: Repository, branch: string): Promise<string | undefined> {
    try {
      const stats = await this.client.get<{ aheadCount: number }>(
        `/${encodeURIComponent(repository.projectId)}/_apis/git/repositories/${encodeURIComponent(repository.id)}/stats/branches`,
        {
          query: {
            name: branch,
            'baseVersionDescriptor.version': this.options.developBranch,
            'baseVersionDescriptor.versionType': 'branch',
          },
        },
      );
      return stats.aheadCount === 0 ? this.options.developBranch : undefined;
    } catch (error) {
      if (error instanceof AzureDevOpsHttpError) return undefined;
      throw error;
    }
  }

  private branchUrl(repository: Repository, branch: string) {
    return `${this.client.baseUrl}/${encodeURIComponent(repository.projectId)}/_git/${encodeURIComponent(repository.name)}?version=GB${encodeURIComponent(branch)}`;
  }

  private toPullRequest(
    pr: AdoPullRequest,
    counts: { commentCount: number; conflictCount: number } = { commentCount: 0, conflictCount: 0 },
    activity?: ReviewerActivity,
  ): PullRequest {
    const repository: Repository = {
      id: pr.repository.id,
      name: pr.repository.name,
      projectId: pr.repository.project.id,
    };
    const reviews: Review[] = (pr.reviewers ?? [])
      .filter((reviewer) => !reviewer.isContainer)
      .map((reviewer) => ({
        reviewer: toPerson(reviewer),
        decision: toDecision(reviewer.vote),
        required: reviewer.isRequired ?? false,
        addedAt: activity?.addedAt.get(reviewer.id),
        votedAt: activity?.votedAt.get(reviewer.id),
      }));
    return {
      provider: 'azure-devops',
      id: pr.pullRequestId,
      title: pr.title,
      repository,
      sourceBranch: stripHeads(pr.sourceRefName),
      targetBranch: stripHeads(pr.targetRefName),
      author: toPerson(pr.createdBy),
      createdAt: pr.creationDate,
      closedAt: pr.closedDate,
      status: pr.status === 'completed' ? 'merged' : 'open',
      isDraft: pr.isDraft ?? false,
      mergeState: toMergeState(pr.mergeStatus),
      conflictCount: counts.conflictCount,
      commentCount: counts.commentCount,
      reviews,
      webUrl: `${this.client.baseUrl}/${encodeURIComponent(repository.projectId)}/_git/${encodeURIComponent(repository.name)}/pullrequest/${pr.pullRequestId}`,
    };
  }
}
