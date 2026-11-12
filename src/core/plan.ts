/**
 * Render plan: the single description of "what is visible/audible when", shared by the preview
 * engine and the exporter so both always agree. Transitions extend clips into their handles and
 * turn into alpha / volume ramps.
 */
import { type Clip, type MediaAsset, type Sequence, type Track, clipEnd } from './model';
import { framesToSeconds } from './time';
import { splitTransition } from './transitions';

export interface PlanItem {
  clip: Clip;
  track: Track;
  media: MediaAsset;
  kind: 'video' | 'audio';
  /** Effective timeline start/end (frames), including transition extensions. */
  start: number;
  end: number;
  /** Source time (s) at `start`. */
  sourceIn: number;
  /** Ramp lengths in frames: opacity/volume rises over the first `rampIn` frames and falls over the last `rampOut`. */
  rampIn: number;
  rampOut: number;
  /** Order for compositing (video): higher draws on top. */
  layer: number;
}

export function planSequence(seq: Sequence, media: Record<string, MediaAsset>): PlanItem[] {
  const rate = seq.settings.frameRate;
  const items: PlanItem[] = [];
  let layer = 0;
  for (const track of seq.tracks) {
    if (track.disabled) continue;
    const ext = new Map<string, { head: number; tail: number; rampIn?: number; rampOut?: number }>();
    for (const tr of track.transitions) {
      const { before, after } = splitTransition(tr.duration);
      const l = ext.get(tr.leftClipId) ?? { head: 0, tail: 0 };
      l.tail = after;
      // audio: crossfade (left fades out); video: left stays opaque underneath the incoming clip
      if (track.kind === 'audio') l.rampOut = tr.duration;
      ext.set(tr.leftClipId, l);
      const r = ext.get(tr.rightClipId) ?? { head: 0, tail: 0 };
      r.head = before;
      r.rampIn = tr.duration;
      ext.set(tr.rightClipId, r);
    }
    for (const clip of track.clips) {
      const m = media[clip.mediaId];
      if (!m || !clip.enabled) continue;
      if (track.kind === 'video' && !m.probe.video) continue;
      if (track.kind === 'audio' && !m.probe.audio) continue;
      const e = ext.get(clip.id);
      const head = e?.head ?? 0;
      const tail = e?.tail ?? 0;
      const start = clip.start - head;
      const end = clipEnd(clip) + tail;
      items.push({
        clip,
        track,
        media: m,
        kind: track.kind,
        start,
        end,
        sourceIn: clip.sourceIn - framesToSeconds(head, rate) * clip.speed,
        rampIn: e?.rampIn ?? clip.fadeIn,
        rampOut: e?.rampOut ?? (tail ? 0 : clip.fadeOut),
        layer: layer++,
      });
    }
  }
  return items;
}

/** Ramp factor (0..1) of an item at a frame. */
export function rampAt(item: PlanItem, frame: number): number {
  let a = 1;
  if (item.rampIn > 0) a = Math.min(a, (frame - item.start + 0.5) / item.rampIn);
  if (item.rampOut > 0) a = Math.min(a, (item.end - frame - 0.5) / item.rampOut);
  return Math.max(0, Math.min(1, a));
}
