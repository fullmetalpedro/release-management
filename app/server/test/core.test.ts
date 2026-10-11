import { describe, expect, it } from 'vitest';
import { MemorySourceControl, MemoryWorkTracking } from '../src/adapters/memory/memoryAdapters.ts';
import { createWorld, MANOEL, PEDRO } from '../src/adapters/memory/world.ts';
import { CherryPickConflictError, ProviderUnavailableError, ValidationError } from '../src/core/domain/errors.ts';
import type { PullRequest, ReviewDecision } from '../src/core/domain/types.ts';
import { classify, getBoard } from '../src/core/usecases/board.ts';
import { listProjects } from '../src/core/usecases/projects.ts';
import { getReleaseDetails, suggestSearchTerm } from '../src/core/usecases/releaseDetails.ts';
import { createRelease, getReleaseLane, getReleaseLanes } from '../src/core/usecases/releaseLane.ts';
import {
  compareVersionsDesc,
  DEFAULT_RELEASE_PATTERN,
  isValidBranchName,
  literalPrefix,
  nextReleaseName,
} from '../src/core/usecases/releaseNaming.ts';
import { linkWorkItem, searchWorkItems, unlinkWorkItem } from '../src/core/usecases/workItems.ts';

const branching = { developBranch: 'develop', baseBranches: ['main', 'master'], releasePattern: DEFAULT_RELEASE_PATTERN, firstRelease: 'release/1.0' };
const api = { projectId: 'p-getnota', repositoryId: 'r-getnota-api', branching };

function pr(overrides: Partial<PullRequest>, votes: [typeof PEDRO, ReviewDecision][] = []): PullRequest {
  return {
    provider: 'azure-devops',
    id: 1,
    title: 't',
    repository: { id: 'r', name: 'r', projectId: 'p' },
    sourceBranch: 'f',
    targetBranch: 'develop',
    author: MANOEL,
    createdAt: '2026-10-01T00:00:00Z',
    status: 'open',
    isDraft: false,
    mergeState: 'clean',
    conflictCount: 0,
    commentCount: 0,
    reviews: votes.map(([reviewer, decision]) => ({ reviewer, decision, required: false })),
    webUrl: '',
    ...overrides,
  };
}

