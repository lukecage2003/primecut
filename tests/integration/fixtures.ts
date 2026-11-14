import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, importMediaFile } from '../../src/engine';
import { listedEncoders } from '../../src/engine/videoEncoders';

/** Test videos: H.264 when this FFmpeg has x264, otherwise VP9 (the installer's LGPL FFmpeg has no x264). */
export async function testVideoCodec(): Promise<string[]> {
  return (await listedEncoders()).has('libx264') ? ['-c:v', 'libx264'] : ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M'];
}

export function tmpDir(prefix = 'ps-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Solid colour video with a sine tone. */
export async function makeColorClip(file: string, color: string, seconds: number, opts: { rate?: string; size?: string; freq?: number; audio?: boolean } = {}) {
  const { rate = '30', size = '640x360', freq = 440, audio = true } = opts;
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${rate}:d=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}:sample_rate=48000`);
  args.push(...(await testVideoCodec()), '-pix_fmt', 'yuv420p', '-g', '10');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await ffmpeg(args);
  return file;
}

/** Variable frame rate clip (mix of 30 and 15 fps sections). */
export async function makeVfrClip(file: string) {
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=2', '-vf', "select='if(lt(t,1),1,not(mod(n,2)))'", '-fps_mode', 'vfr', ...(await testVideoCodec()), file]);
  return file;
}

/** Reads the average RGB of a frame at time t. */
export async function frameColor(file: string, t: number, x?: number, y?: number): Promise<[number, number, number]> {
  const vf = x === undefined ? 'scale=1:1' : `format=rgb24,crop=3:3:${x - 1}:${y! - 1},scale=1:1`;
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', t.toFixed(4), '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { collectStdout: true });
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

/** RMS level (0..1) of audio between t0 and t1. */
export async function audioRms(file: string, t0: number, t1: number): Promise<number> {
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', t0.toFixed(4), '-t', (t1 - t0).toFixed(4), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { collectStdout: true });
  const s = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  let sum = 0;
  for (const x of s) sum += (x / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, s.length));
}

/** Synthetic narration (FFmpeg flite TTS): lead-in silence, sentences separated by pauses. Returns file + true sentence times. */
export async function makeNarration(dir: string, sentences: string[], pause = 0.8): Promise<{ file: string; truth: { start: number; end: number }[] }> {
  const parts: string[] = [];
  const truth: { start: number; end: number }[] = [];
  const sil = async (d: number, i: number) => {
    const f = path.join(dir, `nsil${i}.wav`);
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(d), '-ar', '48000', '-ac', '1', f]);
    parts.push(f);
  };
  let t = 0.6;
  await sil(0.6, 0);
  const tts = await hasFlite();
  for (const [i, s] of sentences.entries()) {
    const f = path.join(dir, `ns${i}.wav`);
    if (tts) await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `flite=text='${s.replace(/['’:]/g, ' ')}':voice=slt`, '-af', 'volume=6dB', '-ar', '48000', '-ac', '1', f]);
    else {
      // builds without libflite (e.g. Windows): speech-like voiced bursts, ~0.18 s per syllable
      const d = Math.max(0.6, syllablesOf(s) * 0.18).toFixed(2);
      await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `sine=f=170:sample_rate=48000:d=${d}`, '-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=pink:a=0.05:r=48000`, '-filter_complex', '[0][1]amix=2:normalize=0,tremolo=f=5.5:d=0.6,volume=4', '-ac', '1', f]);
    }
    const d = (await importMediaFile(f)).probe.durationSec;
    parts.push(f);
    truth.push({ start: t, end: t + d });
    t += d + pause;
    await sil(pause, i + 1);
  }
  const list = path.join(dir, 'nlist.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const file = path.join(dir, 'narration.wav');
  await ffmpeg(['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', file]);
  return { file, truth };
}

export async function makeImage(file: string, color: string, size = '1200x1800') {
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size},drawbox=c=${color}@0.6:t=fill`, '-frames:v', '1', file]);
  return file;
}

let fliteCache: boolean | null = null;
export async function hasFlite(): Promise<boolean> {
  if (process.env.PRIMESTONE_TEST_NO_FLITE) return false;
  if (fliteCache === null) {
    const { stdout } = await ffmpeg(['-filters'], { collectStdout: true }).catch(() => ({ stdout: Buffer.from('') }));
    fliteCache = / flite /.test(stdout.toString());
  }
  return fliteCache;
}

function syllablesOf(text: string): number {
  return (text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[aeiouy]+/g) ?? []).length || 1;
}
