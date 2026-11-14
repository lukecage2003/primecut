/**
 * P-CORE V2 configuration: the five visual layers, identity / animation / narrative settings, the
 * presets (each one really changes the engine), and the per-quality budgets. Pure data.
 */
import type { PCoreQuality } from '../quality';

export type LayerId = 'core' | 'inner' | 'orbital' | 'energy' | 'atmosphere' | 'hud';
export const LAYERS: { id: LayerId; label: string; role: string }[] = [
  { id: 'core', label: 'Noyau', role: 'le logo Primestone, extrudé, métal or, arêtes lumineuses' },
  { id: 'inner', label: 'Structure interne', role: 'architecture géométrique derrière le logo (anneaux concentriques, rayons, circuits)' },
  { id: 'orbital', label: 'Système orbital', role: 'anneaux 3D sur plusieurs plans, arcs, graduations' },
  { id: 'energy', label: 'Champ d’énergie', role: 'particules organisées en coques et spirales, ondes de propagation' },
  { id: 'atmosphere', label: 'Atmosphère', role: 'halo, rayons de lumière, voile' },
  { id: 'hud', label: 'Matrice HUD', role: 'spectre circulaire de la voix, balayage, grille, réticule et lectures de données' },
];

export interface LayerConfig {
  enabled: boolean;
  /** 0..2: brightness / presence of the layer. */
  intensity: number;
}

export interface IdentityConfig {
  layers: Record<LayerId, LayerConfig>;
  /** Extrusion depth of the logo (fraction of its size). */
  depth: number;
  /** Metal look of the sides: 0 satin … 1 mirror. */
  metal: number;
  /** Luminous edges of the silhouette (0..1). */
  edge: number;
  /** Number of orbital rings (2..6). */
  rings: number;
  /** Detail of the inner structure (1..3). */
  innerDetail: number;
  colors: { gold: string; light: string; dark: string };
}

export interface AnimationConfig {
  /** Global speed of rotations and flows (0.5..1.6). */
  speed: number;
  /** Amount of 3D rotation of the core (0..1.5). */
  rotation: number;
  /** Inertia: response time of the springs (s). Higher = heavier, slower. */
  inertia: number;
  /** Particle density (0.3..1.5) before the quality budget. */
  particles: number;
  /** Blend time between expressions (s). */
  transition: number;
  /** Organic micro-motion at rest (0..1). */
  micro: number;
  /** Overall intensity of the effects (0.4..1.4). */
  intensity: number;
}

export interface NarrativeConfig {
  /** How readily the director reacts (0.3 calm … 1.6 very reactive). */
  sensitivity: number;
  /** Strength of the reactions when they happen (0.4..1.4). */
  reaction: number;
  /** Use the script / transcript when available. */
  useText: boolean;
  /** Minimum time between two spectacular expressions (s). */
  spectacularGap: number;
}

export type PresetId = 'classic' | 'cinematic' | 'cosmic' | 'minimal' | 'revelation' | 'hud';

export interface PCoreV2Settings {
  preset: PresetId;
  identity: IdentityConfig;
  animation: AnimationConfig;
  narrative: NarrativeConfig;
}

const L = (core: number, inner: number, orbital: number, energy: number, atmosphere: number, off: LayerId[] = [], hud = 0): Record<LayerId, LayerConfig> => ({
  core: { enabled: true, intensity: core },
  inner: { enabled: !off.includes('inner'), intensity: inner },
  orbital: { enabled: !off.includes('orbital'), intensity: orbital },
  energy: { enabled: !off.includes('energy'), intensity: energy },
  atmosphere: { enabled: !off.includes('atmosphere'), intensity: atmosphere },
  hud: { enabled: hud > 0, intensity: hud || 1 },
});

const COLORS = { gold: '#E8B000', light: '#FFD400', dark: '#050505' };

