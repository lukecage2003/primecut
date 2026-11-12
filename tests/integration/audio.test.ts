import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { History, createProject, placeMedia, type Project } from '../../src/core';
import { exportSequence, ffmpeg, importMediaFile } from '../../src/engine';
import { tmpDir } from './fixtures';

/** RMS (dBFS) of the export in [t0,t1] after a band-pass around `freq`. */
async function bandRmsDb(file: string, t0: number, t1: number, freq: number): Promise<number> {
  const { stdout } = await ffmpeg(
    ['-v', 'error', '-ss', String(t0), '-t', String(t1 - t0), '-i', file, '-af', `bandpass=f=${freq}:width_type=q:w=8,bandpass=f=${freq}:width_type=q:w=8,aformat=sample_fmts=s16:channel_layouts=mono`, '-f', 's16le', 'pipe:1'],
    { collectStdout: true },
  );
  const s = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  let acc = 0;
  for (const v of s) acc += (v / 32768) ** 2;
  return 10 * Math.log10(acc / Math.max(1, s.length) + 1e-12);
}

describe('automatic ducking', () => {
  let dir: string;
  let voice: string;
  let music: string;
  beforeAll(async () => {
    dir = tmpDir();
    voice = path.join(dir, 'voice.wav');
    music = path.join(dir, 'music.wav');
    // "narration": 220 Hz on 0–2 s and 4–6 s, silence 2–4 s and 6–8 s
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=8', '-af', "volume='if(lt(mod(t,4),2),0.5,0)':eval=frame", '-ar', '48000', voice]);
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=1500:d=8', '-af', 'volume=0.3', '-ar', '48000', music]);
  });

  it('lowers the music by the set depth while the narration speaks, and only then', async () => {
    const v = await importMediaFile(voice);
    const m = await importMediaFile(music);
    let p: Project = createProject('duck');
    p = { ...p, media: { [v.id]: v, [m.id]: m } };
    const h = new History(p);
    h.commit('place', (d) => {
      const seq = d.sequences[d.activeSequenceId]!;
      placeMedia(seq, d.media[v.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' });
      placeMedia(seq, d.media[m.id]!, { videoTrack: 0, audioTrack: 1, start: 0, mode: 'overwrite' });
      const [a1, a2] = seq.tracks.filter((t) => t.kind === 'audio');
      a2!.duck = { by: a1!.id, depthDb: -12, attackMs: 100, releaseMs: 200, holdMs: 100, threshold: 0.05 };
    });
    const out = path.join(dir, 'ducked.mp4');
    const res = await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out, cacheDir: path.join(dir, 'Cache') });
    expect(res.ok).toBe(true);
    const speaking = await bandRmsDb(out, 0.6, 1.6, 1500);
    const pause = await bandRmsDb(out, 2.8, 3.6, 1500);
    const speaking2 = await bandRmsDb(out, 4.6, 5.6, 1500);
    expect(pause - speaking).toBeGreaterThan(10);
    expect(pause - speaking).toBeLessThan(14);
    expect(Math.abs(speaking2 - speaking)).toBeLessThan(1);
    // the narration itself is untouched
    const voiceLevel = await bandRmsDb(out, 0.6, 1.6, 220);
    const ref = await bandRmsDb(voice, 0.6, 1.6, 220);
    expect(Math.abs(voiceLevel - ref)).toBeLessThan(1.5);
  });
});
