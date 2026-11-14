import { describe, expect, it } from 'vitest';
import { PANEL_TRUST, detectPanelsDetailed, pageTour, regionPanels } from '../../src/core/panels';
import { untranscribedSounds } from '../../src/production/disfluency';
import { planVoiceChain } from '../../src/production/voiceChain';

/** White page, two dark panels separated by a slanted white gutter (top), one panel below. */
function slantedPage(W = 300, H = 450) {
  const g = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (x < 10 || x >= W - 10 || y < 10 || y >= H - 10) continue;
      if (y < 200) {
        // slanted gutter: from x=120 at the top to x=180 at y=200, 8 px wide
        const gx = 120 + (60 * y) / 200;
        if (Math.abs(x - gx) <= 4) continue;
        if (y > 190) continue;
        g[y * W + x] = x < gx ? 60 : 110;
      } else if (y > 212) g[y * W + x] = 80 + ((x * 7 + y * 3) % 40);
    }
  return { g, W, H };
}

describe('panels with slanted gutters', () => {
  it('finds the panels on both sides of a slanted cut, in reading order', () => {
    const { g, W, H } = slantedPage();
    const r = regionPanels(g, W, H, 255, 30);
    expect(r).toHaveLength(3);
    expect(r[0]!.x).toBeLessThan(r[1]!.x); // left then right
    expect(r[2]!.y).toBeGreaterThan(0.4); // the bottom panel last
    const d = detectPanelsDetailed(g, W, H);
    expect(d.panels.length).toBe(3);
  });
  it('an uncertain page is shown whole, then travelled over in large full-width windows', () => {
    const t = pageTour(0.65, 16 / 9);
    expect(t[0]).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(t.slice(1).every((r) => r.w === 1 && r.h >= 0.4)).toBe(true);
    expect(t.at(-1)!.y + t.at(-1)!.h).toBeCloseTo(1, 3);
    expect(PANEL_TRUST).toBeGreaterThan(0.5);
  });
});

describe('voice', () => {
  it('finds a sound the recogniser did not write between two words, not a pause or a sentence end', () => {
    const words = [
      { text: 'Apocalypse', start: 0, end: 0.6 },
      { text: 'est', start: 1.4, end: 1.6 }, // 0.8 s gap, voice on
      { text: 'là.', start: 1.7, end: 2 },
      { text: 'Puis', start: 2.8, end: 3 }, // after a sentence end
      { text: 'il', start: 3.6, end: 3.7 }, // 0.6 s gap, silent
    ];
    const r = untranscribedSounds(words, [{ start: 3.0, end: 3.6 }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.start).toBeGreaterThan(0.6);
    expect(r[0]!.end).toBeLessThan(1.4);
  });
  it('the radio voice adds warmth, presence and a two-stage compression', () => {
    const q = { noiseFloorDb: -70, speechDb: -18, snrDb: 52, humHz: null, humDb: 0, rumbleShare: 0, sibilanceDb: -20, mudDb: 0, clipShare: 0, analysedSec: 30 } as const;
    const radio = planVoiceChain({ ...q }, { style: 'radio' }).map((s) => s.id);
    expect(radio).toEqual(expect.arrayContaining(['warmth', 'presence', 'air', 'compress']));
    expect(planVoiceChain({ ...q }, { style: 'radio' }).find((s) => s.id === 'compress')!.filter.split('acompressor').length).toBe(3);
    expect(planVoiceChain({ ...q }).map((s) => s.id)).not.toContain('warmth');
  });
});

import { classifyComicImage } from '../../src/core/comicFormat';
describe('page kinds inside a comic book', () => {
  it('the first page is the cover; a flat page without panels is a title/credits page; balloons keep a page in the story', () => {
    expect(classifyComicImage({ width: 1300, height: 2000, pageNumber: 1, flat: 0.3 }).format).toBe('couverture');
    expect(classifyComicImage({ width: 1300, height: 2000, pageNumber: 3, flat: 0.8 }).format).toBe('générique');
    expect(classifyComicImage({ width: 1300, height: 2000, pageNumber: 3, flat: 0.8, balloons: 6 }).format).not.toBe('générique');
    const panels = [0, 1, 2].map((i) => ({ x: 0, y: i / 3, w: 1, h: 0.3 }));
    expect(classifyComicImage({ width: 1300, height: 2000, pageNumber: 2, flat: 0.68, panels }).format).toBe('planche'); // "Previously in…"
    expect(classifyComicImage({ width: 1300, height: 2000, pageNumber: 16, flat: 0.37 }).format).toBe('planche'); // a splash page is story
  });
});
