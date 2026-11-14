/**
 * Story mode: the pages of a comic book (CBZ/ZIP, PDF or a folder of numbered scans) follow the narration
 * in reading order, the way a comic recap channel reads an issue.
 *
 * The book is laid along the narration: each page gets time in proportion to its content (number of
 * panels). Anchors bend that line where the evidence is precise:
 *  - an explicit page request in the script ("[VISUEL: page 12]", "[PAGE 12]");
 *  - a page that clearly matches a passage better than the others (text read in the picture by OCR,
 *    a name only that page carries, its description or tags).
 * Anchors are kept only if they go forward in the book (longest increasing chain), so the reading never
 * jumps back. Pages that would get less than a readable time are skipped (never anchored ones).
 */
import type { Beat, LibraryItem } from './planner';
import { scoreItem } from './planner';

export interface StorySpan {
  item: LibraryItem;
  /** Seconds on the narration timeline. */
  start: number;
  end: number;
  anchored: string | null;
}

export interface StoryPlan {
  books: string[];
  pages: number;
  spans: StorySpan[];
  anchors: { beat: number; page: number; why: string }[];
  skipped: number;
  notes: string[];
}

/** Words any page of any book may carry: never enough to place a page. */
const GENERIC = /^(?:marvel|dc|comics?|issue|page|planche|numero|numéro|volume|vol|tome|chapitre|chapter|the|and|of|empire|story|histoire|now)$|\b(?:marvel|comics?|copyright|www|com)\b/;

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Ordered pages of the books found in the library (books of ≥ minPages pages). */
export function bookPages(library: LibraryItem[], minPages = 4): { books: string[]; pages: LibraryItem[] } {
  const byBook = new Map<string, LibraryItem[]>();
  for (const it of library) {
    const p = it.asset.page;
    // title and credits pages are not part of the story (a recap does not read them)
    if (!p || it.asset.kind !== 'image' || it.asset.comic?.format === 'générique') continue;
    byBook.set(p.book, [...(byBook.get(p.book) ?? []), it]);
  }
  const books = [...byBook.keys()].filter((b) => byBook.get(b)!.length >= minPages).sort(natural);
  const pages = books.flatMap((b) => byBook.get(b)!.sort((x, y) => x.asset.page!.n - y.asset.page!.n));
  return { books, pages };
}

/** Story mode applies when books make up most of the pictures (or when forced). */
export function storyModeApplies(library: LibraryItem[], mode: 'auto' | 'on' | 'off' = 'auto'): boolean {
  if (mode === 'off') return false;
  const { pages } = bookPages(library);
  if (!pages.length) return false;
  if (mode === 'on') return true;
  const images = library.filter((i) => i.asset.kind === 'image' && !i.asset.generator).length;
  return pages.length >= 4 && pages.length >= 0.5 * images;
}

const weightOf = (it: LibraryItem) => (it.asset.comic?.format === 'couverture' ? 2 : Math.max(1, Math.min(8, it.asset.panels?.length ?? 3)));

/** Longest chain of anchors increasing in time and in page (O(n²), n = anchors). */
function increasing<T extends { t: number; k: number; w: number }>(xs: T[]): T[] {
  const s = [...xs].sort((a, b) => a.t - b.t || a.k - b.k);
  const best = s.map((x) => x.w);
  const prev = s.map(() => -1);
  for (let i = 0; i < s.length; i++)
    for (let j = 0; j < i; j++)
      if (s[j]!.k < s[i]!.k && s[j]!.t < s[i]!.t && best[j]! + s[i]!.w > best[i]!) {
        best[i] = best[j]! + s[i]!.w;
        prev[i] = j;
      }
  let i = best.indexOf(Math.max(...best, -Infinity));
  const out: T[] = [];
  while (i >= 0) {
    out.unshift(s[i]!);
    i = prev[i]!;
  }
  return out;
}

