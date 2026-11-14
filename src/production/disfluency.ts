/**
 * Voice Studio: hesitations ("euh", "heu", "hum"…) and immediate repetitions ("le le", "c'est c'est")
 * found in the word-timed transcript. Pure. Detection only reports; cutting is a separate opt-in that
 * produces a derived copy (the recording is never modified, unchecking the option restores it).
 *
 * Limits, stated honestly: Whisper models often leave hesitations out of the text, so a hesitation the
 * recogniser did not write cannot be found here; word times are ±50 ms, hence the margins.
 * French grammatical doubles ("nous nous", "vous vous") and intensifiers ("très très", "non non")
 * are never treated as mistakes.
 */
import type { Interval, RecognisedWord } from './align';

export type DisfluencyKind = 'hesitation' | 'repetition';

export interface Disfluency {
  kind: DisfluencyKind;
  /** Source span that would be removed. */
  start: number;
  end: number;
  /** What was heard, e.g. "euh" or "le le". */
  text: string;
}

const FILLERS = new Set(['euh', 'heu', 'euhm', 'heum', 'hum', 'hmm', 'mmh', 'hm', 'em', 'uh', 'um', 'erm']);
/** Doubles that are correct French or deliberate emphasis. */
const KEEP_DOUBLE = new Set(['nous', 'vous', 'très', 'non', 'oui', 'si', 'bien', 'vite', 'plus', 'encore', 'jamais', 'là', 'tout', 'beaucoup', 'trop', 'quoi', 'ha', 'ah', 'oh', 'lala', 'là-bas']);

export const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}']/gu, '')
    .replace(/^'+|'+$/g, '');

export interface DisfluencyOptions {
  /** Longest gap between the two copies of a repeated word (s). */
  maxRepeatGap: number;
  /** Margin kept around a removed span so no syllable is clipped (s). */
  margin: number;
}

export const DEFAULT_DISFLUENCY: DisfluencyOptions = { maxRepeatGap: 0.6, margin: 0.03 };

export function detectDisfluencies(words: RecognisedWord[], o: DisfluencyOptions = DEFAULT_DISFLUENCY): Disfluency[] {
  const out: Disfluency[] = [];
  const toks = words.map((w) => ({ ...w, n: norm(w.text) })).filter((w) => w.n);
  // a word that ends a sentence and the same word starting the next one is not a repetition
  // ("…cite aussi Jubilee. Jubilee est…"); "-Henri" is a fragment of a compound name, not a word
  const ends = (w: RecognisedWord) => /[.!?…:;]["»”)]*$/.test(w.text.trim());
  const fragment = (w: RecognisedWord) => /^\s*-/.test(w.text);
  // "le, le" is a stammer; "Batman, Batman" or "trois, trois" in a list is an enumeration
  const listItem = (w: RecognisedWord & { n: string }) => /,\s*$/.test(w.text) && (w.n.length > 4 || /^\p{Lu}/u.test(w.text.trim()));
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    if (FILLERS.has(w.n)) {
      // the filler and the pause up to the next word (never past it)
      const next = toks[i + 1];
      const end = next ? Math.min(next.start, w.end + 0.25) : w.end;
      out.push({ kind: 'hesitation', start: w.start - o.margin, end: Math.max(w.end, end - o.margin), text: w.text.trim() });
      continue;
    }
    // repeated bigram "c'est un c'est un" → keep the second copy
    const a = toks[i + 2];
    const b = toks[i + 3];
    const x = toks[i + 1];
    if (x && a && b && w.n === a.n && x.n === b.n && w.n !== x.n && !ends(x) && !fragment(w) && !fragment(x) && !listItem(x) && a.start - x.end <= o.maxRepeatGap && !KEEP_DOUBLE.has(w.n)) {
      out.push({ kind: 'repetition', start: w.start - o.margin, end: a.start - o.margin, text: `${w.text} ${x.text} ${a.text} ${b.text}`.trim() });
      i += 1;
      continue;
    }
    if (x && w.n === x.n && !ends(w) && !fragment(w) && !listItem(w) && !KEEP_DOUBLE.has(w.n) && x.start - w.end <= o.maxRepeatGap && !/^\d+$/.test(w.n)) {
      out.push({ kind: 'repetition', start: w.start - o.margin, end: x.start - o.margin, text: `${w.text} ${x.text}`.trim() });
    }
  }
  return out.map((d) => ({ ...d, start: Math.max(0, +d.start.toFixed(3)), end: +d.end.toFixed(3) })).filter((d) => d.end - d.start >= 0.05);
}

/**
 * Sounds between two words that the recogniser did not write (a long "euuuh", a click, a breath held
 * with the voice on): the gap between the words is long, and the audio is not silent in it. A short
 * natural pause is kept on each side.
 */
export function untranscribedSounds(words: RecognisedWord[], silences: Interval[], o: { minGap?: number; maxGap?: number; keep?: number } = {}): Disfluency[] {
  const minGap = o.minGap ?? 0.4, maxGap = o.maxGap ?? 1.6, keep = o.keep ?? 0.09;
  const out: Disfluency[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!, b = words[i + 1]!;
    const gap = b.start - a.end;
    if (gap < minGap || gap > maxGap) continue;
    // a sentence end is a breath and a pause, not a hesitation
    if (/[.!?…]["»”)]*$/.test(a.text.trim())) continue;
    const silent = silences.reduce((acc, s) => acc + Math.max(0, Math.min(b.start, s.end) - Math.max(a.end, s.start)), 0);
    if (silent / gap > 0.4) continue;
    out.push({ kind: 'hesitation', start: +(a.end + keep).toFixed(3), end: +(b.start - keep).toFixed(3), text: '(son non transcrit entre deux mots)' });
  }
  return out.filter((d) => d.end - d.start >= 0.15);
}

/** Removed spans of a keep list. */
export function cutsFromKeep(keep: Interval[], duration: number): Interval[] {
  const cuts: Interval[] = [];
  let c = 0;
  for (const k of keep) {
    if (k.start > c + 1e-6) cuts.push({ start: c, end: k.start });
    c = k.end;
  }
  if (c < duration - 1e-6) cuts.push({ start: c, end: duration });
  return cuts;
}

/** Keep list for a set of (possibly overlapping) removed spans. */
export function keepFromCuts(cuts: Interval[], duration: number): Interval[] {
  const sorted = cuts.map((c) => ({ start: Math.max(0, c.start), end: Math.min(duration, c.end) })).filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const keep: Interval[] = [];
  let c = 0;
  for (const s of sorted) {
    if (s.start > c) keep.push({ start: c, end: s.start });
    c = Math.max(c, s.end);
  }
  if (c < duration) keep.push({ start: c, end: duration });
  return keep;
}

/** Words that fall inside a removed span disappear; the others are moved to the new timing. */
export function wordsAfterCuts<W extends RecognisedWord>(words: W[], cuts: Interval[], remap: (t: number) => number): W[] {
  const inside = (w: W) => cuts.some((c) => (w.start + w.end) / 2 > c.start && (w.start + w.end) / 2 < c.end);
  return words.filter((w) => !inside(w)).map((w) => ({ ...w, start: remap(w.start), end: remap(w.end) }));
}
