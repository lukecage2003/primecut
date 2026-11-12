/**
 * Timeline editing operations.
 *
 * Every operation mutates a Sequence *draft* in place and is meant to be run inside
 * immer's `produce` (see history.ts) so callers get structural sharing and pure
 * semantics. Operations validate their inputs and throw EditError on illegal edits;
 * drag-style edits (trim/roll/slip/slide) clamp the requested delta to the legal range
 * and return the delta actually applied.
 */
import {
  type Clip,
  type MediaAsset,
  type Sequence,
  type Track,
  DEFAULT_STILL_SECONDS,
  DEFAULT_TRANSFORM,
  clipEnd,
  findClip,
  newId,
} from './model';
import { framesToSeconds, secondsToFrames } from './time';

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

export type MediaMap = Record<string, MediaAsset>;

/** Per-operation scratch state: keeps linked halves of a split paired with a shared new linkId. */
interface OpContext {
  linkRemap: Map<string, string>;
}
const ctx = (): OpContext => ({ linkRemap: new Map() });

function remapLink(c: OpContext, linkId: string | undefined, key: number): string | undefined {
  if (!linkId) return undefined;
  const k = `${linkId}@${key}`;
  let v = c.linkRemap.get(k);
  if (!v) {
    v = newId();
    c.linkRemap.set(k, v);
  }
  return v;
}

function sortTrack(track: Track) {
  track.clips.sort((a, b) => a.start - b.start);
}

function secs(seq: Sequence, frames: number): number {
  return framesToSeconds(frames, seq.settings.frameRate);
}

/** Maximum source position (seconds) available for a clip's media. Infinity for stills. */
export function mediaLimitSec(media: MediaMap, clip: Clip): number {
  const m = media[clip.mediaId];
  if (!m) return Infinity;
  if (m.kind === 'image') return Infinity;
  return m.probe.durationSec;
}

function trackOf(seq: Sequence, clipId: string): Track {
  const f = findClip(seq, clipId);
  if (!f) throw new EditError(`Clip ${clipId} not found`);
  return f.track;
}

/** The clip plus every clip sharing its linkId. */
export function linkedGroup(seq: Sequence, clipId: string): Clip[] {
  const f = findClip(seq, clipId);
  if (!f) throw new EditError(`Clip ${clipId} not found`);
  const { clip } = f;
  if (!clip.linkId) return [clip];
  const out: Clip[] = [];
  for (const t of seq.tracks) for (const c of t.clips) if (c.linkId === clip.linkId) out.push(c);
  return out;
}

function expandLinked(seq: Sequence, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) for (const c of linkedGroup(seq, id)) out.add(c.id);
  return out;
}

function assertUnlocked(track: Track) {
  if (track.locked) throw new EditError(`Track ${track.name} is locked`);
}

/**
 * Removes material in [start, end) on a track (overwrite semantics): clips fully inside are
 * removed, clips crossing the boundaries are trimmed, a clip spanning the whole range is split.
 */
export function clearRange(seq: Sequence, track: Track, start: number, end: number, c: OpContext = ctx(), except?: Set<string>) {
  if (end <= start) return;
  const result: Clip[] = [];
  for (const clip of track.clips) {
    if (except?.has(clip.id)) {
      result.push(clip);
      continue;
    }
    const cs = clip.start;
    const ce = clipEnd(clip);
    if (ce <= start || cs >= end) {
      result.push(clip);
    } else if (cs >= start && ce <= end) {
      // fully covered: dropped
    } else if (cs < start && ce > end) {
      const right: Clip = {
        ...clip,
        transform: { ...clip.transform },
        id: newId(),
        start: end,
        duration: ce - end,
        sourceIn: clip.sourceIn + secs(seq, end - cs) * clip.speed,
        linkId: remapLink(c, clip.linkId, end),
        fadeIn: 0,
      };
      clip.duration = start - cs;
      clip.fadeOut = 0;
      result.push(clip, right);
    } else if (cs < start) {
      clip.duration = start - cs;
      result.push(clip);
    } else {
      clip.sourceIn += secs(seq, end - cs) * clip.speed;
      clip.duration = ce - end;
      clip.start = end;
      result.push(clip);
    }
  }
  track.clips = result;
  sortTrack(track);
}

