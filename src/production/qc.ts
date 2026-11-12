/**
 * Automatic quality control of a (generated or edited) sequence, with safe automatic fixes.
 * The score is a transparent sum of penalties so versions can be compared.
 */
import { type MediaAsset, type ProductionMeta, type Sequence, clipEnd, framesToSeconds, sequenceDuration } from '../core';
import type { EditStyle, ProductionPreferences } from './preferences';

export type QcIssue = ProductionMeta['qcIssues'][number];

export interface QcResult {
  score: number;
  issues: QcIssue[];
}

const PENALTY = { error: 15, warning: 4, info: 0 } as const;

export function runQc(seq: Sequence, media: Record<string, MediaAsset>, prefs: ProductionPreferences, ctx: { alignmentConfidence?: number; narrationEnd?: number } = {}): QcResult {
  const issues: QcIssue[] = [];
  const r = seq.settings.frameRate;
  const sec = (f: number) => framesToSeconds(f, r);
  const v1 = seq.tracks.find((t) => t.kind === 'video')!;
  const end = ctx.narrationEnd ?? sequenceDuration(seq);
  // coverage
  let t = 0;
  for (const c of v1.clips) {
    if (c.start > t) issues.push({ severity: 'error', code: 'gap', message: `Black gap ${sec(t).toFixed(2)}–${sec(c.start).toFixed(2)} s`, frame: t });
    t = Math.max(t, clipEnd(c));
  }
  if (t < end) issues.push({ severity: 'error', code: 'gap', message: `No picture after ${sec(t).toFixed(2)} s`, frame: t });
  // shot lengths & repetition
  v1.clips.forEach((c, i) => {
    const d = sec(c.duration);
    if (d < prefs.shotMin * 0.5) issues.push({ severity: 'warning', code: 'shot-short', message: `Shot ${i + 1} is very short (${d.toFixed(2)} s)`, frame: c.start });
    if (d > prefs.shotMax * 1.6) issues.push({ severity: 'warning', code: 'shot-long', message: `Shot ${i + 1} is long (${d.toFixed(1)} s)`, frame: c.start });
    const prev = v1.clips[i - 1];
    if (prev && prev.mediaId === c.mediaId && clipEnd(prev) === c.start) issues.push({ severity: 'warning', code: 'repeat', message: `Same image twice in a row at shot ${i + 1}`, frame: c.start });
  });
  // rights
  const used = new Set(seq.tracks.flatMap((tr) => tr.clips.map((c) => c.mediaId)));
  for (const id of used) {
    const m = media[id];
    if (!m) continue;
    const u = m.rights?.usage;
    if (u && ['permission-required', 'view-only', 'unknown'].includes(u)) issues.push({ severity: 'error', code: 'rights', message: `${m.name}: usage rights not cleared (${u}) — must not be published` });
    if (u === 'reusable' && !m.rights?.attribution) issues.push({ severity: 'warning', code: 'attribution', message: `${m.name}: reusable but attribution missing` });
  }
  // placeholders and weak matches
  const placeholders = seq.captions.filter((c) => c.style === 'placeholder').length;
  if (placeholders) issues.push({ severity: 'error', code: 'missing-visual', message: `${placeholders} shot(s) have no visual — add media or regenerate` });
  const weak = seq.production?.shots.filter((s) => s.quality === 'weak').length ?? 0;
  if (weak) issues.push({ severity: 'info', code: 'weak-match', message: `${weak} shot(s) use a generic image (no specific match)` });
  // captions
  for (const c of seq.captions) {
    const lines = c.text.split('\n');
    if (c.style === 'subtitle' && (lines.length > 2 || lines.some((l) => l.length > 48))) issues.push({ severity: 'warning', code: 'caption-overflow', message: `Subtitle too long at ${sec(c.start).toFixed(1)} s`, frame: c.start });
    if (c.style === 'subtitle' && c.end - c.start < Math.round(0.7 * (r.num / r.den))) issues.push({ severity: 'info', code: 'caption-fast', message: `Subtitle shown < 0.7 s at ${sec(c.start).toFixed(1)} s`, frame: c.start });
  }
  if (ctx.alignmentConfidence !== undefined && ctx.alignmentConfidence < 0.5)
    issues.push({ severity: 'warning', code: 'alignment', message: `Text/voice sync is approximate (confidence ${(ctx.alignmentConfidence * 100).toFixed(0)}%) — enable word-level transcription for precise timing` });
  const score = Math.max(0, 100 - issues.reduce((a, i) => a + PENALTY[i.severity], 0));
  return { score, issues };
}

