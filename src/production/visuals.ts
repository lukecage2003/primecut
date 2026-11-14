/**
 * Visual decision for shots without a specific illustration.
 *
 * Priority (brief): 1 relevant media → 2 legally usable media found by search → 3 explanatory
 * motion design → 4 audio-reactive holographic visual → 5 typographic composition.
 * Steps 1–2 happen in media matching (step 2 is reported as unavailable until web providers
 * exist); this module covers 3–5, choosing a composition from the passage's content and
 * varying style/seed so consecutive generated shots never look identical.
 */
import type { GeneratorSpec, VisualKind, VisualStyle } from '../core/generators';
import type { EntityIndex } from './entities';
import type { Beat } from './planner';
import { normalize } from './text';

const KW: Record<'tech' | 'cosmic' | 'drama' | 'time', RegExp> = {
  tech: /\b(intelligence artificielle|ia|ordinateur|donnees|programme|robot|androide|ultron|jarvis|vision|technologie|armure|code|algorithme|machine|cyber|virus|reseau|systeme)\b/,
  cosmic: /\b(cosmique|cosmos|univers|galaxie|galactique|espace|etoile|planete|multivers|dimension|celeste|celestes|infini|eternite|galactus|thanos|surfer|big bang|realite)\b/,
  drama: /\b(mort|meurt|tue|tuer|tragedie|tragique|sacrifice|trahison|trahit|guerre|bataille|massacre|drame|choc|fin|perd|perdu|detruit|destruction)\b/,
  time: /\b(chronologie|annee|annees|decennie|epoque|siecle|ensuite|puis|avant|apres|origine|debut|premiere apparition|histoire de)\b/,
};

export interface VisualDecision {
  spec: Omit<GeneratorSpec, 'audio' | 'durationSec'>;
  reason: string;
  /** Which priority level was used (3 = explanatory motion design, 4 = audio-reactive, 5 = typography). */
  level: 3 | 4 | 5;
}

export interface VisualContext {
  index: EntityIndex;
  previous: VisualKind | null;
  shotIndex: number;
  /** Seconds of speech inside the shot (low = pause / breath). */
  speechSec: number;
  durationSec: number;
  style: VisualStyle;
  /** Subtitles are burned in: never repeat the narration's words inside a composition (double text). */
  subtitles?: boolean;
  /** A section title is centred on screen during this shot: no text-bearing composition under it. */
  titleOnScreen?: boolean;
  /** Names already presented by a card recently: not presented again so soon (no repetition). */
  recentCards?: ReadonlySet<string>;
  /** Presenter mode: P-CORE leads; backgrounds are ambient and carry no text. */
  presenter?: boolean;
}

export function yearsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\b(1[89]\d\d|20\d\d)\b/g)].map((m) => m[1]!))].sort();
}

