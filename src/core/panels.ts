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
  /** Also try the region method (gutters of any direction). Default true. */
  regions?: boolean;
}

/**
 * Detects panels in a W×H 8-bit grayscale image. Background (gutter) colour is estimated from the
 * page border. Reading order: rows top→bottom, panels left→right within a row.
 */
export function detectPanels(gray: Uint8Array, W: number, H: number, opts: PanelDetectOptions = {}): Rect[] {
  return detectPanelsDetailed(gray, W, H, opts).panels;
}

export interface PanelDetection {
  panels: Rect[];
  /**
   * 0..1: share of the page's drawn content that falls inside the detected panels, lowered when the
   * gutters had to be read loosely. Low values mean the layout did not split cleanly (borderless
   * panels, art crossing gutters): the panel reading should be checked.
   */
  confidence: number;
  /** Gutter tolerance actually used (grey levels) and whether the relaxed pass was needed. */
  tolerance: number;
  relaxed: boolean;
  /** Gutter (background) grey level read on the page border. */
  bg: number;
  /** Which method gave the panels: straight gutters (XY-cut) or regions (any gutter direction). */
  method: 'xy' | 'regions';
  /** Share of the page that differs from the gutter colour (0..1). */
  ink: number;
  /** Share of the page without texture (0..1): high on title, credits and text pages. */
  flat: number;
  /** Speech balloons / caption boxes found (lettering inside light blobs). */
  balloons: number;
}

/**
 * Detection with a confidence. The gutter tolerance adapts to the noise of the page border (scans,
 * JPEG); when the strict pass finds no layout, a relaxed pass accepts gutters crossed by a little
 * art (balloon tails, speed lines).
 */
export function detectPanelsDetailed(gray: Uint8Array, W: number, H: number, opts: PanelDetectOptions = {}): PanelDetection {
  // background level = median of the outer border; noise = median absolute deviation
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(gray[x]!, gray[(H - 1) * W + x]!);
  for (let y = 0; y < H; y++) border.push(gray[y * W]!, gray[y * W + W - 1]!);
  border.sort((a, b) => a - b);
  const bg = border[Math.floor(border.length / 2)]!;
  const dev = border.map((v) => Math.abs(v - bg)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)]!;
  const tol = opts.tolerance ?? Math.min(60, Math.max(28, Math.round(4 * mad)));
  const strict = xyCut(gray, W, H, bg, tol, opts.lineRatio ?? 0.985, opts);
  let panels = strict;
  let relaxed = false;
  if (strict.length < 2 && opts.lineRatio === undefined) {
    const loose = xyCut(gray, W, H, bg, tol, 0.94, opts);
    if (loose.length >= 2) ((panels = loose), (relaxed = true));
  }
  // coverage of the drawn content by the panels
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 40000)));
  // how much of the page is drawn: a title or credits page (mostly blank) has no panels to read
  let inked = 0, samples = 0;
  for (let y = 0; y < H; y += step)
    for (let x = 0; x < W; x += step) {
      samples++;
      if (Math.abs(gray[y * W + x]! - bg) > tol) inked++;
    }
  const ink = samples ? inked / samples : 0;
  // flat share: pixels with no local texture. A title / credits page is a flat background with a little
  // text (60–80 %); drawn pages, covers included, stay well below (16–47 % on real Marvel issues)
  let flatN = 0, flatAll = 0;
  for (let y = 1; y < H - 1; y += step)
    for (let x = 1; x < W - 1; x += step) {
      const i = y * W + x;
      flatAll++;
      if (Math.abs(gray[i]! - gray[i + 1]!) + Math.abs(gray[i]! - gray[i + W]!) + Math.abs(gray[i]! - gray[i - 1]!) + Math.abs(gray[i]! - gray[i - W]!) < 8) flatN++;
    }
  const flat = flatAll ? flatN / flatAll : 0;
  const coverageOf = (ps: Rect[]) => {
    let content = 0, inside = 0;
    for (let y = 0; y < H; y += step)
      for (let x = 0; x < W; x += step) {
        if (Math.abs(gray[y * W + x]! - bg) <= tol) continue;
        content++;
        const nx = x / W, ny = y / H;
        if (ps.some((p) => nx >= p.x && nx < p.x + p.w && ny >= p.y && ny < p.y + p.h)) inside++;
      }
    return content ? inside / content : 0;
  };
  let coverage = coverageOf(panels);
  let method: 'xy' | 'regions' = 'xy';
  // gutters that are not straight (slanted cuts, bleeding art): the region method sees panels the XY-cut merges
  if (opts.regions !== false) {
    const reg = regionPanels(gray, W, H, bg, tol, opts);
    const cov = reg.length >= 2 ? coverageOf(reg) : 0;
    if (reg.length > panels.length && cov >= Math.max(0.85, coverage - 0.05)) {
      panels = reg;
      coverage = cov;
      relaxed = false;
      method = 'regions';
    }
  }
  // panels that overlap each other mean an irregular layout: the cut is less certain
  let overlap = 0;
  for (let i = 0; i < panels.length; i++)
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i]!, b = panels[j]!;
      overlap += Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    }
  const confidence = panels.length < 2 ? 0 : +Math.max(0, Math.min(1, coverage - (relaxed ? 0.2 : 0) - 3 * overlap)).toFixed(2);
  return { panels, confidence, tolerance: tol, relaxed, bg, method, ink: +ink.toFixed(3), flat: +flat.toFixed(3), balloons: countBalloons(gray, W, H) };
}

