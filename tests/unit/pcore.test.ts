import { describe, expect, it } from 'vitest';
import { createSequence, type MediaAsset } from '../../src/core';
import { analyzeVoice, silences } from '../../src/pcore/audio';
import { expressionTrack, markerEvents, semanticEvents } from '../../src/pcore/expression';
import { planPlacement, placeForShot, DEFAULT_PLACEMENT } from '../../src/pcore/placement';

const RATE = 16000;
/** Synthetic narration: segments of [seconds, amplitude] (voiced 180 Hz + harmonics). */
function voice(segs: [number, number][]): Float32Array {
  const total = segs.reduce((a, s) => a + s[0], 0);
  const x = new Float32Array(Math.round(total * RATE));
  let i = 0;
  for (const [d, amp] of segs) {
    const n = Math.round(d * RATE);
    for (let k = 0; k < n; k++, i++) {
      const t = i / RATE;
      const syll = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t); // ~4 syllables/s
      x[i] = amp * syll * (Math.sin(2 * Math.PI * 180 * t) + 0.4 * Math.sin(2 * Math.PI * 900 * t) + 0.15 * Math.sin(2 * Math.PI * 3000 * t));
    }
  }
  return x;
}

describe('P-CORE audio engine', () => {
  it('detects silences at the right place with hysteresis (no flicker between syllables)', () => {
    const v = analyzeVoice(voice([[2, 0.3], [1.2, 0], [2, 0.3], [0.2, 0], [1, 0.3]]), RATE, { fps: 30 });
    const s = silences(v, 30);
    // the 1.2 s pause is a silence, the 0.2 s gap is not
    expect(s.length).toBe(1);
    expect(Math.abs(s[0]!.start - 2)).toBeLessThan(0.15);
    expect(Math.abs(s[0]!.end - 3.2)).toBeLessThan(0.15);
    expect(v.filter((f) => !f.speaking && f.silenceFor > 0).length).toBeGreaterThan(25);
  });

  it('keeps loudness and spectral balance separate and normalises to the narration itself', () => {
    const quiet = analyzeVoice(voice([[2, 0.05], [1, 0], [2, 0.05]]), RATE, { fps: 30 });
    const loud = analyzeVoice(voice([[2, 0.5], [1, 0], [2, 0.5]]), RATE, { fps: 30 });
    // the same delivery recorded at a different gain animates the same way
    const meanEnv = (v: typeof quiet) => v.slice(10, 50).reduce((a, f) => a + f.env, 0) / 40;
    expect(Math.abs(meanEnv(quiet) - meanEnv(loud))).toBeLessThan(0.05);
    expect(quiet[30]!.low).toBeGreaterThan(0);
    expect(quiet[30]!.high).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = analyzeVoice(voice([[1, 0.3], [0.5, 0]]), RATE, { fps: 25 });
    const b = analyzeVoice(voice([[1, 0.3], [0.5, 0]]), RATE, { fps: 25 });
    expect(a).toEqual(b);
  });
});

describe('P-CORE expression engine', () => {
  const v = analyzeVoice(voice([[2, 0.2], [2.5, 0], [1.5, 0.6], [2, 0.2]]), RATE, { fps: 30 });

  it('goes idle in long silences, speaks with the voice, and blends smoothly', () => {
    const fr = expressionTrack(v, 30);
    const states = fr.map((f) => f.state);
    expect(states.slice(0, 50)).toContain('speaking');
    expect(states.slice(60, 130)).toContain('silence');
    expect(states.slice(60, 130)).toContain('idle');
    // no jumps: the glow never moves more than a bounded step per frame
    for (let i = 1; i < fr.length; i++) expect(Math.abs(fr[i]!.glow - fr[i - 1]!.glow)).toBeLessThan(0.25);
    expect(fr.length).toBe(v.length);
  });

  it('turns once on a reveal, decomposes then rebuilds exactly on a transition, and honours markers', () => {
    const ev = [...markerEvents([{ frame: 30, name: 'P-CORE: REVEAL 2' }, { frame: 150, name: 'P-CORE: transition' }], 30)];
    expect(ev.map((e) => e.state)).toEqual(['reveal', 'transition']);
    const fr = expressionTrack(v, 30, ev);
    expect(fr[89]!.rotY).toBeGreaterThan(Math.PI * 1.8); // full turn at the end of the 2 s reveal
    expect(Math.max(...fr.slice(150, 195).map((f) => f.fragment))).toBeGreaterThan(0.8);
    expect(fr.at(-1)!.fragment).toBeLessThan(0.01); // reconstructed
  });

  it('finds narrative cues in the aligned script', () => {
    const ev = semanticEvents([
      { start: 0, end: 2, text: 'Despair a un plan.', section: 0 },
      { start: 2, end: 4, text: 'Mais pourquoi Krypton ?', section: 0 },
      { start: 4, end: 6, text: 'En réalité, tout était prévu.', section: 1 },
    ]);
    expect(ev.map((e) => e.state)).toEqual(['focus', 'transition', 'reveal']);
    // audio-only mode: semantic events can be disabled entirely
    expect(expressionTrack(v, 30, ev, { semantic: false }).some((f) => f.state === 'reveal')).toBe(false);
  });
});

