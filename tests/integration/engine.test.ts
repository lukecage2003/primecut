import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { History, createProject, moveClips, placeMedia, splitAt, trimClip, validateProject, type Project } from '../../src/core';
import {
  TaskOrchestrator,
  buildExportPlan,
  cacheDirs,
  exportSequence,
  findRecovery,
  importMediaFile,
  listBackups,
  makePeaks,
  makeProxy,
  makeThumbnail,
  needsProxy,
  readProjectFile,
  resolveMedia,
  saveProject,
  searchForMissing,
  writeAutosave,
  ProjectFileError,
  hardwareReport,
} from '../../src/engine';
import { audioRms, frameColor, makeColorClip, makeVfrClip, testVideoCodec, tmpDir } from './fixtures';

let dir: string;
let red: string, blue: string, vfr: string, png: string, wav: string;

beforeAll(async () => {
  dir = tmpDir();
  red = await makeColorClip(path.join(dir, 'red.mp4'), 'red', 2);
  blue = await makeColorClip(path.join(dir, 'blue.mp4'), 'blue', 2, { freq: 880 });
  vfr = await makeVfrClip(path.join(dir, 'vfr.mp4'));
  png = path.join(dir, 'still.png');
  const { ffmpeg } = await import('../../src/engine');
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=400x300', '-frames:v', '1', png]);
  wav = path.join(dir, 'tone.wav');
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=1.5', wav]);
});

describe('media import', () => {
  it('probes video, audio, stills and VFR', async () => {
    const a = await importMediaFile(red, dir);
    expect(a.kind).toBe('video');
    expect(a.probe.video).toMatchObject({ codec: (await testVideoCodec()).includes('libx264') ? 'h264' : 'vp9', width: 640, height: 360, frameRate: { num: 30, den: 1 } });
    expect(a.probe.audio?.sampleRate).toBe(48000);
    expect(a.probe.durationSec).toBeGreaterThan(1.9);
    expect(a.relativePath).toBe('red.mp4');
    expect(needsProxy(a)).toBe(false);

    const s = await importMediaFile(png);
    expect(s.kind).toBe('image');
    const w = await importMediaFile(wav);
    expect(w.kind).toBe('audio');
    expect(w.probe.video).toBeUndefined();

    const v = await importMediaFile(vfr);
    expect(v.probe.video?.isVFR).toBe(true);
    expect(needsProxy(v)).toBe(true);
  });

  it('rejects non-media files', async () => {
    const f = path.join(dir, 'note.txt');
    fs.writeFileSync(f, 'hello');
    await expect(importMediaFile(f)).rejects.toThrow();
  });

  it('creates thumbnails, peaks and proxies in the cache', async () => {
    const dirs = cacheDirs(path.join(dir, 'Cache'));
    const a = await importMediaFile(red);
    const thumb = await makeThumbnail(a, dirs);
    expect(thumb && fs.statSync(thumb).size).toBeGreaterThan(100);
    const peaks = await makePeaks(a, dirs);
    expect(peaks!.length).toBeGreaterThanOrEqual(195);
    expect(Math.max(...peaks!)).toBeGreaterThan(20); // lavfi sine peaks at 1/8 FS
    const v = await importMediaFile(vfr);
    let last = 0;
    const name = await makeProxy(v, dirs, (p) => (last = p));
    const proxied = await importMediaFile(path.join(dirs.proxies, name));
    expect(proxied.probe.video?.isVFR).toBe(false);
    expect(last).toBeGreaterThan(0);
  });
});

async function buildProject(): Promise<{ h: History; ids: Record<string, string> }> {
  const p = createProject('Integration', { width: 640, height: 360, frameRate: { num: 30, den: 1 } });
  const r = await importMediaFile(red, dir);
  const b = await importMediaFile(blue, dir);
  p.media[r.id] = r;
  p.media[b.id] = b;
  const h = new History(p);
  return { h, ids: { red: r.id, blue: b.id } };
}

