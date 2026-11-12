/**
 * Text ↔ narration alignment.
 *
 * Two strategies behind one result type:
 * 1. `alignByPauses` — model-free, always available offline. Uses speech/silence segmentation of
 *    the narration and the script's syllable counts; sentence boundaries are matched to pauses by
 *    dynamic programming (sentence-level accuracy, word timings estimated).
 * 2. `alignToTranscript` — when a local speech recogniser produced word timestamps (optional
 *    faster-whisper sidecar), script words are aligned to recognised words (edit-distance DP), giving
 *    word-level timings that survive recognition errors.
 */
import type { ScriptSentence } from './script';
import { syllables, tokens } from './text';

export interface Interval {
  start: number;
  end: number;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
  estimated: boolean;
}

export interface AlignedSentence {
  index: number;
  start: number;
  end: number;
  words: WordTiming[];
  /** How the timing was obtained. */
  method: 'pause' | 'interpolated' | 'transcript';
}

export interface AlignmentResult {
  sentences: AlignedSentence[];
  method: 'pauses' | 'transcript';
  /** 0..1 — share of sentence boundaries anchored on real evidence (pause or recognised word). */
  confidence: number;
}

/** Speech intervals from silence intervals over a total duration. */
export function speechFromSilences(silences: Interval[], duration: number): Interval[] {
  const out: Interval[] = [];
  let t = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > t + 0.02) out.push({ start: t, end: Math.min(s.start, duration) });
    t = Math.max(t, s.end);
  }
  if (duration > t + 0.02) out.push({ start: t, end: duration });
  return out;
}

class SpeechClock {
  private cum: number[] = [];
  readonly total: number;
  constructor(readonly speech: Interval[]) {
    let c = 0;
    for (const s of speech) {
      this.cum.push(c);
      c += s.end - s.start;
    }
    this.total = c;
  }
  /** speech-time → real time (at boundaries, returns the end of the speech interval). */
  toReal(st: number): number {
    if (!this.speech.length) return st;
    for (let i = this.speech.length - 1; i >= 0; i--) {
      if (st >= this.cum[i]! - 1e-9) {
        const s = this.speech[i]!;
        return Math.min(s.end, s.start + (st - this.cum[i]!));
      }
    }
    return this.speech[0]!.start;
  }
}

function estimateWords(text: string, start: number, end: number, speech: Interval[]): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => syllables(w) + 0.3);
  const total = weights.reduce((a, b) => a + b, 0);
  // speech portions inside [start, end]
  const parts = speech.map((s) => ({ start: Math.max(s.start, start), end: Math.min(s.end, end) })).filter((p) => p.end > p.start);
  const clock = new SpeechClock(parts.length ? parts : [{ start, end }]);
  let acc = 0;
  return words.map((w, i) => {
    const s = clock.toReal((acc / total) * clock.total);
    acc += weights[i]!;
    const e = clock.toReal((acc / total) * clock.total);
    return { text: w, start: s, end: Math.max(e, s + 0.01), estimated: true };
  });
}

export interface PauseAlignOptions {
  minPause?: number;
}

