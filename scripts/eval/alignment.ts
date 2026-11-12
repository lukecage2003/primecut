/**
 * Alignment evaluation against ground truth (reproducible, offline).
 *   sentences <script.pdf|md|txt> <out.json> [maxSentences]   → sentence list for the TTS builder
 *   eval <script> <narration.wav> <truth.json> [words.json] [maxSentences] → error statistics per method
 * Build: npx esbuild scripts/eval/alignment.ts --bundle --platform=node --format=cjs --external:pdfjs-dist
 *        --external:an-array-of-french-words --external:an-array-of-english-words --outfile=.scratch/eval-align.cjs
 */
import fs from 'node:fs';
import { readScriptDocument } from '../../src/engine/scriptFile';
import { analyzeAudio } from '../../src/engine/audioAnalysis';
import { probeMedia } from '../../src/engine/probe';
import { alignByPauses, alignToTranscript, parseScript, speechFromSilences, type AlignmentResult, type ParsedScript } from '../../src/production';

async function load(file: string, max?: number): Promise<ParsedScript> {
  const doc = await readScriptDocument(file);
  const p = parseScript(doc.imported.markdown);
  if (max) p.sentences = p.sentences.slice(0, max);
  return p;
}

function stats(a: AlignmentResult, truth: { index: number; start: number; end: number }[]) {
  const by = new Map(a.sentences.map((s) => [s.index, s]));
  const errs: number[] = [];
  for (const t of truth) {
    const s = by.get(t.index);
    if (s) errs.push(Math.abs(s.start - t.start));
  }
  errs.sort((x, y) => x - y);
  const q = (p: number) => errs[Math.min(errs.length - 1, Math.floor(p * errs.length))] ?? NaN;
  return {
    method: a.method,
    confidence: +a.confidence.toFixed(3),
    sentences: errs.length,
    meanErr: +(errs.reduce((x, y) => x + y, 0) / errs.length).toFixed(3),
    median: +q(0.5).toFixed(3),
    p90: +q(0.9).toFixed(3),
    max: +q(1).toFixed(3),
    within250ms: +(errs.filter((e) => e <= 0.25).length / errs.length).toFixed(3),
    within500ms: +(errs.filter((e) => e <= 0.5).length / errs.length).toFixed(3),
  };
}

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'sentences') {
    const p = await load(a[0]!, a[2] ? Number(a[2]) : undefined);
    const out = p.sentences.map((s, i) => ({ index: s.index, text: s.text, paragraphEnd: p.sentences[i + 1]?.paragraph !== s.paragraph }));
    fs.writeFileSync(a[1]!, JSON.stringify(out));
    console.log(`${out.length} sentences`);
  } else if (cmd === 'eval') {
    const [script, wav, truthFile, wordsFile, max] = a;
    const p = await load(script!, max ? Number(max) : undefined);
    const truth = JSON.parse(fs.readFileSync(truthFile!, 'utf8'));
    const { probe } = await probeMedia(wav!);
    const t0 = Date.now();
    const an = await analyzeAudio(wav!);
    const pauses = alignByPauses(p.sentences, speechFromSilences(an.silences, probe.durationSec));
    const res: Record<string, unknown> = { durationSec: +probe.durationSec.toFixed(1), analysisMs: Date.now() - t0, pauses: stats(pauses, truth) };
    if (wordsFile && wordsFile !== '-') {
      const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8')).words;
      const t1 = Date.now();
      const tr = alignToTranscript(p.sentences, words, speechFromSilences(an.silences, probe.durationSec));
      res.transcript = { ...stats(tr, truth), alignMs: Date.now() - t1, recognisedWords: words.length };
    }
    console.log(JSON.stringify(res, null, 1));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
