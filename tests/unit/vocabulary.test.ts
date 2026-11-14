import { describe, expect, it } from 'vitest';
import { applyVocabulary, parseVocabulary, spellingSimilarity } from '../../src/production/vocabulary';

const W = (s: string) => s.split(' ').map((text, i) => ({ text, start: i, end: i + 0.8 }));

describe('proper names applied to a transcription', () => {
  it('fixes misheard names, keeps timing and punctuation, reports each change', () => {
    const r = applyVocabulary(W('Parce que derrière N. Sabanour, il existe un plan. Arcangel arrive avec les death-sid.'), parseVocabulary('En Sabah Nur, Archangel, Death Seed'));
    expect(r.words.map((w) => w.text).join(' ')).toBe('Parce que derrière En Sabah Nur, il existe un plan. Archangel arrive avec les Death Seed.');
    expect(r.corrections.map((c) => c.name)).toEqual(['En Sabah Nur', 'Archangel', 'Death Seed']);
    const nur = r.words.filter((w) => ['En', 'Sabah', 'Nur,'].includes(w.text));
    expect(nur[0]!.start).toBe(3);
    expect(nur.at(-1)!.end).toBeCloseTo(4.8, 5);
  });
  it('keeps elisions and small edge words, and prefers the closest spelling', () => {
    const v = parseVocabulary('Apocalypse, Archangel, Dark Angel, Marvel, En Sabah Nur');
    const r = applyVocabulary(W("la saga d'apocalypse et qu'Arcangel revient. Mais si Marvel veut, de En Sabanour, Age of apocalypse."), v);
    expect(r.words.map((w) => w.text).join(' ')).toBe("la saga d'Apocalypse et qu'Archangel revient. Mais si Marvel veut, de En Sabah Nur, Age of Apocalypse.");
  });
  it('keeps the number heard (singular / plural)', () => {
    const r = applyVocabulary(W('un Celeste arrive. les celestes partent.'), ['Célestes']);
    expect(r.words.map((w) => w.text).join(' ')).toBe('un Céleste arrive. les Célestes partent.');
  });
  it('leaves ordinary words alone and does not cross sentences', () => {
    const r = applyVocabulary(W('Il est parti. Le marché arrive ensuite.'), ['Marvel', 'Apocalypse']);
    expect(r.corrections).toEqual([]);
    expect(spellingSimilarity('marché', 'Marvel')).toBeLessThan(0.72);
    expect(applyVocabulary(W('Archangel revient.'), ['Archangel']).corrections).toEqual([]);
  });
});
