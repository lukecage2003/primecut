/**
 * Structured comic references (series, volume, issues, year) parsed from script sources, narration
 * and media file names, and compared so that similarly named works are never confused:
 * "Secret Wars (1984)" ≠ "Secret Wars (2015)", "Batman #676" ≠ "Batman #35".
 * Pure and rule-based: a reference is what the text says, nothing is looked up or invented.
 */
import { normalize } from './text';

export interface ComicRef {
  /** Normalised series title ("batman", "new avengers", "secret wars"). */
  series: string;
  /** Title as written. */
  title: string;
  volume?: number;
  issues: number[];
  year?: number;
  yearEnd?: number;
}

export type RefVerdict = 'same-issue' | 'same-series' | 'conflict' | 'unrelated';

// words that may precede a series title without making it a different series
const PREFIXES = ['marvel super heroes', 'marvel', 'dc', 'the', 'les', 'le', 'la'];

const seriesKey = (title: string) =>
  normalize(title.replace(/[’']/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' '))
    .replace(/\b(?:vol(?:ume)?\s*\d+|v\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function stripPrefix(k: string) {
  for (const p of PREFIXES) if (k.startsWith(p + ' ') && k.length > p.length + 3) return k.slice(p.length + 1);
  return k;
}

const range = (a: number, b?: number) => (b !== undefined && b >= a && b - a < 60 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]);
const isYear = (n: number) => n >= 1930 && n <= 2099;

/** "Batman #676-681 (2008) - Grant Morrison…", "New Avengers (vol. 3) #30 (2015)", "Secret Wars (2015) #1". */
export function parseComicRef(text: string): ComicRef | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.{2,80}?)\s*(?:\((?:vol\.?|volume)\s*(\d+)\)\s*)?(?:\((\d{4})(?:\s*[-–]\s*(\d{2,4}))?\)\s*)?#\s?(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?(?:\s*\((\d{4})(?:\s*[-–]\s*(\d{2,4}))?\))?/i.exec(t);
  if (m) {
    const title = m[1]!.replace(/[,;:–—-]+$/, '').trim();
    const series = stripPrefix(seriesKey(title));
    if (!series) return null;
    const y = Number(m[7] ?? m[3]) || undefined;
    const ye = m[8] ?? m[4];
    return { series, title, volume: m[2] ? Number(m[2]) : undefined, issues: range(Number(m[5]), m[6] ? Number(m[6]) : undefined), year: y && isYear(y) ? y : undefined, yearEnd: ye ? Number(ye.length === 2 ? `${String(y).slice(0, 2)}${ye}` : ye) : undefined };
  }
  // title followed by a year only: "Secret Wars (1984)", "Civil War en 2006"
  const y = /^(.{2,60}?)\s*(?:\(|,?\s+en\s+)(\d{4})\)?/i.exec(t);
  if (y && isYear(Number(y[2]))) {
    const series = stripPrefix(seriesKey(y[1]!));
    if (series && series.split(' ').length <= 6) return { series, title: y[1]!.trim(), issues: [], year: Number(y[2]) };
  }
  return null;
}

/** Media file names: "Batman 676 (2008) cover.jpg", "secret_wars_2015_01.png", "New Avengers v3 #30.jpg". */
export function parseMediaRef(name: string): ComicRef | null {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = base.split(' ');
  const titleWords: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (/^(?:#?\d+|\(\d{4}\)|v\d+|vol)$/i.test(w)) break;
    titleWords.push(w);
  }
  if (!titleWords.length || i === words.length) return null;
  let volume: number | undefined;
  let year: number | undefined;
  const issues: number[] = [];
  for (; i < words.length; i++) {
    const w = words[i]!.replace(/[()]/g, '');
    const v = /^v(\d+)$/i.exec(w);
    if (v) volume = Number(v[1]);
    else if (/^vol$/i.test(w) && /^\d+$/.test(words[i + 1] ?? '')) volume = Number(words[++i]);
    else if (/^#?\d{1,4}(?:-\d{1,4})?$/.test(w)) {
      const [a, b] = w.replace('#', '').split('-').map(Number);
      if (!w.startsWith('#') && isYear(a!) && !b) year = a;
      else issues.push(...range(a!, b));
    } else if (!/^(?:cover|couverture|page|planche|p|variant|var|panel|case|art|splash|scan)$/i.test(w) && issues.length + (year ? 1 : 0) === 0) titleWords.push(w);
  }
  const series = stripPrefix(seriesKey(titleWords.join(' ')));
  if (!series || (!issues.length && !year)) return null;
  return { series, title: titleWords.join(' '), volume, issues, year };
}

/** References in a source line (several entries can be packed in one line). */
export function sourceRefs(text: string): ComicRef[] {
  const out: ComicRef[] = [];
  for (const part of text.split(/\s*(?:;|•|\.\s+(?=[A-Z][^.]{1,60}#\s?\d)|,\s+(?=[A-Z][^,]{1,40}#\s?\d))\s*/)) {
    const r = parseComicRef(part);
    if (r) out.push(r);
  }
  return out;
}

/** References cited in narration text. */
export function comicRefsIn(text: string): ComicRef[] {
  const out: ComicRef[] = [];
  // narration: "Dans Batman #676-681 (2008), Grant Morrison…", "dans X-Treme X-Men #9, en 2002"
  for (const m of text.matchAll(/(?:^|[\s(«"])((?:[A-Z0-9][\p{L}\p{N}'’:.-]*\s){0,5}[A-Z0-9][\p{L}\p{N}'’.-]*)\s*#\s?(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?(?:[^.;]{0,12}?(?:\((\d{4})\)|en (\d{4})))?/gu)) {
    const series = stripPrefix(seriesKey(m[1]!.replace(/^(?:Dans|Depuis|Avec|Selon|Puis|Et|Mais)\s+/, '')));
    if (!series || out.some((o) => o.series === series && o.issues.includes(Number(m[2])))) continue;
    const y = Number(m[4] ?? m[5]) || undefined;
    out.push({ series, title: m[1]!.trim(), issues: range(Number(m[2]), m[3] ? Number(m[3]) : undefined), year: y && isYear(y) ? y : undefined });
  }
  return out;
}

const sameSeries = (a: string, b: string) => a === b;

/**
 * How a media reference relates to a cited reference. A conflict is evidence that the picture shows
 * another work with the same name (other issue, other volume, other decade).
 */
export function compareRefs(cited: ComicRef, media: ComicRef): { verdict: RefVerdict; reason: string } {
  if (!sameSeries(cited.series, media.series)) return { verdict: 'unrelated', reason: '' };
  const label = (r: ComicRef) => `${r.title}${r.volume ? ` vol. ${r.volume}` : ''}${r.issues.length ? ` #${r.issues[0]}${r.issues.length > 1 ? `-${r.issues.at(-1)}` : ''}` : ''}${r.year ? ` (${r.year})` : ''}`;
  if (cited.volume && media.volume && cited.volume !== media.volume) return { verdict: 'conflict', reason: `autre volume : ${label(media)} ≠ ${label(cited)}` };
  const cy = cited.year;
  const my = media.year;
  if (cy && my) {
    const end = Math.max(cy, cited.yearEnd ?? cy);
    if (my < cy - 1 || my > end + 1) return { verdict: 'conflict', reason: `autre édition : ${label(media)} ≠ ${label(cited)}` };
  }
  if (cited.issues.length && media.issues.length) {
    const hit = media.issues.some((n) => cited.issues.includes(n));
    if (!hit) return { verdict: 'conflict', reason: `autre numéro : ${label(media)} ≠ ${label(cited)}` };
    return { verdict: 'same-issue', reason: `même numéro : ${label(media)}` };
  }
  return { verdict: 'same-series', reason: `même série : ${label(media)}` };
}
