// Modelo canônico: nenhum tipo aqui conhece Azure DevOps, GitHub ou Jira.

export type ProviderId = 'azure-devops' | 'github' | 'jira';

export interface Person {
  id: string;
  name: string;
  email?: string;
  // Chave opaca com que o provedor localiza a foto da pessoa.
  avatarKey?: string;
}

export interface Avatar {
  contentType: string;
  data: Buffer;
}

export interface Project {
  id: string;
  name: string;
}

export interface Repository {
  id: string;
  name: string;
  projectId: string;
}

export type ReviewDecision = 'approved' | 'rejected' | 'waiting-author' | 'pending';

export interface Review {
  reviewer: Person;
  decision: ReviewDecision;
  // O voto deste revisor é exigido pela política do repositório.
  required: boolean;
}

export type MergeState = 'clean' | 'conflicts' | 'unknown';

export interface PullRequest {
  provider: ProviderId;
  id: number;
  title: string;
  repository: Repository;
  sourceBranch: string;
  targetBranch: string;
  author: Person;
  createdAt: string;
  closedAt?: string;
  status: 'open' | 'merged';
  isDraft: boolean;
  mergeState: MergeState;
  conflictCount: number;
  commentCount: number;
  reviews: Review[];
  // Política de branch, quando o provedor informa: mínimo de aprovações e se alguma política obrigatória ainda barra o merge.
  requiredApprovals?: number;
  blockedByPolicy?: boolean;
  webUrl: string;
}

export type WorkItemKind = 'pbi' | 'task' | 'bug' | 'other';
export type WorkItemStateCategory = 'todo' | 'in-progress' | 'testing' | 'done' | 'removed';

export interface WorkItemSummary {
  id: number;
  // Identificador que o usuário reconhece, quando não é o número (a chave "PROJ-12" do Jira).
  key?: string;
  title: string;
  kind: WorkItemKind;
  state: { name: string; category: WorkItemStateCategory };
  webUrl: string;
}

export interface WorkItem extends WorkItemSummary {
  parent?: WorkItemSummary;
}

export interface ReleaseBranch {
  name: string;
  repository: Repository;
  createdAt?: string;
  createdBy?: Person;
  // Branch de onde a release saiu, quando o provedor consegue dizer.
  baseBranch?: string;
  webUrl: string;
}

export interface PullRequestRef {
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
  // Dados do PR para ferramentas de tarefas que não conhecem o repositório (o Jira acha a issue pela
  // chave no título ou na branch, e guarda o vínculo como um link para o endereço do PR).
  title?: string;
  sourceBranch?: string;
  webUrl?: string;
}
