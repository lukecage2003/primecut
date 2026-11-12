/**
 * Editorial pacing: how intense a passage is, from the text (exclamations, short punchy sentences,
 * dramatic vocabulary, reveals) and from the real narration (speech rate relative to the narrator's
 * own median). Intense passages get shorter shots and slightly stronger camera motion; calm,
 * explanatory or contemplative passages breathe longer.
 */
import type { AlignedSentence } from './align';
import type { Beat } from './planner';
import type { ScriptSentence } from './script';
import { normalize } from './text';

const DRAMA = /\b(mort|meurt|tue|tuer|massacre|guerre|bataille|combat|affronte|trahison|trahit|explose|detruit|destruction|sacrifice|catastrophe|chute|tombe|brise|ecrase|vaincu|defaite|revelation|choc|soudain|brutal|violent|terrifiant)\b/;
const CALM = /\b(comprendre|explique|expliquer|definition|principe|signifie|autrement dit|en realite|rappel|contexte|origine|histoire de|philosophie|idee)\b/;

export interface Pacing {
  /** 0 = calm/explanatory … 1 = intense. */
  intensity: number;
  /** Multiplier for shot length (0.7 … 1.3). */
  shotFactor: number;
  label: 'calm' | 'neutral' | 'intense';
}

export function speechRates(script: ScriptSentence[], aligned: AlignedSentence[]): { bySentence: Map<number, number>; median: number } {
  const bySentence = new Map<number, number>();
  for (const a of aligned) {
    const s = script[a.index];
    const d = a.end - a.start;
    if (s && d > 0.4) bySentence.set(a.index, s.syllables / d);
  }
  const v = [...bySentence.values()].sort((x, y) => x - y);
  return { bySentence, median: v[Math.floor(v.length / 2)] ?? 5 };
}

export function beatPacing(beat: Beat, script: ScriptSentence[], rates: { bySentence: Map<number, number>; median: number }): Pacing {
  const t = normalize(beat.text);
  const sentences = beat.sentenceIndexes.map((i) => script[i]!).filter(Boolean);
  let score = 0;
  const excl = (beat.text.match(/!/g) ?? []).length;
  score += Math.min(0.35, excl * 0.15);
  if (DRAMA.test(t)) score += 0.3;
  if (CALM.test(t)) score -= 0.25;
  const meanWords = sentences.reduce((a, s) => a + s.text.split(/\s+/).length, 0) / Math.max(1, sentences.length);
  if (meanWords < 7) score += 0.2; // short, punchy sentences
  if (meanWords > 22) score -= 0.15;
  const rs = beat.sentenceIndexes.map((i) => rates.bySentence.get(i)).filter((x): x is number => x !== undefined);
  if (rs.length && rates.median > 0) {
    const rel = rs.reduce((a, b) => a + b, 0) / rs.length / rates.median;
    score += Math.max(-0.2, Math.min(0.25, (rel - 1) * 1.5)); // the narrator speeds up → more energy
  }
  const intensity = Math.max(0, Math.min(1, 0.4 + score));
  return { intensity, shotFactor: 1.3 - 0.6 * intensity, label: intensity >= 0.65 ? 'intense' : intensity <= 0.25 ? 'calm' : 'neutral' };
}
