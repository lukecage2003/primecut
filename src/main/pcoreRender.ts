/**
 * P-CORE renderer host (main process). A hidden window runs the Three.js scene; frames come back
 * as straight-alpha RGBA and are piped into FFmpeg. One render at a time per window; the window is
 * destroyed afterwards. Output is validated by reading the file back (alpha, size, frame count).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { ffmpegPaths } from '../engine/ffmpeg';
import { type AlphaCheck, type PCoreFormat, pcoreEncoderArgs, validateAlpha } from '../engine/pcore';
import type { PCoreFrame, PCoreSettings } from '../pcore/expression';

export interface PCoreRenderJob {
  width: number;
  height: number;
  fps: { num: number; den: number };
  frames: PCoreFrame[];
  settings: PCoreSettings;
  composition: 'core' | 'floating' | 'minimal';
  seed: number;
  format: PCoreFormat;
  output: string;
  quality?: 'preview' | 'final';
  /** Narration window muxed into the file (mov/webm only) for a self-contained export. */
  audio?: { path: string; offsetSec: number };
}

function assetPath(...p: string[]) {
  const roots = [path.join(app.getAppPath(), 'assets', 'pcore'), path.join(process.resourcesPath ?? '', 'pcore'), path.join(process.cwd(), 'assets', 'pcore')];
  for (const r of roots) if (fs.existsSync(path.join(r, ...p))) return path.join(r, ...p);
  return path.join(roots[0]!, ...p);
}

let busy: Promise<unknown> = Promise.resolve();

export function renderPCore(job: PCoreRenderJob, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<AlphaCheck> {
  const run = busy.then(() => doRender(job, onProgress, signal));
  busy = run.catch(() => undefined);
  return run;
}

async function doRender(job: PCoreRenderJob, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<AlphaCheck> {
  const fps = job.fps.num / job.fps.den;
  const total = job.frames.length;
  if (!total) throw new Error('P-CORE: nothing to render');
  const isSeq = job.format === 'png-sequence';
  const tmp = isSeq ? `${job.output}.part` : `${job.output}.part${path.extname(job.output)}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  if (isSeq) await fsp.mkdir(tmp, { recursive: true });
  else await fsp.mkdir(path.dirname(job.output), { recursive: true });
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${job.width}x${job.height}`, '-framerate', `${job.fps.num}/${job.fps.den}`, '-i', 'pipe:0'];
  if (job.audio && !isSeq) args.push('-ss', job.audio.offsetSec.toFixed(4), '-t', (total / fps).toFixed(4), '-i', job.audio.path, '-map', '0:v', '-map', '1:a', '-c:a', job.format === 'webm-vp9' ? 'libopus' : 'pcm_s16le');
  args.push(...pcoreEncoderArgs(job.format, job.quality), '-frames:v', String(total));
  args.push(isSeq ? path.join(tmp, 'pcore_%06d.png') : tmp);
  const ff = spawn(ffmpegPaths().ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let ffErr = '';
  ff.stderr.on('data', (d: Buffer) => (ffErr = (ffErr + d.toString()).slice(-4000)));
  const ffDone = new Promise<number>((res) => ff.on('close', (c) => res(c ?? -1)));

  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { preload: path.join(__dirname, '..', 'preload', 'pcore.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: false } });
  const artwork = `data:image/webp;base64,${(await fsp.readFile(assetPath('logo-gold.webp'))).toString('base64')}`;
  const shape = JSON.parse(await fsp.readFile(assetPath('logo-shape.json'), 'utf8'));
  let next = 0;
  let written = 0;
  let failure: string | null = null;
  const wc = win.webContents;
  const handlers: [string, (...a: never[]) => unknown][] = [];
  const handle = (ch: string, fn: (...a: never[]) => unknown) => {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, (e, ...a) => (e.sender === wc ? (fn as (...x: unknown[]) => unknown)(...a) : undefined));
    handlers.push([ch, fn]);
  };
  let endCleanup: () => void = () => undefined;
  const finishedCleanup = new Promise<void>((r) => (endCleanup = r));
  const finished = new Promise<void>((resolve, reject) => {
    handle('pcore:job', () => ({ width: job.width, height: job.height, shape, artwork, settings: job.settings, seed: job.seed, composition: job.composition }));
    handle('pcore:next', () => {
      if (signal?.aborted || failure) return [];
      const batch = job.frames.slice(next, next + 8).map((p, k) => ({ i: next + k, t: (next + k) / fps, p }));
      next += batch.length;
      if (!batch.length) resolve();
      return batch;
    });
    handle('pcore:frame', async (px: Uint8Array) => {
      tick();
      if (!ff.stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) await new Promise((r) => ff.stdin.once('drain', r));
      written++;
      onProgress?.(written / total);
      if (written >= total) resolve();
    });
    const onFail = (e: Electron.IpcMainEvent, m: string) => {
      if (e.sender !== wc) return;
      failure = m;
      reject(new Error(`P-CORE renderer: ${m}`));
    };
    ipcMain.on('pcore:fail', onFail);
    signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    wc.on('render-process-gone', (_e, d) => reject(new Error(`P-CORE renderer crashed (${d.reason})`)));
    // watchdog: a renderer that produces nothing for 60 s has failed (no WebGL, script error…)
    let last = Date.now();
    const dog = setInterval(() => {
      if (Date.now() - last > 60000) reject(new Error('P-CORE renderer stopped responding (is WebGL2 available?)'));
    }, 5000);
    wc.on('ipc-message', () => (last = Date.now()));
    const tick = () => (last = Date.now());
    handlers.push(['__tick', tick]);
    void finishedCleanup.then(() => clearInterval(dog));
    wc.on('console-message', (_e, _l, msg) => process.env.PRIMESTONE_DEBUG && console.error('[pcore page]', msg));
    void win.loadFile(path.join(__dirname, '..', 'pcore', 'render.html'));
  });
  try {
    await finished;
  } catch (e) {
    ff.kill();
    await ffDone;
    await fsp.rm(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    endCleanup();
    for (const [ch] of handlers) if (!ch.startsWith('__')) ipcMain.removeHandler(ch);
    ipcMain.removeAllListeners('pcore:fail');
    if (!win.isDestroyed()) win.destroy();
  }
  ff.stdin.end();
  const code = await ffDone;
  if (code !== 0) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error(`P-CORE encode failed: ${ffErr.trim().split('\n').slice(-3).join(' ')}`);
  }
  const check = await validateAlpha(tmp, { frames: total, width: job.width, height: job.height, fps }, job.format);
  if (!check.ok) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error(`P-CORE export failed validation: ${check.problems.join('; ')}`);
  }
  await fsp.rm(job.output, { recursive: true, force: true });
  await fsp.rename(tmp, job.output);
  return check;
}
