/**
 * Procedural visual compositions ("Primestone Visuals"). A generator asset is an ordinary video
 * media whose file is rendered locally by the engine from this spec (no AI image generation, no
 * external service), so preview, editing and export treat it like any clip.
 */
export type VisualKind = 'audio-hud' | 'data-matrix' | 'character-card' | 'cosmic' | 'timeline' | 'dramatic' | 'typography';
export type VisualStyle = 'gold' | 'hologram' | 'crimson';

export interface GeneratorSpec {
  kind: VisualKind;
  style: VisualStyle;
  seed: number;
  title?: string;
  subtitle?: string;
  /** Timeline labels (years, steps) for 'timeline'. */
  items?: string[];
  /** Audio driving the reactive layers: media + offset (s) into it. */
  audio?: { mediaId: string; offsetSec: number };
  /** 0..1 — how strongly visuals react / how busy they are. */
  intensity: number;
  durationSec: number;
}

export const VISUAL_KINDS: { id: VisualKind; label: string }[] = [
  { id: 'audio-hud', label: 'Holographic voice HUD' },
  { id: 'data-matrix', label: 'Data matrix' },
  { id: 'character-card', label: 'Character card' },
  { id: 'cosmic', label: 'Cosmic' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'dramatic', label: 'Dramatic' },
  { id: 'typography', label: 'Kinetic typography' },
];

export const STYLE_COLORS: Record<VisualStyle, { accent: string; accent2: string; bg0: string; bg1: string }> = {
  gold: { accent: 'FFC400', accent2: 'FF8A00', bg0: '07070A', bg1: '1C1608' },
  hologram: { accent: '5CE1FF', accent2: 'FFC400', bg0: '04080C', bg1: '0A1A24' },
  crimson: { accent: 'FF4A3D', accent2: 'FFC400', bg0: '0A0506', bg1: '240A0A' },
};

/** Stable short hash for cache file names. */
export function specHash(spec: GeneratorSpec, w: number, h: number, fps: string): string {
  const s = JSON.stringify([spec, w, h, fps]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

/** Deterministic pseudo-random in [0,1) from a seed and a salt. */
export function rand(seed: number, salt: number): number {
  const x = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
