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
import { normalize, syllables, tokens } from './text';

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
export function alignToTranscript(sentences: ScriptSentence[], recognised: RecognisedWord[]): AlignmentResult {
  const script: { s: number; w: string; raw: string }[] = [];
  for (const s of sentences) for (const raw of s.text.split(/\s+/).filter(Boolean)) {
    const t = tokens(raw).join('');
    script.push({ s: s.index, w: t, raw });
  }
  const rec = recognised.map((r) => ({ ...r, w: tokens(r.text).join('') }));
  const n = script.length;
  const m = rec.length;
  const sim = (a: string, b: string) => {
    if (!a || !b) return a === b ? 1 : 0;
    if (a === b) return 1;
    if (a.length > 3 && b.length > 3 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4)))) return 0.7;
    return normalize(a) === normalize(b) ? 1 : 0;
  };
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const bt = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) (dp[i]![0] = i), (bt[i]![0] = 1);
  for (let j = 1; j <= m; j++) (dp[0]![j] = j), (bt[0]![j] = 2);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const sub = dp[i - 1]![j - 1]! + (1 - sim(script[i - 1]!.w, rec[j - 1]!.w)) * 1.5;
      const del = dp[i - 1]![j]! + 1;
      const ins = dp[i]![j - 1]! + 1;
      if (sub <= del && sub <= ins) (dp[i]![j] = sub), (bt[i]![j] = 3);
      else if (del <= ins) (dp[i]![j] = del), (bt[i]![j] = 1);
      else (dp[i]![j] = ins), (bt[i]![j] = 2);
    }
  const match: (number | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = bt[i]![j];
    if (b === 3) {
      if (sim(script[i - 1]!.w, rec[j - 1]!.w) > 0) match[i - 1] = j - 1;
      i--;
      j--;
    } else if (b === 1) i--;
    else j--;
  }
  // word timings: matched → recognised times; unmatched → interpolated between neighbours
  const times: { start: number; end: number; estimated: boolean }[] = new Array(n);
  for (let k = 0; k < n; k++) if (match[k] !== null) times[k] = { start: rec[match[k]!]!.start, end: rec[match[k]!]!.end, estimated: false };
  const t0 = rec[0]?.start ?? 0;
  const t1 = rec.at(-1)?.end ?? 0;
  for (let k = 0; k < n; k++) {
    if (times[k]) continue;
    let a = k - 1;
    while (a >= 0 && !times[a]) a--;
    let b = k + 1;
    while (b < n && !times[b]) b++;
    const ta = a >= 0 ? times[a]!.end : t0;
    const tb = b < n ? times[b]!.start : t1;
    const span = b - a - 1;
    const pos = k - a - 1;
    const st = ta + ((tb - ta) * pos) / span;
    times[k] = { start: st, end: ta + ((tb - ta) * (pos + 1)) / span, estimated: true };
  }
  const out: AlignedSentence[] = [];
  let anchored = 0;
  for (const s of sentences) {
    const idx = script.map((x, k) => (x.s === s.index ? k : -1)).filter((k) => k >= 0);
    if (!idx.length) continue;
    const words = idx.map((k) => ({ text: script[k]!.raw, ...times[k]! }));
    if (!words[0]!.estimated && !words.at(-1)!.estimated) anchored++;
    out.push({ index: s.index, start: words[0]!.start, end: words.at(-1)!.end, words, method: 'transcript' });
  }
  return { sentences: out, method: 'transcript', confidence: out.length ? anchored / out.length : 0 };
}
