import type { Rational } from './time';

/** Current native project schema version. Bump together with a migration in migrations.ts. */
export const SCHEMA_VERSION = 3;

export type MediaKind = 'video' | 'audio' | 'image';
export type TrackKind = 'video' | 'audio';

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  /** Nominal (r_frame_rate) rate. */
  frameRate: Rational;
  /** Average rate; differs from frameRate on VFR material. */
  avgFrameRate: Rational;
  isVFR: boolean;
  pixFmt: string;
  rotation: number;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface MediaProbe {
  durationSec: number;
  container: string;
  bitRate?: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
}

export interface MediaFingerprint {
  size: number;
  mtimeMs: number;
  /** sha256 of the first and last 64 KiB — used for relocation matching. */
  partialHash: string;
}

/**
 * Usage rights of a media item. Everything Primestone puts in an automatic edit carries its
 * provenance; only 'owned' and 'reusable' media may be published without a human decision.
 */
export type RightsUsage = 'owned' | 'user-provided' | 'reusable' | 'permission-required' | 'view-only' | 'unknown';

export interface MediaRights {
  usage: RightsUsage;
  source: string; // 'user-library' | provider id
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  sourceUrl?: string;
  checkedAt: string;
  note?: string;
}

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  /** Absolute path at the time of last successful resolution. Source files are never modified. */
  path: string;
  /** Path relative to the project file directory (used to relocate when a project folder moves). */
  relativePath?: string;
  fingerprint: MediaFingerprint;
  probe: MediaProbe;
  importedAt: string;
  /** Optional preview proxy (relative to the project cache dir). */
  proxy?: string;
  rights?: MediaRights;
  /** Procedural composition rendered by the engine (file at `path` is the cached render). */
  generator?: import('./generators').GeneratorSpec;
  /** The file carries a real alpha channel (verified when it was rendered). */
  hasAlpha?: boolean;
  /** P-CORE render description (voice-reactive presence; rendered by the P-CORE engine). */
  pcore?: PCoreClipSpec;
  /** Procedural sound effect rendered locally (Primestone SFX). */
  sfx?: SfxSpec;
  /** Processed copy of another media item (the original file is never modified). */
  derived?: { from: string; kind: 'voice-cleanup'; steps: string[] };
  /** Comics format of a still (cover, page, double page, webtoon, manga…) detected at import. */
  comic?: import('./comicFormat').ComicImageInfo;
  /** Perceptual fingerprint (dHash, 16 hex digits) used to recognise duplicate pictures. */
  phash?: string;
  /** Detected comic panels (normalised rects, reading order) for page-like stills. */
  panels?: { x: number; y: number; w: number; h: number }[];
  /** Free tags (user sidecar tags, detected entities) used by automatic media matching. */
  tags?: string[];
}

export interface ClipTransform {
  x: number; // pixels offset from centre
  y: number;
  scale: number; // 1 = fit to frame
  rotation: number; // degrees
  opacity: number; // 0..1
}

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export type MotionKind = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'panels';

/** Camera move inside the clip's frame (Ken Burns). `amount` = extra zoom (0.15 = 15%). */
export interface ClipMotion {
  kind: MotionKind;
  amount: number;
  /** For 'panels': viewing windows (normalised to the image) visited in order; the clip fills the frame. */
  path?: { x: number; y: number; w: number; h: number }[];
}

export const NO_MOTION: ClipMotion = { kind: 'none', amount: 0 };

export interface Clip {
  id: string;
  mediaId: string;
  name: string;
  /** Timeline start (frames, sequence timebase). */
  start: number;
  /** Duration on the timeline (frames). */
  duration: number;
  /** Source in-point, seconds. */
  sourceIn: number;
  /** Playback speed (1 = normal). Reserved; only 1 is supported by the editor today. */
  speed: number;
  /** Clips sharing a linkId are edited together (e.g. video + its audio). */
  linkId?: string;
  enabled: boolean;
  /** Audio gain in dB (audio clips). */
  gainDb: number;
  /** Video transform (video clips). */
  transform: ClipTransform;
  /** Fade from/to transparent (video) or silence (audio), in frames. */
  fadeIn: number;
  fadeOut: number;
  motion: ClipMotion;
  /** Background behind a clip that does not fill the frame (e.g. portrait comic page). */
  fill?: 'none' | 'blur';
}

export type TransitionKind = 'cross-dissolve';

/**
 * A transition sits on the cut between two adjacent clips of the same track, centred on the cut:
 * floor(duration/2) frames before it and the rest after it. Both clips need enough source handles.
 */
export interface Transition {
  id: string;
  kind: TransitionKind;
  leftClipId: string;
  rightClipId: string;
  duration: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  locked: boolean;
  /** Video: hidden (not rendered). Audio: muted. */
  disabled: boolean;
  /** Clips sorted by start, never overlapping. */
  clips: Clip[];
  transitions: Transition[];
  /** Audio: automatic ducking under another track (e.g. music under narration). */
  duck?: TrackDuck;
}

export interface TrackDuck {
  /** Track whose signal lowers this one. */
  by: string;
  /** Attenuation while the source is active (negative dB). */
  depthDb: number;
  attackMs: number;
  releaseMs: number;
  /** Stays down this long after the source stops (avoids pumping between words). */
  holdMs: number;
  /** Activity threshold on the source's peak level (0..1). */
  threshold: number;
}

export interface Marker {
  id: string;
  frame: number;
  name: string;
  color: string;
}

