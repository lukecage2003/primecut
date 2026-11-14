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
import { type PCoreV2Settings, V2_BUDGET, resolveV2 } from '../pcore/v2/config';
import type { PCoreCue } from '../pcore/v2/director';
import { pcoreFramesV2 } from '../engine/pcore';
import { fingerprintFile } from '../engine/media';
import { directPCore } from '../pcore/v2/director';

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
  /** P-CORE V2 settings: renders the layered V2 scene (frames are V2 frames). Absent = V1 scene. */
  v2?: PCoreV2Settings;
}

/** Measures of the last P-CORE render (shown in P-CORE Studio → Performance). */
export interface PCoreRenderStats {
  engine: 'v1' | 'v2';
  quality: PCoreQuality;
  width: number;
  height: number;
  renderWidth: number;
  renderHeight: number;
  frames: number;
  seconds: number;
  fps: number;
  /** Peak working set (MB) of the render window and of the GPU process during the render. */
  rendererMemMB: number | null;
  gpuProcessMemMB: number | null;
  /** CPU use (% of one core) of the render window and GPU process, averaged over the render. */
  rendererCpu: number | null;
  gpuProcessCpu: number | null;
  /** GPU in use as reported by Chromium; software when no GPU is available. */
  gpu: string;
  software: boolean;
  /** Dedicated video memory use is not exposed by Chromium: never guessed. */
  vram: null;
  at: string;
}
export let lastRenderStats: PCoreRenderStats | null = null;

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
    handle('pcore:job', () => ({ width: rw, height: rh, shape, artwork, settings: job.settings, seed: job.seed, composition: job.composition, particles: ql.particles, ...(job.v2 ? { v2: job.v2, budget: V2_BUDGET[job.quality ?? 'standard'] } : {}) }));
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
  const t0 = Date.now();
  const samples: { r: number; g: number; rc: number; gc: number }[] = [];
  const sample = () => {
    try {
      const ms = app.getAppMetrics();
      const pid = wc.getOSProcessId();
      const rm = ms.find((m) => m.pid === pid);
      const gm = ms.find((m) => m.type === 'GPU');
      samples.push({ r: (rm?.memory.workingSetSize ?? 0) / 1024, g: (gm?.memory.workingSetSize ?? 0) / 1024, rc: rm?.cpu.percentCPUUsage ?? 0, gc: gm?.cpu.percentCPUUsage ?? 0 });
    } catch {
      /* metrics are best effort */
    }
  };
  const sampler = setInterval(sample, 1000);
  try {
    await finished;
    clearInterval(sampler);
    sample();
    const seconds = (Date.now() - t0) / 1000;
    const gpu = await app.getGPUInfo('basic').then((g) => {
      const dev = (g as { gpuDevice?: { active?: boolean; vendorId?: number; deviceId?: number; driverVendor?: string }[] }).gpuDevice?.find((d) => d.active) ?? (g as { gpuDevice?: { vendorId?: number; deviceId?: number }[] }).gpuDevice?.[0];
      return dev ? `vendor 0x${(dev.vendorId ?? 0).toString(16)} device 0x${(dev.deviceId ?? 0).toString(16)}` : 'inconnu';
    }).catch(() => 'inconnu');
    const software = !app.isHardwareAccelerationEnabled() || /0xffff|0x0 device 0x0/.test(gpu);
    const peak = (k: 'r' | 'g') => (samples.length ? Math.round(Math.max(...samples.map((x) => x[k]))) : null);
    const avg = (k: 'rc' | 'gc') => (samples.length ? +(samples.reduce((a, x) => a + x[k], 0) / samples.length).toFixed(1) : null);
    lastRenderStats = { engine: job.v2 ? 'v2' : 'v1', quality: job.quality ?? 'standard', width: job.width, height: job.height, renderWidth: rw, renderHeight: rh, frames: total, seconds: +seconds.toFixed(2), fps: +(total / seconds).toFixed(2), rendererMemMB: peak('r'), gpuProcessMemMB: peak('g'), rendererCpu: avg('rc'), gpuProcessCpu: avg('gc'), gpu, software, vram: null, at: new Date().toISOString() };
  } catch (e) {
    clearInterval(sampler);
    if (process.env.PRIMESTONE_DEBUG) console.error('pcore render failed:', (e as Error).message.slice(0, 200));
    // FFmpeg may be blocked reading its input: close the pipe, then make sure it ends
    ff.stdin.destroy();
    ff.kill('SIGKILL');
    await ffDone;
    await fsp.rm(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    endCleanup();
    // close the page first: a request it was still sending must not reach a removed handler
    if (!win.isDestroyed()) win.destroy();
    // a request the page sent just before closing gets a "finished" answer instead of an unregistered channel
    for (const [ch] of handlers)
      if (!ch.startsWith('__')) {
        ipcMain.removeHandler(ch);
        ipcMain.handle(ch, () => (ch === 'pcore:next' ? [] : undefined));
      }
    ipcMain.removeAllListeners('pcore:fail');
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
export async function renderPCoreAsset(asset: MediaAsset, narration: MediaAsset, seq: SequenceSettings, cacheDir: string, signal?: AbortSignal, qualityOverride?: PCoreQuality): Promise<string> {
  const pc = asset.pcore!;
  const st = loadSettings();
  const settings = { ...DEFAULT_PCORE_SETTINGS, ...(st.pcore?.settings ?? {}) };
  const fps = seq.frameRate.num / seq.frameRate.den;
  const quality = qualityOverride ?? st.pcore?.quality ?? 'high';
  if (pc.engine === 'v2') {
    // V2: everything that shapes the frames is in the asset (cues + settings snapshot) → deterministic cache
    const v2 = resolveV2(pc.v2);
    const key = crypto.createHash('sha256').update(JSON.stringify(['pcore-v2.1', narration.fingerprint, pc.offsetSec, pc.durationSec, pc.size, pc.composition, pc.seed, pc.cues, pc.chapters, v2, seq.frameRate, quality])).digest('hex').slice(0, 20);
    const out = path.join(cacheDir, 'generated', `pcore2-${pc.mode}-${key}.webm`);
    if (fs.existsSync(out)) return out;
    const frames = await pcoreFramesV2(narration.path, { offsetSec: pc.offsetSec, durationSec: pc.durationSec, fps, cues: pc.cues ?? [], v2, seed: pc.seed, signal, chapters: pc.chapters });
    await renderPCore({ width: pc.size, height: pc.size, fps: seq.frameRate, frames, settings, composition: pc.composition, seed: pc.seed, format: 'webm-vp9', quality, output: out, v2 }, undefined, signal);
    return out;
  }
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
  /** V2: preview one expression of the library over the whole window (else the director decides). */
  expression?: import('../pcore/v2/expressions').ExpressionId;
  /** V2: cues already planned for this narration (the production's), in narration time. */
  cues?: PCoreCue[];
}

/** V2 cues for a studio window: one chosen expression, the production's cues, or the director on the window's voice. */
async function studioCues(r: PCoreStudioRequest, v2: PCoreV2Settings): Promise<{ cues: PCoreCue[]; log: string[] }> {
  if (r.expression) return { cues: [{ id: 'studio', expression: r.expression, start: r.offsetSec + 0.3, duration: Math.max(0.8, r.durationSec - 0.6), intensity: 1, variant: 0, reasons: ['aperçu de l’expression'], source: 'utilisateur', state: 'verrouillée' }], log: [] };
  if (r.cues?.length) return { cues: r.cues, log: [] };
  if (!r.audioPath) return { cues: [], log: ['pas de narration : aucune réaction'] };
  const pcm = await decodePcm(r.audioPath, r.offsetSec, r.durationSec, 4000);
  const d = directPCore({ voice: analyzeVoice(pcm, 4000, { fps: 10 }), fps: 10, settings: v2 });
  return { cues: d.cues.map((c) => ({ ...c, start: c.start + r.offsetSec })), log: d.log };
}

/** IPC for P-CORE Studio: analysis graph data, low-res preview, independent export with validation. */
export function registerPCoreIpc() {
  const settingsNow = () => ({ ...DEFAULT_PCORE_SETTINGS, ...(loadSettings().pcore?.settings ?? {}) });
  const v2Now = () => ((loadSettings().pcore?.engine ?? 'v2') === 'v2' ? resolveV2(loadSettings().pcore?.v2) : null);
  /** Frames for a studio request with the engine in use (V2 by default, V1.1 when chosen). */
  const studioFrames = async (r: PCoreStudioRequest) => {
    const fps = r.fps.num / r.fps.den;
    const v2 = v2Now();
    if (!v2) return { frames: await pcoreFrames(r.audioPath, { offsetSec: r.offsetSec, durationSec: r.durationSec, fps, events: r.events, settings: settingsNow() }), v2: undefined, cues: undefined, log: undefined };
    const { cues, log } = await studioCues(r, v2);
    return { frames: await pcoreFramesV2(r.audioPath, { offsetSec: r.offsetSec, durationSec: r.durationSec, fps, cues, v2 }), v2, cues, log };
  };
  ipcMain.handle('pcore:stats', () => lastRenderStats);
  ipcMain.handle('pcore:renderAsset', async (_e, projectFile: string, asset: MediaAsset, narration: MediaAsset, seq: SequenceSettings) => {
    const file = await renderPCoreAsset(asset, narration, seq, path.join(path.dirname(projectFile), 'Cache'));
    return { path: file, fingerprint: await fingerprintFile(file) };
  });
  ipcMain.handle('pcore:analyze', async (_e, r: PCoreStudioRequest) => {
    const fps = r.fps.num / r.fps.den;
    if (v2Now()) {
      const sf = await studioFrames(r);
      let voice: { env: number; low: number; mid: number; high: number; speaking: boolean }[] = [];
      if (r.audioPath) voice = analyzeVoice(await decodePcm(r.audioPath, r.offsetSec, r.durationSec), 16000, { fps }).map((v) => ({ env: v.env, low: v.low, mid: v.mid, high: v.high, speaking: v.speaking }));
      return { fps, voice, states: sf.frames.map((f) => f.state), energy: sf.frames.map((f) => f.energy), fragment: sf.frames.map((f) => f.fragment), engine: 'v2' as const, cues: sf.cues, log: sf.log, expr: sf.frames.map((f) => (f as { expr?: string }).expr ?? f.state) };
    }
    const frames = await pcoreFrames(r.audioPath, { offsetSec: r.offsetSec, durationSec: r.durationSec, fps, events: r.events, settings: settingsNow() });
    let voice: { env: number; low: number; mid: number; high: number; speaking: boolean }[] = [];
    if (r.audioPath) {
      const pcm = await decodePcm(r.audioPath, r.offsetSec, r.durationSec);
      voice = analyzeVoice(pcm, 16000, { fps }).map((v) => ({ env: v.env, low: v.low, mid: v.mid, high: v.high, speaking: v.speaking }));
    }
    return { fps, voice, states: frames.map((f) => f.state), energy: frames.map((f) => f.energy), fragment: frames.map((f) => f.fragment), engine: 'v1' as const };
  });
  ipcMain.handle('pcore:preview', async (e, projectFile: string, r: PCoreStudioRequest & { size: number }) => {
    const settings = settingsNow();
    const fps = r.fps.num / r.fps.den;
    const key = crypto.createHash('sha256').update(JSON.stringify(['preview', r, settings, v2Now()])).digest('hex').slice(0, 16);
    const out = path.join(path.dirname(projectFile), 'Cache', 'pcore-preview', `preview-${key}.webm`);
    if (fs.existsSync(out)) return out;
    void fps;
    const { frames, v2 } = await studioFrames(r);
    await renderPCore({ width: r.size, height: r.size, fps: r.fps, frames, settings, composition: r.composition, seed: 7, format: 'webm-vp9', quality: 'preview', output: out, v2, audio: r.audioPath ? { path: r.audioPath, offsetSec: r.offsetSec } : undefined }, (f) => e.sender.send('pcore:progress', f));
    return out;
  });
  ipcMain.handle('pcore:export', async (e, r: PCoreStudioRequest & { width: number; height: number; format: PCoreFormat; withAudio: boolean; quality?: PCoreQuality }) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const fmt = PCORE_FORMATS.find((f) => f.id === r.format)!;
    const pick = r.format === 'png-sequence' ? await dialog.showOpenDialog(w, { title: 'Dossier de la séquence PNG', properties: ['openDirectory', 'createDirectory'] }) : await dialog.showSaveDialog(w, { title: 'Exporter P-CORE', defaultPath: `P-CORE${fmt.ext}`, filters: [{ name: fmt.label, extensions: [fmt.ext.slice(1)] }] });
    const target = 'filePaths' in pick ? (pick.canceled ? null : pick.filePaths[0] && path.join(pick.filePaths[0], 'P-CORE')) : pick.canceled ? null : pick.filePath;
    if (!target) return null;
    const settings = settingsNow();
    const fps = r.fps.num / r.fps.den;
    const { frames, v2 } = await studioFrames(r);
    void fps;
    const t0 = Date.now();
    const quality = r.quality ?? 'final';
    const check = await renderPCore({ width: r.width, height: r.height, fps: r.fps, frames, settings, composition: r.composition, seed: 7, format: r.format, quality, output: target, v2, audio: r.withAudio && r.audioPath ? { path: r.audioPath, offsetSec: r.offsetSec } : undefined }, (f) => e.sender.send('pcore:progress', f));
    const renderSec = (Date.now() - t0) / 1000;
    return { path: target, check, quality, renderSec, fps: +(frames.length / renderSec).toFixed(2) };
  });
}
