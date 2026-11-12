/**
 * Media import, fingerprinting, thumbnails, waveform peaks and preview proxies.
 * Source files are only ever read.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type MediaAsset, type MediaFingerprint, newId } from '../core';
import { ffmpeg } from './ffmpeg';
import { probeMedia } from './probe';

const CHUNK = 64 * 1024;

export async function fingerprintFile(file: string): Promise<MediaFingerprint> {
  const st = await fsp.stat(file);
  const fh = await fsp.open(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const head = Buffer.alloc(Math.min(CHUNK, st.size));
    await fh.read(head, 0, head.length, 0);
    hash.update(head);
    if (st.size > CHUNK) {
      const tail = Buffer.alloc(Math.min(CHUNK, st.size - CHUNK));
      await fh.read(tail, 0, tail.length, st.size - tail.length);
      hash.update(tail);
    }
    hash.update(String(st.size));
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs), partialHash: hash.digest('hex') };
  } finally {
    await fh.close();
  }
}

export async function importMediaFile(file: string, projectDir?: string, signal?: AbortSignal): Promise<MediaAsset> {
  const abs = path.resolve(file);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  const [{ probe, kind }, fingerprint] = await Promise.all([probeMedia(abs, signal), fingerprintFile(abs)]);
  return {
    id: newId(),
    name: path.basename(abs),
    kind,
    path: abs,
    relativePath: projectDir ? path.relative(projectDir, abs) : undefined,
    fingerprint,
    probe,
    importedAt: new Date().toISOString(),
  };
}

/** Codecs Chromium can decode in a <video> element without a proxy. */
const PREVIEWABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const PREVIEWABLE_PIXFMT = /^(yuv420p|yuvj420p|nv12|yuv420p10le)$/;
const PREVIEWABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);

export function needsProxy(asset: MediaAsset): boolean {
  if (asset.kind === 'image') return false;
  const v = asset.probe.video;
  const a = asset.probe.audio;
  if (v && (!PREVIEWABLE_VIDEO.has(v.codec) || !PREVIEWABLE_PIXFMT.test(v.pixFmt))) return true;
  if (a && !PREVIEWABLE_AUDIO.has(a.codec)) return true;
  if (v && v.isVFR) return true; // CFR proxy makes preview seeking frame-accurate
  return false;
}

export interface CacheDirs {
  thumbs: string;
  peaks: string;
  proxies: string;
}

export function cacheDirs(cacheRoot: string): CacheDirs {
  const d = { thumbs: path.join(cacheRoot, 'thumbs'), peaks: path.join(cacheRoot, 'peaks'), proxies: path.join(cacheRoot, 'proxies') };
  for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
  return d;
}

/** Writes a JPEG poster frame for the asset; returns its path. Idempotent. */
export async function makeThumbnail(asset: MediaAsset, dirs: CacheDirs, signal?: AbortSignal): Promise<string | null> {
  if (!asset.probe.video) return null;
  const out = path.join(dirs.thumbs, `${asset.fingerprint.partialHash.slice(0, 24)}.jpg`);
  if (fs.existsSync(out)) return out;
  const t = asset.kind === 'image' ? 0 : Math.min(asset.probe.durationSec * 0.1, 5);
  const tmp = `${out}.tmp.jpg`;
  await ffmpeg(['-v', 'error', '-ss', t.toFixed(3), '-i', asset.path, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', tmp], { signal });
  await fsp.rename(tmp, out);
  return out;
}

/** Peaks resolution: one value per 10 ms. */
export const PEAKS_PER_SECOND = 100;

/**
 * Computes absolute-peak values (0..255) per 10 ms of mono-downmixed audio and caches them as
 * a raw Uint8 file. Returns the peaks.
 */
export async function makePeaks(asset: MediaAsset, dirs: CacheDirs, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (!asset.probe.audio) return null;
  const out = path.join(dirs.peaks, `${asset.fingerprint.partialHash.slice(0, 24)}.peaks`);
  if (fs.existsSync(out)) return new Uint8Array(await fsp.readFile(out));
  const rate = 8000;
  const { stdout } = await ffmpeg(['-v', 'error', '-i', asset.path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], {
    signal,
    collectStdout: true,
  });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const per = rate / PEAKS_PER_SECOND;
  const peaks = new Uint8Array(Math.ceil(samples.length / per));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    const end = Math.min(samples.length, (i + 1) * per);
    for (let j = i * per; j < end; j++) {
      const s = Math.abs(samples[j]!);
      if (s > m) m = s;
    }
    peaks[i] = Math.min(255, Math.round((m / 32768) * 255));
  }
  await fsp.writeFile(out, peaks);
  return peaks;
}

/** Path where an asset's proxy lives (relative to the proxies dir). */
export function proxyFileName(asset: MediaAsset): string {
  return `${asset.fingerprint.partialHash.slice(0, 24)}.proxy.mp4`;
}

/**
 * Generates an H.264/AAC CFR preview proxy (max 1280 wide). Used only for preview; exports
 * always read the original media.
 */
export async function makeProxy(asset: MediaAsset, dirs: CacheDirs, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<string> {
  const name = proxyFileName(asset);
  const out = path.join(dirs.proxies, name);
  if (fs.existsSync(out)) return name;
  const tmp = `${out}.part.mp4`;
  const args = ['-v', 'error', '-i', asset.path, '-progress', 'pipe:1', '-nostats'];
  if (asset.probe.video) {
    const r = asset.probe.video.frameRate;
    args.push('-vf', `fps=${r.num}/${r.den},scale='min(1280,iw)':-2,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '15');
  } else {
    args.push('-vn');
  }
  if (asset.probe.audio) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-movflags', '+faststart', tmp);
  const total = asset.probe.durationSec;
  await ffmpeg(args, {
    signal,
    onStdoutLine: (l) => {
      if (l.startsWith('out_time_us=') && total > 0) onProgress?.(Math.min(1, Number(l.slice(12)) / 1e6 / total));
    },
  });
  await fsp.rename(tmp, out);
  return name;
}
