import { describe, expect, it } from 'vitest';
import { analyzeMusicSignal, classifyMusic } from '../../src/production';

const SR = 11025;
let seed = 7;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
};

/** Click track: a short decaying noise burst on every beat, optional off-beat hats. */
function clicks(bpm: number, sec = 30, hats = false) {
  const x = new Float32Array(SR * sec);
  const beat = (60 / bpm) * SR;
  for (let b = 0; b * beat < x.length; b++) {
    for (const [off, amp, len] of (hats ? [[0, 0.8, 600], [0.5, 0.25, 200]] : [[0, 0.8, 600]]) as [number, number, number][]) {
      const o = Math.round((b + off) * beat);
      for (let i = 0; i < len && o + i < x.length; i++) x[o + i]! += amp * rnd() * Math.exp(-i / (len / 5));
    }
  }
  return x;
}
/** Noise shaped by a simple one-pole filter (low = dark, high = bright). */
function noise(sec: number, bright: boolean, am = 0) {
  const x = new Float32Array(SR * sec);
  let y = 0, prev = 0;
  for (let i = 0; i < x.length; i++) {
    const n = rnd();
    y = bright ? n - prev : 0.95 * y + 0.05 * n * 4;
    prev = n;
    x[i] = 0.3 * y * (am ? 0.5 + 0.5 * Math.sin((2 * Math.PI * am * i) / SR) : 1);
  }
  return x;
}

describe('music analysis', () => {
  it.each([70, 90, 120, 150, 175])('estimates the tempo of a %i BPM click track within 4 % (or reports the half/double)', (bpm) => {
    const f = analyzeMusicSignal(clicks(bpm, 30, true), SR);
    const ok = [f.bpm!, ...f.bpmAlternatives].some((b) => Math.abs(b - bpm) / bpm <= 0.04);
    expect(ok, `estimé ${f.bpm} (alt ${f.bpmAlternatives}) pour ${bpm}`).toBe(true);
    expect(Math.abs(f.bpm! - bpm) / bpm <= 0.04 || f.bpmConfidence < 1).toBe(true);
  });

  it('orders brightness and energy correctly', () => {
    const dark = analyzeMusicSignal(noise(12, false), SR);
    const bright = analyzeMusicSignal(noise(12, true), SR);
    expect(bright.centroidHz).toBeGreaterThan(dark.centroidHz + 800);
    const slow = classifyMusic(analyzeMusicSignal(clicks(70, 20), SR), 12);
    expect(slow.reasons.join(' ')).not.toMatch(/ambiguë/);
    const fast = classifyMusic(analyzeMusicSignal(clicks(170, 20, true), SR), 4);
    expect(fast.energyScore).toBeGreaterThan(slow.energyScore);
    expect(fast.pace).toBe('rapide');
    expect(slow.pace).toBe('lent');
    expect(fast.moods[0]!.mood).toBe('action');
    expect(fast.reasons.join(' ')).toMatch(/BPM/);
  });

  it('flags irregular syllable-rate modulation (sung voice) but not a steady sound or a regular drum pattern', () => {
    // "syllables": bursts of 120–300 ms with gaps, irregular
    const x = noise(20, true);
    let t = 0;
    const env = new Float32Array(x.length);
    while (t < x.length) {
      const on = Math.round(SR * (0.12 + 0.18 * (0.5 + 0.5 * rnd())));
      const off = Math.round(SR * (0.03 + 0.1 * (0.5 + 0.5 * rnd())));
      for (let i = 0; i < on && t + i < x.length; i++) env[t + i] = Math.sin((Math.PI * i) / on);
      t += on + off;
    }
    const sung = x.map((v, i) => v * env[i]!);
    expect(analyzeMusicSignal(sung, SR).vocalScore).toBeGreaterThanOrEqual(0.35);
    expect(analyzeMusicSignal(noise(20, true), SR).vocalScore).toBeLessThan(0.35);
    expect(analyzeMusicSignal(clicks(120, 20, true), SR).vocalScore).toBeLessThan(0.35);
  });

  it('gives no tempo for a sound without pulse instead of inventing one', () => {
    const f = analyzeMusicSignal(noise(12, false), SR);
    const c = classifyMusic(f, null);
    expect(c.pace === null || f.bpmConfidence < 0.2).toBe(true);
  });
});