export interface PlaceOptions {
  /** Index among video tracks (0 = V1). */
  videoTrack: number;
  /** Index among audio tracks (0 = A1). */
  audioTrack: number;
  start: number;
  mode: 'overwrite' | 'insert';
}

/**
 * Places a media asset on the timeline. Video files with audio produce a linked video+audio pair.
 * Returns the ids of the created clips.
 */
export function placeMedia(seq: Sequence, asset: MediaAsset, opts: PlaceOptions): string[] {
  if (opts.start < 0) throw new EditError('Cannot place a clip before the start of the sequence');
  const rate = seq.settings.frameRate;
  const durSec = asset.kind === 'image' ? DEFAULT_STILL_SECONDS : asset.probe.durationSec;
  const duration = secondsToFrames(durSec, rate, 'floor');
  if (duration < 1) throw new EditError(`${asset.name} is shorter than one frame`);

  const wantsVideo = asset.kind === 'image' || !!asset.probe.video;
  const wantsAudio = asset.kind !== 'image' && !!asset.probe.audio;
  const vts = seq.tracks.filter((t) => t.kind === 'video');
  const ats = seq.tracks.filter((t) => t.kind === 'audio');
  const vt = wantsVideo ? vts[opts.videoTrack] : undefined;
  const at = wantsAudio ? ats[opts.audioTrack] : undefined;
  if (wantsVideo && !vt) throw new EditError('Target video track does not exist');
  if (wantsAudio && !at) throw new EditError('Target audio track does not exist');
  if (vt) assertUnlocked(vt);
  if (at) assertUnlocked(at);

  const c = ctx();
  if (opts.mode === 'insert') {
    rippleInsertGap(seq, opts.start, duration, c);
  } else {
    if (vt) clearRange(seq, vt, opts.start, opts.start + duration, c);
    if (at) clearRange(seq, at, opts.start, opts.start + duration, c);
  }

  const linkId = vt && at ? newId() : undefined;
  const base = {
    mediaId: asset.id,
    name: asset.name,
    start: opts.start,
    duration,
    sourceIn: 0,
    speed: 1,
    enabled: true,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    motion: { kind: 'none' as const, amount: 0 },
    linkId,
  };
  const ids: string[] = [];
  if (vt) {
    const clip: Clip = { ...base, id: newId(), transform: { ...DEFAULT_TRANSFORM }, motion: { kind: 'none', amount: 0 } };
    vt.clips.push(clip);
    sortTrack(vt);
    ids.push(clip.id);
  }
  if (at) {
    const clip: Clip = { ...base, id: newId(), transform: { ...DEFAULT_TRANSFORM }, motion: { kind: 'none', amount: 0 } };
    at.clips.push(clip);
    sortTrack(at);
    ids.push(clip.id);
  }
  return ids;
}

/** Opens a gap of `length` frames at `at` on every unlocked track (splitting clips that cross `at`). */
export function rippleInsertGap(seq: Sequence, at: number, length: number, c: OpContext = ctx()) {
  for (const t of seq.tracks) {
    if (t.locked) continue;
    for (const clip of [...t.clips]) {
      if (clip.start < at && clipEnd(clip) > at) splitSingle(seq, t, clip, at, c);
    }
    for (const clip of t.clips) if (clip.start >= at) clip.start += length;
  }
}

function splitSingle(seq: Sequence, track: Track, clip: Clip, frame: number, c: OpContext): Clip | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null;
  const offset = frame - clip.start;
  const right: Clip = {
    ...clip,
    transform: { ...clip.transform },
    id: newId(),
    start: frame,
    duration: clip.duration - offset,
    sourceIn: clip.sourceIn + secs(seq, offset) * clip.speed,
    linkId: remapLink(c, clip.linkId, frame),
    fadeIn: 0,
  };
  clip.duration = offset;
  clip.fadeOut = 0;
  // a transition on the clip's right cut now belongs to the new right half
  for (const tr of track.transitions) if (tr.leftClipId === clip.id) tr.leftClipId = right.id;
  track.clips.push(right);
  sortTrack(track);
  return right;
}

