/**
 * "S'inspirer d'une vidéo": measures the editing of a reference video the creator has on this computer
 * (a video of their own, or one they have the right to keep) and turns it into editing preferences.
 *
 * Measured locally with FFmpeg: cuts (scene changes), shot lengths over the whole video, how much the
 * picture moves inside a shot (still pictures with slow camera moves vs live footage), loudness and the
 * share of speech. Nothing is sent anywhere; the video is only read.
 */
import { ffmpeg } from './ffmpeg';
import { analyzeAudio } from './audioAnalysis';
import type { ProductionPreferences } from '../production/preferences';

export interface StyleProfile {
  file: string;
  durationSec: number;
  cuts: number;
  cutsPerMinute: number;
  shot: { median: number; p10: number; p90: number; mean: number };
  /** Shot length along the video (10 parts): the rhythm, start to end. */
  rhythm: number[];
  /** Median picture change inside shots: ~0 still picture, small = slow camera move, large = live footage. */
  motion: number;
  motionKind: 'images fixes' | 'images animées (zooms, panoramiques)' | 'vidéo en mouvement';
  loudnessLufs: number | null;
  speechShare: number;
  summary: string[];
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
};

/** Parses FFmpeg `metadata=print` output: (time, scene score) pairs. */
export function parseSceneScores(stderr: string): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [];
  let t: number | null = null;
  for (const line of stderr.split('\n')) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) t = Number(mt[1]);
    const ms = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (ms && t !== null) {
      out.push({ t, s: Number(ms[1]) });
      t = null;
    }
  }
  return out;
}

/** Cuts and in-shot motion from scene scores (a cut: a strong change, at least `minGap` s after the previous one). */
export function cutsFromScores(scores: { t: number; s: number }[], threshold = 0.3, minGap = 0.4): { cuts: number[]; motion: number } {
  const cuts: number[] = [];
  const inShot: number[] = [];
  for (const x of scores) {
    if (x.s >= threshold && (cuts.length === 0 || x.t - cuts.at(-1)! >= minGap)) cuts.push(x.t);
    else if (x.s < threshold * 0.5) inShot.push(x.s);
  }
  return { cuts, motion: pct(inShot, 0.5) };
}

export function profileFrom(file: string, durationSec: number, cuts: number[], motion: number, loudnessLufs: number | null, speechShare: number): StyleProfile {
  const bounds = [0, ...cuts.filter((c) => c > 0.05 && c < durationSec - 0.05), durationSec];
  const shots = bounds.slice(1).map((b, i) => b - bounds[i]!).filter((x) => x > 0.04);
  // average length of the shots seen in each tenth of the video (weighted by how long they are on screen there)
  const rhythm = Array.from({ length: 10 }, (_, k) => {
    const a = (k / 10) * durationSec, b = ((k + 1) / 10) * durationSec;
    let w = 0, acc = 0;
    for (let i = 1; i < bounds.length; i++) {
      const o = Math.min(b, bounds[i]!) - Math.max(a, bounds[i - 1]!);
      if (o > 0) {
        w += o;
        acc += o * (bounds[i]! - bounds[i - 1]!);
      }
    }
    return +(w ? acc / w : 0).toFixed(2);
  });
  const motionKind = motion < 0.0015 ? 'images fixes' : motion < 0.02 ? 'images animées (zooms, panoramiques)' : 'vidéo en mouvement';
  const shot = { median: +pct(shots, 0.5).toFixed(2), p10: +pct(shots, 0.1).toFixed(2), p90: +pct(shots, 0.9).toFixed(2), mean: +(shots.reduce((a, x) => a + x, 0) / Math.max(1, shots.length)).toFixed(2) };
  const cpm = +((cuts.length / Math.max(1e-6, durationSec)) * 60).toFixed(1);
  const firstHalf = rhythm.slice(0, 5).reduce((a, x) => a + x, 0), secondHalf = rhythm.slice(5).reduce((a, x) => a + x, 0);
  const summary = [
    `${cuts.length} coupes en ${Math.round(durationSec)} s (${cpm} par minute) : plan médian de ${shot.median} s (10 % des plans sous ${shot.p10} s, 10 % au-dessus de ${shot.p90} s)`,
    `Image : ${motionKind}`,
    `Rythme : ${Math.abs(firstHalf - secondHalf) < 0.15 * (firstHalf + secondHalf) ? 'régulier du début à la fin' : firstHalf > secondHalf ? 'plans plus courts vers la fin (accélère)' : 'plans plus longs vers la fin (ralentit)'}`,
    `Son (voix ou musique) : ${Math.round(speechShare * 100)} % du temps${loudnessLufs !== null ? ` · volume ${loudnessLufs.toFixed(1)} LUFS` : ''}`,
  ];
  return { file, durationSec, cuts: cuts.length, cutsPerMinute: cpm, shot, rhythm, motion: +motion.toFixed(5), motionKind, loudnessLufs, speechShare: +speechShare.toFixed(2), summary };
}

