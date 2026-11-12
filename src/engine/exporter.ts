/**
 * Export: compiles a Sequence into a single FFmpeg filter graph and encodes it.
 *
 * - Video tracks are composited bottom (V1) → top over a black canvas at sequence size/rate.
 * - Each clip is conformed to the sequence frame rate (fps filter → handles VFR) and cut to an
 *   exact frame count (trim=end_frame), so timeline frame positions are honoured exactly.
 * - Audio clips are resampled to the sequence rate, positioned with sample-exact adelay and mixed
 *   without normalisation (unity gain), then hard-trimmed to the sequence length.
 * - Output is written to a temp file and renamed only after FFmpeg succeeds, then verified.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type ExportSettings,
  type PlanItem,
  type MediaAsset,
  type Project,
  type Sequence,
  framesToSeconds,
  rateToNumber,
  planSequence,
  sequenceDuration,
} from '../core';
import { CancelledError, ffmpeg, ffprobe } from './ffmpeg';

export interface ExportRange {
  start: number; // frames
  end: number; // frames (exclusive)
}

export interface ExportPlan {
  args: string[];
  durationSec: number;
  frames: number;
  hasAudio: boolean;
}

export class ExportError extends Error {}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f6 = (n: number) => n.toFixed(6);

function displaySize(m: MediaAsset): { w: number; h: number } {
  const v = m.probe.video!;
  const rot = v.rotation % 180 !== 0;
  return rot ? { w: v.height, h: v.width } : { w: v.width, h: v.height };
}

export function encoderArgs(s: ExportSettings, encoder: string): string[] {
  const a: string[] = [];
  if (encoder === 'libx264' || encoder === 'libx265') {
    a.push('-c:v', encoder, '-crf', String(s.crf), '-preset', s.preset);
    if (encoder === 'libx265') a.push('-tag:v', 'hvc1');
  } else if (encoder.endsWith('_nvenc')) {
    a.push('-c:v', encoder, '-preset', s.preset === 'fast' ? 'p4' : 'p6', '-rc', 'vbr', '-cq', String(s.crf + 1), '-b:v', '0');
  } else if (encoder.endsWith('_qsv')) {
    a.push('-c:v', encoder, '-global_quality', String(s.crf + 2));
  } else if (encoder.endsWith('_amf')) {
    a.push('-c:v', encoder, '-rc', 'cqp', '-qp_i', String(s.crf), '-qp_p', String(s.crf + 2));
  } else {
    a.push('-c:v', encoder);
  }
  a.push('-pix_fmt', 'yuv420p');
  return a;
}

/** Builds the FFmpeg command for a sequence. Pure: no I/O. */
export function buildExportPlan(project: Project, seq: Sequence, output: string, opts: { range?: ExportRange; encoder?: string } = {}): ExportPlan {
  const s = project.exportSettings;
  const { width: W, height: H, frameRate: r, sampleRate: SR } = seq.settings;
  const rateStr = `${r.num}/${r.den}`;
  const range = opts.range ?? { start: 0, end: sequenceDuration(seq) };
  const frames = range.end - range.start;
  if (frames < 1) throw new ExportError('Nothing to export: the sequence is empty');
  const durSec = framesToSeconds(frames, r);

  const inputs: string[] = [];
  const filters: string[] = [];
  let nIn = 0;

  filters.push(`color=c=black:s=${W}x${H}:r=${rateStr}:d=${f6(durSec)},format=yuv420p,setsar=1[base0]`);
  let last = 'base0';
  let ov = 0;

  // Visible part of a plan item inside the export range (frames relative to range start).
  const visible = (it: PlanItem) => {
    const s0 = Math.max(it.start, range.start);
    const e0 = Math.min(it.end, range.end);
    if (e0 <= s0) return null;
    const srcIn = it.sourceIn + framesToSeconds(s0 - it.start, r) * it.clip.speed;
    // Ramps are expressed relative to the visible window (clamped at range boundaries).
    const fin = Math.max(0, it.rampIn - (s0 - it.start));
    const fout = Math.max(0, it.rampOut - (it.end - e0));
    return { start: s0 - range.start, frames: e0 - s0, srcIn, fin: Math.min(fin, e0 - s0), fout: Math.min(fout, e0 - s0) };
  };

  const plan = planSequence(seq, project.media);
  for (const it of plan.filter((x) => x.kind === 'video')) {
    const p = visible(it);
    if (!p) continue;
    const clipSec = framesToSeconds(p.frames, r);
    if (it.media.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', rateStr, '-t', f6(clipSec + 1), '-i', it.media.path);
    } else {
      // +1s of slack so fps/trim always have enough frames to cut the exact count.
      inputs.push('-ss', f6(p.srcIn), '-t', f6(clipSec + 1), '-i', it.media.path);
    }
    const idx = nIn++;
    const { w, h } = displaySize(it.media);
    const tr = it.clip.transform;
    const fit = Math.min(W / w, H / h) * tr.scale;
    const ow = even(w * fit);
    const oh = even(h * fit);
    const x = Math.round((W - ow) / 2 + tr.x);
    const y = Math.round((H - oh) / 2 + tr.y);
    const chain = [`fps=${rateStr}`, 'setpts=PTS-STARTPTS', `trim=end_frame=${p.frames}`, 'setpts=PTS-STARTPTS', `scale=${ow}:${oh}:flags=lanczos`, 'setsar=1'];
    const needsAlpha = tr.rotation % 360 !== 0 || tr.opacity < 1 || p.fin > 0 || p.fout > 0;
    if (needsAlpha) chain.push('format=yuva420p');
    if (tr.rotation % 360 !== 0) {
      const a = f6((tr.rotation * Math.PI) / 180);
      chain.push(`rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`);
    }
    if (tr.opacity < 1) chain.push(`colorchannelmixer=aa=${Math.max(0, tr.opacity).toFixed(4)}`);
    if (p.fin > 0) chain.push(`fade=t=in:s=0:n=${p.fin}:alpha=1`);
    if (p.fout > 0) chain.push(`fade=t=out:s=${p.frames - p.fout}:n=${p.fout}:alpha=1`);
    chain.push(`setpts=PTS+${f6(framesToSeconds(p.start, r))}/TB`);
    filters.push(`[${idx}:v]${chain.join(',')}[v${idx}]`);
    const next = `ov${ov++}`;
    filters.push(`[${last}][v${idx}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[${next}]`);
    last = next;
  }
  filters.push(`[${last}]format=yuv420p,trim=end_frame=${frames}[vout]`);

  // Audio
  const audioLabels: string[] = [];
  for (const it of plan.filter((x) => x.kind === 'audio')) {
    const p = visible(it);
    if (!p) continue;
    const clipSec = framesToSeconds(p.frames, r);
    inputs.push('-ss', f6(p.srcIn), '-t', f6(clipSec + 0.5), '-i', it.media.path);
    const idx = nIn++;
    const delaySamples = Math.round(framesToSeconds(p.start, r) * SR);
    const samples = Math.round(clipSec * SR);
    const chain = [
      `aresample=${SR}`,
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      'asetpts=PTS-STARTPTS',
      `atrim=end_sample=${samples}`,
      `volume=${it.clip.gainDb.toFixed(2)}dB`,
    ];
    if (p.fin > 0) chain.push(`afade=t=in:ss=0:ns=${Math.round(framesToSeconds(p.fin, r) * SR)}`);
    if (p.fout > 0) {
      const ns = Math.round(framesToSeconds(p.fout, r) * SR);
      chain.push(`afade=t=out:ss=${samples - ns}:ns=${ns}`);
    }
    chain.push(`adelay=delays=${delaySamples}S:all=1`);
    filters.push(`[${idx}:a]${chain.join(',')}[a${idx}]`);
    audioLabels.push(`[a${idx}]`);
  }
  const totalSamples = Math.round(durSec * SR);
  filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=end_sample=${totalSamples}[abase]`);
  if (audioLabels.length) {
    filters.push(`[abase]${audioLabels.join('')}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0:dropout_transition=0,atrim=end_sample=${totalSamples}[aout]`);
  } else {
    filters.push(`[abase]anull[aout]`);
  }

  const encoder = opts.encoder ?? (s.videoCodec === 'hevc' ? 'libx265' : 'libx264');
  const args = [
    '-v', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    ...encoderArgs(s, encoder),
    '-r', rateStr,
    '-c:a', 'aac',
    '-b:a', `${s.audioBitrateKbps}k`,
    '-ar', String(SR),
    '-frames:v', String(frames),
    '-progress', 'pipe:1',
    '-nostats',
  ];
  if (s.container === 'mp4' || s.container === 'mov') args.push('-movflags', '+faststart');
  args.push(output);
  return { args, durationSec: durSec, frames, hasAudio: audioLabels.length > 0 };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  frames: number;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Inspects a rendered file and checks it against the plan. */
export async function verifyExport(file: string, seq: Sequence, expectedFrames: number): Promise<VerifyResult> {
  const problems: string[] = [];
  const { stdout } = await ffprobe(['-v', 'error', '-count_packets', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(stdout.toString()) as { streams: { codec_type: string; width?: number; height?: number; nb_read_packets?: string }[]; format: { duration?: string } };
  const v = j.streams.find((x) => x.codec_type === 'video');
  const a = j.streams.find((x) => x.codec_type === 'audio');
  const frames = Number(v?.nb_read_packets ?? 0);
  const durationSec = Number(j.format.duration ?? 0);
  if (!v) problems.push('no video stream');
  if (!a) problems.push('no audio stream');
  if (v && (v.width !== seq.settings.width || v.height !== seq.settings.height)) problems.push(`resolution ${v.width}x${v.height}`);
  if (Math.abs(frames - expectedFrames) > 0) problems.push(`frame count ${frames} != ${expectedFrames}`);
  const expectedSec = expectedFrames / rateToNumber(seq.settings.frameRate);
  if (Math.abs(durationSec - expectedSec) > 0.1) problems.push(`duration ${durationSec.toFixed(3)}s != ${expectedSec.toFixed(3)}s`);
  return { ok: problems.length === 0, problems, frames, durationSec, width: v?.width ?? 0, height: v?.height ?? 0, hasAudio: !!a };
}

export interface ExportJob {
  project: Project;
  sequenceId: string;
  output: string;
  range?: ExportRange;
  encoder?: string;
  onProgress?: (fraction: number) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export async function exportSequence(job: ExportJob): Promise<VerifyResult> {
  const seq = job.project.sequences[job.sequenceId];
  if (!seq) throw new ExportError('Sequence not found');
  for (const t of seq.tracks)
    for (const c of t.clips) {
      const m = job.project.media[c.mediaId];
      if (c.enabled && !t.disabled && (!m || !fs.existsSync(m.path))) throw new ExportError(`Media offline: ${m?.name ?? c.name}`);
    }
  const ext = path.extname(job.output) || `.${job.project.exportSettings.container}`;
  const tmp = path.join(path.dirname(job.output), `.${path.basename(job.output, ext)}.rendering${ext}`);
  await fsp.mkdir(path.dirname(job.output), { recursive: true });
  const plan = buildExportPlan(job.project, seq, tmp, { range: job.range, encoder: job.encoder });
  job.onLog?.(`ffmpeg ${plan.args.length} args, ${plan.frames} frames`);
  try {
    await ffmpeg(plan.args, {
      signal: job.signal,
      onStdoutLine: (l) => {
        if (l.startsWith('out_time_us=')) job.onProgress?.(Math.min(0.99, Number(l.slice(12)) / 1e6 / plan.durationSec));
      },
    });
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e instanceof CancelledError) throw e;
    throw e;
  }
  const result = await verifyExport(tmp, seq, plan.frames);
  if (!result.ok) {
    await fsp.rm(tmp, { force: true });
    throw new ExportError(`Export verification failed: ${result.problems.join(', ')}`);
  }
  await fsp.rename(tmp, job.output);
  job.onProgress?.(1);
  return result;
}