/**
 * Razor: splits the given clips (and their linked partners) at `frame`. When no clip ids are
 * given, every clip under `frame` on unlocked tracks is split. Returns new right-hand clip ids.
 */
export function splitAt(seq: Sequence, frame: number, clipIds?: string[]): string[] {
  const c = ctx();
  const targets = clipIds ? expandLinked(seq, clipIds) : null;
  const created: string[] = [];
  for (const t of seq.tracks) {
    if (t.locked) continue;
    for (const clip of [...t.clips]) {
      if (targets && !targets.has(clip.id)) continue;
      const r = splitSingle(seq, t, clip, frame, c);
      if (r) created.push(r.id);
    }
  }
  return created;
}

export interface TrackDelta {
  video: number;
  audio: number;
}

/**
 * Moves clips (and linked partners) by `delta` frames and by `trackDelta` tracks of the same kind.
 * Overwrites whatever material sits at the destination.
 */
export function moveClips(seq: Sequence, clipIds: string[], delta: number, trackDelta: TrackDelta = { video: 0, audio: 0 }) {
  const ids = expandLinked(seq, clipIds);
  if (ids.size === 0) return;
  const byKind = { video: seq.tracks.filter((t) => t.kind === 'video'), audio: seq.tracks.filter((t) => t.kind === 'audio') };
  const moves: { clip: Clip; from: Track; to: Track }[] = [];
  for (const id of ids) {
    const from = trackOf(seq, id);
    const clip = from.clips.find((c) => c.id === id)!;
    const list = byKind[from.kind];
    const to = list[list.indexOf(from) + trackDelta[from.kind]];
    if (!to) throw new EditError('Destination track does not exist');
    assertUnlocked(from);
    assertUnlocked(to);
    if (clip.start + delta < 0) throw new EditError('Cannot move a clip before the start of the sequence');
    moves.push({ clip, from, to });
  }
  for (const m of moves) m.from.clips = m.from.clips.filter((c) => c.id !== m.clip.id);
  const c = ctx();
  for (const m of moves) {
    m.clip.start += delta;
    clearRange(seq, m.to, m.clip.start, clipEnd(m.clip), c);
  }
  for (const m of moves) {
    m.to.clips.push(m.clip);
    sortTrack(m.to);
  }
}

/** Removes clips (and linked partners). With ripple, later clips on affected tracks close the gap. */
export function deleteClips(seq: Sequence, clipIds: string[], ripple = false) {
  const ids = expandLinked(seq, clipIds);
  for (const t of seq.tracks) {
    const removed = t.clips.filter((c) => ids.has(c.id));
    if (removed.length === 0) continue;
    assertUnlocked(t);
    t.clips = t.clips.filter((c) => !ids.has(c.id));
    if (ripple) {
      // Process removed ranges right-to-left so shifts don't disturb pending ones.
      for (const r of removed.sort((a, b) => b.start - a.start)) {
        for (const c of t.clips) if (c.start >= clipEnd(r)) c.start -= r.duration;
      }
    }
  }
}

function neighbours(track: Track, clip: Clip): { prev?: Clip; next?: Clip } {
  const i = track.clips.indexOf(clip);
  return { prev: track.clips[i - 1], next: track.clips[i + 1] };
}

/** Intersects allowed delta ranges; returns the requested delta clamped to the result. */
function clampDelta(delta: number, ranges: [number, number][]): number {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [a, b] of ranges) {
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  }
  if (lo > hi) return 0;
  return Math.min(hi, Math.max(lo, delta));
}

/** Frames available in the source before sourceIn / after the clip's current out point. */
function headroom(seq: Sequence, media: MediaMap, clip: Clip): { before: number; after: number } {
  const rate = seq.settings.frameRate;
  const limit = mediaLimitSec(media, clip);
  const before = secondsToFrames(clip.sourceIn / clip.speed, rate, 'floor');
  const outSec = clip.sourceIn + secs(seq, clip.duration) * clip.speed;
  const after = limit === Infinity ? Infinity : secondsToFrames((limit - outSec) / clip.speed, rate, 'floor');
  return { before, after: Math.max(0, after) };
}

