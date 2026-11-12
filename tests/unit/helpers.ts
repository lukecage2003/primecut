import { type MediaAsset, newId } from '../../src/core';

export function fakeMedia(opts: { name?: string; durationSec?: number; video?: boolean; audio?: boolean; kind?: 'video' | 'audio' | 'image' } = {}): MediaAsset {
  const { name = 'clip.mp4', durationSec = 10, video = true, audio = true, kind = 'video' } = opts;
  return {
    id: newId(),
    name,
    kind,
    path: `/media/${name}`,
    fingerprint: { size: 1000, mtimeMs: 0, partialHash: 'x' },
    importedAt: new Date(0).toISOString(),
    probe: {
      durationSec,
      container: 'mp4',
      video: video ? { codec: 'h264', width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, avgFrameRate: { num: 30, den: 1 }, isVFR: false, pixFmt: 'yuv420p', rotation: 0 } : undefined,
      audio: audio ? { codec: 'aac', sampleRate: 48000, channels: 2 } : undefined,
    },
  };
}
