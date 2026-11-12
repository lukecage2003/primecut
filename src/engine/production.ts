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
import { analyzeAudio } from './audioAnalysis';
import { fingerprintFile, importMediaFile } from './media';
import { cleanVoice } from './voice';
import type { VoiceQuality } from '../production/voiceChain';
import { renderGenerator } from './generators';
import { renderSfx } from './sfx';
import { probeMedia } from './probe';
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
  pcorePlacement?: Partial<import('../pcore/placement').PlacementSettings>;
  /** Renders a P-CORE asset (Electron host); without it P-CORE clips are left out and reported. */
  renderPCore?: (asset: MediaAsset, narration: MediaAsset, settings: SequenceSettings, signal?: AbortSignal) => Promise<string>;
  /** Optional word timestamps from a local recogniser (precise alignment). */
  transcript?: RecognisedWord[] | null;
  name?: string;
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
}

export async function produceVideo(req: ProductionRequest, progress: (f: number, msg: string) => void = () => undefined, signal?: AbortSignal): Promise<ProductionResult> {
  const original = req.project.media[req.narrationMediaId];
  if (!original?.probe.audio) throw new Error('Narration audio not found in the project');
  let narration: MediaAsset = original;
  // real production scripts (PDF/Docs exports) are converted; Primestone Markdown is used as is
  const imported = isCanonicalScript(req.script) ? null : importProductionScript(req.script, { dictionary: loadDictionary(), transcriptVocabulary: req.transcript?.map((w) => w.text) });
  const script = parseScript(imported ? imported.markdown : req.script);
  if (!script.sentences.length) throw new Error('The script contains no narration text');

  progress(0.05, 'Analysing narration');
  let na = await analyzeAudio(original.path, { signal });
  // voice cleanup → a derived copy used by the edit; the recording itself is never modified
  let voice: VoiceReport | undefined;
  const voiceNotes: string[] = [];
  if (req.prefs.voiceCleanup !== false) {
    progress(0.1, 'Cleaning the voice');
    try {
      const vc = await cleanVoice(original, path.join(req.projectDir, 'Cache'), { targetLufs: req.prefs.narrationLufs, silences: na.silences }, signal);
      const asset = await importMediaFile(vc.path, req.projectDir, signal);
      asset.name = `${original.name.replace(/\.[^.]+$/, '')} · voix nettoyée.wav`;
      asset.derived = { from: original.id, kind: 'voice-cleanup', steps: vc.steps.map((s) => s.id) };
      narration = asset;
      na = { ...(await analyzeAudio(asset.path, { signal })), silences: na.silences };
      voice = { mediaId: asset.id, originalId: original.id, latencyMs: vc.latencyMs, steps: vc.steps.map((s) => ({ id: s.id, reason: s.reason })), before: vc.before, after: vc.after, beforeLufs: vc.beforeLufs, afterLufs: vc.afterLufs, seconds: vc.seconds, cached: vc.cached };
    } catch (e) {
      if (signal?.aborted) throw e;
      voiceNotes.push(`Voice cleanup skipped: ${(e as Error).message}`);
    }
  }
  const music = req.musicMediaId ? req.project.media[req.musicMediaId] : null;
  const ma = music ? await analyzeAudio(music.path, { signal }) : null;

  progress(0.25, 'Synchronising text and voice');
  let alignment: AlignmentResult;
  const speech = speechFromSilences(na.silences, narration.probe.durationSec);
  if (req.transcript?.length) alignment = alignToTranscript(script.sentences, req.transcript, speech);
  else alignment = alignByPauses(script.sentences, speech);

  progress(0.35, 'Indexing media');
  const known = new Set(Object.values(req.project.media).map((m) => m.path));
  const scan = await scanMediaFolders(req.mediaFolders, req.projectDir, known, signal);
  const library = [...Object.values(req.project.media).filter((m) => m.id !== narration.id && m.id !== original.id && m.id !== music?.id && !m.derived), ...scan.assets];

  progress(0.6, 'Building the edit');
  const base = Object.values(req.project.sequences)[0]?.settings;
  const settings: SequenceSettings = { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, sampleRate: 48000, ...base, ...req.settings };
  const versions = Object.values(req.project.sequences).filter((s) => s.production).length;
  const name = req.name ?? `Auto v${versions + 1}`;
  const built = buildSequence({ name, settings, script, alignment, narration, narrationLufs: na.integratedLufs, music, musicLufs: ma?.integratedLufs ?? null, library, prefs: req.prefs, pcorePlacement: req.pcorePlacement });

  // render procedural compositions (cached by spec hash) so they behave like ordinary media
  const pcoreNotes: string[] = [];
  if (!req.renderPCore) {
    const pc = new Set(built.generated.filter((g) => g.pcore).map((g) => g.id));
    if (pc.size) {
      for (const t of built.sequence.tracks) t.clips = t.clips.filter((c) => !pc.has(c.mediaId));
      pcoreNotes.push('P-CORE not rendered: no 3D renderer in this context (run inside the app)');
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
      progress(0.65 + 0.15 * (done / Math.max(1, built.generated.length)), `Rendering motion design & sound (${done + 1}/${built.generated.length})`);
      g.path = g.sfx ? await renderSfx(g.sfx, cacheDir, signal) : await renderGenerator(g.generator!, { width: settings.width, height: settings.height, rate, audioPath: narration.path, cacheDir, signal });
      g.fingerprint = await fingerprintFile(g.path);
      if (g.sfx) g.probe = (await probeMedia(g.path, signal)).probe;
      g.relativePath = path.relative(req.projectDir, g.path);
      done++;
    }
  };
  // each FFmpeg render is itself multi-threaded: one worker per ~3 hardware threads (2–4)
  const workers = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 3)));
  if (toRender.length) await Promise.all(Array.from({ length: workers }, () => worker()));
  for (const [i, g] of pcoreQueue.entries()) {
    progress(0.72 + 0.08 * (i / pcoreQueue.length), `Rendering P-CORE (${i + 1}/${pcoreQueue.length})`);
    try {
      g.path = await req.renderPCore!(g, narration, settings, signal);
      g.fingerprint = await fingerprintFile(g.path);
      g.relativePath = path.relative(req.projectDir, g.path);
    } catch (e) {
      if (signal?.aborted) throw e;
      // P-CORE must never break a production: leave it out and say why
      const failed = new Set(pcoreQueue.slice(i).map((x) => x.id));
      for (const t of built.sequence.tracks) t.clips = t.clips.filter((c) => !failed.has(c.mediaId));
      pcoreNotes.push(`P-CORE left out: ${(e as Error).message}`);
      break;
    }
  }

  progress(0.8, 'Quality control');
  const mediaMap: Record<string, MediaAsset> = { ...req.project.media, ...Object.fromEntries([...scan.assets, ...built.generated, narration].map((a) => [a.id, a])) };
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
    voice: voice && {
      mediaId: voice.mediaId,
      originalId: voice.originalId,
      steps: voice.steps,
      before: { noiseFloorDb: voice.before.noiseFloorDb, snrDb: voice.before.snrDb, humHz: voice.before.humHz, lufs: voice.beforeLufs },
      after: { noiseFloorDb: voice.after.noiseFloorDb, snrDb: voice.after.snrDb, humHz: voice.after.humHz, lufs: voice.afterLufs },
      latencyMs: voice.latencyMs,
    },
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
    newMedia: [...scan.assets, ...built.generated, ...(narration !== original ? [narration] : [])].filter((a) => used.has(a.id)),
    timings: alignment.sentences.map((a) => ({ index: a.index, start: a.start, end: a.end, text: script.sentences[a.index]?.text ?? '' })),
    report: { sentences: script.sentences.length, beats: built.beats.length, shots: built.shots.length, alignment: { method: alignment.method, confidence: alignment.confidence }, fixes, scanErrors: scan.errors, notes: [...script.notes, ...voiceNotes, ...pcoreNotes], entities, voice, scriptImport: imported ? { title: imported.title, sections: imported.sectionTargets.length, repairs: imported.repairs.length } : undefined },
  };
}