export type CaptionStyle = 'subtitle' | 'title' | 'lower-third' | 'placeholder';

/** Timed text burned into the picture (subtitles, section titles, lower thirds). */
export interface Caption {
  id: string;
  start: number; // frames
  end: number; // frames (exclusive)
  text: string;
  style: CaptionStyle;
}

export interface SequenceSettings {
  width: number;
  height: number;
  frameRate: Rational;
  sampleRate: number;
}

export interface Sequence {
  id: string;
  name: string;
  settings: SequenceSettings;
  /** Video tracks are listed bottom (V1) → top; audio tracks A1 → An. */
  tracks: Track[];
  markers: Marker[];
  captions: Caption[];
  /** Present on sequences produced by the Script-to-Video engine (report, explanations). */
  production?: ProductionMeta;
}

export interface ProductionShotMeta {
  start: number;
  end: number;
  mediaId: string | null;
  beat: number;
  quality: 'strong' | 'weak' | 'missing' | 'generated';
  reasons: string[];
  text: string;
}

export interface ProductionMeta {
  generatedAt: string;
  version: number;
  alignment: { method: string; confidence: number };
  preferencesVersion: number;
  qcScore: number;
  qcIssues: { severity: 'error' | 'warning' | 'info'; code: string; message: string; frame?: number }[];
  shots: ProductionShotMeta[];
  /** Style measured at generation time (baseline for preference learning). */
  style: Record<string, unknown>;
  narrationMediaId: string;
  /** Narration cleanup applied to this version (the clips can be switched back to the original). */
  voice?: ProductionVoice;
  /** Detected (or forced) narration format and the direction changes it caused. */
  narrationFormat?: ProductionNarrationFormat;
}

export interface ProductionNarrationFormat {
  kind: string;
  label: string;
  forced: boolean;
  detected: string;
  confidence: number;
  length: 'short' | 'standard' | 'documentaire';
  evidence: string[];
  changes: string[];
}

export interface VoiceMetrics {
  noiseFloorDb: number;
  snrDb: number;
  humHz: number | null;
  lufs: number | null;
}

export interface ProductionVoice {
  mediaId: string;
  originalId: string;
  steps: { id: string; reason: string }[];
  before: VoiceMetrics;
  after: VoiceMetrics;
  latencyMs?: number;
  swappable?: boolean;
}

export interface ExportSettings {
  container: 'mp4' | 'mov' | 'mkv';
  videoCodec: 'h264' | 'hevc';
  /** x264/x265 CRF; lower = higher quality. */
  crf: number;
  preset: 'slow' | 'medium' | 'fast';
  audioBitrateKbps: number;
  /** auto picks a working hardware encoder when available, falling back to CPU. */
  hardware: 'auto' | 'cpu';
  /** Also write the subtitles next to the video (.srt and .vtt). Default on. */
  subtitleFiles?: boolean;
}

export const DEFAULT_EXPORT: ExportSettings = {
  container: 'mp4',
  videoCodec: 'h264',
  crf: 18,
  preset: 'slow',
  audioBitrateKbps: 320,
  hardware: 'cpu',
};

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  media: Record<string, MediaAsset>;
  sequences: Record<string, Sequence>;
  activeSequenceId: string;
  exportSettings: ExportSettings;
  metadata: Record<string, string>;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function createTrack(kind: TrackKind, index: number): Track {
  return {
    id: newId(),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${index}`,
    locked: false,
    disabled: false,
    clips: [],
    transitions: [],
  };
}

export function createSequence(name: string, settings?: Partial<SequenceSettings>): Sequence {
  return {
    id: newId(),
    name,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      ...settings,
    },
    tracks: [createTrack('video', 1), createTrack('video', 2), createTrack('audio', 1), createTrack('audio', 2)],
    markers: [],
    captions: [],
  };
}

export function createProject(name: string, seqSettings?: Partial<SequenceSettings>): Project {
  const seq = createSequence('Séquence 01', seqSettings);
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: now,
    modifiedAt: now,
    media: {},
    sequences: { [seq.id]: seq },
    activeSequenceId: seq.id,
    exportSettings: { ...DEFAULT_EXPORT },
    metadata: {},
  };
}

export function videoTracks(seq: Sequence): Track[] {
  return seq.tracks.filter((t) => t.kind === 'video');
}

export function audioTracks(seq: Sequence): Track[] {
  return seq.tracks.filter((t) => t.kind === 'audio');
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function sequenceDuration(seq: Sequence): number {
  let end = 0;
  for (const t of seq.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function findClip(seq: Sequence, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of seq.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

/** Image stills have no intrinsic duration; this is the default length when placed. */
export const DEFAULT_STILL_SECONDS = 5;

export type SfxKind = 'whoosh' | 'impact' | 'tick';

export interface SfxSpec {
  kind: SfxKind;
  seed: number;
  durationSec: number;
}

export interface PCoreClipSpec {
  /** Narration window driving the animation. */
  audioMediaId: string;
  offsetSec: number;
  durationSec: number;
  /** Square render size (px). */
  size: number;
  composition: 'core' | 'floating' | 'minimal';
  seed: number;
  mode: 'hero' | 'side' | 'corner';
  /** Narrative/marker events (seconds on the narration). */
  events: { time: number; duration: number; state: 'reveal' | 'focus' | 'transition' | 'emphasis' | 'intense'; source: 'semantic' | 'marker'; label?: string }[];
}
