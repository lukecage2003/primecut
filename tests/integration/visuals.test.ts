/** Primestone Visuals: every composition renders, is never black, and reacts to the real voice. */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type VisualKind, VISUAL_KINDS } from '../../src/core';
import { ffmpeg, ffprobe, renderGenerator, voiceEnvelope } from '../../src/engine';
import { makeNarration, tmpDir } from './fixtures';

let dir: string;
let narr: { file: string; truth: { start: number; end: number }[] };

beforeAll(async () => {
  dir = tmpDir('ps-vis-');
  narr = await makeNarration(dir, ['Tony Stark construit une intelligence artificielle.', 'Ultron se retourne contre lui!'], 1.2);
}, 120000);

async function lumaCentre(file: string, t: number): Promise<number> {
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'crop=iw/8:ih/8:iw*7/16:ih*7/16,scale=1:1,format=gray', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true });
  return stdout[0]!;
}

describe('Primestone Visuals', () => {
  it('voice envelope follows speech and pauses', async () => {
    const env = await voiceEnvelope(narr.file, 0, narr.truth[1]!.end + 0.5, 30);
    const at = (t: number) => env[Math.round(t * 30)]!;
    expect(at(0.3)).toBeLessThan(0.1); // lead-in silence
    expect(at((narr.truth[0]!.start + narr.truth[0]!.end) / 2)).toBeGreaterThan(0.3);
    expect(at(narr.truth[0]!.end + 0.9)).toBeLessThan(at((narr.truth[0]!.start + narr.truth[0]!.end) / 2) / 2); // pause
  });

  it('renders every composition kind (valid, exact length, not black)', async () => {
    for (const { id } of VISUAL_KINDS) {
      const f = await renderGenerator(
        { kind: id as VisualKind, style: 'gold', seed: 5, intensity: 0.7, durationSec: 2, title: 'Iron Man', subtitle: 'Marvel Comics · Personnage', items: ['1963', '2008'], audio: { mediaId: 'n', offsetSec: narr.truth[0]!.start } },
        { width: 640, height: 360, rate: '30/1', audioPath: narr.file, cacheDir: dir },
      );
      const j = JSON.parse((await ffprobe(['-v', 'error', '-count_packets', '-print_format', 'json', '-show_streams', f])).stdout.toString());
      expect(Number(j.streams[0].nb_read_packets), id).toBe(60);
      const { stdout } = await ffmpeg(['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true });
      expect(Math.max(...stdout), id).toBeGreaterThan(80); // visible graphic elements
    }
  }, 300000);

  it('the holographic core is brighter while the narrator speaks than during a pause', async () => {
    const start = narr.truth[0]!.start - 0.5;
    const dur = narr.truth[1]!.start + 0.4 - start;
    const f = await renderGenerator({ kind: 'audio-hud', style: 'gold', seed: 9, intensity: 0.7, durationSec: dur, audio: { mediaId: 'n', offsetSec: start } }, { width: 640, height: 360, rate: '30/1', audioPath: narr.file, cacheDir: dir });
    const speaking = await lumaCentre(f, (narr.truth[0]!.start + narr.truth[0]!.end) / 2 - start);
    const pause = await lumaCentre(f, narr.truth[0]!.end + 1.0 - start);
    expect(speaking - pause).toBeGreaterThan(15);
    void path;
  }, 120000);
});
