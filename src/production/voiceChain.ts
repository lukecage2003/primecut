/**
 * Narration cleanup — measurement and decisions (pure).
 *
 * The narration is measured on sampled windows (noise floor, speech level, hum, rumble, sibilance,
 * mud, clipping) and a chain of standard FFmpeg filters is chosen *from those measurements*:
 * nothing is applied "just in case", and every step records why it was chosen. The original file is
 * never modified; the engine renders a cleaned copy (see engine/voice.ts).
 */

export interface VoiceQuality {
  /** dBFS of the quiet frames (10th percentile) — the background noise. */
  noiseFloorDb: number;
  /** dBFS of the loud frames (90th percentile) — the voice. */
  speechDb: number;
  snrDb: number;
  /** Mains hum found in the pauses (Hz) or null. */
  humHz: 50 | 60 | null;
  humDb: number;
  /** Share of power below 70 Hz (rumble, handling noise, DC). */
  rumbleShare: number;
  /** 95th percentile of sibilant (5–9 kHz) vs voice (0.3–4 kHz) power, in dB. */
  sibilanceDb: number;
  /** Low-mid (200–500 Hz) vs presence (1–4 kHz) power in the voice, dB. */
  mudDb: number;
  /** Share of samples at full scale. */
  clipShare: number;
  analysedSec: number;
}

export interface VoiceStep {
  id: 'highpass' | 'hum' | 'denoise' | 'gain' | 'expand' | 'deess' | 'mud' | 'presence' | 'compress' | 'warmth' | 'air' | 'level';
  filter: string;
  reason: string;
}

export interface VoiceCleanupOptions {
  /** Integrated loudness of the cleaned narration (LUFS). */
  targetLufs: number;
  /** Ceiling of the cleaned narration (dBFS, sample peak after the limiter). */
  ceilingDb: number;
  /** 0 = only corrective steps (hum, rumble, level), 1 = default, up to 1.5 = stronger denoise. */
  strength: number;
  /** 'natural': corrective cleanup; 'radio': broadcast voice (warmth, presence, air, firmer two-stage compression). */
  style?: 'natural' | 'radio';
}

export const DEFAULT_VOICE_CLEANUP: VoiceCleanupOptions = { targetLufs: -16, ceilingDb: -1.5, strength: 1, style: 'natural' };

// --- spectral analysis -------------------------------------------------------------------------

function fftPower(re: Float64Array, im: Float64Array): Float64Array {
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
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return p;
}

const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-20));
const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
};

