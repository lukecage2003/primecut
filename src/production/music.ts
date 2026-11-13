/**
 * Music Studio — analysis of a decoded music signal and rule-based classification. Pure (no I/O).
 * Every value is a measurement or an explicit rule; nothing here is a trained model, and the moods are
 * labelled as estimates with their reasons. Input: mono float PCM at `sr` Hz (the engine decodes with
 * FFmpeg at 11 025 Hz).
 */

export interface MusicFeatures {
  /** Estimated tempo (BPM) and how sure the estimate is (0–1); half/double candidates are given. */
  bpm: number | null;
  bpmConfidence: number;
  bpmAlternatives: number[];
  /** The pulse reads equally well at half or double speed (e.g. beat + off-beats). */
  bpmOctaveAmbiguous: boolean;
  /** Attacks per second (density). */
  onsetRate: number;
  /** Spectral centroid in Hz (brightness). */
  centroidHz: number;
  /** RMS level every 0.5 s (dBFS), for energy curves, quiet passages and build-ups. */
  energyCurve: number[];
  /** Irregular deep modulation of the 300 Hz–3.4 kHz band (0–1): a sung voice is likely above ~0.35. Indicative. */
  vocalScore: number;
  /** Start and end similarity (0–1): a track that ends like it starts loops better. */
  loopScore: number;
}

export type Energy = 'basse' | 'moyenne' | 'haute';
export type Pace = 'lent' | 'modéré' | 'rapide';
export const MOODS = ['calme', 'mystère', 'tension', 'action', 'épique', 'mélancolie', 'lumineux'] as const;
export type Mood = (typeof MOODS)[number];

export interface MusicClass {
  energy: Energy;
  energyScore: number;
  pace: Pace | null;
  moods: { mood: Mood; score: number }[];
  /** Plain-language reasons (French), shown to the user. */
  reasons: string[];
  vocalsLikely: boolean;
}

// ---------- signal helpers ----------

function fftMag(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const N_FFT = 1024;
const HOP = 128;

/** Magnitude spectra of hop-spaced Hann frames. */
function spectra(pcm: Float32Array, maxFrames = 20000) {
  const win = new Float64Array(N_FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N_FFT - 1)));
  const frames = Math.min(maxFrames, Math.max(0, Math.floor((pcm.length - N_FFT) / HOP)));
  const out: Float32Array[] = [];
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = pcm[o + i]! * win[i]!;
      im[i] = 0;
    }
    fftMag(re, im);
    const m = new Float32Array(N_FFT / 2);
    for (let k = 0; k < N_FFT / 2; k++) m[k] = Math.hypot(re[k]!, im[k]!);
    out.push(m);
  }
  return out;
}

/** Tempo from the autocorrelation of the spectral-flux onset envelope (60–200 BPM, mild prior near 110). */
export function estimateTempo(onset: Float64Array, fps: number): { bpm: number | null; confidence: number; alternatives: number[]; octaveAmbiguous: boolean } {
  if (onset.length < fps * 6) return { bpm: null, confidence: 0, alternatives: [], octaveAmbiguous: false };
  // light smoothing: a beat period rarely falls on a whole number of frames
  const sm = onset.map((_, i) => 0.25 * (onset[i - 1] ?? onset[i]!) + 0.5 * onset[i]! + 0.25 * (onset[i + 1] ?? onset[i]!));
  const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
  const x = sm.map((v) => v - mean);
  const acf = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i]! * x[i + lag]!;
    return s / (x.length - lag);
  };
  const a0 = acf(0) || 1;
  const minLag = Math.floor((60 * fps) / 200), maxLag = Math.ceil((60 * fps) / 60);
  const vals: number[] = [];
  for (let L = minLag; L <= maxLag; L++) vals.push(acf(L));
  let best = -Infinity, bestLag = 0;
  vals.forEach((v, i) => {
    const L = minLag + i;
    const bpm = (60 * fps) / L;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    // candidate period L also explains 2L: rewards the true beat over its 2/3 or 3/2 neighbours
    const v2 = 2 * L < x.length / 2 ? acf(2 * L) : v;
    const score = (v + 0.5 * v2) * (0.8 + 0.2 * prior);
    if (score > best) { best = score; bestLag = L; }
  });
  if (!bestLag || vals[bestLag - minLag]! <= 0) return { bpm: null, confidence: 0, alternatives: [], octaveAmbiguous: false };
  // fundamental period: when a pulse 2× or 3× faster is nearly as clear, it is the beat level
  // (the slower readings stay as alternatives, and the ambiguity is reported)
  let octaveAmbiguous = false;
  const peakNear = (c: number) => Math.max(acf(c - 1), acf(c), acf(c + 1));
  const dbl = bestLag * 2;
  if (dbl <= maxLag && peakNear(dbl) >= 0.8 * acf(bestLag)) octaveAmbiguous = true;
  // shortest strong period whose multiple is the chosen one (fundamental of 2×, 3×, 5×…)
  const ref = acf(bestLag);
  for (let c = minLag; c < bestLag - 1; c++) {
    const v = acf(c);
    if (v < acf(c - 1) || v < acf(c + 1)) continue; // local peak only
    const ratio = bestLag / c;
    if (Math.abs(ratio - Math.round(ratio)) > 0.12 || Math.round(ratio) < 2) continue;
    if (v >= 0.8 * ref) octaveAmbiguous = true;
    if (v >= 0.85 * ref) {
      bestLag = c;
      break;
    }
  }
  // parabolic refinement of the lag
  const y0 = acf(bestLag - 1), y1 = acf(bestLag), y2 = acf(bestLag + 1);
  const d = y0 - 2 * y1 + y2 ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
  const bpm = (60 * fps) / (bestLag + Math.max(-0.5, Math.min(0.5, d)));
  const confidence = Math.max(0, Math.min(1, y1 / a0));
  const alternatives = [bpm / 2, bpm * 2, ...(octaveAmbiguous ? [bpm / 3] : [])].filter((b) => b >= 50 && b <= 220).map((b) => Math.round(b));
  return { bpm: +bpm.toFixed(1), confidence: +confidence.toFixed(2), alternatives, octaveAmbiguous };
}

