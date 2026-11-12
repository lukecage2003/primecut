import { describe, expect, it } from 'vitest';
import { importProductionScript, parseScript, repairGluedWords } from '../../src/production';

const DICT = new Set(
  'a à de se un des le la les plus il est et dans pour avec une prépare préparation temps parce futur alternatif comprendre the dark heroes secret marvel super ville nuit héros apparaît pendant enquête'.split(' '),
);
const dict = (w: string) => DICT.has(w);

// Synthetic script written in the same layout as real PDF exports (pdftotext/pdf.js output).
const PDF_LIKE = `       LE HÉROS DE LA NUIT
          ET SES LIMITES
   Une enquête sur un mythe de fans


  Format        Script vidéo long format - environ 12 minutes
  Angle         Direct, documenté


Note éditoriale : ce document sépare les faits des interprétations.

0:00 - 1:10 | INTRODUCTION - LE MYTHE
Le Chevalier Noir gagne parcequ’il a eu le temps dese préparer. C'est ce que tout le monde répète.
Mais est-ce vrai ? Dans Marvel Super HeroesSecret Wars #1, rien ne le prouve.

   VISUELS — Couverture Dark Knight 1986 →
              Couverture Hush 2003
   Texte : « LE TEMPS SUFFIT-IL ? »

1:10 - 3:00 | 1. 1986 - LE RETOUR : L’IMAGE QUI
A FIXÉ LE MYTHE
ANALYSE / CRITIQUE : Le récit montre un futur alternatif dans lequel le héros revient. Il prépare une
armure.
 Source(s) comics : Dark Knight Returns #1-4 (1986) • Hush #612 (2003)

   Montage : couper sur l'armure, puis zoom sur le visage.

PRIMESTONE - Le héros de la nuit                                                   1 / 2
Le combat est bref. Il est violent.

SOURCES PRINCIPALES
Dark Knight Returns #1-4 (1986).
Hush (2003).
PRIMESTONE - Le héros de la nuit                                                   2 / 2
`;

describe('production script import', () => {
  it('turns a PDF-like production script into narration, sections, hints, sources and meta', () => {
    const imp = importProductionScript(PDF_LIKE, { dictionary: dict });
    expect(imp.structured).toBe(true);
    expect(imp.title).toBe('LE HÉROS DE LA NUIT ET SES LIMITES');
    expect(imp.meta['Format']).toMatch(/12 minutes/);
    expect(imp.meta['Note éditoriale']).toMatch(/faits/);
    expect(imp.sectionTargets).toEqual([
      { start: 0, end: 70 },
      { start: 70, end: 180 },
    ]);
    const p = parseScript(imp.markdown);
    expect(p.sections.map((s) => s.title)).toEqual(['INTRODUCTION - LE MYTHE', '1. 1986 - LE RETOUR : L’IMAGE QUI A FIXÉ LE MYTHE']);
    const text = p.sentences.map((s) => s.text).join(' ');
    // glued words repaired, labels/footers/metadata/sources never narrated
    expect(text).toContain('parce qu’il a eu le temps de se préparer');
    expect(text).toContain('Super Heroes Secret Wars #1');
    expect(text).not.toMatch(/PRIMESTONE|ANALYSE|Format|Source|VISUELS|Montage|SOURCES PRINCIPALES|12 minutes/);
    expect(text).toContain('Le récit montre un futur alternatif dans lequel le héros revient. Il prépare une armure.');
    expect(p.sentences.at(-1)!.text).toBe('Il est violent.');
    // visual directions after a paragraph describe that paragraph, in order
    const intro = p.sentences.filter((s) => s.section === 0);
    expect(intro[0]!.hints).toContain('Couverture Dark Knight 1986');
    expect(intro.flatMap((s) => s.hints)).toEqual(['Couverture Dark Knight 1986', 'Couverture Hush 2003']);
    expect(intro[0]!.onScreen).toEqual(['LE TEMPS SUFFIT-IL ?']);
    const s1 = p.sentences.filter((s) => s.section === 1);
    expect(s1[0]!.sources).toEqual(['Dark Knight Returns #1-4 (1986)', 'Hush #612 (2003)']);
    expect(s1.flatMap((s) => s.hints).join(' ')).toMatch(/armure/);
    expect(imp.meta['Annexes']).toMatch(/SOURCES PRINCIPALES/);
  });

  it('repairs glued words without breaking real words or names', () => {
    const r = repairGluedWords('Batman est là. Batman revient. SiBatman prépare dese pièges. Catwoman et Amanda aussi. Le temps parcequ’il faut.', [], dict);
    expect(r.text).toContain('Si Batman prépare de se pièges');
    expect(r.text).toContain('Catwoman et Amanda');
    expect(r.text).toContain('parce qu’il');
    expect(repairGluedWords('quelqu’un aujourd’hui', [], dict).repairs).toEqual([]);
  });

  it('keeps plain prose scripts unchanged in structure', () => {
    const imp = importProductionScript('Spider-Man est né en 1962. Il a changé les comics.\n\nPuis vint Venom.');
    expect(imp.structured).toBe(false);
    expect(parseScript(imp.markdown).sentences).toHaveLength(3);
  });
});
