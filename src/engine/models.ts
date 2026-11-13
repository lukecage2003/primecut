/**
 * Local AI model manager. Nothing is downloaded unless the user asks for a specific model in the UI
 * (size, source and licence are shown first). Downloads go to a `.part` file, resume after an
 * interruption (HTTP Range), are checked against the SHA-1 published by the model's authors, and are
 * only then renamed into place. A model already on disk can be registered instead (same check).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';

export interface ModelEntry {
  id: string;
  kind: 'whisper-ggml';
  label: string;
  file: string;
  sizeBytes: number;
  /** SHA-1 published in whisper.cpp models/README.md. */
  sha1: string;
  url: string;
  license: string;
  source: string;
  note: string;
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const W = (id: string, label: string, mib: number, sha1: string, note: string): ModelEntry => ({
  id: `whisper-${id}`,
  kind: 'whisper-ggml',
  label,
  file: `ggml-${id}.bin`,
  sizeBytes: Math.round(mib * 1024 * 1024),
  sha1,
  url: `${HF}/ggml-${id}.bin`,
  license: 'MIT (poids OpenAI Whisper, conversion ggml whisper.cpp)',
  source: 'huggingface.co/ggerganov/whisper.cpp',
  note,
});

/** Multilingual models only (French narration). SHA-1 values from whisper.cpp models/README.md. */
export const MODEL_CATALOG: ModelEntry[] = [
  W('base', 'Whisper base (rapide)', 142, '465707469ff3a37a2b9b8d8f89f2f99de7299dac', 'Le plus léger utilisable en français ; précision moyenne.'),
  W('small', 'Whisper small (recommandé)', 466, '55356645c2b361a969dfd0ef2c5a50d530afd8d5', 'Bon équilibre précision / vitesse, y compris sans carte graphique.'),
  W('large-v3-turbo-q5_0', 'Whisper large-v3 turbo, compressé', 547, 'e050f7970618a659205450ad97eb95a18d69c9ee', 'Le plus précis de la liste ; plus lent sans carte graphique.'),
  W('medium', 'Whisper medium', 1536, 'fd9727b6e1217c2f614f9b698455c4ffd82463b4', 'Très précis, lourd (1,5 Go) ; carte graphique conseillée.'),
];

export interface ModelStatus {
  id: string;
  path: string;
  present: boolean;
  verified: boolean;
  partialBytes: number;
}

export function modelPath(dir: string, m: ModelEntry) {
  return path.join(dir, m.kind, m.file);
}

export async function sha1File(file: string, signal?: AbortSignal): Promise<string> {
  const h = crypto.createHash('sha1');
  await new Promise<void>((res, rej) => {
    const s = fs.createReadStream(file, { highWaterMark: 4 << 20 });
    signal?.addEventListener('abort', () => s.destroy(new Error('Annulé')), { once: true });
    s.on('data', (d) => h.update(d)).on('end', () => res()).on('error', rej);
  });
  return h.digest('hex');
}

/** Status of every catalogue model (a `.verified` marker records a successful SHA-1 check). */
export async function modelStatus(dir: string): Promise<ModelStatus[]> {
  return Promise.all(
    MODEL_CATALOG.map(async (m) => {
      const p = modelPath(dir, m);
      const st = await fsp.stat(p).catch(() => null);
      const part = await fsp.stat(`${p}.part`).catch(() => null);
      const marker = await fsp.readFile(`${p}.verified`, 'utf8').catch(() => '');
      return { id: m.id, path: p, present: !!st, verified: !!st && marker.trim() === `${m.sha1} ${st.size}`, partialBytes: part?.size ?? 0 };
    }),
  );
}

function get(url: string, headers: Record<string, string>, signal?: AbortSignal, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((res, rej) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'PrimestoneMotionStudio', ...headers } }, (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume();
        return get(new URL(r.headers.location, url).toString(), headers, signal, redirects - 1).then(res, rej);
      }
      res(r);
    });
    req.on('error', rej);
    signal?.addEventListener('abort', () => req.destroy(new Error('Annulé')), { once: true });
  });
}

