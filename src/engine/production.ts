/**
 * Script-to-Video production pipeline (engine side): analyses the narration, indexes the media the
 * user provided, plans and builds the edit, runs QC with automatic fixes, and returns a new
 * sequence plus a full report. Each stage reports progress through the TaskOrchestrator.
 */
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type MediaAsset, type Project, type Sequence, type SequenceSettings, framesToSeconds, secondsToFrames } from '../core';
import {
  type AlignmentResult,
  type ProductionPreferences,
  type RecognisedWord,
  alignByPauses,
  alignToTranscript,
  autoFix,
  buildSequence,
  measureStyle,
  parseScript,
  runQc,
  speechFromSilences,
  importProductionScript,
  isCanonicalScript,
} from '../production';
import { loadDictionary } from './scriptFile';
import { analyzeAudio, analyzeNarration } from './audioAnalysis';
import { fingerprintFile, importMediaFile } from './media';
import { cleanVoice, renderTightened } from './voice';
import { ARCHIVE_EXT, extractComicArchive } from './archive';
import { extractComicPdf, isComicPdf, pdfTextDensity } from './comicPdf';
import { planTighten, remapTime } from '../production/pauses';
import { cutsFromKeep, detectDisfluencies, keepFromCuts, untranscribedSounds, wordsAfterCuts } from '../production/disfluency';
import { scriptFromTranscript } from '../production/transcriptScript';
import { applyVocabulary } from '../production/vocabulary';
import { NARRATION_KINDS, type NarrationKind, detectNarrationFormat, directionFor, rankCard } from '../production/narrationFormat';
import type { VoiceQuality } from '../production/voiceChain';
import { renderGenerator } from './generators';
import { renderSfx } from './sfx';
import { probeMedia } from './probe';
import { ffmpeg } from './ffmpeg';
import { classifyComicImage, dHash, detectPanelsDetailed, orderPanels, newId, type EditDecisionGraph, rebindGraph } from '../core';
import { analyseNarrative } from '../production/narrative';
import { type MusicCandidate, type MusicSegment, planMusic } from '../production/musicPlan';
import { effectiveTrack, loadMusicIndex, recordMusicUsage } from './musicLibrary';
import { reviewQc } from '../production/qc';
import { IMAGE_ANALYSER, type MediaIndex, type MediaIndexEntry, entryForPath, loadMediaIndex, markMissing, saveMediaIndex } from './mediaIndex';
import { type OcrConfig, findTesseract, ocrComicPage, ocrImage } from './ocr';
import { planPCoreV2 } from './pcore';
import { type FetchLike, fetchWebImages, loadWebRights, webQueries } from './webImages';
import { type PCoreV2Settings, resolveV2 } from '../pcore/v2/config';
import type { PCoreCue } from '../pcore/v2/director';

/** Decodes a page at low resolution and runs panel detection (XY-cut on gutters). */
export async function detectPagePanels(file: string, w: number, h: number, signal?: AbortSignal) {
  // tall strips (webtoons) keep enough vertical resolution to find their gutters
  const W = w / h <= 0.45 ? 200 : 400;
  const H = Math.max(2, Math.min(4000, Math.round((W * h) / w / 2) * 2));
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'], { collectStdout: true, signal });
  const d = detectPanelsDetailed(new Uint8Array(stdout.buffer, stdout.byteOffset, W * H), W, H);
  return { panels: d.panels.length >= 2 ? d.panels : undefined, confidence: d.panels.length >= 2 ? d.confidence : undefined, ink: d.ink, flat: d.flat, balloons: d.balloons };
}

