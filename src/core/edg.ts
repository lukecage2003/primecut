/**
 * Edit Decision Graph (EDG): the source of truth for the editorial decisions of a generated version.
 *
 * Every automatic choice (which picture for which passage, which music for which section) is a
 * decision with a stable identifier, its candidates, the criteria and evidence behind it, a
 * confidence, its dependencies, a validation state and a history. The timeline is the
 * materialisation of these decisions; manual edits in the timeline are reconciled back into the
 * graph (the decision becomes the user's and is locked), so a regeneration keeps them.
 *
 * Pure functions only: used by the builder (engine side), the editor (renderer side, inside the
 * undoable edit so undo/redo restore the graph with the timeline) and the project migration.
 */
import type { MediaAsset, Sequence } from './model';

export const EDG_VERSION = 1;

/**
 * Where a match comes from. Only 'description' (written by the user) and 'texte-ocr' (text read in
 * the picture by a local OCR engine) say anything about what the picture contains; everything
 * else is metadata (file name, tags, folders), never a visual understanding.
 */
export type EvidenceBasis = 'référence' | 'nom' | 'étiquette' | 'dossier' | 'texte-ocr' | 'description' | 'section' | 'mots-clés' | 'indication' | 'utilisateur' | 'musique' | 'ordre' | 'aucune';

export interface MatchEvidence {
  basis: EvidenceBasis;
  detail: string;
  weight: number;
}

export const CONTENT_BASES: ReadonlySet<EvidenceBasis> = new Set(['texte-ocr', 'description', 'utilisateur']);

export const BASIS_LABEL: Record<EvidenceBasis, string> = {
  référence: 'référence comics lue dans le nom du fichier',
  nom: 'nom du fichier',
  étiquette: 'étiquette',
  dossier: 'nom du dossier',
  'texte-ocr': 'texte lu dans l’image (OCR local)',
  description: 'description écrite par vous',
  section: 'lien avec la section',
  'mots-clés': 'mots-clés du nom ou des étiquettes',
  indication: 'indication [VISUEL] du script',
  utilisateur: 'choisi par vous',
  musique: 'analyse du signal musical',
  ordre: 'ordre de lecture du livre (mode histoire)',
  aucune: 'aucune correspondance',
};

export type DecisionKind = 'visuel' | 'musique';
export type DecisionState = 'proposée' | 'acceptée' | 'rejetée' | 'verrouillée';

export interface DecisionCandidate {
  /** Media chosen (null = no media: placeholder or procedural composition). */
  mediaId: string | null;
  label: string;
  score: number;
  /** 0..1: how well the evidence supports this candidate for the passage (not a visual certainty). */
  confidence: number;
  evidence: MatchEvidence[];
  /** Procedural composition (no picture). */
  generated?: boolean;
  /** For music: id in the music library index. */
  trackId?: string;
}

export interface DecisionEvent {
  at: string;
  action: 'créée' | 'acceptée' | 'rejetée' | 'verrouillée' | 'déverrouillée' | 'remplacée' | 'retouche' | 'supprimée' | 'conservée' | 'rétablie';
  by: 'auto' | 'utilisateur';
  detail?: string;
}

export interface EditDecision {
  id: string;
  kind: DecisionKind;
  anchor: {
    /** Beat (visual) or section (music) index in this version. */
    beat?: number;
    section?: number;
    /** n-th decision of the same kind inside the anchor. */
    ordinal: number;
    text: string;
    /** Hash of the normalised passage text: the decision's identity survives re-timing. */
    textHash: string;
    start: number;
    end: number;
  };
  /** Timeline clips materialising this decision. */
  clipIds: string[];
  chosen: DecisionCandidate;
  candidates: DecisionCandidate[];
  /** Rules applied (variety, rights, reservation…). */
  criteria: string[];
  confidence: number;
  /** Inputs this decision depends on: `phrase:<hash>`, `section:<n>`, `media:<id>`, `piste:<id>`. */
  deps: string[];
  state: DecisionState;
  author: 'auto' | 'utilisateur';
  /** Media the user rejected for this decision (never proposed again for it). */
  rejected: string[];
  history: DecisionEvent[];
}

