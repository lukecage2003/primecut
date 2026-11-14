import { describe, expect, it } from 'vitest';
import { createProject, subtitleDir } from '../../src/core';
import { DEFAULT_PREFERENCES, alignByPauses, buildSequence, parseScript, speechFromSilences } from '../../src/production';
import { fakeMedia } from './helpers';

const SCRIPT = `# Le retour du Bouffon Vert

En 1964, Spider-Man affronte pour la première fois le Bouffon Vert. Personne ne connaît alors son identité.

## La révélation

Des années plus tard, Norman Osborn est démasqué! C'est un choc pour les lecteurs de Marvel.`;

function build(subtitles: boolean) {
  const script = parseScript(SCRIPT);
  const narration = fakeMedia({ name: 'voice.wav', kind: 'audio', video: false, durationSec: 24 });
  const silences = [0, 1, 2, 3, 4].map((i) => ({ start: i * 5, end: i * 5 + 1.2 }));
  const p = createProject('P');
  return buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script, alignment: alignByPauses(script.sentences, speechFromSilences(silences, 24)), narration, library: [], prefs: { ...DEFAULT_PREFERENCES, subtitles, pcore: 'off' } });
}

describe('no text shown twice', () => {
  it('with burned-in subtitles, no composition repeats the narration words', () => {
    const r = build(true);
    const narration = parseScript(SCRIPT).sentences.map((s) => s.text.toLowerCase());
    for (const g of r.generated.filter((x) => x.generator?.kind === 'typography')) {
      const t = (g.generator!.title ?? '').toLowerCase();
      expect(narration.some((n) => t.length > 8 && n.includes(t))).toBe(false);
    }
  });
  it('a name shown by a character card does not get a second name card at the same time', () => {
    const r = build(true);
    const lt = r.sequence.captions.filter((c) => c.style === 'lower-third');
    const v1 = r.sequence.tracks[0]!;
    for (const c of lt) {
      const under = v1.clips.find((x) => x.start <= c.start && x.start + x.duration > c.start);
      const g = r.generated.find((x) => x.id === under?.mediaId)?.generator;
      if (g?.kind === 'character-card') expect(g.title && c.text.toLowerCase().startsWith(g.title.toLowerCase())).toBeFalsy();
    }
  });
  it('a centred section title never sits on a text card', () => {
    const r = build(true);
    const v1 = r.sequence.tracks[0]!;
    for (const t of r.sequence.captions.filter((c) => c.style === 'title')) {
      const under = v1.clips.filter((x) => x.start < t.end && x.start + x.duration > t.start);
      for (const u of under) expect(['typography', 'character-card', 'timeline']).not.toContain(r.generated.find((g) => g.id === u.mediaId)?.generator?.kind);
    }
  });
  it('subtitle files never sit next to the video under its own name', () => {
    const d = subtitleDir('C:\\Vidéos\\apocalypse.mp4');
    expect(d).toBe('C:\\Vidéos\\apocalypse — sous-titres (pour YouTube, TikTok)');
    expect(/\/(subs|subtitles)$/i.test(d)).toBe(false);
  });
});

import { CAPTION_METRICS } from '../../src/core';
describe('name cards and subtitles never overlap', () => {
  it('the name card sits above two full lines of subtitles', () => {
    const subTop = CAPTION_METRICS.subtitle.marginV + 2 * CAPTION_METRICS.subtitle.size * 1.25;
    expect(CAPTION_METRICS['lower-third'].marginV).toBeGreaterThan(subTop);
  });
});
