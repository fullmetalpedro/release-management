import { describe, expect, it } from 'vitest';
import type { LanePullRequest, ReleaseDetails, WorkItemSummary } from './api';
import {
  buildReleaseNotes,
  changeType,
  parseInline,
  parseMarkdown,
  toPlainText,
  type ReleaseNotesOptions,
} from './releaseNotes';

const person = { name: 'Sam', isMe: false, avatarKey: undefined };
const pr = (id: number, title: string): LanePullRequest => ({
  id,
  title,
  author: person,
  mergedAt: undefined,
  webUrl: `https://git/pr/${id}`,
});
const item = (id: number, title: string, kind: WorkItemSummary['kind'] = 'pbi', key?: string): WorkItemSummary => ({
  id,
  key,
  title,
  kind,
  state: { name: 'Done', category: 'done' },
  webUrl: `https://tracker/${id}`,
});

const details: ReleaseDetails = {
  syncedAt: '2026-10-18T00:00:00Z',
  repository: { id: 'r', name: 'api' },
  release: {
    name: 'release/1.4',
    isLatest: true,
    createdAt: undefined,
    createdBy: undefined,
    baseBranch: undefined,
    webUrl: 'https://git/release/1.4',
  },
  summary: { pullRequests: 4, tasks: 2, pbis: 2, unlinked: 1 },
  groups: [
    {
      pbi: item(10, 'Checkout'),
      tasks: 2,
      pullRequests: 2,
      rows: [
        { task: item(101, 'Task A', 'task'), pullRequest: pr(1, 'feat(cart): add coupon') },
        { task: item(102, 'Task B', 'task'), pullRequest: pr(1, 'feat(cart): add coupon') },
        { task: null, pullRequest: pr(2, 'fix: rounding [cents]') },
      ],
    },
    {
      pbi: item(20, 'Reports'),
      tasks: 0,
      pullRequests: 2,
      rows: [
        { task: null, pullRequest: pr(1, 'feat(cart): add coupon') },
        { task: null, pullRequest: pr(3, 'chore: bump deps') },
      ],
    },
  ],
  unlinked: [{ ...pr(4, 'Update README'), suggestedTerm: 'readme' }],
};

const labels = {
  types: { features: 'Features', fixes: 'Fixes', maintenance: 'Maintenance', others: 'Other' },
  unlinked: 'No linked item',
  empty: 'No pull requests.',
};
const options = (overrides: Partial<ReleaseNotesOptions> = {}): ReleaseNotesOptions => ({
  groupByType: true,
  includeLinks: true,
  includeUnlinked: true,
  labels,
  ...overrides,
});

describe('changeType', () => {
  it('reads the conventional prefix and drops it from the title', () => {
    expect(changeType('feat(api)!: new thing')).toEqual({ type: 'features', rest: 'new thing' });
    expect(changeType('Fix: crash')).toEqual({ type: 'fixes', rest: 'crash' });
    expect(changeType('refactor: tidy')).toEqual({ type: 'maintenance', rest: 'tidy' });
    expect(changeType('Update README')).toEqual({ type: 'others', rest: 'Update README' });
    expect(changeType('wip: something')).toEqual({ type: 'others', rest: 'wip: something' });
  });
});

