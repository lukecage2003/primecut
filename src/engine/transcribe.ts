/**
 * Local speech recognition (word timestamps) through an optional sidecar. Nothing is downloaded or
 * sent anywhere: the user points Primestone at an engine and a model that already exist on disk
 * (or downloads one explicitly from Settings, after seeing its source, size and licence).
 *
 * Backends
 * - `faster-whisper`: Python + faster-whisper (MIT) running tools/transcribe/faster_whisper_words.py
 *   with a CTranslate2 Whisper model directory. Verified end-to-end in development.
 * - `whisper.cpp`: the whisper.cpp CLI (MIT, no Python; CUDA builds for NVIDIA GPUs) with a ggml
 *   model file, run with one word per segment (`-ml 1 -sow`) and JSON output.
 *
 * Results are cached per (narration fingerprint, engine, model, language) in Cache/transcripts.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RecognisedWord } from '../production';
import { ffmpeg } from './ffmpeg';

export type TranscriberBackend = 'faster-whisper' | 'whisper.cpp';

export interface TranscriberConfig {
  enabled: boolean;
  backend: TranscriberBackend;
  /** faster-whisper: Python interpreter that has `faster_whisper` installed. */
  pythonPath?: string;
  /** whisper.cpp: path to `whisper-cli` (or `main` in older releases). */
  whisperCppPath?: string;
  /** Model directory (faster-whisper) or ggml .bin file (whisper.cpp). */
  modelPath?: string;
  language: string;
  /** 'auto' | 'cpu' | 'cuda' (faster-whisper); whisper.cpp uses the GPU its build supports. */
  device: 'auto' | 'cpu' | 'cuda';
  threads?: number;
  /** Use the most accurate whisper.cpp model present next to the chosen one that this computer can run (default true). */
  autoModel?: boolean;
}

/**
 * The most accurate ggml model present beside the configured one that this computer can run in reasonable
 * time: medium (or large-v3-turbo) from 6 processor threads, small otherwise. Never downloads anything.
 * Measured here: on 62 s of French narration, medium fixed every proper-name error small made
 * ("Cypher ou Doug Ramsey", "Horsemen", "Death Seeds", "Archangel") for about 1× real time on 16 threads.
 */
export function bestModel(cfg: TranscriberConfig, threads = os.cpus().length): { path: string | undefined; note: string | null } {
  if (!cfg.modelPath || cfg.backend !== 'whisper.cpp' || cfg.autoModel === false) return { path: cfg.modelPath, note: null };
  const dir = path.dirname(cfg.modelPath);
  const ranked = threads >= 6 ? ['ggml-large-v3-turbo-q5_0.bin', 'ggml-medium.bin', 'ggml-small.bin'] : ['ggml-small.bin', 'ggml-base.bin'];
  const current = path.basename(cfg.modelPath);
  for (const name of ranked) {
    if (name === current) return { path: cfg.modelPath, note: null };
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { path: p, note: `modèle ${name.replace(/^ggml-|\.bin$/g, '')} choisi automatiquement (plus précis, ${threads} cœurs disponibles)` };
  }
  return { path: cfg.modelPath, note: null };
}

export const DEFAULT_TRANSCRIBER: TranscriberConfig = { enabled: false, backend: 'whisper.cpp', language: 'fr', device: 'auto' };

let bundledCli: string | null = null;
/** whisper-cli shipped with the application (set by the host at start-up). */
export function setBundledWhisperCli(p: string | null) {
  bundledCli = p && fs.existsSync(p) ? p : null;
}
export function bundledWhisperCli() {
  return bundledCli;
}
const whisperCli = (cfg: TranscriberConfig) => cfg.whisperCppPath || bundledCli;

export interface TranscriptResult {
  engine: string;
  model: string;
  language: string;
  words: RecognisedWord[];
  cached: boolean;
  seconds: number;
}

export interface EngineCheck {
  ok: boolean;
  detail: string;
}

function runProcess(cmd: string, args: string[], opts: { signal?: AbortSignal; onLine?: (l: string) => void; timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    let err = '';
    let buf = '';
    const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : null;
    const abort = () => p.kill();
    opts.signal?.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      out += s;
      buf += s;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) opts.onLine?.(l);
    });
    let ebuf = '';
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      err += s;
      // whisper.cpp reports its progress on stderr
      ebuf += s;
      const lines = ebuf.split(/\r?\n/);
      ebuf = lines.pop() ?? '';
      for (const l of lines) opts.onLine?.(l);
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (opts.signal?.aborted) reject(new Error('Cancelled'));
      else resolve({ code: code ?? -1, out, err });
    });
  });
}

/** Path of the bundled sidecar script (dev tree or packaged resources). */
export function sidecarScript(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'transcribe', 'faster_whisper_words.py'),
    path.join(__dirname, '..', '..', 'tools', 'transcribe', 'faster_whisper_words.py'),
    path.join(process.cwd(), 'tools', 'transcribe', 'faster_whisper_words.py'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates.at(-1)!;
}

