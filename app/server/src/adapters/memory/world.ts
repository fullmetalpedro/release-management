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

export const ALEX: Person = { id: 'u-alex', name: 'Alex Rivera', email: 'alex.rivera@example.com' };
export const SAM: Person = { id: 'u-sam', name: 'Sam Carter', email: 'sam.carter@example.com' };
const AMY: Person = { id: 'u-amy', name: 'Amy Chen', email: 'amy.chen@example.com' };
const BEN: Person = { id: 'u-ben', name: 'Ben Fischer', email: 'ben.fischer@example.com' };

// O quarto item é há quanto tempo a pessoa votou.
type Vote = [Person, ReviewDecision, required?: boolean, votedAgo?: number];

export function createWorld(now = Date.now()): World {
  const projects: Project[] = [
    { id: 'p-invoicing', name: 'Invoicing' },
    { id: 'p-trade', name: 'Trade Desk' },
    { id: 'p-scheduler', name: 'Scheduler' },
  ];
  const repo = (id: string, projectId: string): Repository => ({ id: `r-${id}`, name: id, projectId });
  const repositories = [
    repo('invoicing-api', 'p-invoicing'),
    repo('invoicing-web', 'p-invoicing'),
    repo('invoicing-worker', 'p-invoicing'),
    repo('invoicing-infra', 'p-invoicing'),
    repo('trade-api', 'p-trade'),
    repo('trade-web', 'p-trade'),
    repo('scheduler-api', 'p-scheduler'),
    repo('scheduler-app', 'p-scheduler'),
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
      reviews: votes.map(([reviewer, decision, required, votedAgo]) => ({
        reviewer,
        decision,
        required: required ?? false,
        votedAt: votedAgo === undefined ? undefined : ago(votedAgo),
      })),
      webUrl: `https://dev.azure.com/demo/${repository.projectId}/_git/${repoName}/pullrequest/${id}`,
      ...extra,
    });
  };
  const merged = (repoName: string, id: number, title: string, author: Person, age: number) => {
    open(repoName, id, title, author, age + DAY, [[author === ALEX ? SAM : ALEX, 'approved']], {
      status: 'merged',
      closedAt: ago(age),
    });
  };

  // Invoicing · board
  open('invoicing-api', 1287, 'feat: validate e-invoices on receipt', SAM, DAY, [[ALEX, 'pending', true], [AMY, 'pending']], { commentCount: 3 });
  // O voto da Amy, há 3h, não zera o relógio de quem ainda deve a revisão.
  open('invoicing-worker', 311, 'feat: exponential retry in the tax authority integration', SAM, 2 * DAY + 4 * HOUR, [[ALEX, 'pending'], [AMY, 'approved', false, 3 * HOUR]], { targetBranch: 'release/2.14' });
  open('invoicing-web', 642, 'fix: pagination of the invoice list', ALEX, 3 * HOUR, [[SAM, 'waiting-author', false, HOUR], [AMY, 'pending']], { commentCount: 5, mergeState: 'conflicts', conflictCount: 1 });
  open('invoicing-api', 1279, 'refactor: extract the tax calculation service', ALEX, 4 * DAY, [[SAM, 'waiting-author', false, 3 * DAY], [AMY, 'pending']], { commentCount: 7 });
  open('invoicing-web', 650, 'feat: filter by tax ID on the dashboard', ALEX, 5 * HOUR, [[SAM, 'pending'], [AMY, 'pending']], { commentCount: 1, lastPushAt: ago(2 * HOUR) });
  // Aberto sem nenhum revisor: fica em "Em revisão" com o aviso no card.
  open('invoicing-api', 1290, 'chore: upgrade Spring Boot to 3.4', SAM, DAY + HOUR, []);
  open('invoicing-infra', 88, 'feat: deploy pipeline for staging', ALEX, 2 * DAY + HOUR, [[SAM, 'approved', false, DAY], [AMY, 'pending']], { targetBranch: 'main', commentCount: 2, lastPushAt: ago(DAY + 2 * HOUR) });
  open('invoicing-api', 1265, 'feat: export the hours report as CSV', ALEX, 3 * DAY, [[SAM, 'approved'], [AMY, 'pending']], { commentCount: 2, mergeState: 'conflicts', conflictCount: 3, lastPushAt: ago(DAY + 5 * HOUR) });
  open('invoicing-web', 631, 'fix: ID number mask on sign-up forms', SAM, 6 * DAY, [[AMY, 'approved'], [BEN, 'approved']], { mergeState: 'conflicts', conflictCount: 1, lastPushAt: ago(4 * DAY) });
  open('invoicing-worker', 305, 'feat: invoice reprocessing queue', ALEX, DAY + 2 * HOUR, [[SAM, 'approved'], [AMY, 'approved']], { commentCount: 4 });
  open('invoicing-api', 1293, 'hotfix: timeout when issuing service invoices', ALEX, 2 * HOUR, [[SAM, 'approved'], [AMY, 'approved']], { targetBranch: 'main' });

  // Invoicing · mergeados e releases
  merged('invoicing-api', 1295, 'feat: cancelled invoices report', ALEX, DAY);
  merged('invoicing-api', 1294, 'fix: tax ID validation with leading zeros', SAM, DAY + HOUR);
  merged('invoicing-api', 1291, 'feat: date range filter on the statement', ALEX, 2 * DAY);
  merged('invoicing-api', 1289, 'chore: remove the legacy v1 endpoint', SAM, 2 * DAY + HOUR);
  merged('invoicing-api', 1286, 'fix: error logging in the tax authority integration', ALEX, 2 * DAY + 2 * HOUR);
  merged('invoicing-api', 1284, 'feat: cost center registration', ALEX, 2 * DAY + 5 * HOUR);
  merged('invoicing-api', 1282, 'fix: rounding in the state tax calculation', SAM, 2 * DAY + 6 * HOUR);
  merged('invoicing-api', 1276, 'feat: tax authority status webhook', ALEX, 3 * DAY);
  merged('invoicing-api', 1274, 'chore: update Hibernate dependencies', SAM, 3 * DAY + HOUR);
  merged('invoicing-api', 1270, 'fix: duplicates when importing XML', ALEX, 4 * DAY);
  merged('invoicing-api', 1268, 'feat: audit trail for invoice changes', SAM, 4 * DAY + HOUR);
  merged('invoicing-web', 640, 'feat: cost centers screen', ALEX, 2 * DAY);
  merged('invoicing-web', 638, 'fix: sorting of the invoice grid', SAM, 3 * DAY);
  merged('invoicing-web', 633, 'feat: export the grid as CSV', ALEX, 5 * DAY);

  // Trade Desk e Scheduler · só o suficiente para trocar de projeto
  open('trade-api', 412, 'feat: batch import of export declarations', SAM, 5 * HOUR, [[BEN, 'pending'], [AMY, 'pending']], { commentCount: 1 });
  open('trade-api', 409, 'fix: time zone in deadline calculation', ALEX, 2 * DAY, [[SAM, 'approved'], [AMY, 'approved']]);
  open('trade-web', 201, 'feat: shipments dashboard', AMY, DAY, [[SAM, 'pending'], [BEN, 'pending']], { commentCount: 2 });
  open('trade-web', 198, 'chore: migrate to Vite 7', BEN, 3 * DAY, [[AMY, 'approved'], [SAM, 'pending']], { mergeState: 'conflicts', conflictCount: 2 });
  open('scheduler-api', 77, 'feat: recurring scheduling', SAM, 4 * HOUR, [[ALEX, 'pending'], [BEN, 'pending']]);
  open('scheduler-api', 75, 'fix: expired token in the webhook', ALEX, DAY, [[SAM, 'waiting-author'], [AMY, 'pending']], { commentCount: 3 });
  open('scheduler-api', 73, 'refactor: split out the notifications module', AMY, 2 * DAY, [[SAM, 'pending'], [BEN, 'approved']]);
  open('scheduler-app', 150, 'feat: dark mode', BEN, 6 * HOUR, [[AMY, 'pending'], [SAM, 'pending']], { commentCount: 4 });
  open('scheduler-app', 148, 'fix: keyboard covering the search field', ALEX, 2 * DAY, [[AMY, 'approved'], [BEN, 'approved']]);
  open('scheduler-app', 146, 'feat: push notifications', AMY, 3 * DAY, [[SAM, 'approved'], [BEN, 'pending']], { mergeState: 'conflicts', conflictCount: 1 });
  open('scheduler-app', 141, 'chore: update the Expo SDK', SAM, 5 * DAY, [[AMY, 'approved'], [BEN, 'approved']]);

  const releases: MemoryRelease[] = [
    {
      name: 'release/2.15',
      repositoryId: 'r-invoicing-api',
      createdAt: ago(2 * DAY + 3 * HOUR),
      createdBy: SAM,
      baseBranch: 'develop',
      pullRequestIds: [1284, 1282, 1276, 1274, 1270, 1268],
    },
    {
      name: 'release/2.14',
      repositoryId: 'r-invoicing-api',
      createdAt: ago(16 * DAY),
      createdBy: ALEX,
      baseBranch: 'develop',
      pullRequestIds: [],
    },
    {
      name: 'release/1.8',
      repositoryId: 'r-invoicing-web',
      createdAt: ago(4 * DAY),
      createdBy: ALEX,
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
  ): MemoryWorkItem => ({ id, title, kind, state, parentId, projectId: 'p-invoicing', pullRequestIds });

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

  return { me: ALEX, projects, repositories, pullRequests, releases, workItems };
}
