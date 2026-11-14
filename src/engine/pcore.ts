/**
 * P-CORE engine helpers (Node): narration decoding for the Audio Engine, encoder settings for the
 * alpha formats, and post-render validation that reads the produced file (never trusts settings).
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeVoice, spectrumBands, type AudioEngineOptions } from '../pcore/audio';
import { type PCoreEvent, type PCoreFrame, type PCoreSettings, expressionTrack } from '../pcore/expression';
import { ffmpeg, ffprobe } from './ffmpeg';
import { animateV2, type PCoreFrameV2 } from '../pcore/v2/animation';
import type { PCoreV2Settings } from '../pcore/v2/config';
import { type DirectorResult, type CueEdit, type PCoreCue, directPCore } from '../pcore/v2/director';
import type { NarrativeSentence } from '../pcore/v2/narrative';

export type PCoreFormat = 'webm-vp9' | 'mov-prores4444' | 'mov-qtrle' | 'png-sequence';

export const PCORE_FORMATS: { id: PCoreFormat; label: string; ext: string; note: string }[] = [
  { id: 'mov-prores4444', label: 'ProRes 4444 (.mov, alpha)', ext: '.mov', note: 'Mezzanine with 10-bit alpha; large files' },
  { id: 'mov-qtrle', label: 'QuickTime Animation (.mov, lossless alpha)', ext: '.mov', note: 'Lossless RGBA; very large files' },
  { id: 'webm-vp9', label: 'WebM VP9 (alpha)', ext: '.webm', note: 'Small; plays with transparency in browsers and in Primestone' },
  { id: 'png-sequence', label: 'PNG sequence (alpha)', ext: '', note: 'One PNG per frame in a folder' },
];

import { PCORE_QUALITY, type PCoreQuality } from '../pcore/quality';
export { PCORE_QUALITY, type PCoreQuality };

export function pcoreEncoderArgs(format: PCoreFormat, quality: PCoreQuality = 'final'): string[] {
  const q = PCORE_QUALITY[quality];
  switch (format) {
    case 'webm-vp9':
      return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(q.crf), '-row-mt', '1', '-deadline', q.deadline, '-cpu-used', String(q.cpuUsed), '-auto-alt-ref', '0'];
    case 'mov-prores4444':
      return ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-alpha_bits', '16'];
    case 'mov-qtrle':
      return ['-c:v', 'qtrle', '-pix_fmt', 'argb'];
    case 'png-sequence':
      return ['-c:v', 'png', '-pix_fmt', 'rgba'];
  }
}

/** Mono float PCM of [offset, offset+dur] of the narration (16 kHz is plenty for the features). */
export async function decodePcm(file: string, offsetSec: number, durationSec: number, rate = 16000, signal?: AbortSignal): Promise<Float32Array> {
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', offsetSec.toFixed(4), '-t', durationSec.toFixed(4), '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { collectStdout: true, signal });
  const n = Math.floor(stdout.byteLength / 4);
  const out = new Float32Array(n);
  out.set(new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + n * 4)));
  // pad to the requested length (silence after the end of the file)
  const want = Math.round(durationSec * rate);
  if (out.length >= want) return out;
  const padded = new Float32Array(want);
  padded.set(out);
  return padded;
}

/**
 * Parameter frames for a P-CORE clip. Voice features are computed on the whole narration (so the
 * normalisation does not depend on where the clip starts), then cut to the clip's window.
 */
export async function pcoreFrames(
  audioPath: string | null,
  o: { offsetSec: number; durationSec: number; fps: number; events?: PCoreEvent[]; settings?: Partial<PCoreSettings>; audio?: Partial<AudioEngineOptions>; signal?: AbortSignal },
): Promise<PCoreFrame[]> {
  const frames = Math.round(o.durationSec * o.fps);
  if (!audioPath) {
    const silent = analyzeVoice(new Float32Array(Math.round(o.durationSec * 16000)), 16000, { fps: o.fps });
    return expressionTrack(silent, o.fps, o.events ?? [], o.settings).slice(0, frames);
  }
  const pre = Math.min(o.offsetSec, 3); // warm-up so smoothing starts in the right state
  const pcm = await decodePcm(audioPath, o.offsetSec - pre, o.durationSec + pre, 16000, o.signal);
  const voice = analyzeVoice(pcm, 16000, { ...o.audio, fps: o.fps });
  const shifted = (o.events ?? []).map((e) => ({ ...e, time: e.time - (o.offsetSec - pre) }));
  const skip = Math.round(pre * o.fps);
  return expressionTrack(voice, o.fps, shifted, o.settings).slice(skip, skip + frames);
}

export interface AlphaCheck {
  ok: boolean;
  pixFmt: string;
  frames: number;
  durationSec: number;
  width: number;
  height: number;
  /** Alpha range measured on decoded frames (0 = transparent somewhere, 255 = opaque somewhere). */
  alphaMin: number;
  alphaMax: number;
  problems: string[];
}

