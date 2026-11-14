/**
 * What Primestone needs from FFmpeg, checked on the binary actually in use. Non-regression gate for
 * any FFmpeg change (docs/ETUDE_FFMPEG.md): a replacement binary is acceptable only if nothing here is
 * missing. Hardware encoders are optional (used only after a real test encode). Read-only.
 */
import { ffmpeg, ffmpegPaths, run } from './ffmpeg';

export const FFMPEG_REQUIREMENTS = {
  // x264/x265 are GPL: the installer's LGPL FFmpeg has neither (AV1/VP9 on the processor, H.264 on the graphics card)
  encoders: ['libvpx-vp9', 'aac', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'png', 'mjpeg', 'prores_ks', 'qtrle', 'libopus'],
  decoders: ['h264', 'hevc', 'libvpx-vp9', 'vp9', 'prores', 'png', 'mjpeg', 'webp', 'mp3', 'aac', 'flac', 'vorbis', 'opus', 'pcm_s16le', 'pcm_s24le'],
  filters: [
    'acompressor', 'aecho', 'aevalsrc', 'afade', 'afftdn', 'aformat', 'alimiter', 'alphaextract', 'amerge', 'amix', 'anoisesrc', 'anullsrc', 'apad', 'aresample', 'aselect', 'asetpts', 'asplit', 'ass', 'atrim',
    'bandreject', 'blend', 'color', 'colorchannelmixer', 'concat', 'crop', 'curves', 'deesser', 'ebur128', 'equalizer', 'fade', 'format', 'fps', 'gblur', 'geq', 'gradients', 'highpass', 'hue', 'agate', 'treble', 'afade', 'lagfun',
    'life', 'lowpass', 'mandelbrot', 'noise', 'overlay', 'pad', 'premultiply', 'rotate', 'scale', 'setpts', 'setsar', 'silencedetect', 'sine', 'split', 'testsrc2', 'trim', 'unpremultiply', 'volume',
  ],
  muxers: ['mp4', 'mov', 'webm', 'matroska', 'wav', 'flac', 'image2', 'null', 'f32le', 's16le', 'rawvideo', 'srt', 'webvtt'],
  demuxers: ['concat', 'lavfi', 'mov', 'matroska', 'mp3', 'wav', 'flac', 'ogg', 'image2', 'aac'],
  optionalEncoders: ['libx264', 'libx265', 'libsvtav1', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'],
} as const;

export interface FfmpegCapabilities {
  version: string | null;
  configuration: string | null;
  licence: string | null;
  missing: { kind: string; name: string }[];
  optionalPresent: string[];
  nonfree: boolean;
}

const names = (out: string, re: RegExp) => new Set([...out.matchAll(re)].map((m) => m[1]!));

export async function ffmpegCapabilities(): Promise<FfmpegCapabilities> {
  const bin = ffmpegPaths().ffmpeg;
  const q = async (a: string[]) => (await run(bin, ['-hide_banner', ...a], { collectStdout: true })).stdout.toString();
  const [ver, enc, dec, fil, mux, demux, dev] = await Promise.all([
    ffmpeg(['-version'], { collectStdout: true }).then((r) => r.stdout.toString()),
    q(['-encoders']),
    q(['-decoders']),
    q(['-filters']),
    q(['-muxers']),
    q(['-demuxers']),
    // lavfi is an input *device* in FFmpeg 8 (listed by -devices, not -demuxers)
    q(['-devices']).catch(() => ''),
  ]);
  const codecRe = /^\s[VAS][.A-Z]{5}\s+(\S+)/gm;
  const have = {
    encoders: names(enc, codecRe),
    decoders: names(dec, codecRe),
    filters: names(fil, /^\s[.TSC|]{2,3}\s+(\S+)/gm),
    muxers: new Set([...names(mux, /^\s+E\s+(\S+)/gm), ...names(mux, /^\s+DE\s+(\S+)/gm)].flatMap((n) => n.split(','))),
    demuxers: new Set([...names(demux, /^\s+D\s+(\S+)/gm), ...names(demux, /^\s+DE\s+(\S+)/gm), ...names(dev, /^\s+D\s+(\S+)/gm), ...names(dev, /^\s+DE\s+(\S+)/gm)].flatMap((n) => n.split(','))),
  };
  const missing: FfmpegCapabilities['missing'] = [];
  for (const kind of ['encoders', 'decoders', 'filters', 'muxers', 'demuxers'] as const) for (const n of FFMPEG_REQUIREMENTS[kind]) if (!have[kind].has(n)) missing.push({ kind, name: n });
  const configuration = /configuration: (.*)/.exec(ver)?.[1] ?? null;
  const licence = /--enable-gpl/.test(configuration ?? '') ? (/--enable-version3/.test(configuration ?? '') ? 'GPL-3.0' : 'GPL-2.0+') : configuration ? 'LGPL' : null;
  return {
    version: ver.split('\n')[0]?.trim() ?? null,
    configuration,
    licence,
    missing,
    optionalPresent: FFMPEG_REQUIREMENTS.optionalEncoders.filter((n) => have.encoders.has(n)),
    nonfree: /--enable-nonfree/.test(configuration ?? ''),
  };
}
