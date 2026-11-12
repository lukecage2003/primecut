import fs from 'node:fs';
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

describe('segmented export', () => {
  it('renders in segments, joins without re-encoding, matches the single-pass result and resumes', async () => {
    const { makeColorClip, frameColor } = await import('./fixtures');
    const dir = tmpDir();
    const red = await importMediaFile(await makeColorClip(path.join(dir, 'red.mp4'), 'red', 3));
    const blue = await importMediaFile(await makeColorClip(path.join(dir, 'blue.mp4'), 'blue', 3, { freq: 880 }));
    let p: Project = createProject('seg', { width: 320, height: 180, frameRate: { num: 30, den: 1 } });
    p = { ...p, media: { [red.id]: red, [blue.id]: blue } };
    const h = new History(p);
    h.commit('place', (d) => {
      const seq = d.sequences[d.activeSequenceId]!;
      placeMedia(seq, d.media[red.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' });
      placeMedia(seq, d.media[blue.id]!, { videoTrack: 0, audioTrack: 0, start: 90, mode: 'overwrite' });
      placeMedia(seq, d.media[red.id]!, { videoTrack: 0, audioTrack: 0, start: 180, mode: 'overwrite' });
      seq.captions = [{ id: 'c1', start: 40, end: 140, text: 'Sous-titre à cheval', style: 'subtitle' }];
    });
    const out = path.join(dir, 'seg.mp4');
    // interrupted export: finished segments are kept…
    const ac = new AbortController();
    await expect(
      exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out, segmentSeconds: 2, signal: ac.signal, onProgress: (f) => f > 0.3 && ac.abort() }),
    ).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    // …and reused when the export is started again
    const logs: string[] = [];
    const res = await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out, segmentSeconds: 2, cacheDir: path.join(dir, 'Cache'), onLog: (l) => logs.push(l) });
    expect(logs.some((l) => l.includes('reused'))).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.frames).toBe(270);
    const [r1] = await frameColor(out, 1.5);
    const [, , b2] = await frameColor(out, 4.5);
    const [r3] = await frameColor(out, 7.5);
    expect(r1).toBeGreaterThan(150);
    expect(b2).toBeGreaterThan(150);
    expect(r3).toBeGreaterThan(150);
    // audio covers the whole video with the right tones
    const single = path.join(dir, 'single.mp4');
    await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: single, segmentSeconds: 0 });
    const tone = async (f: string, a: number, b: number, freq: number) => bandRmsDb(f, a, b, freq);
    expect(Math.abs((await tone(out, 4, 5, 880)) - (await tone(single, 4, 5, 880)))).toBeLessThan(1);
    expect(fs.existsSync(path.join(dir, '.seg.segments'))).toBe(false); // cleaned after success
  });
});

describe('transparent overlays', () => {
  it('composites a VP9 alpha clip (P-CORE format) over V1 with its transparency', async () => {
    const dir = tmpDir();
    const { makeColorClip, frameColor } = await import('./fixtures');
    const bgFile = await makeColorClip(path.join(dir, 'blue.mp4'), 'blue', 2);
    const ov = path.join(dir, 'overlay.webm');
    // 200×200 transparent square with an opaque yellow disc-ish box in the centre
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', "color=c=black:s=200x200:d=2:r=30,format=rgba,geq=r='255*between(X,50,150)*between(Y,50,150)':g='255*between(X,50,150)*between(Y,50,150)':b=0:a='255*between(X,50,150)*between(Y,50,150)'", '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', ov]);
    const bg = await importMediaFile(bgFile);
    const o = { ...(await importMediaFile(ov)), hasAlpha: true };
    let p: Project = createProject('alpha', { width: 320, height: 180, frameRate: { num: 30, den: 1 } });
    p = { ...p, media: { [bg.id]: bg, [o.id]: o } };
    const h = new History(p);
    h.commit('place', (d) => {
      const seq = d.sequences[d.activeSequenceId]!;
      placeMedia(seq, d.media[bg.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' });
      placeMedia(seq, d.media[o.id]!, { videoTrack: 1, audioTrack: 1, start: 0, mode: 'overwrite' });
    });
    const out = path.join(dir, 'alpha.mp4');
    expect((await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out, segmentSeconds: 0 })).ok).toBe(true);
    // centre: yellow overlay; corner of the overlay square (transparent there): blue background shows
    const [r, g, b] = await frameColor(out, 1, 160, 90);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeGreaterThan(180);
    expect(b).toBeLessThan(90);
    const [r2, , b2] = await frameColor(out, 1, 85, 20);
    expect(b2).toBeGreaterThan(150);
    expect(r2).toBeLessThan(60);
  });
});

