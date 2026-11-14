/**
 * Production preferences and how they adapt.
 *
 * This is *parameter adaptation*, not model training: after the user edits a generated cut,
 * measurable choices (shot length, motion types, dissolves, music level, caption use) are compared
 * with what was generated and the preferences move toward them with an exponential moving
 * average. Every adaptation is stored as a new version so any change can be reverted.
 */
import type { MotionKind } from '../core/model';

export interface ProductionPreferences {
  version: number;
  /** Shot length in seconds. */
  shotMin: number;
  shotTarget: number;
  shotMax: number;
  motionAmount: number;
  motionWeights: Record<Exclude<MotionKind, 'none' | 'panels'>, number>;
  /** Read comic pages panel by panel when panels are detected and the shot is long enough. */
  panelReading: boolean;
  /** Fill shots without a relevant illustration with procedural compositions (never a black screen). */
  proceduralVisuals: boolean;
  /** P-CORE presence: off, only where there is no illustration ('hero'), or always (discreet over pictures). */
  pcore: 'off' | 'hero' | 'always';
  visualStyle: 'gold' | 'hologram' | 'crimson';
  /** Seconds spent per panel. */
  secondsPerPanel: number;
  /** Dissolve between sections (frames); 0 = hard cut. */
  sectionDissolveFrames: number;
  /** Share of in-section cuts that get a short dissolve (0..1). */
  dissolveShare: number;
  subtitles: boolean;
  sectionTitles: boolean;
  lowerThirds: boolean;
  /** Music bed level relative to narration while the narrator speaks (dB). */
  musicRelativeDb: number;
  /** Extra attenuation of the music under the voice (automatic ducking, dB, ≤ 0; 0 = off).
   *  Between sentences the music rises by this amount. */
  duckDepthDb: number;
  /** Procedural sound effects (whoosh on section changes, impact under titles). */
  sfx: boolean;
  /** SFX clip gain (dB). */
  sfxDb: number;
  narrationLufs: number;
  /** Clean the narration (hum, rumble, noise, sibilance, level) into a derived copy, from measurements. */
  voiceCleanup: boolean;
  /** Adapt pacing and cards to the detected narration format (ranking, recap, Short…). */
  autoDirection: boolean;
  /** Shorten long pauses of the narration (derived copy; off by default). */
  tightenPauses: boolean;
  /** Remove hesitations ("euh") and immediate repetitions found in the transcript (derived copy; off by default). */
  cutDisfluencies: boolean;
  /** A media item is not reused within this many shots when alternatives exist. */
  avoidRepeatWithin: number;
  /** Place pictures with no relation at all to the passage (off: compositions or placeholders instead). */
  fillUnrelated: boolean;
  /** Choose the music per section from the local music library (when no track is imposed). */
  musicFromLibrary: boolean;
  /** Regeneration keeps the proposals of passages whose text did not change. */
  keepUnchanged: boolean;
  /** Below this confidence (0..1) an automatic choice is listed for review. */
  reviewThreshold: number;
  /** Faceless videos without pictures: P-CORE stays central and continuous, calm backgrounds, names as
   *  name cards, chapter titles in the P-CORE data matrix (no back-and-forth to a corner). */
  presenter: boolean;
  /** With pictures: P-CORE is a discreet animated badge (one continuous clip in a corner), never in the way. */
  pcoreBadge: boolean;
  /** Opt-in: search freely licensed pictures on the Internet when the library lacks them (sends search words only). */
  webImages: boolean;
  /** Story mode: the pages of a comic book follow the narration in reading order ('auto': when books are most of the pictures). */
  storyOrder: 'auto' | 'on' | 'off';
  /** Voice processing: corrective cleanup only, or a broadcast ("radio") voice. */
  voiceStyle: 'natural' | 'radio';
}

export const DEFAULT_PREFERENCES: ProductionPreferences = {
  version: 1,
  shotMin: 2.5,
  shotTarget: 4.5,
  shotMax: 8,
  motionAmount: 0.12,
  motionWeights: { 'zoom-in': 3, 'zoom-out': 2, 'pan-left': 1, 'pan-right': 1, 'pan-up': 0.5, 'pan-down': 0.5 },
  panelReading: true,
  proceduralVisuals: true,
  pcore: 'hero',
  visualStyle: 'gold',
  secondsPerPanel: 1.8,
  sectionDissolveFrames: 15,
  dissolveShare: 0,
  subtitles: true,
  sectionTitles: true,
  lowerThirds: true,
  musicRelativeDb: -20,
  duckDepthDb: -8,
  sfx: true,
  sfxDb: -10,
  narrationLufs: -16,
  voiceCleanup: true,
  autoDirection: true,
  tightenPauses: false,
  cutDisfluencies: true,
  avoidRepeatWithin: 4,
  fillUnrelated: false,
  musicFromLibrary: true,
  keepUnchanged: true,
  reviewThreshold: 0.45,
  presenter: true,
  pcoreBadge: true,
  webImages: false,
  storyOrder: 'auto',
  voiceStyle: 'radio',
};