export interface EditDecisionGraph {
  version: number;
  createdAt: string;
  decisions: EditDecision[];
}

const now = () => new Date().toISOString();

/** 64-bit (two FNV-1a 32) hash in base 36: stable across runs and platforms. */
export function stableHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return h1.toString(36).padStart(7, '0') + h2.toString(36).padStart(7, '0');
}

export function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function textHash(text: string): string {
  return stableHash(normaliseText(text));
}

/** Identifier of a decision: kind + passage text + rank inside the passage. Independent of timing. */
export function decisionId(kind: DecisionKind, text: string, ordinal: number): string {
  return `${kind === 'visuel' ? 'v' : 'm'}-${textHash(text)}-${ordinal}`;
}

/** Confidence of a candidate from its evidence: metadata alone never reaches visual certainty. */
export function confidenceFrom(score: number, evidence: MatchEvidence[]): number {
  if (evidence.some((e) => e.basis === 'utilisateur')) return 1;
  if (score <= 0) return 0;
  const content = evidence.some((e) => CONTENT_BASES.has(e.basis));
  const cap = content ? 0.9 : 0.75;
  return +Math.min(cap, 1 - Math.exp(-score / 6)).toFixed(2);
}

export function createGraph(decisions: EditDecision[] = []): EditDecisionGraph {
  return { version: EDG_VERSION, createdAt: now(), decisions };
}

export function findDecision(seq: Sequence, id: string): EditDecision | undefined {
  return seq.production?.edg?.decisions.find((d) => d.id === id);
}

export function decisionForClip(seq: Sequence, clipId: string): EditDecision | undefined {
  return seq.production?.edg?.decisions.find((d) => d.clipIds.includes(clipId));
}

function push(d: EditDecision, e: Omit<DecisionEvent, 'at'>) {
  d.history.push({ at: now(), ...e });
  if (d.history.length > 50) d.history.splice(0, d.history.length - 50);
}

/**
 * Brings the graph in line with the timeline after a manual edit (called inside the same undoable
 * step). A clip whose picture was changed by hand makes the decision the user's (locked); a
 * deleted clip makes the decision rejected; a trim updates the anchor. Returns what changed.
 */
