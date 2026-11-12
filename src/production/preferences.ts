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
  /** Seconds spent per panel. */
  secondsPerPanel: number;
  /** Dissolve between sections (frames); 0 = hard cut. */
  sectionDissolveFrames: number;
  /** Share of in-section cuts that get a short dissolve (0..1). */
  dissolveShare: number;
  subtitles: boolean;
  sectionTitles: boolean;
  lowerThirds: boolean;
  /** Music bed level relative to narration (dB). */
  musicRelativeDb: number;
  narrationLufs: number;
  /** A media item is not reused within this many shots when alternatives exist. */
  avoidRepeatWithin: number;
}

export const DEFAULT_PREFERENCES: ProductionPreferences = {
  version: 1,
  shotMin: 2.5,
  shotTarget: 4.5,
  shotMax: 8,
  motionAmount: 0.12,
  motionWeights: { 'zoom-in': 3, 'zoom-out': 2, 'pan-left': 1, 'pan-right': 1, 'pan-up': 0.5, 'pan-down': 0.5 },
  panelReading: true,
  secondsPerPanel: 1.8,
  sectionDissolveFrames: 15,
  dissolveShare: 0,
  subtitles: true,
  sectionTitles: true,
  lowerThirds: true,
  musicRelativeDb: -20,
  narrationLufs: -16,
  avoidRepeatWithin: 4,
};

/** Observable style of an edit (generated or user-modified). */
export interface EditStyle {
  shots: number;
  meanShotSec: number;
  motionCounts: Partial<Record<MotionKind, number>>;
  dissolves: number;
  cuts: number;
  musicRelativeDb: number | null;
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
  if (edited.subtitles !== generated.subtitles) {
    next.subtitles = edited.subtitles;
    changes.push(`subtitles ${edited.subtitles ? 'on' : 'off'}`);
  }
  if (changes.length) next.version = prefs.version + 1;
  return { prefs: next, changes };
}
