/**
 * FFmpeg / FFprobe process layer. FFmpeg is used as an external executable (never linked),
 * which keeps licensing clean and lets users swap builds (see docs/LICENSES.md).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  source: 'env' | 'bundled' | 'path';
}

const exe = process.platform === 'win32' ? '.exe' : '';

/** Resolution order: PRIMESTONE_FFMPEG_DIR env → bundled resources/ffmpeg → system PATH. */
export function resolveFfmpeg(bundledDir?: string): FfmpegPaths {
  const envDir = process.env.PRIMESTONE_FFMPEG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, `ffmpeg${exe}`))) {
    return { ffmpeg: path.join(envDir, `ffmpeg${exe}`), ffprobe: path.join(envDir, `ffprobe${exe}`), source: 'env' };
  }
  if (bundledDir && fs.existsSync(path.join(bundledDir, `ffmpeg${exe}`))) {
    return { ffmpeg: path.join(bundledDir, `ffmpeg${exe}`), ffprobe: path.join(bundledDir, `ffprobe${exe}`), source: 'bundled' };
  }
  return { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}`, source: 'path' };
}

let current: FfmpegPaths = resolveFfmpeg();
export function setFfmpegPaths(p: FfmpegPaths) {
  current = p;
}
export function ffmpegPaths(): FfmpegPaths {
  return current;
}

export class ProcessError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) {
    super(message);
    this.name = 'ProcessError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with each complete stdout line. */
  onStdoutLine?: (line: string) => void;
  /** Collect stdout as a Buffer (for binary pipes). */
  collectStdout?: boolean;
  cwd?: string;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    let lineBuf = '';
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (opts.collectStdout) out.push(d);
      if (opts.onStdoutLine) {
        lineBuf += d.toString('utf8');
        let i;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(lineBuf.slice(0, i).trim());
          lineBuf = lineBuf.slice(i + 1);
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      // analysis filters report results on stderr: keep plenty (a long narration has thousands of pauses)
      if (stderr.length > 16_000_000) stderr = stderr.slice(-8_000_000);
    });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      log('error', 'ffmpeg', `impossible de lancer ${path.basename(bin)} : ${e.message}`, { bin });
      reject(new ProcessError(`Failed to start ${path.basename(bin)}: ${e.message}`, null, ''));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new CancelledError());
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        log('warn', 'ffmpeg', `${path.basename(bin)} a échoué (code ${code})`, { args: args.slice(0, 40).join(' ').slice(0, 1500), tail: tail.slice(-1500) });
        return reject(new ProcessError(`${path.basename(bin)} exited with code ${code}: ${tail}`, code, stderr));
      }
      resolve({ stdout: Buffer.concat(out), stderr });
    });
  });
}

export function ffmpeg(args: string[], opts?: RunOptions) {
  return run(ffmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], opts);
}

export function ffprobe(args: string[], opts?: RunOptions) {
  return run(ffmpegPaths().ffprobe, ['-hide_banner', ...args], { collectStdout: true, ...opts });
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const r = await run(ffmpegPaths().ffmpeg, ['-version'], { collectStdout: true });
    return r.stdout.toString().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}
