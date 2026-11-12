import { describe, expect, it } from 'vitest';
import { detectPanels, pathAt, windowFor } from '../../src/core';

function page(W: number, H: number, rects: [number, number, number, number][]): Uint8Array {
  const g = new Uint8Array(W * H).fill(250);
  rects.forEach(([x, y, w, h], i) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) g[yy * W + xx] = 40 + ((xx * 7 + yy * 3 + i * 50) % 120);
  });
  return g;
}

describe('panel detection (XY-cut)', () => {
  it('finds panels of a 3-row page in reading order', () => {
    const W = 300, H = 450;
    const g = page(W, H, [
      [10, 10, 280, 130], // row 1: one wide panel
      [10, 155, 135, 140], [155, 155, 135, 140], // row 2: two panels
      [10, 310, 85, 130], [105, 310, 85, 130], [200, 310, 90, 130], // row 3: three panels
    ]);
    const p = detectPanels(g, W, H);
    expect(p).toHaveLength(6);
    expect(p[0]!.w).toBeCloseTo(280 / W, 2);
    expect(p[1]!.x).toBeLessThan(p[2]!.x);
    expect(p[2]!.y).toBeCloseTo(155 / H, 2);
    expect(p[5]!.x).toBeCloseTo(200 / W, 2);
  });
  it('returns a single region for an unpaneled illustration', () => {
    const W = 200, H = 300;
    expect(detectPanels(page(W, H, [[5, 5, 190, 290]]), W, H)).toHaveLength(1);
  });
});

describe('camera path', () => {
  it('windows keep the frame aspect, contain the panel and stay inside the image', () => {
    const w = windowFor({ x: 0.1, y: 0.05, w: 0.4, h: 0.2 }, 2 / 3, 16 / 9);
    expect(((w.w * 2) / 3) / w.h).toBeCloseTo(16 / 9, 6);
    expect(w.x).toBeLessThanOrEqual(0.1);
    expect(w.x + w.w).toBeGreaterThanOrEqual(0.5);
    expect(w.y).toBeGreaterThanOrEqual(0);
    expect(w.x + w.w).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('holds on each panel then eases to the next', () => {
    const a = { x: 0, y: 0, w: 0.5, h: 0.2 };
    const b = { x: 0.5, y: 0.5, w: 0.5, h: 0.2 };
    expect(pathAt([a, b], 0.1)).toEqual(a);
    expect(pathAt([a, b], 0.9)).toEqual(b);
    const mid = pathAt([a, b], 0.42); // segment 0 moves for p in [0.325, 0.5)
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(0.5);
  });
});