describe('classificação do board', () => {
  it('pede minha revisão quando sou revisor e ainda não votei', () => {
    expect(classify(pr({}, [[PEDRO, 'pending']]), PEDRO)).toEqual({ column: 'dependsOnMe', reason: 'reviewer' });
  });

  it('volta para mim quando sou autor e um revisor aguarda o autor', () => {
    const mine = pr({ author: PEDRO }, [[MANOEL, 'waiting-author']]);
    expect(classify(mine, PEDRO)).toEqual({ column: 'dependsOnMe', reason: 'waiting-author' });
  });

  it('depende de mim tem prioridade sobre conflito', () => {
    const mine = pr({ author: PEDRO, mergeState: 'conflicts' }, [[MANOEL, 'rejected']]);
    expect(classify(mine, PEDRO).column).toBe('dependsOnMe');
  });

  it('não cobra meu voto opcional quando o PR já tem as aprovações da política', () => {
    const votes: [typeof PEDRO, ReviewDecision][] = [[PEDRO, 'pending'], [{ ...MANOEL, id: 'x' }, 'approved']];
    expect(classify(pr({ requiredApprovals: 1 }, votes), PEDRO).column).toBe('ready');
    expect(classify(pr({ requiredApprovals: 2 }, votes), PEDRO)).toEqual({ column: 'dependsOnMe', reason: 'reviewer' });
    // Aprovações completas, mas outra política (build, comentários) ainda barra: não é o meu voto que falta.
    expect(classify(pr({ requiredApprovals: 1, blockedByPolicy: true }, votes), PEDRO).column).toBe('review');
  });

  it('não cobra revisão de rascunho', () => {
    expect(classify(pr({ isDraft: true }, [[PEDRO, 'pending']]), PEDRO).column).toBe('review');
  });

  it('conflito bloqueia mesmo aprovado', () => {
    expect(classify(pr({ mergeState: 'conflicts' }, [[MANOEL, 'approved']]), PEDRO).column).toBe('conflict');
  });

  it('pronto pra merge exige todos os revisores aprovando', () => {
    expect(classify(pr({ author: PEDRO }, [[MANOEL, 'approved']]), PEDRO).column).toBe('ready');
    expect(classify(pr({ author: PEDRO }, []), PEDRO).column).toBe('review');
  });

  it('a política de branch define o mínimo de aprovações e pode barrar o merge', () => {
    const votes: [typeof PEDRO, ReviewDecision][] = [[MANOEL, 'approved'], [{ ...MANOEL, id: 'x' }, 'pending']];
    expect(classify(pr({ author: PEDRO, requiredApprovals: 1 }, votes), PEDRO).column).toBe('ready');
    expect(classify(pr({ author: PEDRO, requiredApprovals: 2 }, votes), PEDRO).column).toBe('review');
    expect(classify(pr({ author: PEDRO, requiredApprovals: 1, blockedByPolicy: true }, votes), PEDRO).column).toBe('review');
  });

  it('distribui os PRs do GetNota como no design', async () => {
    const board = await getBoard({ sourceControl: new MemorySourceControl(createWorld()) }, 'p-getnota');
    expect(board.openCount).toBe(11);
    expect(Object.fromEntries(Object.entries(board.columns).map(([k, v]) => [k, v.length]))).toEqual({
      dependsOnMe: 4,
      review: 3,
      conflict: 2,
      ready: 2,
    });
    const waiting = board.columns.dependsOnMe.find((c) => c.id === 642)!;
    expect(waiting).toMatchObject({ reason: 'waiting-author', conflictCount: 1, approvals: 0, reviewers: 2 });
    expect(waiting.author).toEqual({ name: 'Pedro Carlo', isMe: true });
    // Só o #1287 me tem como revisor obrigatório; no #311 sou opcional.
    expect(board.columns.dependsOnMe.map((c) => [c.id, c.reason, c.requiredReviewer])).toEqual([
      [1287, 'reviewer', true],
      [642, 'waiting-author', false],
      [311, 'reviewer', false],
      [1279, 'waiting-author', false],
    ]);
  });
});

describe('projetos', () => {
  it('respeita a lista e a ordem configuradas, ignorando caixa e espaços', async () => {
    const sourceControl = new MemorySourceControl(createWorld());
    const projects = await listProjects({ sourceControl }, ['jane', 'LeadComex']);
    expect(projects).toEqual([
      { id: 'p-jane', name: 'Jane', openPullRequests: 7 },
      { id: 'p-leadcomex', name: 'Lead Comex', openPullRequests: 4 },
    ]);
  });
});