describe('project storage', () => {
  it('saves, reopens identically, keeps backups and detects corruption', async () => {
    const { h, ids } = await buildProject();
    h.commit('place', (d) => placeMedia(d.sequences[d.activeSequenceId]!, d.media[ids.red!]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
    const projDir = path.join(dir, 'proj1');
    fs.mkdirSync(projDir);
    const file = path.join(projDir, 'Integration.psproj');
    await saveProject(file, h.present, 'test');
    const loaded = await readProjectFile(file);
    expect(loaded.issues).toEqual([]);
    const seqA = h.present.sequences[h.present.activeSequenceId]!;
    const seqB = loaded.project.sequences[loaded.project.activeSequenceId]!;
    expect(seqB.tracks).toEqual(seqA.tracks);

    await saveProject(file, h.present, 'test');
    expect((await listBackups(file)).length).toBe(1);

    const text = fs.readFileSync(file, 'utf8').replace('"Integration"', '"Tampered"');
    fs.writeFileSync(file, text);
    await expect(readProjectFile(file)).rejects.toBeInstanceOf(ProjectFileError);
    fs.writeFileSync(file, '{"broken');
    await expect(readProjectFile(file)).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('autosave recovery is offered only when newer', async () => {
    const { h } = await buildProject();
    const projDir = path.join(dir, 'proj2');
    fs.mkdirSync(projDir);
    const file = path.join(projDir, 'P.psproj');
    await saveProject(file, h.present, 'test');
    expect(await findRecovery(file)).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await writeAutosave(file, { ...h.present, name: 'Autosaved' }, 'test');
    const rec = await findRecovery(file);
    expect(rec?.project.name).toBe('Autosaved');
    await saveProject(file, h.present, 'test');
    expect(await findRecovery(file)).toBeNull();
  });

  it('refuses projects from a newer schema', async () => {
    const { h } = await buildProject();
    const file = path.join(dir, 'future.psproj');
    await saveProject(file, { ...h.present, schemaVersion: 99 } as Project, 'test');
    await expect(readProjectFile(file)).rejects.toMatchObject({ kind: 'version' });
  });

  it('resolves moved media through relative paths and folder search', async () => {
    const src = path.join(dir, 'moving');
    fs.mkdirSync(path.join(src, 'media'), { recursive: true });
    const clip = await makeColorClip(path.join(src, 'media', 'm.mp4'), 'yellow', 1);
    const p = createProject('Move');
    const a = await importMediaFile(clip, src);
    p.media[a.id] = a;
    const file = path.join(src, 'Move.psproj');
    await saveProject(file, p, 'test');
    const dest = path.join(dir, 'moved');
    fs.renameSync(src, dest);
    const loaded = await readProjectFile(path.join(dest, 'Move.psproj'));
    const res = await resolveMedia(loaded.project, path.join(dest, 'Move.psproj'));
    expect(res[0]).toMatchObject({ status: 'relocated', path: path.join(dest, 'media', 'm.mp4') });

    const elsewhere = path.join(dir, 'elsewhere', 'deep');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.renameSync(path.join(dest, 'media', 'm.mp4'), path.join(elsewhere, 'm.mp4'));
    const res2 = await resolveMedia(loaded.project, path.join(dest, 'Move.psproj'));
    expect(res2[0]!.status).toBe('missing');
    const found = await searchForMissing(Object.values(loaded.project.media), path.join(dir, 'elsewhere'));
    expect(found[a.id]).toBe(path.join(elsewhere, 'm.mp4'));
  });
});

describe('export', () => {
  it('renders a cut/moved timeline frame-exactly with correct picture and sound', async () => {
    const { h, ids } = await buildProject();
    const seq = (d: Project) => d.sequences[d.activeSequenceId]!;
    // red 0..60, blue 60..120 ; split red at 30, move second red half to 120 (after blue)
    h.commit('red', (d) => placeMedia(seq(d), d.media[ids.red!]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
    h.commit('blue', (d) => placeMedia(seq(d), d.media[ids.blue!]!, { videoTrack: 0, audioTrack: 0, start: 60, mode: 'overwrite' }));
    h.commit('split', (d) => splitAt(seq(d), 30));
    const redTail = seq(h.present).tracks[0]!.clips[1]!.id;
    h.commit('move', (d) => moveClips(seq(d), [redTail], 90)); // 30..60 -> 120..150
    const blueId = seq(h.present).tracks[0]!.clips.find((c) => c.start === 60)!.id;
    h.commit('mute blue', (d) => {
      const a = seq(d).tracks[2]!.clips.find((c) => c.start === 60)!;
      a.gainDb = -60;
    });
    void blueId;
    expect(validateProject(h.present)).toEqual([]);

    const out = path.join(dir, 'out', 'export.mp4');
    let progress = 0;
    const result = await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out, onProgress: (p) => (progress = p) });
    expect(result.ok).toBe(true);
    expect(result.frames).toBe(150);
    expect(progress).toBe(1);
    expect(fs.existsSync(out)).toBe(true);

    const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 60 && b! < 60;
    const isBlue = ([r, g, b]: number[]) => b! > 200 && r! < 60 && g! < 60;
    const isBlack = ([r, g, b]: number[]) => r! < 30 && g! < 30 && b! < 30;
    expect(isRed(await frameColor(out, 0.5))).toBe(true); // frame 15
    expect(isBlack(await frameColor(out, 1.5))).toBe(true); // gap 30..60
    expect(isBlue(await frameColor(out, 2.5))).toBe(true); // 60..120
    expect(isRed(await frameColor(out, 4.5))).toBe(true); // 120..150
    // audio: tone in red parts, silence in gap, ~silent (-60dB) blue
    expect(await audioRms(out, 0.1, 0.9)).toBeGreaterThan(0.03);
    expect(await audioRms(out, 1.1, 1.9)).toBeLessThan(0.01);
    expect(await audioRms(out, 2.1, 3.9)).toBeLessThan(0.01);
    expect(await audioRms(out, 4.1, 4.9)).toBeGreaterThan(0.03);
  });

  it('exports at 29.97 with trimmed clips and still images', async () => {
    const p = createProject('NTSC', { width: 640, height: 360, frameRate: { num: 30000, den: 1001 } });
    const r = await importMediaFile(red);
    const s = await importMediaFile(png);
    p.media[r.id] = r;
    p.media[s.id] = s;
    const h = new History(p);
    const seq = (d: Project) => d.sequences[d.activeSequenceId]!;
    const [vid] = h.commit('red', (d) => placeMedia(seq(d), d.media[r.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
    h.commit('trim', (d) => trimClip(seq(d), d.media, vid!, 'out', -20));
    h.commit('still', (d) => placeMedia(seq(d), d.media[s.id]!, { videoTrack: 1, audioTrack: 0, start: 40, mode: 'overwrite' }));
    const end = 40 + 149; // 5s still at 29.97 = floor(149.85)
    const out = path.join(dir, 'out', 'ntsc.mp4');
    const res = await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out });
    expect(res.frames).toBe(end);
    const [r1, g1] = await frameColor(out, 3);
    expect(g1).toBeGreaterThan(100);
    expect(r1).toBeLessThan(60);
  });

  it('refuses empty sequences and cleans up on cancel', async () => {
    const { h } = await buildProject();
    expect(() => buildExportPlan(h.present, h.present.sequences[h.present.activeSequenceId]!, 'x.mp4')).toThrow(/empty/);
    const { h: h2, ids } = await buildProject();
    h2.commit('red', (d) => placeMedia(d.sequences[d.activeSequenceId]!, d.media[ids.red!]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
    const ac = new AbortController();
    const out = path.join(dir, 'out', 'cancel.mp4');
    const pr = exportSequence({ project: h2.present, sequenceId: h2.present.activeSequenceId, output: out, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(pr).rejects.toThrow(/Cancel/);
    expect(fs.readdirSync(path.join(dir, 'out')).some((f) => f.includes('cancel'))).toBe(false);
  });
});

describe('task orchestrator', () => {
  it('respects priority, concurrency, dependencies, dedupe, cancel and verify', async () => {
    const orch = new TaskOrchestrator(1);
    const order: string[] = [];
    const mk = (name: string, ms = 20) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, ms));
      return name;
    };
    const a = orch.submit({ type: 't', label: 'a', run: mk('a') });
    const low = orch.submit({ type: 't', label: 'low', priority: 'low', run: mk('low') });
    const high = orch.submit({ type: 't', label: 'high', priority: 'high', run: mk('high') });
    const dep = orch.submit({ type: 't', label: 'dep', priority: 'high', dependsOn: [low.id], run: mk('dep') });
    const dup = orch.submit({ type: 't', label: 'low2', dedupeKey: 'k', run: mk('k1') });
    const dup2 = orch.submit({ type: 't', label: 'low3', dedupeKey: 'k', run: mk('k2') });
    expect(dup2.id).toBe(dup.id);
    await Promise.all([a.promise, low.promise, high.promise, dep.promise, dup.promise]);
    expect(order[0]).toBe('high'); // pump runs after all synchronous submits
    expect(order.indexOf('dep')).toBeGreaterThan(order.indexOf('low'));
    expect(order).not.toContain('k2');

    const bad = orch.submit({ type: 't', label: 'verify-fails', run: async () => 1, verify: () => { throw new Error('bad output'); } });
    await expect(bad.promise).rejects.toThrow('bad output');
    expect(orch.get(bad.id)!.state).toBe('failed');

    const long = orch.submit({ type: 't', label: 'long', run: (ctx) => new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    const after = orch.submit({ type: 't', label: 'after-dep', dependsOn: [long.id], run: mk('x') });
    await new Promise((r) => setTimeout(r, 10));
    orch.cancel(long.id);
    await expect(long.promise).rejects.toThrow();
    expect(orch.get(long.id)!.state).toBe('cancelled');
    await expect(after.promise).rejects.toThrow(/dependency/);
  });
});

describe('hardware', () => {
  it('produces a report without modifying anything', async () => {
    const r = await hardwareReport();
    expect(r.cpuThreads).toBeGreaterThan(0);
    expect(r.ffmpeg.version).toMatch(/ffmpeg/);
    expect(Array.isArray(r.hwEncoders)).toBe(true);
  });
});

describe('transitions & fades in export', async () => {
  const { addTransitionsAt, setClipFades, normalizeSequence } = await import('../../src/core');
  it('renders a cross-dissolve as a 50% mix at the cut and fades from black', async () => {
    const r = await makeColorClip(path.join(dir, 'red4.mp4'), 'red', 4);
    const b = await makeColorClip(path.join(dir, 'blue4.mp4'), 'blue', 4, { freq: 880 });
    const p = createProject('X', { width: 320, height: 180, frameRate: { num: 30, den: 1 } });
    const ra = await importMediaFile(r);
    const ba = await importMediaFile(b);
    p.media[ra.id] = ra;
    p.media[ba.id] = ba;
    const h = new History(p);
    const S = (d: Project) => d.sequences[d.activeSequenceId]!;
    // red 0..60 (source 0..2s, tail handle 2s) ; blue 60..120 with source starting at 1s (head handle 1s)
    h.commit('r', (d) => placeMedia(S(d), d.media[ra.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' }));
    h.commit('trim', (d) => trimClip(S(d), d.media, S(d).tracks[0]!.clips[0]!.id, 'out', -60));
    h.commit('b', (d) => placeMedia(S(d), d.media[ba.id]!, { videoTrack: 0, audioTrack: 0, start: 60, mode: 'overwrite' }));
    const blueV = S(h.present).tracks[0]!.clips[1]!.id;
    h.commit('trim b', (d) => trimClip(S(d), d.media, blueV, 'in', 30)); // blue now 90..180? keep adjacency below
    h.commit('move b', (d) => moveClips(S(d), [blueV], -30)); // back to 60, source in = 1s
    h.commit('dissolve', (d) => addTransitionsAt(S(d), d.media, 60, 30));
    h.commit('fade', (d) => {
      setClipFades(S(d), S(d).tracks[0]!.clips[0]!.id, { fadeIn: 30 });
      normalizeSequence(S(d), d.media);
    });
    expect(validateProject(h.present)).toEqual([]);
    expect(S(h.present).tracks[0]!.transitions[0]!.duration).toBe(30);
    const out = path.join(dir, 'out', 'dissolve.mp4');
    const res = await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out });
    expect(res.frames).toBe(150);
    const [r0, , b0] = await frameColor(out, 1 / 60); // frame 0 of a 30-frame fade from black
    expect(r0).toBeLessThan(30);
    expect(b0).toBeLessThan(30);
    const [rh] = await frameColor(out, 0.5 + 1 / 60); // frame 15: ~half
    expect(rh).toBeGreaterThan(90);
    expect(rh).toBeLessThan(170);
    const [rm, , bm] = await frameColor(out, 2 + 1 / 60); // frame 60: middle of the dissolve
    expect(rm).toBeGreaterThan(90);
    expect(rm).toBeLessThan(170);
    expect(bm).toBeGreaterThan(90);
    expect(bm).toBeLessThan(170);
    const [r3, , b3] = await frameColor(out, 3); // after the dissolve: blue
    expect(r3).toBeLessThan(40);
    expect(b3).toBeGreaterThan(200);
    // audio: both tones present during the crossfade, fade-in starts silent
    expect(await audioRms(out, 0, 0.1)).toBeLessThan(0.02);
    expect(await audioRms(out, 1.8, 2.2)).toBeGreaterThan(0.03);
  });
});