describe('P-CORE adaptive placement', () => {
  const img = (w: number, h: number, extra: Partial<MediaAsset> = {}): MediaAsset =>
    ({ id: `m${w}x${h}`, name: 'x.png', kind: 'image', path: '/x.png', probe: { durationSec: 5, container: 'png', video: { codec: 'png', width: w, height: h, frameRate: { num: 25, den: 1 }, avgFrameRate: { num: 25, den: 1 }, isVFR: false, pixFmt: 'rgb24', rotation: 0 } }, fingerprint: { size: 1, mtimeMs: 1, partialHash: 'h' }, importedAt: '', ...extra }) as MediaAsset;

  it('leads when there is no illustration, steps aside over pictures, uses the free side of a page', () => {
    const hero = placeForShot(null, 1920, 1080, DEFAULT_PLACEMENT);
    expect(hero.mode).toBe('hero');
    expect(hero.transform.scale).toBeGreaterThan(0.6);
    const corner = placeForShot(img(1920, 1080), 1920, 1080, DEFAULT_PLACEMENT);
    expect(corner.mode).toBe('corner');
    expect(corner.transform.scale).toBeLessThan(0.3);
    // stays out of the subtitle band
    const size = corner.transform.scale * 1080;
    expect(540 + corner.transform.y + size / 2).toBeLessThan(1080 * (1 - DEFAULT_PLACEMENT.subtitleBand) + 1);
    const page = placeForShot(img(1000, 1500), 1920, 1080, DEFAULT_PLACEMENT);
    expect(page.mode).toBe('side');
    expect(Math.abs(page.transform.x)).toBeGreaterThan(1920 * 0.3); // in the pillarbox band, not over the page
  });

  it('builds placement segments from the timeline and enlarges on reveals', () => {
    const seq = createSequence('s', { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } });
    const pic = img(1920, 1080);
    const v1 = seq.tracks[0]!;
    v1.clips.push({ id: 'c1', mediaId: pic.id, name: 'p', start: 90, duration: 90, sourceIn: 0, speed: 1, enabled: true, gainDb: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, fadeIn: 0, fadeOut: 0 } as never);
    const segs = planPlacement(seq, { [pic.id]: pic }, 300, {}, [{ time: 7, duration: 1, state: 'reveal', source: 'marker' }]);
    expect(segs.map((g) => [g.start, g.end, g.mode])).toEqual([
      [0, 90, 'hero'],
      [90, 180, 'corner'],
      [180, 210, 'hero'],
      [210, 240, 'hero'],
      [240, 300, 'hero'],
    ]);
    expect(segs[3]!.transform.scale).toBeGreaterThan(segs[2]!.transform.scale);
  });

  it('character cards keep P-CORE beside them; a vertical frame keeps it out of the subtitle band', () => {
    const card = img(1920, 1080, { generator: { kind: 'character-card' } as never });
    const p = placeForShot(card, 1920, 1080, DEFAULT_PLACEMENT);
    expect(p.mode).not.toBe('hero');
    const v = placeForShot(img(1920, 1080), 1080, 1920, DEFAULT_PLACEMENT);
    const size = v.transform.scale * 1080;
    expect(960 + v.transform.y + size / 2).toBeLessThan(1920 * (1 - DEFAULT_PLACEMENT.subtitleBand) + 1);
  });

  it('a fixed position chosen by the creator overrides every shot and survives regeneration', () => {
    const seq = createSequence('s', { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } });
    const pic = img(1920, 1080);
    seq.tracks[0]!.clips.push({ id: 'c1', mediaId: pic.id, name: 'p', start: 0, duration: 150, sourceIn: 0, speed: 1, enabled: true, gainDb: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, fadeIn: 0, fadeOut: 0 } as never);
    const manual = { enabled: true, x: 0.8, y: 0.3, size: 0.3 };
    const segs = planPlacement(seq, { [pic.id]: pic }, 300, { manual, growOnReveal: false });
    expect(segs).toHaveLength(1);
    expect(segs[0]!.reason).toMatch(/position fixe/);
    // centre at 80 % / 30 % of the frame, 30 % of the short side
    expect(segs[0]!.transform.x).toBe(Math.round(0.8 * 1920 - 960));
    expect(segs[0]!.transform.y).toBe(Math.round(0.3 * 1080 - 540));
    expect(segs[0]!.transform.scale).toBeCloseTo(0.3, 3);
  });
});
