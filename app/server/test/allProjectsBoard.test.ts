import { describe, expect, it } from 'vitest';
import { MemorySourceControl } from '../src/adapters/memory/memoryAdapters.ts';
import { ALEX, createWorld, SAM } from '../src/adapters/memory/world.ts';
import { ConnectionExpiredError, ProviderUnavailableError } from '../src/core/domain/errors.ts';
import type { Project, PullRequest } from '../src/core/domain/types.ts';
import type { SourceControl } from '../src/core/ports/sourceControl.ts';
import { ALL_PROJECTS_LIMIT, getAllProjectsBoard } from '../src/core/usecases/allProjectsBoard.ts';

const pullRequest = (projectId: string): PullRequest => ({
  provider: 'azure-devops',
  id: 1,
  title: `PR de ${projectId}`,
  repository: { id: `r-${projectId}`, name: `repo-${projectId}`, projectId },
  sourceBranch: 'feature',
  targetBranch: 'develop',
  author: SAM,
  createdAt: '2026-10-01T00:00:00Z',
  status: 'open',
  isDraft: false,
  mergeState: 'clean',
  conflictCount: 0,
  commentCount: 0,
  reviews: [{ reviewer: ALEX, decision: 'pending', required: true }],
  webUrl: '',
});

// Provedor com `count` projetos de um PR cada. Conta as chamadas e quantas estão em andamento ao mesmo tempo.
function fakeProvider(count: number, options: { failing?: string[]; empty?: string[]; error?: () => Error } = {}) {
  const projects: Project[] = Array.from({ length: count }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, name: `Projeto ${String(i).padStart(2, '0')}` }));
  const stats = { inFlight: 0, maxInFlight: 0, currentUser: 0, listed: [] as string[] };
  const track = async <T,>(fn: () => T): Promise<T> => {
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return fn();
    } finally {
      stats.inFlight--;
    }
  };
  const sourceControl = {
    currentUser: () => track(() => (stats.currentUser++, ALEX)),
    listProjects: () => track(() => projects),
    countOpenPullRequests: (id: string) => track(() => (options.empty?.includes(id) ? 0 : 1)),
    listOpenPullRequests: (id: string) =>
      track(() => {
        stats.listed.push(id);
        if (options.failing?.includes(id)) throw options.error?.() ?? new ProviderUnavailableError('azure-devops', 'fora do ar');
        return [pullRequest(id)];
      }),
  } as unknown as SourceControl;
  return { sourceControl, stats };
}

describe('board de todos os projetos', () => {
  it('junta os PRs dos projetos, com o projeto e a coluna em cada card', async () => {
    const board = await getAllProjectsBoard({ sourceControl: new MemorySourceControl(createWorld()) });
    expect(board.projects.map((p) => p.name)).toEqual(['Invoicing', 'Scheduler', 'Trade Desk']);
    expect(board.items).toHaveLength(11 + 7 + 4);
    expect(board.failed).toEqual([]);
    expect(board.skipped).toBe(0);
    const card = board.items.find((item) => item.id === 1287)!;
    expect(card).toMatchObject({ column: 'dependsOnMe', reason: 'reviewer', project: { id: 'p-invoicing', name: 'Invoicing' } });
  });

  it('um projeto que falha vira aviso, e os outros carregam', async () => {
    const { sourceControl } = fakeProvider(3, { failing: ['p01'] });
    const board = await getAllProjectsBoard({ sourceControl, reasonOf: (error) => `motivo: ${(error as Error).message}` });
    expect(board.items.map((item) => item.project.id)).toEqual(['p00', 'p02']);
    expect(board.failed).toEqual([{ project: { id: 'p01', name: 'Projeto 01' }, reason: 'motivo: fora do ar' }]);
  });

  it('token recusado derruba a conexão inteira, não só o projeto', async () => {
    const { sourceControl } = fakeProvider(3, { failing: ['p01'], error: () => new ConnectionExpiredError('c1', 'org') });
    await expect(getAllProjectsBoard({ sourceControl })).rejects.toBeInstanceOf(ConnectionExpiredError);
  });

  it(`só busca projetos com PR aberto, até ${ALL_PROJECTS_LIMIT}, e conta os que ficaram de fora`, async () => {
    const { sourceControl, stats } = fakeProvider(ALL_PROJECTS_LIMIT + 6, { empty: ['p00', 'p03'] });
    const board = await getAllProjectsBoard({ sourceControl });
    expect(stats.listed).toHaveLength(ALL_PROJECTS_LIMIT);
    expect(stats.listed).not.toContain('p00');
    expect(stats.listed).not.toContain('p03');
    expect(board.projects).toHaveLength(ALL_PROJECTS_LIMIT);
    expect(board.skipped).toBe(4);
  });

  it('nunca passa de 4 requisições simultâneas e pergunta o usuário uma vez só', async () => {
    const { sourceControl, stats } = fakeProvider(12);
    await getAllProjectsBoard({ sourceControl });
    expect(stats.listed).toHaveLength(12);
    expect(stats.maxInFlight).toBe(4);
    expect(stats.currentUser).toBe(1);
  });
});