/**
 * Downloads a catalogue model (resumable). Rejects, deleting the file, if the SHA-1 does not match.
 * `url` can be overridden (tests, mirrors chosen by the user); the checksum never can.
 */
export async function downloadModel(dir: string, id: string, opts: DownloadOptions = {}): Promise<string> {
  const m = MODEL_CATALOG.find((x) => x.id === id);
  if (!m) throw new Error(`Modèle inconnu : ${id}`);
  return downloadEntry(dir, m, opts);
}

export interface DownloadOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  url?: string;
}

/** Download + SHA-1 check of one entry (exported for tests with a local server). */
export async function downloadEntry(dir: string, m: ModelEntry, opts: DownloadOptions = {}): Promise<string> {
  const dest = modelPath(dir, m);
  const part = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const have = (await fsp.stat(part).catch(() => null))?.size ?? 0;
  const r = await get(opts.url ?? m.url, have ? { Range: `bytes=${have}-` } : {}, opts.signal);
  if (r.statusCode !== 200 && r.statusCode !== 206) {
    r.resume();
    throw new Error(`Téléchargement refusé par le serveur (HTTP ${r.statusCode})`);
  }
  const resumed = r.statusCode === 206 && have > 0;
  const total = resumed ? have + Number(r.headers['content-length'] ?? 0) : Number(r.headers['content-length'] ?? m.sizeBytes);
  let done = resumed ? have : 0;
  await new Promise<void>((res, rej) => {
    const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    r.on('data', (d: Buffer) => {
      done += d.length;
      opts.onProgress?.(done, total);
    });
    r.on('error', rej);
    out.on('error', rej);
    out.on('finish', () => res());
    r.pipe(out);
    opts.signal?.addEventListener('abort', () => {
      r.destroy();
      out.close();
      rej(new Error('Annulé (le téléchargement reprendra où il s’est arrêté)'));
    }, { once: true });
  });
  if (total > 0 && done < total) throw new Error(`Téléchargement interrompu (${Math.round((100 * done) / total)} %) : il reprendra où il s’est arrêté`);
  const sum = await sha1File(part, opts.signal);
  if (sum !== m.sha1) {
    await fsp.rm(part, { force: true });
    throw new Error(`Fichier corrompu ou différent de l’original (SHA-1 ${sum.slice(0, 12)}… au lieu de ${m.sha1.slice(0, 12)}…) : supprimé`);
  }
  await fsp.rename(part, dest);
  await fsp.writeFile(`${dest}.verified`, `${m.sha1} ${(await fsp.stat(dest)).size}`);
  return dest;
}

/** Registers a model file the user already has (copied into the models folder after the SHA-1 check). */
export async function importModelFile(dir: string, id: string, file: string, signal?: AbortSignal): Promise<string> {
  const m = MODEL_CATALOG.find((x) => x.id === id);
  if (!m) throw new Error(`Modèle inconnu : ${id}`);
  const sum = await sha1File(file, signal);
  if (sum !== m.sha1) throw new Error(`Ce fichier n’est pas le modèle ${m.label} officiel (SHA-1 différent).`);
  const dest = modelPath(dir, m);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (path.resolve(file) !== path.resolve(dest)) await fsp.copyFile(file, `${dest}.part`).then(() => fsp.rename(`${dest}.part`, dest));
  await fsp.writeFile(`${dest}.verified`, `${m.sha1} ${(await fsp.stat(dest)).size}`);
  return dest;
}

export async function removeModel(dir: string, id: string): Promise<void> {
  const m = MODEL_CATALOG.find((x) => x.id === id);
  if (!m) return;
  const p = modelPath(dir, m);
  for (const f of [p, `${p}.part`, `${p}.verified`]) await fsp.rm(f, { force: true });
}