export function alignByPauses(sentences: ScriptSentence[], speechIn: Interval[], opts: PauseAlignOptions = {}): AlignmentResult {
  const minPause = opts.minPause ?? 0.18;
  const speech = speechIn.filter((s) => s.end > s.start);
  if (!sentences.length || !speech.length) return { sentences: [], method: 'pauses', confidence: 0 };
  const clock = new SpeechClock(speech);
  const T = clock.total;
  const totalSyl = sentences.reduce((a, s) => a + s.syllables + 1, 0);
  // expected speech-time of each boundary (after sentence i), i = 0..n-2
  const exp: number[] = [];
  let acc = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    acc += sentences[i]!.syllables + 1;
    exp.push((acc / totalSyl) * T);
  }
  // pauses between speech intervals, with their speech-time position
  const pauses: { pos: number; len: number; start: number; end: number }[] = [];
  let st = 0;
  for (let i = 0; i < speech.length - 1; i++) {
    st += speech[i]!.end - speech[i]!.start;
    const len = speech[i + 1]!.start - speech[i]!.end;
    if (len >= minPause) pauses.push({ pos: st, len, start: speech[i]!.end, end: speech[i + 1]!.start });
  }
  const n = exp.length;
  const m = pauses.length;
  const avgSentence = T / sentences.length;
  const sigma = Math.max(0.8, avgSentence * 0.45);
  const matchCost = (i: number, j: number) => {
    const d = (exp[i]! - pauses[j]!.pos) / sigma;
    const strength = Math.min(1, pauses[j]!.len / 0.6);
    return d * d - 0.8 * strength - (sentences[i]!.breakAfter ? 0.5 * strength : 0);
  };
  const skipBoundary = 1.2;
  const skipPause = (j: number) => 0.6 * Math.min(1.5, pauses[j]!.len / 0.5);
  // dp[i][j]: best cost for first i boundaries using first j pauses
  const INF = 1e18;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const bt = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  dp[0]![0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i]![j]!;
      if (cur >= INF) continue;
      if (i < n && cur + skipBoundary < dp[i + 1]![j]!) {
        dp[i + 1]![j] = cur + skipBoundary;
        bt[i + 1]![j] = 1;
      }
      if (j < m && cur + skipPause(j) < dp[i]![j + 1]!) {
        dp[i]![j + 1] = cur + skipPause(j);
        bt[i]![j + 1] = 2;
      }
      if (i < n && j < m && cur + matchCost(i, j) < dp[i + 1]![j + 1]!) {
        dp[i + 1]![j + 1] = cur + matchCost(i, j);
        bt[i + 1]![j + 1] = 3;
      }
    }
  }
  const assign: (number | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = bt[i]![j];
    if (b === 3) {
      assign[i - 1] = j - 1;
      i--;
      j--;
    } else if (b === 1) i--;
    else j--;
  }
  // anchors in speech-time; unassigned boundaries interpolate by syllables between anchors
  const bSpeech: number[] = new Array(n);
  const anchors: { idx: number; pos: number }[] = [{ idx: -1, pos: 0 }];
  for (let k = 0; k < n; k++) if (assign[k] !== null) anchors.push({ idx: k, pos: pauses[assign[k]!]!.pos });
  anchors.push({ idx: n, pos: T });
  const cumSyl = [0];
  for (const s of sentences) cumSyl.push(cumSyl.at(-1)! + s.syllables + 1);
  for (let a = 0; a + 1 < anchors.length; a++) {
    const A = anchors[a]!;
    const B = anchors[a + 1]!;
    const sylA = cumSyl[A.idx + 1]!;
    const sylB = cumSyl[B.idx + 1]!;
    for (let k = A.idx + 1; k < B.idx; k++) bSpeech[k] = A.pos + ((cumSyl[k + 1]! - sylA) / Math.max(1, sylB - sylA)) * (B.pos - A.pos);
    if (B.idx < n) bSpeech[B.idx] = B.pos;
  }
  const out: AlignedSentence[] = [];
  for (let k = 0; k < sentences.length; k++) {
    const startPause = k > 0 ? assign[k - 1] : null;
    const endPause = k < n ? assign[k] : null;
    const start = k === 0 ? speech[0]!.start : startPause !== null && startPause !== undefined ? pauses[startPause]!.end : clock.toReal(bSpeech[k - 1]!);
    const end = k === n ? speech.at(-1)!.end : endPause !== null && endPause !== undefined ? pauses[endPause]!.start : clock.toReal(bSpeech[k]!);
    const s = sentences[k]!;
    out.push({ index: s.index, start, end: Math.max(end, start + 0.05), words: estimateWords(s.text, start, Math.max(end, start + 0.05), speech), method: endPause !== null || k === n ? 'pause' : 'interpolated' });
  }
  const anchored = assign.filter((x) => x !== null).length;
  return { sentences: out, method: 'pauses', confidence: n ? anchored / n : 1 };
}

export interface RecognisedWord {
  text: string;
  start: number;
  end: number;
}

/** Aligns script words to recognised words (Levenshtein-style DP on normalised tokens). */
/**
 * `speech` (optional): speech intervals from the audio analysis. Script words the recogniser missed
 * are then laid over the real speech inside their gap (pauses excluded) instead of being spread evenly.
 */
