/** Narration/music analysis with FFmpeg: speech segmentation (silencedetect) and EBU R128 loudness. */
import type { Interval } from '../production/align';
import { ffmpeg } from './ffmpeg';

export interface AudioAnalysis {
  duration: number;
  silences: Interval[];
  integratedLufs: number | null;
  truePeakDb: number | null;
}

export async function analyzeAudio(file: string, opts: { noiseDb?: number; minSilence?: number; signal?: AbortSignal } = {}): Promise<AudioAnalysis> {
  const noise = opts.noiseDb ?? -35;
  const minSil = opts.minSilence ?? 0.18;
  const { stderr } = await ffmpeg(['-v', 'info', '-i', file, '-vn', '-af', `silencedetect=noise=${noise}dB:d=${minSil},ebur128=peak=true`, '-f', 'null', '-'], { signal: opts.signal });
  const silences: Interval[] = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const v = Math.max(0, Number(m[2]));
    if (m[1] === 'start') open = v;
    else if (open !== null) {
      silences.push({ start: open, end: v });
      open = null;
    }
  }
  const dm = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
  const durMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const toSec = (m: RegExpExecArray | RegExpMatchArray | null | undefined) => (m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
  const duration = toSec(durMatch) || toSec(dm);
  if (open !== null) silences.push({ start: open, end: duration });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  return {
    duration,
    silences,
    integratedLufs: I && Number.isFinite(Number(I[1])) && Number(I[1]) > -70 ? Number(I[1]) : null,
    truePeakDb: peak && peak[1] !== '-inf' ? Number(peak[1]) : null,
  };
}