/**
 * Trims the in or out edge of a clip (and its linked partners) by `delta` frames.
 * Positive delta moves the edge to the right. Ripple keeps the clip anchored at its start and
 * shifts later clips on the affected tracks. Returns the delta actually applied.
 */
export function trimClip(seq: Sequence, media: MediaMap, clipId: string, edge: 'in' | 'out', delta: number, ripple = false): number {
  const group = linkedGroup(seq, clipId);
  const ranges: [number, number][] = [];
  for (const clip of group) {
    const track = trackOf(seq, clip.id);
    assertUnlocked(track);
    const { prev, next } = neighbours(track, clip);
    const hr = headroom(seq, media, clip);
    if (edge === 'in') {
      // delta > 0 shortens; must keep >=1 frame. delta < 0 extends into source head.
      ranges.push([-hr.before, clip.duration - 1]);
      if (!ripple) ranges.push([(prev ? clipEnd(prev) : 0) - clip.start, Infinity]);
    } else {
      ranges.push([1 - clip.duration, hr.after]);
      if (!ripple && next) ranges.push([-Infinity, next.start - clipEnd(clip)]);
    }
  }
  const d = clampDelta(delta, ranges);
  if (d === 0) return 0;
  for (const clip of group) {
    const track = trackOf(seq, clip.id);
    const oldEnd = clipEnd(clip);
    if (edge === 'in') {
      clip.sourceIn += secs(seq, d) * clip.speed;
      clip.duration -= d;
      if (ripple) {
        for (const c of track.clips) if (c !== clip && c.start >= oldEnd) c.start -= d;
      } else {
        clip.start += d;
      }
    } else {
      clip.duration += d;
      if (ripple) for (const c of track.clips) if (c !== clip && c.start >= oldEnd) c.start += d;
    }
    sortTrack(track);
  }
  return d;
}

/** Roll edit: moves the cut between two adjacent clips, keeping total duration. */
export function rollEdit(seq: Sequence, media: MediaMap, leftId: string, rightId: string, delta: number): number {
  const lf = findClip(seq, leftId);
  const rf = findClip(seq, rightId);
  if (!lf || !rf) throw new EditError('Clip not found');
  if (lf.track !== rf.track || clipEnd(lf.clip) !== rf.clip.start) throw new EditError('Roll requires two adjacent clips on the same track');
  assertUnlocked(lf.track);
  const l = headroom(seq, media, lf.clip);
  const r = headroom(seq, media, rf.clip);
  const d = clampDelta(delta, [
    [1 - lf.clip.duration, l.after],
    [-r.before, rf.clip.duration - 1],
  ]);
  if (d === 0) return 0;
  lf.clip.duration += d;
  rf.clip.start += d;
  rf.clip.duration -= d;
  rf.clip.sourceIn += secs(seq, d) * rf.clip.speed;
  return d;
}

/** Slip: changes which part of the source is shown without moving the clip. */
export function slipClip(seq: Sequence, media: MediaMap, clipId: string, delta: number): number {
  const group = linkedGroup(seq, clipId);
  const ranges: [number, number][] = [];
  for (const clip of group) {
    assertUnlocked(trackOf(seq, clip.id));
    const hr = headroom(seq, media, clip);
    ranges.push([-hr.before, hr.after]);
  }
  const d = clampDelta(delta, ranges);
  for (const clip of group) clip.sourceIn += secs(seq, d) * clip.speed;
  return d;
}

/**
 * Slide: moves a clip between its neighbours; the previous clip's out point and the next
 * clip's in point absorb the change so total duration is unchanged.
 */
