/**
 * Editorial planning: aligned sentences → beats (editorial sequences) → visual needs → shots
 * matched against the media library, with an explanation for every choice.
 */
import type { MediaAsset, MotionKind } from '../core/model';
import { duplicateGroups } from '../core/phash';
import { type DecisionCandidate, type EvidenceBasis, type MatchEvidence, CONTENT_BASES, confidenceFrom } from '../core/edg';
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

/** Where a library item's words come from (only description and OCR describe the picture itself). */
type SourceKey = 'description' | 'texte-ocr' | 'étiquette' | 'nom' | 'dossier';
const SOURCE_ORDER: SourceKey[] = ['description', 'texte-ocr', 'étiquette', 'nom', 'dossier'];

export interface LibraryItem {
  asset: MediaAsset;
  tokens: Set<string>;
  entityIds: Set<string>;
  issues: Set<string>;
  /** Tokens and entities per source, to say where a match comes from. */
  bySource: Partial<Record<SourceKey, { tokens: Set<string>; entityIds: Set<string> }>>;
  /** Comic reference read from the file name (series, volume, issues, year), when it has one. */
  ref?: ComicRef | null;
  /** Id shared by near-identical copies of the same picture (repetition checks use it). */
  same: string;
}

export function indexLibrary(assets: MediaAsset[], index = new EntityIndex()): LibraryItem[] {
  // duplicate pictures (same image, other file/size/compression) count as one for repetitions
  const same = duplicateGroups(assets.map((a) => ({ id: a.id, phash: a.phash, area: (a.probe.video?.width ?? 0) * (a.probe.video?.height ?? 0) })));
  return assets
    .filter((a) => a.kind === 'image' || (a.kind === 'video' && a.probe.video))
    .map((asset) => {
      const texts: Record<SourceKey, string> = {
        nom: asset.name.replace(/\.[^.]+$/, ''),
        étiquette: (asset.tags ?? []).join(' '),
        dossier: asset.path.split(/[\\/]/).slice(-3, -1).join(' '),
        'texte-ocr': asset.ocr?.text ?? '',
        description: asset.description ?? '',
      };
      const bySource: LibraryItem['bySource'] = {};
      for (const k of SOURCE_ORDER) {
        const t = texts[k];
        if (!t.trim()) continue;
        const spaced = t.replace(/[_.]/g, ' ');
        const ents = index.find(spaced.replace(/-/g, ' ')).concat(index.find(spaced));
        bySource[k] = { tokens: new Set(tokens(t)), entityIds: new Set(ents.map((e) => e.entityId).filter((x): x is string => !!x)) };
      }
      const label = [texts.nom, texts.étiquette, texts.dossier].join(' ');
      return {
        asset,
        tokens: new Set(SOURCE_ORDER.flatMap((k) => [...(bySource[k]?.tokens ?? [])])),
        entityIds: new Set(SOURCE_ORDER.flatMap((k) => [...(bySource[k]?.entityIds ?? [])])),
        issues: new Set([...label.matchAll(/(?:#|n°|no\.?|issue|num[eé]ro)\s?_?(\d{1,4})/gi)].map((m) => String(Number(m[1])))),
        bySource,
        ref: parseMediaRef(asset.name),
        same: same.get(asset.id) ?? asset.id,
      };
    });
}

/** First source (most descriptive first) where an entity or a token was found. */
function sourceOf(item: LibraryItem, test: (s: { tokens: Set<string>; entityIds: Set<string> }) => boolean): EvidenceBasis {
  for (const k of SOURCE_ORDER) {
    const s = item.bySource[k];
    if (s && test(s)) return k;
  }
  return 'nom';
}

export interface ShotChoice {
  item: LibraryItem | null;
  score: number;
  reasons: string[];
  quality: 'strong' | 'weak' | 'missing';
  /** Where the match comes from (file name, tags, folder, OCR, description…). */
  evidence: MatchEvidence[];
  /** 0..1, metadata-only matches stay ≤ 0.75 (see confidenceFrom). */
  confidence: number;
  /** Other acceptable candidates, best first (for the decision graph and the "Replace" menu). */
  candidates: DecisionCandidate[];
  /** Rules that shaped the choice (variety, rights, reservations, user locks). */
  criteria: string[];
}

/** Minimum metadata score for a match to count as specific ("strong"). Keyword overlap alone never does. */
export const STRONG_SCORE = 4;

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

export function scoreItem(beat: Beat, item: LibraryItem): { score: number; reasons: string[]; evidence: MatchEvidence[] } {
  let score = 0;
  const reasons: string[] = [];
  const evidence: MatchEvidence[] = [];
  const add = (basis: EvidenceBasis, detail: string, weight: number) => {
    score += weight;
    evidence.push({ basis, detail, weight: +weight.toFixed(2) });
  };
  // a picture named after a precise comic is checked against the references the passage cites:
  // same issue is strong evidence; another issue/volume/decade of a same-named series is a conflict
  if (item.ref) {
    const verdicts = beatRefs(beat).map((r) => compareRefs(r, item.ref!)).filter((v) => v.verdict !== 'unrelated');
    const best = verdicts.find((v) => v.verdict === 'same-issue') ?? verdicts.find((v) => v.verdict === 'same-series');
    if (best) {
      add('référence', best.reason, best.verdict === 'same-issue' ? 7 : 2);
      reasons.push(`${best.reason} (lu dans le nom du fichier, non authentifié)`);
    } else if (verdicts.length) {
      return { score: -10, reasons: [verdicts[0]!.reason], evidence: [{ basis: 'référence', detail: verdicts[0]!.reason, weight: -10 }] };
    }
  }
  for (const e of beat.entities) {
    if (e.entityId && item.entityIds.has(e.entityId)) {
      const basis = sourceOf(item, (s) => s.entityIds.has(e.entityId!));
      const name = e.surface.replace(/[.,;:!?»”)]+$/, '') || e.name;
      add(basis, name, e.kind === 'character' || e.kind === 'team' ? 6 : 4);
      reasons.push(CONTENT_BASES.has(basis) ? `montre ${name} (${basis === 'texte-ocr' ? 'texte lu dans l’image' : 'd’après votre description'})` : `${name} dans le ${basis === 'dossier' ? 'nom du dossier' : basis === 'étiquette' ? 'étiquettes' : 'nom du fichier'}`);
    }
    if (e.kind === 'issue' && item.issues.has(e.name.slice(1))) {
      add('nom', `numéro ${e.name}`, 3);
      reasons.push(`numéro ${e.name}`);
    }
  }
  for (const h of beat.hints) {
    const ht = tokens(h).filter((t) => t.length > 2);
    const hit = ht.filter((t) => item.tokens.has(t));
    if (hit.length) {
      add('indication', `“${h}” (${hit.length}/${ht.length} mots dans ${BASIS_WHERE(item, hit[0]!)})`, 5 * (hit.length / ht.length) + 2);
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
      add('référence', `source “${src}”${issueHit ? ' (même numéro)' : ''}`, 3 * (hit / st.length) + (issueHit ? 3 : 1));
      reasons.push(`correspond à la source “${src}”${issueHit ? ' (même numéro)' : ''}`);
      break;
    }
  }
  const kw = beat.keywords.filter((k) => item.tokens.has(k));
  if (kw.length) {
    const basis = sourceOf(item, (s) => kw.some((k) => s.tokens.has(k)));
    add(CONTENT_BASES.has(basis) ? basis : 'mots-clés', kw.slice(0, 3).join(', '), Math.min(3, kw.length));
    reasons.push(`mots-clés : ${kw.slice(0, 3).join(', ')}`);
  }
  return { score, reasons, evidence };
}

function BASIS_WHERE(item: LibraryItem, token: string): string {
  const b = sourceOf(item, (s) => s.tokens.has(token));
  return b === 'description' ? 'votre description' : b === 'texte-ocr' ? 'le texte lu dans l’image' : b === 'étiquette' ? 'les étiquettes' : b === 'dossier' ? 'le nom du dossier' : 'le nom du fichier';
}

export interface ChooseOptions {
  /** Media forced by the user (locked/accepted decision): used when still available and allowed. */
  forced?: string | null;
  /** Media the user rejected for this decision. */
  exclude?: ReadonlySet<string>;
  /** Place a picture with no relation at all to the passage (off: the shot becomes a composition or a placeholder). */
  fillUnrelated?: boolean;
}

const RIGHTS_OK = ['owned', 'user-provided', 'reusable'];

function candidate(item: LibraryItem, score: number, evidence: MatchEvidence[]): DecisionCandidate {
  return { mediaId: item.asset.id, label: item.asset.name, score: +score.toFixed(2), confidence: confidenceFrom(score, evidence), evidence };
}

/**
 * Picks media for a shot, preferring relevance, then variety (no repeats within a window).
 * A picture with no relation to the passage is never placed unless `fillUnrelated` is set: the
 * shot then becomes a procedural composition or a "missing visual" placeholder.
 */
export function chooseMedia(beat: Beat, library: LibraryItem[], recent: string[], usage: Map<string, number>, prefs: ProductionPreferences, sectionEntities: Set<string>, next?: Beat, reserved?: Map<string, number>, opts: ChooseOptions = {}): ShotChoice {
  const none = (reason: string, criteria: string[] = []): ShotChoice => ({ item: null, score: 0, reasons: [reason], quality: 'missing', evidence: [{ basis: 'aucune', detail: reason, weight: 0 }], confidence: 0, candidates: [], criteria });
  if (!library.length) return none('aucun média disponible');
  const criteria: string[] = [];
  // a user lock wins when the media still exists and may be used
  if (opts.forced) {
    const it = library.find((i) => i.asset.id === opts.forced);
    if (it && (!it.asset.rights || RIGHTS_OK.includes(it.asset.rights.usage))) {
      const { score, reasons, evidence } = scoreItem(beat, it);
      const ev: MatchEvidence[] = [...evidence, { basis: 'utilisateur', detail: 'choix conservé', weight: 0 }];
      return { item: it, score, reasons: ['choix conservé de la version précédente', ...reasons], quality: score >= STRONG_SCORE ? 'strong' : 'weak', evidence: ev, confidence: 1, candidates: [candidate(it, score, ev)], criteria: ['décision verrouillée ou validée : conservée'] };
    }
    criteria.push('le média choisi auparavant n’est plus disponible : nouvelle proposition');
  }
  let best: (ShotChoice & { raw: number }) | null = null;
  const window = recent.slice(-prefs.avoidRepeatWithin);
  const pool: { item: LibraryItem; adj: number; raw: number; evidence: MatchEvidence[] }[] = [];
  let blockedRights = 0;
  for (const item of library) {
    if (opts.exclude?.has(item.asset.id)) continue;
    if (item.asset.rights && !RIGHTS_OK.includes(item.asset.rights.usage)) {
      blockedRights++;
      continue; // never auto-place unlicensed media
    }
    const { score, reasons, evidence } = scoreItem(beat, item);
    if (score < 0) continue; // another work with the same name: never shown for this passage
    let adj = score;
    const r: string[] = [...reasons];
    const ev = [...evidence];
    if (score === 0) {
      const sec = [...item.entityIds].filter((e) => sectionEntities.has(e)).length;
      if (sec) {
        adj = 0.5 * sec;
        r.push('liée à la section en cours (nom ou étiquettes)');
        ev.push({ basis: 'section', detail: `${sec} personnage(s) ou équipe(s) de la section`, weight: adj });
      } else if (!opts.fillUnrelated) continue; // no relation at all: not placed automatically
    }
    const owner = reserved?.get(item.asset.id);
    if (owner !== undefined && owner !== beat.index && library.length > 2) continue; // reserved by an explicit visual hint elsewhere
    // don't spend, on a generic shot, the image the next beat specifically needs
    if (score === 0 && next && scoreItem(next, item).score > 0) adj -= 2;
    if (library.length > 1 && recent.at(-1) === item.same) continue; // never the same image twice in a row (duplicates included)
    if (window.includes(item.same)) adj -= 4;
    adj -= 0.3 * (usage.get(item.same) ?? 0);
    pool.push({ item, adj, raw: score > 0 ? score : Math.max(0, adj), evidence: ev });
    if (!best || adj > best.score) best = { item, score: adj, raw: score, reasons: r, quality: score >= STRONG_SCORE ? 'strong' : 'weak', evidence: ev, confidence: confidenceFrom(score > 0 ? score : Math.max(0, adj), ev), candidates: [], criteria };
  }
  if (blockedRights) criteria.push(`${blockedRights} média(s) écarté(s) : droits non vérifiés`);
  if (opts.exclude?.size) criteria.push(`${opts.exclude.size} média(s) rejeté(s) par vous pour ce passage`);
  if (!best) return none(blockedRights && blockedRights === library.length ? 'aucun média aux droits utilisables' : 'aucune image liée à ce passage (nom, étiquettes, dossier, description)', criteria);
  if (best.quality === 'weak' && best.reasons.length === 0) best.reasons.push('aucune correspondance : image la moins utilisée, pour varier (option « Remplir avec des images sans rapport »)');
  if (window.includes(best.item!.same)) criteria.push('répétition récente acceptée faute d’alternative');
  best.candidates = pool
    .sort((a, b) => b.adj - a.adj)
    .slice(0, 6)
    .map((p) => candidate(p.item, p.raw, p.evidence));
  const { raw: _raw, ...choice } = best;
  void _raw;
  return choice;
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
