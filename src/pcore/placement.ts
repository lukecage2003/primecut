/**
 * P-CORE Adaptive Placement Engine (pure). Reads what the timeline already knows — which shot is on
 * V1, whether it is a procedural composition, a comic page (detected panels, blurred side fill) or a
 * landscape picture — and decides where P-CORE sits and how big it is, avoiding forbidden zones
 * (subtitle band, lower thirds, panels). No computer vision is required.
 */
import type { Caption, ClipTransform, MediaAsset, Sequence } from '../core/model';
import { planSequence } from '../core/plan';
import { framesToSeconds } from '../core/time';
import type { PCoreEvent } from './expression';

export type PlacementMode = 'hero' | 'side' | 'corner' | 'cinematic' | 'hidden';
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
  /** Fixed position chosen by the creator: overrides adaptive placement in every production.
   *  x, y = centre as a fraction of the frame; size = fraction of the frame's short side. */
  manual?: { enabled: boolean; x: number; y: number; size: number };
  /** Zones P-CORE must never cover (normalised rects of the frame), drawn by the creator. */
  protectedZones?: Rect[];
  /** Step aside for on-screen titles and name cards (their real positions are known). */
  avoidCaptions?: boolean;
  /** Mode C: on strong moments P-CORE returns to the front over illustrations, briefly. */
  cinematic?: boolean;
  /** Vertical centre of the central P-CORE (fraction of the height); default: centred above the subtitles. */
  heroY?: number;
  /** Badge mode: one continuous, discreet animated logo in a corner for the whole video (channel signature). */
  badge?: boolean;
  /** Badge size (fraction of the short side). */
  badgeScale?: number;
}

export const DEFAULT_PLACEMENT: PlacementSettings = { enabled: true, heroScale: 0.72, cornerScale: 0.24, corner: 'top-right', margin: 0.04, subtitleBand: 0.2, overIllustrations: true, growOnReveal: true, avoidCaptions: true, cinematic: true };

export interface PlacementSegment {
  start: number;
  end: number;
  mode: PlacementMode;
  transform: ClipTransform;
  reason: string;
}

export interface Rect {
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
  // informative compositions (names, dates, quotes) are content: P-CORE steps aside for them
  const informative = media?.generator && ['character-card', 'timeline', 'typography'].includes(media.generator.kind);
  const guard = (s.protectedZones ?? []).map((z) => ({ x: z.x * W, y: z.y * H, w: z.w * W, h: z.h * H }));
  if (!media || (media.generator && !informative)) {
    const size = s.heroScale * U;
    const cy = s.heroY !== undefined ? s.heroY * H : Math.min(H / 2, (H - sub) / 2 + m);
    const hero = { x: W / 2 - size / 2, y: cy - size / 2, w: size, h: size };
    const blocked = guard.reduce((a, z) => a + overlap(hero, z), 0) / (size * size);
    if (blocked <= 0.05) return { mode: 'hero', transform: at(W, H, W / 2, cy, size), reason: media ? 'composition procédurale : P-CORE au premier plan' : 'pas d’illustration : P-CORE au premier plan' };
    // a protected zone covers the centre: P-CORE takes the best free corner, larger than usual
  }
  // informative compositions are not illustrations: P-CORE stays present beside them
  if (!s.overIllustrations && !informative && media && !media.generator) return { mode: 'hidden', transform: { x: 0, y: 0, scale: 0.01, rotation: 0, opacity: 0 }, reason: 'illustration : P-CORE masqué par les réglages' };
  const v = media && !media.generator ? media.probe.video : undefined;
  if (v) {
    const fit = Math.min(W / v.width, H / v.height);
    const pw = v.width * fit;
    const free = (W - pw) / 2;
    // portrait page with side fill: the free side band is the natural place
    if (free > 0.12 * W) {
      const size = Math.min(free - 2 * m, s.cornerScale * 1.6 * U);
      const cx = s.corner.endsWith('left') ? free / 2 : W - free / 2;
      return { mode: 'side', transform: at(W, H, cx, H * 0.42, size), reason: 'planche : P-CORE dans la bande libre sur le côté' };
    }
  }
  // corner with the least overlap with panels / the subject area (centre)
  const size = s.cornerScale * U;
  const order: Corner[] = [s.corner, 'top-left', 'top-right', 'bottom-right', 'bottom-left'];
  // what must stay visible: panels, the text read in the picture (OCR zones, mapped through the fit), protected zones
  const v2 = media?.probe.video;
  const fit = v2 ? Math.min(W / v2.width, H / v2.height) : 1;
  const ox = v2 ? (W - v2.width * fit) / 2 : 0;
  const oy = v2 ? (H - v2.height * fit) / 2 : 0;
  const text = v2 && media?.ocr ? media.ocr.zones.map((z) => ({ x: ox + z.x * v2.width * fit, y: oy + z.y * v2.height * fit, w: z.w * v2.width * fit, h: z.h * v2.height * fit })) : [];
  const subject: Rect[] = [...(panels?.length ? panels : [{ x: W * 0.3, y: H * 0.2, w: W * 0.4, h: H * 0.55 }]), ...text, ...guard];
  let best: { c: Corner; cost: number } | null = null;
  for (const c of order) {
    const r = cornerRect(c, W, H, size, m, c.startsWith('bottom') ? sub + m : m);
    let cost = subject.reduce((a, p) => a + overlap(r, p), 0) / (size * size);
    if (c === 'bottom-left') cost += 0.5; // lower thirds live here
    if (!best || cost < best.cost - 1e-6) best = { c, cost };
  }
  const r = cornerRect(best!.c, W, H, size, m, best!.c.startsWith('bottom') ? sub + m : m);
  return { mode: 'corner', transform: at(W, H, r.x + size / 2, r.y + size / 2, size), reason: `illustration : P-CORE discret (${best!.c})` };
}

