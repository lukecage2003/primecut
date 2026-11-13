/**
 * Editorial planning: aligned sentences → beats (editorial sequences) → visual needs → shots
 * matched against the media library, with an explanation for every choice.
 */
import type { MediaAsset, MotionKind } from '../core/model';
import type { AlignedSentence } from './align';
import { type EntityMention, EntityIndex } from './entities';
import type { ProductionPreferences } from './preferences';
import type { ParsedScript } from './script';
import { contentWords, normalize, tokens } from './text';
import { type ComicRef, compareRefs, comicRefsIn, parseMediaRef, sourceRefs } from './comicRefs';

export interface Beat {
  index: number;
  section: number;
  sentenceIndexes: number[];
  start: number;
  end: number;
  text: string;
  entities: EntityMention[];
  hints: string[];
  keywords: string[];
  /** Comic references backing the beat ([SOURCE: …] in the script). */
  sources: string[];
  /** On-screen texts requested by the script. */
  onScreen: string[];
}

export function buildBeats(script: ParsedScript, aligned: AlignedSentence[], prefs: ProductionPreferences, index = new EntityIndex()): Beat[] {
  const beats: Beat[] = [];
  const bySentence = new Map(aligned.map((a) => [a.index, a]));
  let cur: Beat | null = null;
  const close = () => {
    if (cur) beats.push(cur);
    cur = null;
  };
  for (const s of script.sentences) {
    const a = bySentence.get(s.index);
    if (!a) continue;
    const ents = index.find(s.text);
    const mainEnt = ents.find((e) => e.entityId)?.entityId ?? null;
    if (cur) {
      const c: Beat = cur;
      const dur = c.end - c.start;
      const curMain = c.entities.find((e) => e.entityId)?.entityId ?? null;
      const newSubject = mainEnt && curMain && mainEnt !== curMain;
      const prevSentence = script.sentences[s.index - 1];
      if (s.section !== c.section || prevSentence?.breakAfter || dur >= prefs.shotTarget || (newSubject && dur >= prefs.shotMin) || dur + (a.end - a.start) > prefs.shotMax * 1.5) close();
    }
    if (!cur) {
      cur = { index: beats.length, section: s.section, sentenceIndexes: [], start: a.start, end: a.end, text: '', entities: [], hints: [], keywords: [], sources: [], onScreen: [] };
    }
    const b: Beat = cur;
    b.sentenceIndexes.push(s.index);
    b.end = a.end;
    b.text = (b.text + ' ' + s.text).trim();
    b.entities.push(...ents.filter((e) => !b.entities.some((x) => x.name === e.name)));
    for (const h of s.hints) if (!b.hints.includes(h)) b.hints.push(h);
    for (const x of s.sources ?? []) if (!b.sources.includes(x)) b.sources.push(x);
    b.onScreen.push(...(s.onScreen ?? []));
  }
  close();
  for (const b of beats) b.keywords = [...new Set(contentWords(b.text))];
  // beats tile the narration: each beat lasts until the next one starts
  for (let i = 0; i + 1 < beats.length; i++) beats[i]!.end = beats[i + 1]!.start;
  return beats;
}

export interface LibraryItem {
  asset: MediaAsset;
  tokens: Set<string>;
  entityIds: Set<string>;
  issues: Set<string>;
  /** Comic reference read from the file name (series, volume, issues, year), when it has one. */
  ref?: ComicRef | null;
}

