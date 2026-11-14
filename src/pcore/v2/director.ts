/**
 * P-CORE V2 Evolution Director: decides WHICH expression, WHEN, HOW LONG and HOW STRONG, from the
 * voice (always) and the text (when a script or transcript is aligned), with a memory of what it
 * already did. It does not fire every effect it could: it spaces spectacular moments, varies
 * repeated expressions, caps the density, and leaves the user's locked or edited cues untouched.
 * Pure and deterministic.
 */
import type { VoiceFrame } from '../audio';
import { textHash } from '../../core/edg';
import type { PCoreV2Settings } from './config';
import { EXPRESSIONS, type ExpressionId } from './expressions';
import { type NarrativeSentence, readNarration, CATEGORY_LABEL } from './narrative';

export type CueState = 'proposée' | 'acceptée' | 'verrouillée' | 'désactivée';

export interface PCoreCue {
  /** Stable id: same passage (or same moment of an audio-only narration) → same id. */
  id: string;
  expression: ExpressionId;
  start: number;
  duration: number;
  /** 0..1.5 */
  intensity: number;
  variant: number;
  reasons: string[];
  source: 'auto' | 'utilisateur';
  state: CueState;
}

export interface CueEdit {
  id: string;
  /** The automatic proposal before the first edit (to restore it). */
  original?: PCoreCue;
  expression?: ExpressionId;
  start?: number;
  duration?: number;
  intensity?: number;
  state?: CueState;
}

export interface DirectorInput {
  voice: VoiceFrame[];
  fps: number;
  sentences?: NarrativeSentence[];
  settings: PCoreV2Settings;
  /** The user's edits and additions from a previous plan (kept as they are). */
  edits?: CueEdit[];
  added?: PCoreCue[];
}

export interface DirectorResult {
  cues: PCoreCue[];
  /** Why candidates were dropped or changed (memory, spacing, density) — shown in the studio. */
  log: string[];
  usedText: boolean;
}

interface Candidate {
  expression: ExpressionId;
  start: number;
  duration: number;
  salience: number;
  variantHint?: number;
  reasons: string[];
  anchor: string;
  pairWith?: Candidate;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Speech segments and pauses from the voice gate. */
function speechMap(voice: VoiceFrame[], fps: number) {
  const pauses: { start: number; end: number }[] = [];
  let firstSpeech = -1;
  let lastSpeech = -1;
  let s: number | null = null;
  voice.forEach((v, i) => {
    if (v.speaking) {
      if (firstSpeech < 0) firstSpeech = i;
      lastSpeech = i;
      if (s !== null && firstSpeech < i) pauses.push({ start: s / fps, end: i / fps });
      s = null;
    } else if (s === null) s = i;
  });
  return { pauses: pauses.filter((p) => p.start > 0), firstSpeech: firstSpeech < 0 ? null : firstSpeech / fps, lastSpeech: lastSpeech < 0 ? null : lastSpeech / fps };
}

/** Rising energy: where the 3 s mean envelope climbs into the narrator's top quarter. */
function energyBuilds(voice: VoiceFrame[], fps: number): { time: number; strength: number }[] {
  const n = voice.length;
  if (n < fps * 6) return [];
  const w = Math.round(3 * fps);
  const mean: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += voice[i]!.speaking ? voice[i]!.env : 0;
    if (i >= w) acc -= voice[i - w]!.speaking ? voice[i - w]!.env : 0;
    mean.push(acc / Math.min(i + 1, w));
  }
  const sorted = [...mean].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.8)] ?? 1;
  const out: { time: number; strength: number }[] = [];
  const lag = Math.round(4 * fps);
  for (let i = lag; i < n; i++) {
    const rise = mean[i]! - mean[i - lag]!;
    // a build-up heard in the voice alone: at most one every 30 s (the text, when present, finds the others)
    if (mean[i]! >= top && rise > 0.15 && (!out.length || i / fps - out.at(-1)!.time > 30)) out.push({ time: i / fps - 1, strength: clamp(rise * 2.5, 0.3, 1) });
  }
  return out;
}