describe('buildReleaseNotes', () => {
  it('groups by type, lists each PR once with its backlog items (not the tasks) and links', () => {
    expect(buildReleaseNotes(details, options())).toBe(
      [
        '# release/1.4',
        '',
        '## Features',
        '',
        '- [\\#1](https://git/pr/1) add coupon ([PBI 10](https://tracker/10), [PBI 20](https://tracker/20))',
        '',
        '## Fixes',
        '',
        '- [\\#2](https://git/pr/2) rounding \\[cents\\] ([PBI 10](https://tracker/10))',
        '',
        '## Maintenance',
        '',
        '- [\\#3](https://git/pr/3) bump deps ([PBI 20](https://tracker/20))',
        '',
        '## Other',
        '',
        '- [\\#4](https://git/pr/4) Update README',
        '',
      ].join('\n'),
    );
  });

  it('groups by backlog item like the screen, with the unlinked PRs last', () => {
    expect(buildReleaseNotes(details, options({ groupByType: false, includeLinks: false }))).toBe(
      [
        '# release/1.4',
        '',
        '## PBI 10 · Checkout',
        '',
        '- \\#1 feat\\(cart\\): add coupon',
        '- \\#2 fix: rounding \\[cents\\]',
        '',
        '## PBI 20 · Reports',
        '',
        '- \\#1 feat\\(cart\\): add coupon',
        '- \\#3 chore: bump deps',
        '',
        '## No linked item',
        '',
        '- \\#4 Update README',
        '',
      ].join('\n'),
    );
  });

  it('leaves the unlinked PRs out when asked', () => {
    expect(buildReleaseNotes(details, options({ includeUnlinked: false }))).not.toContain('README');
    expect(buildReleaseNotes(details, options({ groupByType: false, includeUnlinked: false }))).not.toContain('No linked item');
  });

  it('uses the Jira key for the item', () => {
    const jira = { ...details, groups: [{ ...details.groups[0]!, pbi: item(10, 'Checkout', 'pbi', 'SHOP-7') }] };
    expect(buildReleaseNotes(jira, options({ groupByType: false, includeLinks: false }))).toContain('## SHOP-7 · Checkout');
  });

  it('says so when there is nothing to list, and returns nothing without a release', () => {
    const empty = { ...details, groups: [], unlinked: [] };
    expect(buildReleaseNotes(empty, options())).toBe('# release/1.4\n\nNo pull requests.\n');
    expect(buildReleaseNotes({ ...details, release: null }, options())).toBe('');
  });
});

describe('markdown reading', () => {
  it('turns the generated markdown back into headings, lists and links', () => {
    const blocks = parseMarkdown(buildReleaseNotes(details, options()));
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, content: [{ kind: 'text', text: 'release/1.4' }] });
    expect(blocks[2]).toEqual({
      kind: 'list',
      items: [
        [
          { kind: 'link', text: '#1', url: 'https://git/pr/1' },
          { kind: 'text', text: ' add coupon (' },
          { kind: 'link', text: 'PBI 10', url: 'https://tracker/10' },
          { kind: 'text', text: ', ' },
          { kind: 'link', text: 'PBI 20', url: 'https://tracker/20' },
          { kind: 'text', text: ')' },
        ],
      ],
    });
  });

  it('keeps parentheses in URLs inside the link', () => {
    const notes = buildReleaseNotes(
      { ...details, groups: [], unlinked: [{ ...pr(5, 'x'), webUrl: 'https://git/pr/(5) a', suggestedTerm: '' }] },
      options(),
    );
    expect(parseInline(notes.split('\n').find((line) => line.startsWith('- '))!.slice(2))[0]).toEqual({
      kind: 'link',
      text: '#5',
      url: 'https://git/pr/%285%29%20a',
    });
  });

  it('writes plain text without markup', () => {
    expect(toPlainText(buildReleaseNotes(details, options({ includeLinks: false, includeUnlinked: false })))).toBe(
      [
        'release/1.4',
        '===========',
        '',
        'Features',
        '--------',
        '',
        '• #1 add coupon (PBI 10, PBI 20)',
        '',
        'Fixes',
        '-----',
        '',
        '• #2 rounding [cents] (PBI 10)',
        '',
        'Maintenance',
        '-----------',
        '',
        '• #3 bump deps (PBI 20)',
        '',
      ].join('\n'),
    );
    expect(toPlainText('- [#1](https://git/pr/1) x')).toBe('• #1 (https://git/pr/1) x\n');
    // O sublinhado mede o título sem as URLs.
    expect(toPlainText('## [PBI 1](https://t/1) · X')).toBe('PBI 1 (https://t/1) · X\n---------\n');
  });
});
