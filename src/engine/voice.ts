/**
 * Narration cleanup — rendering. Measures the narration, chooses a filter chain from the
 * measurements (production/voiceChain.ts), measures the loudness of the processed voice, then renders
 * a cleaned copy (48 kHz, 24-bit WAV) into the project cache. The original file is never touched;
 * the cleaned copy is an ordinary media item that can be swapped back at any time.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MediaAsset } from '../core/model';
import { DEFAULT_VOICE_CLEANUP, levelStep, measureVoiceQuality, planVoiceChain, type VoiceCleanupOptions, type VoiceQuality, type VoiceStep } from '../production/voiceChain';
import type { Interval } from '../production/align';
import { escapeFilterPath } from './exporter';
import { ffmpeg } from './ffmpeg';

export interface VoiceCleanupResult {
  path: string;
  cached: boolean;
  /** Processing latency that was measured and removed (ms). */
  latencyMs?: number;
  steps: VoiceStep[];
  before: VoiceQuality;
  after: VoiceQuality;
  beforeLufs: number | null;
  afterLufs: number | null;
  seconds: number;
}

const RATE = 24000;

/** Mono = average of the channels (FFmpeg's -ac 1 downmix can exceed full scale on in-phase stereo). */
async function decodeMono(file: string, at: number, len: number, signal?: AbortSignal): Promise<Float32Array> {
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', at.toFixed(3), '-t', len.toFixed(3), '-i', file, '-vn', '-ar', String(RATE), '-ac', '2', '-f', 'f32le', 'pipe:1'], { collectStdout: true, signal });
  const st = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.byteLength / 8) * 8));
  const out = new Float32Array(st.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (st[2 * i]! + st[2 * i + 1]!);
  return out;
}

/** Sample up to `count` windows of `len` seconds spread over the file (bounded cost on long files). */
export async function sampleVoiceQuality(file: string, durationSec: number, signal?: AbortSignal, count = 24, len = 5): Promise<VoiceQuality> {
  const n = Math.max(1, Math.min(count, Math.floor(durationSec / len)));
  const chunks: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const at = n === 1 ? 0 : ((durationSec - len) * i) / (n - 1);
    chunks.push(await decodeMono(file, Math.max(0, at), Math.min(len, durationSec), signal));
  }
  return measureVoiceQuality(chunks, RATE);
}

/**
 * Latency of a filter chain in samples at 48 kHz (FFT denoisers and look-ahead limiters delay the
 * signal; the amount depends on the FFmpeg build), measured with an impulse so it can be removed.
 */
export async function chainLatency(chain: string, signal?: AbortSignal): Promise<number> {
  const peak = async (af: string) => {
    const { stdout } = await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,1.002),0.8,0)+0.0005*sin(2*PI*997*t)':s=48000:d=3", '-af', af, '-ac', '1', '-f', 'f32le', 'pipe:1'], { collectStdout: true, signal });
    const x = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.byteLength / 4) * 4));
    let best = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i]!) > Math.abs(x[best]!)) best = i;
    return best;
  };
  return Math.max(0, (await peak(chain)) - (await peak('anull')));
}

const lufsOf = (stderr: string) => {
  const s = stderr.slice(stderr.lastIndexOf('Summary:'));
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(s);
  return m && Number(m[1]) > -70 ? Number(m[1]) : null;
};

/**
 * A pause to learn the background noise profile from. The denoiser uses the learned profile from
 * that moment on, so the earliest usable pause wins (a longer one only if it comes within 30 s).
 */
export function noiseSampleInterval(silences: Interval[]): Interval | null {
  const ok = silences.filter((s) => s.end - s.start >= 0.45).sort((x, y) => x.start - y.start);
  if (!ok.length) return null;
  const early = ok.filter((s) => s.start <= ok[0]!.start + 30);
  const best = early.reduce((x, y) => (y.end - y.start > x.end - x.start ? y : x));
  return { start: best.start + 0.05, end: Math.min(best.end - 0.05, best.start + 2.05) };
}

let bundledDenoiser: string | null = null;
/** The neural denoiser shipped with the app (set by the Electron host). */
export function setBundledDenoiser(p: string | null) {
  bundledDenoiser = p;
}

/**
 * The neural speech denoiser (DeepFilterNet3 through deep-filter-rt, MIT/Apache, model embedded, CPU):
 * PRIMESTONE_DENOISER, the copy shipped with the app, or the development build. Null when absent: the
 * FFmpeg spectral denoiser is used instead.
 */
