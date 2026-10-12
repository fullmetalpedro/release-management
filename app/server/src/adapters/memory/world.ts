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

export const PEDRO: Person = { id: 'u-pedro', name: 'Pedro Carlo', email: 'pedro.carlo@example.com' };
export const MANOEL: Person = { id: 'u-manoel', name: 'Manoel Martins', email: 'manoel.martins@example.com' };
const ANA: Person = { id: 'u-ana', name: 'Ana Souza', email: 'ana.souza@example.com' };
const BRUNO: Person = { id: 'u-bruno', name: 'Bruno Lima', email: 'bruno.lima@example.com' };

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
  open('getnota-api', 1287, 'feat: validate e-invoices on receipt', MANOEL, DAY, [[PEDRO, 'pending', true], [ANA, 'pending']], { commentCount: 3 });
  open('getnota-worker', 311, 'feat: exponential retry in the tax authority integration', MANOEL, 2 * DAY, [[PEDRO, 'pending'], [ANA, 'approved']], { targetBranch: 'release/2.14' });
  open('getnota-web', 642, 'fix: pagination of the invoice list', PEDRO, 3 * HOUR, [[MANOEL, 'waiting-author'], [ANA, 'pending']], { commentCount: 5, mergeState: 'conflicts', conflictCount: 1 });
  open('getnota-api', 1279, 'refactor: extract the tax calculation service', PEDRO, 4 * DAY, [[MANOEL, 'waiting-author'], [ANA, 'pending']], { commentCount: 7 });
  open('getnota-web', 650, 'feat: filter by tax ID on the dashboard', PEDRO, 5 * HOUR, [[MANOEL, 'pending'], [ANA, 'pending']], { commentCount: 1 });
  // Aberto sem nenhum revisor: fica em "Em revisão" com o aviso no card.
  open('getnota-api', 1290, 'chore: upgrade Spring Boot to 3.4', MANOEL, DAY + HOUR, []);
  open('getnota-infra', 88, 'feat: deploy pipeline for staging', PEDRO, 2 * DAY + HOUR, [[MANOEL, 'approved'], [ANA, 'pending']], { targetBranch: 'main', commentCount: 2 });
  open('getnota-api', 1265, 'feat: export the hours report as CSV', PEDRO, 3 * DAY, [[MANOEL, 'approved'], [ANA, 'pending']], { commentCount: 2, mergeState: 'conflicts', conflictCount: 3 });
  open('getnota-web', 631, 'fix: ID number mask on sign-up forms', MANOEL, 6 * DAY, [[ANA, 'approved'], [BRUNO, 'approved']], { mergeState: 'conflicts', conflictCount: 1 });
  open('getnota-worker', 305, 'feat: invoice reprocessing queue', PEDRO, DAY + 2 * HOUR, [[MANOEL, 'approved'], [ANA, 'approved']], { commentCount: 4 });
  open('getnota-api', 1293, 'hotfix: timeout when issuing service invoices', PEDRO, 2 * HOUR, [[MANOEL, 'approved'], [ANA, 'approved']], { targetBranch: 'main' });

  // GetNota · mergeados e releases
  merged('getnota-api', 1295, 'feat: cancelled invoices report', PEDRO, DAY);
  merged('getnota-api', 1294, 'fix: tax ID validation with leading zeros', MANOEL, DAY + HOUR);
  merged('getnota-api', 1291, 'feat: date range filter on the statement', PEDRO, 2 * DAY);
  merged('getnota-api', 1289, 'chore: remove the legacy v1 endpoint', MANOEL, 2 * DAY + HOUR);
  merged('getnota-api', 1286, 'fix: error logging in the tax authority integration', PEDRO, 2 * DAY + 2 * HOUR);
  merged('getnota-api', 1284, 'feat: cost center registration', PEDRO, 2 * DAY + 5 * HOUR);
  merged('getnota-api', 1282, 'fix: rounding in the state tax calculation', MANOEL, 2 * DAY + 6 * HOUR);
  merged('getnota-api', 1276, 'feat: tax authority status webhook', PEDRO, 3 * DAY);
  merged('getnota-api', 1274, 'chore: update Hibernate dependencies', MANOEL, 3 * DAY + HOUR);
  merged('getnota-api', 1270, 'fix: duplicates when importing XML', PEDRO, 4 * DAY);
  merged('getnota-api', 1268, 'feat: audit trail for invoice changes', MANOEL, 4 * DAY + HOUR);
  merged('getnota-web', 640, 'feat: cost centers screen', PEDRO, 2 * DAY);
  merged('getnota-web', 638, 'fix: sorting of the invoice grid', MANOEL, 3 * DAY);
  merged('getnota-web', 633, 'feat: export the grid as CSV', PEDRO, 5 * DAY);

  // Lead Comex e Jane · só o suficiente para trocar de projeto
  open('leadcomex-api', 412, 'feat: batch import of export declarations', MANOEL, 5 * HOUR, [[BRUNO, 'pending'], [ANA, 'pending']], { commentCount: 1 });
  open('leadcomex-api', 409, 'fix: time zone in deadline calculation', PEDRO, 2 * DAY, [[MANOEL, 'approved'], [ANA, 'approved']]);
  open('leadcomex-web', 201, 'feat: shipments dashboard', ANA, DAY, [[MANOEL, 'pending'], [BRUNO, 'pending']], { commentCount: 2 });
  open('leadcomex-web', 198, 'chore: migrate to Vite 7', BRUNO, 3 * DAY, [[ANA, 'approved'], [MANOEL, 'pending']], { mergeState: 'conflicts', conflictCount: 2 });
  open('jane-api', 77, 'feat: recurring scheduling', MANOEL, 4 * HOUR, [[PEDRO, 'pending'], [BRUNO, 'pending']]);
  open('jane-api', 75, 'fix: expired token in the webhook', PEDRO, DAY, [[MANOEL, 'waiting-author'], [ANA, 'pending']], { commentCount: 3 });
  open('jane-api', 73, 'refactor: split out the notifications module', ANA, 2 * DAY, [[MANOEL, 'pending'], [BRUNO, 'approved']]);
  open('jane-app', 150, 'feat: dark mode', BRUNO, 6 * HOUR, [[ANA, 'pending'], [MANOEL, 'pending']], { commentCount: 4 });
  open('jane-app', 148, 'fix: keyboard covering the search field', PEDRO, 2 * DAY, [[ANA, 'approved'], [BRUNO, 'approved']]);
  open('jane-app', 146, 'feat: push notifications', ANA, 3 * DAY, [[MANOEL, 'approved'], [BRUNO, 'pending']], { mergeState: 'conflicts', conflictCount: 1 });
  open('jane-app', 141, 'chore: update the Expo SDK', MANOEL, 5 * DAY, [[ANA, 'approved'], [BRUNO, 'approved']]);

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

  const done = { name: 'Done', category: 'done' } as const;
  const testing = { name: 'In testing', category: 'testing' } as const;
  const doing = { name: 'In progress', category: 'in-progress' } as const;
  const item = (
    id: number,
    title: string,
    kind: WorkItemKind,
    state: MemoryWorkItem['state'],
    parentId?: number,
    pullRequestIds: number[] = [],
  ): MemoryWorkItem => ({ id, title, kind, state, parentId, projectId: 'p-getnota', pullRequestIds });

  const workItems: MemoryWorkItem[] = [
    item(48120, 'Cost centers in company registration', 'pbi', testing),
    item(48125, 'Cost center registration (API)', 'task', done, 48120, [1284]),
    item(48140, 'State tax calculation', 'pbi', doing),
    item(48144, 'Incorrect rounding of state tax', 'bug', done, 48140, [1282]),
    item(48147, 'Prevent duplicates in XML import', 'task', done, 48140, [1270]),
    item(48150, 'Queue infrastructure', 'pbi', doing),
    item(48152, 'Update worker dependencies', 'task', doing, 48150),
    item(48160, 'Tax authority status integration', 'pbi', testing),
    item(48162, 'Tax authority status webhook', 'task', done, 48160, [1276]),
    item(48170, 'Tax audit', 'pbi', doing),
    item(48173, 'Record invoice changes', 'task', testing, 48170, [1268]),
    item(48180, 'Technical maintenance', 'pbi', doing),
    item(48181, 'Update backend dependencies', 'task', done, 48180),
    item(48176, 'Review vulnerable dependencies', 'task', doing, 48180),
    item(48190, 'Tax reports', 'pbi', doing),
    item(48191, 'Cancelled invoices report', 'task', done, 48190, [1295]),
    item(48193, 'Date range filter on the statement', 'task', testing, 48190, [1291]),
    item(48148, 'Tax ID validation rejects leading zeros', 'bug', done, 48140),
  ];

  return { me: PEDRO, projects, repositories, pullRequests, releases, workItems };
}
