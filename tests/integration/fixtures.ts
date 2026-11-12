import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, importMediaFile } from '../../src/engine';

export function tmpDir(prefix = 'ps-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Solid colour video with a sine tone. */
export async function makeColorClip(file: string, color: string, seconds: number, opts: { rate?: string; size?: string; freq?: number; audio?: boolean } = {}) {
  const { rate = '30', size = '640x360', freq = 440, audio = true } = opts;
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${rate}:d=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}:sample_rate=48000`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await ffmpeg(args);
  return file;
}

/** Variable frame rate clip (mix of 30 and 15 fps sections). */
export async function makeVfrClip(file: string) {
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=2', '-vf', "select='if(lt(t,1),1,not(mod(n,2)))'", '-fps_mode', 'vfr', '-c:v', 'libx264', file]);
  return file;
}

/** Reads the average RGB of a frame at time t. */
export async function frameColor(file: string, t: number): Promise<[number, number, number]> {
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', t.toFixed(4), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { collectStdout: true });
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
  for (const [i, s] of sentences.entries()) {
    const f = path.join(dir, `ns${i}.wav`);
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `flite=text='${s.replace(/['’:]/g, ' ')}':voice=slt`, '-af', 'volume=6dB', '-ar', '48000', '-ac', '1', f]);
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
