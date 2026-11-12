import { type MediaKind, type MediaProbe, parseRate, rateToNumber } from '../core';
import { ffprobe } from './ffmpeg';

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg2000', 'bmp', 'tiff', 'webp', 'gif', 'jpegls']);

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

export class ProbeError extends Error {}

export async function probeMedia(file: string, signal?: AbortSignal): Promise<{ probe: MediaProbe; kind: MediaKind }> {
  const { stdout } = await ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal });
  let json: { streams?: FfStream[]; format?: { duration?: string; format_name?: string; bit_rate?: string } };
  try {
    json = JSON.parse(stdout.toString('utf8'));
  } catch {
    throw new ProbeError('ffprobe returned invalid JSON');
  }
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new ProbeError('No audio or video stream found');
  const container = json.format?.format_name ?? 'unknown';
  const isImage = !!v && !a && (IMAGE_CODECS.has(v.codec_name ?? '') && (container.includes('image2') || container.includes('_pipe') || container === 'png_pipe' || Number(v.nb_frames ?? 1) <= 1));
  let durationSec = Number(json.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  if (!Number.isFinite(durationSec)) durationSec = 0;
  if (!isImage && durationSec <= 0) throw new ProbeError('Media has no measurable duration');

  const probe: MediaProbe = { durationSec: isImage ? 0 : durationSec, container };
  if (json.format?.bit_rate) probe.bitRate = Number(json.format.bit_rate);
  if (v) {
    const r = parseRate(v.r_frame_rate ?? '') ?? { num: 30, den: 1 };
    const avg = parseRate(v.avg_frame_rate ?? '') ?? r;
    let rotation = 0;
    const sd = v.side_data_list?.find((x) => typeof x.rotation === 'number');
    if (sd?.rotation) rotation = ((Math.round(-sd.rotation) % 360) + 360) % 360;
    else if (v.tags?.rotate) rotation = ((Number(v.tags.rotate) % 360) + 360) % 360;
    probe.video = {
      codec: v.codec_name ?? 'unknown',
      width: v.width ?? 0,
      height: v.height ?? 0,
      frameRate: r,
      avgFrameRate: avg,
      // VFR heuristic: nominal and average rates disagree by more than 0.5%.
      isVFR: !isImage && Math.abs(rateToNumber(r) - rateToNumber(avg)) / rateToNumber(r) > 0.005,
      pixFmt: v.pix_fmt ?? 'unknown',
      rotation,
    };
  }
  if (a) {
    probe.audio = { codec: a.codec_name ?? 'unknown', sampleRate: Number(a.sample_rate ?? 48000), channels: a.channels ?? 2 };
  }
  const kind: MediaKind = isImage ? 'image' : v ? 'video' : 'audio';
  return { probe, kind };
}
