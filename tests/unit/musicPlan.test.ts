import { describe, expect, it } from 'vitest';
import { parseScript } from '../../src/production';
import { analyseNarrative } from '../../src/production/narrative';
import { type MusicCandidate, planMusic, snapToPause } from '../../src/production/musicPlan';

const SCRIPT = `# Et si tout avait changé ?

Saviez-vous que ce personnage a failli ne jamais exister ? Pourquoi Marvel a-t-il hésité ?

## Les origines

En 1962, Stan Lee et Steve Ditko créent le personnage. À l'époque, les ventes sont faibles. Le titre est publié presque par hasard. Les lecteurs découvrent un adolescent ordinaire.

## La bataille finale

Il affronte le Bouffon Vert! Le combat détruit le pont! Gwen meurt!

## Conclusion

Au final, cette histoire a tout changé. Dites-moi en commentaire votre moment préféré.`;

const track = (id: string, energy: MusicCandidate['energy'], moods: MusicCandidate['moods'], extra: Partial<MusicCandidate> = {}): MusicCandidate => ({
  trackId: id, title: id, path: `/m/${id}.mp3`, durationSec: 120, energy, moods, bpm: 100, vocalsLikely: false, licence: 'CC0', licenceStatus: 'déclarée', uses: 0, loopScore: 0.5, ...extra,
});

describe('narrative structure (rules with evidence)', () => {
  it('reads hook, context, reveal/action and conclusion, with cues and bounded confidence', () => {
    const n = analyseNarrative(parseScript(SCRIPT));
    expect(n.map((x) => x.fn)).toEqual(['accroche', 'contexte', 'révélation', 'conclusion']);
    expect(n[0]!.evidence.join(' ')).toMatch(/question/);
    expect(n[1]!.evidence.join(' ')).toMatch(/1962|époque/);
    expect(n[2]!.intensity).toBeGreaterThan(n[1]!.intensity);
    expect(n[2]!.moods[0]).toBe('action');
    expect(n.every((x) => x.confidence > 0 && x.confidence < 1)).toBe(true);
  });
  it('a script without cues gets a low-confidence default, not an invented function', () => {
    const n = analyseNarrative(parseScript('Une phrase.\n\nUne autre phrase.'));
    expect(n).toHaveLength(1);
    expect(n[0]!.confidence).toBeLessThanOrEqual(0.55);
  });
});

describe('music per section', () => {
  const narrative = analyseNarrative(parseScript(SCRIPT));
  const spans = narrative.map((x, i) => ({ section: x.section, start: i * 40, end: i * 40 + 40, narrative: x }));
  const lib = [
    track('calme', 'basse', ['calme', 'lumineux']),
    track('mystere', 'moyenne', ['mystère', 'tension']),
    track('action', 'haute', ['action', 'épique']),
    track('chant', 'haute', ['action'], { vocalsLikely: true }),
    track('nc', 'haute', ['action', 'épique'], { licence: 'CC-BY-NC' }),
  ];

  it('changes music only at section boundaries, by energy and mood, avoiding vocals and NC licences', () => {
    const plan = planMusic(spans, lib);
    expect(plan.length).toBeGreaterThanOrEqual(2);
    const at = (t: number) => plan.find((p) => p.start <= t && p.end > t)!;
    expect(at(90).trackId).toBe('action');
    expect(at(10).trackId).not.toBe('action');
    expect(plan.some((p) => p.trackId === 'chant' || p.trackId === 'nc')).toBe(false);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.start).toBe(plan[i - 1]!.end);
      expect(plan[i]!.trackId).not.toBe(plan[i - 1]!.trackId);
    }
    expect(at(90).reasons.join(' ')).toMatch(/intense/);
  });

  it('snaps switches onto a pause of the voice', () => {
    const plan = planMusic(spans, lib, { pauses: [{ start: 78.6, end: 79.4 }] });
    const sw = plan.find((p) => p.trackId === 'action')!;
    expect(sw.start).toBeCloseTo(79, 5);
    expect(sw.reasons).toContain('changement placé sur une pause de la voix');
    expect(snapToPause(10, [{ start: 30, end: 31 }], 2)).toEqual({ t: 10, snapped: false });
  });

  it('keeps a locked track and never proposes a rejected one again', () => {
    const base = planMusic(spans, lib);
    const climax = base.find((p) => p.trackId === 'action')!;
    const locked = planMusic(spans, lib, { locks: new Map([[climax.anchor, 'calme']]) });
    expect(locked.find((p) => p.anchor === climax.anchor || p.key.includes(climax.anchor))!.trackId).toBe('calme');
    const rejected = planMusic(spans, lib, { rejected: new Map([[climax.anchor, new Set(['action'])]]) });
    expect(rejected.every((p) => !(p.key.includes(climax.anchor) && p.trackId === 'action'))).toBe(true);
    expect(planMusic(spans, [])).toEqual([]);
  });
});
