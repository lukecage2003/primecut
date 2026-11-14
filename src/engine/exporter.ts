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
import crypto from 'node:crypto';
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
  captionsToAss,
  motionExpr,
  pathExpr,
  PANEL_OVERFLOW,
  planSequence,
  sequenceDuration,
  secondsToFrames,
  duckEnvelope,
  envelopeToSendcmd,
  trackActivity,
} from '../core';
import { CancelledError, ffmpeg, ffprobe } from './ffmpeg';
import { cpuExportEncoder } from './videoEncoders';
import { cacheDirs, makePeaks } from './media';

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
  } else if (encoder === 'libsvtav1') {
    // AV1 on the processor (no GPL): CRF on the AV1 scale (x264 18 ≈ AV1 28), preset by speed setting
    a.push('-c:v', encoder, '-crf', String(Math.min(63, s.crf + 10)), '-preset', s.preset === 'fast' ? '8' : s.preset === 'slow' ? '4' : '6', '-svtav1-params', 'tune=0');
  } else if (encoder === 'libaom-av1') {
    a.push('-c:v', encoder, '-crf', String(Math.min(63, s.crf + 10)), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1');
  } else if (encoder === 'libvpx-vp9') {
    a.push('-c:v', encoder, '-crf', String(Math.min(63, s.crf + 13)), '-b:v', '0', '-row-mt', '1', '-cpu-used', s.preset === 'slow' ? '1' : '2');
  } else {
    a.push('-c:v', encoder);
  }
  a.push('-pix_fmt', 'yuv420p');
  return a;
}