/** Measure voice quality on PCM windows (mono float). */
export function measureVoiceQuality(chunks: Float32Array[], rate: number): VoiceQuality {
  const N = 4096;
  const hop = 2048;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const binHz = rate / N;
  const band = (p: Float64Array, lo: number, hi: number) => {
    let s = 0;
    for (let k = Math.max(1, Math.round(lo / binHz)); k <= Math.min(p.length - 1, Math.round(hi / binHz)); k++) s += p[k]!;
    return s;
  };
  const frames: { rms: number; p: Float64Array; x: Float32Array; at: number }[] = [];
  let samples = 0;
  let clipped = 0;
  for (const x of chunks) {
    samples += x.length;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) >= 0.999) clipped++;
    for (let s = 0; s + N <= x.length; s += hop) {
      let e = 0;
      const re = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const v = x[s + i]!;
        e += v * v;
        re[i] = v * win[i]!;
      }
      const p = fftPower(re, new Float64Array(N));
      // the level that tells voice from pauses ignores rumble below 80 Hz (it can dominate the
      // broadband RMS); Hann-window power is scaled back to an RMS-like value
      frames.push({ rms: db((2 * band(p, 80, Math.min(8000, rate / 2 - binHz))) / (N * N * 0.375)), p, x, at: s });
      void e;
    }
  }
  if (!frames.length) return { noiseFloorDb: -90, speechDb: -90, snrDb: 0, humHz: null, humDb: 0, rumbleShare: 0, sibilanceDb: -60, mudDb: 0, clipShare: 0, analysedSec: samples / rate };
  const levels = frames.map((f) => f.rms);
  // −120 dBFS is below any real recording (24-bit noise floor): digital silence reads as −120, not −200
  const floor = Math.max(-120, pct(levels, 0.1));
  const speech = Math.max(-120, pct(levels, 0.9));
  const quiet = frames.filter((f) => f.rms <= floor + 4);
  const loud = frames.filter((f) => f.rms >= speech - 10);
  // hum: a narrow peak at f0 (and harmonics) above the neighbouring bins, in the pauses
  const avg = (fs: typeof frames) => {
    const a = new Float64Array(N / 2);
    for (const f of fs) for (let k = 0; k < a.length; k++) a[k] = a[k]! + f.p[k]! / fs.length;
    return a;
  };
  const q = avg(quiet.length ? quiet : frames);
  // hum: exact-frequency power (windowed DFT) in the pauses — FFT bins are too coarse to tell
  // 50 from 60 Hz. Fundamental and 2nd harmonic only (voice harmonics can sit on 3×60 Hz).
  const qs = (quiet.length ? quiet : frames).slice(0, 400);
  const tone = (f: number) => {
    let acc = 0;
    const w = (2 * Math.PI * f) / rate;
    for (const fr of qs) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < N; i++) {
        const v = fr.x[fr.at + i]! * win[i]!;
        re += v * Math.cos(w * i);
        im -= v * Math.sin(w * i);
      }
      acc += re * re + im * im;
    }
    return acc / qs.length;
  };
  const peakOver = (f0: number) => {
    let sum = 0;
    for (const h of [1, 2]) {
      const f = f0 * h;
      // the quieter side is the background (the other may carry rumble or voice leakage)
      const lo = (tone(f - 14) + tone(f - 19)) / 2;
      const hi = (tone(f + 14) + tone(f + 19)) / 2;
      sum += db(tone(f)) - db(Math.min(lo, hi));
    }
    return sum / 2;
  };
  const h50 = peakOver(50);
  const h60 = peakOver(60);
  const humDb = Math.max(h50, h60);
  const all = avg(frames);
  const total = band(all, 20, rate / 2);
  const rumbleShare = band(all, 1, 70) / Math.max(total, 1e-20);
  const sib = loud.map((f) => db(band(f.p, 5000, Math.min(9000, rate / 2 - binHz))) - db(band(f.p, 300, 4000)));
  const mud = loud.map((f) => db(band(f.p, 200, 500)) - db(band(f.p, 1000, 4000)));
  return {
    noiseFloorDb: +floor.toFixed(1),
    speechDb: +speech.toFixed(1),
    snrDb: +(speech - floor).toFixed(1),
    humHz: humDb >= 10 ? (h50 >= h60 ? 50 : 60) : null,
    humDb: +humDb.toFixed(1),
    rumbleShare: +rumbleShare.toFixed(4),
    sibilanceDb: +pct(sib, 0.95).toFixed(1),
    mudDb: +pct(mud, 0.5).toFixed(1),
    clipShare: samples ? clipped / samples : 0,
    analysedSec: +(samples / rate).toFixed(1),
  };
}

