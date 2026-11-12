import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Project,
  type Sequence,
  EditError,
  History,
  clipsAt,
  createProject,
  deleteClips,
  moveClips,
  placeMedia,
  rollEdit,
  slideClip,
  slipClip,
  splitAt,
  trimClip,
  validateProject,
  setTrackProps,
  addMarker,
  addTrack,
} from '../../src/core';
import { fakeMedia } from './helpers';

let h: History;
const seq = (): Sequence => h.present.sequences[h.present.activeSequenceId]!;
const v1 = () => seq().tracks[0]!;
const a1 = () => seq().tracks[2]!;

function setup(): { project: Project; mediaId: string } {
  const project = createProject('Test');
  const m = fakeMedia({ durationSec: 10 });
  project.media[m.id] = m;
  h = new History(project);
  return { project, mediaId: m.id };
}

function place(mediaId: string, start: number, mode: 'overwrite' | 'insert' = 'overwrite') {
  return h.commit('place', (d) => placeMedia(d.sequences[d.activeSequenceId]!, d.media[mediaId]!, { videoTrack: 0, audioTrack: 0, start, mode }));
}

function valid() {
  expect(validateProject(h.present)).toEqual([]);
}

describe('timeline operations', () => {
  let mediaId: string;
  beforeEach(() => {
    mediaId = setup().mediaId;
  });

  it('places linked video+audio clips with exact duration', () => {
    const ids = place(mediaId, 0);
    expect(ids).toHaveLength(2);
    expect(v1().clips[0]!.duration).toBe(300);
    expect(a1().clips[0]!.duration).toBe(300);
    expect(v1().clips[0]!.linkId).toBe(a1().clips[0]!.linkId);
    valid();
  });

  it('overwrite trims and splits existing material', () => {
    place(mediaId, 0);
    // a 10s clip at frame 100 overwrites 100..400
    place(mediaId, 100);
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 100],
      [100, 300],
    ]);
    // place inside again -> split the second clip
    const m2 = fakeMedia({ durationSec: 1 });
    h.commit('add media', (d) => {
      d.media[m2.id] = m2;
    });
    place(m2.id, 200);
    expect(v1().clips.map((c) => [c.start, c.duration, +c.sourceIn.toFixed(4)])).toEqual([
      [0, 100, 0],
      [100, 100, 0],
      [200, 30, 0],
      [230, 170, 130 / 30].map((x) => +x.toFixed(4)),
    ]);
    // split right halves on V1 and A1 remain linked to each other
    const rv = v1().clips[3]!;
    const ra = a1().clips.find((c) => c.start === 230)!;
    expect(rv.linkId).toBeDefined();
    expect(rv.linkId).toBe(ra.linkId);
    valid();
  });

  it('insert mode ripples downstream clips', () => {
    place(mediaId, 0);
    place(mediaId, 150, 'insert');
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 150],
      [150, 300],
      [450, 150],
    ]);
    valid();
  });

  it('splits at the playhead (razor) on linked clips', () => {
    place(mediaId, 0);
    const created = h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 90));
    expect(created).toHaveLength(2);
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 90],
      [90, 210],
    ]);
    expect(v1().clips[1]!.sourceIn).toBeCloseTo(3, 9);
    expect(v1().clips[1]!.linkId).toBe(a1().clips[1]!.linkId);
    expect(v1().clips[0]!.linkId).not.toBe(v1().clips[1]!.linkId);
    valid();
  });

  it('moves linked clips together and overwrites destination', () => {
    place(mediaId, 0);
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 100));
    const second = v1().clips[1]!.id;
    h.commit('move', (d) => moveClips(d.sequences[d.activeSequenceId]!, [second], -50));
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 50],
      [50, 200],
    ]);
    expect(a1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 50],
      [50, 200],
    ]);
    valid();
  });

  it('moves a clip to another track', () => {
    const [vid] = place(mediaId, 0);
    h.commit('move', (d) => moveClips(d.sequences[d.activeSequenceId]!, [vid!], 30, { video: 1, audio: 0 }));
    expect(v1().clips).toHaveLength(0);
    expect(seq().tracks[1]!.clips[0]!.start).toBe(30);
    expect(a1().clips[0]!.start).toBe(30);
    valid();
  });

  it('refuses edits on locked tracks and leaves history unchanged', () => {
    const [vid] = place(mediaId, 0);
    h.commit('lock', (d) => setTrackProps(d.sequences[d.activeSequenceId]!, v1().id, { locked: true }));
    const before = h.present;
    expect(() => h.commit('move', (d) => moveClips(d.sequences[d.activeSequenceId]!, [vid!], 10))).toThrow(EditError);
    expect(h.present).toBe(before);
  });

  it('refuses moving before zero', () => {
    const [vid] = place(mediaId, 10);
    expect(() => h.commit('move', (d) => moveClips(d.sequences[d.activeSequenceId]!, [vid!], -11))).toThrow(EditError);
  });

  it('trims with media and neighbour constraints', () => {
    const [vid] = place(mediaId, 0);
    // cannot extend beyond media
    const applied = h.commit('trim', (d) => trimClip(d.sequences[d.activeSequenceId]!, d.media, vid!, 'out', 50));
    expect(applied).toBe(0);
    expect(h.commit('trim', (d) => trimClip(d.sequences[d.activeSequenceId]!, d.media, vid!, 'out', -100))).toBe(-100);
    expect(v1().clips[0]!.duration).toBe(200);
    expect(a1().clips[0]!.duration).toBe(200);
    // trim in: +20 moves start and source
    expect(h.commit('trim', (d) => trimClip(d.sequences[d.activeSequenceId]!, d.media, vid!, 'in', 20))).toBe(20);
    expect(v1().clips[0]!.start).toBe(20);
    expect(v1().clips[0]!.sourceIn).toBeCloseTo(20 / 30, 9);
    // cannot extend head beyond source start
    expect(h.commit('trim', (d) => trimClip(d.sequences[d.activeSequenceId]!, d.media, vid!, 'in', -999))).toBe(-20);
    valid();
  });

  it('ripple trim shifts later clips', () => {
    place(mediaId, 0);
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 100));
    const first = v1().clips[0]!.id;
    h.commit('ripple', (d) => trimClip(d.sequences[d.activeSequenceId]!, d.media, first, 'out', -40, true));
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 60],
      [60, 200],
    ]);
    valid();
  });

  it('roll edit moves the cut point', () => {
    place(mediaId, 0);
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 100));
    const [l, r] = v1().clips;
    expect(h.commit('roll', (d) => rollEdit(d.sequences[d.activeSequenceId]!, d.media, l!.id, r!.id, 10))).toBe(10);
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 110],
      [110, 190],
    ]);
    expect(v1().clips[1]!.sourceIn).toBeCloseTo(110 / 30, 9);
  });

  it('slip changes source without moving', () => {
    place(mediaId, 0);
    const vid = v1().clips[0]!.id;
    h.commit('trim', (d) => trimClip(d.sequences[d.activeSequenceId]!, d.media, vid, 'out', -100));
    expect(h.commit('slip', (d) => slipClip(d.sequences[d.activeSequenceId]!, d.media, vid, 150))).toBe(100);
    expect(v1().clips[0]!.start).toBe(0);
    expect(v1().clips[0]!.sourceIn).toBeCloseTo(100 / 30, 9);
    expect(a1().clips[0]!.sourceIn).toBeCloseTo(100 / 30, 9);
  });

  it('slide moves a clip between neighbours', () => {
    place(mediaId, 0);
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 100));
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 200));
    const mid = v1().clips[1]!.id;
    expect(h.commit('slide', (d) => slideClip(d.sequences[d.activeSequenceId]!, d.media, mid, 10))).toBe(10);
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 110],
      [110, 100],
      [210, 90],
    ]);
    valid();
  });

  it('ripple delete closes gaps', () => {
    place(mediaId, 0);
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 100));
    const first = v1().clips[0]!.id;
    h.commit('del', (d) => deleteClips(d.sequences[d.activeSequenceId]!, [first], true));
    expect(v1().clips.map((c) => [c.start, c.duration])).toEqual([[0, 200]]);
    expect(a1().clips.map((c) => [c.start, c.duration])).toEqual([[0, 200]]);
  });

  it('undo / redo restores exact states', () => {
    const s0 = h.present;
    place(mediaId, 0);
    const s1 = h.present;
    h.commit('split', (d) => splitAt(d.sequences[d.activeSequenceId]!, 100));
    expect(h.undo()).toBe(true);
    expect(h.present).toBe(s1);
    expect(h.undo()).toBe(true);
    expect(h.present).toBe(s0);
    expect(h.undo()).toBe(false);
    h.redo();
    expect(h.present).toBe(s1);
    expect(h.dirty).toBe(true);
  });

  it('clipsAt / markers / tracks', () => {
    place(mediaId, 0);
    expect(clipsAt(seq(), 299)).toHaveLength(2);
    expect(clipsAt(seq(), 300)).toHaveLength(0);
    h.commit('marker', (d) => addMarker(d.sequences[d.activeSequenceId]!, 42));
    h.commit('track', (d) => addTrack(d.sequences[d.activeSequenceId]!, 'video'));
    expect(seq().markers[0]!.frame).toBe(42);
    expect(seq().tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3', 'A1', 'A2']);
  });

  it('stills get default duration, audio-only go to audio tracks', () => {
    const img = fakeMedia({ kind: 'image', audio: false, name: 'a.png', durationSec: 0 });
    const aud = fakeMedia({ video: false, kind: 'audio', name: 'a.wav', durationSec: 2 });
    h.commit('add', (d) => {
      d.media[img.id] = img;
      d.media[aud.id] = aud;
    });
    place(img.id, 0);
    place(aud.id, 0);
    expect(v1().clips[0]!.duration).toBe(150);
    expect(a1().clips[0]!.duration).toBe(60);
    valid();
  });
});
