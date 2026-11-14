/**
 * P-CORE V2 Cinematic Expression Library. An expression is not a canned animation: it is a pose
 * (target values for every layer) shaped over its progress u ∈ [0,1], scaled by an intensity and
 * varied by a variant number, with entry/exit envelopes. The animation engine blends several
 * expressions over the continuous base and follows the result with springs (inertia).
 */

/** Target values of the renderer parameters (all layers). Angles in radians, speeds in rad/s. */
export interface Pose {
  // core
  coreGlow: number;
  edge: number;
  scale: number;
  fragment: number;
  tiltX: number;
  spinY: number;
  // inner structure
  innerReveal: number;
  innerPulse: number;
  innerSpin: number;
  // orbital system
  orbSpread: number;
  orbTilt: number;
  orbSpin: number;
  orbOpacity: number;
  // energy field
  energyDensity: number;
  energyFlow: number;
  swirl: number;
  // atmosphere
  halo: number;
  shafts: number;
  haze: number;
  /** Concentration: periphery dims, the core leads (0..1). */
  focus: number;
}

export const POSE_KEYS = ['coreGlow', 'edge', 'scale', 'fragment', 'tiltX', 'spinY', 'innerReveal', 'innerPulse', 'innerSpin', 'orbSpread', 'orbTilt', 'orbSpin', 'orbOpacity', 'energyDensity', 'energyFlow', 'swirl', 'halo', 'shafts', 'haze', 'focus'] as const satisfies readonly (keyof Pose)[];

export type ExpressionId =
  | 'dormant'
  | 'awakening'
  | 'active'
  | 'deep-focus'
  | 'energy-expansion'
  | 'orbital-motion'
  | 'fragmentation'
  | 'reconstruction'
  | 'revelation'
  | 'cinematic-transition'
  | 'silence'
  | 'final-stabilization';

