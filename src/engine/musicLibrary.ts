/**
 * Music library index: local analysis of the user's own music files, persistent and incremental.
 * - Original files are only read, never written.
 * - A file is re-analysed only when its size or modification time changed; a moved or renamed file is
 *   recognised by its content id (SHA-256 of size + first and last MiB) and keeps its history.
 * - Licences are read from what the files and folders declare; when nothing is declared the licence
 *   is "inconnue" — never guessed.
 * - The index is written atomically (temporary file + rename) and survives interruptions.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { analyzeMusicSignal, classifyMusic, type Energy, type MusicClass, type MusicFeatures, type Mood } from '../production/music';
import { ffmpeg, ffprobe } from './ffmpeg';
import { log } from './log';

export const MUSIC_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.aif', '.aiff', '.wma']);
const SR = 11025;
/** Longer tracks are analysed on their first 8 minutes (stated in the track's record). */
const MAX_ANALYSIS_SEC = 480;
export const MUSIC_INDEX_VERSION = 1;

export type LicenceFamily = 'CC0' | 'CC-BY' | 'CC-BY-SA' | 'CC-BY-NC' | 'CC-BY-ND' | 'libre de droits' | 'propriétaire' | 'autre';

export interface MusicLicence {
  status: 'déclarée' | 'inconnue';
  /** The declared text, as found. */
  text?: string;
  /** Where it was found: tag, file next to the track, folder licence file, or the user. */
  source?: 'métadonnées' | 'fichier voisin' | 'dossier' | 'utilisateur';
  /** Recognised family, only when the declared text names it explicitly. */
  family?: LicenceFamily;
  author?: string;
  url?: string;
}

export interface MusicTrack {
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
  missing?: boolean;
  format: { codec: string | null; sampleRate: number | null; channels: number | null; durationSec: number };
  tags: Record<string, string>;
  title: string;
  artist?: string;
  loudness: { integratedLufs: number | null; lra: number | null; truePeakDb: number | null };
  features: MusicFeatures;
  classification: MusicClass;
  analysedSec: number;
  licence: MusicLicence;
  /** Same content as another indexed file. */
  duplicateOf?: string;
  /** Probably the same music (other encoding/copy): same duration, tempo and brightness. */
  similarTo?: string[];
  /** User corrections: always win over the rules. */
  overrides?: { moods?: Mood[]; energy?: Energy; licence?: Omit<MusicLicence, 'source'> };
  usage: { project: string; at: string; sequence?: string }[];
  analysedAt: string;
  analyser: number;
}

export interface MusicIndex {
  version: number;
  updatedAt: string;
  tracks: Record<string, MusicTrack>;
}

export interface MusicScanResult {
  index: MusicIndex;
  found: number;
  analysed: number;
  reused: number;
  moved: number;
  missing: number;
  failed: { path: string; error: string }[];
  seconds: number;
}

// ---------- index file ----------

export async function loadMusicIndex(file: string): Promise<MusicIndex> {
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8')) as MusicIndex;
    if (j && j.version === MUSIC_INDEX_VERSION && j.tracks) return j;
  } catch {
    /* absent or unreadable: start a new index (the old file is left in place) */
  }
  return { version: MUSIC_INDEX_VERSION, updatedAt: new Date().toISOString(), tracks: {} };
}

export async function saveMusicIndex(file: string, index: MusicIndex) {
  index.updatedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(index));
  await fsp.rename(tmp, file);
}

// ---------- helpers ----------

/** Content id: SHA-256 of size + first and last MiB (fast on large files, stable across moves). */
export async function contentId(file: string, size: number): Promise<string> {
  const h = crypto.createHash('sha256').update(String(size));
  const fd = await fsp.open(file, 'r');
  try {
    const n = Math.min(size, 1 << 20);
    const a = Buffer.alloc(n);
    await fd.read(a, 0, n, 0);
    h.update(a);
    if (size > n) {
      const b = Buffer.alloc(n);
      await fd.read(b, 0, n, size - n);
      h.update(b);
    }
  } finally {
    await fd.close();
  }
  return h.digest('hex').slice(0, 24);
}