/** Perceptual fingerprint of a picture (dHash on a 9×8 grey thumbnail). */
export async function imageFingerprint(file: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true, signal });
  if (stdout.byteLength < 72) throw new Error('vignette incomplète');
  // + average colour: a recoloured variant of a cover is a different picture
  const c = await ffmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true, signal });
  const rgb = [...c.stdout.subarray(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${dHash(new Uint8Array(stdout.buffer, stdout.byteOffset, 72))}:${rgb}`;
}

/** Mean colour saturation (0..1) of a 48×48 thumbnail: black & white pages are near 0. */
export async function imageSaturation(file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=48:48,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true, signal });
  let acc = 0;
  const n = Math.floor(stdout.byteLength / 3);
  for (let i = 0; i < n; i++) {
    const r = stdout[i * 3]!, g = stdout[i * 3 + 1]!, b = stdout[i * 3 + 2]!;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    acc += mx === 0 ? 0 : (mx - mn) / mx;
  }
  return n ? acc / n : 0;
}

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.mp4', '.mov', '.mkv', '.webm', '.m4v']);

export interface ScanResult {
  assets: MediaAsset[];
  errors: { path: string; error: string }[];
  /** Index statistics: reused as is, re-analysed, recognised after a move, no longer found, read by OCR. */
  stats: { reused: number; analysed: number; moved: number; missing: number; ocr: number; ocrUnavailable?: string };
}

export interface ScanOptions {
  /** Persistent media index (analyses reused across scans and projects). */
  indexFile?: string;
  /** Optional local OCR (Tesseract installed by the user). */
  ocr?: OcrConfig;
  progress?: (f: number, msg: string) => void;
}

async function readSidecars(f: string) {
  const tags: string[] = [];
  for (const side of [`${f}.tags.txt`, f.replace(/\.[^.]+$/, '.tags.txt')]) {
    if (fs.existsSync(side)) tags.push(...(await fsp.readFile(side, 'utf8')).split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
  }
  const json = f.replace(/\.[^.]+$/, '.json');
  let rights: MediaAsset['rights'] = { usage: 'user-provided', source: 'user-library', checkedAt: new Date().toISOString(), note: 'Provided by the user, who is responsible for usage rights.' };
  let description: string | undefined;
  if (fs.existsSync(json)) {
    try {
      const j = JSON.parse(await fsp.readFile(json, 'utf8'));
      if (Array.isArray(j.tags)) tags.push(...j.tags.map(String));
      if (typeof j.description === 'string' && j.description.trim()) description = j.description.trim();
      if (j.rights && typeof j.rights.usage === 'string') rights = { ...rights, ...j.rights, checkedAt: new Date().toISOString() };
    } catch {
      /* invalid sidecar ignored */
    }
  }
  return { tags, rights, description };
}

/** Image analyses: panels (+ confidence), saturation, perceptual fingerprint, comics format. */
async function analyseImage(a: MediaAsset, signal?: AbortSignal) {
  const v = a.probe.video;
  if (a.kind !== 'image' || !v) return;
  const ar = v.width / v.height;
  let flat: number | undefined;
  let balloons: number | undefined;
  // every picture is measured (a near-square back-cover ad must be recognised too); near-square pictures
  // keep their panels only when they really are pages (2+ panels found with confidence)
  {
    const d = await detectPagePanels(a.path, v.width, v.height, signal).catch(() => undefined);
    a.panels = d?.panels;
    a.panelConfidence = d?.confidence;
    flat = d?.flat;
    balloons = d?.balloons;
  }
  const sat = await imageSaturation(a.path, signal).catch(() => null);
  a.phash = await imageFingerprint(a.path, signal).catch(() => undefined);
  a.comic = classifyComicImage({ width: v.width, height: v.height, panels: a.panels && (a.panelConfidence ?? 1) >= 0.8 ? a.panels : a.panels?.slice(0, 2), saturation: sat, name: a.name, flat, balloons, pageNumber: a.page?.n });
  // a title or credits page is never cut into "panels"
  if (a.comic.format === 'générique') ((a.panels = undefined), (a.panelConfidence = undefined));
  if (ar >= 0.87 && ar < 1.25 && !(a.panels && a.panels.length >= 2 && (a.panelConfidence ?? 0) >= 0.8)) ((a.panels = undefined), (a.panelConfidence = undefined));
  if (a.comic) a.comic = { ...a.comic, balloons, flat };
  // a wide picture is only read panel by panel when it really is a spread (3+ panels)
  if (ar >= 1.25 && a.comic.format !== 'double-page') ((a.panels = undefined), (a.panelConfidence = undefined));
  if (a.panels && a.comic.readingOrder === 'rtl') a.panels = orderPanels(a.panels, 'rtl');
}

function fromEntry(e: MediaIndexEntry, file: string, projectDir: string): MediaAsset {
  return {
    id: newId(),
    name: path.basename(file),
    kind: e.kind,
    path: file,
    relativePath: path.relative(projectDir, file),
    fingerprint: { size: e.size, mtimeMs: e.mtimeMs, partialHash: e.hash },
    probe: e.probe,
    importedAt: new Date().toISOString(),
    ...(e.panels ? { panels: e.panels } : {}),
    ...(e.panelConfidence !== undefined ? { panelConfidence: e.panelConfidence } : {}),
    ...(e.phash ? { phash: e.phash } : {}),
    ...(e.comic ? { comic: e.comic } : {}),
    ...(e.ocr ? { ocr: e.ocr } : {}),
  };
}

function toEntry(a: MediaAsset, prev?: MediaIndexEntry): MediaIndexEntry {
  const now = new Date().toISOString();
  return {
    hash: a.fingerprint.partialHash,
    path: a.path,
    size: a.fingerprint.size,
    mtimeMs: a.fingerprint.mtimeMs,
    kind: a.kind,
    probe: a.probe,
    panels: a.panels,
    panelConfidence: a.panelConfidence,
    phash: a.phash,
    comic: a.comic,
    ocr: a.ocr ?? prev?.ocr,
    tags: a.tags ?? [],
    description: a.description,
    rights: a.rights,
    analyser: IMAGE_ANALYSER,
    analysedAt: prev?.analysedAt ?? now,
    seenAt: now,
  };
}

/**
 * Imports every image/video under the given folders. Folder names and optional sidecar files
 * (`<file>.tags.txt` with comma/line separated tags, or `<file>.json` with {tags, description, rights})
 * become tags and descriptions. User-provided files are marked `user-provided` (the user is
 * responsible for their rights). With an index file, analyses are reused across scans.
 */
export async function scanMediaFolders(folders: string[], projectDir: string, known: Set<string>, signal?: AbortSignal, maxFiles = 2000, opts: ScanOptions = {}): Promise<ScanResult> {
  const files: string[] = [];
  const archives: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full, depth + 1);
      else if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase()) && !known.has(full)) files.push(full);
      else if (e.isFile() && (ARCHIVE_EXT.has(path.extname(e.name).toLowerCase()) || path.extname(e.name).toLowerCase() === '.pdf')) archives.push(full);
    }
  }
  for (const f of folders) await walk(f, 0);
  const out: ScanResult = { assets: [], errors: [], stats: { reused: 0, analysed: 0, moved: 0, missing: 0, ocr: 0 } };
  // comic archives (CBZ/ZIP): pages extracted into the project cache, in reading order
  const pageOf = new Map<string, { title: string; n: number; of: number; archive: string }>();
  for (const [zi, z] of archives.entries()) {
    if (signal?.aborted) break;
    try {
      let x: { pages: string[]; title: string };
      if (z.toLowerCase().endsWith('.pdf')) {
        // a PDF is a comic when its pages are pictures; a text PDF (a script, notes) is not a media
        const d = await pdfTextDensity(z);
        if (!isComicPdf(d)) continue;
        x = await extractComicPdf(z, path.join(projectDir, 'Cache'), { signal, progress: (k, n) => opts.progress?.(0, `PDF « ${path.basename(z)} » : page ${k}/${n} (${zi + 1}/${archives.length})`) });
      } else x = await extractComicArchive(z, path.join(projectDir, 'Cache'));
      x.pages.forEach((pg, i) => {
        // a page already in the project keeps its place in the book (re-scanned below for its page number)
        pageOf.set(pg, { title: x.title, n: i + 1, of: x.pages.length, archive: path.basename(z) });
        if (known.has(pg) || files.length >= maxFiles) return;
        files.push(pg);
      });
    } catch (e) {
      out.errors.push({ path: z, error: (e as Error).message });
    }
  }
  // a folder of numbered page scans (001.jpg, 002.jpg… or "X-Men 1 - 03.png") is a book too, in name order
  const byDir = new Map<string, string[]>();
  for (const f of files) if (!pageOf.has(f) && /\.(jpe?g|png|webp)$/i.test(f)) byDir.set(path.dirname(f), [...(byDir.get(path.dirname(f)) ?? []), f]);
  for (const [dir, list] of byDir) {
    const numbered = list.filter((f) => /\d/.test(path.basename(f)));
    // (pictures found on the Internet are not a book)
    if (list.length < 4 || numbered.length < 0.8 * list.length || fs.existsSync(path.join(dir, 'licences.json'))) continue;
    const sorted = [...list].sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
    sorted.forEach((f, i) => pageOf.set(f, { title: path.basename(dir), n: i + 1, of: sorted.length, archive: path.basename(dir) }));
  }
  const idx: MediaIndex | null = opts.indexFile ? await loadMediaIndex(opts.indexFile) : null;
  const seen = new Set<string>();
  const ocrOn = !!opts.ocr?.enabled;
  if (ocrOn && !findTesseract(opts.ocr!.path)) out.stats.ocrUnavailable = 'OCR activé mais Tesseract introuvable : correspondance sur les noms, étiquettes et descriptions seulement';
  let sinceSave = 0;
  for (const [i, f] of files.entries()) {
    if (signal?.aborted) break;
    opts.progress?.(i / Math.max(1, files.length), 'Indexation des médias');
    try {
      const st = await fsp.stat(f);
      let a: MediaAsset | null = null;
      let entry = idx ? entryForPath(idx, f, st.size, Math.round(st.mtimeMs)) : undefined;
      if (entry && entry.kind === 'image' && entry.analyser !== IMAGE_ANALYSER) entry = undefined;
      if (entry) {
        a = fromEntry(entry, f, projectDir);
        out.stats.reused++;
      } else if (idx) {
        const fp = await fingerprintFile(f);
        const same = idx.entries[fp.partialHash];
        if (same && (same.kind !== 'image' || same.analyser === IMAGE_ANALYSER)) {
          if (same.path !== f) out.stats.moved++;
          else out.stats.reused++;
          entry = same;
          a = fromEntry({ ...same, size: fp.size, mtimeMs: fp.mtimeMs }, f, projectDir);
        }
      }
      if (!a) {
        a = await importMediaFile(f, projectDir, signal);
        await analyseImage(a, signal);
        out.stats.analysed++;
      }
      const side = await readSidecars(f);
      const page = pageOf.get(f);
      a.tags = side.tags;
      a.rights = side.rights;
      if (side.description) a.description = side.description;
      if (page) {
        a.tags.push(page.title, `page ${page.n}`);
        a.page = { book: page.title, n: page.n, of: page.of };
        // the first page of a book is its cover: shown whole, never cut into panels
        if (page.n === 1 && a.kind === 'image' && a.comic && a.comic.format !== 'couverture' && a.comic.format !== 'double-page') ((a.comic = { ...a.comic, format: 'couverture', reason: 'première page du livre' }), (a.panels = undefined), (a.panelConfidence = undefined));
        a.rights = { ...a.rights!, note: `Page ${page.n} de « ${page.archive} » fournie par l’utilisateur (droits sous sa responsabilité).` };
      }
      if (ocrOn && !out.stats.ocrUnavailable && a.kind === 'image' && !a.ocr) {
        try {
          a.ocr = a.page || a.comic?.format === 'planche' || a.comic?.format === 'double-page' ? await ocrComicPage(a.path, opts.ocr!, signal) : await ocrImage(a.path, opts.ocr!, signal);
          out.stats.ocr++;
        } catch (e) {
          if (signal?.aborted) throw e;
          out.errors.push({ path: f, error: `OCR : ${(e as Error).message}` });
        }
      }
      // a page that is mostly running text without balloons (glossary, letters, editorial) is not story
      if (a.ocr && a.page && a.page.n > 1 && a.comic && a.comic.format !== 'générique') {
        const letters = a.ocr.text.replace(/[^\p{L}]/gu, '').length;
        // measured on 139 real pages: dialogue pages stay under ~900 letters; letters pages and glossaries
        // go far beyond; between the two, a dense, textured layout of panels is a story page
        const layout = !!a.panels && a.panels.length >= 3 && (a.panelConfidence ?? 0) >= 0.8 && (a.comic.flat ?? 0) <= 0.45;
        if (letters > 1500 || (letters > 600 && (a.comic.balloons ?? 0) < 2 && !layout)) ((a.comic = { ...a.comic, format: 'générique', reason: `page de texte (${letters} lettres lues, sans bulles) : glossaire, courrier ou éditorial` }), (a.panels = undefined), (a.panelConfidence = undefined));
      }
      if (idx) {
        const e = toEntry(a, entry);
        if (entry && entry.hash !== e.hash) delete idx.entries[entry.hash];
        // the previous content of a file that changed in place is replaced, not reported missing
        for (const [h, old] of Object.entries(idx.entries)) if (old.path === f && h !== e.hash) delete idx.entries[h];
        idx.entries[e.hash] = e;
        seen.add(e.hash);
        if (++sinceSave >= 50) {
          await saveMediaIndex(opts.indexFile!, idx);
          sinceSave = 0;
        }
      }
      out.assets.push(a);
    } catch (e) {
      if (signal?.aborted) break;
      out.errors.push({ path: f, error: (e as Error).message });
    }
  }
  if (idx) {
    // files in the scanned folders that were not found again (and are not in the project) are kept, marked missing
    for (const k of known) for (const e of Object.values(idx.entries)) if (e.path === k) seen.add(e.hash);
    if (!signal?.aborted) out.stats.missing = markMissing(idx, folders, seen);
    await saveMediaIndex(opts.indexFile!, idx);
  }
  return out;
}

export interface ProductionRequest {
  project: Project;
  projectDir: string;
  script: string;
  narrationMediaId: string;
  musicMediaId?: string | null;
  mediaFolders: string[];
  settings?: Partial<SequenceSettings>;
  prefs: ProductionPreferences;
  pcorePlacement?: Partial<import('../pcore/placement').PlacementSettings>;
  /** Force a narration format instead of the detected one ('auto' = detect). */
  narrationKind?: NarrationKind | 'auto';
  /** Renders a P-CORE asset (Electron host); without it P-CORE clips are left out and reported. */
  renderPCore?: (asset: MediaAsset, narration: MediaAsset, settings: SequenceSettings, signal?: AbortSignal) => Promise<string>;
  /** Optional word timestamps from a local recogniser (precise alignment). */
  transcript?: RecognisedWord[] | null;
  name?: string;
  /** Local music library index (JSON written by the music library scan): music per section. */
  musicIndexFile?: string;
  /** Decision graph to carry over (locks, validations, rejections). Default: the active version's. */
  previous?: EditDecisionGraph | null;
  /** Persistent media index file (analyses reused across scans and projects). */
  mediaIndexFile?: string;
  /** Optional local OCR. */
  ocr?: OcrConfig;
  /** Proper names of this video (creator's list): fix misspelt names in the transcription (reported). */
  vocabulary?: string[];
  /** P-CORE engine for new clips: 'v2' (default) or 'v1' (V1.1 behaviour). */
  pcoreEngine?: 'v1' | 'v2';
  /** P-CORE V2 settings (preset + adjustments) from P-CORE Studio. */
  pcoreV2?: Partial<import('../pcore/v2/config').PCoreV2Settings> | null;
  /** Opt-in: search freely licensed pictures on the Internet (Openverse, Wikimedia Commons). Only the
   *  search words leave the machine. Without it, nothing is sent anywhere. */
  webImages?: { fetchImpl: FetchLike; perQuery?: number; maxQueries?: number } | null;
}

export interface ProductionResult {
  sequence: Sequence;
  newMedia: MediaAsset[];
  /** Sentence timings used for the edit (diagnostics, evaluation). */
  timings?: { index: number; start: number; end: number; text: string }[];
  report: {
    sentences: number;
    beats: number;
    shots: number;
    alignment: { method: string; confidence: number };
    fixes: string[];
    scanErrors: { path: string; error: string }[];
    notes: string[];
    entities: string[];
    /** Set when the script was converted from a production document. */
    scriptImport?: { title: string | null; sections: number; repairs: number };
    transcription?: string;
    /** Narration cleanup: steps chosen from measurements, before/after metrics. */
    voice?: VoiceReport;
    /** Where the script came from: the written script, or rebuilt from the narration (no script given). */
    narrationFormat?: import('../core/model').ProductionNarrationFormat;
    scriptSource?: { kind: 'script' } | { kind: 'narration'; title: string; sentences: number; sections: number; markdown: string };
  };
}

export interface VoiceReport {
  mediaId: string;
  originalId: string;
  steps: { id: string; reason: string }[];
  before: VoiceQuality;
  after: VoiceQuality;
  beforeLufs: number | null;
  afterLufs: number | null;
  seconds: number;
  cached: boolean;
  latencyMs?: number;
  /** false when the edit uses a tightened copy (the original no longer matches the timing). */
  swappable?: boolean;
}

export async function produceVideo(req0: ProductionRequest, progress: (f: number, msg: string) => void = () => undefined, signal?: AbortSignal, live: (patch: Partial<import('./tasks').TaskLive>) => void = () => undefined): Promise<ProductionResult> {
  let req = req0;
  const original = req.project.media[req.narrationMediaId];
  if (!original?.probe.audio) throw new Error('Narration audio not found in the project');
  let narration: MediaAsset = original;
  // real production scripts (PDF/Docs exports) are converted; Primestone Markdown is used as is
  // no written script: the narration itself becomes the script (needs the local transcription)
  const vocabNotes: string[] = [];
  if (req.transcript?.length && req.vocabulary?.length) {
    const v = applyVocabulary(req.transcript, req.vocabulary);
    req = { ...req, transcript: v.words };
    if (v.corrections.length) vocabNotes.push(`Noms propres corrigés dans la transcription (${v.corrections.length}) : ${v.corrections.slice(0, 12).map((c) => `« ${c.heard} » → ${c.name} à ${c.at.toFixed(1)} s`).join(', ')}${v.corrections.length > 12 ? '…' : ''}`);
  }
  let fromVoice: ReturnType<typeof scriptFromTranscript> | null = null;
  if (!req.script.trim()) {
    if (!req.transcript?.length) throw new Error('Sans script, la transcription locale est nécessaire : Réglages → Transcription locale (ou collez votre script).');
    fromVoice = scriptFromTranscript(req.transcript);
  }
  const source = fromVoice ? fromVoice.markdown : req.script;
  const imported = fromVoice || isCanonicalScript(source) ? null : importProductionScript(source, { dictionary: loadDictionary(), transcriptVocabulary: req.transcript?.map((w) => w.text) });
  const script = parseScript(imported ? imported.markdown : source);
  if (!script.sentences.length) throw new Error('Le script ne contient aucun texte de narration');

  progress(0.05, 'Analyse de la narration');
  let na = await analyzeNarration(original.path, { signal });
  // voice cleanup → a derived copy used by the edit; the recording itself is never modified
  let voice: VoiceReport | undefined;
  const voiceNotes: string[] = [];
  if (req.prefs.voiceCleanup !== false) {
    progress(0.1, 'Nettoyage de la voix');
    try {
      const vc = await cleanVoice(original, path.join(req.projectDir, 'Cache'), { targetLufs: req.prefs.narrationLufs, style: req.prefs.voiceStyle ?? 'natural', silences: na.silences }, signal);
      const asset = await importMediaFile(vc.path, req.projectDir, signal);
      asset.name = `${original.name.replace(/\.[^.]+$/, '')} · voix nettoyée.wav`;
      asset.derived = { from: original.id, kind: 'voice-cleanup', steps: vc.steps.map((s) => s.id) };
      narration = asset;
      na = { ...(await analyzeAudio(asset.path, { signal })), silences: na.silences };
      voice = { mediaId: asset.id, originalId: original.id, latencyMs: vc.latencyMs, steps: vc.steps.map((s) => ({ id: s.id, reason: s.reason })), before: vc.before, after: vc.after, beforeLufs: vc.beforeLufs, afterLufs: vc.afterLufs, seconds: vc.seconds, cached: vc.cached };
    } catch (e) {
      if (signal?.aborted) throw e;
      voiceNotes.push(`Nettoyage de la voix ignoré : ${(e as Error).message}`);
    }
  }
  // Voice Studio: hesitations and repetitions are always reported; long pauses and (opt-in) those
  // mistakes are removed together in one derived copy; every time is remapped
  let transcript = req.transcript ?? null;
  let tightened: { pauses: number; removedSec: number } | null = null;
  const disfluencies = transcript?.length ? [...detectDisfluencies(transcript), ...untranscribedSounds(transcript, na.silences)].sort((x, y) => x.start - y.start) : [];
  let disfluencyCut = 0;
  if (req.prefs.tightenPauses || (req.prefs.cutDisfluencies && disfluencies.length)) {
    const dur = narration.probe.durationSec;
    const pausePlan = req.prefs.tightenPauses ? planTighten(na.silences, dur) : { keep: [{ start: 0, end: dur }], removedSec: 0, pauses: 0 };
    const cuts = [...cutsFromKeep(pausePlan.keep, dur), ...(req.prefs.cutDisfluencies ? disfluencies : [])];
    const keep = keepFromCuts(cuts, dur);
    const removedSec = dur - keep.reduce((a, k) => a + k.end - k.start, 0);
    if (removedSec >= 0.3) {
      progress(0.2, 'Resserrement de la voix');
      const file = await renderTightened(narration, keep, path.join(req.projectDir, 'Cache'), signal);
      const asset = await importMediaFile(file, req.projectDir, signal);
      const steps = [...(req.prefs.tightenPauses ? ['pauses'] : []), ...(req.prefs.cutDisfluencies ? ['disfluencies'] : [])];
      asset.name = `${original.name.replace(/\.[^.]+$/, '')} · ${req.prefs.cutDisfluencies ? 'voix resserrée' : 'pauses resserrées'}.wav`;
      asset.derived = { from: original.id, kind: 'voice-cleanup', steps: [...(narration.derived?.steps ?? []), ...steps] };
      narration = asset;
      na = await analyzeNarration(asset.path, { signal });
      transcript = transcript ? wordsAfterCuts(transcript, cutsFromKeep(keep, dur), (t) => remapTime(t, keep)) : null;
      tightened = { pauses: pausePlan.pauses, removedSec: +removedSec.toFixed(3) };
      disfluencyCut = req.prefs.cutDisfluencies ? disfluencies.length : 0;
      if (voice) voice = { ...voice, mediaId: asset.id, swappable: false };
    }
  }
  const music = req.musicMediaId ? req.project.media[req.musicMediaId] : null;
  const ma = music ? await analyzeAudio(music.path, { signal }) : null;

  progress(0.25, 'Synchronisation du texte et de la voix');
  let alignment: AlignmentResult;
  const speech = speechFromSilences(na.silences, narration.probe.durationSec);
  if (transcript?.length) alignment = alignToTranscript(script.sentences, transcript, speech);
  else alignment = alignByPauses(script.sentences, speech);

  const indexNotes: string[] = [];
  const webDir = path.join(req.projectDir, 'Images libres (Internet)');
  const folders = [...req.mediaFolders];
  if (req.webImages) {
    const queries = webQueries(script, req.vocabulary ?? [], req.webImages.maxQueries ?? 10);
    progress(0.3, 'Recherche d\'images libres sur Internet');
    live({ stage: `Recherche d'images libres sur Internet (${queries.length} recherche(s))` });
    const web = await fetchWebImages({ queries, dir: webDir, perQuery: req.webImages.perQuery ?? 2, fetchImpl: req.webImages.fetchImpl, signal, progress: (f, m) => { progress(0.3 + 0.05 * f, m); live({ detail: m }); } });
    const last = web.downloaded.at(-1);
    if (last) live({ latest: last.file });
    indexNotes.push(queries.length ? `Images libres (Internet) : ${web.downloaded.length} téléchargée(s) pour ${queries.length} recherche(s) (${queries.join(' · ')}) — licences CC0 / domaine public / CC BY / CC BY-SA, crédits dans « ${path.basename(webDir)}/CRÉDITS IMAGES.txt »` : 'Images libres (Internet) : aucun mot-clé à chercher (ajoutez des [VISUEL: …] ou des noms propres).');
    if (web.errors.length) indexNotes.push(`Images libres : ${web.errors.length} problème(s) — ${web.errors.slice(0, 3).join(' ; ')}`);
  }
  if (fs.existsSync(webDir) && !folders.includes(webDir)) folders.push(webDir);

  progress(0.35, 'Indexation des médias');
  const known = new Set(Object.values(req.project.media).map((m) => m.path));
  const scan = await scanMediaFolders(folders, req.projectDir, known, signal, 2000, { indexFile: req.mediaIndexFile, ocr: req.ocr, progress: (f, m) => progress(0.35 + 0.2 * f, m) });
  // pictures from the Internet keep their licence, author and source page (not "provided by the user")
  const webRights = loadWebRights(webDir);
  for (const a of [...scan.assets, ...Object.values(req.project.media)]) {
    const r = path.dirname(a.path) === webDir ? webRights[path.basename(a.path)] : undefined;
    if (r) a.rights = r;
  }
  if (req.mediaIndexFile && req.mediaFolders.length) indexNotes.push(`Index des médias : ${scan.stats.reused} réutilisé(s), ${scan.stats.analysed} analysé(s), ${scan.stats.moved} retrouvé(s) après déplacement, ${scan.stats.missing} introuvable(s)${scan.stats.ocr ? `, ${scan.stats.ocr} lu(s) par OCR` : ''}`);
  if (scan.stats.ocrUnavailable) indexNotes.push(scan.stats.ocrUnavailable);
  const library = [...Object.values(req.project.media).filter((m) => m.id !== narration.id && m.id !== original.id && m.id !== music?.id && !m.derived), ...scan.assets];

  const tailNotes: string[] = [];
  const base = Object.values(req.project.sequences)[0]?.settings;
  const settings: SequenceSettings = { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, sampleRate: 48000, ...base, ...req.settings };
  // narration format (ranking, versus, recap…) and length class → direction preset (explained, overridable)
  const detected = detectNarrationFormat(script, narration.probe.durationSec, settings.height > settings.width);
  const kind = req.narrationKind && req.narrationKind !== 'auto' ? req.narrationKind : detected.kind;
  const direction = req.prefs.autoDirection === false ? { prefs: req.prefs, changes: [] as string[] } : directionFor({ kind, length: detected.length }, req.prefs);
  const prefs = direction.prefs;
  if (kind === 'classement') for (const s of script.sentences) {
    const card = rankCard(s.text);
    if (card && !s.onScreen.includes(card)) s.onScreen.unshift(card);
  }
  const narrationFormat = { kind, label: NARRATION_KINDS[kind], forced: kind !== detected.kind, detected: detected.kind, confidence: detected.confidence, length: detected.length, evidence: detected.evidence, changes: direction.changes };
  const versions = Object.values(req.project.sequences).filter((s) => s.production).length;
  const name = req.name ?? `Auto v${versions + 1}`;
  // a recording that ends with speech not in the script (outtake, retake) is cut after the last sentence
  let narrationEndSec: number | undefined;
  const lastEnd = alignment.sentences.at(-1)?.end ?? 0;
  const tail = alignment.offScript?.find((o) => o.start >= lastEnd - 0.2 && o.end >= narration.probe.durationSec - 1.5);
  if (tail) {
    narrationEndSec = Math.min(tail.start - 0.05, lastEnd + 0.8);
    tailNotes.push(`Prise hors script en fin d'enregistrement retirée du montage (${tail.start.toFixed(1)}–${tail.end.toFixed(1)} s): “${tail.text.slice(0, 60)}…” — rallongez le clip de narration pour la récupérer`);
  }
  // narrative reading of the script (rules, with evidence): drives the music per section
  const narrative = analyseNarrative(script);
  const previous = req.previous === undefined ? req.project.sequences[req.project.activeSequenceId]?.production?.edg : req.previous ?? undefined;
  const musicNotes: string[] = [];
  let musicSegments: { media: MediaAsset; lufs: number | null; segment: MusicSegment }[] | undefined;
  if (!music && prefs.musicFromLibrary !== false && req.musicIndexFile) {
    try {
      const idx = await loadMusicIndex(req.musicIndexFile);
      const tracks: MusicCandidate[] = Object.values(idx.tracks)
        .filter((t) => !t.missing && !t.duplicateOf && fs.existsSync(t.path))
        .map((t) => {
          const e = effectiveTrack(t);
          return { trackId: t.id, title: t.title, path: t.path, durationSec: t.format.durationSec, energy: e.energy, moods: e.moods, bpm: t.features.bpm, vocalsLikely: t.classification.vocalsLikely, licence: e.licence.family ?? null, licenceStatus: e.licence.status, uses: t.usage.length, loopScore: t.features.loopScore };
        });
      if (!tracks.length) musicNotes.push('Musique : la bibliothèque musicale est vide ou pas encore analysée (bouton « Musique » de l’éditeur) — vidéo sans musique');
      else {
        const spans = narrative.map((n) => {
          const al = alignment.sentences.filter((a) => n.sentences.includes(a.index));
          return { section: n.section, start: al[0]?.start ?? 0, end: al.at(-1)?.end ?? 0, narrative: n };
        }).filter((x) => x.end > x.start);
        if (spans.length) spans[0]!.start = 0;
        const locks = new Map<string, string>();
        const rejected = new Map<string, Set<string>>();
        for (const d of previous?.decisions ?? []) {
          if (d.kind !== 'musique') continue;
          const anchor = d.anchor.text.split(' + ')[0]!;
          if ((d.state === 'verrouillée' || d.state === 'acceptée') && d.chosen.trackId) locks.set(anchor, d.chosen.trackId);
          if (d.rejected.length) rejected.set(anchor, new Set(d.rejected));
        }
        const plan = planMusic(spans, tracks, { locks, rejected, pauses: na.silences });
        musicSegments = [];
        for (const seg of plan) {
          if (!seg.trackId) continue;
          const t = tracks.find((x) => x.trackId === seg.trackId)!;
          const media = await importMediaFile(t.path, req.projectDir, signal);
          media.rights = { usage: 'user-provided', source: 'music-library', license: t.licence ?? undefined, checkedAt: new Date().toISOString(), note: t.licenceStatus === 'inconnue' ? 'Licence non déclarée : vérifiez vos droits avant publication.' : 'Licence déclarée dans la bibliothèque musicale.' };
          const lufs = idx.tracks[t.trackId]?.loudness.integratedLufs ?? null;
          musicSegments.push({ media, lufs, segment: seg });
          if (t.licenceStatus === 'inconnue') musicNotes.push(`Musique « ${t.title} » : licence non déclarée — vérifiez vos droits avant de publier`);
        }
        if (!musicSegments.length) musicNotes.push('Musique : aucune piste utilisable (licences NC/ND écartées, ou pistes rejetées)');
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      musicNotes.push(`Musique par section ignorée : ${(e as Error).message}`);
    }
  }
  // P-CORE V2: the director plans the expressions over the whole narration (voice + aligned text),
  // keeping the cues the creator edited or locked in the previous version
  let pcoreV2: { cues: PCoreCue[]; settings: PCoreV2Settings } | undefined;
  let pcorePlan: Awaited<ReturnType<typeof planPCoreV2>> | null = null;
  if ((prefs.pcore ?? 'off') !== 'off' && (req.pcoreEngine ?? 'v2') === 'v2') {
    progress(0.58, 'Direction de P-CORE');
    const v2 = resolveV2(req.pcoreV2);
    const prevP = req.project.sequences[req.project.activeSequenceId]?.production?.pcore;
    const sentences = alignment.sentences.map((a) => ({ index: a.index, start: a.start, end: a.end, text: script.sentences[a.index]?.text ?? '', section: script.sentences[a.index]?.section }));
    pcorePlan = await planPCoreV2(narration.path, { sentences, v2, edits: prevP?.edits, added: prevP?.added, endSec: narrationEndSec, signal });
    pcoreV2 = { cues: pcorePlan.cues, settings: v2 };
  }
  progress(0.6, 'Construction du montage');
  const built = buildSequence({ name, settings, script, alignment, narration, narrationEndSec, narrationLufs: na.integratedLufs, music, musicLufs: ma?.integratedLufs ?? null, library, prefs, pcorePlacement: req.pcorePlacement, previous, musicSegments, narrative, pcoreV2 });

  if (built.story) tailNotes.push(`Mode histoire : ${built.story.spans.length} page(s) de ${built.story.books.map((b) => `« ${b} »`).join(', ')} montrée(s) dans l'ordre du livre, au fil de la narration (${built.story.anchors.length} ancrage(s) précis sur le texte, les noms ou vos [VISUEL: page N])`, ...built.story.notes);
  // live view: the storyboard of the edit, as decided (library pictures show at once; compositions when rendered)
  const fpsR = settings.frameRate.num / settings.frameRate.den;
  const mediaById = new Map([...library, ...built.generated].map((m) => [m.id, m]));
  const board = built.shots.map((sh) => {
    const m = sh.mediaId ? mediaById.get(sh.mediaId) : undefined;
    return { start: +(sh.start / fpsR).toFixed(2), end: +(sh.end / fpsR).toFixed(2), kind: (sh.quality === 'missing' ? 'missing' : m?.generator ? 'composition' : 'image') as 'image' | 'composition' | 'missing', label: m?.name ?? 'visuel manquant', text: sh.text.slice(0, 90), thumb: m && !m.generator && m.kind === 'image' ? m.path : undefined, mediaId: m?.id };
  });
  // first picture of the edit as the preview until a composition or P-CORE is rendered
  live({ stage: 'Montage décidé', board: board.map(({ mediaId: _m, ...b }) => b), latest: board.find((b) => b.thumb)?.thumb, detail: `${board.length} plans · ${built.generated.filter((g) => g.generator).length} compositions à rendre` });
  const thumbOf = async (file: string) => {
    const out = `${file}.jpg`;
    if (!fs.existsSync(out)) await ffmpeg(['-v', 'error', '-y', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', out]).catch(() => undefined);
    return fs.existsSync(out) ? out : undefined;
  };
  // render procedural compositions (cached by spec hash) so they behave like ordinary media
  const pcoreNotes: string[] = [];
  if (!req.renderPCore) {
    const pc = new Set(built.generated.filter((g) => g.pcore).map((g) => g.id));
    if (pc.size) {
      for (const t of built.sequence.tracks) t.clips = t.clips.filter((c) => !pc.has(c.mediaId));
      pcoreNotes.push('P-CORE non calculé : pas de moteur 3D dans ce contexte (lancez-le dans l’application)');
    }
  }
  const toRender = built.generated.filter((g) => built.sequence.tracks.some((t) => t.clips.some((c) => c.mediaId === g.id)));
  // P-CORE renders share one GPU window: render them after the CPU work, one at a time
  const pcoreQueue = toRender.filter((g) => g.pcore);
  for (const g of pcoreQueue) toRender.splice(toRender.indexOf(g), 1);
  const cacheDir = path.join(req.projectDir, 'Cache');
  let done = 0;
  const rate = `${settings.frameRate.num}/${settings.frameRate.den}`;
  const worker = async () => {
    for (let g = toRender.shift(); g; g = toRender.shift()) {
      progress(0.65 + 0.15 * (done / Math.max(1, built.generated.length)), `Rendu des animations et du son (${done + 1}/${built.generated.length})`);
      g.path = g.sfx ? await renderSfx(g.sfx, cacheDir, signal) : await renderGenerator(g.generator!, { width: settings.width, height: settings.height, rate, audioPath: narration.path, cacheDir, signal });
      g.fingerprint = await fingerprintFile(g.path);
      if (g.sfx) g.probe = (await probeMedia(g.path, signal)).probe;
      g.relativePath = path.relative(req.projectDir, g.path);
      done++;
      if (g.generator) {
        const th = await thumbOf(g.path);
        if (th) {
          for (const b of board) if (b.mediaId === g.id) b.thumb = th;
          live({ stage: 'Rendu des compositions', latest: th, board: board.map(({ mediaId: _m, ...b }) => b), detail: `${done}/${built.generated.length} rendus` });
        }
      }
    }
  };
  // each FFmpeg render is itself multi-threaded: one worker per ~3 hardware threads (2–4)
  const workers = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 3)));
  if (toRender.length) await Promise.all(Array.from({ length: workers }, () => worker()));
  for (const [i, g] of pcoreQueue.entries()) {
    progress(0.72 + 0.08 * (i / pcoreQueue.length), `Rendu de P-CORE (${i + 1}/${pcoreQueue.length})`);
    try {
      live({ stage: `Rendu de P-CORE (${i + 1}/${pcoreQueue.length})` });
      g.path = await req.renderPCore!(g, narration, settings, signal);
      const pth = await thumbOf(g.path);
      if (pth) live({ latest: pth });
      g.fingerprint = await fingerprintFile(g.path);
      g.relativePath = path.relative(req.projectDir, g.path);
    } catch (e) {
      if (signal?.aborted) throw e;
      // P-CORE must never break a production: leave it out and say why
      const failed = new Set(pcoreQueue.slice(i).map((x) => x.id));
      for (const t of built.sequence.tracks) t.clips = t.clips.filter((c) => !failed.has(c.mediaId));
      pcoreNotes.push(`P-CORE non inclus : ${(e as Error).message}`);
      break;
    }
  }

  progress(0.8, 'Contrôle qualité');
  live({ stage: 'Contrôle qualité' });
  const mediaMap: Record<string, MediaAsset> = { ...req.project.media, ...Object.fromEntries([...scan.assets, ...built.generated, narration, ...(musicSegments ?? []).map((x) => x.media)].map((a) => [a.id, a])) };
  const endFrame = secondsToFrames((narrationEndSec ?? narration.probe.durationSec) + 1, settings.frameRate);
  const fixes = autoFix(built.sequence, mediaMap, endFrame);
  built.sequence.production = {
    generatedAt: new Date().toISOString(),
    version: versions + 1,
    alignment: { method: alignment.method, confidence: alignment.confidence },
    preferencesVersion: req.prefs.version,
    qcScore: 0,
    qcIssues: [],
    shots: built.shots,
    style: {},
    narrationMediaId: narration.id,
    narrationFormat,
    edg: built.edg,
    ...(pcoreV2 && pcorePlan ? { pcore: { engine: 'v2' as const, preset: pcoreV2.settings.preset, cues: pcoreV2.cues, edits: req.project.sequences[req.project.activeSequenceId]?.production?.pcore?.edits ?? [], added: req.project.sequences[req.project.activeSequenceId]?.production?.pcore?.added ?? [], log: pcorePlan.log.slice(0, 200), usedText: pcorePlan.usedText } } : {}),
    narrative: narrative.map((n) => ({ section: n.section, title: n.title, fn: n.fn, label: n.label, confidence: n.confidence, evidence: n.evidence, intensity: n.intensity })),
    music: built.music,
    voice: voice && {
      mediaId: voice.mediaId,
      originalId: voice.originalId,
      steps: voice.steps,
      before: { noiseFloorDb: voice.before.noiseFloorDb, snrDb: voice.before.snrDb, humHz: voice.before.humHz, lufs: voice.beforeLufs },
      after: { noiseFloorDb: voice.after.noiseFloorDb, snrDb: voice.after.snrDb, humHz: voice.after.humHz, lufs: voice.afterLufs },
      latencyMs: voice.latencyMs,
      swappable: voice.swappable,
    },
  };
  rebindGraph(built.sequence);
  const qc = runQc(built.sequence, mediaMap, prefs, { alignmentConfidence: alignment.confidence, narrationEnd: endFrame, offScript: alignment.offScript?.filter((o) => o !== tail) });
  qc.issues.push(...reviewQc(built.sequence, mediaMap, prefs));
  qc.score = Math.max(0, qc.score - qc.issues.filter((i) => i.code.startsWith('review-') && i.severity === 'warning').length * 4);
  if (musicSegments?.length && req.musicIndexFile) {
    for (const x of musicSegments) if (x.segment.trackId && built.sequence.tracks.some((t) => t.clips.some((c) => c.mediaId === x.media.id))) await recordMusicUsage(req.musicIndexFile, x.segment.trackId, { project: req.project.name, sequence: built.sequence.name }).catch(() => undefined);
  }
  if (tightened) qc.issues.push({ severity: 'info', code: 'pauses', message: `Voix resserrée : ${tightened.pauses} pause(s) raccourcie(s)${disfluencyCut ? `, ${disfluencyCut} hésitation(s) ou répétition(s) coupée(s)` : ''}, ${tightened.removedSec.toFixed(1)} s retirées (copie dérivée ; décochez l’option et régénérez pour revenir à l’enregistrement d’origine)` });
  if (disfluencies.length && !disfluencyCut) {
    const list = disfluencies.slice(0, 6).map((d) => `« ${d.text} » à ${d.start.toFixed(1)} s`).join(', ');
    qc.issues.push({ severity: 'info', code: 'disfluency', message: `${disfluencies.length} hésitation(s) ou répétition(s) entendue(s) : ${list}${disfluencies.length > 6 ? '…' : ''}. Cochez « Couper les « euh » et les répétitions » pour les retirer (copie dérivée, réversible).`, frame: secondsToFrames(disfluencies[0]!.start, settings.frameRate) });
  }
  if (tail) qc.issues.push({ severity: 'info', code: 'outtake-cut', message: tailNotes[0]!, frame: secondsToFrames(narrationEndSec!, settings.frameRate) });
  built.sequence.production.qcScore = qc.score;
  built.sequence.production.qcIssues = qc.issues;
  built.sequence.production.style = measureStyle(built.sequence) as unknown as Record<string, unknown>;
  // only media actually used by the edit are added to the project
  const used = new Set(built.sequence.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)));
  // the best alternative pictures of each decision come too, so "Replace with…" works offline at once
  const offered = new Set(built.edg.decisions.flatMap((d) => (d.kind === 'visuel' ? d.candidates.slice(0, 4).map((c) => c.mediaId).filter((x): x is string => !!x) : [])));
  const entities = [...new Set(built.beats.flatMap((b) => b.entities.filter((e) => e.kind !== 'unknown').map((e) => e.name)))];
  progress(1, `Contrôle qualité ${qc.score}/100`);
  void framesToSeconds;
  return {
    sequence: built.sequence,
    newMedia: [...scan.assets, ...built.generated, ...(musicSegments ?? []).map((x) => x.media), ...(narration !== original ? [narration] : [])].filter((a) => used.has(a.id) || offered.has(a.id)),
    timings: alignment.sentences.map((a) => ({ index: a.index, start: a.start, end: a.end, text: script.sentences[a.index]?.text ?? '' })),
    report: { sentences: script.sentences.length, beats: built.beats.length, shots: built.shots.length, alignment: { method: alignment.method, confidence: alignment.confidence }, fixes, scanErrors: scan.errors, notes: [...script.notes, ...voiceNotes, ...tailNotes, ...vocabNotes, ...pcoreNotes, ...musicNotes, ...indexNotes], entities, voice, narrationFormat, scriptSource: fromVoice ? { kind: 'narration', title: fromVoice.title, sentences: fromVoice.sentences, sections: fromVoice.sections, markdown: fromVoice.markdown } : { kind: 'script' }, scriptImport: imported ? { title: imported.title, sections: imported.sectionTargets.length, repairs: imported.repairs.length } : undefined },
  };
}
