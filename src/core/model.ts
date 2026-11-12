import type { Rational } from './time';

/** Current native project schema version. Bump together with a migration in migrations.ts. */
export const SCHEMA_VERSION = 2;

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
}

export interface ClipTransform {
  x: number; // pixels offset from centre
  y: number;
  scale: number; // 1 = fit to frame
  rotation: number; // degrees
  opacity: number; // 0..1
}

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

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
}

export interface Marker {
  id: string;
  frame: number;
  name: string;
  color: string;
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
  };
}

export function createProject(name: string, seqSettings?: Partial<SequenceSettings>): Project {
  const seq = createSequence('Sequence 01', seqSettings);
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
