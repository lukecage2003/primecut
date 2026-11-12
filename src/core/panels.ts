/**
 * Comic panels: detection on a grayscale raster (recursive XY-cut on gutters) and the camera path
 * that visits panels in reading order. Pure functions, shared by engine (detection), builder,
 * preview and export.
 */

/** Normalised rectangle (0..1 in image coordinates). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelDetectOptions {
  /** Minimum gutter thickness as a fraction of the dimension. */
  minGutter?: number;
  /** Minimum panel size as a fraction of the page dimension. */
  minPanel?: number;
  /** Max deviation from the background level for a pixel to count as gutter (0..255). */
  tolerance?: number;
  /** Share of pixels in a line that must be background. */
  lineRatio?: number;
}

/**
 * Detects panels in a W×H 8-bit grayscale image. Background (gutter) colour is estimated from the
 * page border. Reading order: rows top→bottom, panels left→right within a row.
 */
export function detectPanels(gray: Uint8Array, W: number, H: number, opts: PanelDetectOptions = {}): Rect[] {
  const minGutter = opts.minGutter ?? 0.006;
  const minPanel = opts.minPanel ?? 0.08;
  const tol = opts.tolerance ?? 28;
  const ratio = opts.lineRatio ?? 0.985;
  // background level = median of the outer border
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(gray[x]!, gray[(H - 1) * W + x]!);
  for (let y = 0; y < H; y++) border.push(gray[y * W]!, gray[y * W + W - 1]!);
  border.sort((a, b) => a - b);
  const bg = border[Math.floor(border.length / 2)]!;
  const isBg = (v: number) => Math.abs(v - bg) <= tol;

  const panels: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const rowBg = (y: number, x0: number, x1: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (isBg(gray[y * W + x]!)) n++;
    return n >= (x1 - x0) * ratio;
  };
  const colBg = (x: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (isBg(gray[y * W + x]!)) n++;
    return n >= (y1 - y0) * ratio;
  };
  /** Splits [a,b) into content runs separated by background runs ≥ gap. */
  const runs = (a: number, b: number, bgAt: (i: number) => boolean, gap: number) => {
    const out: [number, number][] = [];
    let start = -1;
    let bgLen = 0;
    for (let i = a; i < b; i++) {
      if (bgAt(i)) {
        bgLen++;
        if (start >= 0 && bgLen >= gap) {
          out.push([start, i - bgLen + 1]);
          start = -1;
        }
      } else {
        if (start < 0) start = i;
        bgLen = 0;
      }
    }
    if (start >= 0) out.push([start, b - bgLen]);
    return out;
  };
  const gapX = Math.max(2, Math.round(W * minGutter));
  const gapY = Math.max(2, Math.round(H * minGutter));
  const cut = (x0: number, y0: number, x1: number, y1: number, depth: number) => {
    if (depth > 6) return void panels.push({ x0, y0, x1, y1 });
    const rows = runs(y0, y1, (y) => rowBg(y, x0, x1), gapY);
    if (rows.length > 1) {
      for (const [a, b] of rows) cut(x0, a, x1, b, depth + 1);
      return;
    }
    const [ry0, ry1] = rows[0] ?? [y0, y1];
    const cols = runs(x0, x1, (x) => colBg(x, ry0, ry1), gapX);
    if (cols.length > 1) {
      for (const [a, b] of cols) cut(a, ry0, b, ry1, depth + 1);
      return;
    }
    const [cx0, cx1] = cols[0] ?? [x0, x1];
    panels.push({ x0: cx0, y0: ry0, x1: cx1, y1: ry1 });
  };
  cut(0, 0, W, H, 0);
  return panels
    .filter((p) => (p.x1 - p.x0) / W >= minPanel && (p.y1 - p.y0) / H >= minPanel)
    .map((p) => ({ x: p.x0 / W, y: p.y0 / H, w: (p.x1 - p.x0) / W, h: (p.y1 - p.y0) / H }));
}

/**
 * Viewing window (normalised to the image) that frames a panel with a margin while keeping the
 * output box aspect ratio `boxAspect` (= box width / box height, both in image pixels ratio terms).
 */
/** How far (fraction of the image) a window may extend beyond the page; the overflow shows the dark background. */
export const PANEL_OVERFLOW = { x: 0.6, y: 0.1 };

export function windowFor(panel: Rect, imageAspect: number, boxAspect: number, margin = 0.04, ext = PANEL_OVERFLOW): Rect {
  // work in image pixel units where image width = imageAspect, height = 1
  let w = (panel.w + 2 * margin) * imageAspect;
  let h = panel.h + 2 * margin;
  if (w / h > boxAspect) h = w / boxAspect;
  else w = h * boxAspect;
  // clamp to the image extended by the allowed overflow
  const maxW = imageAspect * (1 + 2 * ext.x);
  const maxH = 1 + 2 * ext.y;
  w = Math.min(w, maxW);
  h = Math.min(h, maxH);
  if (w / h > boxAspect) w = h * boxAspect;
  else h = w / boxAspect;
  const cx = (panel.x + panel.w / 2) * imageAspect;
  const cy = panel.y + panel.h / 2;
  const x = Math.min(Math.max(cx - w / 2, -ext.x * imageAspect), imageAspect * (1 + ext.x) - w);
  const y = Math.min(Math.max(cy - h / 2, -ext.y), 1 + ext.y - h);
  return { x: x / imageAspect, y, w: w / imageAspect, h };
}

/**
 * Window at progress p (0..1) along a path of windows: each window holds, then eases to the next.
 * `hold` = share of each segment spent still.
 */
export function pathAt(path: Rect[], p: number, hold = 0.65): Rect {
  if (path.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  if (path.length === 1) return path[0]!;
  const n = path.length;
  const seg = Math.min(n - 1, Math.floor(Math.max(0, Math.min(0.999999, p)) * n));
  const local = Math.max(0, Math.min(1, p * n - seg));
  const a = path[seg]!;
  const b = path[Math.min(n - 1, seg + 1)]!;
  if (seg === n - 1 || local < hold) return a;
  const x = (local - hold) / (1 - hold);
  const e = x * x * (3 - 2 * x);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e, h: a.h + (b.h - a.h) * e };
}

/** FFmpeg expression of pathAt for one field ('x' | 'y' | 'w' | 'h'), with `t` in seconds. */
export function pathExpr(path: Rect[], field: keyof Rect, durationSec: number, hold = 0.65): string {
  const n = path.length;
  if (n === 1) return path[0]![field].toFixed(6);
  const segDur = durationSec / n;
  let expr = path[n - 1]![field].toFixed(6);
  for (let i = n - 2; i >= 0; i--) {
    const a = path[i]![field];
    const b = path[i + 1]![field];
    const t0 = i * segDur;
    const tm = t0 + hold * segDur;
    const t1 = (i + 1) * segDur;
    const x = `((t-${tm.toFixed(6)})/${(t1 - tm).toFixed(6)})`;
    const moving = `(${a.toFixed(6)}+${(b - a).toFixed(6)}*${x}*${x}*(3-2*${x}))`;
    expr = `if(lt(t,${tm.toFixed(6)}),${a.toFixed(6)},if(lt(t,${t1.toFixed(6)}),${moving},${expr}))`;
    void t0;
  }
  return expr;
}
