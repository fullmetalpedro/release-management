import type {
  Person,
  Project,
  PullRequest,
  Repository,
  ReviewDecision,
  WorkItemKind,
  WorkItemStateCategory,
} from '../../core/domain/types.ts';

// Dados de demonstração: os mesmos que aparecem nas telas do design.

export interface MemoryWorkItem {
  id: number;
  title: string;
  kind: WorkItemKind;
  state: { name: string; category: WorkItemStateCategory };
  parentId?: number;
  projectId: string;
  pullRequestIds: number[];
}

export interface MemoryRelease {
  name: string;
  repositoryId: string;
  createdAt: string;
  createdBy: Person;
  baseBranch: string;
  pullRequestIds: number[];
}

export interface World {
  me: Person;
  projects: Project[];
  repositories: Repository[];
  pullRequests: PullRequest[];
  releases: MemoryRelease[];
  workItems: MemoryWorkItem[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const PEDRO: Person = { id: 'u-pedro', name: 'Pedro Carlo', email: 'pedro.carlo@muralis.com.br' };
export const MANOEL: Person = { id: 'u-manoel', name: 'Manoel Martins', email: 'manoel.martins@muralis.com.br' };
const ANA: Person = { id: 'u-ana', name: 'Ana Souza', email: 'ana.souza@muralis.com.br' };
const BRUNO: Person = { id: 'u-bruno', name: 'Bruno Lima', email: 'bruno.lima@muralis.com.br' };

type Vote = [Person, ReviewDecision, required?: boolean];

export function createWorld(now = Date.now()): World {
  const projects: Project[] = [
    { id: 'p-getnota', name: 'GetNota' },
    { id: 'p-leadcomex', name: 'Lead Comex' },
    { id: 'p-jane', name: 'Jane' },
  ];
  const repo = (id: string, projectId: string): Repository => ({ id: `r-${id}`, name: id, projectId });
  const repositories = [
    repo('getnota-api', 'p-getnota'),
    repo('getnota-web', 'p-getnota'),
    repo('getnota-worker', 'p-getnota'),
    repo('getnota-infra', 'p-getnota'),
    repo('leadcomex-api', 'p-leadcomex'),
    repo('leadcomex-web', 'p-leadcomex'),
    repo('jane-api', 'p-jane'),
    repo('jane-app', 'p-jane'),
  ];
  const repoByName = (name: string) => repositories.find((r) => r.name === name)!;
  const ago = (ms: number) => new Date(now - ms).toISOString();

  const pullRequests: PullRequest[] = [];
  const open = (
    repoName: string,
    id: number,
    title: string,
    author: Person,
    age: number,
    votes: Vote[],
    extra: Partial<PullRequest> = {},
  ) => {
    const repository = repoByName(repoName);
    pullRequests.push({
      provider: 'azure-devops',
      id,
      title,
      repository,
      sourceBranch: `feature/${id}`,
      targetBranch: 'develop',
      author,
      createdAt: ago(age),
      status: 'open',
      isDraft: false,
      mergeState: 'clean',
      conflictCount: 0,
      commentCount: 0,
      reviews: votes.map(([reviewer, decision, required]) => ({ reviewer, decision, required: required ?? false })),
      webUrl: `https://dev.azure.com/demo/${repository.projectId}/_git/${repoName}/pullrequest/${id}`,
      ...extra,
    });
  };
  const merged = (repoName: string, id: number, title: string, author: Person, age: number) => {
    open(repoName, id, title, author, age + DAY, [[author === PEDRO ? MANOEL : PEDRO, 'approved']], {
      status: 'merged',
      closedAt: ago(age),
    });
  };

  // GetNota · board
  open('getnota-api', 1287, 'feat: validação de NF-e no recebimento', MANOEL, DAY, [[PEDRO, 'pending', true], [ANA, 'pending']], { commentCount: 3 });
  open('getnota-worker', 311, 'feat: retry exponencial na integração com a Sefaz', MANOEL, 2 * DAY, [[PEDRO, 'pending'], [ANA, 'approved']], { targetBranch: 'release/2.14' });
  open('getnota-web', 642, 'fix: paginação da listagem de notas fiscais', PEDRO, 3 * HOUR, [[MANOEL, 'waiting-author'], [ANA, 'pending']], { commentCount: 5, mergeState: 'conflicts', conflictCount: 1 });
  open('getnota-api', 1279, 'refactor: extrair serviço de cálculo de impostos', PEDRO, 4 * DAY, [[MANOEL, 'waiting-author'], [ANA, 'pending']], { commentCount: 7 });
  open('getnota-web', 650, 'feat: filtro por CNPJ no dashboard', PEDRO, 5 * HOUR, [[MANOEL, 'pending'], [ANA, 'pending']], { commentCount: 1 });
  open('getnota-api', 1290, 'chore: atualizar Spring Boot para 3.4', MANOEL, DAY + HOUR, [[ANA, 'approved'], [BRUNO, 'pending']]);
  open('getnota-infra', 88, 'feat: pipeline de deploy em homologação', PEDRO, 2 * DAY + HOUR, [[MANOEL, 'approved'], [ANA, 'pending']], { targetBranch: 'main', commentCount: 2 });
  open('getnota-api', 1265, 'feat: exportar relatório de horas em CSV', PEDRO, 3 * DAY, [[MANOEL, 'approved'], [ANA, 'pending']], { commentCount: 2, mergeState: 'conflicts', conflictCount: 3 });
  open('getnota-web', 631, 'fix: máscara de CPF nos formulários de cadastro', MANOEL, 6 * DAY, [[ANA, 'approved'], [BRUNO, 'approved']], { mergeState: 'conflicts', conflictCount: 1 });
  open('getnota-worker', 305, 'feat: fila de reprocessamento de notas', PEDRO, DAY + 2 * HOUR, [[MANOEL, 'approved'], [ANA, 'approved']], { commentCount: 4 });
  open('getnota-api', 1293, 'hotfix: timeout na emissão de NFS-e', PEDRO, 2 * HOUR, [[MANOEL, 'approved'], [ANA, 'approved']], { targetBranch: 'main' });

  // GetNota · mergeados e releases
  merged('getnota-api', 1295, 'feat: relatório de notas canceladas', PEDRO, DAY);
  merged('getnota-api', 1294, 'fix: validação de CNPJ com zeros à esquerda', MANOEL, DAY + HOUR);
  merged('getnota-api', 1291, 'feat: filtro por período no extrato', PEDRO, 2 * DAY);
  merged('getnota-api', 1289, 'chore: remover endpoint legado da v1', MANOEL, 2 * DAY + HOUR);
  merged('getnota-api', 1286, 'fix: log de erro na integração com a Sefaz', PEDRO, 2 * DAY + 2 * HOUR);
  merged('getnota-api', 1284, 'feat: cadastro de centros de custo', PEDRO, 2 * DAY + 5 * HOUR);
  merged('getnota-api', 1282, 'fix: arredondamento no cálculo de ICMS', MANOEL, 2 * DAY + 6 * HOUR);
  merged('getnota-api', 1276, 'feat: webhook de status da Sefaz', PEDRO, 3 * DAY);
  merged('getnota-api', 1274, 'chore: atualizar dependências do Hibernate', MANOEL, 3 * DAY + HOUR);
  merged('getnota-api', 1270, 'fix: duplicidade ao importar XML', PEDRO, 4 * DAY);
  merged('getnota-api', 1268, 'feat: auditoria de alterações em notas', MANOEL, 4 * DAY + HOUR);
  merged('getnota-web', 640, 'feat: tela de centros de custo', PEDRO, 2 * DAY);
  merged('getnota-web', 638, 'fix: ordenação da grade de notas', MANOEL, 3 * DAY);
  merged('getnota-web', 633, 'feat: exportação da grade em CSV', PEDRO, 5 * DAY);

  // Lead Comex e Jane · só o suficiente para trocar de projeto
  open('leadcomex-api', 412, 'feat: importação de DU-E em lote', MANOEL, 5 * HOUR, [[BRUNO, 'pending'], [ANA, 'pending']], { commentCount: 1 });
  open('leadcomex-api', 409, 'fix: fuso horário no cálculo de prazos', PEDRO, 2 * DAY, [[MANOEL, 'approved'], [ANA, 'approved']]);
  open('leadcomex-web', 201, 'feat: painel de embarques', ANA, DAY, [[MANOEL, 'pending'], [BRUNO, 'pending']], { commentCount: 2 });
  open('leadcomex-web', 198, 'chore: migrar para o Vite 7', BRUNO, 3 * DAY, [[ANA, 'approved'], [MANOEL, 'pending']], { mergeState: 'conflicts', conflictCount: 2 });
  open('jane-api', 77, 'feat: agendamento recorrente', MANOEL, 4 * HOUR, [[PEDRO, 'pending'], [BRUNO, 'pending']]);
  open('jane-api', 75, 'fix: token expirado no webhook', PEDRO, DAY, [[MANOEL, 'waiting-author'], [ANA, 'pending']], { commentCount: 3 });
  open('jane-api', 73, 'refactor: separar módulo de notificações', ANA, 2 * DAY, [[MANOEL, 'pending'], [BRUNO, 'approved']]);
  open('jane-app', 150, 'feat: modo escuro', BRUNO, 6 * HOUR, [[ANA, 'pending'], [MANOEL, 'pending']], { commentCount: 4 });
  open('jane-app', 148, 'fix: teclado cobrindo o campo de busca', PEDRO, 2 * DAY, [[ANA, 'approved'], [BRUNO, 'approved']]);
  open('jane-app', 146, 'feat: notificações push', ANA, 3 * DAY, [[MANOEL, 'approved'], [BRUNO, 'pending']], { mergeState: 'conflicts', conflictCount: 1 });
  open('jane-app', 141, 'chore: atualizar SDK do Expo', MANOEL, 5 * DAY, [[ANA, 'approved'], [BRUNO, 'approved']]);

  const releases: MemoryRelease[] = [
    {
      name: 'release/2.15',
      repositoryId: 'r-getnota-api',
      createdAt: ago(2 * DAY + 3 * HOUR),
      createdBy: MANOEL,
      baseBranch: 'develop',
      pullRequestIds: [1284, 1282, 1276, 1274, 1270, 1268],
    },
    {
      name: 'release/2.14',
      repositoryId: 'r-getnota-api',
      createdAt: ago(16 * DAY),
      createdBy: PEDRO,
      baseBranch: 'develop',
      pullRequestIds: [],
    },
    {
      name: 'release/1.8',
      repositoryId: 'r-getnota-web',
      createdAt: ago(4 * DAY),
      createdBy: PEDRO,
      baseBranch: 'develop',
      pullRequestIds: [633],
    },
  ];

  const done = { name: 'Concluída', category: 'done' } as const;
  const testing = { name: 'Em teste', category: 'testing' } as const;
  const doing = { name: 'Em andamento', category: 'in-progress' } as const;
  const item = (
    id: number,
    title: string,
    kind: WorkItemKind,
    state: MemoryWorkItem['state'],
    parentId?: number,
    pullRequestIds: number[] = [],
  ): MemoryWorkItem => ({ id, title, kind, state, parentId, projectId: 'p-getnota', pullRequestIds });

  const workItems: MemoryWorkItem[] = [
    item(48120, 'Centros de custo no cadastro de empresas', 'pbi', testing),
    item(48125, 'Cadastro de centros de custo (API)', 'task', done, 48120, [1284]),
    item(48140, 'Cálculo de impostos estaduais', 'pbi', doing),
    item(48144, 'Arredondamento incorreto no ICMS', 'bug', done, 48140, [1282]),
    item(48147, 'Evitar duplicidade na importação de XML', 'task', done, 48140, [1270]),
    item(48150, 'Infra de filas', 'pbi', doing),
    item(48152, 'Atualizar dependências do worker', 'task', doing, 48150),
    item(48160, 'Integração com status da Sefaz', 'pbi', testing),
    item(48162, 'Webhook de status da Sefaz', 'task', done, 48160, [1276]),
    item(48170, 'Auditoria fiscal', 'pbi', doing),
    item(48173, 'Registrar alterações em notas', 'task', testing, 48170, [1268]),
    item(48180, 'Manutenção técnica', 'pbi', doing),
    item(48181, 'Atualizar dependências do backend', 'task', done, 48180),
    item(48176, 'Revisar dependências vulneráveis', 'task', doing, 48180),
    item(48190, 'Relatórios fiscais', 'pbi', doing),
    item(48191, 'Relatório de notas canceladas', 'task', done, 48190, [1295]),
    item(48193, 'Filtro por período no extrato', 'task', testing, 48190, [1291]),
    item(48148, 'Validação de CNPJ rejeita zeros à esquerda', 'bug', done, 48140),
  ];

  return { me: PEDRO, projects, repositories, pullRequests, releases, workItems };
}
