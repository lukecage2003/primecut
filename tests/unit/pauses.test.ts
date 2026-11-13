import { describe, expect, it } from 'vitest';
import { planTighten, remapTime } from '../../src/production';

describe('pause tightening', () => {
  it('shortens only long inner pauses, keeping a natural gap, and remaps times', () => {
    const sil = [{ start: 0, end: 0.5 }, { start: 3, end: 5 }, { start: 8, end: 8.4 }, { start: 11, end: 12.5 }, { start: 15.8, end: 16 }];
    const p = planTighten(sil, 16, { maxPause: 0.75, keepPause: 0.45 });
    expect(p.pauses).toBe(2); // 2 s and 1.5 s pauses; the leading/trailing silence and 0.4 s pause stay
    expect(p.removedSec).toBeCloseTo(2 - 0.45 + 1.5 - 0.45, 6);
    expect(remapTime(2, p.keep)).toBeCloseTo(2, 6); // before the first cut
    expect(remapTime(5.5, p.keep)).toBeCloseTo(5.5 - (2 - 0.45), 6); // after it
    expect(remapTime(4, p.keep)).toBeCloseTo(3.225, 6); // inside a removed span → the cut
    expect(remapTime(16, p.keep)).toBeCloseTo(16 - p.removedSec, 6);
  });
});
