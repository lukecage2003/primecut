/**
 * Script-to-Video production pipeline (engine side): analyses the narration, indexes the media the
 * user provided, plans and builds the edit, runs QC with automatic fixes, and returns a new
 * sequence plus a full report. Each stage reports progress through the TaskOrchestrator.
 */
import fs from 'node:fs';
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
} from '../production';
import { analyzeAudio } from './audioAnalysis';
import { importMediaFile } from './media';
import { ffmpeg } from './ffmpeg';
import { detectPanels } from '../core';

/** Decodes a page at low resolution and runs panel detection (XY-cut on gutters). */
export async function detectPagePanels(file: string, w: number, h: number, signal?: AbortSignal) {
  const W = 320;
  const H = Math.max(2, Math.round((W * h) / w / 2) * 2);
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'], { collectStdout: true, signal });
  const panels = detectPanels(new Uint8Array(stdout.buffer, stdout.byteOffset, W * H), W, H);
  return panels.length >= 2 ? panels : undefined;
}

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.mp4', '.mov', '.mkv', '.webm', '.m4v']);

export interface ScanResult {
  assets: MediaAsset[];
  errors: { path: string; error: string }[];
}

/**
 * Imports every image/video under the given folders. Folder names and optional sidecar files
 * (`<file>.tags.txt` with comma/line separated tags, or `<file>.json` with {tags, rights}) become tags.
 * User-provided files are marked `user-provided` (the user is responsible for their rights).
 */
export async function scanMediaFolders(folders: string[], projectDir: string, known: Set<string>, signal?: AbortSignal, maxFiles = 2000): Promise<ScanResult> {
  const files: string[] = [];
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
    }
  }
  for (const f of folders) await walk(f, 0);
  const out: ScanResult = { assets: [], errors: [] };
  for (const f of files) {
    if (signal?.aborted) break;
    try {
      const a = await importMediaFile(f, projectDir, signal);
      const tags: string[] = [];
      for (const side of [`${f}.tags.txt`, f.replace(/\.[^.]+$/, '.tags.txt')]) {
        if (fs.existsSync(side)) tags.push(...(await fsp.readFile(side, 'utf8')).split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
      }
      const json = f.replace(/\.[^.]+$/, '.json');
      let rights: MediaAsset['rights'] = { usage: 'user-provided', source: 'user-library', checkedAt: new Date().toISOString(), note: 'Provided by the user, who is responsible for usage rights.' };
      if (fs.existsSync(json)) {
        try {
          const j = JSON.parse(await fsp.readFile(json, 'utf8'));
          if (Array.isArray(j.tags)) tags.push(...j.tags.map(String));
          if (j.rights && typeof j.rights.usage === 'string') rights = { ...rights, ...j.rights, checkedAt: new Date().toISOString() };
        } catch {
          /* invalid sidecar ignored */
        }
      }
      a.tags = tags;
      a.rights = rights;
      const v = a.probe.video;
      if (a.kind === 'image' && v && v.height > v.width * 1.15) a.panels = await detectPagePanels(a.path, v.width, v.height, signal).catch(() => undefined);
      out.assets.push(a);
    } catch (e) {
      out.errors.push({ path: f, error: (e as Error).message });
    }
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
  /** Optional word timestamps from a local recogniser (precise alignment). */
  transcript?: RecognisedWord[] | null;
  name?: string;
}

export interface ProductionResult {
  sequence: Sequence;
  newMedia: MediaAsset[];
  report: {
    sentences: number;
    beats: number;
    shots: number;
    alignment: { method: string; confidence: number };
    fixes: string[];
    scanErrors: { path: string; error: string }[];
    notes: string[];
    entities: string[];
  };
}

export async function produceVideo(req: ProductionRequest, progress: (f: number, msg: string) => void = () => undefined, signal?: AbortSignal): Promise<ProductionResult> {
  const narration = req.project.media[req.narrationMediaId];
  if (!narration?.probe.audio) throw new Error('Narration audio not found in the project');
  const script = parseScript(req.script);
  if (!script.sentences.length) throw new Error('The script contains no narration text');

  progress(0.05, 'Analysing narration');
  const na = await analyzeAudio(narration.path, { signal });
  const music = req.musicMediaId ? req.project.media[req.musicMediaId] : null;
  const ma = music ? await analyzeAudio(music.path, { signal }) : null;

  progress(0.25, 'Synchronising text and voice');
  let alignment: AlignmentResult;
  if (req.transcript?.length) alignment = alignToTranscript(script.sentences, req.transcript);
  else alignment = alignByPauses(script.sentences, speechFromSilences(na.silences, narration.probe.durationSec));

  progress(0.35, 'Indexing media');
  const known = new Set(Object.values(req.project.media).map((m) => m.path));
  const scan = await scanMediaFolders(req.mediaFolders, req.projectDir, known, signal);
  const library = [...Object.values(req.project.media).filter((m) => m.id !== narration.id && m.id !== music?.id), ...scan.assets];

  progress(0.6, 'Building the edit');
  const base = Object.values(req.project.sequences)[0]?.settings;
  const settings: SequenceSettings = { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, sampleRate: 48000, ...base, ...req.settings };
  const versions = Object.values(req.project.sequences).filter((s) => s.production).length;
  const name = req.name ?? `Auto v${versions + 1}`;
  const built = buildSequence({ name, settings, script, alignment, narration, narrationLufs: na.integratedLufs, music, musicLufs: ma?.integratedLufs ?? null, library, prefs: req.prefs });

  progress(0.8, 'Quality control');
  const mediaMap: Record<string, MediaAsset> = { ...req.project.media, ...Object.fromEntries(scan.assets.map((a) => [a.id, a])) };
  const endFrame = secondsToFrames(narration.probe.durationSec + 1, settings.frameRate);
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
  };
  const qc = runQc(built.sequence, mediaMap, req.prefs, { alignmentConfidence: alignment.confidence, narrationEnd: endFrame });
  built.sequence.production.qcScore = qc.score;
  built.sequence.production.qcIssues = qc.issues;
  built.sequence.production.style = measureStyle(built.sequence) as unknown as Record<string, unknown>;
  // only media actually used by the edit are added to the project
  const used = new Set(built.sequence.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)));
  const entities = [...new Set(built.beats.flatMap((b) => b.entities.filter((e) => e.kind !== 'unknown').map((e) => e.name)))];
  progress(1, `QC score ${qc.score}/100`);
  void framesToSeconds;
  return {
    sequence: built.sequence,
    newMedia: scan.assets.filter((a) => used.has(a.id)),
    report: { sentences: script.sentences.length, beats: built.beats.length, shots: built.shots.length, alignment: { method: alignment.method, confidence: alignment.confidence }, fixes, scanErrors: scan.errors, notes: script.notes, entities },
  };
}
