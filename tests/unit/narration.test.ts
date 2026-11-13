import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, detectNarrationFormat, directionFor, joinTokens, parseScript, rankCard, scriptFromTranscript, alignToTranscript } from '../../src/production';

const words = (text: string, gapAfter: Record<number, number> = {}) => {
  let t = 0;
  return text.split(' ').map((w, i) => {
    const r = { text: w, start: t, end: t + 0.3 };
    t += 0.35 + (gapAfter[i] ?? 0);
    return r;
  });
};

describe('script from the narration (no written script)', () => {
  it('joins recogniser tokens back into French text', () => {
    expect(joinTokens(['Tout', 'le', 'monde', 'connaît', 'l', "'histoire", 'de', 'Spider', '-Man', ','])).toBe("Tout le monde connaît l'histoire de Spider-Man,");
  });
  it('builds sentences, sections and titles from pauses and spoken cues, aligned exactly', () => {
    const text = 'Peter Parker est mordu par une araignée. Peter Parker devient Spider-Man. Il sauve New York chaque nuit. Peter Parker garde son secret. Il travaille au Daily Bugle. Peter Parker aime Mary Jane. Passons maintenant au Bouffon Vert. Norman Osborn devient le Bouffon Vert. Norman Osborn attaque la ville. Le combat dure toute la nuit.';
    const w = words(text, { 37: 2.5 });
    const r = scriptFromTranscript(w);
    const p = parseScript(r.markdown);
    expect(p.sentences.length).toBe(10);
    expect(r.markdown.match(/^## /gm)).toHaveLength(2);
    expect(r.markdown).toMatch(/## Peter Parker/);
    expect(r.markdown).toMatch(/## Bouffon Vert/);
    expect(alignToTranscript(p.sentences, w).confidence).toBe(1);
  });
  it('leaves a retake at the end out of the script', () => {
    const w = words('Spider-Man sauve la ville une fois de plus. Il rentre enfin chez lui. Oh là là mais ça commence à me faire chier franchement.');
    const r = scriptFromTranscript(w);
    expect(r.outtakes).toHaveLength(1);
    expect(r.markdown).not.toMatch(/chier/);
  });
});

describe('narration format', () => {
  const fmt = (md: string, sec = 600, portrait = false) => detectNarrationFormat(parseScript(md), sec, portrait);
  it('recognises a ranking (countdown or N°) but not chapter numbering', () => {
    const ranking = '# Top\n\n## 5. Venom\n\nNuméro 5 : Venom.\n\n## 4. Carnage\n\nNuméro 4 : Carnage.\n\n## 3. Bouffon Vert\n\nNuméro 3 : le Bouffon Vert.';
    expect(fmt(ranking).kind).toBe('classement');
    const chapters = '# Doc\n\n## 1. Les débuts\n\nSpider-Man est né en 1962.\n\n## 2. La suite\n\nIl devient célèbre.\n\n## 3. Fin\n\nPourquoi ses pouvoirs fonctionnent-ils ainsi ? Autrement dit, comment ?';
    expect(fmt(chapters).kind).not.toBe('classement');
  });
  it('recognises versus, theory, length classes', () => {
    expect(fmt('Hulk versus Thor : qui gagnerait ? Hulk contre Thor, le duel ultime.').kind).toBe('versus');
    expect(fmt('Et si Peter Parker était mort ? Selon moi, cette théorie pourrait expliquer tout. Cette hypothèse serait logique.').kind).toBe('theorie');
    expect(fmt('Texte.', 90).length).toBe('short');
    expect(fmt('Texte.', 3600).length).toBe('documentaire');
  });
  it('turns the format into explained direction changes, and rank cards', () => {
    const d = directionFor({ kind: 'recap', length: 'short' }, DEFAULT_PREFERENCES);
    expect(d.prefs.shotTarget).toBeLessThanOrEqual(2.8);
    expect(d.prefs.panelReading).toBe(true);
    expect(d.changes.length).toBeGreaterThan(2);
    expect(DEFAULT_PREFERENCES.shotTarget).toBe(4.5); // the saved preferences are not modified
    expect(rankCard('Numéro 3 : le Bouffon Vert.')).toBe('N°3');
    expect(rankCard('En première position, Venom.')).toBe('N°1');
    expect(rankCard('Venom est premier.')).toBeNull();
  });
});