export function alignToTranscript(sentences: ScriptSentence[], recognised: RecognisedWord[], speech?: Interval[]): AlignmentResult {
  const script: { s: number; w: string; raw: string }[] = [];
  for (const s of sentences) for (const raw of s.text.split(/\s+/).filter(Boolean)) {
    const t = tokens(raw).join('');
    script.push({ s: s.index, w: t, raw });
  }
  const rec = recognised.map((r) => ({ ...r, w: tokens(r.text).join('') }));
  const n = script.length;
  const m = rec.length;
  // tokens are already normalised: equality, or a shared 4-letter stem (conjugations, plurals)
  const sim = (a: string, b: string) => {
    if (a === b) return 1;
    if (a.length > 3 && b.length > 3 && a.charCodeAt(0) === b.charCodeAt(0) && a.slice(0, 4) === b.slice(0, 4)) return 0.7;
    return 0;
  };
  // Banded DP: the band follows a path through unique trigram anchors, so memory stays linear
  // (a 90-minute narration has ~14k words) and long skipped/added passages are still followed.
  const center = anchorPath(script.map((x) => x.w), rec.map((x) => x.w));
  const W = Math.max(150, Math.min(600, Math.ceil(Math.max(n, m) * 0.04)));
  const lo = new Int32Array(n + 1);
  const hi = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const c = center(i);
    lo[i] = Math.max(0, c - W);
    hi[i] = Math.min(m, c + W);
  }
  for (let i = 1; i <= n; i++) {
    lo[i] = Math.min(lo[i]!, hi[i - 1]!); // keep the band connected
    hi[i] = Math.max(hi[i]!, lo[i - 1]!);
  }
  lo[0] = 0;
  hi[n] = m;
  const bt: Uint8Array[] = new Array(n + 1);
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  bt[0] = new Uint8Array(hi[0]! - lo[0]! + 1);
  for (let j = lo[0]!; j <= hi[0]!; j++) (prev[j] = j), (bt[0]![j - lo[0]!] = 2);
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity, lo[i]!, hi[i]! + 1);
    if (lo[i]! > 0) cur[lo[i]! - 1] = Infinity;
    const row = (bt[i] = new Uint8Array(hi[i]! - lo[i]! + 1));
    for (let j = lo[i]!; j <= hi[i]!; j++) {
      const del = prev[j]! + 1;
      const ins = j > lo[i]! ? cur[j - 1]! + 1 : Infinity;
      const sub = j > 0 ? prev[j - 1]! + (1 - sim(script[i - 1]!.w, rec[j - 1]!.w)) * 1.5 : Infinity;
      if (sub <= del && sub <= ins) (cur[j] = sub), (row[j - lo[i]!] = 3);
      else if (del <= ins) (cur[j] = del), (row[j - lo[i]!] = 1);
      else (cur[j] = ins), (row[j - lo[i]!] = 2);
    }
    [prev, cur] = [cur, prev];
    // cells outside this row's band must read as unreachable for the next row
    if (lo[i]! > 0) prev[lo[i]! - 1] = Infinity;
    if (hi[i]! < m) prev[hi[i]! + 1] = Infinity;
  }
  const match: (number | null)[] = new Array(n).fill(null);
  const weak: (number | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = j >= lo[i]! && j <= hi[i]! ? bt[i]![j - lo[i]!] : i > 0 ? 1 : 2;
    if (b === 3) {
      if (sim(script[i - 1]!.w, rec[j - 1]!.w) > 0) match[i - 1] = j - 1;
      else weak[i - 1] = j - 1; // misrecognised word in the same position: its timing is still right
      i--;
      j--;
    } else if (b === 1) i--;
    else j--;
  }
  // word timings: matched → recognised times; unmatched → interpolated between neighbours
  const times: { start: number; end: number; estimated: boolean }[] = new Array(n);
  for (let k = 0; k < n; k++) if (match[k] !== null) times[k] = { start: rec[match[k]!]!.start, end: rec[match[k]!]!.end, estimated: false };
  for (let k = 0; k < n; k++) if (!times[k] && weak[k] !== null) times[k] = { start: rec[weak[k]!]!.start, end: rec[weak[k]!]!.end, estimated: true };
  const t0 = rec[0]?.start ?? 0;
  const t1 = rec.at(-1)?.end ?? 0;
  for (let k = 0; k < n; k++) {
    if (times[k]) continue;
    let a = k - 1;
    while (a >= 0 && !times[a]) a--;
    let b = k + 1;
    while (b < n && !times[b]) b++;
    let ta = a >= 0 ? times[a]!.end : t0;
    let tb = b < n ? times[b]!.start : t1;
    const span = b - a - 1;
    const pos = k - a - 1;
    const inGap = speech?.map((iv) => ({ start: Math.max(ta, iv.start), end: Math.min(tb, iv.end) })).filter((iv) => iv.end - iv.start > 0.05) ?? [];
    const speechLen = inGap.reduce((x, iv) => x + iv.end - iv.start, 0);
    if (speech && speechLen > 0.1) {
      // lay the words over the speech inside the gap
      const at = (f: number) => {
        let rem = f * speechLen;
        for (const iv of inGap) {
          if (rem <= iv.end - iv.start) return iv.start + rem;
          rem -= iv.end - iv.start;
        }
        return inGap.at(-1)!.end;
      };
      times[k] = { start: at(pos / span), end: at((pos + 1) / span), estimated: true };
      continue;
    }
    // no audio evidence: a gap that crosses a sentence boundary contains a pause, so keep the
    // words next to the neighbour of their own sentence (~0.32 s per word)
    const per = 0.32;
    if (tb - ta > span * per * 1.6) {
      const sameA = a >= 0 && script[a]!.s === script[k]!.s;
      const sameB = b < n && script[b]!.s === script[k]!.s;
      if (sameB && !sameA) ta = Math.max(ta, tb - span * per);
      else if (sameA && !sameB) tb = Math.min(tb, ta + span * per);
    }
    const st = ta + ((tb - ta) * pos) / span;
    times[k] = { start: st, end: ta + ((tb - ta) * (pos + 1)) / span, estimated: true };
  }
  const out: AlignedSentence[] = [];
  let anchored = 0;
  const bySentence = new Map<number, number[]>();
  script.forEach((x, k) => {
    const l = bySentence.get(x.s);
    if (l) l.push(k);
    else bySentence.set(x.s, [k]);
  });
  for (const s of sentences) {
    const idx = bySentence.get(s.index) ?? [];
    if (!idx.length) continue;
    const words = idx.map((k) => ({ text: script[k]!.raw, ...times[k]! }));
    if (!words[0]!.estimated && !words.at(-1)!.estimated) anchored++;
    out.push({ index: s.index, start: words[0]!.start, end: words.at(-1)!.end, words, method: 'transcript' });
  }
  if (speech?.length) snapToSpeech(out, speech);
  return { sentences: out, method: 'transcript', confidence: out.length ? anchored / out.length : 0 };
}