/** Choose the cleanup chain from the measurements (level step is added by the engine after a measuring pass). */
export function planVoiceChain(q: VoiceQuality, opts: Partial<VoiceCleanupOptions> = {}): VoiceStep[] {
  const o = { ...DEFAULT_VOICE_CLEANUP, ...opts };
  const steps: VoiceStep[] = [];
  const rumble = q.rumbleShare > 0.05;
  steps.push({ id: 'highpass', filter: `highpass=f=${rumble ? 90 : 70}:poles=2`, reason: rumble ? `grondement sous 70 Hz (${(q.rumbleShare * 100).toFixed(0)} % de la puissance)` : 'retire la composante continue et les bruits de manipulation graves (inaudibles sur une voix)' });
  if (q.humHz) {
    const f = q.humHz;
    steps.push({ id: 'hum', filter: [1, 2, 3, 4].map((h) => `bandreject=f=${f * h}:width_type=h:w=${h === 1 ? 4 : 6}`).join(','), reason: `${f} Hz : ronflement secteur ${q.humDb.toFixed(0)} dB au-dessus de son voisinage dans les pauses` });
  }
  // denoise only when the background is audible; strength follows the measured SNR
  if (q.noiseFloorDb > -62 && q.snrDb < 50 && o.strength > 0) {
    const nr = Math.round(Math.max(6, Math.min(24, (36 - q.snrDb * 0.5) * o.strength)));
    const nf = Math.round(Math.max(-80, Math.min(-20, q.noiseFloorDb)));
    steps.push({ id: 'denoise', filter: `afftdn@dn=nr=${nr}:nf=${nf}:tn=1:rf=${Math.max(-80, nf - 30)}`, reason: `bruit de fond à ${q.noiseFloorDb} dBFS (voix/bruit ${q.snrDb} dB) : réduction spectrale de ${nr} dB` });
  }
  // dynamics (de-esser, compressor) have absolute thresholds: bring the voice to a nominal level first
  const pre = Math.max(-12, Math.min(24, -18 - q.speechDb));
  if (Math.abs(pre) >= 1) steps.push({ id: 'gain', filter: `volume=${pre.toFixed(1)}dB`, reason: `crêtes de voix à ${q.speechDb} dBFS : ${pre > 0 ? '+' : ''}${pre.toFixed(1)} dB avant le traitement dynamique pour que ses seuils agissent comme prévu` });
  // radio voice: a gentle downward expander after the gain: what lies well under the voice (breaths, room,
  // what the denoiser left) is lowered by up to 12 dB, so the compression that follows does not lift it
  if (o.style === 'radio' && o.strength > 0) steps.push({ id: 'expand', filter: 'agate=threshold=0.012:ratio=2:range=0.25:attack=8:release=180:knee=4', reason: 'voix radio : expandeur doux (−12 dB au plus sous la voix) pour que la compression ne remonte pas le souffle et l’ambiance' });
  if (q.sibilanceDb > -6 && o.strength > 0) steps.push({ id: 'deess', filter: `deesser=i=${q.sibilanceDb > 2 ? 1 : 0.7}:m=0.5:f=0.5`, reason: `sibilance forte (5–9 kHz à ${q.sibilanceDb} dB par rapport à la voix)` });
  if (q.mudDb > 8 && o.strength > 0) steps.push({ id: 'mud', filter: 'equalizer=f=320:t=q:w=1.1:g=-3', reason: `bas-médiums chargés (200–500 Hz ${q.mudDb} dB au-dessus de la présence)` });
  else if (q.mudDb > -2 && q.mudDb <= 8 && q.sibilanceDb < -18 && o.strength > 0) steps.push({ id: 'presence', filter: 'equalizer=f=3200:t=q:w=1:g=2', reason: 'voix terne (peu de présence et d’air) : +2 dB à 3,2 kHz' });
  if (o.style === 'radio' && o.strength > 0) {
    // broadcast voice: body, intelligibility and air, measured so nothing already present is pushed further
    if (q.mudDb <= 4) steps.push({ id: 'warmth', filter: 'equalizer=f=140:t=q:w=0.9:g=2.5', reason: 'voix radio : rondeur dans les graves (+2,5 dB à 140 Hz)' });
    if (!steps.some((x) => x.id === 'presence') && q.sibilanceDb < -4) steps.push({ id: 'presence', filter: 'equalizer=f=3500:t=q:w=1.2:g=3', reason: 'voix radio : présence et intelligibilité (+3 dB à 3,5 kHz)' });
    if (q.sibilanceDb < -10) steps.push({ id: 'air', filter: 'treble=g=2:f=10000:t=s', reason: 'voix radio : air et brillance (+2 dB au-dessus de 10 kHz)' });
    steps.push({ id: 'compress', filter: 'acompressor=threshold=-24dB:ratio=3.5:attack=8:release=140:knee=6:makeup=3,acompressor=threshold=-12dB:ratio=2:attack=3:release=80:knee=3', reason: 'voix radio : compression en deux étages (niveau constant, voix posée et dense)' });
  } else steps.push({ id: 'compress', filter: 'acompressor=threshold=-21dB:ratio=2.5:attack=12:release=180:knee=4', reason: 'compression douce : égalise le niveau entre passages forts et faibles' });
  void o.targetLufs;
  return steps;
}

/** Final gain + limiter from the measured loudness of the processed chain. */
export function levelStep(measuredLufs: number | null, opts: Partial<VoiceCleanupOptions> = {}): VoiceStep {
  const o = { ...DEFAULT_VOICE_CLEANUP, ...opts };
  const gain = measuredLufs == null ? 0 : Math.max(-20, Math.min(24, o.targetLufs - measuredLufs));
  const limit = Math.pow(10, o.ceilingDb / 20).toFixed(4);
  return { id: 'level', filter: `volume=${gain.toFixed(2)}dB,alimiter=limit=${limit}:attack=2:release=60:level=disabled`, reason: measuredLufs == null ? 'limiteur seul (volume non mesurable)' : `volume ramené de ${measuredLufs.toFixed(1)} à ${o.targetLufs} LUFS, crêtes sous ${o.ceilingDb} dBFS` };
}