/**
 * Panels as connected regions of drawn content separated by gutters of any direction (slanted cuts,
 * irregular gutters, art bleeding to the page edge). Thin bridges across a gutter (balloon tails, speed
 * lines) are cut by an erosion first. Returns bounding boxes in reading order.
 */
export function regionPanels(gray: Uint8Array, W: number, H: number, bg: number, tol: number, opts: PanelDetectOptions = {}): Rect[] {
  const minPanel = opts.minPanel ?? 0.08;
  const n = W * H;
  let fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = Math.abs(gray[i]! - bg) > tol ? 1 : 0;
  // erosion (square, radius r): breaks thin bridges; the boxes grow back by r afterwards
  const r = Math.max(1, Math.round(Math.min(W, H) * 0.006));
  const erode = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(n);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let ok = 1;
        for (let k = -r; k <= r && ok; k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || !src[yy * W + xx]) ok = 0;
        }
        out[y * W + x] = ok;
      }
    return out;
  };
  fg = erode(erode(fg, true), false);
  const label = new Int32Array(n);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!fg[i] || label[i]) continue;
    const id = boxes.length + 1;
    const b = { x0: W, y0: H, x1: 0, y1: 0, area: 0 };
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % W, y = (j - x) / W;
      b.area++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (x > 0 && fg[j - 1] && !label[j - 1]) ((label[j - 1] = id), stack.push(j - 1));
      if (x < W - 1 && fg[j + 1] && !label[j + 1]) ((label[j + 1] = id), stack.push(j + 1));
      if (y > 0 && fg[j - W] && !label[j - W]) ((label[j - W] = id), stack.push(j - W));
      if (y < H - 1 && fg[j + W] && !label[j + W]) ((label[j + W] = id), stack.push(j + W));
    }
    boxes.push(b);
  }
  // each region is then cut along straight gutters of any angle (slanted layouts), recursively
  const fgRaw = new Uint8Array(n);
  for (let i = 0; i < n; i++) fgRaw[i] = Math.abs(gray[i]! - bg) > tol ? 1 : 0;
  const pieces: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  boxes.forEach((b, k) => {
    if (b.area < n * 0.012) return;
    const mask = new Uint8Array(n);
    // the region grown back by r (erosion undone), limited to its box
    for (let y = Math.max(0, b.y0 - r); y <= Math.min(H - 1, b.y1 + r); y++)
      for (let x = Math.max(0, b.x0 - r); x <= Math.min(W - 1, b.x1 + r); x++) {
        let near = 0;
        for (let dy = -r; dy <= r && !near; dy++)
          for (let dx = -r; dx <= r && !near; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && label[yy * W + xx] === k + 1) near = 1;
          }
        if (near && fgRaw[y * W + x]) mask[y * W + x] = 1;
      }
    for (const m of slantedSplit(mask, fgRaw, W, H, 0)) pieces.push(m);
  });
  let rects = pieces
    .filter((b) => b.area >= n * 0.012)
    .map((b) => ({ x0: b.x0, y0: b.y0, x1: Math.min(W, b.x1 + 1), y1: Math.min(H, b.y1 + 1) }))
    .filter((b) => (b.x1 - b.x0) / W >= minPanel && (b.y1 - b.y0) / H >= minPanel * 0.6);
  // a box inside another (an inset drawn over a bigger panel) is kept only when it is small next to it
  const areaOf = (b: { x0: number; y0: number; x1: number; y1: number }) => (b.x1 - b.x0) * (b.y1 - b.y0);
  const inter = (a: typeof rects[number], b: typeof rects[number]) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  rects = rects.filter((a) => !rects.some((b) => b !== a && areaOf(b) > areaOf(a) && inter(a, b) > 0.85 * areaOf(a) && areaOf(a) > 0.35 * areaOf(b)));
  // pieces that overlap a lot (balloons spilling over a gutter, a broken panel) are one panel
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!, b = rects[j]!;
        if (inter(a, b) > 0.4 * Math.min(areaOf(a), areaOf(b))) {
          rects[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          rects.splice(j, 1);
          changed = true;
          break outer;
        }
      }
  }
  return orderRects(rects.map((b) => ({ x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H })));
}

