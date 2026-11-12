/**
 * Transitions and fades.
 *
 * Transitions are centred on a cut between two adjacent clips of one track. Their duration is
 * clamped to the source handles available on both sides (no frozen frames are invented), and they
 * are pruned automatically when an edit separates the clips (see normalizeSequence).
 */
import { type Clip, type MediaAsset, type Sequence, type Track, type TransitionKind, clipEnd, findClip, newId } from './model';
import { EditError, linkedGroup, mediaLimitSec } from './timeline';
import { secondsToFrames, framesToSeconds } from './time';

type MediaMap = Record<string, MediaAsset>;

export function splitTransition(duration: number): { before: number; after: number } {
  const before = Math.floor(duration / 2);
  return { before, after: duration - before };
}

/** Max transition duration allowed by handles and clip lengths for a pair of adjacent clips. */
export function maxTransitionDuration(seq: Sequence, media: MediaMap, left: Clip, right: Clip): number {
  const rate = seq.settings.frameRate;
  const leftLimit = mediaLimitSec(media, left);
  const leftOut = left.sourceIn + framesToSeconds(left.duration, rate) * left.speed;
  const tail = leftLimit === Infinity ? Infinity : secondsToFrames((leftLimit - leftOut) / left.speed, rate, 'floor');
  const head = media[right.mediaId]?.kind === 'image' ? Infinity : secondsToFrames(right.sourceIn / right.speed, rate, 'floor');
  // before-cut part (floor(d/2)) comes from the right clip's head, after-cut part from the left tail.
  const byHandles = Math.min(2 * head + 1, 2 * tail);
  const byLength = 2 * Math.min(left.duration, right.duration);
  return Math.max(0, Math.min(byHandles, byLength));
}

function adjacentPair(track: Track, leftId: string, rightId: string): [Clip, Clip] | null {
  const i = track.clips.findIndex((c) => c.id === leftId);
  const l = track.clips[i];
  const r = track.clips[i + 1];
  if (!l || !r || r.id !== rightId || clipEnd(l) !== r.start) return null;
  return [l, r];
}

/** Finds the cut (adjacent pair) on a track nearest to `frame` within `tolerance` frames. */
export function cutNear(track: Track, frame: number, tolerance: number): [Clip, Clip] | null {
  let best: [Clip, Clip] | null = null;
  let dist = tolerance + 1;
  for (let i = 0; i + 1 < track.clips.length; i++) {
    const l = track.clips[i]!;
    const r = track.clips[i + 1]!;
    if (clipEnd(l) !== r.start) continue;
    const d = Math.abs(r.start - frame);
    if (d < dist) {
      dist = d;
      best = [l, r];
    }
  }
  return best;
}

/** Adds (or replaces) a transition on the cut between two adjacent clips. Returns its id. */
export function addTransition(seq: Sequence, media: MediaMap, trackId: string, leftId: string, rightId: string, duration: number, kind: TransitionKind = 'cross-dissolve'): string {
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError('Track not found');
  if (track.locked) throw new EditError(`Track ${track.name} is locked`);
  const pair = adjacentPair(track, leftId, rightId);
  if (!pair) throw new EditError('A transition needs two adjacent clips');
  const max = maxTransitionDuration(seq, media, ...pair);
  const d = Math.min(Math.round(duration), max);
  if (d < 2) throw new EditError('Not enough media handles for a transition at this cut (trim the clips to create handles)');
  track.transitions = track.transitions.filter((t) => !(t.leftClipId === leftId && t.rightClipId === rightId));
  const id = newId();
  track.transitions.push({ id, kind, leftClipId: leftId, rightClipId: rightId, duration: d });
  return id;
}

/**
 * Adds a default transition at the cut nearest to `frame` on every unlocked track (Ctrl+D).
 * Linked audio cuts get a matching crossfade. Returns created ids.
 */
export function addTransitionsAt(seq: Sequence, media: MediaMap, frame: number, duration: number, tolerance = 2, trackIds?: string[]): string[] {
  const ids: string[] = [];
  for (const t of seq.tracks) {
    if (t.locked || (trackIds && !trackIds.includes(t.id))) continue;
    const pair = cutNear(t, frame, tolerance);
    if (!pair) continue;
    try {
      ids.push(addTransition(seq, media, t.id, pair[0].id, pair[1].id, duration));
    } catch {
      /* track skipped: no handles */
    }
  }
  if (!ids.length) throw new EditError('No cut with enough media handles near the playhead');
  return ids;
}

function findTransition(seq: Sequence, id: string) {
  for (const track of seq.tracks) {
    const tr = track.transitions.find((t) => t.id === id);
    if (tr) return { track, tr };
  }
  return null;
}

export function removeTransition(seq: Sequence, id: string) {
  const f = findTransition(seq, id);
  if (!f) throw new EditError('Transition not found');
  if (f.track.locked) throw new EditError(`Track ${f.track.name} is locked`);
  f.track.transitions = f.track.transitions.filter((t) => t.id !== id);
}

export function setTransitionDuration(seq: Sequence, media: MediaMap, id: string, duration: number): number {
  const f = findTransition(seq, id);
  if (!f) throw new EditError('Transition not found');
  if (f.track.locked) throw new EditError(`Track ${f.track.name} is locked`);
  const pair = adjacentPair(f.track, f.tr.leftClipId, f.tr.rightClipId);
  if (!pair) throw new EditError('Transition clips are no longer adjacent');
  f.tr.duration = Math.max(2, Math.min(Math.round(duration), maxTransitionDuration(seq, media, ...pair)));
  return f.tr.duration;
}

/** Sets fades (frames) on a clip and its linked partners, clamped to the clip length. */
export function setClipFades(seq: Sequence, clipId: string, fades: { fadeIn?: number; fadeOut?: number }) {
  for (const c of linkedGroup(seq, clipId)) {
    const f = findClip(seq, c.id)!;
    if (f.track.locked) throw new EditError(`Track ${f.track.name} is locked`);
    if (fades.fadeIn !== undefined) c.fadeIn = Math.max(0, Math.min(Math.round(fades.fadeIn), c.duration));
    if (fades.fadeOut !== undefined) c.fadeOut = Math.max(0, Math.min(Math.round(fades.fadeOut), c.duration));
    if (c.fadeIn + c.fadeOut > c.duration) c.fadeOut = c.duration - c.fadeIn;
  }
}

/**
 * Post-edit consistency pass: drops transitions whose clips are gone or no longer adjacent, clamps
 * transition durations to current handles and fades to clip lengths. Idempotent.
 */
export function normalizeSequence(seq: Sequence, media: MediaMap) {
  for (const t of seq.tracks) {
    t.transitions = t.transitions.filter((tr) => {
      const pair = adjacentPair(t, tr.leftClipId, tr.rightClipId);
      if (!pair) return false;
      const max = maxTransitionDuration(seq, media, ...pair);
      if (max < 2) return false;
      if (tr.duration > max) tr.duration = max;
      return true;
    });
    for (const c of t.clips) {
      if (c.fadeIn > c.duration) c.fadeIn = c.duration;
      if (c.fadeIn + c.fadeOut > c.duration) c.fadeOut = Math.max(0, c.duration - c.fadeIn);
    }
  }
}
