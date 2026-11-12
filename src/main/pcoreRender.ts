/**
 * P-CORE renderer host (main process). A hidden window runs the Three.js scene; frames come back
 * as straight-alpha RGBA and are piped into FFmpeg. One render at a time per window; the window is
 * destroyed afterwards. Output is validated by reading the file back (alpha, size, frame count).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import type { MediaAsset, SequenceSettings } from '../core/model';
import { PCORE_FORMATS, decodePcm, pcoreFrames } from '../engine/pcore';
import { analyzeVoice } from '../pcore/audio';
import { DEFAULT_PCORE_SETTINGS, type PCoreEvent } from '../pcore/expression';
import { loadSettings } from './settings';
import { ffmpegPaths } from '../engine/ffmpeg';
import { type AlphaCheck, PCORE_QUALITY, type PCoreFormat, type PCoreQuality, pcoreEncoderArgs, validateAlpha } from '../engine/pcore';
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
  quality?: PCoreQuality;
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
  // quality: render at renderScale × the output size, then downscale with premultiplied alpha
  // (straight-alpha averaging would darken the glow edges)
  const ql = PCORE_QUALITY[job.quality ?? 'standard'];
  const rw = Math.max(16, Math.round((job.width * ql.renderScale) / 2) * 2);
  const rh = Math.max(16, Math.round((job.height * ql.renderScale) / 2) * 2);
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${rw}x${rh}`, '-framerate', `${job.fps.num}/${job.fps.den}`, '-i', 'pipe:0'];

  if (job.audio && !isSeq) args.push('-ss', job.audio.offsetSec.toFixed(4), '-t', (total / fps).toFixed(4), '-i', job.audio.path, '-map', '0:v', '-map', '1:a', '-c:a', job.format === 'webm-vp9' ? 'libopus' : 'pcm_s16le');
  // output-side filter (after every input, or FFmpeg would bind it to the audio input)
  if (rw !== job.width || rh !== job.height) args.push('-vf', `format=gbrap,premultiply=inplace=1,scale=${job.width}:${job.height}:flags=${rw > job.width ? 'area' : 'bicubic'},unpremultiply=inplace=1`);
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
    ipcMain.handle(ch, (e, ...a) => (e.sender.id === wc.id ? (fn as (...x: unknown[]) => unknown)(...a) : undefined));
    handlers.push([ch, fn]);
  };
  let endCleanup: () => void = () => undefined;
  const finishedCleanup = new Promise<void>((r) => (endCleanup = r));
  const finished = new Promise<void>((resolve, reject) => {
    handle('pcore:job', () => ({ width: rw, height: rh, shape, artwork, settings: job.settings, seed: job.seed, composition: job.composition, particles: ql.particles }));
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
      if (e.sender.id !== wc.id) return;
      failure = m;
      if (process.env.PRIMESTONE_DEBUG) console.error('pcore:fail received');
      reject(new Error(`P-CORE renderer: ${m}`));
    };
    ipcMain.on('pcore:fail', onFail);
    signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    // FFmpeg exiting before every frame was written is a failure: report it at once, with its message
    void ffDone.then((code) => {
      if (written < total) reject(new Error(`FFmpeg stopped (code ${code}) before the end of the P-CORE render: ${ffErr.trim().split('\n').slice(-3).join(' ')}`));
    });
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
    if (process.env.PRIMESTONE_DEBUG) console.error('pcore render failed:', (e as Error).message.slice(0, 200));
    // FFmpeg may be blocked reading its input: close the pipe, then make sure it ends
    ff.stdin.destroy();
    ff.kill('SIGKILL');
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

/** Renders (or reuses from the cache) the VP9-alpha file of a P-CORE timeline asset. */
export async function renderPCoreAsset(asset: MediaAsset, narration: MediaAsset, seq: SequenceSettings, cacheDir: string, signal?: AbortSignal): Promise<string> {
  const pc = asset.pcore!;
  const st = loadSettings();
  const settings = { ...DEFAULT_PCORE_SETTINGS, ...(st.pcore?.settings ?? {}) };
  const fps = seq.frameRate.num / seq.frameRate.den;
  const quality = st.pcore?.quality ?? 'high';
  const key = crypto.createHash('sha256').update(JSON.stringify(['pcore-v2', narration.fingerprint, pc, settings, seq.frameRate, quality])).digest('hex').slice(0, 20);
  const out = path.join(cacheDir, 'generated', `pcore-${pc.mode}-${key}.webm`);
  if (fs.existsSync(out)) return out;
  const frames = await pcoreFrames(narration.path, { offsetSec: pc.offsetSec, durationSec: pc.durationSec, fps, events: pc.events, settings, signal });
  await renderPCore({ width: pc.size, height: pc.size, fps: seq.frameRate, frames, settings, composition: pc.composition, seed: pc.seed, format: 'webm-vp9', quality, output: out }, undefined, signal);
  return out;
}