/** Monotonic path script-index → recognised-index through trigrams that are unique on both sides. */
function anchorPath(a: string[], b: string[]): (i: number) => number {
  const key = (x: string[], k: number) => `${x[k]}\u0001${x[k + 1]}\u0001${x[k + 2]}`;
  const uniq = (x: string[]) => {
    const mp = new Map<string, number>();
    for (let k = 0; k + 2 < x.length; k++) mp.set(key(x, k), mp.has(key(x, k)) ? -1 : k);
    return mp;
  };
  const ua = uniq(a);
  const ub = uniq(b);
  const pairs: [number, number][] = [];
  for (const [g, ia] of ua) {
    const ib = ub.get(g);
    if (ia >= 0 && ib !== undefined && ib >= 0) pairs.push([ia, ib]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  // longest increasing subsequence on the recognised index keeps the anchors monotonic
  const tails: number[] = [];
  const prevIdx = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((p, k) => {
    let l = 0;
    let h = tails.length;
    while (l < h) {
      const mid = (l + h) >> 1;
      if (pairs[tails[mid]!]![1] < p[1]) l = mid + 1;
      else h = mid;
    }
    if (l > 0) prevIdx[k] = tails[l - 1]!;
    tails[l] = k;
  });
  const chain: [number, number][] = [];
  for (let k = tails.at(-1) ?? -1; k >= 0; k = prevIdx[k]!) chain.unshift(pairs[k]!);
  const pts: [number, number][] = [[0, 0], ...chain, [a.length, b.length]];
  let k = 0; // callers query increasing indexes
  return (i: number) => {
    if (k > 0 && pts[k]![0] > i) k = 0;
    while (k + 1 < pts.length - 1 && pts[k + 1]![0] <= i) k++;
    const [x0, y0] = pts[k]!;
    const [x1, y1] = pts[Math.min(k + 1, pts.length - 1)]!;
    return Math.round(x1 === x0 ? y0 : y0 + ((i - x0) * (y1 - y0)) / (x1 - x0));
  };
}

/**
 * Recogniser word times drift by a few hundred ms around pauses (the first word after a pause is
 * often early). Sentence edges are snapped to the nearest real speech onset/offset when one is close
 * and doing so keeps sentences in order.
 */
function snapToSpeech(out: AlignedSentence[], speech: Interval[], tol = 0.6) {
  const onsets = speech.map((iv) => iv.start);
  const offsets = speech.map((iv) => iv.end);
  const nearest = (xs: number[], t: number) => xs.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), Infinity);
  out.forEach((s, k) => {
    const prevEnd = k > 0 ? out[k - 1]!.end : -Infinity;
    const on = nearest(onsets, s.start);
    if (Math.abs(on - s.start) <= tol && on >= prevEnd - 0.05 && on < s.words[0]!.end + 0.3) {
      const d = on - s.start;
      s.start = on;
      s.words[0]!.start = on;
      if (s.words[0]!.end < on) s.words[0]!.end = on + 0.05;
      void d;
    }
    const nextStart = k + 1 < out.length ? out[k + 1]!.start : Infinity;
    const off = nearest(offsets, s.end);
    if (Math.abs(off - s.end) <= tol && off <= nextStart + 0.05 && off > s.words.at(-1)!.start) {
      s.end = off;
      s.words.at(-1)!.end = off;
    }
  });
}
