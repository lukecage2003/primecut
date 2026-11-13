import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/core';
import { compareVersions, versionMetrics } from '../../src/production';
import { fakeMedia } from './helpers';

describe('version comparison', () => {
  it('measures both versions the same way and only judges technical facts', () => {
    const p = createProject('C', { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } });
    const seqA = p.sequences[p.activeSequenceId]!;
    const img1 = fakeMedia({ name: 'a.jpg', kind: 'image', durationSec: 0 });
    const img2 = fakeMedia({ name: 'b.jpg', kind: 'image', durationSec: 0 });
    const media = { [img1.id]: img1, [img2.id]: img2 };
    const clip = (id: string, mediaId: string, start: number, duration: number) => ({ id, mediaId, name: id, start, duration, sourceIn: 0, speed: 1, enabled: true, gainDb: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, fadeIn: 0, fadeOut: 0 }) as never;
    seqA.tracks[0]!.clips = [clip('1', img1.id, 0, 90), clip('2', img1.id, 90, 90), clip('3', img2.id, 180, 90)];
    const seqB = structuredClone(seqA);
    seqB.id = 'b';
    seqB.name = 'B';
    seqB.tracks[0]!.clips[1] = clip('2', img2.id, 90, 90);
    seqB.tracks[0]!.clips[2] = clip('3', img1.id, 180, 90);
    const a = versionMetrics(seqA, media);
    const b = versionMetrics(seqB, media);
    expect(a).toMatchObject({ shots: 3, durationSec: 9, repeatsBackToBack: 1, meanShotSec: 3 });
    expect(b.repeatsBackToBack).toBe(0);
    const rows = compareVersions(a, b);
    expect(rows.find((r) => r.key === 'repeatsBackToBack')!.verdict).toBe('better');
    expect(rows.find((r) => r.key === 'shots')!.verdict).toBe('same');
    // shot length is an editorial choice: never marked better/worse
    expect(rows.filter((r) => r.key === 'meanShotSec' || r.key === 'durationSec').every((r) => r.verdict === 'same' || r.verdict === 'diff')).toBe(true);
  });
});
