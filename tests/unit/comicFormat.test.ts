import { describe, expect, it } from 'vitest';
import { classifyComicImage, orderPanels } from '../../src/core';

const grid = (cols: number, rows: number) =>
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ({ x: c / cols + 0.01, y: r / rows + 0.01, w: 1 / cols - 0.02, h: 1 / rows - 0.02 }))).flat();

describe('comics image format', () => {
  it('tells covers, pages, spreads, webtoons and illustrations apart', () => {
    expect(classifyComicImage({ width: 1988, height: 3056, panels: null, saturation: 0.5 }).format).toBe('couverture');
    expect(classifyComicImage({ width: 1988, height: 3056, panels: grid(2, 3), saturation: 0.5 }).format).toBe('planche');
    expect(classifyComicImage({ width: 3976, height: 3056, panels: grid(4, 3), saturation: 0.5 }).format).toBe('double-page');
    expect(classifyComicImage({ width: 800, height: 6000, panels: grid(1, 6), saturation: 0.6 }).format).toBe('webtoon');
    expect(classifyComicImage({ width: 1920, height: 1080, panels: null, saturation: 0.5 }).format).toBe('illustration');
    expect(classifyComicImage({ width: 1200, height: 1800, panels: null, name: 'Batman 676 variant.jpg' }).format).toBe('couverture');
  });
  it('a black & white page is manga and read right to left; a colour page left to right', () => {
    const manga = classifyComicImage({ width: 1400, height: 2000, panels: grid(2, 2), saturation: 0.02 });
    expect(manga).toMatchObject({ format: 'planche', manga: true, readingOrder: 'rtl' });
    expect(classifyComicImage({ width: 1400, height: 2000, panels: grid(2, 2), saturation: 0.45 }).readingOrder).toBe('ltr');
    // a grey cover is not a manga page
    expect(classifyComicImage({ width: 1400, height: 2000, panels: null, saturation: 0.02 }).manga).toBe(false);
  });
  it('orders panels row by row, right to left for manga', () => {
    const p = grid(2, 2);
    const rtl = orderPanels(p, 'rtl');
    expect(rtl.map((q) => [Math.round(q.x * 2), Math.round(q.y * 2)])).toEqual([[1, 0], [0, 0], [1, 1], [0, 1]]);
    expect(orderPanels(p, 'ltr').map((q) => [Math.round(q.x * 2), Math.round(q.y * 2)])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });
});