export function findDenoiser(): string | null {
  const exe = process.platform === 'win32' ? 'primestone-denoise.exe' : 'primestone-denoise';
  const cands = [process.env.PRIMESTONE_DENOISER, bundledDenoiser, path.join(process.cwd(), 'vendor', 'denoise', exe), path.join(process.cwd(), 'tools', 'denoise', 'target', 'release', exe)];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

/** Runs the neural denoiser on a recording: 48 kHz mono WAV out, sample-aligned with the input. Cached. */
export async function neuralDenoise(file: string, bin: string, dir: string, attenDb: number, signal?: AbortSignal): Promise<string> {
  const key = crypto.createHash('sha256').update(JSON.stringify(['dfn3-v1', file, fs.statSync(file).size, fs.statSync(file).mtimeMs, attenDb])).digest('hex').slice(0, 20);
  const out = path.join(dir, `dfn-${key}.wav`);
  if (fs.existsSync(out)) return out;
  await fsp.mkdir(dir, { recursive: true });
  const rawIn = `${out}.in.f32`, rawOut = `${out}.out.f32`;
  try {
    await ffmpeg(['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', rawIn], { signal });
    await new Promise<void>((resolve, reject) => execFile(bin, [rawIn, rawOut, String(attenDb)], { signal, windowsHide: true, maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())));
    await ffmpeg(['-v', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', rawOut, '-c:a', 'pcm_f32le', `${out}.part.wav`], { signal });
    await fsp.rename(`${out}.part.wav`, out);
  } finally {
    await fsp.rm(rawIn, { force: true });
    await fsp.rm(rawOut, { force: true });
  }
  return out;
}

export async function cleanVoice(media: Pick<MediaAsset, 'path' | 'fingerprint' | 'probe'>, cacheDir: string, opts: Partial<VoiceCleanupOptions> & { silences?: Interval[] } = {}, signal?: AbortSignal): Promise<VoiceCleanupResult> {
  const t0 = Date.now();
  const o = { ...DEFAULT_VOICE_CLEANUP, ...opts };
  const dur = media.probe.durationSec;
  const before = await sampleVoiceQuality(media.path, dur, signal);
  const steps = planVoiceChain(before, o);
  const sample = noiseSampleInterval(o.silences ?? []);
  // neural denoising when the denoiser is present: always for the radio voice, otherwise when noise is audible
  const neural = o.strength > 0 && (o.style === 'radio' || steps.some((x) => x.id === 'denoise')) ? findDenoiser() : null;
  const key = crypto.createHash('sha256').update(JSON.stringify(['voice-v2', media.fingerprint.partialHash, media.fingerprint.size, steps.map((s) => s.filter), sample, { ...o, silences: undefined }, neural ? 'dfn3' : 'fft'])).digest('hex').slice(0, 20);
  const dir = path.join(cacheDir, 'voice');
  const out = path.join(dir, `voice-${key}.wav`);
  let src = media.path;
  if (neural) {
    // how much it may remove: deep for a noisy room, gentler on a clean recording (keeps the voice natural)
    const atten = before.snrDb < 25 ? 40 : before.snrDb < 40 ? 30 : 20;
    try {
      src = await neuralDenoise(media.path, neural, dir, atten, signal);
      const i = steps.findIndex((x) => x.id === 'denoise');
      const step = { id: 'denoise' as const, filter: 'anull', reason: `débruitage neuronal DeepFilterNet3 (local, réduction jusqu’à ${atten} dB) : bruit de fond, souffle, résonance de la pièce` };
      if (i >= 0) steps[i] = step;
      else steps.splice(1, 0, step);
    } catch (e) {
      if (signal?.aborted) throw e;
      src = media.path; // the spectral denoiser stays in the chain
    }
  }
  // the denoiser learns the noise profile in a real pause of this recording
  const dn = steps.find((s) => s.id === 'denoise' && s.filter.includes('afftdn'));
  const dnRaw = dn?.filter;
  if (dn && sample) {
    const cmd = `${out}.noise.cmd`;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(cmd, `${sample.start.toFixed(3)} afftdn@dn sn start;\n${sample.end.toFixed(3)} afftdn@dn sn stop;\n`);
    dn.filter = `asendcmd=f='${escapeFilterPath(cmd)}',${dn.filter}`;
    dn.reason += ` (profil de bruit appris dans la pause à ${sample.start.toFixed(1)} s)`;
  }
  const chain = steps.map((s) => s.filter).join(',');
  const meta = `${out}.json`;
  try {
    const m = JSON.parse(await fsp.readFile(meta, 'utf8')) as VoiceCleanupResult;
    await fsp.access(out);
    return { ...m, path: out, cached: true };
  } catch {
    /* not cached */
  }
  await fsp.mkdir(dir, { recursive: true });
  // pass 1: loudness of the original and of the processed voice (one decode)
  const p1 = await ffmpeg(['-v', 'info', '-i', media.path, '-i', src, '-vn', '-filter_complex', `[0:a]aresample=48000,ebur128@orig=framelog=verbose[o1];[1:a]aresample=48000,${chain},ebur128@proc=framelog=verbose[o2]`, '-map', '[o1]', '-f', 'null', '-', '-map', '[o2]', '-f', 'null', '-'], { signal });
  // the two summaries are told apart by the filter instance names
  const lufsNamed = (name: string) => {
    const at = p1.stderr.indexOf('Summary:', p1.stderr.lastIndexOf(`[${name} @`));
    const m = at < 0 ? null : /I:\s+(-?[\d.]+) LUFS/.exec(p1.stderr.slice(at, at + 400));
    return m && Number(m[1]) > -70 ? Number(m[1]) : null;
  };
  const beforeLufs = lufsNamed('ebur128@orig');
  const processed = lufsNamed('ebur128@proc');
  // pass 2: render the cleaned copy (atomic: .part then rename). The limiter can lower the loudness
  // of very peaky voices, so the result is measured and the gain corrected (at most twice).
  const part = `${out}.part.wav`;
  let level = levelStep(processed, o);
  // remove the chain's latency so the cleaned voice stays sample-aligned with the original
  const lat = await chainLatency(`${steps.map((s) => (s === dn ? dnRaw : s.filter)).join(',')},${level.filter}`, signal);
  const align = lat > 24 ? `,apad=pad_len=${lat},atrim=start_sample=${lat},asetpts=PTS-STARTPTS` : '';
  let afterLufs: number | null = null;
  let extra = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p2 = await ffmpeg(['-v', 'info', '-i', src, '-vn', '-af', `aresample=48000,${chain},${level.filter}${align},ebur128=framelog=verbose`, '-ac', String(Math.min(2, media.probe.audio?.channels ?? 1)), '-ar', '48000', '-c:a', 'pcm_s24le', part], { signal });
    afterLufs = lufsOf(p2.stderr);
    if (processed == null || afterLufs == null || Math.abs(o.targetLufs - afterLufs) <= 1) break;
    extra += o.targetLufs - afterLufs;
    if (extra > 12) break; // do not crush the voice into the limiter
    level = levelStep(processed - extra, o);
    level.reason += ` (${extra >= 0 ? '+' : ''}${extra.toFixed(1)} dB pour compenser le limiteur)`;
  }
  await fsp.rename(part, out);
  const all = [...steps, level];
  const after = await sampleVoiceQuality(out, dur, signal);
  const res: VoiceCleanupResult = { path: out, cached: false, latencyMs: +((lat / 48) ).toFixed(1), steps: all, before, after, beforeLufs, afterLufs, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  await fsp.writeFile(meta, JSON.stringify(res, null, 1));
  return res;
}

/** Renders the narration with long pauses shortened (keep = source ranges kept, in order). Cached. */
export async function renderTightened(media: Pick<MediaAsset, 'path' | 'fingerprint' | 'probe'>, keep: Interval[], cacheDir: string, signal?: AbortSignal): Promise<string> {
  const key = crypto.createHash('sha256').update(JSON.stringify(['tight-v2', media.path, media.fingerprint.size, media.fingerprint.partialHash, keep.map((k) => [+k.start.toFixed(3), +k.end.toFixed(3)])])).digest('hex').slice(0, 20);
  const dir = path.join(cacheDir, 'voice');
  const out = path.join(dir, `tight-${key}.wav`);
  try {
    await fsp.access(out);
    return out;
  } catch {
    /* render */
  }
  await fsp.mkdir(dir, { recursive: true });
  // a filter script file: hundreds of ranges on a 60-minute narration would overflow a command line
  const script = `${out}.filter.txt`;
  // every kept piece fades in and out over 8 ms: the joins are inaudible (no click where two pieces meet)
  const F = 0.008;
  const parts = keep
    .filter((k) => k.end - k.start > 0.02)
    .map((k, i, all) => {
      const len = k.end - k.start;
      const fin = i > 0 ? `,afade=t=in:d=${F}` : '';
      const fout = i < all.length - 1 ? `,afade=t=out:st=${Math.max(0, len - F).toFixed(4)}:d=${F}` : '';
      return `[0:a]atrim=start=${k.start.toFixed(4)}:end=${k.end.toFixed(4)},asetpts=PTS-STARTPTS${fin}${fout}[k${i}]`;
    });
  await fsp.writeFile(script, `${parts.join(';\n')};\n${parts.map((_, i) => `[k${i}]`).join('')}concat=n=${parts.length}:v=0:a=1[out]`);
  const part = `${out}.part.wav`;
  await ffmpeg(['-v', 'error', '-i', media.path, '-vn', '-filter_complex_script', script, '-map', '[out]', '-c:a', 'pcm_s24le', part], { signal });
  await fsp.rename(part, out);
  return out;
}

