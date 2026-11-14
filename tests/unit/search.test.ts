import { describe, expect, it } from 'vitest';
import { detectPanelsDetailed } from '../../src/core';
import { parseTesseractTsv } from '../../src/engine/ocr';
import { searchEntries } from '../../src/production/search';

// Tesseract TSV layout (level page_num block_num par_num line_num word_num left top width height conf text).
// Synthetic sample written for this test, not the output of a real page.
const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '1\t1\t0\t0\t0\t0\t0\t0\t1000\t1500\t-1\t',
  '2\t1\t1\t0\t0\t0\t100\t100\t300\t80\t-1\t',
  '5\t1\t1\t1\t1\t1\t100\t100\t140\t40\t91.5\tTHANOS',
  '5\t1\t1\t1\t1\t2\t250\t100\t150\t40\t88\tARRIVE',
  '5\t1\t1\t1\t2\t1\t100\t150\t60\t30\t12\t~~',
  '5\t1\t2\t1\t1\t1\t600\t1200\t200\t50\t76\tBOOM!',
  '5\t1\t3\t1\t1\t1\t10\t10\t5\t5\t70\t|',
].join('\n');

describe('OCR output parsing', () => {
  it('keeps confident words, groups lines and blocks into normalised zones', () => {
    const r = parseTesseractTsv(TSV);
    expect(r.text).toBe('THANOS ARRIVE\nBOOM!');
    expect(r.zones).toHaveLength(2);
    expect(r.zones[0]).toEqual({ x: 0.1, y: 100 / 1500, w: 0.3, h: 40 / 1500 });
    expect(r.confidence).toBeCloseTo((91.5 + 88 + 76) / 300, 2);
    expect(parseTesseractTsv('')).toEqual({ text: '', confidence: 0, zones: [] });
  });
});

describe('media search (names, tags, descriptions, OCR — never pixels)', () => {
  const items = [
    { id: 'a', name: 'IMG_0001.jpg', path: '/c/Marvel/IMG_0001.jpg', description: 'Thanos porte le Gant de l’Infini' },
    { id: 'b', name: 'thanos-portrait.jpg', path: '/c/Marvel/thanos-portrait.jpg' },
    { id: 'c', name: 'page12.png', path: '/c/Infinity Gauntlet/page12.png', ocr: { text: 'LE GANT EST COMPLET' } },
    { id: 'd', name: 'hulk.jpg', path: '/c/Marvel/hulk.jpg', tags: ['Avengers'] },
  ];
  it('ranks by field weight and term rarity, and says which field matched', () => {
    const r = searchEntries(items, 'Thanos et le Gant');
    expect(r[0]!.item.id).toBe('a'); // description has both terms
    expect(r.map((x) => x.item.id)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(r.find((x) => x.item.id === 'd')).toBeUndefined();
    expect(r[0]!.matched[0]).toEqual({ field: 'description', terms: ['thanos', 'gant'] });
    expect(r.find((x) => x.item.id === 'c')!.matched[0]!.field).toBe('texte');
    expect(searchEntries(items, 'avengers')[0]!.item.id).toBe('d');
    expect(searchEntries(items, '   ')).toEqual([]);
  });
});

describe('panel detection confidence', () => {
  const W = 200;
  const H = 300;
  const page = (noise = 0, crossing = false) => {
    const g = new Uint8Array(W * H).fill(255);
    const box = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * W + x] = 40;
    };
    box(8, 8, 95, 140);
    box(105, 8, 192, 140);
    box(8, 150, 192, 292);
    let s = 7;
    if (noise) for (let i = 0; i < g.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      g[i] = Math.max(0, Math.min(255, g[i]! + ((s >>> 16) % (2 * noise + 1)) - noise));
    }
    if (crossing) for (let x = 60; x < 140; x++) g[145 * W + x] = 0; // a balloon tail crosses the horizontal gutter
    return g;
  };
  it('is high on clean gutters, survives scan noise, and drops when the layout is read loosely', () => {
    const clean = detectPanelsDetailed(page(), W, H);
    expect(clean.panels).toHaveLength(3);
    expect(clean.confidence).toBeGreaterThan(0.9);
    const noisy = detectPanelsDetailed(page(18), W, H);
    expect(noisy.panels).toHaveLength(3);
    const crossed = detectPanelsDetailed(page(0, true), W, H);
    expect(crossed.panels.length).toBeGreaterThanOrEqual(2);
    const blank = detectPanelsDetailed(new Uint8Array(W * H).fill(255), W, H);
    expect(blank.confidence).toBe(0);
  });
});
