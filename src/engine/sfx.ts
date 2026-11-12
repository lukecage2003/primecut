/**
 * Primestone SFX: sound effects synthesised locally with FFmpeg (no sample library, no licence
 * question). Deterministic for a given spec; cached in Cache/generated.
 * - whoosh: pink noise, band-limited, swelling and panning left→right (section transitions)
 * - impact: low sine thump with fast decay + short filtered noise burst + small room (titles, reveals)
 * - tick: short bright click (list items, data cards)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SfxSpec } from '../core';
import { ffmpeg } from './ffmpeg';

export function sfxHash(spec: SfxSpec): string {
  return crypto.createHash('sha256').update(JSON.stringify(['sfx-v1', spec.kind, spec.seed, spec.durationSec])).digest('hex').slice(0, 20);
}

export function sfxFilter(spec: SfxSpec): string {
  const d = spec.durationSec.toFixed(3);
  const j = ((spec.seed * 9301 + 49297) % 233280) / 233280; // small per-seed variation
  switch (spec.kind) {
    case 'whoosh': {
      const lo = Math.round(250 + j * 150);
      const hi = Math.round(3500 + j * 1500);
      return (
        `anoisesrc=d=${d}:c=pink:r=48000:a=0.9:seed=${spec.seed},highpass=f=${lo},lowpass=f=${hi},` +
        `aeval='val(0)*pow(sin(PI*t/${d}),3)|val(0)*pow(sin(PI*t/${d}),3)':c=stereo,` +
        `aeval='val(0)*(1-0.7*t/${d})|val(1)*(0.3+0.7*t/${d})':c=stereo,volume=1.6`
      );
    }
    case 'impact': {
      const f = (48 + j * 14).toFixed(1);
      return (
        `aevalsrc='0.9*sin(2*PI*${f}*t*(1+0.6*exp(-30*t)))*exp(-5*t)+0.25*(random(0)*2-1)*exp(-40*t)|0.9*sin(2*PI*${f}*t*(1+0.6*exp(-30*t)))*exp(-5*t)+0.25*(random(1)*2-1)*exp(-40*t)':s=48000:d=${d}:c=stereo,` +
        `lowpass=f=2500,aecho=0.8:0.5:60|110:0.25|0.15,alimiter=limit=0.9`
      );
    }
    case 'tick':
      return `aevalsrc='0.6*sin(2*PI*2400*t)*exp(-60*t)|0.6*sin(2*PI*2400*t)*exp(-60*t)':s=48000:d=${d}:c=stereo,highpass=f=800`;
  }
}

export async function renderSfx(spec: SfxSpec, cacheDir: string, signal?: AbortSignal): Promise<string> {
  const dir = path.join(cacheDir, 'generated');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `sfx-${spec.kind}-${sfxHash(spec)}.wav`);
  if (fs.existsSync(out)) return out;
  const tmp = `${out}.tmp.wav`;
  await ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', sfxFilter(spec), '-t', spec.durationSec.toFixed(3), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', tmp], { signal });
  await fsp.rename(tmp, out);
  return out;
}
