import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/production/commands';
import { DEFAULT_PREFERENCES } from '../../src/production/preferences';

describe('edit instructions in plain French', () => {
  it('understands several instructions in one sentence', () => {
    const r = applyCommand('Fais des plans plus courts, baisse la musique de 3 dB et enlève les sous-titres', DEFAULT_PREFERENCES);
    expect(r.prefs.shotTarget).toBeLessThan(DEFAULT_PREFERENCES.shotTarget);
    expect(r.prefs.musicRelativeDb).toBe(DEFAULT_PREFERENCES.musicRelativeDb - 3);
    expect(r.prefs.subtitles).toBe(false);
    expect(r.changes).toHaveLength(3);
    expect(r.unknown).toEqual([]);
  });
  it('exact values, panel speed, voice and the logo', () => {
    const r = applyCommand('plans de 3 secondes. lis les cases plus lentement. voix naturelle. mets le logo en haut à gauche, logo plus petit', DEFAULT_PREFERENCES);
    expect(r.prefs.shotTarget).toBe(3);
    expect(r.prefs.secondsPerPanel).toBeGreaterThan(DEFAULT_PREFERENCES.secondsPerPanel);
    expect(r.prefs.voiceStyle).toBe('natural');
    expect(r.placement).toEqual({ corner: 'top-left', badgeScale: 0.15 });
  });
  it('says what it did not understand instead of guessing', () => {
    const r = applyCommand('rends la vidéo plus épique', DEFAULT_PREFERENCES);
    expect(r.changes).toEqual([]);
    expect(r.unknown.length).toBe(1);
  });
  it('hesitations, pauses, music off, no transitions', () => {
    const r = applyCommand('coupe les euh et les répétitions, resserre les pauses, pas de musique, sans fondus', { ...DEFAULT_PREFERENCES, cutDisfluencies: false });
    expect(r.prefs.cutDisfluencies).toBe(true);
    expect(r.prefs.tightenPauses).toBe(true);
    expect(r.prefs.musicFromLibrary).toBe(false);
    expect(r.prefs.dissolveShare).toBe(0);
  });
});
