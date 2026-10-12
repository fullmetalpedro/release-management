import type { Person, ProviderId, PullRequest } from '../domain/types.ts';
import type { SourceControl } from '../ports/sourceControl.ts';

export type BoardColumnId = 'dependsOnMe' | 'review' | 'conflict' | 'ready';
export type DependsOnMeReason = 'reviewer' | 'waiting-author';

export interface PersonView {
  name: string;
  isMe: boolean;
  avatarKey?: string;
}

export interface PullRequestCard {
  id: number;
  provider: ProviderId;
  title: string;
  repository: { id: string; name: string };
  targetBranch: string;
  author: PersonView;
  createdAt: string;
  commentCount: number;
  conflictCount: number;
  approvals: number;
  reviewers: number;
  approved: boolean;
  // Ninguém foi chamado para revisar: o card avisa, em vez de mostrar a contagem de votos.
  noReviewers: boolean;
  reason?: DependsOnMeReason;
  // Sou revisor obrigatório deste PR (e não apenas opcional).
  requiredReviewer: boolean;
  webUrl: string;
}

export interface Board {
  syncedAt: string;
  openCount: number;
  columns: Record<BoardColumnId, PullRequestCard[]>;
  repositories: { id: string; name: string }[];
}

export function toPersonView(person: Person, me: Person): PersonView {
  return { name: person.name, isMe: person.id === me.id, avatarKey: person.avatarKey };
}

// Sem política de mínimo de revisores, todos os revisores do PR precisam aprovar.
export function requiredApprovals(pr: PullRequest): number {
  return pr.requiredApprovals && pr.requiredApprovals > 0 ? pr.requiredApprovals : pr.reviews.length;
}

export function isApproved(pr: PullRequest): boolean {
  const approvals = pr.reviews.filter((r) => r.decision === 'approved').length;
  const blocked = pr.reviews.some((r) => r.decision === 'rejected' || r.decision === 'waiting-author');
  const required = requiredApprovals(pr);
  return !pr.isDraft && required > 0 && approvals >= required && !blocked && !pr.blockedByPolicy;
}

export function classify(pr: PullRequest, me: Person): { column: BoardColumnId; reason?: DependsOnMeReason } {
  const iAmAuthor = pr.author.id === me.id;
  if (iAmAuthor && pr.reviews.some((r) => r.decision === 'waiting-author' || r.decision === 'rejected')) {
    return { column: 'dependsOnMe', reason: 'waiting-author' };
  }
  const myReview = pr.reviews.find((r) => r.reviewer.id === me.id);
  // Meu voto pendente pesa quando sou revisor obrigatório ou enquanto faltam aprovações; se o que barra o PR é
  // outra política, não depende de mim.
  const approvals = pr.reviews.filter((r) => r.decision === 'approved').length;
  const myVoteIsNeeded = myReview?.decision === 'pending' && (myReview.required || approvals < requiredApprovals(pr));
  if (!iAmAuthor && !pr.isDraft && myVoteIsNeeded) {
    return { column: 'dependsOnMe', reason: 'reviewer' };
  }
  if (pr.mergeState === 'conflicts') return { column: 'conflict' };
  if (isApproved(pr)) return { column: 'ready' };
  return { column: 'review' };
}

export function toCard(pr: PullRequest, me: Person, reason?: DependsOnMeReason): PullRequestCard {
  return {
    id: pr.id,
    provider: pr.provider,
    title: pr.title,
    repository: { id: pr.repository.id, name: pr.repository.name },
    targetBranch: pr.targetBranch,
    author: toPersonView(pr.author, me),
    createdAt: pr.createdAt,
    commentCount: pr.commentCount,
    conflictCount: pr.conflictCount,
    approvals: pr.reviews.filter((r) => r.decision === 'approved').length,
    reviewers: requiredApprovals(pr),
    approved: isApproved(pr),
    noReviewers: pr.reviews.length === 0,
    reason,
    requiredReviewer: pr.reviews.some((r) => r.reviewer.id === me.id && r.required),
    webUrl: pr.webUrl,
  };
}

export async function getBoard(
  deps: { sourceControl: SourceControl; now?: () => Date },
  projectId: string,
): Promise<Board> {
  const [me, pullRequests, repositories] = await Promise.all([
    deps.sourceControl.currentUser(),
    deps.sourceControl.listOpenPullRequests(projectId),
    deps.sourceControl.listRepositories(projectId),
  ]);

  const columns: Board['columns'] = { dependsOnMe: [], review: [], conflict: [], ready: [] };
  // A ordem dentro de cada coluna é a do provedor.
  for (const pr of pullRequests) {
    const { column, reason } = classify(pr, me);
    columns[column].push(toCard(pr, me, reason));
  }

  return {
    syncedAt: (deps.now?.() ?? new Date()).toISOString(),
    openCount: pullRequests.length,
    columns,
    repositories: repositories
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
