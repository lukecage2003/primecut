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
