/**
 * Built-in transcription (whisper.cpp, no Python). The real recognition test needs an official ggml
 * model (PRIMESTONE_WHISPER_MODEL, SHA-1 checked by CI) and espeak-ng for French speech; without them
 * only the real invocation of the bundled binary is checked.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTranscriber, setBundledWhisperCli, transcribe } from '../../src/engine/transcribe';
import { alignToTranscript, parseScript } from '../../src/production';
import { tmpDir } from './fixtures';

const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const cli = process.env.PRIMESTONE_WHISPER_CLI ?? path.resolve('vendor/whisper', exe);
const model = process.env.PRIMESTONE_WHISPER_MODEL;
const hasEspeak = (() => {
  try {
    execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!fs.existsSync(cli))('built-in whisper.cpp', () => {
  it('the bundled engine is found and answers', async () => {
    setBundledWhisperCli(cli);
    const dir = tmpDir('ps-wcpp-');
    const fakeModel = path.join(dir, 'm.bin');
    fs.writeFileSync(fakeModel, 'x');
    const r = await checkTranscriber({ enabled: true, backend: 'whisper.cpp', modelPath: fakeModel, language: 'fr', device: 'auto' });
    expect(r).toMatchObject({ ok: true });
    expect(r.detail).toMatch(/whisper\.cpp prêt \(intégré\)/);
  });

  it.skipIf(!model || !hasEspeak)('transcribes French speech with word timings that align with the script', async () => {
    setBundledWhisperCli(cli);
    const dir = tmpDir('ps-wcpp-');
    const text = 'Spider-Man affronte le Bouffon Vert au-dessus de New York. Peter Parker comprend enfin que son ennemi connaît son secret. Le combat dure toute la nuit.';
    const wav = path.join(dir, 'voix.wav');
    execFileSync('espeak-ng', ['-v', 'fr', '-s', '150', '-w', wav, text]);
    const progress: number[] = [];
    const r = await transcribe(wav, { enabled: true, backend: 'whisper.cpp', modelPath: model!, language: 'fr', device: 'auto' }, path.join(dir, 'Cache'), { progress: (f) => progress.push(f) });
    expect(r.engine).toMatch(/whisper\.cpp/);
    // word timings are increasing and inside the file
    r.words.forEach((w, i) => {
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      if (i) expect(w.start).toBeGreaterThanOrEqual(r.words[i - 1]!.start - 0.01);
    });
    // alignment with the script: most sentences recognised (espeak is a robotic voice)
    const a = alignToTranscript(parseScript(text).sentences, r.words);
    expect(a.confidence).toBeGreaterThanOrEqual(0.66);
    expect(progress.length).toBeGreaterThan(0);
    console.log('whisper.cpp words:', r.words.map((w) => w.text).join(' '), '| confidence', a.confidence, '|', r.seconds, 's');
  }, 300000);
});