async function walk(dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && MUSIC_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

const FAMILIES: [RegExp, LicenceFamily][] = [
  [/\bCC0\b|public domain|domaine public/i, 'CC0'],
  [/\bCC[- ]?BY[- ]?NC\b|non[- ]?commercial/i, 'CC-BY-NC'],
  [/\bCC[- ]?BY[- ]?ND\b|no ?derivatives/i, 'CC-BY-ND'],
  [/\bCC[- ]?BY[- ]?SA\b|share ?alike/i, 'CC-BY-SA'],
  [/\bCC[- ]?BY\b|creative commons attribution/i, 'CC-BY'],
  [/royalty[- ]?free|libre de droits/i, 'libre de droits'],
  [/all rights reserved|tous droits réservés/i, 'propriétaire'],
];
export const licenceFamily = (t: string): LicenceFamily | undefined => FAMILIES.find(([re]) => re.test(t))?.[1];

/** What the track, a file next to it, or its folder declares. Nothing declared → "inconnue". */
export async function readLicence(file: string, tags: Record<string, string>): Promise<MusicLicence> {
  const tag = tags.license ?? tags.licence ?? tags.copyright ?? tags.tcop ?? tags.TCOP;
  const comment = tags.comment ?? '';
  if (tag?.trim()) return { status: 'déclarée', text: tag.trim(), source: 'métadonnées', family: licenceFamily(tag), author: tags.artist };
  if (/licen[cs]e|creative commons|\bCC[- ]?(0|BY)\b|droits/i.test(comment)) return { status: 'déclarée', text: comment.trim(), source: 'métadonnées', family: licenceFamily(comment), author: tags.artist };
  const base = file.replace(/\.[^.]+$/, '');
  for (const side of [`${base}.license.txt`, `${base}.licence.txt`, `${base}.json`, `${base}.txt`]) {
    const txt = await fsp.readFile(side, 'utf8').catch(() => null);
    if (txt == null) continue;
    if (side.endsWith('.json')) {
      try {
        const j = JSON.parse(txt) as Record<string, string>;
        const t = j.license ?? j.licence;
        if (t) return { status: 'déclarée', text: String(t), source: 'fichier voisin', family: licenceFamily(String(t)), author: j.author ?? j.artist, url: j.url ?? j.source };
      } catch {
        /* not a licence file */
      }
      continue;
    }
    if (txt.trim()) return { status: 'déclarée', text: txt.trim().slice(0, 2000), source: 'fichier voisin', family: licenceFamily(txt) };
  }
  for (const n of ['LICENSE', 'LICENSE.txt', 'LICENCE', 'LICENCE.txt', 'licence.txt', 'license.txt', 'LICENSE.md']) {
    const txt = await fsp.readFile(path.join(path.dirname(file), n), 'utf8').catch(() => null);
    if (txt?.trim()) return { status: 'déclarée', text: txt.trim().slice(0, 2000), source: 'dossier', family: licenceFamily(txt) };
  }
  return { status: 'inconnue' };
}

async function probeAudio(file: string) {
  const { stdout } = await ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file], { collectStdout: true });
  const j = JSON.parse(stdout.toString()) as { format?: { duration?: string; tags?: Record<string, string> }; streams?: { codec_name?: string; sample_rate?: string; channels?: number; tags?: Record<string, string> }[] };
  const s = j.streams?.[0];
  if (!s) throw new Error('aucune piste audio');
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(s.tags ?? {}), ...(j.format?.tags ?? {}) })) tags[k.toLowerCase()] = String(v);
  return { codec: s.codec_name ?? null, sampleRate: s.sample_rate ? Number(s.sample_rate) : null, channels: s.channels ?? null, durationSec: Number(j.format?.duration ?? 0), tags };
}