/** Observable style of an edit (generated or user-modified). */
export interface EditStyle {
  shots: number;
  meanShotSec: number;
  motionCounts: Partial<Record<MotionKind, number>>;
  dissolves: number;
  cuts: number;
  musicRelativeDb: number | null;
  /** Number of SFX clips kept (null = SFX track absent). */
  sfxClips?: number | null;
  /** Ducking depth on the music track (null = no music / no ducking). */
  duckDepthDb?: number | null;
  subtitles: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function adaptPreferences(prefs: ProductionPreferences, generated: EditStyle, edited: EditStyle, alpha = 0.35): { prefs: ProductionPreferences; changes: string[] } {
  const next: ProductionPreferences = structuredClone(prefs);
  const changes: string[] = [];
  if (edited.shots >= 3 && generated.meanShotSec > 0) {
    const ratio = edited.meanShotSec / generated.meanShotSec;
    if (Math.abs(ratio - 1) > 0.05) {
      const target = clamp(prefs.shotTarget * (1 + alpha * (ratio - 1)), 1.5, 15);
      changes.push(`shot length ${prefs.shotTarget.toFixed(2)}s → ${target.toFixed(2)}s`);
      const k = target / prefs.shotTarget;
      next.shotTarget = target;
      next.shotMin = clamp(prefs.shotMin * k, 1, target);
      next.shotMax = clamp(prefs.shotMax * k, target, 30);
    }
  }
  const kinds = Object.keys(next.motionWeights) as (keyof ProductionPreferences['motionWeights'])[];
  const totalEdited = kinds.reduce((a, k) => a + (edited.motionCounts[k] ?? 0), 0);
  const totalGen = kinds.reduce((a, k) => a + (generated.motionCounts[k] ?? 0), 0);
  const noneEdited = edited.motionCounts.none ?? 0;
  const noneGen = generated.motionCounts.none ?? 0;
  if (totalEdited + noneEdited >= 3) {
    const sumW = kinds.reduce((a, x) => a + prefs.motionWeights[x], 0);
    for (const k of kinds) {
      // move weights by the difference between what the user kept and what was generated
      const share = totalEdited ? (edited.motionCounts[k] ?? 0) / totalEdited : 0;
      const genShare = totalGen ? (generated.motionCounts[k] ?? 0) / totalGen : 0;
      const w = prefs.motionWeights[k] / sumW;
      const nw = Math.max(0.001, w + alpha * (share - genShare));
      if (Math.abs(nw - w) > 0.02) changes.push(`motion ${k} weight ${(w * 100).toFixed(0)}% → ${(nw * 100).toFixed(0)}%`);
      next.motionWeights[k] = Math.max(0.01, nw * 10);
    }
    const noneShare = noneEdited / (totalEdited + noneEdited);
    const noneGenShare = totalGen + noneGen ? noneGen / (totalGen + noneGen) : 0;
    if (noneShare - noneGenShare > 0.3 && prefs.motionAmount > 0.04) {
      next.motionAmount = clamp(prefs.motionAmount * (1 - alpha * noneShare), 0.03, 0.4);
      changes.push(`motion intensity ${prefs.motionAmount.toFixed(2)} → ${next.motionAmount.toFixed(2)}`);
    }
  }
  const editedShare = edited.cuts ? edited.dissolves / edited.cuts : 0;
  const genShare = generated.cuts ? generated.dissolves / generated.cuts : 0;
  if (edited.cuts >= 3 && Math.abs(editedShare - genShare) > 0.05) {
    next.dissolveShare = clamp((1 - alpha) * prefs.dissolveShare + alpha * editedShare, 0, 1);
    changes.push(`dissolve share ${(prefs.dissolveShare * 100).toFixed(0)}% → ${(next.dissolveShare * 100).toFixed(0)}%`);
  }
  if (edited.musicRelativeDb !== null && generated.musicRelativeDb !== null && Math.abs(edited.musicRelativeDb - generated.musicRelativeDb) > 0.5) {
    // an explicit level change by the user is adopted as-is
    next.musicRelativeDb = clamp(prefs.musicRelativeDb + (edited.musicRelativeDb - generated.musicRelativeDb), -40, -6);
    changes.push(`music level ${prefs.musicRelativeDb.toFixed(1)} dB → ${next.musicRelativeDb.toFixed(1)} dB`);
  }
  if (edited.duckDepthDb != null && generated.duckDepthDb != null && Math.abs(edited.duckDepthDb - generated.duckDepthDb) > 0.5) {
    next.duckDepthDb = clamp(edited.duckDepthDb, -24, 0);
    changes.push(`music ducking ${(prefs.duckDepthDb ?? -8).toFixed(1)} dB → ${next.duckDepthDb.toFixed(1)} dB`);
  }
  if (generated.sfxClips && edited.sfxClips != null && edited.sfxClips < generated.sfxClips * 0.3) {
    next.sfx = false;
    changes.push('sound effects off (most were removed)');
  }
  if (edited.subtitles !== generated.subtitles) {
    next.subtitles = edited.subtitles;
    changes.push(`subtitles ${edited.subtitles ? 'on' : 'off'}`);
  }
  if (changes.length) next.version = prefs.version + 1;
  return { prefs: next, changes };
}