export const PRESETS: Record<PresetId, { label: string; description: string; settings: Omit<PCoreV2Settings, 'preset'> }> = {
  classic: {
    label: 'Primestone Classic',
    description: 'Équilibré : noyau or, anneaux sobres, champ d’énergie discret.',
    settings: {
      identity: { layers: L(1, 0.7, 0.8, 0.6, 0.6), depth: 0.13, metal: 0.8, edge: 0.5, rings: 3, innerDetail: 2, colors: COLORS },
      animation: { speed: 1, rotation: 0.6, inertia: 0.45, particles: 0.9, transition: 0.6, micro: 0.5, intensity: 1 },
      narrative: { sensitivity: 1, reaction: 1, useText: true, spectacularGap: 9 },
    },
  },
  cinematic: {
    label: 'Primestone Cinematic',
    description: 'Lent et lourd, lumière volumétrique, réactions rares mais amples.',
    settings: {
      identity: { layers: L(1.1, 0.9, 0.7, 0.5, 1.2), depth: 0.17, metal: 0.95, edge: 0.65, rings: 4, innerDetail: 3, colors: COLORS },
      animation: { speed: 0.7, rotation: 0.45, inertia: 0.8, particles: 0.7, transition: 0.9, micro: 0.35, intensity: 1.05 },
      narrative: { sensitivity: 0.75, reaction: 1.2, useText: true, spectacularGap: 14 },
    },
  },
  cosmic: {
    label: 'Primestone Cosmic',
    description: 'Orbites multiples et champ de particules dense, mouvement continu.',
    settings: {
      identity: { layers: L(1, 0.8, 1.3, 1.4, 0.9), depth: 0.12, metal: 0.75, edge: 0.55, rings: 6, innerDetail: 2, colors: { ...COLORS, light: '#FFE066' } },
      animation: { speed: 1.25, rotation: 0.8, inertia: 0.4, particles: 1.4, transition: 0.5, micro: 0.7, intensity: 1.1 },
      narrative: { sensitivity: 1.1, reaction: 1, useText: true, spectacularGap: 8 },
    },
  },
  minimal: {
    label: 'Primestone Minimal',
    description: 'Le noyau seul avec une arête lumineuse et un anneau : pour accompagner sans distraire.',
    settings: {
      identity: { layers: L(1, 0.4, 0.6, 0.3, 0.4, ['energy']), depth: 0.1, metal: 0.6, edge: 0.4, rings: 2, innerDetail: 1, colors: COLORS },
      animation: { speed: 0.8, rotation: 0.35, inertia: 0.6, particles: 0.4, transition: 0.8, micro: 0.25, intensity: 0.75 },
      narrative: { sensitivity: 0.6, reaction: 0.7, useText: true, spectacularGap: 18 },
    },
  },
  revelation: {
    label: 'Primestone Revelation',
    description: 'Très réactif : expansions, fragmentations et reconstructions marquées aux moments clés.',
    settings: {
      identity: { layers: L(1.15, 1, 1, 1.1, 1), depth: 0.15, metal: 0.9, edge: 0.8, rings: 4, innerDetail: 3, colors: COLORS },
      animation: { speed: 1.1, rotation: 1, inertia: 0.35, particles: 1.2, transition: 0.45, micro: 0.55, intensity: 1.25 },
      narrative: { sensitivity: 1.45, reaction: 1.35, useText: true, spectacularGap: 6 },
    },
  },
  hud: {
    label: 'Primestone HUD',
    description: 'Interface holographique : le logo au cœur d’une matrice de données qui analyse la voix en direct.',
    settings: {
      identity: { layers: L(1.05, 0.9, 0.85, 0.7, 0.7, [], 1), depth: 0.14, metal: 0.9, edge: 0.7, rings: 3, innerDetail: 3, colors: { gold: '#E8B000', light: '#FFD400', dark: '#050505' } },
      animation: { speed: 1, rotation: 0.5, inertia: 0.4, particles: 0.8, transition: 0.55, micro: 0.45, intensity: 1.05 },
      narrative: { sensitivity: 1.05, reaction: 1.1, useText: true, spectacularGap: 9 },
    },
  },
};

export function presetSettings(id: PresetId): PCoreV2Settings {
  return structuredClone({ preset: id, ...PRESETS[id].settings });
}

export const DEFAULT_V2: PCoreV2Settings = presetSettings('classic');

/** Merges stored (possibly partial, older) settings over the preset they name. */
export function resolveV2(s?: Partial<PCoreV2Settings> | null): PCoreV2Settings {
  const base = presetSettings(s?.preset ?? 'classic');
  if (!s) return base;
  return {
    preset: base.preset,
    identity: { ...base.identity, ...s.identity, layers: { ...base.identity.layers, ...(s.identity?.layers ?? {}) }, colors: { ...base.identity.colors, ...(s.identity?.colors ?? {}) } },
    animation: { ...base.animation, ...s.animation },
    narrative: { ...base.narrative, ...s.narrative },
  };
}

/** Per-quality budgets of the V2 scene (real differences, measured in docs/PCORE_V2.md). */
export const V2_BUDGET: Record<PCoreQuality, { particles: number; ringSegments: number; shafts: number; inner: number; bevelSegments: number; hudBars: number }> = {
  preview: { particles: 900, ringSegments: 96, shafts: 0, inner: 1, bevelSegments: 1, hudBars: 48 },
  standard: { particles: 2200, ringSegments: 160, shafts: 6, inner: 2, bevelSegments: 2, hudBars: 72 },
  high: { particles: 3600, ringSegments: 220, shafts: 9, inner: 3, bevelSegments: 3, hudBars: 96 },
  final: { particles: 5200, ringSegments: 300, shafts: 12, inner: 3, bevelSegments: 4, hudBars: 120 },
};
