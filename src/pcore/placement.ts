/**
 * P-CORE Adaptive Placement Engine (pure). Reads what the timeline already knows — which shot is on
 * V1, whether it is a procedural composition, a comic page (detected panels, blurred side fill) or a
 * landscape picture — and decides where P-CORE sits and how big it is, avoiding forbidden zones
 * (subtitle band, lower thirds, panels). No computer vision is required.
 */
import type { ClipTransform, MediaAsset, Sequence } from '../core/model';
import { planSequence } from '../core/plan';
import { framesToSeconds } from '../core/time';
import type { PCoreEvent } from './expression';

export type PlacementMode = 'hero' | 'side' | 'corner' | 'hidden';
export type Corner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export interface PlacementSettings {
  enabled: boolean;
  /** Size of P-CORE relative to the frame height. */
  heroScale: number;
  cornerScale: number;
  /** Preferred corner over illustrations. */
  corner: Corner;
  /** Safe margin (fraction of the frame height). */
  margin: number;
  /** Bottom band kept free for subtitles (fraction of height). */
  subtitleBand: number;
  /** Show P-CORE over illustrations at all (false = only where there is no illustration). */
  overIllustrations: boolean;
  /** Reveal events enlarge P-CORE temporarily. */
  growOnReveal: boolean;
}

export const DEFAULT_PLACEMENT: PlacementSettings = { enabled: true, heroScale: 0.72, cornerScale: 0.24, corner: 'top-right', margin: 0.04, subtitleBand: 0.2, overIllustrations: true, growOnReveal: true };

export interface PlacementSegment {
  start: number;
  end: number;
  mode: PlacementMode;
  transform: ClipTransform;
  reason: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Transform for a P-CORE square (rendered S×S, fitted to the frame height) centred at (cx, cy) px. */
function at(W: number, H: number, cx: number, cy: number, size: number): ClipTransform {
  return { x: Math.round(cx - W / 2), y: Math.round(cy - H / 2), scale: +(size / Math.min(W, H)).toFixed(4), rotation: 0, opacity: 1 };
}

function cornerRect(corner: Corner, W: number, H: number, size: number, m: number, sub: number): Rect {
  const x = corner.endsWith('right') ? W - m - size : m;
  const y = corner.startsWith('top') ? m : H - sub - size;
  return { x, y, w: size, h: size };
}

export function placeForShot(media: MediaAsset | null, W: number, H: number, s: PlacementSettings, panels?: Rect[]): Omit<PlacementSegment, 'start' | 'end'> {
  const U = Math.min(W, H);
  const m = s.margin * H;
  const sub = s.subtitleBand * H;
  if (!media || media.generator) {
    const size = s.heroScale * U;
    return { mode: 'hero', transform: at(W, H, W / 2, Math.min(H / 2, (H - sub) / 2 + m), size), reason: media ? 'procedural composition: P-CORE leads' : 'no illustration: P-CORE leads' };
  }
  if (!s.overIllustrations) return { mode: 'hidden', transform: { x: 0, y: 0, scale: 0.01, rotation: 0, opacity: 0 }, reason: 'illustration: P-CORE hidden by settings' };
  const v = media.probe.video;
  if (v) {
    const fit = Math.min(W / v.width, H / v.height);
    const pw = v.width * fit;
    const free = (W - pw) / 2;
    // portrait page with side fill: the free side band is the natural place
    if (free > 0.12 * W) {
      const size = Math.min(free - 2 * m, s.cornerScale * 1.6 * U);
      const cx = s.corner.endsWith('left') ? free / 2 : W - free / 2;
      return { mode: 'side', transform: at(W, H, cx, H * 0.42, size), reason: 'page pillarbox: P-CORE in the free side band' };
    }
  }
  // corner with the least overlap with panels / the subject area (centre)
  const size = s.cornerScale * U;
  const order: Corner[] = [s.corner, 'top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const subject: Rect[] = panels?.length ? panels : [{ x: W * 0.3, y: H * 0.2, w: W * 0.4, h: H * 0.55 }];
  let best: { c: Corner; cost: number } | null = null;
  for (const c of order) {
    const r = cornerRect(c, W, H, size, m, c.startsWith('bottom') ? sub + m : m);
    let cost = subject.reduce((a, p) => a + overlap(r, p), 0) / (size * size);
    if (c === 'bottom-left') cost += 0.5; // lower thirds live here
    if (!best || cost < best.cost - 1e-6) best = { c, cost };
  }
  const r = cornerRect(best!.c, W, H, size, m, best!.c.startsWith('bottom') ? sub + m : m);
  return { mode: 'corner', transform: at(W, H, r.x + size / 2, r.y + size / 2, size), reason: `illustration: P-CORE discreet (${best!.c})` };
}

/** Placement segments covering [0, endFrame) from the V1 shots of the sequence. */
export function planPlacement(seq: Sequence, media: Record<string, MediaAsset>, endFrame: number, settings: Partial<PlacementSettings> = {}, events: PCoreEvent[] = []): PlacementSegment[] {
  const s = { ...DEFAULT_PLACEMENT, ...settings };
  const { width: W, height: H, frameRate: r } = seq.settings;
  const v1 = seq.tracks.find((t) => t.kind === 'video');
  const items = planSequence(seq, media).filter((p) => p.kind === 'video' && p.track.id === v1?.id);
  const segs: PlacementSegment[] = [];
  const push = (start: number, end: number, p: Omit<PlacementSegment, 'start' | 'end'>) => {
    if (end <= start) return;
    const last = segs.at(-1);
    if (last && last.end === start && last.mode === p.mode && JSON.stringify(last.transform) === JSON.stringify(p.transform)) last.end = end;
    else segs.push({ start, end, ...p });
  };
  let t = 0;
  for (const it of items) {
    if (it.start >= endFrame) break;
    if (it.start > t) push(t, it.start, placeForShot(null, W, H, s));
    const mo = it.clip.motion;
    const panels = it.media.panels && mo?.kind !== 'panels' ? undefined : undefined; // full-frame panel reading: corner logic below
    const pl = mo?.kind === 'panels' ? placeForShot({ ...it.media, probe: { ...it.media.probe, video: it.media.probe.video ? { ...it.media.probe.video, width: W, height: H } : undefined } } as MediaAsset, W, H, s, panels) : placeForShot(it.media, W, H, s);
    push(Math.max(t, it.start), Math.min(endFrame, it.end), pl);
    t = Math.max(t, it.end);
  }
  if (t < endFrame) push(t, endFrame, placeForShot(null, W, H, s));
  // important passages: enlarge temporarily (split segments around reveal events)
  if (s.growOnReveal) {
    for (const e of events.filter((x) => x.state === 'reveal')) {
      const a = Math.round(e.time * (r.num / r.den));
      const b = Math.round((e.time + e.duration) * (r.num / r.den));
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i]!;
        if (g.mode === 'hidden' || g.end <= a || g.start >= b) continue;
        const grown: PlacementSegment = { ...g, start: Math.max(a, g.start), end: Math.min(b, g.end), transform: { ...g.transform, scale: +(g.transform.scale * (g.mode === 'hero' ? 1.12 : 1.5)).toFixed(4) }, reason: `${g.reason} · reveal: enlarged` };
        const parts = [g.start < grown.start ? { ...g, end: grown.start } : null, grown, g.end > grown.end ? { ...g, start: grown.end } : null].filter(Boolean) as PlacementSegment[];
        segs.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    }
  }
  void framesToSeconds;
  return segs;
}