/** Preferences that reproduce the measured editing (only what can be measured is changed). */
export function prefsFromProfile(p: StyleProfile, prefs: ProductionPreferences): { prefs: ProductionPreferences; changes: string[] } {
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const next = { ...prefs };
  const changes: string[] = [];
  const set = <K extends keyof ProductionPreferences>(k: K, v: ProductionPreferences[K], label: string) => {
    if (JSON.stringify(next[k]) === JSON.stringify(v)) return;
    next[k] = v;
    changes.push(label);
  };
  if (p.cuts >= 3) {
    const target = +clamp(p.shot.median, 1.5, 10).toFixed(2);
    const min = +clamp(Math.min(target, p.shot.p10), 1, target).toFixed(2);
    const max = +clamp(Math.max(target, p.shot.p90), target, 14).toFixed(2);
    set('shotTarget', target, `durée de plan visée : ${target} s`);
    set('shotMin', min, `plan le plus court : ${min} s`);
    set('shotMax', max, `plan le plus long : ${max} s`);
  }
  const amount = p.motionKind === 'images fixes' ? 0.04 : p.motionKind === 'vidéo en mouvement' ? 0.2 : +clamp(0.06 + p.motion * 6, 0.06, 0.2).toFixed(2);
  set('motionAmount', amount, `mouvement de caméra sur les images : ${Math.round(amount * 100)} %`);
  if (p.loudnessLufs !== null && p.loudnessLufs > -24 && p.loudnessLufs < -8) set('narrationLufs', Math.round(p.loudnessLufs), `volume final : ${Math.round(p.loudnessLufs)} LUFS`);
  return { prefs: next, changes };
}

export async function analyzeReference(file: string, opts: { signal?: AbortSignal; progress?: (f: number, msg: string) => void } = {}): Promise<StyleProfile> {
  opts.progress?.(0.05, 'Lecture des coupes et du mouvement (image par image)');
  // 10 images per second, small: enough to see every cut, fast on any computer
  const { stderr } = await ffmpeg(['-v', 'info', '-i', file, '-an', '-vf', "fps=10,scale=256:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-'], { signal: opts.signal });
  const scores = parseSceneScores(stderr);
  const dur = Number(stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)?.slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i]!, 0) ?? scores.at(-1)?.t ?? 0);
  const { cuts, motion } = cutsFromScores(scores);
  opts.progress?.(0.7, 'Analyse du son (voix, volume)');
  let lufs: number | null = null;
  let speech = 0;
  try {
    const a = await analyzeAudio(file, { signal: opts.signal });
    lufs = a.integratedLufs;
    const silent = a.silences.reduce((acc, s) => acc + (s.end - s.start), 0);
    speech = dur > 0 ? Math.max(0, Math.min(1, 1 - silent / dur)) : 0;
  } catch {
    /* no audio track */
  }
  opts.progress?.(1, 'Analyse terminée');
  return profileFrom(file, dur, cuts, motion, lufs, speech);
}
