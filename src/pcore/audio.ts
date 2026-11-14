/**
 * P-CORE Audio Engine (pure, deterministic). Turns narration samples into one feature frame per
 * video frame. Loudness, spectral balance, transients and silence are kept as *separate* signals:
 * none of them is interpreted as an emotion here.
 *
 * Input: mono float samples (any rate). Output per frame:
 * - rms: raw RMS (linear) and level: normalised 0..1 against the narration's own loudness range
 * - env: smoothed envelope (fast attack, slower release) — what the animation follows
 * - low / mid / high: band energies (0..1, normalised per band) from 2nd-order band filters
 * - onset: transient strength (0..1) from the rise of the envelope
 * - speaking: hysteresis gate with minimum silence duration (no flicker between words)
 * - silenceFor: seconds since the voice stopped (0 while speaking)
 * - rate: syllable-like onsets per second over a 2 s window (speech rhythm)
 */

export interface VoiceFrame {
  rms: number;
  level: number;
  env: number;
  low: number;
  mid: number;
  high: number;
  onset: number;
  speaking: boolean;
  silenceFor: number;
  rate: number;
}

export interface AudioEngineOptions {
  fps: number;
  /** Envelope attack/release time constants (s). */
  attack: number;
  release: number;
  /** Gate thresholds relative to the normalised level (open > close: hysteresis). */
  openThreshold: number;
  closeThreshold: number;
  /** A pause shorter than this keeps the gate open (s). */
  minSilence: number;
  /** Global sensitivity multiplier applied to the envelope (1 = neutral). */
  sensitivity: number;
}

export const DEFAULT_AUDIO_OPTIONS: AudioEngineOptions = { fps: 30, attack: 0.03, release: 0.25, openThreshold: 0.2, closeThreshold: 0.12, minSilence: 0.35, sensitivity: 1 };

/** RBJ biquad band-pass (constant skirt gain), processed in place on a copy. */
function bandpass(x: Float32Array, rate: number, f0: number, q: number): Float32Array {
  const w = (2 * Math.PI * f0) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w);
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

function frameRms(x: Float32Array, rate: number, fps: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const per = rate / fps;
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * per);
    const b = Math.min(x.length, Math.floor((f + 1) * per));
    let s = 0;
    for (let i = a; i < b; i++) s += x[i]! * x[i]!;
    out[f] = b > a ? Math.sqrt(s / (b - a)) : 0;
  }
  return out;
}

function percentile(v: Float32Array, p: number): number {
  const s = Array.from(v).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

/** Maps a per-frame series to 0..1 between its quiet floor and loud ceiling (dB domain). */
function normaliseDb(v: Float32Array): Float32Array {
  const db = v.map((x) => 20 * Math.log10(x + 1e-6));
  const voiced = db.filter((x) => x > -70);
  const lo = voiced.length ? percentile(voiced, 0.1) : -60;
  const hi = voiced.length ? percentile(voiced, 0.97) : -10;
  const span = Math.max(6, hi - lo);
  return db.map((x) => Math.max(0, Math.min(1, (x - lo) / span)));
}

export function analyzeVoice(samples: Float32Array, sampleRate: number, opts: Partial<AudioEngineOptions> = {}): VoiceFrame[] {
  const o = { ...DEFAULT_AUDIO_OPTIONS, ...opts };
  const frames = Math.ceil((samples.length / sampleRate) * o.fps);
  const rms = frameRms(samples, sampleRate, o.fps, frames);
  const level = normaliseDb(rms);
  const low = normaliseDb(frameRms(bandpass(samples, sampleRate, 180, 0.9), sampleRate, o.fps, frames));
  const mid = normaliseDb(frameRms(bandpass(samples, sampleRate, 1000, 0.9), sampleRate, o.fps, frames));
  const high = normaliseDb(frameRms(bandpass(samples, sampleRate, Math.min(4000, sampleRate * 0.4), 0.9), sampleRate, o.fps, frames));
  const ka = 1 - Math.exp(-1 / (o.attack * o.fps));
  const kr = 1 - Math.exp(-1 / (o.release * o.fps));
  const out: VoiceFrame[] = [];
  let env = 0;
  let open = false;
  let below = 0;
  let silent = 0;
  const onsets: number[] = [];
  for (let f = 0; f < frames; f++) {
    const target = Math.min(1, level[f]! * o.sensitivity);
    const prev = env;
    env += (target - env) * (target > env ? ka : kr);
    // scaled so strong attacks stay below saturation (emphasis is chosen among the strongest)
    const onset = Math.max(0, Math.min(1, (env - prev) * 2));
    if (onset > 0.0833 && (onsets.length === 0 || f - onsets.at(-1)! > o.fps * 0.12)) onsets.push(f);
    // gate with hysteresis + minimum silence
    if (target >= o.openThreshold) {
      open = true;
      below = 0;
    } else if (open && target < o.closeThreshold) {
      below++;
      if (below / o.fps >= o.minSilence) open = false;
    }
    silent = open ? 0 : silent + 1 / o.fps;
    while (onsets.length && onsets[0]! < f - 2 * o.fps) onsets.shift();
    out.push({ rms: rms[f]!, level: level[f]!, env, low: low[f]!, mid: mid[f]!, high: high[f]!, onset, speaking: open, silenceFor: open ? 0 : silent, rate: onsets.length / 2 });
  }
  // the gate closes only after minSilence: the pause really began when the level dropped
  for (let f = 1; f < frames; f++) {
    if (out[f]!.speaking || !out[f - 1]!.speaking) continue;
    let k = f - 1;
    while (k > 0 && out[k]!.speaking && out[k]!.level < o.closeThreshold) {
      out[k]!.speaking = false;
      k--;
    }
    for (let j = k + 1, t = 0; j < frames && !out[j]!.speaking; j++) out[j]!.silenceFor = t += 1 / o.fps;
  }
  return out;
}

/** Silence intervals (s) from the gate. */
export function silences(frames: VoiceFrame[], fps: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s: number | null = null;
  frames.forEach((f, i) => {
    if (!f.speaking && s === null) s = i;
    if (f.speaking && s !== null) {
      out.push({ start: s / fps, end: i / fps });
      s = null;
    }
  });
  if (s !== null) out.push({ start: s / fps, end: frames.length / fps });
  return out;
}

/**
 * Voice spectrum per video frame: `bands` log-spaced band levels (0..1, each normalised over the whole
 * clip in dB) from 2nd-order band filters between 120 Hz and ~45 % of the sample rate. Real measurements of
 * the narration, used by the HUD spectrum ring.
 */
export function spectrumBands(samples: Float32Array, sampleRate: number, fps: number, bands = 24): Float32Array[] {
  const frames = Math.ceil((samples.length / sampleRate) * fps);
  const lo = 120;
  const hi = Math.min(7000, sampleRate * 0.45);
  const per: Float32Array[] = [];
  for (let b = 0; b < bands; b++) {
    const f0 = lo * Math.pow(hi / lo, (b + 0.5) / bands);
    per.push(normaliseDb(frameRms(bandpass(samples, sampleRate, f0, 2.2), sampleRate, fps, frames)));
  }
  const out: Float32Array[] = [];
  for (let f = 0; f < frames; f++) {
    const v = new Float32Array(bands);
    for (let b = 0; b < bands; b++) v[b] = per[b]![f]!;
    out.push(v);
  }
  return out;
}