export function analyzeMusicSignal(pcm: Float32Array, sr: number): MusicFeatures {
  const spec = spectra(pcm);
  const fps = sr / HOP;
  const binHz = sr / N_FFT;
  // spectral flux (log-compressed, half-wave rectified)
  const onset = new Float64Array(spec.length);
  let cNum = 0, cDen = 0;
  const lo = Math.floor(300 / binHz), hi = Math.ceil(3400 / binHz);
  const band = new Float64Array(spec.length);
  const levels = new Float64Array(spec.length);
  for (let f = 0; f < spec.length; f++) {
    const s = spec[f]!;
    let flux = 0, b = 0, level = 0;
    for (let k = 1; k < s.length; k++) {
      const v = Math.log1p(10 * s[k]!);
      level += v;
      if (f) flux += Math.max(0, v - Math.log1p(10 * spec[f - 1]![k]!));
      cNum += k * binHz * s[k]!;
      cDen += s[k]!;
      if (k >= lo && k <= hi) b += s[k]! ** 2;
    }
    onset[f] = flux;
    levels[f] = level;
    band[f] = Math.sqrt(b);
  }
  // relative to the track's mean level: a steady tone's numerical ripple stays far below a real attack,
  // and a quiet off-beat stays weaker than the beat
  const meanLevel = levels.reduce((a, b) => a + b, 0) / Math.max(1, levels.length);
  for (let f = 0; f < onset.length; f++) onset[f] = meanLevel > 1e-6 ? onset[f]! / meanLevel : 0;
  // no real attack anywhere → no pulse, no onsets (never a tempo invented from ripple)
  const sortedOn = Array.from(onset).sort((a, b) => a - b);
  const p99 = sortedOn[Math.floor(sortedOn.length * 0.99)] ?? 0;
  const pulsed = p99 >= 0.08;
  const t = pulsed ? estimateTempo(onset, fps) : { bpm: null, confidence: 0, alternatives: [], octaveAmbiguous: false };
  // onsets: local maxima above an adaptive threshold
  let onsets = 0;
  const W = Math.round(fps * 0.5);
  for (let f = 1; f < onset.length - 1; f++) {
    let m = 0, c = 0;
    for (let k = Math.max(0, f - W); k < Math.min(onset.length, f + W); k++) { m += onset[k]!; c++; }
    if (pulsed && onset[f]! > onset[f - 1]! && onset[f]! >= onset[f + 1]! && onset[f]! > 1.5 * (m / c) && onset[f]! > 0.08) onsets++;
  }
  // energy curve
  const step = Math.round(sr * 0.5);
  const energyCurve: number[] = [];
  for (let o = 0; o + step <= pcm.length; o += step) {
    let e = 0;
    for (let i = o; i < o + step; i++) e += pcm[i]! ** 2;
    energyCurve.push(+Math.max(-120, 10 * Math.log10(e / step + 1e-12)).toFixed(1));
  }
  // sung voice in the narration band (300 Hz–3.4 kHz): its level dips between syllables (deep
  // modulation) at IRREGULAR intervals; a steady pad barely moves and a drum pattern moves
  // periodically. Score = modulation depth × (1 − periodicity). Indicative only.
  let vocalScore = 0;
  if (band.length > fps * 4) {
    const m = band.reduce((a, b) => a + b, 0) / band.length;
    const sd = Math.sqrt(band.reduce((a, b) => a + (b - m) ** 2, 0) / band.length);
    const depth = m > 0 ? Math.min(1, sd / m / 0.8) : 0;
    const x = band.map((v) => v - m);
    const r0 = x.reduce((a, b) => a + b * b, 0) || 1;
    let per = 0;
    for (let L = Math.round(fps * 0.1); L <= Math.round(fps * 1.5) && L < x.length / 2; L++) {
      let r = 0;
      for (let i = 0; i + L < x.length; i++) r += x[i]! * x[i + L]!;
      per = Math.max(per, (r / (x.length - L)) / (r0 / x.length));
    }
    vocalScore = +(depth * (1 - Math.max(0, Math.min(1, per)))).toFixed(2);
  }
  // loop: average spectrum of the first vs last 4 s (cosine similarity)
  const avg = (from: number, to: number) => {
    const a = new Float64Array(N_FFT / 2);
    for (let f = Math.max(0, from); f < Math.min(spec.length, to); f++) for (let k = 0; k < a.length; k++) a[k]! += spec[f]![k]!;
    return a;
  };
  const k4 = Math.round(fps * 4);
  const A = avg(0, k4), B = avg(spec.length - k4, spec.length);
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < A.length; k++) { dot += A[k]! * B[k]!; na += A[k]! ** 2; nb += B[k]! ** 2; }
  return {
    bpm: t.bpm,
    bpmConfidence: t.confidence,
    bpmAlternatives: t.alternatives,
    bpmOctaveAmbiguous: t.octaveAmbiguous,
    onsetRate: +(onsets / Math.max(1, pcm.length / sr)).toFixed(2),
    centroidHz: Math.round(cDen ? cNum / cDen : 0),
    energyCurve,
    vocalScore,
    loopScore: na && nb ? +(dot / Math.sqrt(na * nb)).toFixed(2) : 0,
  };
}

