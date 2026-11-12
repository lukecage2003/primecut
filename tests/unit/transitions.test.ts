import { beforeEach, describe, expect, it } from 'vitest';
import {
  EditError,
  History,
  type Project,
  addTransition,
  addTransitionsAt,
  createProject,
  maxTransitionDuration,
  migrateProject,
  moveClips,
  normalizeSequence,
  placeMedia,
  planSequence,
  rampAt,
  setClipFades,
  setTransitionDuration,
  splitAt,
  trimClip,
  validateProject,
} from '../../src/core';
import { fakeMedia } from './helpers';

let h: History;
let mediaId: string;
const seq = () => h.present.sequences[h.present.activeSequenceId]!;
const v1 = () => seq().tracks[0]!;
const a1 = () => seq().tracks[2]!;
function run<R>(fn: (d: Project) => R): R {
  return h.commit('op', (d) => {
    const r = fn(d as Project);
    normalizeSequence(d.sequences[d.activeSequenceId]!, d.media);
    return r;
  });
}
const S = (d: Project) => d.sequences[d.activeSequenceId]!;

beforeEach(() => {
  const p = createProject('T');
  const m = fakeMedia({ durationSec: 10 });
  p.media[m.id] = m;
  mediaId = m.id;
  h = new History(p);
  // one 10s clip split at 150 → two adjacent halves with handles on both sides of the cut
  run((d) => placeMedia(S(d), d.media[mediaId]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
  run((d) => splitAt(S(d), 150));
});

describe('transitions', () => {
  it('adds a centred cross-dissolve, clamped to handles', () => {
    const [l, r] = v1().clips;
    expect(maxTransitionDuration(seq(), h.present.media, l!, r!)).toBe(300);
    const id = run((d) => addTransition(S(d), d.media, v1().id, l!.id, r!.id, 30));
    expect(v1().transitions).toEqual([{ id, kind: 'cross-dissolve', leftClipId: l!.id, rightClipId: r!.id, duration: 30 }]);
    expect(validateProject(h.present)).toEqual([]);
  });

  it('limits duration by available media handles', () => {
    // trim the right clip's head to 4 frames of handle: before = floor(d/2) <= 4 → d <= 9
    const [l, r] = v1().clips;
    run((d) => trimClip(S(d), d.media, r!.id, 'in', -146, false)); // can't extend into left clip → 0
    run((d) => moveClips(S(d), [r!.id], 0));
    const right = v1().clips[1]!;
    expect(right.sourceIn).toBeCloseTo(5, 9);
    // make a short-handle cut by slipping the right clip to source 4 frames
    run((d) => {
      S(d).tracks.forEach((t) => t.clips.forEach((c) => c.id === right.id && (c.sourceIn = 4 / 30)));
    });
    const max = maxTransitionDuration(seq(), h.present.media, v1().clips[0]!, v1().clips[1]!);
    expect(max).toBe(9);
    run((d) => addTransition(S(d), d.media, v1().id, l!.id, right.id, 60));
    expect(v1().transitions[0]!.duration).toBe(9);
  });

  it('refuses cuts without handles', () => {
    const p = createProject('N');
    const a = fakeMedia({ durationSec: 2 });
    const b = fakeMedia({ durationSec: 2 });
    p.media[a.id] = a;
    p.media[b.id] = b;
    const hh = new History(p);
    hh.commit('a', (d) => placeMedia(S(d as Project), d.media[a.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
    hh.commit('b', (d) => placeMedia(S(d as Project), d.media[b.id]!, { videoTrack: 0, audioTrack: 0, start: 60, mode: 'overwrite' }));
    const t = S(hh.present).tracks[0]!;
    expect(() => hh.commit('t', (d) => addTransition(S(d as Project), d.media, t.id, t.clips[0]!.id, t.clips[1]!.id, 30))).toThrow(EditError);
  });

  it('Ctrl+D adds matching video dissolve and audio crossfade', () => {
    const ids = run((d) => addTransitionsAt(S(d), d.media, 151, 30));
    expect(ids).toHaveLength(2);
    expect(v1().transitions).toHaveLength(1);
    expect(a1().transitions).toHaveLength(1);
  });

  it('is pruned when clips are separated and follows splits', () => {
    run((d) => addTransitionsAt(S(d), d.media, 150, 30));
    // split the left clip: transition moves to the new right half (still adjacent to the cut)
    run((d) => splitAt(S(d), 50));
    expect(v1().transitions).toHaveLength(1);
    expect(v1().transitions[0]!.leftClipId).toBe(v1().clips[1]!.id);
    expect(validateProject(h.present)).toEqual([]);
    // move the right clip away: transition disappears
    const right = v1().clips[2]!.id;
    run((d) => moveClips(S(d), [right], 10));
    expect(v1().transitions).toHaveLength(0);
    expect(a1().transitions).toHaveLength(0);
  });

  it('duration can be changed and is clamped', () => {
    const [id] = run((d) => addTransitionsAt(S(d), d.media, 150, 30));
    expect(run((d) => setTransitionDuration(S(d), d.media, id!, 1000))).toBe(300);
    expect(run((d) => setTransitionDuration(S(d), d.media, id!, 0))).toBe(2);
  });
});

describe('fades and render plan', () => {
  it('fades are linked and clamped', () => {
    const left = v1().clips[0]!.id;
    run((d) => setClipFades(S(d), left, { fadeIn: 15, fadeOut: 1000 }));
    expect(v1().clips[0]).toMatchObject({ fadeIn: 15, fadeOut: 135 });
    expect(a1().clips[0]).toMatchObject({ fadeIn: 15, fadeOut: 135 });
  });

  it('plan extends clips into handles and ramps opacity / volume', () => {
    run((d) => addTransitionsAt(S(d), d.media, 150, 30));
    const plan = planSequence(seq(), h.present.media);
    const vl = plan.find((p) => p.kind === 'video' && p.clip.start === 0)!;
    const vr = plan.find((p) => p.kind === 'video' && p.clip.start === 150)!;
    const al = plan.find((p) => p.kind === 'audio' && p.clip.start === 0)!;
    expect([vl.start, vl.end, vl.rampIn, vl.rampOut]).toEqual([0, 165, 0, 0]); // stays opaque underneath
    expect([vr.start, vr.end, vr.rampIn]).toEqual([135, 300, 30]);
    expect(vr.sourceIn).toBeCloseTo(135 / 30, 9);
    expect([al.end, al.rampOut]).toEqual([165, 30]); // audio crossfade
    expect(rampAt(vr, 135)).toBeCloseTo(0.5 / 30, 6);
    expect(rampAt(vr, 150)).toBeCloseTo(15.5 / 30, 6);
    expect(rampAt(vr, 200)).toBe(1);
    expect(vr.layer).toBeGreaterThan(vl.layer);
  });

  it('skips disabled tracks and clips', () => {
    run((d) => {
      S(d).tracks[0]!.disabled = true;
      S(d).tracks[2]!.clips[0]!.enabled = false;
    });
    const plan = planSequence(seq(), h.present.media);
    expect(plan.filter((p) => p.kind === 'video')).toHaveLength(0);
    expect(plan.filter((p) => p.kind === 'audio')).toHaveLength(1);
  });
});

describe('schema v1 → v2 migration', () => {
  it('adds transitions and fades to v1 documents', () => {
    const p = JSON.parse(JSON.stringify(h.present)) as Record<string, any>;
    p.schemaVersion = 1;
    for (const s of Object.values(p.sequences) as any[])
      for (const t of s.tracks) {
        delete t.transitions;
        for (const c of t.clips) {
          delete c.fadeIn;
          delete c.fadeOut;
        }
      }
    const m = migrateProject(p);
    expect(m.schemaVersion).toBe(2);
    expect(validateProject(m)).toEqual([]);
    expect(m.sequences[m.activeSequenceId]!.tracks[0]!.clips[0]!.fadeIn).toBe(0);
  });
});
