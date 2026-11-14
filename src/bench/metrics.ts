/**
 * Benchmark metrics against HUMAN annotations (pure). Formats are documented in docs/BENCHMARK.md.
 * Nothing here produces a score without annotated data: every function takes the annotation as input
 * and reports how many items were actually evaluated.
 */
import type { Rect } from '../core/panels';

// ---------------------------------------------------------------- formats

/** B1: one annotated page. Boxes are normalised (0..1); `panels` are listed in reading order. */
export interface PageAnnotation {
  file: string;
  format?: 'planche' | 'double-page' | 'couverture' | 'webtoon' | 'manga' | 'illustration';
  panels: Rect[];
  /** Balloons / captions with their transcribed text (for OCR and text-zone metrics). */
  texts?: { box: Rect; text: string; kind?: 'dialogue' | 'narration' | 'bruitage' | 'pensée' }[];
  characters?: string[];
  description?: string;
}

export interface PagesFile {
  format: 'primestone-bench/pages@1';
  annotator: string;
  pages: PageAnnotation[];
}

/** B2: queries with the files a person judged relevant. */
export interface QueriesFile {
  format: 'primestone-bench/queries@1';
  annotator: string;
  queries: { query: string; relevant: string[] }[];
}

/** B3: script sections annotated by a person. */
export interface ScriptAnnotation {
  format: 'primestone-bench/script@1';
  annotator: string;
  script: string;
  sections: { title: string; fn: string; intensity: 1 | 2 | 3 | 4 | 5; entities: string[] }[];
}

/** B4: per-shot human judgement of a generated version. */
export interface JudgementsFile {
  format: 'primestone-bench/judgements@1';
  annotator: string;
  project: string;
  sequence: string;
  shots: { decisionId: string; start: number; end: number; text: string; media: string | null; confidence: number | null; metadataOnly: boolean; rating?: 1 | 2 | 3 | 4 | 5; misleading?: boolean; note?: string }[];
  overall?: 'publiable' | 'retouches mineures' | 'retouches majeures';
  retouchMinutes?: number;
}

// ---------------------------------------------------------------- geometry & ranking

export function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy one-to-one matching by best IoU above `threshold`. Returns pairs (pred index, truth index, iou). */
export function matchBoxes(pred: Rect[], truth: Rect[], threshold = 0.5): [number, number, number][] {
  const all: [number, number, number][] = [];
  pred.forEach((p, i) => truth.forEach((t, j) => all.push([i, j, iou(p, t)])));
  all.sort((a, b) => b[2] - a[2]);
  const usedP = new Set<number>();
  const usedT = new Set<number>();
  const out: [number, number, number][] = [];
  for (const [i, j, v] of all) {
    if (v < threshold) break;
    if (usedP.has(i) || usedT.has(j)) continue;
    usedP.add(i);
    usedT.add(j);
    out.push([i, j, v]);
  }
  return out;
}

/** Kendall's tau between two orders of the same items (1 = identical, -1 = reversed). */
export function kendallTau(order: number[]): number {
  const n = order.length;
  if (n < 2) return 1;
  let c = 0;
  let d = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) (order[i]! < order[j]! ? c++ : d++);
  return (c - d) / ((n * (n - 1)) / 2);
}

/** Character error rate (Levenshtein distance / reference length), case and spacing normalised. */
export function cer(hyp: string, ref: string): number {
  const n = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();
  const a = n(hyp);
  const b = n(ref);
  if (!b.length) return a.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]! / b.length;
}

export function recallAtK(ranked: string[], relevant: string[], k = 10): number {
  if (!relevant.length) return NaN;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function ndcgAtK(ranked: string[], relevant: string[], k = 10): number {
  if (!relevant.length) return NaN;
  const rel = new Set(relevant);
  const dcg = ranked.slice(0, k).reduce((a, f, i) => a + (rel.has(f) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal ? dcg / ideal : 0;
}

/** Cohen's kappa between two label lists of equal length. */
export function cohenKappa(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return NaN;
  const labels = [...new Set([...a, ...b])];
  const po = a.slice(0, n).filter((x, i) => x === b[i]).length / n;
  const pe = labels.reduce((acc, l) => acc + (a.slice(0, n).filter((x) => x === l).length / n) * (b.slice(0, n).filter((x) => x === l).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export function spearman(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;
  const rank = (v: number[]) => {
    const idx = v.map((val, i) => [val, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x.slice(0, n));
  const ry = rank(y.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

// ---------------------------------------------------------------- per benchmark

export interface PanelScore {
  pages: number;
  truthPanels: number;
  predictedPanels: number;
  precision: number;
  recall: number;
  meanIou: number;
  /** Mean Kendall tau of the reading order over matched panels (pages with ≥ 2 matches). */
  readingOrderTau: number;
  /** Pages where ≥ 85 % of the annotated panels were found at IoU ≥ 0.8 (criterion of the capability matrix). */
  pagesMeetingCriterion: number;
}

export function scorePanels(items: { truth: Rect[]; predicted: Rect[] }[]): PanelScore {
  let tp = 0;
  let nt = 0;
  let np = 0;
  let iouSum = 0;
  const taus: number[] = [];
  let good = 0;
  for (const it of items) {
    const m = matchBoxes(it.predicted, it.truth, 0.5);
    tp += m.length;
    nt += it.truth.length;
    np += it.predicted.length;
    iouSum += m.reduce((a, x) => a + x[2], 0);
    if (m.length >= 2) taus.push(kendallTau([...m].sort((a, b) => a[0] - b[0]).map((x) => x[1])));
    const strict = matchBoxes(it.predicted, it.truth, 0.8).length;
    if (it.truth.length && strict / it.truth.length >= 0.85) good++;
  }
  return {
    pages: items.length,
    truthPanels: nt,
    predictedPanels: np,
    precision: np ? tp / np : NaN,
    recall: nt ? tp / nt : NaN,
    meanIou: tp ? iouSum / tp : NaN,
    readingOrderTau: taus.length ? taus.reduce((a, b) => a + b, 0) / taus.length : NaN,
    pagesMeetingCriterion: good,
  };
}

export interface JudgementScore {
  shots: number;
  rated: number;
  meanRating: number;
  /** Share of rated shots with a rating ≥ 4 ("the picture illustrates what is said"). */
  relevantShare: number;
  misleading: number;
  /** Mean rating split by what the match relied on. */
  byBasis: { metadataOnly: number; content: number };
  /** Mean rating by confidence band (calibration: do high-confidence shots get better ratings?). */
  byConfidence: { band: string; n: number; mean: number }[];
}

export function scoreJudgements(j: JudgementsFile): JudgementScore {
  const rated = j.shots.filter((s) => s.rating);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const bands: [string, number, number][] = [['< 0,3', 0, 0.3], ['0,3–0,6', 0.3, 0.6], ['≥ 0,6', 0.6, 1.01]];
  return {
    shots: j.shots.length,
    rated: rated.length,
    meanRating: mean(rated.map((s) => s.rating!)),
    relevantShare: rated.length ? rated.filter((s) => s.rating! >= 4).length / rated.length : NaN,
    misleading: j.shots.filter((s) => s.misleading).length,
    byBasis: { metadataOnly: mean(rated.filter((s) => s.metadataOnly).map((s) => s.rating!)), content: mean(rated.filter((s) => !s.metadataOnly).map((s) => s.rating!)) },
    byConfidence: bands.map(([band, lo, hi]) => {
      const xs = rated.filter((s) => s.confidence != null && s.confidence >= lo && s.confidence < hi).map((s) => s.rating!);
      return { band, n: xs.length, mean: mean(xs) };
    }),
  };
}