export function reconcileGraph(seq: Sequence, media?: Record<string, MediaAsset>): string[] {
  const g = seq.production?.edg;
  if (!g) return [];
  const clips = new Map(seq.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  const changes: string[] = [];
  for (const d of g.decisions) {
    const live = d.clipIds.map((id) => clips.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
    if (!live.length) {
      if (d.clipIds.length && d.state !== 'rejetée') {
        d.state = 'rejetée';
        d.author = 'utilisateur';
        push(d, { action: 'supprimée', by: 'utilisateur', detail: 'plan supprimé dans la timeline' });
        changes.push(d.id);
      }
      continue;
    }
    // a restored clip (undo of a delete is handled by history; a re-added clip id) brings it back
    if (d.state === 'rejetée' && live.length === d.clipIds.length && d.history.at(-1)?.action === 'supprimée') {
      d.state = 'proposée';
      push(d, { action: 'rétablie', by: 'utilisateur' });
      changes.push(d.id);
    }
    const first = live[0]!;
    const start = Math.min(...live.map((c) => c.start));
    const end = Math.max(...live.map((c) => c.start + c.duration));
    if (start !== d.anchor.start || end !== d.anchor.end) {
      d.anchor.start = start;
      d.anchor.end = end;
    }
    if (first.mediaId !== d.chosen.mediaId) {
      const known = d.candidates.find((c) => c.mediaId === first.mediaId);
      const m = media?.[first.mediaId];
      d.chosen = known
        ? { ...known, evidence: [...known.evidence, { basis: 'utilisateur', detail: 'remplacé dans la timeline', weight: 0 }], confidence: 1 }
        : { mediaId: first.mediaId, label: m?.name ?? first.name, score: 0, confidence: 1, evidence: [{ basis: 'utilisateur', detail: 'remplacé dans la timeline', weight: 0 }], generated: !!m?.generator };
      d.confidence = 1;
      d.author = 'utilisateur';
      d.state = 'verrouillée';
      push(d, { action: 'retouche', by: 'utilisateur', detail: `image remplacée dans la timeline : ${d.chosen.label}` });
      changes.push(d.id);
    }
  }
  return changes;
}

export function setDecisionState(seq: Sequence, id: string, state: DecisionState): EditDecision {
  const d = findDecision(seq, id);
  if (!d) throw new Error('Décision introuvable dans cette version');
  if (d.state === state) return d;
  const action: DecisionEvent['action'] = state === 'acceptée' ? 'acceptée' : state === 'verrouillée' ? 'verrouillée' : state === 'rejetée' ? 'rejetée' : 'déverrouillée';
  d.state = state;
  push(d, { action, by: 'utilisateur' });
  return d;
}

/**
 * Applies a candidate (or any media) to a decision: the timeline clips switch to it and the
 * decision becomes the user's, locked. Video candidates must be long enough for the shot.
 */
export function chooseCandidate(seq: Sequence, media: Record<string, MediaAsset>, id: string, mediaId: string): EditDecision {
  const d = findDecision(seq, id);
  if (!d) throw new Error('Décision introuvable dans cette version');
  const m = media[mediaId];
  if (!m) throw new Error('Média introuvable dans le projet');
  const clips = seq.tracks.flatMap((t) => t.clips).filter((c) => d.clipIds.includes(c.id));
  if (!clips.length) throw new Error('Le plan de cette décision a été supprimé de la timeline');
  const rate = seq.settings.frameRate;
  for (const c of clips) {
    if (m.kind === 'video' && (m.probe.durationSec * rate.num) / rate.den < c.duration) throw new Error(`${m.name} est plus courte que le plan`);
    const wasGenerated = !!media[c.mediaId]?.generator;
    c.mediaId = m.id;
    c.name = m.name;
    if (wasGenerated || m.kind === 'image') c.sourceIn = 0;
    if (m.kind === 'image' && c.motion.kind === 'none') c.motion = { kind: 'zoom-in', amount: 0.1 };
    if (m.kind !== 'image' && c.motion.kind === 'panels') c.motion = { kind: 'none', amount: 0 };
    if (m.kind === 'image' && c.motion.kind === 'panels' && !m.panels?.length) c.motion = { kind: 'zoom-in', amount: 0.1 };
  }
  const known = d.candidates.find((c) => c.mediaId === mediaId);
  d.chosen = { ...(known ?? { mediaId, label: m.name, score: 0, evidence: [] }), confidence: 1, evidence: [...(known?.evidence ?? []), { basis: 'utilisateur', detail: 'choisi par vous', weight: 0 }], generated: !!m.generator };
  d.confidence = 1;
  d.state = 'verrouillée';
  d.author = 'utilisateur';
  d.rejected = d.rejected.filter((r) => r !== mediaId);
  push(d, { action: 'remplacée', by: 'utilisateur', detail: m.name });
  return d;
}

/**
 * Rejects the current choice: it is never proposed again for this passage. When another candidate
 * exists it replaces it at once (still a proposal); otherwise the decision stays rejected and the
 * quality report asks for a replacement.
 */
export function rejectDecision(seq: Sequence, media: Record<string, MediaAsset>, id: string): EditDecision {
  const d = findDecision(seq, id);
  if (!d) throw new Error('Décision introuvable dans cette version');
  const key = d.kind === 'musique' ? (d.chosen.trackId ?? d.chosen.mediaId) : d.chosen.mediaId;
  if (key && !d.rejected.includes(key)) d.rejected.push(key);
  const next = d.candidates.find((c) => c.mediaId && c.mediaId !== d.chosen.mediaId && !d.rejected.includes(c.mediaId) && media[c.mediaId]);
  if (next && d.kind === 'visuel') {
    const before = d.chosen.label;
    chooseCandidate(seq, media, id, next.mediaId!);
    d.chosen = next;
    d.confidence = next.confidence;
    d.state = 'proposée';
    d.author = 'auto';
    d.history.pop();
    push(d, { action: 'rejetée', by: 'utilisateur', detail: `${before} rejetée ; proposition suivante : ${next.label}` });
  } else {
    d.state = 'rejetée';
    d.author = 'utilisateur';
    push(d, { action: 'rejetée', by: 'utilisateur', detail: d.kind === 'musique' ? 'piste écartée : une autre sera choisie à la prochaine génération, ou choisissez-en une' : 'aucune autre proposition : à remplacer' });
  }
  return d;
}

/**
 * Replaces the music of a decision: the bed clips of its span are re-laid with the new track
 * (looped, same fades), and the decision becomes the user's, locked.
 */
export function replaceMusic(seq: Sequence, id: string, m: MediaAsset, gainDb: number, trackId?: string): EditDecision {
  const d = findDecision(seq, id);
  if (!d || d.kind !== 'musique') throw new Error('Décision musicale introuvable');
  const track = seq.tracks.find((t) => t.clips.some((c) => d.clipIds.includes(c.id)));
  if (!track) throw new Error('Les clips de cette musique ont été supprimés de la timeline');
  const old = track.clips.filter((c) => d.clipIds.includes(c.id)).sort((a, b) => a.start - b.start);
  const from = old[0]!.start;
  const to = Math.max(...old.map((c) => c.start + c.duration));
  const fadeIn = old[0]!.fadeIn;
  const fadeOut = old.at(-1)!.fadeOut;
  track.clips = track.clips.filter((c) => !d.clipIds.includes(c.id));
  const rate = seq.settings.frameRate;
  const loop = Math.floor((m.probe.durationSec * rate.num) / rate.den);
  if (loop < 1) throw new Error(`${m.name} est trop courte`);
  const ids: string[] = [];
  for (let t = from; t < to; t += loop) {
    const dur = Math.min(loop, to - t);
    const c = { ...old[0]!, id: globalThis.crypto.randomUUID(), mediaId: m.id, name: m.name, start: t, duration: dur, sourceIn: 0, gainDb, fadeIn: t === from ? Math.min(fadeIn, dur) : Math.min(Math.round((0.3 * rate.num) / rate.den), dur), fadeOut: 0, transform: { ...old[0]!.transform }, motion: { ...old[0]!.motion } };
    c.fadeOut = Math.min(t + loop >= to ? fadeOut : Math.round((0.3 * rate.num) / rate.den), dur - c.fadeIn);
    track.clips.push(c);
    ids.push(c.id);
  }
  track.clips.sort((a, b) => a.start - b.start);
  d.clipIds = ids;
  d.chosen = { mediaId: m.id, label: m.name, score: 0, confidence: 1, evidence: [{ basis: 'utilisateur', detail: 'piste choisie par vous', weight: 0 }], trackId };
  d.confidence = 1;
  d.state = 'verrouillée';
  d.author = 'utilisateur';
  push(d, { action: 'remplacée', by: 'utilisateur', detail: m.name });
  return d;
}

export interface GraphSummary {
  total: number;
  locked: number;
  accepted: number;
  rejected: number;
  proposed: number;
  lowConfidence: number;
  byUser: number;
  /** Decisions backed only by metadata (file names, tags, folders). */
  metadataOnly: number;
}

export function summariseGraph(g: EditDecisionGraph | undefined, threshold = 0.45): GraphSummary {
  const ds = g?.decisions ?? [];
  return {
    total: ds.length,
    locked: ds.filter((d) => d.state === 'verrouillée').length,
    accepted: ds.filter((d) => d.state === 'acceptée').length,
    rejected: ds.filter((d) => d.state === 'rejetée').length,
    proposed: ds.filter((d) => d.state === 'proposée').length,
    lowConfidence: ds.filter((d) => d.state === 'proposée' && !d.chosen.generated && d.chosen.mediaId && d.confidence < threshold).length,
    byUser: ds.filter((d) => d.author === 'utilisateur').length,
    metadataOnly: ds.filter((d) => d.chosen.mediaId && !d.chosen.generated && d.author === 'auto' && !d.chosen.evidence.some((e) => CONTENT_BASES.has(e.basis))).length,
  };
}

/** What a regeneration must keep from a previous graph, per decision id. */
export interface Carry {
  /** Forced media (locked or accepted decisions, or unchanged passages when asked). */
  forced?: string | null;
  /** The kept choice was a procedural composition (re-rendered, never replaced by a picture). */
  generated?: boolean;
  rejected: string[];
  state: DecisionState;
  author: 'auto' | 'utilisateur';
  history: DecisionEvent[];
}

/**
 * Carry-over plan for a regeneration. Locked and accepted decisions are kept; rejected media stay
 * excluded. With `keepUnchanged`, proposals of passages whose text did not change are kept too, so
 * editing one sentence only changes the shots of that sentence.
 */
export function carryOver(prev: EditDecisionGraph | undefined, keepUnchanged = false): Map<string, Carry> {
  const out = new Map<string, Carry>();
  for (const d of prev?.decisions ?? []) {
    const keep = d.state === 'verrouillée' || d.state === 'acceptée' || (keepUnchanged && d.state === 'proposée');
    out.set(d.id, { forced: keep ? d.chosen.mediaId : undefined, generated: keep && !!d.chosen.generated, rejected: [...d.rejected], state: d.state, author: d.author, history: d.history.slice(-20) });
  }
  return out;
}

/**
 * Builds a graph for a version produced before the EDG existed (project migration): one visual
 * decision per shot of the production record, matched to the V1 clip that starts at the same frame.
 */
export function graphFromShots(seq: Sequence): EditDecisionGraph | undefined {
  const p = seq.production;
  if (!p) return undefined;
  const v1 = seq.tracks.find((t) => t.kind === 'video');
  const ordinal = new Map<string, number>();
  const decisions: EditDecision[] = p.shots.map((s) => {
    const n = ordinal.get(s.text) ?? 0;
    ordinal.set(s.text, n + 1);
    const clip = v1?.clips.find((c) => c.start === s.start);
    const generated = s.quality === 'generated';
    const evidence: MatchEvidence[] = s.reasons.map((r) => ({ basis: 'nom' as const, detail: r, weight: 0 }));
    const conf = s.quality === 'strong' ? 0.6 : s.quality === 'weak' ? 0.2 : 0;
    const chosen: DecisionCandidate = { mediaId: clip?.mediaId ?? s.mediaId, label: clip?.name ?? (s.mediaId ? 'média' : 'visuel manquant'), score: 0, confidence: conf, evidence, generated };
    return {
      id: decisionId('visuel', s.text, n),
      kind: 'visuel',
      anchor: { beat: s.beat, ordinal: n, text: s.text, textHash: textHash(s.text), start: s.start, end: s.end },
      clipIds: clip ? [clip.id] : [],
      chosen,
      candidates: [chosen],
      criteria: ['version antérieure à l’EDG : décision reconstituée depuis le rapport de production'],
      confidence: conf,
      deps: [`phrase:${textHash(s.text)}`, ...(chosen.mediaId ? [`media:${chosen.mediaId}`] : [])],
      state: 'proposée',
      author: 'auto',
      rejected: [],
      history: [{ at: p.generatedAt, action: 'créée', by: 'auto', detail: 'reconstituée à la migration du projet' }],
    };
  });
  return { version: EDG_VERSION, createdAt: p.generatedAt, decisions };
}

/**
 * After automatic fixes (merged repeats, extended stills) some clips of the graph no longer exist:
 * each decision is re-bound to the clip of the same track kind that now covers its start. Unlike
 * reconcileGraph this is not a user action and changes no state.
 */
export function rebindGraph(seq: Sequence) {
  const g = seq.production?.edg;
  if (!g) return;
  const ids = new Set(seq.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  for (const d of g.decisions) {
    if (!d.clipIds.length || d.clipIds.every((id) => ids.has(id))) continue;
    const kind = d.kind === 'visuel' ? 'video' : 'audio';
    const tracks = seq.tracks.filter((t) => t.kind === kind);
    const track = d.kind === 'visuel' ? tracks[0] : tracks[1];
    const c = track?.clips.find((x) => x.start <= d.anchor.start && x.start + x.duration > d.anchor.start);
    d.clipIds = d.clipIds.filter((id) => ids.has(id));
    if (c && !d.clipIds.includes(c.id)) d.clipIds.push(c.id);
  }
}