export function decideVisual(beat: Beat, ctx: VisualContext): VisualDecision {
  const t = normalize(beat.text);
  const seed = ctx.shotIndex * 7 + beat.index * 13 + 1;
  const firstWords = beat.text.split(/\s+/).slice(0, 9).join(' ').replace(/[,;:]$/, '');
  const candidates: VisualDecision[] = [];
  if (beat.onScreen?.length) {
    candidates.push({ level: 5, reason: 'texte à l’écran demandé par le script', spec: { kind: 'typography', style: ctx.style, seed, title: beat.onScreen[0]!.slice(0, 90), intensity: 0.5 } });
  }
  const source = beat.sources?.[0]?.replace(/\s+/g, ' ').slice(0, 60);
  const people = beat.entities.filter((e) => e.entityId && (e.kind === 'character' || e.kind === 'team'));
  // names specific to this script (not in the curated base) get a neutral reference card
  const local = beat.entities.filter((e) => e.entityId?.startsWith('script:') && e.kind === 'concept');
  const years = yearsIn(beat.text);
  if (people.length) {
    const e = people[0]!;
    const entry = ctx.index.get(e.entityId!);
    const pub = entry?.publisher ? ctx.index.get(entry.publisher)?.name : undefined;
    const kindLabel = e.kind === 'team' ? 'Équipe' : 'Personnage';
    candidates.push({ level: 3, reason: `présente ${e.name}`, spec: { kind: 'character-card', style: ctx.style, seed, title: e.name, subtitle: source ?? [pub, kindLabel].filter(Boolean).join(' · '), intensity: 0.6 } });
  }
  if (!people.length && local.length) {
    const e = local[0]!;
    candidates.push({ level: 3, reason: `présente ${e.name}`, spec: { kind: 'character-card', style: ctx.style, seed, title: e.name, subtitle: source ?? 'Référence', intensity: 0.6 } });
  }
  if (years.length >= 2 || (years.length === 1 && KW.time.test(t))) {
    candidates.push({ level: 3, reason: `chronologie ${years.join(' → ')}`, spec: { kind: 'timeline', style: ctx.style, seed, items: years, title: beat.entities.find((x) => x.entityId)?.name, intensity: 0.5 } });
  }
  if (KW.cosmic.test(t) || beat.entities.some((e) => ['galactus', 'thanos', 'silver-surfer', 'multiverse'].includes(e.entityId ?? ''))) {
    candidates.push({ level: 3, reason: 'sujet cosmique', spec: { kind: 'cosmic', style: ctx.style, seed, intensity: 0.7 } });
  }
  if (KW.tech.test(t)) {
    candidates.push({ level: 3, reason: 'sujet technologie / IA', spec: { kind: 'data-matrix', style: 'hologram', seed, title: beat.entities.find((x) => x.entityId)?.name, intensity: 0.7 } });
  }
  if (KW.drama.test(t) || /!\s*$/.test(beat.text.trim())) {
    candidates.push({ level: 4, reason: 'passage dramatique', spec: { kind: 'dramatic', style: 'crimson', seed, intensity: 0.9 } });
  }
  // the first words of the narration as a big card only when they are NOT also subtitled (double text)
  if (!ctx.subtitles && ctx.speechSec < Math.min(1.2, ctx.durationSec * 0.35) && firstWords.length > 8) {
    candidates.push({ level: 5, reason: 'pause / phrase clé', spec: { kind: 'typography', style: ctx.style, seed, title: firstWords, intensity: 0.4 } });
  }
  candidates.push({ level: 4, reason: 'pas d’illustration : visuel réactif à la voix', spec: { kind: 'audio-hud', style: ctx.style, seed, intensity: 0.7 } });
  // a second text-free fallback so two shots in a row never repeat the same composition
  candidates.push({ level: 4, reason: 'pas d’illustration : matrice de données (sans texte)', spec: { kind: 'data-matrix', style: ctx.style === 'hologram' ? 'gold' : 'hologram', seed, intensity: 0.5 } });
  // a centred section title must not sit on top of another text (cards, timelines, typography)
  const TEXT_KINDS = new Set(['typography', 'character-card', 'timeline', 'data-matrix']);
  if (ctx.presenter) {
    const AMBIENT = new Set(['audio-hud', 'cosmic', 'data-matrix', 'dramatic']);
    const amb = candidates.filter((c) => AMBIENT.has(c.spec.kind)).map((c) => ({ ...c, spec: { ...c.spec, title: undefined, intensity: Math.min(0.6, c.spec.intensity ?? 0.5) } }));
    const pickA = amb.find((c) => c.spec.kind !== ctx.previous) ?? amb[0]!;
    return { ...pickA, reason: `${pickA.reason} (fond d’ambiance : P-CORE présente)` };
  }
  const fresh = candidates.filter((c) => !(c.spec.kind === 'character-card' && c.spec.title && ctx.recentCards?.has(c.spec.title.toLowerCase())));
  const allowed0 = fresh.length ? fresh : candidates;
  const allowed = ctx.titleOnScreen
    ? allowed0.filter((c) => !TEXT_KINDS.has(c.spec.kind) || c.spec.kind === 'data-matrix').map((c) => (c.spec.kind === 'data-matrix' ? { ...c, spec: { ...c.spec, title: undefined } } : c))
    : allowed0;
  // anti-repetition: avoid the same composition twice in a row when an alternative exists
  const pick = allowed.find((c) => c.spec.kind !== ctx.previous) ?? allowed[0] ?? candidates[0]!;
  if (pick.spec.kind === ctx.previous) pick.spec.style = pick.spec.style === 'gold' ? 'hologram' : 'gold';
  return pick;
}
