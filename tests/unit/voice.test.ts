import { describe, expect, it } from 'vitest';
import { levelStep, measureVoiceQuality, planVoiceChain } from '../../src/production';
import { noiseSampleInterval } from '../../src/engine/voice';

const RATE = 24000;
function signal(sec: number, f: (t: number) => number) {
  const x = new Float32Array(Math.round(sec * RATE));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < x.length; i++) x[i] = f(i / RATE);
  void rnd;
  return { x, rnd };
}
// voice-like phrases (harmonics of 180 Hz) with pauses
const voice = (t: number) => (Math.floor(t) % 3 === 2 ? 0 : 1) * (0.2 * Math.sin(2 * Math.PI * 180 * t) + 0.12 * Math.sin(2 * Math.PI * 360 * t) + 0.05 * Math.sin(2 * Math.PI * 1440 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));

describe('voice cleanup decisions', () => {
  it('a clean recording only gets the corrective minimum', () => {
    const { x } = signal(12, voice);
    const q = measureVoiceQuality([x], RATE);
    expect(q.humHz).toBeNull();
    const ids = planVoiceChain(q).map((s) => s.id);
    expect(ids).not.toContain('denoise');
    expect(ids).not.toContain('hum');
    expect(ids).toEqual(expect.arrayContaining(['highpass', 'compress']));
  });
  it('hum (50 vs 60 Hz), noise and rumble are measured and answered', () => {
    for (const f0 of [50, 60] as const) {
      let seed = 3;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
      const { x } = signal(12, (t) => voice(t) + 0.02 * Math.sin(2 * Math.PI * f0 * t) + 0.15 * Math.sin(2 * Math.PI * 20 * t) + 0.01 * rnd());
      const q = measureVoiceQuality([x], RATE);
      expect(q.humHz).toBe(f0);
      expect(q.rumbleShare).toBeGreaterThan(0.05);
      const steps = planVoiceChain(q);
      expect(steps.map((s) => s.id)).toEqual(expect.arrayContaining(['highpass', 'hum', 'denoise']));
      expect(steps.find((s) => s.id === 'hum')!.filter).toContain(`f=${f0}:`);
      expect(steps.find((s) => s.id === 'highpass')!.filter).toContain('f=90');
    }
  });
  it('level step targets the loudness and caps the gain', () => {
    expect(levelStep(-26, { targetLufs: -16 }).filter).toMatch(/^volume=10\.00dB,alimiter/);
    expect(levelStep(-60, { targetLufs: -16 }).filter).toMatch(/^volume=24\.00dB/);
    expect(levelStep(null).filter).toMatch(/^volume=0\.00dB/);
  });
  it('the noise profile is learned in the earliest usable pause', () => {
    expect(noiseSampleInterval([{ start: 0.5, end: 0.7 }, { start: 3, end: 3.8 }, { start: 20, end: 22 }, { start: 3000, end: 3010 }])).toEqual({ start: 20.05, end: 21.95 });
    const iv = noiseSampleInterval([{ start: 50, end: 50.6 }, { start: 3000, end: 3010 }])!;
    expect(iv.start).toBeCloseTo(50.05, 6);
    expect(iv.end).toBeCloseTo(50.55, 6);
    expect(noiseSampleInterval([{ start: 1, end: 1.2 }])).toBeNull();
  });
});

describe('quiet recordings', () => {
  it('a quiet voice is raised before the dynamics so de-esser and compressor thresholds act', () => {
    const quiet = (t: number) => 0.02 * voice(t);
    const q = measureVoiceQuality([signal(12, quiet).x], RATE);
    const steps = planVoiceChain(q);
    const gain = steps.find((s) => s.id === 'gain');
    expect(gain).toBeTruthy();
    expect(Number(/volume=([\d.]+)dB/.exec(gain!.filter)![1])).toBeGreaterThan(20);
    expect(steps.findIndex((s) => s.id === 'gain')).toBeLessThan(steps.findIndex((s) => s.id === 'compress'));
  });
});