describe('voice cleanup', () => {
  it('chooses its steps from measurements, removes hum/rumble/noise, keeps timing, never touches the original', async () => {
    const { cleanVoice } = await import('../../src/engine/voice');
    const { analyzeAudio } = await import('../../src/engine');
    const dir = tmpDir();
    const raw = path.join(dir, 'raw-voice.wav');
    // voice-like: harmonics 180·k Hz with syllable modulation, phrases 1–4 s and 5.5–9 s; pauses elsewhere
    const voice = "aevalsrc='(0.25*sin(2*PI*180*t)+0.2*sin(2*PI*360*t)+0.12*sin(2*PI*720*t)+0.06*sin(2*PI*1440*t)+0.03*sin(2*PI*2880*t))*(0.55+0.45*sin(2*PI*4*t))*(between(t,1,4)+between(t,5.5,9))':s=48000:d=10";
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', voice, '-f', 'lavfi', '-i', 'anoisesrc=d=10:c=white:r=48000:a=0.012:seed=5', '-f', 'lavfi', '-i', 'sine=f=50:r=48000:d=10', '-f', 'lavfi', '-i', 'sine=f=18:r=48000:d=10',
      '-filter_complex', '[2:a]volume=0.25[h];[3:a]volume=1.2[r];[0:a][1:a][h][r]amix=inputs=4:normalize=0', '-ar', '48000', raw]);
    const before = fs.readFileSync(raw);
    const media = await importMediaFile(raw, dir);
    const na = await analyzeAudio(raw, { noiseDb: -30 });
    const r = await cleanVoice(media, path.join(dir, 'Cache'), { targetLufs: -16, silences: na.silences });
    const ids = r.steps.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['highpass', 'hum', 'denoise', 'compress', 'level']));
    expect(r.before.humHz).toBe(50);
    expect(r.after.snrDb).toBeGreaterThan(r.before.snrDb + 8);
    expect(r.after.rumbleShare).toBeLessThan(r.before.rumbleShare / 10);
    expect(Math.abs(r.afterLufs! - -16)).toBeLessThanOrEqual(1);
    // hum in a pause, relative to the voice band in a phrase: at least 15 dB lower than before
    const rel = async (f: string) => (await bandRmsDb(f, 4.3, 5.2, 50)) - (await bandRmsDb(f, 2, 3.5, 360));
    expect((await rel(r.path)) - (await rel(raw))).toBeLessThan(-15);
    // timing preserved: envelope cross-correlation peaks at lag 0 (±10 ms)
    const env = async (f: string) => {
      const { stdout } = await ffmpeg(['-v', 'error', '-i', f, '-af', 'highpass=f=150,lowpass=f=3000', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { collectStdout: true });
      const s = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
      const out: number[] = [];
      for (let i = 0; i + 80 <= s.length; i += 80) {
        let a = 0;
        for (let k = 0; k < 80; k++) a += Math.abs(s[i + k]!);
        out.push(a / 80);
      }
      return out;
    };
    const a = await env(raw);
    const b = await env(r.path);
    const corr = (lag: number) => {
      let acc = 0;
      for (let i = 50; i < Math.min(a.length, b.length) - 50; i++) acc += a[i]! * b[i + lag]!;
      return acc;
    };
    const lags = Array.from({ length: 41 }, (_, k) => k - 20);
    const best = lags.reduce((x, y) => (corr(y) > corr(x) ? y : x));
    expect(Math.abs(best)).toBeLessThanOrEqual(1);
    // the recording is untouched; a second run is served from the cache
    expect(fs.readFileSync(raw).equals(before)).toBe(true);
    expect((await cleanVoice(media, path.join(dir, 'Cache'), { targetLufs: -16, silences: na.silences })).cached).toBe(true);
  });
});

describe('pause detection on long narrations', () => {
  it('finds the pauses at the start of a 7-minute recording, not only the last ones', async () => {
    const { analyzeAudio } = await import('../../src/engine');
    const dir = tmpDir();
    const f = path.join(dir, 'long.wav');
    // 2 s of tone, 0.5 s of silence, repeated for 420 s
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)*lt(mod(t,2.5),2)':s=16000:d=420", f]);
    const a = await analyzeAudio(f);
    expect(a.silences.length).toBeGreaterThanOrEqual(160);
    expect(a.silences[0]!.start).toBeLessThan(3);
    expect(a.integratedLufs).not.toBeNull();
  }, 120000);
});
