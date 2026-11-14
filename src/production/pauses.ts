/**
 * Pause tightening (idea from auto-editor, Unlicense — re-implemented, no code copied): long pauses
 * in the narration are shortened to a natural length, keeping a margin of silence on both sides so no
 * breath or syllable is clipped. Pure planning + time remapping; the engine renders the copy.
 */
import type { Interval } from './align';

export interface TightenOptions {
  /** Pauses longer than this are shortened (s). */
  maxPause: number;
  /** Length a shortened pause keeps (s). */
  keepPause: number;
}

// podcast pacing: any pause over half a second is brought down to about a third of a second
export const DEFAULT_TIGHTEN: TightenOptions = { maxPause: 0.5, keepPause: 0.32 };

export interface TightenPlan {
  /** Source ranges kept, in order. */
  keep: Interval[];
  removedSec: number;
  pauses: number;
}

export function planTighten(silences: Interval[], duration: number, o: TightenOptions = DEFAULT_TIGHTEN): TightenPlan {
  const keep: Interval[] = [];
  let cursor = 0;
  let removed = 0;
  let pauses = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const len = s.end - s.start;
    // the very beginning and end of the recording are left alone
    if (len <= o.maxPause || s.start <= 0.05 || s.end >= duration - 0.05) continue;
    const half = o.keepPause / 2;
    const cutA = s.start + half;
    const cutB = s.end - half;
    if (cutB - cutA < 0.05 || cutA < cursor) continue;
    keep.push({ start: cursor, end: cutA });
    cursor = cutB;
    removed += cutB - cutA;
    pauses++;
  }
  keep.push({ start: cursor, end: duration });
  return { keep, removedSec: +removed.toFixed(3), pauses };
}

/** Source time → time in the tightened file (a time inside a removed span maps to the cut). */
export function remapTime(t: number, keep: Interval[]): number {
  let out = 0;
  for (const k of keep) {
    if (t <= k.start) return out;
    if (t <= k.end) return out + (t - k.start);
    out += k.end - k.start;
  }
  return out;
}