describe('nomes de release', () => {
  it('ordena por versão e não por texto', () => {
    const names = ['release/2.9', 'release/2.15', 'release/2.14', 'release/10.0'];
    expect(names.sort(compareVersionsDesc)).toEqual(['release/10.0', 'release/2.15', 'release/2.14', 'release/2.9']);
  });

  it('sugere a próxima versão', () => {
    expect(nextReleaseName('release/2.15', 'release/1.0')).toBe('release/2.16');
    expect(nextReleaseName('release/2.9', 'release/1.0')).toBe('release/2.10');
    expect(nextReleaseName('release-sprint-35', 'release/1.0')).toBe('release-sprint-36');
    expect(nextReleaseName('release/0.1.0', 'release/1.0')).toBe('release/0.1.1');
    expect(nextReleaseName(undefined, 'release-sprint-1')).toBe('release-sprint-1');
  });

  it('reconhece os formatos de release e deixa de fora branches de trabalho e hotfixes', () => {
    const pattern = new RegExp(DEFAULT_RELEASE_PATTERN);
    for (const name of ['release-sprint-35', 'release/2.15', 'release/0.1.0', 'release/3', 'release-12']) {
      expect(pattern.test(name), name).toBe(true);
    }
    for (const name of [
      'release/131046-remover-ativo-entidades-filhas',
      'release-sprint-35-hotfix',
      'release/2.15-hotfix',
      'hotfix/release-sprint-35',
      'release/sprint',
      'release',
      'prerelease/1.0',
    ]) {
      expect(pattern.test(name), name).toBe(false);
    }
    expect(literalPrefix(DEFAULT_RELEASE_PATTERN)).toBe('release');
    expect(literalPrefix(String.raw`^rel/v\d+$`)).toBe('rel/v');
    expect(literalPrefix(String.raw`\d+`)).toBe('');
    expect(literalPrefix('^release/?v')).toBe('release');
  });

  it('valida nomes de branch', () => {
    expect(isValidBranchName('release/2.16')).toBe(true);
    for (const bad of ['', 'release/', '/release', 'a..b', 'a b', 'a~1', 'x.lock', 'a//b', '.hidden']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
});

describe('mergeados e release', () => {
  it('lista o que foi mergeado e ainda não entrou em release', async () => {
    const lane = await getReleaseLane({ sourceControl: new MemorySourceControl(createWorld()) }, api);
    expect(lane.merged.map((p) => p.id)).toEqual([1295, 1294, 1291, 1289, 1286]);
    expect(lane.suggestedBranch).toBe('release/2.16');
    expect(lane.release).toMatchObject({ name: 'release/2.15', isLatest: true, baseBranch: 'develop' });
    expect(lane.release!.pullRequests.map((p) => p.id)).toEqual([1284, 1282, 1276, 1274, 1270, 1268]);
    expect(lane.release!.createdBy).toEqual({ name: 'Manoel Martins', isMe: false });
  });

  it('carrega as raias de todos os repositórios de uma vez e tolera a falha de um', async () => {
    const sourceControl = new MemorySourceControl(createWorld());
    const all = await getReleaseLanes({ sourceControl }, { projectId: 'p-getnota', branching });
    expect(all.lanes.map((l) => [l.repository.name, l.merged.length, l.release?.name ?? null])).toEqual([
      ['getnota-api', 5, 'release/2.15'],
      ['getnota-web', 2, 'release/1.8'],
      ['getnota-worker', 0, null],
      ['getnota-infra', 0, null],
    ]);

    const original = sourceControl.listMergedPullRequests.bind(sourceControl);
    sourceControl.listMergedPullRequests = async (repository, target) => {
      if (repository.name === 'getnota-web') throw new ProviderUnavailableError('azure-devops', 'caiu');
      return original(repository, target);
    };
    const partial = await getReleaseLanes({ sourceControl }, { projectId: 'p-getnota', branching });
    expect(partial.lanes.map((l) => l.repository.name)).toEqual(['getnota-api', 'getnota-worker', 'getnota-infra']);
  });

  it('repositório sem release sugere a primeira versão', async () => {
    const lane = await getReleaseLane(
      { sourceControl: new MemorySourceControl(createWorld()) },
      { ...api, repositoryId: 'r-getnota-worker' },
    );
    expect(lane).toMatchObject({ release: null, merged: [], suggestedBranch: 'release/1.0' });
  });

  it('cria a release e tira os PRs de mergeados', async () => {
    const sourceControl = new MemorySourceControl(createWorld());
    const created = await createRelease(
      { sourceControl },
      { ...api, name: 'release/2.16', pullRequestIds: [1295, 1294, 1291] },
    );
    expect(created).toMatchObject({ name: 'release/2.16', pullRequests: 3, repository: 'getnota-api' });

    const lane = await getReleaseLane({ sourceControl }, api);
    expect(lane.merged.map((p) => p.id)).toEqual([1289, 1286]);
    expect(lane.release).toMatchObject({ name: 'release/2.16', baseBranch: 'main', createdBy: { isMe: true } });
    expect(lane.release!.pullRequests.map((p) => p.id)).toEqual([1295, 1294, 1291]);
    expect(lane.suggestedBranch).toBe('release/2.17');
  });

  it('aplica os PRs na ordem em que foram mergeados', async () => {
    const world = createWorld();
    const sourceControl = new MemorySourceControl(world);
    await createRelease({ sourceControl }, { ...api, name: 'release/2.16', pullRequestIds: [1295, 1291, 1294] });
    expect(world.releases.at(-1)!.pullRequestIds).toEqual([1291, 1294, 1295]);
  });

  it('conflito de cherry-pick não cria nada', async () => {
    const world = createWorld();
    const sourceControl = new MemorySourceControl(world, { conflictingPullRequestIds: [1291] });
    const attempt = createRelease({ sourceControl }, { ...api, name: 'release/2.16', pullRequestIds: [1295, 1291] });
    await expect(attempt).rejects.toMatchObject({ pullRequestId: 1291, baseBranch: 'main' });
    await expect(attempt).rejects.toBeInstanceOf(CherryPickConflictError);
    expect(world.releases.some((r) => r.name === 'release/2.16')).toBe(false);
  });

  it('recusa nome inválido, branch existente, seleção vazia e PR aberto', async () => {
    const sourceControl = new MemorySourceControl(createWorld());
    const attempt = (name: string, pullRequestIds: number[]) =>
      createRelease({ sourceControl }, { ...api, name, pullRequestIds });
    await expect(attempt('release 2', [1295])).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt('release/2.15', [1295])).rejects.toThrow('já existe');
    await expect(attempt('release/2.16', [])).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt('release/2.16', [1287])).rejects.toThrow('mergeados');
  });
});

describe('detalhe da release', () => {
  const deps = () => {
    const world = createWorld();
    return { sourceControl: new MemorySourceControl(world), workTracking: new MemoryWorkTracking(world) };
  };

  it('agrupa por PBI e destaca o PR sem task', async () => {
    const details = await getReleaseDetails(deps(), api);
    expect(details.release).toMatchObject({ name: 'release/2.15', isLatest: true });
    expect(details.summary).toEqual({ pullRequests: 6, tasks: 5, pbis: 4, unlinked: 1 });
    expect(details.groups.map((g) => [g.pbi.id, g.tasks, g.pullRequests])).toEqual([
      [48120, 1, 1],
      [48140, 2, 2],
      [48160, 1, 1],
      [48170, 1, 1],
    ]);
    expect(details.groups[1]!.rows.map((r) => [r.task?.id, r.task?.kind, r.pullRequest.id])).toEqual([
      [48144, 'bug', 1282],
      [48147, 'task', 1270],
    ]);
    expect(details.unlinked).toMatchObject([{ id: 1274, suggestedTerm: 'dependências' }]);
  });

  it('vincular a task move o PR para o PBI dela; desfazer devolve', async () => {
    const d = deps();
    const ref = { projectId: 'p-getnota', repositoryId: 'r-getnota-api', pullRequestId: 1274 };

    await linkWorkItem(d, 48181, ref);
    const linked = await getReleaseDetails(d, api);
    expect(linked.summary).toEqual({ pullRequests: 6, tasks: 6, pbis: 5, unlinked: 0 });
    expect(linked.groups.at(-1)).toMatchObject({ pbi: { id: 48180, title: 'Manutenção técnica' }, tasks: 1 });

    await unlinkWorkItem(d, 48181, ref);
    expect((await getReleaseDetails(d, api)).summary.unlinked).toBe(1);
  });

  it('busca tasks pelo título, com o PBI pai', async () => {
    const found = await searchWorkItems(deps(), { projectId: 'p-getnota', term: 'dependências' });
    expect(found.map((w) => [w.id, w.parent?.id])).toEqual([
      [48181, 48180],
      [48176, 48180],
      [48152, 48150],
    ]);
    expect(await searchWorkItems(deps(), { projectId: 'p-getnota', term: 'a' })).toEqual([]);
  });

  it('escolhe o termo de busca a partir do título do PR', () => {
    expect(suggestSearchTerm('chore: atualizar dependências do Hibernate')).toBe('dependências');
    expect(suggestSearchTerm('feat(api)!: webhook de status')).toBe('webhook');
    expect(suggestSearchTerm('fix: a b')).toBe('');
  });
});
