import { describe, expect, it } from 'vitest';
import { parseWhisperCppJson } from '../../src/engine/transcribe';
import { alignToTranscript, parseScript } from '../../src/production';

/** Recognised words with a constant speaking rate; sentence k starts at k * 4 s. */
function synth(sentences: string[], opts: { drop?: (si: number, wi: number) => boolean; garble?: (si: number, wi: number) => boolean } = {}) {
  const words: { text: string; start: number; end: number }[] = [];
  sentences.forEach((s, si) => {
    s.split(' ').forEach((w, wi) => {
      if (opts.drop?.(si, wi)) return;
      words.push({ text: opts.garble?.(si, wi) ? 'xyz' : w, start: si * 4 + wi * 0.3, end: si * 4 + wi * 0.3 + 0.25 });
    });
  });
  return words;
}

describe('transcript alignment', () => {
  const sentences = ['Spider-Man affronte le Bouffon Vert à New York.', 'Gwen Stacy tombe du pont.', 'Peter ne sera plus jamais le même.'];
  const script = parseScript(sentences.join(' '));

  it('uses misrecognised words in place and snaps sentence starts to real speech onsets', () => {
    const rec = synth(sentences, { garble: (si, wi) => si === 1 && wi === 0 }).map((w) => ({ ...w, start: w.start - 0.25 })); // recogniser is early
    const speech = sentences.map((s, si) => ({ start: si * 4, end: si * 4 + s.split(' ').length * 0.3 }));
    const a = alignToTranscript(script.sentences, rec, speech);
    expect(a.sentences.map((s) => +s.start.toFixed(2))).toEqual([0, 4, 8]);
  });

  it('lays words the recogniser missed over the speech of their gap, not over the pause', () => {
    // the whole start of sentence 2 was not recognised
    const rec = synth(sentences, { drop: (si, wi) => si === 2 && wi < 4 });
    const speech = sentences.map((s, si) => ({ start: si * 4, end: si * 4 + s.split(' ').length * 0.3 }));
    const a = alignToTranscript(script.sentences, rec, speech);
    expect(Math.abs(a.sentences[2]!.start - 8)).toBeLessThan(0.15);
    const noAudio = alignToTranscript(script.sentences, rec);
    expect(Math.abs(noAudio.sentences[2]!.start - 8)).toBeLessThan(0.6); // without audio: per-word estimate
  });

  it('aligns a 90-minute-scale narration with bounded memory and time', () => {
    const many: string[] = [];
    for (let i = 0; i < 1600; i++) many.push(`Phrase numéro ${i} raconte un événement important du comic ${i % 37} avec Thor et Loki.`);
    const sc = parseScript(many.join(' '));
    const rec = synth(many, { drop: (si, wi) => si % 50 === 3 && wi < 6 }); // ~15k words, a few gaps
    const t0 = Date.now();
    const a = alignToTranscript(sc.sentences, rec);
    expect(Date.now() - t0).toBeLessThan(5000);
    const bad = a.sentences.filter((s, i) => Math.abs(s.start - i * 4) > 0.6).length;
    expect(bad / a.sentences.length).toBeLessThan(0.05);
  });

  it('parses whisper.cpp JSON with one word per segment', () => {
    const j = {
      transcription: [
        { offsets: { from: 0, to: 320 }, text: ' Batman' },
        { offsets: { from: 320, to: 500 }, text: ' gagne' },
        { offsets: { from: 500, to: 610 }, text: 'ait' },
        { offsets: { from: 700, to: 900 }, text: ' [MUSIC]' },
      ],
    };
    expect(parseWhisperCppJson(j)).toEqual([
      { text: 'Batman', start: 0, end: 0.32 },
      { text: 'gagneait', start: 0.32, end: 0.61 },
    ]);
  });
});

describe('implausible lone matches', () => {
  it('drops a frequent word paired with a far occurrence when the recogniser skipped a passage', async () => {
    const { dropImplausibleMatches } = await import('../../src/production');
    // script words 0..29; recognised words: two reliable runs, and a lone "batman" 9 s late
    const words = Array.from({ length: 30 }, (_, k) => (k === 12 || k === 20 ? 'batman' : `w${k}`));
    const rec = Array.from({ length: 40 }, (_, j) => ({ start: j * 0.4 }));
    const match: (number | null)[] = new Array(30).fill(null);
    for (let k = 0; k < 5; k++) match[k] = k; // 0..1.6 s
    for (let k = 25; k < 30; k++) match[k] = k + 5; // 12..13.6 s
    match[12] = 32; // "batman" of word 20 heard at 12.8 s, given to word 12 (expected ≈ 6.4 s)
    match[22] = 26; // a unique word at the right time stays
    dropImplausibleMatches(match, rec, words);
    expect(match[12]).toBeNull();
    expect(match[22]).toBe(26);
  });
});

describe('speech that is not in the script', () => {
  it('reports an outtake at the end of the recording as off-script speech', async () => {
    const { alignToTranscript, parseScript } = await import('../../src/production');
    const script = parseScript('Peter Parker est mordu par une araignée radioactive. Il signe avec Oscorp et il rentre.');
    const said = 'Peter Parker est mordu par une araignée radioactive il signe avec Oscorp et il rentre oh lala mais ça commence à m énerver franchement'.split(' ');
    const rec = said.map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.35 }));
    const a = alignToTranscript(script.sentences, rec);
    expect(a.offScript).toHaveLength(1);
    expect(a.offScript![0]!.text).toMatch(/^oh lala/);
    expect(a.offScript![0]!.start).toBeCloseTo(15 * 0.4, 5);
    expect(a.sentences.at(-1)!.end).toBeLessThan(a.offScript![0]!.start);
  });
});