/**
 * Splits a region (mask of drawn pixels) along the best straight gutter of any angle that crosses it
 * completely, then splits both sides again. A gutter line: almost no drawn pixel on a 3-pixel-thick line
 * across the region's box, with drawn content on both sides.
 */
function slantedSplit(mask: Uint8Array, fg: Uint8Array, W: number, H: number, depth: number): { x0: number; y0: number; x1: number; y1: number; area: number }[] {
  let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x]) {
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const self = { x0, y0, x1, y1, area };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (!area || depth > 6 || bw < W * 0.16 || bh < H * 0.1) return area ? [self] : [];
  const minSide = W * H * 0.012;
  type Cut = { score: number; side: (x: number, y: number) => boolean };
  let best: Cut | null = null;
  const tryLine = (ax: number, ay: number, bx: number, by: number, horizontal: boolean) => {
    const len = horizontal ? bw : bh;
    let crossed = 0, drawn = 0, run = 0, maxRun = 0, runs = 0;
    for (let t = 0; t < len; t++) {
      const f = t / Math.max(1, len - 1);
      const cx = Math.round(ax + (bx - ax) * f), cy = Math.round(ay + (by - ay) * f);
      let hit = false;
      for (let d = -1; d <= 1; d++) {
        const xx = horizontal ? cx : cx + d, yy = horizontal ? cy + d : cy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = yy * W + xx;
        crossed++;
        if (mask[i] && fg[i]) ((drawn++), (hit = true));
      }
      if (hit) {
        if (run === 0) runs++;
        run++;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    if (crossed < len * 2) return;
    const ratio = drawn / crossed;
    // a clean gutter, or one crossed by a few thin strokes (a sword, a balloon tail, speed lines)
    if (ratio > 0.06 || (ratio > 0.015 && (maxRun > len * 0.035 || runs > 4))) return;
    // drawn content on both sides, each side large enough
    const side = horizontal ? (x: number, y: number) => y < ay + (by - ay) * ((x - ax) / Math.max(1, bx - ax)) : (x: number, y: number) => x < ax + (bx - ax) * ((y - ay) / Math.max(1, by - ay));
    let a = 0;
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) if (mask[y * W + x] && side(x, y)) a += 4;
    if (a < minSide || area - a < minSide) return;
    // prefer clean, then horizontal (reading rows first), then balanced cuts
    const score = ratio * 10 + (horizontal ? 0 : 0.05) + Math.abs(a / area - 0.5) * 0.02;
    if (!best || score < best.score) best = { score, side };
  };
  const stepY = Math.max(2, Math.round(bh / 120)), stepX = Math.max(2, Math.round(bw / 120));
  const tiltH = Math.round(bh * 0.35), tiltW = Math.round(bw * 0.35);
  for (let ya = y0 + 4; ya <= y1 - 4; ya += stepY)
    for (let d = -Math.min(tiltH, Math.round(bw * 0.4)); d <= Math.min(tiltH, Math.round(bw * 0.4)); d += stepY) {
      const yb = ya + d;
      if (yb <= y0 + 2 || yb >= y1 - 2) continue;
      tryLine(x0, ya, x1, yb, true);
    }
  for (let xa = x0 + 4; xa <= x1 - 4; xa += stepX)
    for (let d = -Math.min(tiltW, Math.round(bh * 0.4)); d <= Math.min(tiltW, Math.round(bh * 0.4)); d += stepX) {
      const xb = xa + d;
      if (xb <= x0 + 2 || xb >= x1 - 2) continue;
      tryLine(xa, y0, xb, y1, false);
    }
  const cut = best as Cut | null;
  if (!cut) return [self];
  const a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (cut.side(x, y)) a[i] = 1;
      else b[i] = 1;
    }
  return [...slantedSplit(a, fg, W, H, depth + 1), ...slantedSplit(b, fg, W, H, depth + 1)];
}

