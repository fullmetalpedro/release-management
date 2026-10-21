import { describe, expect, it } from 'vitest';
import type { PullRequestCard } from './api';
import { oldestWaiting, sortCards, waitingBand, waitingLabel, WAITING_LIMITS } from './waiting';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-18T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

function card(id: number, overrides: Partial<PullRequestCard> = {}): PullRequestCard {
  return {
    id,
    provider: 'azure-devops',
    title: 't',
    repository: { id: 'r', name: 'r' },
    targetBranch: 'develop',
    author: { name: 'Sam', isMe: false, avatarKey: undefined },
    createdAt: ago(10 * 24 * HOUR),
    commentCount: 0,
    conflictCount: 0,
    approvals: 0,
    reviewers: 1,
    approved: false,
    noReviewers: false,
    reason: undefined,
    requiredReviewer: false,
    waitingSince: ago(HOUR),
    hasVotes: false,
    webUrl: '',
    project: undefined,
    ...overrides,
  };
}

describe('faixa da espera', () => {
  it('menos de 1 dia é neutro, de 1 a 2 dias pede atenção, acima de 2 dias está parado', () => {
    expect(waitingBand(ago(0), now)).toBe('fresh');
    expect(waitingBand(ago(23 * HOUR), now)).toBe('fresh');
    expect(waitingBand(ago(24 * HOUR), now)).toBe('attention');
    expect(waitingBand(ago(48 * HOUR), now)).toBe('attention');
    expect(waitingBand(ago(48 * HOUR + 1000), now)).toBe('stale');
    expect(waitingBand(ago(30 * 24 * HOUR), now)).toBe('stale');
  });

  it('os limites vêm da constante', () => {
    expect(waitingBand(ago(WAITING_LIMITS.attentionAfterMs - 1), now)).toBe('fresh');
    expect(waitingBand(ago(WAITING_LIMITS.staleAfterMs + 1), now)).toBe('stale');
  });

  it('uma data no futuro (relógio adiantado no provedor) fica neutra', () => {
    expect(waitingBand(new Date(now + HOUR).toISOString(), now)).toBe('fresh');
  });
});

describe('texto do badge', () => {
  it('segue o motivo e, em revisão, se já há votos', () => {
    expect(waitingLabel(card(1, { reason: 'reviewer' }), 'dependsOnMe')).toBe('waiting.you');
    expect(waitingLabel(card(1, { reason: 'waiting-author' }), 'dependsOnMe')).toBe('waiting.author');
    expect(waitingLabel(card(1), 'review')).toBe('waiting.noReview');
    expect(waitingLabel(card(1, { hasVotes: true }), 'review')).toBe('waiting.review');
    expect(waitingLabel(card(1, { hasVotes: true }), 'conflict')).toBe('waiting.conflict');
  });
});

describe('mais antigos primeiro', () => {
  const cards = [card(1, { waitingSince: ago(HOUR) }), card(2, { waitingSince: ago(50 * HOUR) }), card(3, { waitingSince: ago(5 * HOUR) })];

  it('ordena pela espera sem mexer na lista original; na ordem do provedor nada muda', () => {
    expect(sortCards(cards, 'oldest').map((c) => c.id)).toEqual([2, 3, 1]);
    expect(cards.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(sortCards(cards, 'provider')).toBe(cards);
  });

  it('acha a maior espera da coluna', () => {
    expect(oldestWaiting(cards)).toBe(ago(50 * HOUR));
    expect(oldestWaiting([])).toBeUndefined();
  });
});