/** Placement segments covering [0, endFrame) from the V1 shots of the sequence. */
export interface PlacementContext {
  /** Captions of the sequence (titles, name cards): their on-screen zones are known. */
  captions?: Caption[];
  /** Strong narrative moments (seconds) that justify a brief return to the front (mode C). */
  cinematic?: { time: number; duration: number; reason: string }[];
}

/** Zone (px) of a caption as drawn by the subtitle renderer (title: centred; name card: bottom left). */
export function captionZone(c: Caption, W: number, H: number): Rect | null {
  const lines = c.text.split('\n').length;
  if (c.style === 'title') {
    const half = 0.085 * H * 0.62 * lines + 0.02 * H;
    return { x: 0.08 * W, y: H / 2 - half, w: 0.84 * W, h: 2 * half };
  }
  if (c.style === 'lower-third') {
    const b = H > W ? Math.min(H, W * 1.2) : H;
    return { x: 0.02 * W, y: H - 0.2 * b - 0.055 * b * lines - 0.02 * b, w: 0.55 * W, h: 0.055 * b * lines + 0.04 * b };
  }
  return null;
}

export function planPlacement(seq: Sequence, media: Record<string, MediaAsset>, endFrame: number, settings: Partial<PlacementSettings> = {}, events: PCoreEvent[] = [], ctx: PlacementContext = {}): PlacementSegment[] {
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
  if (s.badge && !s.manual?.enabled) {
    // a channel signature: same place and size from start to end, above the subtitle band
    const U = Math.min(W, H);
    const size = (s.badgeScale ?? 0.2) * U;
    const m = s.margin * H;
    const corner = s.corner ?? 'bottom-right';
    const x = corner.endsWith('right') ? W - m - size / 2 : m + size / 2;
    const y = corner.startsWith('top') ? m + size / 2 : H - s.subtitleBand * H - m - size / 2;
    const badge = { mode: 'corner' as const, transform: at(W, H, x, y, size), reason: 'image à l’écran : P-CORE en logo dans le coin' };
    // nothing to show (no picture, or a background composition): P-CORE comes to the front, animated by the voice
    let t0 = 0;
    for (const it of items) {
      if (it.start >= endFrame) break;
      if (it.start > t0) push(t0, it.start, placeForShot(null, W, H, s));
      const p = placeForShot(it.media, W, H, s);
      push(Math.max(t0, it.start), Math.min(endFrame, it.end), p.mode === 'hero' ? p : badge);
      t0 = Math.max(t0, it.end);
    }
    if (t0 < endFrame) push(t0, endFrame, placeForShot(null, W, H, s));
    // very short returns to the front (< 1.5 s) would flicker: they stay a logo
    const minF = Math.round(1.5 * (r.num / r.den));
    for (const g of segs) if (g.mode === 'hero' && g.end - g.start < minF) Object.assign(g, badge);
    const merged: PlacementSegment[] = [];
    for (const g of segs) {
      const last = merged.at(-1);
      if (last && last.end === g.start && last.mode === g.mode && JSON.stringify(last.transform) === JSON.stringify(g.transform)) last.end = g.end;
      else merged.push({ ...g });
    }
    return merged;
  }
  if (s.manual?.enabled) {
    const U = Math.min(W, H);
    const size = Math.max(0.05, Math.min(1, s.manual.size)) * U;
    push(0, endFrame, { mode: s.manual.size >= s.heroScale * 0.8 ? 'hero' : 'corner', transform: at(W, H, s.manual.x * W, s.manual.y * H, size), reason: 'position fixe choisie par le créateur' });
  }
  let t = s.manual?.enabled ? endFrame : 0;
  for (const it of items) {
    if (s.manual?.enabled) break;
    if (it.start >= endFrame) break;
    if (it.start > t) push(t, it.start, placeForShot(null, W, H, s));
    const mo = it.clip.motion;
    const panels = it.media.panels && mo?.kind !== 'panels' ? undefined : undefined; // full-frame panel reading: corner logic below
    const pl = mo?.kind === 'panels' ? placeForShot({ ...it.media, probe: { ...it.media.probe, video: it.media.probe.video ? { ...it.media.probe.video, width: W, height: H } : undefined } } as MediaAsset, W, H, s, panels) : placeForShot(it.media, W, H, s);
    push(Math.max(t, it.start), Math.min(endFrame, it.end), pl);
    t = Math.max(t, it.end);
  }
  if (t < endFrame) push(t, endFrame, placeForShot(null, W, H, s));
  const fpsN = r.num / r.den;
  /** Replaces [a, b) of the plan with `make(segment)` (segments are split at a and b). */
  const overlay = (a: number, b: number, make: (g: PlacementSegment) => PlacementSegment | null) => {
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i]!;
      if (g.end <= a || g.start >= b) continue;
      const mid = make({ ...g, start: Math.max(a, g.start), end: Math.min(b, g.end) });
      if (!mid) continue;
      const parts = [g.start < mid.start ? { ...g, end: mid.start } : null, mid, g.end > mid.end ? { ...g, start: mid.end } : null].filter(Boolean) as PlacementSegment[];
      segs.splice(i, 1, ...parts);
      i += parts.length - 1;
    }
  };
  const U = Math.min(W, H);
  const cinematicRanges: [number, number][] = [];
  // mode C: a strong moment brings P-CORE back to the front over an illustration (never when the position is locked)
  if (s.cinematic && !s.manual?.enabled) {
    for (const c of ctx.cinematic ?? []) {
      const a = Math.round(c.time * fpsN);
      const b = Math.round((c.time + Math.min(4, c.duration)) * fpsN);
      overlay(a, b, (g) => (g.mode === 'corner' || g.mode === 'side' ? { ...g, mode: 'cinematic', transform: at(W, H, W / 2, Math.min(H / 2, (H - s.subtitleBand * H) / 2 + s.margin * H), s.heroScale * 0.85 * U), reason: `${c.reason} : P-CORE revient brièvement au premier plan` } : null));
      cinematicRanges.push([a, b]);
    }
  }
  // titles and name cards are on screen at known places: P-CORE steps aside (smaller, above the title)
  if (s.avoidCaptions !== false && !s.manual?.enabled) {
    for (const c of ctx.captions ?? []) {
      const z = captionZone(c, W, H);
      if (!z) continue;
      overlay(c.start, c.end, (g) => {
        const sz = g.transform.scale * U;
        const cx = W / 2 + g.transform.x;
        const cy = H / 2 + g.transform.y;
        const rect = { x: cx - sz / 2, y: cy - sz / 2, w: sz, h: sz };
        if (overlap(rect, z) < 0.02 * sz * sz) return null;
        if (c.style === 'title') {
          const room = z.y - 2 * s.margin * H;
          const size = Math.max(0.18 * U, Math.min(sz * 0.6, room));
          return { ...g, transform: at(W, H, W / 2, s.margin * H + size / 2, size), reason: `${g.reason} · titre à l’écran : P-CORE au-dessus` };
        }
        // a name card under a central P-CORE: P-CORE shrinks above it, still central
        if (g.mode === 'hero' || g.mode === 'cinematic') {
          const size = Math.max(0.25 * U, Math.min(sz, z.y - 2 * s.margin * H));
          return { ...g, transform: at(W, H, W / 2, z.y - s.margin * H - size / 2, size), reason: `${g.reason} · nom à l’écran : P-CORE au-dessus` };
        }
        const other = cornerRect('top-right', W, H, s.cornerScale * U, s.margin * H, s.margin * H);
        return { ...g, mode: 'corner', transform: at(W, H, other.x + other.w / 2, other.y + other.h / 2, other.w), reason: `${g.reason} · nom à l’écran : P-CORE en haut à droite` };
      });
    }
  }
  // important passages: enlarge temporarily (split segments around reveal events)
  if (s.growOnReveal) {
    for (const e of events.filter((x) => x.state === 'reveal')) {
      const a = Math.round(e.time * (r.num / r.den));
      const b = Math.round((e.time + e.duration) * (r.num / r.den));
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i]!;
        if (g.mode === 'hidden' || g.mode === 'cinematic' || g.end <= a || g.start >= b || g.reason.includes('titre à l’écran')) continue;
        const grown: PlacementSegment = { ...g, start: Math.max(a, g.start), end: Math.min(b, g.end), transform: { ...g.transform, scale: +(g.transform.scale * (g.mode === 'hero' ? 1.12 : 1.5)).toFixed(4) }, reason: `${g.reason} · révélation : agrandi` };
        const parts = [g.start < grown.start ? { ...g, end: grown.start } : null, grown, g.end > grown.end ? { ...g, start: grown.end } : null].filter(Boolean) as PlacementSegment[];
        segs.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    }
  }
  void framesToSeconds;
  return segs;
}