/**
 * Speech balloons and caption boxes: light, compact blobs (ellipse or rounded box) holding dark marks
 * (lettering). A page with balloons is a story page, whatever else is on it.
 */
export function countBalloons(gray: Uint8Array, W: number, H: number): number {
  return detectBalloons(gray, W, H).length;
}

/** Speech balloons and caption boxes (normalised rectangles, in reading order). */
export function detectBalloons(gray: Uint8Array, W: number, H: number): Rect[] {
  const found: Rect[] = [];
  const n = W * H;
  const light = (v: number) => v >= 215;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || !light(gray[i]!)) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % W, y = (j - x) / W;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of nb) if (k >= 0 && !seen[k] && light(gray[k]!)) ((seen[k] = 1), stack.push(k));
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, box = bw * bh;
    if (area < n * 0.0015 || area > n * 0.05) continue;
    // touching the page edge: a gutter or a margin, not a balloon
    if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) continue;
    const ar = bw / bh;
    if (ar < 0.3 || ar > 5) continue;
    // lettering: dark marks inside the blob's box, but the blob still fills most of it
    let dark = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (gray[y * W + x]! < 110) dark++;
    const fill = (area + dark) / box;
    if (fill < 0.6 || dark < box * 0.03 || dark > box * 0.45) continue;
    found.push({ x: x0 / W, y: y0 / H, w: bw / W, h: bh / H });
  }
  return orderRects(found);
}

/** Reading order for boxes that may overlap (slanted layouts): rows by vertical overlap, then left → right. */
export function orderRects(rs: Rect[]): Rect[] {
  const sorted = [...rs].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Rect[][] = [];
  for (const r of sorted) {
    const row = rows.find((g) => g.some((o) => Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y) > 0.5 * Math.min(o.h, r.h)));
    if (row) row.push(r);
    else rows.push([r]);
  }
  rows.sort((a, b) => Math.min(...a.map((r) => r.y)) - Math.min(...b.map((r) => r.y)));
  return rows.flatMap((g) => g.sort((a, b) => a.x - b.x));
}

function xyCut(gray: Uint8Array, W: number, H: number, bg: number, tol: number, ratio: number, opts: PanelDetectOptions): Rect[] {
  const minGutter = opts.minGutter ?? 0.006;
  const minPanel = opts.minPanel ?? 0.08;
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

/** Below this confidence the panels are not cut out: the page is shown whole, then travelled over. */
export const PANEL_TRUST = 0.8;

/**
 * A page whose panels cannot be cut out safely: the whole page first, then large full-width windows from
 * top to bottom (each about half the page, overlapping), so the details are readable and no panel is
 * ever cut in two by a wrong outline.
 */
export function pageTour(imageAspect: number, boxAspect: number): Rect[] {
  const out: Rect[] = [{ x: 0, y: 0, w: 1, h: 1 }];
  // a landscape page (double page) fits the frame already: left half, right half
  if (imageAspect >= boxAspect * 0.8) return [...out, { x: 0, y: 0, w: 0.55, h: 1 }, { x: 0.45, y: 0, w: 0.55, h: 1 }];
  const h = Math.min(0.6, Math.max(0.4, (imageAspect / boxAspect) * 1.35));
  const n = Math.max(2, Math.ceil((1 - h) / (h * 0.6)) + 1);
  for (let k = 0; k < n; k++) out.push({ x: 0, y: +((k * (1 - h)) / (n - 1)).toFixed(4), w: 1, h });
  return out;
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
  // the window stays on the page whenever it fits (never a half-empty frame); when it is wider (or taller)
  // than the page, the page is centred so the empty bands are even on both sides
  const x = w <= imageAspect ? Math.min(Math.max(cx - w / 2, 0), imageAspect - w) : (imageAspect - w) / 2;
  const y = h <= 1 ? Math.min(Math.max(cy - h / 2, 0), 1 - h) : (1 - h) / 2;
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