/** Read-only check that the configured engine and model are usable. Never installs anything. */
export async function checkTranscriber(cfg: TranscriberConfig): Promise<EngineCheck> {
  if (!cfg.modelPath || !fs.existsSync(cfg.modelPath)) return { ok: false, detail: 'Aucun modèle choisi (ou fichier introuvable).' };
  try {
    if (cfg.backend === 'faster-whisper') {
      if (!fs.existsSync(path.join(cfg.modelPath, 'model.bin'))) return { ok: false, detail: 'The model folder must contain a CTranslate2 model.bin (faster-whisper format).' };
      const py = cfg.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
      const r = await runProcess(py, ['-c', 'import faster_whisper, ctranslate2; print(faster_whisper.__version__, ctranslate2.get_cuda_device_count())'], { timeoutMs: 30000 });
      if (r.code !== 0) return { ok: false, detail: `Python cannot import faster_whisper (${r.err.trim().split('\n').at(-1) ?? 'error'}). Install it with: ${py} -m pip install faster-whisper` };
      const [ver, cuda] = r.out.trim().split(/\s+/);
      return { ok: true, detail: `faster-whisper ${ver} · CUDA devices: ${cuda ?? '0'}` };
    }
    const cli = whisperCli(cfg);
    if (!cli || !fs.existsSync(cli)) return { ok: false, detail: 'Moteur whisper.cpp introuvable (réinstallez Primestone ou indiquez whisper-cli).' };
    const r = await runProcess(cli, ['--help'], { timeoutMs: 15000 });
    const txt = r.out + r.err;
    if (!/--output-json|-oj/.test(txt)) return { ok: false, detail: 'Ce programme ne ressemble pas à whisper.cpp (pas de sortie JSON).' };
    return { ok: true, detail: `whisper.cpp prêt${cli === bundledCli ? ' (intégré)' : ''}${/cuda|cublas/i.test(txt) ? ' · carte graphique' : ' · processeur'}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** Parses whisper.cpp JSON (`-oj`, one word per segment with `-ml 1 -sow`). */
export function parseWhisperCppJson(json: unknown): RecognisedWord[] {
  const segs = (json as { transcription?: { offsets?: { from: number; to: number }; text?: string }[] }).transcription ?? [];
  const words: RecognisedWord[] = [];
  for (const s of segs) {
    const text = (s.text ?? '').trim();
    if (!text || !s.offsets || /^\[.*\]$/.test(text)) continue;
    const w = { text, start: s.offsets.from / 1000, end: s.offsets.to / 1000 };
    // word pieces without a leading space belong to the previous word
    if (words.length && !/^\s/.test(s.text ?? '') && /^[\p{Ll}'’-]/u.test(text)) {
      const p = words.at(-1)!;
      p.text += text;
      p.end = w.end;
    } else words.push(w);
  }
  return words;
}

export async function transcribe(
  audioPath: string,
  cfg: TranscriberConfig,
  cacheDir: string,
  opts: { signal?: AbortSignal; progress?: (f: number) => void; prompt?: string; fingerprint?: string } = {},
): Promise<TranscriptResult> {
  if (!cfg.modelPath) throw new Error('aucun modèle de transcription choisi');
  const t0 = Date.now();
  const key = crypto
    .createHash('sha256')
    .update(JSON.stringify([opts.fingerprint ?? audioPath, cfg.backend, path.basename(cfg.modelPath), cfg.language, opts.prompt ?? '']))
    .digest('hex')
    .slice(0, 24);
  const dir = path.join(cacheDir, 'transcripts');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${key}.json`);
  if (fs.existsSync(out)) {
    const j = JSON.parse(await fsp.readFile(out, 'utf8'));
    return { ...j, cached: true, seconds: 0 };
  }
  // decode once to 16 kHz mono PCM: both engines read it without extra codecs
  const wav = path.join(dir, `${key}.16k.wav`);
  await ffmpeg(['-v', 'error', '-y', '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: opts.signal });
  try {
    let words: RecognisedWord[];
    let engine: string;
    const raw = path.join(dir, `${key}.raw.json`);
    if (cfg.backend === 'faster-whisper') {
      const py = cfg.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
      const args = [sidecarScript(), '--model', cfg.modelPath, '--audio', wav, '--out', raw, '--language', cfg.language, '--device', cfg.device];
      if (cfg.device === 'cpu') args.push('--compute-type', 'int8');
      if (cfg.threads) args.push('--threads', String(cfg.threads));
      if (opts.prompt) args.push('--initial-prompt', opts.prompt);
      const r = await runProcess(py, args, { signal: opts.signal, onLine: (l) => (l.startsWith('PROGRESS ') ? opts.progress?.(Number(l.slice(9))) : undefined) });
      if (r.code !== 0) throw new Error(`Transcription failed: ${r.err.trim().split('\n').slice(-3).join(' ')}`);
      const j = JSON.parse(await fsp.readFile(raw, 'utf8'));
      words = j.words;
      engine = `faster-whisper (${j.model})`;
    } else {
      const cli = whisperCli(cfg);
      if (!cli) throw new Error('Moteur whisper.cpp introuvable');
      const base = raw.replace(/\.json$/, '');
      const args = ['-m', cfg.modelPath, '-f', wav, '-l', cfg.language, '-ml', '1', '-sow', '-oj', '-of', base, '-pp'];
      if (cfg.threads) args.push('-t', String(cfg.threads));
      if (opts.prompt) args.push('--prompt', opts.prompt);
      const r = await runProcess(cli, args, {
        signal: opts.signal,
        onLine: (l) => {
          const m = /progress\s*=\s*(\d+)%/.exec(l);
          if (m) opts.progress?.(Number(m[1]) / 100);
        },
      });
      if (r.code !== 0) throw new Error(`échec de whisper.cpp : ${r.err.trim().split('\n').slice(-3).join(' ')}`);
      words = parseWhisperCppJson(JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')));
      engine = `whisper.cpp (${path.basename(cfg.modelPath)})`;
    }
    if (!words.length) throw new Error('la reconnaissance n’a renvoyé aucun mot');
    const result = { engine, model: path.basename(cfg.modelPath), language: cfg.language, words };
    await fsp.writeFile(out, JSON.stringify(result));
    return { ...result, cached: false, seconds: (Date.now() - t0) / 1000 };
  } finally {
    await fsp.rm(wav, { force: true });
  }
}
