/**
 * Music per section: picks tracks from the local music library for each part of the narration,
 * switches only at section boundaries snapped to a pause in the voice, keeps the user's locks and
 * never proposes a rejected track again. Pure: the engine supplies the indexed tracks and pauses.
 */
import type { Energy, Mood } from './music';
import type { SectionNarrative } from './narrative';

export interface MusicCandidate {
  trackId: string;
  title: string;
  path: string;
  durationSec: number;
  energy: Energy;
  moods: Mood[];
  bpm: number | null;
  vocalsLikely: boolean;
  /** Declared licence family, or null when unknown. */
  licence: string | null;
  licenceStatus: 'déclarée' | 'inconnue';
  /** Times used in previous productions (fresher tracks are preferred a little). */
  uses: number;
  loopScore: number;
}

export interface MusicSectionSpan {
  section: number;
  start: number;
  end: number;
  narrative?: SectionNarrative;
}

export interface MusicSegment {
  trackId: string | null;
  title: string;
  sections: number[];
  start: number;
  end: number;
  reasons: string[];
  confidence: number;
  candidates: { trackId: string; title: string; score: number; reasons: string[] }[];
  /** Section titles covered (display). */
  key: string;
  /** Title of the first section: identity of the music decision (locks and rejections use it). */
  anchor: string;
  locked?: boolean;
}

export interface MusicPlanOptions {
  /** Track forced per anchor (first section title; user lock), and tracks rejected per anchor. */
  locks?: Map<string, string>;
  rejected?: Map<string, Set<string>>;
  /** Pauses in the narration (seconds) where a change of track may happen. */
  pauses?: { start: number; end: number }[];
  /** Max distance (s) to move a boundary onto a pause. */
  snap?: number;
  /** Do not change the music for spans shorter than this (s). */
  minSpan?: number;
  /** Licences that may not be used in a published video (e.g. non-commercial) are excluded unless allowed. */
  allowRestricted?: boolean;
}

const ENERGY_OF = (intensity: number): Energy => (intensity >= 0.6 ? 'haute' : intensity <= 0.32 ? 'basse' : 'moyenne');
const RESTRICTED = /NC|ND/;

export function scoreTrack(t: MusicCandidate, want: { energy: Energy; moods: Mood[] }): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (t.energy === want.energy) ((score += 3), reasons.push(`énergie ${t.energy} attendue`));
  else if (t.energy === 'moyenne' || want.energy === 'moyenne') ((score += 1), reasons.push(`énergie ${t.energy} proche de ${want.energy}`));
  else ((score -= 2), reasons.push(`énergie ${t.energy} opposée à ${want.energy}`));
  const shared = t.moods.filter((m) => want.moods.includes(m));
  if (shared.length) {
    score += 2 * shared.length + (want.moods[0] && t.moods.includes(want.moods[0]) ? 1 : 0);
    reasons.push(`ambiance ${shared.join(', ')}`);
  }
  if (t.vocalsLikely) ((score -= 3), reasons.push('voix chantée probable : gêne la narration'));
  if (t.licenceStatus === 'inconnue') ((score -= 0.5), reasons.push('licence non déclarée'));
  score -= Math.min(1.5, 0.3 * t.uses);
  return { score, reasons };
}

/** Moves a time onto the middle of the nearest pause within `snap` seconds. */
export function snapToPause(t: number, pauses: { start: number; end: number }[], snap: number): { t: number; snapped: boolean } {
  let best: number | null = null;
  for (const p of pauses) {
    if (p.end - p.start < 0.25) continue;
    const mid = (p.start + p.end) / 2;
    if (Math.abs(mid - t) <= snap && (best === null || Math.abs(mid - t) < Math.abs(best - t))) best = mid;
  }
  return best === null ? { t, snapped: false } : { t: best, snapped: true };
}