async function loudness(file: string, sec: number) {
  const { stderr } = await ffmpeg(['-v', 'info', '-t', String(sec), '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => {
    const m = re.exec(sum);
    return m ? Number(m[1]) : null;
  };
  return { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

async function decode(file: string, sec: number): Promise<Float32Array> {
  const { stdout } = await ffmpeg(['-v', 'error', '-t', String(sec), '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { collectStdout: true });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.byteLength / 4) * 4));
}

/** Full analysis of one file (read-only). */
export async function analyzeMusicFile(file: string): Promise<Omit<MusicTrack, 'id' | 'usage' | 'mtimeMs' | 'size'>> {
  const fmt = await probeAudio(file);
  const sec = Math.min(MAX_ANALYSIS_SEC, fmt.durationSec || MAX_ANALYSIS_SEC);
  const [loud, pcm] = await Promise.all([loudness(file, sec), decode(file, sec)]);
  const features = analyzeMusicSignal(pcm, SR);
  return {
    path: file,
    format: fmt.codec ? { codec: fmt.codec, sampleRate: fmt.sampleRate, channels: fmt.channels, durationSec: fmt.durationSec } : { codec: null, sampleRate: null, channels: null, durationSec: fmt.durationSec },
    tags: fmt.tags,
    title: fmt.tags.title?.trim() || path.basename(file).replace(/\.[^.]+$/, ''),
    artist: fmt.tags.artist?.trim() || undefined,
    loudness: loud,
    features,
    classification: classifyMusic(features, loud.lra),
    analysedSec: +(pcm.length / SR).toFixed(1),
    licence: await readLicence(file, fmt.tags),
    analysedAt: new Date().toISOString(),
    analyser: MUSIC_INDEX_VERSION,
  };
}

/** Effective view of a track: user corrections win over the rules. */
export function effectiveTrack(t: MusicTrack) {
  const o = t.overrides ?? {};
  return {
    ...t,
    energy: o.energy ?? t.classification.energy,
    moods: o.moods?.length ? o.moods : t.classification.moods.filter((m) => m.score >= 0.4).slice(0, 3).map((m) => m.mood),
    licence: o.licence ? { ...o.licence, source: 'utilisateur' as const } : t.licence,
  };
}

function markSimilar(tracks: MusicTrack[]) {
  for (const t of tracks) delete t.similarTo;
  const live = tracks.filter((t) => !t.missing && !t.duplicateOf);
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!, b = live[j]!;
      const sameLen = Math.abs(a.format.durationSec - b.format.durationSec) <= 0.5;
      const sameTempo = a.features.bpm != null && b.features.bpm != null ? Math.abs(a.features.bpm - b.features.bpm) / a.features.bpm < 0.02 : a.features.bpm === b.features.bpm;
      const sameColour = Math.abs(a.features.centroidHz - b.features.centroidHz) / Math.max(1, a.features.centroidHz) < 0.06;
      if (sameLen && sameTempo && sameColour) {
        (a.similarTo ??= []).push(b.id);
        (b.similarTo ??= []).push(a.id);
      }
    }
}

/**
 * Scans folders and brings the index up to date. Unchanged files are reused; changed files are
 * re-analysed; moved files keep their record (and history); files no longer found are marked
 * `missing` (their history is kept, nothing is deleted).
 */
export async function scanMusicLibrary(dirs: string[], indexFile: string, opts: { signal?: AbortSignal; progress?: (f: number, msg: string) => void; concurrency?: number } = {}): Promise<MusicScanResult> {
  const t0 = Date.now();
  const index = await loadMusicIndex(indexFile);
  const files: string[] = [];
  for (const d of dirs) await walk(d, files);
  files.sort((a, b) => a.localeCompare(b));
  const byPath = new Map(Object.values(index.tracks).map((t) => [t.path, t]));
  const seen = new Set<string>();
  const res: MusicScanResult = { index, found: files.length, analysed: 0, reused: 0, moved: 0, missing: 0, failed: [], seconds: 0 };
  let done = 0;
  let lastSave = Date.now();
  // content ids being analysed right now: an identical copy waits, then is recorded as a duplicate
  const inflight = new Map<string, Promise<void>>();
  const work = async (file: string) => {
    if (opts.signal?.aborted) return;
    try {
      const st = await fsp.stat(file);
      const known = byPath.get(file);
      if (known && known.size === st.size && Math.abs(known.mtimeMs - st.mtimeMs) < 1 && known.analyser === MUSIC_INDEX_VERSION) {
        delete known.missing;
        seen.add(known.id);
        res.reused++;
        return;
      }
      const id = await contentId(file, st.size);
      const pending = inflight.get(id);
      if (pending) await pending.catch(() => {});
      const prev = index.tracks[id];
      if (prev && prev.path !== file && !seen.has(id)) {
        const stillThere = await fsp.stat(prev.path).then((s) => s.size === prev.size).catch(() => false);
        if (!stillThere && prev.analyser === MUSIC_INDEX_VERSION) {
          // moved or renamed: same content, history kept
          Object.assign(prev, { path: file, mtimeMs: st.mtimeMs, missing: undefined });
          seen.add(id);
          res.moved++;
          return;
        }
      }
      if (seen.has(id) || (prev && prev.path !== file)) {
        // identical content already indexed at another place: record the copy, point to the original
        const copyId = crypto.createHash('sha256').update(id + file).digest('hex').slice(0, 24);
        const base = index.tracks[id]!;
        index.tracks[copyId] = { ...base, id: copyId, path: file, size: st.size, mtimeMs: st.mtimeMs, duplicateOf: id, usage: index.tracks[copyId]?.usage ?? [], missing: undefined };
        seen.add(copyId);
        res.reused++;
        return;
      }
      let release!: () => void;
      inflight.set(id, new Promise<void>((r) => (release = r)));
      try {
        const a = await analyzeMusicFile(file);
        // same place, new content: the old record is replaced, its history and corrections carried over
        const old = known && known.id !== id ? known : undefined;
        if (old) delete index.tracks[old.id];
        index.tracks[id] = { ...a, id, size: st.size, mtimeMs: st.mtimeMs, usage: prev?.usage ?? old?.usage ?? [], overrides: prev?.overrides ?? old?.overrides };
        seen.add(id);
        res.analysed++;
      } finally {
        // released only once the record exists, so an identical copy sees it
        inflight.delete(id);
        release();
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      res.failed.push({ path: file, error: (e as Error).message.slice(0, 300) });
      log('warn', 'media', `analyse musicale impossible : ${path.basename(file)}`, { error: (e as Error).message.slice(0, 300) });
    } finally {
      done++;
      opts.progress?.(done / Math.max(1, files.length), `Analyse musicale ${done}/${files.length}`);
      if (Date.now() - lastSave > 5000) {
        // checkpoint: an interrupted scan keeps what was already analysed
        lastSave = Date.now();
        await saveMusicIndex(indexFile, index).catch(() => {});
      }
    }
  };
  const queue = [...files];
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, async () => {
    while (queue.length && !opts.signal?.aborted) await work(queue.shift()!);
  }));
  for (const t of Object.values(index.tracks))
    if (!seen.has(t.id) && !t.missing) {
      t.missing = true;
      res.missing++;
    }
  markSimilar(Object.values(index.tracks));
  await saveMusicIndex(indexFile, index);
  res.seconds = +((Date.now() - t0) / 1000).toFixed(2);
  if (opts.signal?.aborted) throw Object.assign(new Error('Analyse musicale annulée'), { name: 'CancelledError' });
  return res;
}

/** Records that a track was used (repetition checks across videos). */
export async function recordMusicUsage(indexFile: string, id: string, entry: { project: string; sequence?: string }) {
  const index = await loadMusicIndex(indexFile);
  const t = index.tracks[id];
  if (!t) return false;
  t.usage.push({ ...entry, at: new Date().toISOString() });
  if (t.usage.length > 200) t.usage.splice(0, t.usage.length - 200);
  await saveMusicIndex(indexFile, index);
  return true;
}

/** User correction (moods, energy, licence). Pass `null` to remove the corrections. */
export async function setMusicOverride(indexFile: string, id: string, overrides: MusicTrack['overrides'] | null) {
  const index = await loadMusicIndex(indexFile);
  const t = index.tracks[id];
  if (!t) return null;
  if (overrides) t.overrides = { ...t.overrides, ...overrides };
  else delete t.overrides;
  await saveMusicIndex(indexFile, index);
  return effectiveTrack(t);
}
