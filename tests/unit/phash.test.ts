import { describe, expect, it } from 'vitest';
import { dHash, duplicateGroups, hamming } from '../../src/core';

describe('duplicate pictures', () => {
  const grid = (f: (x: number, y: number) => number) => Uint8Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));
  it('fingerprints survive small changes and separate different pictures', () => {
    const a = dHash(grid((x, y) => (x * 23 + y * 7) % 256));
    const brighter = dHash(grid((x, y) => Math.min(255, ((x * 23 + y * 7) % 256) + 10)));
    const other = dHash(grid((x, y) => 255 - ((x * 23 + y * 7) % 256)));
    expect(a).toHaveLength(16);
    expect(hamming(a, brighter)).toBeLessThanOrEqual(6);
    expect(hamming(a, other)).toBeGreaterThan(32);
  });
  it('groups near-identical copies under the largest one', () => {
    const g = duplicateGroups([
      { id: 'small', phash: 'f0f0f0f0f0f0f0f0', area: 100 },
      { id: 'big', phash: 'f0f0f0f0f0f0f0f1', area: 1000 },
      { id: 'other', phash: '0f0f0f0f0f0f0f0f', area: 500 },
      { id: 'nohash', area: 50 },
    ]);
    expect(g.get('small')).toBe('big');
    expect(g.get('big')).toBe('big');
    expect(g.get('other')).toBe('other');
    expect(g.get('nohash')).toBe('nohash');
  });
});