export function directPCore(input: DirectorInput): DirectorResult {
  const { voice, fps, settings } = input;
  const nar = settings.narrative;
  const total = voice.length / fps;
  const log: string[] = [];
  const cands: Candidate[] = [];
  const { pauses, firstSpeech, lastSpeech } = speechMap(voice, fps);

  // ---- opening: a sleeping core before the first word, then the awakening
  const wake = firstSpeech ?? 0;
  if (wake >= 0.8) cands.push({ expression: 'dormant', start: 0, duration: wake, salience: 1, reasons: ['aucune voix avant ' + wake.toFixed(1) + ' s : noyau en veille'], anchor: 'ouverture' });
  cands.push({ expression: 'awakening', start: Math.max(0, wake - 0.4), duration: 2.6, salience: 1, reasons: ['début de la narration : éveil'], anchor: 'éveil' });

  // ---- text: category of each sentence in context
  const useText = nar.useText && !!input.sentences?.length;
  const readings = useText ? readNarration(input.sentences!) : [];
  const sectionStarts = readings.filter((r) => r.sectionStart);
  for (const r of readings) {
    const len = Math.max(1, r.end - r.start);
    const anchor = input.sentences!.find((s) => s.index === r.index)!.text;
    const why = [`${CATEGORY_LABEL[r.category]} (confiance ${Math.round(r.confidence * 100)} %) : ${r.reasons.slice(0, 2).join(' ; ')}`];
    if (r.sectionStart) {
      // a new part: a full fragmentation/reconstruction for the strongest one, a lighter transition otherwise
      const strongest = sectionStarts.reduce((a, b) => (b.salience > a.salience ? b : a), sectionStarts[0]!);
      if (r === strongest && sectionStarts.length >= 1) {
        const frag: Candidate = { expression: 'fragmentation', start: Math.max(0, r.start - 1.3), duration: 1.3, salience: 0.7, reasons: ['nouvelle partie : décomposition'], anchor: anchor + '|frag' };
        frag.pairWith = { expression: 'reconstruction', start: r.start, duration: 1.6, salience: 0.7, reasons: ['nouvelle partie : reconstruction'], anchor: anchor + '|recon' };
        cands.push(frag);
      } else cands.push({ expression: 'cinematic-transition', start: Math.max(0, r.start - 0.6), duration: 1.6, salience: 0.5, reasons: ['nouvelle partie : transition'], anchor: anchor + '|trans' });
    }
    const map: Partial<Record<typeof r.category, [ExpressionId, number?]>> = {
      revelation: ['revelation'],
      escalade: ['energy-expansion'],
      opposition: ['orbital-motion', 2],
      question: ['deep-focus', 1],
      explication: ['deep-focus', 0],
      analyse: ['deep-focus', 2],
      presentation: ['orbital-motion', 0],
      contexte: ['orbital-motion', 1],
    };
    const m = map[r.category];
    if (!m) continue;
    const def = EXPRESSIONS[m[0]];
    const duration = clamp(m[0] === 'deep-focus' || m[0] === 'orbital-motion' ? len : def.duration.default, def.duration.min, def.duration.max);
    cands.push({ expression: m[0], start: m[0] === 'revelation' ? Math.max(0, r.start - 0.3) : r.start, duration, salience: r.salience, variantHint: m[1], reasons: why, anchor });
  }

  // ---- audio: pauses, energy builds, long continuous explanations (works without any text)
  for (const p of pauses) {
    const d = p.end - p.start;
    if (d >= 1.0) cands.push({ expression: 'silence', start: p.start, duration: d, salience: clamp(0.3 + d / 4, 0.3, 0.8), reasons: [`pause de ${d.toFixed(1)} s dans la voix`], anchor: `pause@${Math.round(p.start * 2)}` });
    if (!useText && d >= 1.6 && p.end < total - 4) cands.push({ expression: 'cinematic-transition', start: Math.max(0, p.end - 0.5), duration: 1.6, salience: 0.45, reasons: [`longue pause (${d.toFixed(1)} s) : probable changement de partie (sans texte)`], anchor: `reprise@${Math.round(p.end * 2)}` });
  }
  for (const b of energyBuilds(voice, fps)) cands.push({ expression: 'energy-expansion', start: Math.max(0, b.time), duration: 2.4, salience: 0.35 + 0.4 * b.strength, reasons: ['montée de l’énergie vocale (moyenne sur 3 s dans le quart supérieur de cette voix)'], anchor: `montée@${Math.round(b.time * 2)}` });
  if (!useText) {
    // long stretches of continuous speech get an occasional focus so the core is not static
    let last = firstSpeech ?? 0;
    for (const p of [...pauses, { start: total, end: total }]) {
      for (let t = last + 12; t < p.start - 4; t += 18) cands.push({ expression: 'deep-focus', start: t, duration: 4, salience: 0.32, reasons: ['passage parlé continu (sans texte) : concentration'], anchor: `focus@${Math.round(t * 2)}` });
      last = p.end;
    }
  }

  // ---- closing
  if (total > 6) {
    const end = lastSpeech ?? total;
    const start = Math.max(total * 0.5, Math.min(end - 1.5, total - 3.2));
    cands.push({ expression: 'final-stabilization', start, duration: Math.max(1.5, total - start), salience: 1, reasons: [readings.at(-1)?.category === 'conclusion' ? 'conclusion du script : stabilisation' : 'fin de la narration : stabilisation'], anchor: 'final' });
  }

  // ---- the user's edits and additions are fixed points
  const edits = new Map((input.edits ?? []).map((e) => [e.id, e]));
  const fixed: PCoreCue[] = [...(input.added ?? [])];

  // ---- selection with memory
  cands.sort((a, b) => a.start - b.start || b.salience - a.salience);
  // look-ahead: two spectacular moments closer than the gap → the more important one keeps its place,
  // the other is played as a lighter expression (the strongest reveal is never sacrificed to a lesser one)
  // the narrative climax (a reveal) outranks a build-up or a section change of similar importance
  const rank = (c: Candidate) => c.salience + (c.expression === 'revelation' ? 0.2 : 0);
  const spect = cands.filter((c) => EXPRESSIONS[c.expression].spectacular).sort((x, y) => rank(y) - rank(x) || x.start - y.start);
  const kept: Candidate[] = [];
  for (const c of spect) {
    const end = (x: Candidate) => (x.pairWith ? x.pairWith.start + x.pairWith.duration : x.start + x.duration);
    const rival = kept.find((o) => c.start < end(o) + nar.spectacularGap && o.start < end(c) + nar.spectacularGap);
    if (!rival) {
      kept.push(c);
      continue;
    }
    const down: ExpressionId = c.expression === 'fragmentation' ? 'cinematic-transition' : c.expression === 'revelation' ? 'deep-focus' : 'orbital-motion';
    log.push(`${EXPRESSIONS[c.expression].label} à ${c.start.toFixed(1)} s jouée en ${EXPRESSIONS[down].label} : un moment plus important (${EXPRESSIONS[rival.expression].label} à ${rival.start.toFixed(1)} s) est trop proche`);
    c.reasons = [...c.reasons, `mémoire : laisse la place à ${EXPRESSIONS[rival.expression].label.toLowerCase()} à ${rival.start.toFixed(1)} s`];
    c.expression = down;
    c.duration = Math.min(c.duration, EXPRESSIONS[down].duration.max);
    c.pairWith = undefined;
  }
  const thresholdCalm = 0.22 / Math.max(0.2, nar.sensitivity);
  const thresholdSpectacular = 0.45 / Math.max(0.2, nar.sensitivity);
  const gap = nar.spectacularGap;
  const maxPerMinute = 9 * nar.sensitivity;
  const out: PCoreCue[] = [];
  const used = new Map<ExpressionId, number>();
  let lastSpectacularEnd = -Infinity;
  let lastStart = -Infinity;
  const ids = new Map<string, number>();
  const mkId = (anchor: string, expr: ExpressionId) => {
    const base = `pc-${textHash(anchor + '|' + expr).slice(0, 10)}`;
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const always = new Set<ExpressionId>(['dormant', 'awakening', 'final-stabilization', 'silence']);
  for (const c0 of cands) {
    let c = c0;
    const def0 = EXPRESSIONS[c.expression];
    if (!always.has(c.expression)) {
      const threshold = def0.spectacular ? thresholdSpectacular : thresholdCalm;
      if (c.salience < threshold) {
        log.push(`${def0.label} à ${c.start.toFixed(1)} s ignorée : importance ${c.salience.toFixed(2)} sous le seuil (sensibilité)`);
        continue;
      }
      const recent = out.filter((x) => !always.has(x.expression) && x.start > c.start - 60).length;
      if (recent >= maxPerMinute && !(c.expression === 'revelation' && c.salience >= 0.7)) {
        log.push(`${def0.label} à ${c.start.toFixed(1)} s ignorée : déjà ${recent} réactions dans la dernière minute`);
        continue;
      }
      // a new expression may start while the previous one is still running: the previous one yields
      // (shortened, keeping a short blend) unless that would cut it below its minimum duration
      const running = out.filter((x) => !always.has(x.expression) && x.start + x.duration > c.start).at(-1);
      if (running) {
        const keep = c.start - running.start + 0.4;
        if (c.start - lastStart < 1.2 || keep < EXPRESSIONS[running.expression].duration.min) {
          log.push(`${def0.label} à ${c.start.toFixed(1)} s ignorée : ${EXPRESSIONS[running.expression].label} en cours depuis ${(c.start - running.start).toFixed(1)} s`);
          continue;
        }
        running.duration = +keep.toFixed(3);
      }
      // memory: spectacular moments are spaced; a strong reveal may still happen, smaller
      if (def0.spectacular && c.start - lastSpectacularEnd < gap) {
        if (c.expression === 'revelation' && c.salience >= 0.8 && c.start - lastSpectacularEnd >= gap / 2) {
          c = { ...c, salience: c.salience * 0.7, reasons: [...c.reasons, 'mémoire : révélation rapprochée de la précédente, jouée plus sobrement'] };
        } else {
          const down: ExpressionId = c.expression === 'fragmentation' ? 'cinematic-transition' : 'orbital-motion';
          log.push(`${def0.label} à ${c.start.toFixed(1)} s remplacée par ${EXPRESSIONS[down].label} : moment spectaculaire il y a moins de ${gap} s`);
          c = { ...c, expression: down, pairWith: undefined, duration: EXPRESSIONS[down].duration.default, reasons: [...c.reasons, `mémoire : ${def0.label.toLowerCase()} trop proche d’un autre moment fort`] };
        }
      }
      // the same expression twice in a row within 6 s adds nothing
      const prev = out.filter((x) => !always.has(x.expression)).at(-1);
      if (prev && prev.expression === c.expression && c.start - (prev.start + prev.duration) < 6 && c.salience < 0.8) {
        prev.duration = Math.min(EXPRESSIONS[c.expression].duration.max, c.start + c.duration - prev.start);
        log.push(`${EXPRESSIONS[c.expression].label} à ${c.start.toFixed(1)} s fusionnée avec la précédente (même comportement)`);
        continue;
      }
    }
    const def = EXPRESSIONS[c.expression];
    const n = used.get(c.expression) ?? 0;
    used.set(c.expression, n + 1);
    // variants rotate so two uses never look the same; a hint from the text picks the flavour first
    const variant = def.variants > 1 ? ((c.variantHint ?? 0) + n) % def.variants : 0;
    const repeatDecay = n > 0 && out.some((x) => x.expression === c.expression && c.start - x.start < 60) ? 0.85 : 1;
    const intensity = clamp((always.has(c.expression) ? 1 : 0.55 + 0.6 * c.salience) * nar.reaction * repeatDecay * settings.animation.intensity, 0.2, 1.5);
    const push = (x: Candidate, v: number) => {
      const cue: PCoreCue = { id: mkId(x.anchor, x.expression), expression: x.expression, start: +x.start.toFixed(3), duration: +clamp(x.duration, EXPRESSIONS[x.expression].duration.min, EXPRESSIONS[x.expression].duration.max).toFixed(3), intensity: +intensity.toFixed(2), variant: v, reasons: x.reasons, source: 'auto', state: 'proposée' };
      out.push(cue);
      return cue;
    };
    const cue = push(c, variant);
    if (c.pairWith) push(c.pairWith, variant);
    if (!always.has(c.expression)) lastStart = cue.start;
    if (def.spectacular) lastSpectacularEnd = (c.pairWith ? c.pairWith.start + c.pairWith.duration : cue.start + cue.duration);
  }

  // ---- apply the user's edits; disabled cues stay listed (so they can be re-enabled) but do nothing
  const final: PCoreCue[] = [];
  for (const cue of out) {
    const e = edits.get(cue.id);
    if (!e) {
      final.push(cue);
      continue;
    }
    final.push({ ...cue, ...(e.expression ? { expression: e.expression, variant: 0 } : {}), ...(e.start !== undefined ? { start: e.start } : {}), ...(e.duration !== undefined ? { duration: e.duration } : {}), ...(e.intensity !== undefined ? { intensity: e.intensity } : {}), state: e.state ?? 'acceptée', source: e.expression || e.start !== undefined || e.duration !== undefined || e.intensity !== undefined ? 'utilisateur' : cue.source, reasons: [...cue.reasons, 'modifiée par vous'] });
  }
  // locked edits whose automatic cue disappeared (text changed) are kept as the user's own
  for (const e of edits.values()) {
    if (final.some((c) => c.id === e.id) || e.state !== 'verrouillée' || !e.expression || e.start === undefined) continue;
    fixed.push({ id: e.id, expression: e.expression, start: e.start, duration: e.duration ?? EXPRESSIONS[e.expression].duration.default, intensity: e.intensity ?? 1, variant: 0, reasons: ['verrouillée par vous'], source: 'utilisateur', state: 'verrouillée' });
  }
  for (const f of fixed) {
    // a fixed cue wins: automatic proposals overlapping it are dropped (not the base states)
    for (let i = final.length - 1; i >= 0; i--) {
      const c = final[i]!;
      if (c.source === 'auto' && c.state === 'proposée' && !always.has(c.expression) && c.start < f.start + f.duration && f.start < c.start + c.duration) {
        log.push(`${EXPRESSIONS[c.expression].label} à ${c.start.toFixed(1)} s retirée : chevauche votre réaction ${EXPRESSIONS[f.expression].label}`);
        final.splice(i, 1);
      }
    }
    final.push(f);
  }
  final.sort((a, b) => a.start - b.start);
  return { cues: final, log, usedText: useText };
}