export interface ExpressionDef {
  id: ExpressionId;
  label: string;
  description: string;
  /** Default and allowed durations (s). */
  duration: { default: number; min: number; max: number };
  /** Entry / exit envelope lengths (fraction of the duration). */
  entry: number;
  exit: number;
  /** Spectacular expressions are spaced by the director (narrative.spectacularGap). */
  spectacular: boolean;
  /** Blend priority: higher wins when two expressions overlap. */
  priority: number;
  /** When the director may choose it (French, shown in the interface). */
  when: string;
  /** Relative GPU cost (particles, overdraw) for the performance panel. */
  cost: number;
  /** Number of variants (deterministic). */
  variants: number;
  /** Full turns of the core over the expression (per variant; 0 = none). */
  turns?: (variant: number) => number;
  /** Pose at progress u for intensity I (0..1.5) and variant v. Only the keys it changes. */
  pose: (u: number, I: number, v: number) => Partial<Pose>;
  /** One-shot energy waves emitted at these progress points (per variant). */
  waves?: (variant: number) => number[];
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const bell = (u: number, c: number, w: number) => Math.exp(-(((u - c) / w) ** 2));

export const BASE_POSE: Pose = { coreGlow: 0.35, edge: 0.35, scale: 0.97, fragment: 0, tiltX: 0.05, spinY: 0, innerReveal: 0.35, innerPulse: 0.1, innerSpin: 0.02, orbSpread: 0.55, orbTilt: 0.35, orbSpin: 0.08, orbOpacity: 0.55, energyDensity: 0.25, energyFlow: 0, swirl: 0.15, halo: 0.35, shafts: 0.1, haze: 0.2, focus: 0 };

export const EXPRESSIONS: Record<ExpressionId, ExpressionDef> = {
  dormant: {
    id: 'dormant', label: 'Noyau en veille', description: 'Lueur faible qui respire lentement, anneaux rapprochés et presque immobiles.',
    duration: { default: 3, min: 1, max: 30 }, entry: 0.3, exit: 0.3, spectacular: false, priority: 1, when: 'avant la première phrase, ou après un long silence', cost: 0.3, variants: 1,
    pose: (u, I) => ({ coreGlow: 0.15 + 0.05 * Math.sin(u * Math.PI * 2), edge: 0.2, scale: 0.94, innerReveal: 0.1, innerPulse: 0.05, orbSpread: 0.25, orbSpin: 0.03, orbOpacity: 0.25 * I, energyDensity: 0.08, halo: 0.18, shafts: 0, haze: 0.12, swirl: 0.05 }),
  },
  awakening: {
    id: 'awakening', label: 'Éveil', description: 'L’arête s’allume, la structure interne se dessine, puis les orbites s’ouvrent une à une.',
    duration: { default: 2.6, min: 1.2, max: 6 }, entry: 0.05, exit: 0.25, spectacular: false, priority: 3, when: 'introduction : premières secondes de la narration', cost: 0.6, variants: 2,
    pose: (u, I, v) => ({ coreGlow: 0.15 + 0.55 * ease(u / 0.6) * I, edge: 0.2 + 0.7 * ease(u / 0.35), innerReveal: ease((u - 0.15) / 0.5), orbSpread: 0.25 + 0.45 * ease((u - 0.35) / 0.5), orbOpacity: 0.25 + 0.5 * ease((u - 0.3) / 0.5), energyDensity: 0.08 + 0.35 * ease((u - 0.5) / 0.4), halo: 0.2 + 0.4 * ease(u), scale: 0.94 + 0.06 * ease(u), tiltX: v ? 0.25 * (1 - ease(u)) : 0.05 }),
    waves: (v) => (v ? [0.55] : [0.4]),
  },
  active: {
    id: 'active', label: 'Noyau actif', description: 'Le noyau suit la voix : lueur et orbites portées par l’énergie de la parole, sans agitation.',
    duration: { default: 4, min: 1, max: 60 }, entry: 0.2, exit: 0.2, spectacular: false, priority: 1, when: 'pendant la parole (état de base)', cost: 0.5, variants: 1,
    pose: (_u, I) => ({ coreGlow: 0.55 * I, edge: 0.5, innerReveal: 0.6, innerPulse: 0.3, orbSpread: 0.65, orbSpin: 0.18, orbOpacity: 0.7, energyDensity: 0.45, swirl: 0.25, halo: 0.45, shafts: 0.2, haze: 0.25 }),
  },
  'deep-focus': {
    id: 'deep-focus', label: 'Concentration', description: 'Les orbites se resserrent, la périphérie s’assombrit, la structure interne s’éclaire : l’attention va au noyau.',
    duration: { default: 4, min: 1.5, max: 20 }, entry: 0.25, exit: 0.25, spectacular: false, priority: 2, when: 'explication, analyse, question', cost: 0.4, variants: 3,
    pose: (u, I, v) => ({ coreGlow: 0.6 * I, edge: 0.75, innerReveal: 1, innerPulse: 0.5, innerSpin: 0.05, orbSpread: 0.35, orbSpin: 0.06, orbOpacity: 0.45, orbTilt: v === 1 ? 0.6 + 0.15 * Math.sin(u * Math.PI) : 0.25, energyDensity: 0.2, swirl: 0.1, halo: 0.3, shafts: 0.05, focus: 0.75, tiltX: v === 2 ? 0.12 * Math.sin(u * Math.PI) : 0 }),
  },
  'energy-expansion': {
    id: 'energy-expansion', label: 'Expansion d’énergie', description: 'Une onde part du noyau, les orbites s’écartent et le champ se densifie, puis tout revient.',
    duration: { default: 2.4, min: 1.2, max: 5 }, entry: 0.1, exit: 0.35, spectacular: true, priority: 4, when: 'montée en intensité, « mais ce n’est pas tout », opposition marquée', cost: 1, variants: 3,
    pose: (u, I, v) => ({ coreGlow: 0.6 + 0.4 * bell(u, 0.3, 0.25) * I, edge: 0.85, orbSpread: 0.65 + 0.35 * bell(u, 0.35 + 0.1 * v, 0.3) * I, orbSpin: 0.2 + 0.4 * bell(u, 0.35, 0.3), orbOpacity: 0.8, energyDensity: 0.5 + 0.5 * bell(u, 0.35, 0.3) * I, energyFlow: 0.9 * bell(u, 0.3, 0.3), swirl: 0.4, halo: 0.6 + 0.4 * bell(u, 0.3, 0.25), shafts: 0.4 + 0.4 * bell(u, 0.3, 0.3), scale: 1 + 0.05 * bell(u, 0.3, 0.2) * I }),
    waves: (v) => (v === 2 ? [0.2, 0.45] : [0.25 + 0.05 * v]),
  },
  'orbital-motion': {
    id: 'orbital-motion', label: 'Mouvement orbital', description: 'Les anneaux basculent sur leurs plans et accélèrent ; le noyau pivote légèrement.',
    duration: { default: 3.5, min: 1.5, max: 10 }, entry: 0.25, exit: 0.3, spectacular: false, priority: 2, when: 'présentation d’un personnage, contexte, énumération', cost: 0.6, variants: 3,
    pose: (u, I, v) => ({ coreGlow: 0.55, edge: 0.6, orbSpread: 0.75, orbTilt: 0.35 + 0.5 * Math.sin(u * Math.PI) * (v === 2 ? -1 : 1), orbSpin: 0.25 + 0.35 * Math.sin(u * Math.PI) * I, orbOpacity: 0.85, energyDensity: 0.4, swirl: 0.5, halo: 0.45, shafts: 0.2, spinY: v === 1 ? 0.25 * Math.sin(u * Math.PI) : 0, tiltX: v === 0 ? 0.12 * Math.sin(u * Math.PI) : 0 }),
  },
  fragmentation: {
    id: 'fragmentation', label: 'Fragmentation', description: 'Le logo se sépare en éclats qui s’écartent en tournant ; le noyau d’énergie reste visible.',
    duration: { default: 1.6, min: 0.8, max: 4 }, entry: 0.15, exit: 0.1, spectacular: true, priority: 5, when: 'avant une reconstruction (changement de partie)', cost: 0.8, variants: 2,
    pose: (u, I) => ({ fragment: ease(u / 0.8) * Math.min(1, 0.7 + 0.3 * I), coreGlow: 0.8, edge: 0.3, innerReveal: 1, innerPulse: 0.8, energyDensity: 0.7, energyFlow: 0.5, halo: 0.6, orbSpread: 0.85, orbOpacity: 0.7 }),
  },
  reconstruction: {
    id: 'reconstruction', label: 'Reconstruction', description: 'Les éclats reviennent exactement à leur place ; l’arête se rallume quand le logo est entier.',
    duration: { default: 1.8, min: 0.8, max: 4 }, entry: 0.0, exit: 0.2, spectacular: true, priority: 5, when: 'après une fragmentation, au début d’une nouvelle partie', cost: 0.8, variants: 2,
    pose: (u, _I, v) => ({ fragment: 1 - ease(u / 0.75), coreGlow: 0.7, edge: 0.3 + 0.6 * ease((u - 0.7) / 0.3), innerReveal: 1, energyDensity: 0.55, energyFlow: -0.7 * (1 - u), halo: 0.55, orbSpread: 0.75, orbOpacity: 0.75, spinY: v ? 0.4 * (1 - u) : 0 }),
    waves: () => [0.8],
  },
  revelation: {
    id: 'revelation', label: 'Révélation', description: 'Tension (le noyau se contracte), puis déploiement : rayons de lumière, onde, demi-tour ou tour complet selon la variante.',
    duration: { default: 3, min: 1.8, max: 6 }, entry: 0.08, exit: 0.3, spectacular: true, priority: 6, when: 'révélation, « en réalité », « et c’est là que tout change »', cost: 1.2, variants: 3,
    turns: (v) => (v === 1 ? 0 : 1),
    pose: (u, I, v) => {
      const pre = u < 0.3 ? ease(u / 0.3) : 1;
      const burst = bell(u, 0.42, 0.18);
      return { scale: 1 - 0.06 * pre * (1 - ease((u - 0.3) / 0.1)) + 0.08 * burst * I, coreGlow: 0.5 + 0.5 * burst + 0.2 * (u > 0.3 ? 1 : 0), edge: 1, innerReveal: 1, innerPulse: 0.6 + 0.4 * burst, orbSpread: 0.4 + 0.6 * ease((u - 0.3) / 0.25) * I, orbOpacity: 0.9, orbSpin: 0.2 + 0.5 * burst, energyDensity: 0.4 + 0.6 * burst * I, energyFlow: burst, swirl: 0.3 + 0.4 * burst, halo: 0.5 + 0.5 * burst, shafts: 0.3 + 0.7 * burst * I, haze: 0.3 + 0.3 * burst, focus: u < 0.3 ? 0.5 * pre : 0, fragment: v === 1 ? 0.55 * bell(u, 0.45, 0.15) : 0 };
    },
    waves: (v) => (v === 1 ? [0.42, 0.6] : [0.42]),
  },
  'cinematic-transition': {
    id: 'cinematic-transition', label: 'Transition cinématique', description: 'Rotation accélérée et balayage de lumière qui ponctue un changement de partie, puis stabilisation.',
    duration: { default: 1.8, min: 1, max: 4 }, entry: 0.1, exit: 0.3, spectacular: false, priority: 4, when: 'changement de section (quand une fragmentation serait de trop)', cost: 0.7, variants: 2,
    turns: (v) => (v ? 1 : 0),
    pose: (u, I, v) => ({ orbSpin: 0.3 + 0.9 * bell(u, 0.4, 0.3) * I, orbTilt: v ? 0.7 * bell(u, 0.45, 0.3) : 0.35, orbSpread: 0.7, shafts: 0.5 * bell(u, 0.4, 0.2), coreGlow: 0.6, edge: 0.8, energyFlow: 0.4 * bell(u, 0.4, 0.3), swirl: 0.6 * bell(u, 0.4, 0.3), halo: 0.5 }),
  },
  silence: {
    id: 'silence', label: 'Silence', description: 'Pendant une pause : les orbites ralentissent, la lueur baisse sans s’éteindre ; le noyau attend.',
    duration: { default: 1.5, min: 0.6, max: 10 }, entry: 0.3, exit: 0.3, spectacular: false, priority: 2, when: 'pause de la voix de plus d’une seconde', cost: 0.3, variants: 1,
    pose: () => ({ coreGlow: 0.3, edge: 0.4, orbSpin: 0.05, orbSpread: 0.5, energyDensity: 0.18, energyFlow: -0.15, swirl: 0.1, halo: 0.3, shafts: 0.05, innerPulse: 0.1 }),
  },
  'final-stabilization': {
    id: 'final-stabilization', label: 'Stabilisation finale', description: 'Conclusion : l’activité décroît, les orbites se referment, le logo reste net et lumineux.',
    duration: { default: 3, min: 1.5, max: 8 }, entry: 0.2, exit: 0.0, spectacular: false, priority: 3, when: 'conclusion, dernières secondes', cost: 0.4, variants: 1,
    pose: (u) => ({ coreGlow: 0.6 - 0.25 * ease(u), edge: 0.7, orbSpread: 0.6 - 0.25 * ease(u), orbSpin: 0.12 * (1 - u) + 0.03, orbOpacity: 0.7 - 0.3 * ease(u), energyDensity: 0.35 * (1 - ease(u)) + 0.08, energyFlow: -0.3 * (1 - u), halo: 0.45 - 0.15 * ease(u), shafts: 0.15 * (1 - u), focus: 0.3 * ease(u), scale: 1 - 0.02 * ease(u) }),
  },
};

export const EXPRESSION_LIST = Object.values(EXPRESSIONS);

/** Weight of an expression at progress u (entry/exit envelopes, smooth). */
export function envelope(def: ExpressionDef, u: number): number {
  if (u < 0 || u > 1) return 0;
  const a = def.entry > 0 ? ease(u / def.entry) : 1;
  const b = def.exit > 0 ? ease((1 - u) / def.exit) : 1;
  return Math.min(a, b);
}