/**
 * Energy, pace and moods from measurements (rules, explained). `lra` (EBU R128 loudness range, LU)
 * comes from the engine's loudness pass. Loudness itself is not used: tracks are mastered at
 * different levels, energy must not depend on it.
 */
export function classifyMusic(f: MusicFeatures, lra: number | null): MusicClass {
  const dens = Math.min(1, f.onsetRate / 6);
  const bright = Math.min(1, Math.max(0, (f.centroidHz - 600) / 2400));
  const compact = lra == null ? 0.5 : Math.min(1, Math.max(0, 1 - lra / 16));
  const energyScore = +(0.5 * dens + 0.3 * bright + 0.2 * compact).toFixed(2);
  const energy: Energy = energyScore < 0.35 ? 'basse' : energyScore < 0.6 ? 'moyenne' : 'haute';
  const sureTempo = f.bpm != null && f.bpmConfidence >= 0.2;
  const pace: Pace | null = !sureTempo ? null : f.bpm! < 85 ? 'lent' : f.bpm! < 125 ? 'modéré' : 'rapide';
  const dark = f.centroidHz < 1200;
  const rising = (() => {
    const c = f.energyCurve;
    if (c.length < 8) return false;
    const q = Math.floor(c.length / 4);
    const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    return m(c.slice(-q)) - m(c.slice(0, q)) > 4;
  })();
  const s: Record<Mood, number> = {
    calme: (1 - energyScore) * (pace === 'rapide' ? 0.4 : 1),
    mystère: (energy !== 'haute' ? 0.8 : 0.2) * (dark ? 1 : 0.4),
    tension: (energy === 'moyenne' ? 0.9 : 0.4) * (dark ? 1 : 0.6) * (pace === 'lent' ? 0.6 : 1),
    action: energyScore * (pace === 'rapide' ? 1 : pace === 'modéré' ? 0.7 : 0.4),
    épique: energyScore * ((lra ?? 0) >= 8 ? 1 : 0.6) * (rising ? 1 : 0.7),
    mélancolie: (1 - energyScore) * (dark ? 1 : 0.5) * (pace === 'lent' ? 1 : 0.6),
    lumineux: bright * (energy === 'haute' ? 0.7 : energy === 'basse' ? 0.6 : 1),
  };
  const moods = MOODS.map((m) => ({ mood: m, score: +s[m].toFixed(2) })).sort((a, b) => b.score - a.score);
  const reasons = [
    `énergie ${energy} (attaques ${f.onsetRate}/s, brillance ${f.centroidHz} Hz${lra != null ? `, dynamique ${lra.toFixed(1)} LU` : ''})`,
    pace ? `rythme ${pace} (≈ ${Math.round(f.bpm!)} BPM${f.bpmOctaveAmbiguous ? ` ou ${f.bpmAlternatives.join('/')} BPM, lecture ambiguë` : ''}, confiance ${f.bpmConfidence})` : 'rythme non déterminé (pulsation peu marquée)',
    ...(rising ? ['montée en intensité vers la fin'] : []),
    `ambiance estimée par règles : ${moods.slice(0, 2).map((m) => m.mood).join(', ')}`,
  ];
  const vocalsLikely = f.vocalScore >= 0.35;
  if (vocalsLikely) reasons.push(`voix chantée probable (modulation syllabique ${f.vocalScore}) : gêne possible sous la narration`);
  return { energy, energyScore, pace, moods, reasons, vocalsLikely };
}