export function indexLibrary(assets: MediaAsset[], index = new EntityIndex()): LibraryItem[] {
  return assets
    .filter((a) => a.kind === 'image' || (a.kind === 'video' && a.probe.video))
    .map((asset) => {
      const label = [asset.name.replace(/\.[^.]+$/, ''), ...(asset.tags ?? []), ...asset.path.split(/[\\/]/).slice(-3, -1)].join(' ');
      const spaced = label.replace(/[_.]/g, ' ');
      const ents = index.find(spaced.replace(/-/g, ' ')).concat(index.find(spaced));
      return {
        asset,
        tokens: new Set(tokens(label)),
        entityIds: new Set(ents.map((e) => e.entityId).filter((x): x is string => !!x)),
        issues: new Set([...label.matchAll(/(?:#|n°|no\.?|issue|num[eé]ro)\s?_?(\d{1,4})/gi)].map((m) => String(Number(m[1])))),
        ref: parseMediaRef(asset.name),
      };
    });
}

export interface ShotChoice {
  item: LibraryItem | null;
  score: number;
  reasons: string[];
  quality: 'strong' | 'weak' | 'missing';
}

const beatRefCache = new WeakMap<Beat, ComicRef[]>();
/** References the beat cites: its sources first, then the narration itself. */
export function beatRefs(beat: Beat): ComicRef[] {
  let r = beatRefCache.get(beat);
  if (!r) {
    r = [...beat.sources.flatMap(sourceRefs), ...comicRefsIn(beat.text)];
    beatRefCache.set(beat, r);
  }
  return r;
}

export function scoreItem(beat: Beat, item: LibraryItem): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  // a picture named after a precise comic is checked against the references the passage cites:
  // same issue is strong evidence; another issue/volume/decade of a same-named series is a conflict
  if (item.ref) {
    const verdicts = beatRefs(beat).map((r) => compareRefs(r, item.ref!)).filter((v) => v.verdict !== 'unrelated');
    const best = verdicts.find((v) => v.verdict === 'same-issue') ?? verdicts.find((v) => v.verdict === 'same-series');
    if (best) {
      score += best.verdict === 'same-issue' ? 7 : 2;
      reasons.push(`${best.reason} (lu dans le nom du fichier, non authentifié)`);
    } else if (verdicts.length) {
      return { score: -10, reasons: [verdicts[0]!.reason] };
    }
  }
  for (const e of beat.entities) {
    if (e.entityId && item.entityIds.has(e.entityId)) {
      score += e.kind === 'character' || e.kind === 'team' ? 6 : 4;
      reasons.push(`montre ${e.surface.replace(/[.,;:!?»”)]+$/, '') || e.name}`);
    }
    if (e.kind === 'issue' && item.issues.has(e.name.slice(1))) {
      score += 3;
      reasons.push(`numéro ${e.name}`);
    }
  }
  for (const h of beat.hints) {
    const ht = tokens(h).filter((t) => t.length > 2);
    const hit = ht.filter((t) => item.tokens.has(t)).length;
    if (hit) {
      score += 5 * (hit / ht.length) + 2;
      reasons.push(`correspond à l’indication visuelle “${h}”`);
    }
  }
  for (const src of beat.sources ?? []) {
    const st = tokens(src.replace(/\([^)]*\)/g, ' ')).filter((t) => t.length > 2 && !/^\d+$/.test(t));
    const hit = st.filter((t) => item.tokens.has(t)).length;
    const issues = [...src.matchAll(/#\s?(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?/g)].flatMap((m) => {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      return b >= a && b - a < 30 ? Array.from({ length: b - a + 1 }, (_, i) => String(a + i)) : [String(a)];
    });
    if (hit && st.length) {
      const issueHit = issues.some((n) => item.issues.has(n));
      score += 3 * (hit / st.length) + (issueHit ? 3 : 1);
      reasons.push(`correspond à la source “${src}”${issueHit ? ' (même numéro)' : ''}`);
      break;
    }
  }
  const kw = beat.keywords.filter((k) => item.tokens.has(k));
  if (kw.length) {
    score += Math.min(3, kw.length);
    reasons.push(`mots-clés : ${kw.slice(0, 3).join(', ')}`);
  }
  return { score, reasons };
}

/** Picks media for a shot, preferring relevance, then variety (no repeats within a window). */
export function chooseMedia(beat: Beat, library: LibraryItem[], recent: string[], usage: Map<string, number>, prefs: ProductionPreferences, sectionEntities: Set<string>, next?: Beat, reserved?: Map<string, number>): ShotChoice {
  if (!library.length) return { item: null, score: 0, reasons: ['aucun média disponible'], quality: 'missing' };
  let best: ShotChoice | null = null;
  const window = recent.slice(-prefs.avoidRepeatWithin);
  for (const item of library) {
    const { score, reasons } = scoreItem(beat, item);
    if (score < 0) continue; // another work with the same name: never shown for this passage
    let adj = score;
    const r: string[] = [...reasons];
    if (score === 0) {
      const sec = [...item.entityIds].filter((e) => sectionEntities.has(e)).length;
      if (sec) {
        adj = 0.5 * sec;
        r.push('liée à la section en cours');
      }
    }
    const owner = reserved?.get(item.asset.id);
    if (owner !== undefined && owner !== beat.index && library.length > 2) continue; // reserved by an explicit visual hint elsewhere
    // don't spend, on a generic shot, the image the next beat specifically needs
    if (score === 0 && next && scoreItem(next, item).score > 0) adj -= 2;
    if (library.length > 1 && recent.at(-1) === item.asset.id) continue; // never the same image twice in a row
    if (window.includes(item.asset.id)) adj -= 4;
    adj -= 0.3 * (usage.get(item.asset.id) ?? 0);
    if (item.asset.rights && !['owned', 'user-provided', 'reusable'].includes(item.asset.rights.usage)) continue; // never auto-place unlicensed media
    if (!best || adj > best.score) best = { item, score: adj, reasons: r, quality: score > 0 ? 'strong' : 'weak' };
  }
  if (!best) return { item: null, score: 0, reasons: ['aucun média aux droits utilisables'], quality: 'missing' };
  if (best.quality === 'weak' && best.reasons.length === 0) best.reasons.push('aucune correspondance précise : image la moins utilisée, pour varier');
  return best;
}

/** Items explicitly requested by a beat's [VISUEL: …] hint are reserved for that beat. */
export function reserveHinted(beats: Beat[], library: LibraryItem[]): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const b of beats) {
    if (!b.hints.length) continue;
    let best: { id: string; score: number } | null = null;
    for (const item of library) {
      const hintOnly = scoreItem({ ...b, entities: b.entities.filter((e) => e.kind === 'issue'), keywords: [] }, item).score;
      if (hintOnly >= 5 && (!best || hintOnly > best.score)) best = { id: item.asset.id, score: hintOnly };
    }
    if (best && !reserved.has(best.id)) reserved.set(best.id, b.index);
  }
  return reserved;
}

/** Deterministic weighted pick (stable across runs for the same input). */
export function pickMotion(prefs: ProductionPreferences, seed: number, previous: MotionKind | null, portrait: boolean): MotionKind {
  const entries = Object.entries(prefs.motionWeights).filter(([k]) => k !== previous) as [Exclude<MotionKind, 'none' | 'panels'>, number][];
  const weighted = entries.map(([k, w]) => [k, portrait && (k === 'pan-up' || k === 'pan-down') ? w * 3 : w] as const);
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  if (total <= 0 || prefs.motionAmount <= 0) return 'none';
  let x = ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1 * total;
  for (const [k, w] of weighted) {
    if ((x -= w) <= 0) return k;
  }
  return weighted.at(-1)![0];
}

export function normalizedTitle(s: string) {
  return normalize(s);
}
