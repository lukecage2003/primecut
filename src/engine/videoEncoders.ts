/**
 * Which video encoder to use, from what the FFmpeg in use really has.
 *
 * The installer ships an LGPL FFmpeg (no GPL component, the user's rule): it has no x264/x265. Then:
 *  - H.264 from the graphics card (NVENC, Quick Sync, AMF) when a real test encode works;
 *  - otherwise, on the processor, encoders free of GPL: AV1 (SVT-AV1) for exports (accepted by YouTube),
 *    VP9 for the app's own intermediate files (proxies, rendered compositions), which the preview reads.
 * A user who points PRIMESTONE_FFMPEG_DIR at a build with x264 gets x264 back automatically.
 */
import { ffmpeg, ffmpegPaths, run } from './ffmpeg';

let listed: Promise<Set<string>> | null = null;
let hw: Promise<string[]> | null = null;

/** Encoders listed by the FFmpeg in use (PRIMESTONE_DISABLE_ENCODERS hides some, for tests). */
export function listedEncoders(): Promise<Set<string>> {
  listed ??= run(ffmpegPaths().ffmpeg, ['-hide_banner', '-encoders'], { collectStdout: true })
    .then((r) => {
      const hidden = new Set((process.env.PRIMESTONE_DISABLE_ENCODERS ?? '').split(',').map((x) => x.trim()).filter(Boolean));
      return new Set([...r.stdout.toString().matchAll(/^\s*V\S*\s+(\S+)/gm)].map((m) => m[1]!).filter((e) => !hidden.has(e)));
    })
    .catch(() => new Set<string>());
  return listed;
}

/** Hardware H.264 encoders that pass a real one-frame encode on this computer. */
export function workingHardwareH264(): Promise<string[]> {
  hw ??= listedEncoders().then(async (l) => {
    const ok: string[] = [];
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf'].filter((x) => l.has(x))) {
      try {
        await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-frames:v', '1', '-c:v', e, '-f', 'null', '-']);
        ok.push(e);
      } catch {
        /* not usable on this machine */
      }
    }
    return ok;
  });
  return hw;
}

/** Forget what was measured (after the FFmpeg path changes). */
export function resetEncoderCache() {
  listed = null;
  hw = null;
}

/**
 * Encoder for the app's own intermediate videos (preview proxies, rendered compositions): fast, and
 * readable by the preview (H.264 or VP9 in MP4). Quality `crf` on the x264 scale.
 */
export async function intermediateVideoArgs(crf = 18, preset = 'veryfast'): Promise<string[]> {
  const l = await listedEncoders();
  if (l.has('libx264')) return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];
  const h = await workingHardwareH264();
  if (h[0]?.endsWith('_nvenc')) return ['-c:v', h[0], '-preset', 'p4', '-rc', 'vbr', '-cq', String(crf + 1), '-b:v', '0'];
  if (h[0]?.endsWith('_qsv')) return ['-c:v', h[0], '-global_quality', String(crf + 2)];
  if (h[0]?.endsWith('_amf')) return ['-c:v', h[0], '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2)];
  // VP9 on the processor, tuned for speed (intermediates only; exports are encoded again)
  return ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', String(Math.min(40, crf + 12)), '-b:v', '0'];
}

/** Processor encoder for exports when x264/x265 are absent: AV1 (SVT-AV1) or VP9. */
export async function cpuExportEncoder(codec: 'h264' | 'hevc'): Promise<string> {
  const l = await listedEncoders();
  const x = codec === 'hevc' ? 'libx265' : 'libx264';
  if (l.has(x)) return x;
  if (l.has('libsvtav1')) return 'libsvtav1';
  if (l.has('libaom-av1')) return 'libaom-av1';
  return 'libvpx-vp9';
}
