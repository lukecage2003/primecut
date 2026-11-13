import { describe, expect, it } from 'vitest';
import { cutsFromKeep, detectDisfluencies, keepFromCuts, remapTime, scriptFromTranscript, wordsAfterCuts } from '../../src/production';

const words = (s: string, step = 0.4) => s.split(' ').map((text, i) => ({ text, start: i * step, end: i * step + 0.3 }));

describe('hesitations and repetitions', () => {
  it('finds fillers and immediate repetitions, never French grammatical doubles or intensifiers', () => {
    const w = words("Peter euh rentre chez lui et le le Bouffon l'attend . Nous nous battons , très très fort , c'est un c'est un piège");
    const d = detectDisfluencies(w);
    expect(d.map((x) => [x.kind, x.text])).toEqual([
      ['hesitation', 'euh'],
      ['repetition', 'le le'],
      ['repetition', "c'est un c'est un"],
    ]);
    // the removed span ends before the kept copy starts
    const le = d[1]!;
    const second = w.findIndex((x, i) => x.text === 'le' && w[i - 1]?.text === 'le');
    expect(le.end).toBeLessThan(w[second]!.start);
    expect(le.start).toBeLessThan(w[second - 1]!.start + 0.01);
  });

  it('ignores sentence boundaries, exclamations and name fragments (false positives found on real transcripts)', () => {
    const w = words("Elle cite aussi Jubilee. Jubilee est une mutante . oh lala lala , Marie -Henri -Henri Beyle , la vraie question est... Est -ce que , Batman, SoCut, SoCut, trente, trois, trois, Dans X -men X -men 13");
    expect(detectDisfluencies(words('il a dit le, le Bouffon')).map((d) => d.text)).toEqual(['le, le,'.slice(0, 6)]);
    expect(detectDisfluencies(w)).toEqual([]);
  });

  it('cuts become a keep list; words inside cuts disappear and the rest is remapped', () => {
    const w = words('Peter euh rentre le le soir');
    const d = detectDisfluencies(w);
    const dur = 3;
    const keep = keepFromCuts([...d, { start: 2.9, end: 5 }], dur);
    expect(cutsFromKeep(keep, dur).length).toBe(3);
    const after = wordsAfterCuts(w, cutsFromKeep(keep, dur), (t) => remapTime(t, keep));
    expect(after.map((x) => x.text)).toEqual(['Peter', 'rentre', 'le', 'soir']);
    for (let i = 1; i < after.length; i++) expect(after[i]!.start).toBeGreaterThanOrEqual(after[i - 1]!.end - 0.05);
  });

  it('keeps fillers out of a script built from the voice', () => {
    const md = scriptFromTranscript(words('Peter Parker euh rentre chez lui ce soir là .')).markdown;
    expect(md).not.toMatch(/euh/);
    expect(md).toMatch(/rentre chez lui/);
  });
});