export function planStoryOrder(beats: Beat[], library: LibraryItem[], totalSec: number, opts: { minPageSec?: number } = {}): StoryPlan | null {
  const { books, pages } = bookPages(library);
  if (!pages.length || totalSec <= 0 || !beats.length) return null;
  const minPageSec = opts.minPageSec ?? 2.5;
  const notes: string[] = [];
  const pageIndexOf = new Map(pages.map((p, k) => [p.asset.id, k]));

  // anchors: explicit page requests, then clear content matches
  const raw: { t: number; k: number; w: number; beat: number; why: string }[] = [];
  for (const b of beats) {
    const asked = [...b.hints, b.text].join(' ').match(/\b(?:page|planche|p\.)\s*(\d{1,3})\b/i);
    if (asked) {
      const n = Number(asked[1]);
      // "page 12" of the book the passage names, else of the first book
      const book = books.find((x) => b.hints.join(' ').toLowerCase().includes(x.toLowerCase())) ?? books[0];
      const k = pages.findIndex((p) => p.asset.page!.book === book && p.asset.page!.n === n);
      if (k >= 0) {
        raw.push({ t: b.start, k, w: 10, beat: b.index, why: `page ${n} demandée dans le script` });
        continue;
      }
    }
    const scored = pages.map((p, k) => ({ k, s: scoreItem(b, p) })).filter((x) => x.s.score > 0).sort((x, y) => y.s.score - x.s.score);
    const top = scored[0];
    if (!top) continue;
    const second = scored[1]?.s.score ?? 0;
    // a page that stands out by what is specific to it (text read in it, its description, a choice of yours),
    // never by a generic word every page could carry (publisher, "comics", "issue"…)
    const distinctive = top.s.evidence.filter((e) => (e.basis === 'texte-ocr' || e.basis === 'description' || e.basis === 'utilisateur') && !GENERIC.test(e.detail.toLowerCase().replace(/^[^:]*:\s*/, '')));
    if (top.s.score - second >= 1 && distinctive.length) raw.push({ t: b.start, k: top.k, w: Math.min(5, top.s.score - second), beat: b.index, why: top.s.reasons[0] ?? 'correspondance avec ce passage' });
  }
  // an anchor that would make the reading jump far ahead of (or behind) the narration is not trusted: a recap
  // follows its book; only an explicit page request may do that
  const plausible = raw.filter((a) => a.w >= 10 || Math.abs(a.k / Math.max(1, pages.length - 1) - a.t / Math.max(1e-6, totalSec)) <= 0.3);
  if (plausible.length < raw.length) notes.push(`${raw.length - plausible.length} correspondance(s) écartée(s) : elles auraient fait sauter une grande partie du livre`);
  const anchors = increasing(plausible);
  if (plausible.length > anchors.length) notes.push(`${plausible.length - anchors.length} correspondance(s) écartée(s) : elles auraient fait revenir la lecture en arrière`);

  // reading position (in weight units) as a piecewise-linear function of time through the anchors
  const cum = [0];
  for (const p of pages) cum.push(cum.at(-1)! + weightOf(p));
  const W = cum.at(-1)!;
  const knots = [{ t: 0, x: 0 }, ...anchors.map((a) => ({ t: a.t, x: cum[a.k]! })), { t: totalSec, x: W }].filter((k, i, arr) => i === 0 || (k.t > arr[i - 1]!.t && k.x >= arr[i - 1]!.x));
  const timeAt = (x: number) => {
    for (let i = 1; i < knots.length; i++) {
      const a = knots[i - 1]!, b = knots[i]!;
      if (x <= b.x) return b.x === a.x ? a.t : a.t + ((x - a.x) / (b.x - a.x)) * (b.t - a.t);
    }
    return totalSec;
  };
  const anchoredPage = new Map(anchors.map((a) => [a.k, a.why]));
  let spans: StorySpan[] = pages.map((p, k) => ({ item: p, start: timeAt(cum[k]!), end: timeAt(cum[k + 1]!), anchored: anchoredPage.get(k) ?? null }));
  spans = spans.filter((s) => s.end > s.start + 1e-6 || s.anchored);

  // too many pages for the time: drop the shortest non-anchored pages, their time goes to the previous page
  let skipped = 0;
  for (let guard = 0; guard < 2000; guard++) {
    let worst = -1;
    for (let i = 0; i < spans.length; i++) if (!spans[i]!.anchored && spans[i]!.end - spans[i]!.start < minPageSec && (worst < 0 || spans[i]!.end - spans[i]!.start < spans[worst]!.end - spans[worst]!.start)) worst = i;
    if (worst < 0 || spans.length <= 1) break;
    const s = spans[worst]!;
    if (worst > 0) spans[worst - 1]!.end = s.end;
    else spans[1]!.start = s.start;
    spans.splice(worst, 1);
    skipped++;
  }
  if (skipped) notes.push(`${skipped} page(s) non montrée(s) : la narration est trop courte pour toutes les lire (au moins ${minPageSec} s par page)`);
  spans[0]!.start = 0;
  spans.at(-1)!.end = totalSec;
  // a page turns with the narration: a boundary close to the start of a passage moves onto it
  const starts = beats.map((b) => b.start).filter((x) => x > 0);
  for (let i = 0; i < spans.length - 1; i++) {
    const e = spans[i]!.end;
    const near = starts.reduce((best, x) => (Math.abs(x - e) < Math.abs(best - e) ? x : best), Infinity);
    if (Math.abs(near - e) <= Math.min(1.2, 0.4 * minPageSec) && near - spans[i]!.start >= minPageSec * 0.8 && spans[i + 1]!.end - near >= minPageSec * 0.8) spans[i]!.end = near;
  }
  for (let i = 1; i < spans.length; i++) spans[i]!.start = spans[i - 1]!.end;
  void pageIndexOf;
  return { books, pages: pages.length, spans, anchors: anchors.map((a) => ({ beat: a.beat, page: a.k, why: a.why })), skipped, notes };
}

/** The page on screen at `sec`, and how far into its time span we are (0..1). */
export function spanAt(plan: StoryPlan, sec: number, notAfter = Infinity): { span: StorySpan; index: number; progress: number } {
  let i = plan.spans.findIndex((s) => sec >= s.start - 1e-6 && sec < s.end - 1e-6);
  if (i < 0) i = sec <= 0 ? 0 : plan.spans.length - 1;
  // never jump over a page of the plan (shots are cut in whole frames and passages): show it now, briefly
  i = Math.min(i, notAfter);
  const s = plan.spans[i]!;
  return { span: s, index: i, progress: Math.max(0, Math.min(1, (sec - s.start) / Math.max(1e-6, s.end - s.start))) };
}
