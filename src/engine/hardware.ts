/**
 * Read-only hardware inspection and performance profiles.
 * Hardware encoders are only reported as usable after a real 1-frame test encode succeeds.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { ffmpeg, ffmpegPaths, ffmpegVersion, run } from './ffmpeg';

export type PerformanceProfile = 'quality' | 'deep-quality' | 'balanced';

export interface GpuInfo {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  vramMB?: number;
}

export interface HardwareReport {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuThreads: number;
  totalMemMB: number;
  freeMemMB: number;
  gpus: GpuInfo[];
  ffmpeg: { version: string | null; path: string; source: string };
  hwEncoders: string[];
  recommendedCpuSlots: number;
}

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function vendorOf(name: string): GpuInfo['vendor'] {
  const n = name.toLowerCase();
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon')) return 'amd';
  if (n.includes('intel')) return 'intel';
  return 'other';
}

export async function detectGpus(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  const smi = await sh('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  for (const line of smi.split('\n').filter(Boolean)) {
    const [name, mem] = line.split(',').map((s) => s.trim());
    gpus.push({ name: name ?? 'NVIDIA GPU', vendor: 'nvidia', vramMB: Number(mem) || undefined });
  }
  if (process.platform === 'win32') {
    const out = await sh('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name']);
    for (const name of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (!gpus.some((g) => g.name === name)) gpus.push({ name, vendor: vendorOf(name) });
    }
  } else if (process.platform === 'linux') {
    const out = await sh('lspci', []);
    for (const line of out.split('\n').filter((l) => /VGA|3D controller|Display/.test(l))) {
      const name = line.split(': ').slice(1).join(': ').trim();
      if (name && !gpus.some((g) => name.includes(g.name))) gpus.push({ name, vendor: vendorOf(name) });
    }
  }
  return gpus;
}

const CANDIDATE_ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'];

/** Returns hardware encoders that actually work on this machine. */
export async function probeHwEncoders(): Promise<string[]> {
  let listed = '';
  try {
    listed = (await run(ffmpegPaths().ffmpeg, ['-hide_banner', '-encoders'], { collectStdout: true })).stdout.toString();
  } catch {
    return [];
  }
  const working: string[] = [];
  for (const enc of CANDIDATE_ENCODERS.filter((e) => listed.includes(` ${e} `))) {
    try {
      await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-']);
      working.push(enc);
    } catch {
      /* not usable */
    }
  }
  return working;
}

export async function hardwareReport(): Promise<HardwareReport> {
  const cpus = os.cpus();
  const [gpus, hwEncoders, version] = await Promise.all([detectGpus(), probeHwEncoders(), ffmpegVersion()]);
  return {
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuThreads: cpus.length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    gpus,
    ffmpeg: { version, path: ffmpegPaths().ffmpeg, source: ffmpegPaths().source },
    hwEncoders,
    recommendedCpuSlots: Math.max(1, Math.min(4, Math.floor(cpus.length / 4))),
  };
}

/**
 * Chooses the export encoder. Quality / Deep Quality use the CPU encoder (best quality per bit)
 * unless the user explicitly selects hardware; Balanced prefers a verified hardware encoder.
 * Never silently lowers quality: the choice is reported back to the user.
 */
export function chooseEncoder(codec: 'h264' | 'hevc', hardware: 'auto' | 'cpu', profile: PerformanceProfile, hw: string[]): string {
  const cpu = codec === 'hevc' ? 'libx265' : 'libx264';
  if (hardware === 'cpu' || profile !== 'balanced') return cpu;
  return hw.find((e) => e.startsWith(codec === 'hevc' ? 'hevc_' : 'h264_')) ?? cpu;
}

export interface DiagnosticsReport {
  generatedAt: string;
  app: string;
  hardware: HardwareReport;
  storage: { path: string; freeGB: number | null; totalGB: number | null }[];
  /** Short, real measurements on this machine (seconds of work for a fixed amount of video). */
  benchmarks: { name: string; seconds: number; realtimeFactor: number; ok: boolean; detail?: string }[];
  transcriber?: { ok: boolean; detail: string };
}

async function storageInfo(p: string) {
  try {
    const fsp = await import('node:fs/promises');
    const s = await fsp.statfs(p);
    return { path: p, freeGB: +((s.bavail * s.bsize) / 1e9).toFixed(1), totalGB: +((s.blocks * s.bsize) / 1e9).toFixed(1) };
  } catch {
    return { path: p, freeGB: null, totalGB: null };
  }
}

/**
 * Read-only diagnostics the user can save and share: hardware, free space, and two short real
 * benchmarks (1080p x264 export with Ken Burns scaling; verified hardware encoders). Nothing is
 * sent anywhere; nothing on the machine is modified.
 */
export async function diagnostics(paths: string[], appVersion: string, transcriber?: () => Promise<{ ok: boolean; detail: string }>): Promise<DiagnosticsReport> {
  const hardware = await hardwareReport();
  const storage = await Promise.all([...new Set(paths)].map(storageInfo));
  const benchmarks: DiagnosticsReport['benchmarks'] = [];
  const bench = async (name: string, args: string[], videoSec: number) => {
    const t0 = Date.now();
    try {
      await ffmpeg(['-v', 'error', ...args, '-f', 'null', '-']);
      const s = (Date.now() - t0) / 1000;
      benchmarks.push({ name, seconds: +s.toFixed(2), realtimeFactor: +(s / videoSec).toFixed(2), ok: true });
    } catch (e) {
      benchmarks.push({ name, seconds: 0, realtimeFactor: 0, ok: false, detail: (e as Error).message.slice(0, 200) });
    }
  };
  const kb = ['-f', 'lavfi', '-i', 'testsrc2=s=2400x1600:r=30:d=4', '-vf', "scale=w='1920*(1+0.1*t/4)':h=-2:eval=frame,crop=1920:1080,format=yuv420p"];
  await bench('x264 1080p30 Ken Burns (Quality)', [...kb, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18'], 4);
  for (const enc of hardware.hwEncoders) await bench(`${enc} 1080p30`, [...kb, '-c:v', enc], 4);
  return { generatedAt: new Date().toISOString(), app: appVersion, hardware, storage, benchmarks, transcriber: transcriber ? await transcriber().catch((e) => ({ ok: false, detail: String(e) })) : undefined };
}