/** Builds the FFmpeg command for a sequence. Pure: no I/O. */
/** Escapes a filesystem path for use inside a quoted filtergraph option (Windows drive colons). */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function buildExportPlan(
  project: Project,
  seq: Sequence,
  output: string,
  /** duckFiles: trackId → sendcmd script (from envelopeToSendcmd) for ducked audio tracks. */
  opts: {
    range?: ExportRange;
    encoder?: string;
    assFile?: string;
    duckFiles?: Record<string, string>;
    /** 'video' = picture only (segments), 'audio' = sound only (full-length AAC pass). */
    streams?: 'both' | 'video' | 'audio';
  } = {},
): ExportPlan {
  const wantVideo = opts.streams !== 'audio';
  const wantAudio = opts.streams !== 'video';
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
  for (const it of plan.filter((x) => wantVideo && x.kind === 'video')) {
    const p = visible(it);
    if (!p) continue;
    const clipSec = framesToSeconds(p.frames, r);
    if (it.media.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', rateStr, '-t', f6(clipSec + 1), '-i', it.media.path);
    } else {
      // +1s of slack so fps/trim always have enough frames to cut the exact count.
      // VP9/VP8 alpha lives in a side channel only libvpx decodes (P-CORE renders, transparent overlays)
      const vpxAlpha = it.media.hasAlpha && /^vp[89]$/.test(it.media.probe.video?.codec ?? '') ? ['-c:v', it.media.probe.video!.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : [];
      inputs.push('-ss', f6(p.srcIn), '-t', f6(clipSec + 1), ...vpxAlpha, '-i', it.media.path);
    }
    const idx = nIn++;
    const { w, h } = displaySize(it.media);
    const tr = it.clip.transform;
    const fit = Math.min(W / w, H / h) * tr.scale;
    const ow = even(w * fit);
    const oh = even(h * fit);
    const x = Math.round((W - ow) / 2 + tr.x);
    const y = Math.round((H - oh) / 2 + tr.y);
    const chain = [`fps=${rateStr}`, 'setpts=PTS-STARTPTS', `trim=end_frame=${p.frames}`, 'setpts=PTS-STARTPTS'];
    let panelsFull = false;
    const mo = it.clip.motion;
    if (mo && mo.kind === 'panels' && mo.path && mo.path.length) {
      // panel reading: the clip fills the whole frame; the window path drives scale + crop
      const itemSec = framesToSeconds(it.end - it.start, r);
      const off = framesToSeconds(Math.max(it.start, range.start) - it.start, r);
      const tt = (e: string) => e.replace(/\bt\b/g, `(t+${f6(off)})`);
      // pad the page so windows may extend past it (dark background), then map windows into padded space
      const E = PANEL_OVERFLOW;
      const padded = mo.path.map((q) => ({ x: (q.x + E.x) / (1 + 2 * E.x), y: (q.y + E.y) / (1 + 2 * E.y), w: q.w / (1 + 2 * E.x), h: q.h / (1 + 2 * E.y) }));
      const X = tt(pathExpr(padded, 'x', itemSec));
      const Y = tt(pathExpr(padded, 'y', itemSec));
      const PW = tt(pathExpr(padded, 'w', itemSec));
      const PH = tt(pathExpr(padded, 'h', itemSec));
      // pictures: the area around the page is transparent, a blurred copy of the page shows through (no black bands)
      const soft = it.media.kind === 'image';
      if (soft) chain.push('format=yuva420p');
      chain.push(
        `pad=w=trunc(iw*${1 + 2 * E.x}/2)*2:h=trunc(ih*${1 + 2 * E.y}/2)*2:x=iw*${E.x}:y=ih*${E.y}:color=${soft ? '0x00000000' : '0x08080A'}`,
        `scale=w='trunc(${W}/(${PW})/2)*2':h='trunc(${H}/(${PH})/2)*2':eval=frame:flags=bicubic`,
        `crop=${W}:${H}:x='min(iw-${W},max(0,(${X})*iw))':y='min(ih-${H},max(0,(${Y})*ih))'`,
      );
      panelsFull = true;
    } else if (mo && mo.kind !== 'none' && mo.amount > 0) {
      // Ken Burns: per-frame scale of the fitted frame, then a fixed-size crop that pans.
      const itemSec = framesToSeconds(it.end - it.start, r);
      const off = framesToSeconds(Math.max(it.start, range.start) - it.start, r);
      const ex = motionExpr(mo, itemSec);
      const tt = (e: string) => e.replace(/\bt\b/g, `(t+${f6(off)})`);
      chain.push(
        `scale=w='trunc(${ow}*${tt(ex.zoom)}/2)*2':h='trunc(${oh}*${tt(ex.zoom)}/2)*2':eval=frame:flags=bicubic`,
        `crop=${ow}:${oh}:x='(iw-${ow})/2*(1+${tt(ex.panX)})':y='(ih-${oh})/2*(1+${tt(ex.panY)})'`,
      );
    } else {
      chain.push(`scale=${ow}:${oh}:flags=lanczos`);
    }
    chain.push('setsar=1');
    const needsAlpha = !!it.media.hasAlpha || tr.rotation % 360 !== 0 || tr.opacity < 1 || p.fin > 0 || p.fout > 0;
    if (needsAlpha) chain.push('format=yuva420p');
    if (tr.rotation % 360 !== 0) {
      const a = f6((tr.rotation * Math.PI) / 180);
      chain.push(`rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`);
    }
    if (tr.opacity < 1) chain.push(`colorchannelmixer=aa=${Math.max(0, tr.opacity).toFixed(4)}`);
    chain.push(...(p.fin > 0 ? [`fade=t=in:s=0:n=${p.fin}:alpha=1`] : []), ...(p.fout > 0 ? [`fade=t=out:s=${p.frames - p.fout}:n=${p.fout}:alpha=1`] : []));
    chain.push(`setpts=PTS+${f6(framesToSeconds(p.start, r))}/TB`);
    const fades: string[] = [];
    if (p.fin > 0) fades.push(`fade=t=in:s=0:n=${p.fin}:alpha=1`);
    if (p.fout > 0) fades.push(`fade=t=out:s=${p.frames - p.fout}:n=${p.fout}:alpha=1`);
    const offset = `setpts=PTS+${f6(framesToSeconds(p.start, r))}/TB`;
    if (panelsFull && it.media.kind === 'image') {
      const head = chain.slice(0, 4).join(',');
      filters.push(`[${idx}:v]${head},split[s${idx}a][s${idx}b]`);
      filters.push(`[s${idx}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=${Math.round(H / 30)}:2,eq=brightness=-0.16:saturation=0.8,setsar=1,format=yuva420p${fades.length ? ',' + fades.join(',') : ''},${offset}[bg${idx}]`);
      const nb = `ov${ov++}`;
      filters.push(`[${last}][bg${idx}]overlay=x=0:y=0:eof_action=pass:format=auto[${nb}]`);
      last = nb;
      filters.push(`[s${idx}b]${chain.slice(4).join(',')}[v${idx}]`);
      const nx = `ov${ov++}`;
      filters.push(`[${last}][v${idx}]overlay=x=0:y=0:eof_action=pass:format=auto[${nx}]`);
      last = nx;
      continue;
    }
    if (panelsFull) {
      filters.push(`[${idx}:v]${chain.join(',')}[v${idx}]`);
      const nx = `ov${ov++}`;
      filters.push(`[${last}][v${idx}]overlay=x=0:y=0:eof_action=pass:format=auto[${nx}]`);
      last = nx;
      continue;
    }
    if (it.clip.fill === 'blur' && (ow < W || oh < H)) {
      // blurred, darkened cover-scaled copy fills the frame behind the fitted picture
      const head = chain.slice(0, 4).join(',');
      const rest = chain.slice(4);
      filters.push(`[${idx}:v]${head},split[s${idx}a][s${idx}b]`);
      filters.push(`[s${idx}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=${Math.round(H / 40)}:2,eq=brightness=-0.12:saturation=0.85,setsar=1,format=yuva420p${fades.length ? ',' + fades.join(',') : ''},${offset}[bg${idx}]`);
      const nb = `ov${ov++}`;
      filters.push(`[${last}][bg${idx}]overlay=x=0:y=0:eof_action=pass:format=auto[${nb}]`);
      last = nb;
      filters.push(`[s${idx}b]${rest.join(',')}[v${idx}]`);
    } else {
      filters.push(`[${idx}:v]${chain.join(',')}[v${idx}]`);
    }
    const next = `ov${ov++}`;
    filters.push(`[${last}][v${idx}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[${next}]`);
    last = next;
  }
  const caps = seq.captions?.filter((c) => c.end > range.start && c.start < range.end) ?? [];
  const assFilter = caps.length && opts.assFile ? `,ass='${escapeFilterPath(opts.assFile)}'` : '';
  filters.push(`[${last}]format=yuv420p${assFilter},trim=end_frame=${frames}[vout]`);

  // Audio
  const audioLabels: string[] = [];
  const busInputs: Record<string, string[]> = {};
  for (const it of plan.filter((x) => wantAudio && x.kind === 'audio')) {
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
    if (opts.duckFiles?.[it.track.id]) (busInputs[it.track.id] ??= []).push(`[a${idx}]`);
    else audioLabels.push(`[a${idx}]`);
  }
  const totalSamples = Math.round(durSec * SR);
  // ducked tracks: sub-mix, then the shared gain envelope as sample-accurate volume commands
  for (const [trackId, labels] of Object.entries(busInputs)) {
    const b = duckFilterName(trackId);
    filters.push(
      `anullsrc=r=${SR}:cl=stereo,atrim=end_sample=${totalSamples}[${b}z];[${b}z]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:normalize=0:dropout_transition=0,` +
        `asendcmd=f='${escapeFilterPath(opts.duckFiles![trackId]!)}',volume@${b}=volume=1:eval=frame[${b}]`,
    );
    audioLabels.push(`[${b}]`);
  }
  filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=end_sample=${totalSamples}[abase]`);
  if (audioLabels.length) {
    // master safety limiter: peaks stay below -1 dBFS (sample peak ≈ -1.5 dB leaves room for true peak)
    filters.push(`[abase]${audioLabels.join('')}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.84:attack=2:release=60:level=false:latency=1,atrim=end_sample=${totalSamples}[aout]`);
  } else {
    filters.push(`[abase]anull[aout]`);
  }

  const encoder = opts.encoder ?? (s.videoCodec === 'hevc' ? 'libx265' : 'libx264');
  const fg = wantVideo && wantAudio ? filters : filters.filter((f) => (wantVideo ? !/\[a(?:out|base)\]|\[a\d+\]|\[duck_/.test(f) : !/\[vout\]|\[base0\]|\[v\d+\]|\[ov\d+\]|\[bg\d+\]|\[s\d+[ab]\]/.test(f)));
  const args = ['-v', 'error', ...inputs, '-filter_complex', fg.join(';')];
  if (wantVideo) args.push('-map', '[vout]', ...encoderArgs(s, encoder), '-r', rateStr, '-frames:v', String(frames));
  if (wantAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', `${s.audioBitrateKbps}k`, '-ar', String(SR));
  if (!wantAudio) args.push('-an');
  args.push('-progress', 'pipe:1', '-nostats');
  if (wantVideo && (s.container === 'mp4' || s.container === 'mov')) args.push('-movflags', '+faststart');
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
  /** Project cache folder (waveform peaks for ducking); defaults to a cache next to the output. */
  cacheDir?: string;
  /** Segment length for segmented rendering (s). 0 = always single pass; undefined = automatic. */
  segmentSeconds?: number;
  onProgress?: (fraction: number) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Segment boundaries (frames) close to every `target` frames, placed where no transition or fade
 * is running, so every segment renders exactly what the single-pass export would.
 */
export function segmentBoundaries(project: Project, seq: Sequence, range: ExportRange, target: number): number[] {
  const plan = planSequence(seq, project.media).filter((p) => p.kind === 'video');
  const busy = (f: number) => plan.some((p) => (f > p.start && f < p.start + p.rampIn) || (f > p.end - p.rampOut && f < p.end));
  const cuts = [...new Set(plan.flatMap((p) => [p.start, p.end]))].filter((f) => f > range.start && f < range.end && !busy(f)).sort((a, b) => a - b);
  const out = [range.start];
  for (let goal = range.start + target; goal < range.end - target / 3; goal += target) {
    const near = cuts.filter((c) => c > out.at(-1)! + target / 3 && Math.abs(c - goal) <= target / 3);
    let b = near.sort((x, y) => Math.abs(x - goal) - Math.abs(y - goal))[0];
    if (b === undefined) {
      // no cut nearby: any frame outside ramps
      for (let d = 0; d < target / 3 && b === undefined; d++) for (const f of [goal + d, goal - d]) if (f > out.at(-1)! && f < range.end && !busy(f)) (b ??= f);
    }
    if (b !== undefined && b > out.at(-1)!) out.push(b);
  }
  out.push(range.end);
  return out;
}

/** Long or clip-heavy timelines are rendered in segments (resumable, short command lines on Windows). */
export function shouldSegment(project: Project, seq: Sequence, range: ExportRange): boolean {
  const frames = range.end - range.start;
  const r = seq.settings.frameRate;
  const clips = planSequence(seq, project.media).filter((p) => p.end > range.start && p.start < range.end).length;
  return framesToSeconds(frames, r) > 240 || clips > 60;
}

export async function exportSequence(job: ExportJob): Promise<VerifyResult> {
  const seq = job.project.sequences[job.sequenceId];
  if (!seq) throw new ExportError('Sequence not found');
  const range0 = job.range ?? { start: 0, end: sequenceDuration(seq) };
  if (job.segmentSeconds !== 0 && (job.segmentSeconds || shouldSegment(job.project, seq, range0))) return exportSegmented(job, seq, range0);
  for (const t of seq.tracks)
    for (const c of t.clips) {
      const m = job.project.media[c.mediaId];
      if (c.enabled && !t.disabled && (!m || !fs.existsSync(m.path))) throw new ExportError(`Media offline: ${m?.name ?? c.name}`);
    }
  const ext = path.extname(job.output) || `.${job.project.exportSettings.container}`;
  const tmp = path.join(path.dirname(job.output), `.${path.basename(job.output, ext)}.rendering${ext}`);
  await fsp.mkdir(path.dirname(job.output), { recursive: true });
  let assFile: string | undefined;
  if (seq.captions?.length) {
    assFile = path.join(path.dirname(job.output), `.${path.basename(job.output, ext)}.captions.ass`);
    await fsp.writeFile(assFile, captionsToAss(seq, seq.captions, job.range?.start ?? 0), 'utf8');
  }
  const duckFiles = await writeDuckFiles(job.project, seq, job.cacheDir ?? path.join(path.dirname(job.output), '.primestone-cache'), path.dirname(job.output), `.${path.basename(job.output, ext)}`, job.range?.start ?? 0, job.signal);
  const plan = buildExportPlan(job.project, seq, tmp, { range: job.range, encoder: job.encoder ?? (await cpuExportEncoder(job.project.exportSettings.videoCodec === 'hevc' ? 'hevc' : 'h264')), assFile, duckFiles });
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
    if (assFile) await fsp.rm(assFile, { force: true });
    for (const f of Object.values(duckFiles)) await fsp.rm(f, { force: true });
    if (e instanceof CancelledError) throw e;
    throw e;
  }
  if (assFile) await fsp.rm(assFile, { force: true });
  for (const f of Object.values(duckFiles)) await fsp.rm(f, { force: true });
  const result = await verifyExport(tmp, seq, plan.frames);
  if (!result.ok) {
    await fsp.rm(tmp, { force: true });
    throw new ExportError(`Export verification failed: ${result.problems.join(', ')}`);
  }
  await fsp.rename(tmp, job.output);
  job.onProgress?.(1);
  return result;
}

/** Computes each ducked track's envelope from the source track's waveform peaks (cached). */
export async function writeDuckFiles(project: Project, seq: Sequence, cacheRoot: string, dir: string, prefix: string, rangeStartFrame: number, signal?: AbortSignal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ducked = seq.tracks.filter((t) => t.kind === 'audio' && t.duck && !t.disabled && seq.tracks.some((x) => x.id === t.duck!.by));
  if (!ducked.length) return out;
  const cache = cacheDirs(cacheRoot);
  await fsp.mkdir(cache.peaks, { recursive: true });
  const peaks: Record<string, Uint8Array | undefined> = {};
  for (const t of ducked) {
    const src = seq.tracks.find((x) => x.id === t.duck!.by)!;
    if (src.disabled) continue;
    for (const c of src.clips) {
      const m = project.media[c.mediaId];
      if (m && !(m.id in peaks)) peaks[m.id] = (await makePeaks(m, cache, signal)) ?? undefined;
    }
    const keys = duckEnvelope(trackActivity(seq, project.media, src.id, peaks, t.duck!.threshold), t.duck!);
    const f = path.join(dir, `${prefix}.duck-${t.id}.cmd`);
    await fsp.writeFile(f, envelopeToSendcmd(keys, duckFilterName(t.id), framesToSeconds(rangeStartFrame, seq.settings.frameRate)));
    out[t.id] = f;
  }
  return out;
}

export const duckFilterName = (trackId: string) => `duck_${trackId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;

/**
 * Segmented export: the picture is rendered in segments (each a plain range export, video only),
 * the sound in one full-length pass, then both are joined without re-encoding and verified.
 * Finished segments are kept until the export succeeds, so a cancelled/crashed export resumes.
 */
async function exportSegmented(job: ExportJob, seq: Sequence, range: ExportRange): Promise<VerifyResult> {
  for (const t of seq.tracks)
    for (const c of t.clips) {
      const m = job.project.media[c.mediaId];
      if (c.enabled && !t.disabled && (!m || !fs.existsSync(m.path))) throw new ExportError(`Media offline: ${m?.name ?? c.name}`);
    }
  const r = seq.settings.frameRate;
  const ext = path.extname(job.output) || `.${job.project.exportSettings.container}`;
  const base = path.basename(job.output, ext);
  const outDir = path.dirname(job.output);
  const work = path.join(outDir, `.${base}.segments`);
  await fsp.mkdir(work, { recursive: true });
  const target = Math.max(1, secondsToFrames(job.segmentSeconds ?? 60, r));
  const bounds = segmentBoundaries(job.project, seq, range, target);
  const total = range.end - range.start;
  const encoder = job.encoder ?? (await cpuExportEncoder(job.project.exportSettings.videoCodec === 'hevc' ? 'hevc' : 'h264'));
  const segFiles: string[] = [];
  let doneFrames = 0;
  const report = (f: number) => job.onProgress?.(Math.min(0.99, (0.88 * f) / total));
  for (let i = 0; i + 1 < bounds.length; i++) {
    const seg = { start: bounds[i]!, end: bounds[i + 1]! };
    const ass = seq.captions?.some((c) => c.end > seg.start && c.start < seg.end) ? path.join(work, `seg${i}.ass`) : undefined;
    if (ass) await fsp.writeFile(ass, captionsToAss(seq, seq.captions, seg.start), 'utf8');
    const probePlan = buildExportPlan(job.project, seq, 'OUT', { range: seg, encoder, assFile: ass ? 'ASS' : undefined, streams: 'video' });
    // the segment is identified by what it renders (resume only reuses identical work)
    const key = crypto.createHash('sha256').update(JSON.stringify([probePlan.args, ass ? captionsToAss(seq, seq.captions, seg.start) : ''])).digest('hex').slice(0, 16);
    const file = path.join(work, `seg${String(i).padStart(4, '0')}-${key}${ext}`);
    segFiles.push(file);
    const frames = seg.end - seg.start;
    let ok = false;
    if (fs.existsSync(file)) {
      const v = await verifySegment(file, frames).catch(() => false);
      ok = v;
      if (ok) job.onLog?.(`segment ${i + 1}/${bounds.length - 1} reused`);
    }
    if (!ok) {
      const tmp = `${file}.part${ext}`;
      const plan = buildExportPlan(job.project, seq, tmp, { range: seg, encoder, assFile: ass, streams: 'video' });
      await ffmpeg(plan.args, {
        signal: job.signal,
        onStdoutLine: (l) => {
          if (l.startsWith('frame=')) report(doneFrames + Math.min(frames, Number(l.slice(6))));
        },
      }).catch(async (e) => {
        await fsp.rm(tmp, { force: true });
        throw e;
      });
      if (!(await verifySegment(tmp, frames))) throw new ExportError(`Segment ${i + 1} verification failed`);
      await fsp.rename(tmp, file);
    }
    if (ass) await fsp.rm(ass, { force: true });
    doneFrames += frames;
    report(doneFrames);
  }
  // sound: one full-length pass (ducking envelopes, limiter) → AAC
  const duckFiles = await writeDuckFiles(job.project, seq, job.cacheDir ?? path.join(outDir, '.primestone-cache'), work, 'audio', range.start, job.signal);
  const audioFile = path.join(work, 'audio.m4a');
  const ap = buildExportPlan(job.project, seq, audioFile, { range, duckFiles, streams: 'audio' });
  await ffmpeg(['-y', ...ap.args.slice(0, -1), '-f', 'mp4', audioFile], { signal: job.signal });
  job.onProgress?.(0.95);
  // join (stream copy) and verify
  const list = path.join(work, 'list.txt');
  await fsp.writeFile(list, segFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const tmp = path.join(outDir, `.${base}.rendering${ext}`);
  const mux = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-frames:v', String(total)];
  if (ext === '.mp4' || ext === '.mov') mux.push('-movflags', '+faststart');
  await ffmpeg([...mux, tmp], { signal: job.signal });
  const result = await verifyExport(tmp, seq, total);
  if (!result.ok) {
    await fsp.rm(tmp, { force: true });
    throw new ExportError(`Export verification failed: ${result.problems.join(', ')}`);
  }
  await fsp.rename(tmp, job.output);
  await fsp.rm(work, { recursive: true, force: true });
  job.onProgress?.(1);
  return result;
}

async function verifySegment(file: string, frames: number): Promise<boolean> {
  const { stdout } = await ffprobe(['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return Number(stdout.toString().trim()) === frames;
}
