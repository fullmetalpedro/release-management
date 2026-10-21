import type { BoardColumnId, PullRequestCard } from './api';

const DAY = 24 * 3_600_000;

// Faixas da espera: até 1 dia é normal, de 1 a 2 dias pede atenção, acima de 2 dias o PR está parado.
export const WAITING_LIMITS = { attentionAfterMs: DAY, staleAfterMs: 2 * DAY } as const;
export const STALE_DAYS = WAITING_LIMITS.staleAfterMs / DAY;

export type WaitingBand = 'fresh' | 'attention' | 'stale';

export function waitingBand(since: string, now: number): WaitingBand {
  const elapsed = now - new Date(since).getTime();
  if (elapsed > WAITING_LIMITS.staleAfterMs) return 'stale';
  if (elapsed >= WAITING_LIMITS.attentionAfterMs) return 'attention';
  return 'fresh';
}

// Colunas em que o card mostra há quanto tempo espera por alguém.
export const WAITING_COLUMNS: BoardColumnId[] = ['dependsOnMe', 'review', 'conflict'];

// Chave do texto do badge ("Aguardando você há 3d"), pelo motivo de o PR estar na coluna.
export function waitingLabel(pr: PullRequestCard, column: BoardColumnId) {
  if (pr.reason === 'reviewer') return 'waiting.you' as const;
  if (pr.reason === 'waiting-author') return 'waiting.author' as const;
  if (column === 'conflict') return 'waiting.conflict' as const;
  return pr.hasVotes ? ('waiting.review' as const) : ('waiting.noReview' as const);
}

export type SortOrder = 'provider' | 'oldest';

// Mais antigos primeiro: quem espera há mais tempo sobe. Na ordem do provedor, nada muda.
export function sortCards(cards: PullRequestCard[], order: SortOrder): PullRequestCard[] {
  if (order !== 'oldest') return cards;
  return [...cards].sort((a, b) => new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime());
}

// O que espera há mais tempo, ou undefined numa lista vazia.
export function oldestWaiting(cards: PullRequestCard[]): string | undefined {
  return sortCards(cards, 'oldest')[0]?.waitingSince;
}