export function planMusic(spans: MusicSectionSpan[], tracks: MusicCandidate[], opts: MusicPlanOptions = {}): MusicSegment[] {
  const snap = opts.snap ?? 2;
  const minSpan = opts.minSpan ?? 20;
  const usable = tracks.filter((t) => opts.allowRestricted || !(t.licence && RESTRICTED.test(t.licence)));
  if (!spans.length || !usable.length) return [];
  // 1) merge short sections with their neighbour of the closest intensity (a change every 10 s is noise)
  const groups: MusicSectionSpan[][] = [];
  for (const s of spans) {
    const last = groups.at(-1);
    const lastEnd = last?.at(-1)?.end ?? 0;
    const lastStart = last?.[0]?.start ?? 0;
    const similar = last && Math.abs(ENERGY_LEVEL(last) - (s.narrative?.intensity ?? 0.4)) < 0.2;
    if (last && (lastEnd - lastStart < minSpan || s.end - s.start < minSpan * 0.5 || similar)) last.push(s);
    else groups.push([s]);
  }
  const used = new Map<string, number>();
  const out: MusicSegment[] = [];
  for (const g of groups) {
    const key = g.map((s) => s.narrative?.title ?? `section ${s.section}`).join(' + ');
    const anchor = g[0]!.narrative?.title ?? `section ${g[0]!.section}`;
    const intensity = ENERGY_LEVEL(g);
    const moods = [...new Set(g.flatMap((s) => s.narrative?.moods ?? []))];
    const want = { energy: ENERGY_OF(intensity), moods };
    const rejected = opts.rejected?.get(anchor) ?? new Set<string>();
    const ranked = usable
      .filter((t) => !rejected.has(t.trackId))
      .map((t) => {
        const r = scoreTrack({ ...t, uses: t.uses + (used.get(t.trackId) ?? 0) * 3 }, want);
        // the previous segment's track again is only fine when nothing else fits
        if (out.at(-1)?.trackId === t.trackId) ((r.score -= 2), r.reasons.push('déjà sur la section précédente'));
        return { t, ...r };
      })
      .sort((a, b) => b.score - a.score);
    const lock = opts.locks?.get(anchor);
    const locked = lock ? usable.find((t) => t.trackId === lock) : undefined;
    const pick = locked ? { t: locked, score: 99, reasons: ['choix verrouillé par vous'] } : ranked[0];
    const start = g[0]!.start;
    const end = g.at(-1)!.end;
    if (!pick) {
      out.push({ trackId: null, title: 'aucune piste', sections: g.map((s) => s.section), start, end, reasons: ['toutes les pistes ont été rejetées pour cette partie'], confidence: 0, candidates: [], key, anchor });
      continue;
    }
    used.set(pick.t.trackId, (used.get(pick.t.trackId) ?? 0) + 1);
    const reasons = [`partie ${want.energy === 'haute' ? 'intense' : want.energy === 'basse' ? 'calme' : 'modérée'}${moods.length ? ` (${moods.slice(0, 3).join(', ')})` : ''}`, ...pick.reasons];
    out.push({
      trackId: pick.t.trackId,
      title: pick.t.title,
      sections: g.map((s) => s.section),
      start,
      end,
      reasons,
      confidence: locked ? 1 : +Math.max(0.1, Math.min(0.8, 0.3 + pick.score / 12)).toFixed(2),
      candidates: ranked.slice(0, 5).map((r) => ({ trackId: r.t.trackId, title: r.t.title, score: +r.score.toFixed(1), reasons: r.reasons })),
      key,
      anchor,
      locked: !!locked,
    });
  }
  // 2) consecutive segments with the same track become one; 3) boundaries move onto a pause
  const merged: MusicSegment[] = [];
  for (const s of out) {
    const last = merged.at(-1);
    if (last && last.trackId === s.trackId) {
      last.end = s.end;
      last.sections.push(...s.sections);
      last.key = `${last.key} + ${s.key}`;
    } else merged.push(s);
  }
  for (let i = 1; i < merged.length; i++) {
    const b = snapToPause(merged[i]!.start, opts.pauses ?? [], snap);
    if (b.t > merged[i - 1]!.start + 1 && b.t < merged[i]!.end - 1) {
      merged[i - 1]!.end = b.t;
      merged[i]!.start = b.t;
    }
    merged[i]!.reasons.push(b.snapped ? 'changement placé sur une pause de la voix' : 'aucune pause proche : changement à la frontière de section');
  }
  return merged;
}

function ENERGY_LEVEL(g: MusicSectionSpan[]): number {
  const total = g.reduce((a, s) => a + (s.end - s.start), 0) || 1;
  return g.reduce((a, s) => a + (s.narrative?.intensity ?? 0.4) * (s.end - s.start), 0) / total;
}
