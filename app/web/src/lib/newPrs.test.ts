import { describe, expect, it } from 'vitest';
import { createSeenMemory, diffNewPrs, recordSync } from './newPrs';

describe('diffNewPrs', () => {
  it('returns only the ids that were never seen, in order', () => {
    expect(diffNewPrs(['a', 'b', 'c', 'd'], new Set(['b', 'd']))).toEqual(['a', 'c']);
  });

  it('returns nothing when every id was seen', () => {
    expect(diffNewPrs(['a', 'b'], new Set(['a', 'b', 'z']))).toEqual([]);
  });

  it('returns nothing for an empty column', () => {
    expect(diffNewPrs([], new Set(['a']))).toEqual([]);
  });
});

describe('recordSync', () => {
  it('stays quiet on the first load', () => {
    const memory = createSeenMemory();
    expect(recordSync(memory, 'p1', ['a', 'b'])).toEqual([]);
  });

  it('reports the ids that arrive in a later sync', () => {
    const memory = createSeenMemory();
    recordSync(memory, 'p1', ['a']);
    expect(recordSync(memory, 'p1', ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(recordSync(memory, 'p1', ['a', 'b', 'c'])).toEqual([]);
  });

  it('does not report a PR that comes back to the column', () => {
    const memory = createSeenMemory();
    recordSync(memory, 'p1', ['a', 'b']);
    recordSync(memory, 'p1', ['a']);
    expect(recordSync(memory, 'p1', ['a', 'b'])).toEqual([]);
  });

  it('stays quiet when switching project or organization, and when switching back', () => {
    const memory = createSeenMemory();
    recordSync(memory, 'org1|p1', ['a']);
    expect(recordSync(memory, 'org1|p2', ['x', 'y'])).toEqual([]);
    expect(recordSync(memory, 'org2|p1', ['m'])).toEqual([]);
    // Back to the first project, with a PR that arrived meanwhile: still a fresh load, no alert.
    expect(recordSync(memory, 'org1|p1', ['a', 'b'])).toEqual([]);
    expect(recordSync(memory, 'org1|p1', ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('starts over when the scope is cleared', () => {
    const memory = createSeenMemory();
    recordSync(memory, 'p1', ['a']);
    memory.scope = undefined;
    expect(recordSync(memory, 'p1', ['a', 'b'])).toEqual([]);
  });
});