export function slideClip(seq: Sequence, media: MediaMap, clipId: string, delta: number): number {
  const group = linkedGroup(seq, clipId);
  const ranges: [number, number][] = [];
  const plan: { clip: Clip; track: Track; prev?: Clip; next?: Clip }[] = [];
  for (const clip of group) {
    const track = trackOf(seq, clip.id);
    assertUnlocked(track);
    const { prev, next } = neighbours(track, clip);
    const adjPrev = prev && clipEnd(prev) === clip.start ? prev : undefined;
    const adjNext = next && next.start === clipEnd(clip) ? next : undefined;
    if (adjPrev) {
      const hr = headroom(seq, media, adjPrev);
      ranges.push([1 - adjPrev.duration, hr.after]);
    } else {
      ranges.push([(prev ? clipEnd(prev) : 0) - clip.start, Infinity]);
    }
    if (adjNext) {
      const hr = headroom(seq, media, adjNext);
      ranges.push([-hr.before, adjNext.duration - 1]);
    } else if (next) {
      ranges.push([-Infinity, next.start - clipEnd(clip)]);
    }
    plan.push({ clip, track, prev: adjPrev, next: adjNext });
  }
  const d = clampDelta(delta, ranges);
  if (d === 0) return 0;
  for (const p of plan) {
    p.clip.start += d;
    if (p.prev) p.prev.duration += d;
    if (p.next) {
      p.next.start += d;
      p.next.duration -= d;
      p.next.sourceIn += secs(seq, d) * p.next.speed;
    }
    sortTrack(p.track);
  }
  return d;
}

export function setClipProps(seq: Sequence, clipId: string, props: Partial<Pick<Clip, 'enabled' | 'gainDb' | 'name' | 'transform' | 'fadeIn' | 'fadeOut' | 'motion' | 'fill'>>) {
  const f = findClip(seq, clipId);
  if (!f) throw new EditError('Clip not found');
  assertUnlocked(f.track);
  Object.assign(f.clip, props);
}

export function unlinkClips(seq: Sequence, clipIds: string[]) {
  for (const id of expandLinked(seq, clipIds)) {
    const f = findClip(seq, id);
    if (f) delete f.clip.linkId;
  }
}

export function setTrackProps(seq: Sequence, trackId: string, props: Partial<Pick<Track, 'locked' | 'disabled' | 'name'>>) {
  const t = seq.tracks.find((x) => x.id === trackId);
  if (!t) throw new EditError('Track not found');
  Object.assign(t, props);
}

export function addTrack(seq: Sequence, kind: 'video' | 'audio') {
  const count = seq.tracks.filter((t) => t.kind === kind).length;
  const t: Track = { id: newId(), kind, name: `${kind === 'video' ? 'V' : 'A'}${count + 1}`, locked: false, disabled: false, clips: [], transitions: [] };
  // keep video tracks before audio tracks
  if (kind === 'video') {
    const lastVideo = seq.tracks.map((x) => x.kind).lastIndexOf('video');
    seq.tracks.splice(lastVideo + 1, 0, t);
  } else {
    seq.tracks.push(t);
  }
  return t.id;
}

export function addMarker(seq: Sequence, frame: number, name = 'Marker', color = '#ffc400'): string {
  const id = newId();
  seq.markers.push({ id, frame: Math.max(0, Math.round(frame)), name, color });
  seq.markers.sort((a, b) => a.frame - b.frame);
  return id;
}

export function removeMarker(seq: Sequence, markerId: string) {
  seq.markers = seq.markers.filter((m) => m.id !== markerId);
}

/** Snap candidates: clip edges, markers and the playhead. */
export function snapPoints(seq: Sequence, exclude: Set<string>, playhead?: number): number[] {
  const pts = new Set<number>([0]);
  for (const t of seq.tracks) for (const c of t.clips) if (!exclude.has(c.id)) pts.add(c.start).add(clipEnd(c));
  for (const m of seq.markers) pts.add(m.frame);
  if (playhead !== undefined) pts.add(playhead);
  return [...pts].sort((a, b) => a - b);
}

/** Clips visible/audible at a frame, per track. */
export function clipsAt(seq: Sequence, frame: number): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of seq.tracks) {
    for (const clip of track.clips) if (clip.start <= frame && frame < clipEnd(clip)) out.push({ track, clip });
  }
  return out;
}