/** Safe automatic fixes: close picture gaps by extending the previous still, merge same-image repeats. */
export function autoFix(seq: Sequence, media: Record<string, MediaAsset>, endFrame: number): string[] {
  const fixes: string[] = [];
  const v1 = seq.tracks.find((t) => t.kind === 'video')!;
  for (let i = 0; i < v1.clips.length; i++) {
    const c = v1.clips[i]!;
    const next = v1.clips[i + 1];
    const until = next ? next.start : endFrame;
    const isStill = media[c.mediaId]?.kind === 'image';
    if (clipEnd(c) < until && isStill) {
      fixes.push(`extended shot ${i + 1} to close a ${until - clipEnd(c)}-frame gap`);
      c.duration = until - c.start;
    }
    if (next && next.mediaId === c.mediaId && clipEnd(c) === next.start && isStill) {
      c.duration += next.duration;
      v1.transitions = v1.transitions.filter((t) => t.leftClipId !== c.id && t.rightClipId !== next.id);
      for (const t of v1.transitions) if (t.leftClipId === next.id) t.leftClipId = c.id;
      v1.clips.splice(i + 1, 1);
      fixes.push(`merged repeated image at shot ${i + 2}`);
      i--;
    }
  }
  if (v1.clips[0] && v1.clips[0].start > 0 && media[v1.clips[0].mediaId]?.kind === 'image') {
    v1.clips[0].duration += v1.clips[0].start;
    v1.clips[0].start = 0;
    fixes.push('extended first shot to the start');
  }
  return fixes;
}

/** Measures the observable style of a sequence (used for preference learning). */
export function measureStyle(seq: Sequence): EditStyle {
  const r = seq.settings.frameRate;
  const v1 = seq.tracks.find((t) => t.kind === 'video')!;
  const vids = seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips);
  const motionCounts: EditStyle['motionCounts'] = {};
  for (const c of vids) motionCounts[c.motion?.kind ?? 'none'] = (motionCounts[c.motion?.kind ?? 'none'] ?? 0) + 1;
  let cuts = 0;
  for (let i = 0; i + 1 < v1.clips.length; i++) if (clipEnd(v1.clips[i]!) === v1.clips[i + 1]!.start) cuts++;
  const narr = seq.production ? seq.tracks.find((t) => t.kind === 'audio')?.clips[0] : undefined;
  const music = seq.tracks.filter((t) => t.kind === 'audio')[1]?.clips[0];
  return {
    shots: vids.length,
    meanShotSec: vids.length ? framesToSeconds(vids.reduce((a, c) => a + c.duration, 0), r) / vids.length : 0,
    motionCounts,
    dissolves: v1.transitions.length,
    cuts,
    musicRelativeDb: music && narr ? music.gainDb - narr.gainDb : null,
    sfxClips: seq.production ? seq.tracks.filter((t) => t.kind === 'audio').slice(2).reduce((n, t) => n + t.clips.length, 0) : null,
    duckDepthDb: music ? (seq.tracks.filter((t) => t.kind === 'audio')[1]?.duck?.depthDb ?? 0) : null,
    subtitles: seq.captions.some((c) => c.style === 'subtitle'),
  };
}
