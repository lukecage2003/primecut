import { describe, expect, it } from 'vitest';
import { cutsFromScores, parseSceneScores, prefsFromProfile, profileFrom } from '../../src/engine/styleReference';
import { DEFAULT_PREFERENCES } from '../../src/production/preferences';

describe('editing style of a reference video', () => {
  it('reads FFmpeg scene scores and finds the cuts', () => {
    const log = ['[Parsed_metadata_3 @ 0x1] frame:0    pts:0       pts_time:0', '[Parsed_metadata_3 @ 0x1] lavfi.scene_score=0.000000', 'frame:1 pts:1 pts_time:0.1', 'lavfi.scene_score=0.001', 'frame:30 pts:30 pts_time:3', 'lavfi.scene_score=0.92', 'frame:31 pts:31 pts_time:3.1', 'lavfi.scene_score=0.5', 'frame:50 pts:50 pts_time:5', 'lavfi.scene_score=0.7'].join('\n');
    const s = parseSceneScores(log);
    expect(s).toHaveLength(5);
    const { cuts } = cutsFromScores(s);
    expect(cuts).toEqual([3, 5]); // 3.1 is the same cut (less than 0.4 s later)
  });
  it('turns a fast edit into short shots, and a slow one into long shots', () => {
    const fast = profileFrom('f', 60, Array.from({ length: 29 }, (_, i) => (i + 1) * 2), 0.004, -14, 0.9);
    expect(fast.shot.median).toBeCloseTo(2, 1);
    expect(fast.cutsPerMinute).toBeCloseTo(29, 0);
    expect(fast.motionKind).toBe('images animées (zooms, panoramiques)');
    const p = prefsFromProfile(fast, DEFAULT_PREFERENCES);
    expect(p.prefs.shotTarget).toBeCloseTo(2, 1);
    expect(p.prefs.narrationLufs).toBe(-14);
    expect(p.changes.length).toBeGreaterThan(2);
    const slow = profileFrom('s', 60, [10, 20, 30, 40, 50], 0.0005, null, 0.5);
    expect(slow.motionKind).toBe('images fixes');
    expect(prefsFromProfile(slow, DEFAULT_PREFERENCES).prefs.shotTarget).toBe(10);
  });
  it('describes the rhythm along the video', () => {
    const acc = profileFrom('a', 100, [10, 20, 30, 40, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98], 0.004, null, 1);
    expect(acc.rhythm[0]).toBeGreaterThan(acc.rhythm[9]!);
    expect(acc.summary.join(' ')).toMatch(/accélère/);
  });
});
