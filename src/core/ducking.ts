/**
 * Automatic ducking: a track (music, ambience) is lowered while another track (narration) speaks.
 *
 * Deterministic and shared by preview and export: speech activity is measured on the timeline from
 * the cached waveform peaks (100 values/s) of the source track's clips, then turned into a gain
 * envelope with look-ahead attack, hold and release. The exporter writes the envelope as volume
 * commands; the preview applies the same envelope to the Web Audio gain. Editing the narration
 * (moving, cutting, muting) changes the envelope accordingly.
 */
import type { MediaAsset, Sequence, TrackDuck } from './model';
import { planSequence } from './plan';
import { framesToSeconds } from './time';

export const PEAKS_PER_SECOND = 100;

export const DEFAULT_DUCK: Omit<TrackDuck, 'by'> = { depthDb: -10, attackMs: 250, releaseMs: 600, holdMs: 350, threshold: 0.06 };

export interface Interval {
  start: number;
  end: number;
}

/** Timeline seconds where the source track has signal above the threshold. */
export function trackActivity(seq: Sequence, media: Record<string, MediaAsset>, trackId: string, peaks: Record<string, Uint8Array | undefined>, threshold = DEFAULT_DUCK.threshold): Interval[] {
  const r = seq.settings.frameRate;
  const out: Interval[] = [];
  const thr = Math.round(threshold * 255);
  for (const it of planSequence(seq, media)) {
    if (it.kind !== 'audio' || it.track.id !== trackId) continue;
    const p = peaks[it.media.id];
    if (!p) continue;
    const t0 = framesToSeconds(it.start, r);
    const len = framesToSeconds(it.end - it.start, r);
    const speed = it.clip.speed || 1;
    let open: number | null = null;
    const n = Math.ceil(len * PEAKS_PER_SECOND);
    for (let k = 0; k <= n; k++) {
      const src = Math.floor((it.sourceIn + (k / PEAKS_PER_SECOND) * speed) * PEAKS_PER_SECOND);
      const on = k < n && (p[src] ?? 0) >= thr;
      if (on && open === null) open = t0 + k / PEAKS_PER_SECOND;
      if (!on && open !== null) {
        out.push({ start: open, end: t0 + k / PEAKS_PER_SECOND });
        open = null;
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export interface GainKey {
  t: number;
  db: number;
}

/**
 * Gain envelope (dB, piecewise linear). Gaps shorter than hold + release keep the music down, so it
 * does not pump between words; the attack starts before the voice (look-ahead).
 */
export function duckEnvelope(activity: Interval[], duck: Omit<TrackDuck, 'by'>): GainKey[] {
  const a = duck.attackMs / 1000;
  const rl = duck.releaseMs / 1000;
  const hold = duck.holdMs / 1000;
  const merged: Interval[] = [];
  for (const iv of activity) {
    const last = merged.at(-1);
    if (last && iv.start - last.end <= hold + rl + a) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  const keys: GainKey[] = [{ t: 0, db: 0 }];
  for (const iv of merged) {
    const downStart = Math.max(keys.at(-1)!.t, iv.start - a);
    keys.push({ t: downStart, db: 0 }, { t: Math.max(downStart, iv.start), db: duck.depthDb });
    const upStart = iv.end + hold;
    keys.push({ t: upStart, db: duck.depthDb }, { t: upStart + rl, db: 0 });
  }
  // drop redundant points
  return keys.filter((k, i) => i === 0 || i === keys.length - 1 || !(keys[i - 1]!.db === k.db && keys[i + 1]!.db === k.db));
}

export function gainAt(keys: GainKey[], t: number): number {
  if (!keys.length) return 0;
  let lo = 0;
  let hi = keys.length - 1;
  if (t <= keys[0]!.t) return keys[0]!.db;
  if (t >= keys[hi]!.t) return keys[hi]!.db;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const A = keys[lo]!;
  const B = keys[hi]!;
  return B.t === A.t ? B.db : A.db + ((B.db - A.db) * (t - A.t)) / (B.t - A.t);
}

/**
 * FFmpeg sendcmd script driving `volume@<name>` (linear factor) with 25 ms steps on ramps.
 * `offset` shifts timeline time to the filter's local time (export ranges).
 */
export function envelopeToSendcmd(keys: GainKey[], name: string, offset = 0, step = 0.025): string {
  const lines: string[] = [];
  let last = NaN;
  const emit = (t: number, db: number) => {
    const v = Math.pow(10, db / 20);
    if (Math.abs(v - last) < 0.002) return;
    last = v;
    lines.push(`${Math.max(0, t - offset).toFixed(3)} volume@${name} volume ${v.toFixed(4)};`);
  };
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const next = keys[i + 1];
    emit(k.t, k.db);
    if (next && next.db !== k.db) for (let t = k.t + step; t < next.t; t += step) emit(t, gainAt(keys, t));
  }
  return lines.join('\n') + '\n';
}