export interface PCoreStudioRequest {
  audioPath: string | null;
  offsetSec: number;
  durationSec: number;
  fps: { num: number; den: number };
  composition: 'core' | 'floating' | 'minimal';
  events: PCoreEvent[];
}

/** IPC for P-CORE Studio: analysis graph data, low-res preview, independent export with validation. */
export function registerPCoreIpc() {
  const settingsNow = () => ({ ...DEFAULT_PCORE_SETTINGS, ...(loadSettings().pcore?.settings ?? {}) });
  ipcMain.handle('pcore:analyze', async (_e, r: PCoreStudioRequest) => {
    const fps = r.fps.num / r.fps.den;
    const frames = await pcoreFrames(r.audioPath, { offsetSec: r.offsetSec, durationSec: r.durationSec, fps, events: r.events, settings: settingsNow() });
    let voice: { env: number; low: number; mid: number; high: number; speaking: boolean }[] = [];
    if (r.audioPath) {
      const pcm = await decodePcm(r.audioPath, r.offsetSec, r.durationSec);
      voice = analyzeVoice(pcm, 16000, { fps }).map((v) => ({ env: v.env, low: v.low, mid: v.mid, high: v.high, speaking: v.speaking }));
    }
    return { fps, voice, states: frames.map((f) => f.state), energy: frames.map((f) => f.energy), fragment: frames.map((f) => f.fragment) };
  });
  ipcMain.handle('pcore:preview', async (e, projectFile: string, r: PCoreStudioRequest & { size: number }) => {
    const settings = settingsNow();
    const fps = r.fps.num / r.fps.den;
    const key = crypto.createHash('sha256').update(JSON.stringify(['preview', r, settings])).digest('hex').slice(0, 16);
    const out = path.join(path.dirname(projectFile), 'Cache', 'pcore-preview', `preview-${key}.webm`);
    if (fs.existsSync(out)) return out;
    const frames = await pcoreFrames(r.audioPath, { offsetSec: r.offsetSec, durationSec: r.durationSec, fps, events: r.events, settings });
    await renderPCore({ width: r.size, height: r.size, fps: r.fps, frames, settings, composition: r.composition, seed: 7, format: 'webm-vp9', quality: 'preview', output: out, audio: r.audioPath ? { path: r.audioPath, offsetSec: r.offsetSec } : undefined }, (f) => e.sender.send('pcore:progress', f));
    return out;
  });
  ipcMain.handle('pcore:export', async (e, r: PCoreStudioRequest & { width: number; height: number; format: PCoreFormat; withAudio: boolean; quality?: PCoreQuality }) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const fmt = PCORE_FORMATS.find((f) => f.id === r.format)!;
    const pick = r.format === 'png-sequence' ? await dialog.showOpenDialog(w, { title: 'Folder for the PNG sequence', properties: ['openDirectory', 'createDirectory'] }) : await dialog.showSaveDialog(w, { title: 'Export P-CORE', defaultPath: `P-CORE${fmt.ext}`, filters: [{ name: fmt.label, extensions: [fmt.ext.slice(1)] }] });
    const target = 'filePaths' in pick ? (pick.canceled ? null : pick.filePaths[0] && path.join(pick.filePaths[0], 'P-CORE')) : pick.canceled ? null : pick.filePath;
    if (!target) return null;
    const settings = settingsNow();
    const fps = r.fps.num / r.fps.den;
    const frames = await pcoreFrames(r.audioPath, { offsetSec: r.offsetSec, durationSec: r.durationSec, fps, events: r.events, settings });
    const t0 = Date.now();
    const quality = r.quality ?? 'final';
    const check = await renderPCore({ width: r.width, height: r.height, fps: r.fps, frames, settings, composition: r.composition, seed: 7, format: r.format, quality, output: target, audio: r.withAudio && r.audioPath ? { path: r.audioPath, offsetSec: r.offsetSec } : undefined }, (f) => e.sender.send('pcore:progress', f));
    const renderSec = (Date.now() - t0) / 1000;
    return { path: target, check, quality, renderSec, fps: +(frames.length / renderSec).toFixed(2) };
  });
}