/** Reads the rendered file back and proves it carries a real, used alpha channel. */
export async function validateAlpha(file: string, expect: { frames: number; width: number; height: number; fps: number }, format: PCoreFormat): Promise<AlphaCheck> {
  const problems: string[] = [];
  let pixFmt = '';
  let frames = 0;
  let width = 0;
  let height = 0;
  let durationSec = 0;
  let sample = file;
  if (format === 'png-sequence') {
    const files = fs.readdirSync(file).filter((f) => f.endsWith('.png')).sort();
    frames = files.length;
    sample = path.join(file, files[Math.floor(files.length / 2)] ?? files[0] ?? 'missing.png');
    durationSec = frames / expect.fps;
  }
  const { stdout } = await ffprobe(['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,width,height,nb_read_packets:format=duration', '-of', 'json', sample]);
  const j = JSON.parse(stdout.toString()) as { streams: { pix_fmt: string; width: number; height: number; nb_read_packets?: string }[]; format: { duration?: string } };
  const st = j.streams[0];
  pixFmt = st?.pix_fmt ?? '';
  width = st?.width ?? 0;
  height = st?.height ?? 0;
  if (format !== 'png-sequence') {
    frames = Number(st?.nb_read_packets ?? 0);
    durationSec = Number(j.format.duration ?? 0);
  }
  // VP9 stores alpha in a side stream: the container reports yuv420p, the libvpx decoder restores alpha
  const decoder = format === 'webm-vp9' ? ['-c:v', 'libvpx-vp9'] : [];
  if (format !== 'webm-vp9' && !/a|argb|rgba|bgra/.test(pixFmt.replace('yuv', '').replace('p10le', ''))) problems.push(`pixel format ${pixFmt} has no alpha`);
  if (width !== expect.width || height !== expect.height) problems.push(`size ${width}x${height} != ${expect.width}x${expect.height}`);
  if (frames !== expect.frames) problems.push(`frames ${frames} != ${expect.frames}`);
  // decode a middle frame's alpha plane and measure it
  let alphaMin = 255;
  let alphaMax = 0;
  try {
    const at = format === 'png-sequence' ? [] : ['-ss', ((expect.frames / expect.fps) * 0.5).toFixed(3)];
    const { stdout: a } = await ffmpeg(['-v', 'error', ...at, ...decoder, '-i', sample, '-frames:v', '1', '-vf', 'format=rgba,alphaextract,format=gray', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true });
    for (const v of a) {
      if (v < alphaMin) alphaMin = v;
      if (v > alphaMax) alphaMax = v;
    }
    if (!a.length) problems.push('no decodable frame');
  } catch (e) {
    problems.push(`alpha decode failed: ${(e as Error).message.slice(0, 120)}`);
  }
  if (alphaMin > 5) problems.push(`no transparent pixels (alpha min ${alphaMin})`);
  if (alphaMax < 200) problems.push(`no opaque pixels (alpha max ${alphaMax})`);
  return { ok: problems.length === 0, pixFmt, frames, durationSec, width, height, alphaMin, alphaMax, problems };
}

/**
 * P-CORE V2 frames for a clip window: voice features of the window (with a warm-up so the springs
 * start in the right state), then the animation engine with the director's cues (absolute times).
 */
export async function pcoreFramesV2(audioPath: string | null, o: { offsetSec: number; durationSec: number; fps: number; cues: PCoreCue[]; v2: PCoreV2Settings; seed?: number; signal?: AbortSignal; chapters?: { time: number; title: string }[] }): Promise<PCoreFrameV2[]> {
  const frames = Math.round(o.durationSec * o.fps);
  const pre = Math.min(o.offsetSec, 6);
  const pcm = audioPath ? await decodePcm(audioPath, o.offsetSec - pre, o.durationSec + pre, 16000, o.signal) : new Float32Array(Math.round((o.durationSec + pre) * 16000));
  const voice = analyzeVoice(pcm, 16000, { fps: o.fps });
  const skip = Math.round(pre * o.fps);
  // the HUD shows the real spectrum of the voice (only computed when the layer is on)
  const spectrum = o.v2.identity.layers.hud?.enabled ? spectrumBands(pcm, 16000, o.fps, 24) : undefined;
  return animateV2(voice, o.fps, o.cues, o.v2, o.seed ?? 7, o.offsetSec - pre, spectrum, o.chapters).slice(skip, skip + frames);
}

/**
 * Plans the P-CORE V2 cues for a whole narration (director). The voice is analysed at a coarse
 * rate (4 kHz, 10 frames/s): enough for pauses, energy and rhythm, light for long narrations.
 */
export async function planPCoreV2(audioPath: string, o: { sentences?: NarrativeSentence[]; v2: PCoreV2Settings; edits?: CueEdit[]; added?: PCoreCue[]; endSec?: number; signal?: AbortSignal }): Promise<DirectorResult> {
  const { stdout } = await ffmpeg(['-v', 'error', '-i', audioPath, ...(o.endSec ? ['-t', o.endSec.toFixed(3)] : []), '-vn', '-ac', '1', '-ar', '4000', '-f', 'f32le', 'pipe:1'], { collectStdout: true, signal: o.signal });
  const n = Math.floor(stdout.byteLength / 4);
  const pcm = new Float32Array(n);
  pcm.set(new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + n * 4)));
  const voice = analyzeVoice(pcm, 4000, { fps: 10 });
  return directPCore({ voice, fps: 10, sentences: o.sentences, settings: o.v2, edits: o.edits, added: o.added });
}
