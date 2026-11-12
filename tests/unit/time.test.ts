import { describe, expect, it } from 'vitest';
import { FPS, framesToSeconds, framesToTimecode, parseRate, secondsToFrames, timecodeToFrames } from '../../src/core';

describe('time', () => {
  it('converts frames and seconds exactly for NTSC', () => {
    expect(framesToSeconds(30000, FPS.f2997)).toBeCloseTo(1001, 9);
    expect(secondsToFrames(1001, FPS.f2997)).toBe(30000);
    expect(secondsToFrames(0.0333, FPS.f30, 'floor')).toBe(0);
    expect(secondsToFrames(1 / 30, FPS.f30, 'floor')).toBe(1);
  });

  it('parses rates', () => {
    expect(parseRate('30000/1001')).toEqual({ num: 30000, den: 1001 });
    expect(parseRate('29.97')).toEqual({ num: 30000, den: 1001 });
    expect(parseRate('25')).toEqual({ num: 25, den: 1 });
    expect(parseRate('50/2')).toEqual({ num: 25, den: 1 });
    expect(parseRate('0/0')).toBeNull();
    expect(parseRate('abc')).toBeNull();
  });

  it('formats non-drop timecode', () => {
    expect(framesToTimecode(0, FPS.f25)).toBe('00:00:00:00');
    expect(framesToTimecode(25 * 3661 + 7, FPS.f25)).toBe('01:01:01:07');
  });

  it('formats drop-frame timecode (29.97)', () => {
    expect(framesToTimecode(1800, FPS.f2997)).toBe('00:01:00;02');
    expect(framesToTimecode(17982, FPS.f2997)).toBe('00:10:00;00');
    expect(framesToTimecode(1799, FPS.f2997)).toBe('00:00:59;29');
  });

  it('round-trips timecode', () => {
    for (const rate of [FPS.f2997, FPS.f5994, FPS.f24, FPS.f25]) {
      for (const f of [0, 1, 1799, 1800, 17982, 107892, 123456]) {
        expect(timecodeToFrames(framesToTimecode(f, rate), rate)).toBe(f);
      }
    }
    expect(timecodeToFrames('00:00:00:30', FPS.f30)).toBeNull();
  });
});

import { MigrationError, migrateProject, createProject } from '../../src/core';
describe('migrations', () => {
  it('applies registered migrations in order and refuses newer files', () => {
    const p = createProject('x') as unknown as Record<string, unknown>;
    const old = { ...p, schemaVersion: 1, legacy: true };
    const migrated = migrateProject(old, { 1: (d) => ({ ...d, upgraded: 1 }), 2: (d) => ({ ...d, upgraded: 2 }) }, 3) as unknown as Record<string, unknown>;
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.upgraded).toBe(2);
    expect(() => migrateProject({ ...p, schemaVersion: 5 })).toThrow(MigrationError);
    expect(() => migrateProject({ ...p, schemaVersion: 1 }, {}, 2)).toThrow(/No migration/);
  });
});
