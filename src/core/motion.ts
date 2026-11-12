/**
 * Camera motion (Ken Burns) shared by preview and export. Progress uses smoothstep easing so moves
 * start and end gently. Zoom is relative to the clip's fitted frame; pan offsets are fractions of
 * the available overflow (-1..1, 0 = centred).
 */
import type { ClipMotion } from './model';

export interface MotionState {
  zoom: number;
  panX: number;
  panY: number;
}

export const ease = (p: number) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * (3 - 2 * x);
};

export function motionAt(m: ClipMotion | undefined, progress: number): MotionState {
  if (!m || m.kind === 'none' || m.amount <= 0) return { zoom: 1, panX: 0, panY: 0 };
  const e = ease(progress);
  const a = m.amount;
  switch (m.kind) {
    case 'zoom-in':
      return { zoom: 1 + a * e, panX: 0, panY: 0 };
    case 'zoom-out':
      return { zoom: 1 + a * (1 - e), panX: 0, panY: 0 };
    case 'pan-left':
      return { zoom: 1 + a, panX: 1 - 2 * e, panY: 0 };
    case 'pan-right':
      return { zoom: 1 + a, panX: -1 + 2 * e, panY: 0 };
    case 'pan-up':
      return { zoom: 1 + a, panX: 0, panY: 1 - 2 * e };
    case 'pan-down':
      return { zoom: 1 + a, panX: 0, panY: -1 + 2 * e };
    default:
      return { zoom: 1, panX: 0, panY: 0 };
  }
}

/** FFmpeg expressions (variable `t` = seconds since the item's first frame) equivalent to motionAt. */
export function motionExpr(m: ClipMotion, durationSec: number): { zoom: string; panX: string; panY: string } {
  const a = m.amount.toFixed(6);
  const d = Math.max(1e-3, durationSec).toFixed(6);
  const p = `min(1,max(0,t/${d}))`;
  const e = `(${p})*(${p})*(3-2*(${p}))`;
  switch (m.kind) {
    case 'zoom-in':
      return { zoom: `(1+${a}*${e})`, panX: '0', panY: '0' };
    case 'zoom-out':
      return { zoom: `(1+${a}*(1-${e}))`, panX: '0', panY: '0' };
    case 'pan-left':
      return { zoom: `(1+${a})`, panX: `(1-2*${e})`, panY: '0' };
    case 'pan-right':
      return { zoom: `(1+${a})`, panX: `(-1+2*${e})`, panY: '0' };
    case 'pan-up':
      return { zoom: `(1+${a})`, panX: '0', panY: `(1-2*${e})` };
    case 'pan-down':
      return { zoom: `(1+${a})`, panX: '0', panY: `(-1+2*${e})` };
    default:
      return { zoom: '1', panX: '0', panY: '0' };
  }
}
