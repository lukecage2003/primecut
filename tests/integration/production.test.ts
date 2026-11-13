/**
 * Script-to-Video end-to-end on real files: synthetic narration (FFmpeg flite TTS) with known
 * sentence boundaries, real images, full pipeline, then a verified export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProject, framesToSeconds, validateProject } from '../../src/core';
import { DEFAULT_PREFERENCES, parseScript, alignByPauses, speechFromSilences } from '../../src/production';
import { analyzeAudio, exportSequence, ffmpeg, importMediaFile, produceVideo } from '../../src/engine';
import { audioRms, frameColor, makeNarration, tmpDir } from './fixtures';

const SENTENCES = [
  'Spider-Man affronte le Bouffon Vert.',
  'Le combat dure toute la nuit.',
  'Norman Osborn est enfin démasqué.',
  'Puis Venom entre en scène.',
];
const SCRIPT = `# Le Bouffon Vert\n\n${SENTENCES[0]} ${SENTENCES[1]}\n\n## Venom\n\n${SENTENCES[2]} [VISUEL: venom symbiote] ${SENTENCES[3]}`;

let dir: string;
let narrationFile: string;
const truth: { start: number; end: number }[] = [];

beforeAll(async () => {
  dir = tmpDir('ps-prod-');
  const n = await makeNarration(dir, SENTENCES);
  narrationFile = n.file;
  truth.push(...n.truth);
  // image library with descriptive names + one sidecar-tagged file
  const lib = path.join(dir, 'library');
  fs.mkdirSync(path.join(lib, 'covers'), { recursive: true });
  const img = (name: string, color: string, size = '1200x1800') => ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size},drawbox=c=${color}@0.6:t=fill`, '-frames:v', '1', path.join(lib, name)]);
  await img('spider-man-vs-bouffon-vert.png', 'red');
  await img('covers/norman_osborn.png', 'green', '1920x1080');
  await img('img_0042.png', 'purple');
  fs.writeFileSync(path.join(lib, 'img_0042.tags.txt'), 'Venom, symbiote');
  await img('combat-nuit.png', 'blue', '1920x1080');
}, 120000);

describe('narration analysis + alignment on real audio', () => {
  it('detects pauses and aligns sentences within 0.3 s of the truth', async () => {
    const a = await analyzeAudio(narrationFile);
    expect(a.integratedLufs).not.toBeNull();
    const speech = speechFromSilences(a.silences, a.duration);
    const al = alignByPauses(parseScript(SENTENCES.join(' ')).sentences, speech);
    expect(al.confidence).toBe(1);
    al.sentences.forEach((s, i) => {
      expect(Math.abs(s.start - truth[i]!.start)).toBeLessThan(0.3);
      expect(Math.abs(s.end - truth[i]!.end)).toBeLessThan(0.3);
    });
  });
});

describe('Script-to-Video', () => {
  it('produces a complete edit from script + narration + media folder and exports it', async () => {
    const project = createProject('Prod', { width: 640, height: 360, frameRate: { num: 30, den: 1 } });
    const narr = await importMediaFile(narrationFile, dir);
    project.media[narr.id] = narr;
    const stages: string[] = [];
    const res = await produceVideo(
      { project, projectDir: dir, script: SCRIPT, narrationMediaId: narr.id, mediaFolders: [path.join(dir, 'library')], prefs: { ...DEFAULT_PREFERENCES, shotTarget: 3, shotMin: 1.5 } },
      (_, m) => stages.push(m),
    );
    expect(stages.filter((x) => !x.startsWith('Rendu'))).toEqual(['Analyse de la narration', 'Nettoyage de la voix', 'Synchronisation du texte et de la voix', 'Indexation des médias', 'Construction du montage', 'Contrôle qualité', expect.stringMatching(/Contrôle qualité \d+/)]);
    // sound design: procedural SFX on their own track, rendered as real audio files
    const sfxTrack = res.sequence.tracks.find((t) => t.name === 'SFX');
    expect(sfxTrack?.clips.length).toBeGreaterThan(0);
    for (const c of sfxTrack!.clips) {
      const a = res.newMedia.find((m) => m.id === c.mediaId)!;
      expect(a.sfx).toBeTruthy();
      expect(a.probe.audio?.sampleRate).toBe(48000);
    }
    // voice cleanup: the edit plays a derived copy; the recording is untouched and still in the project
    const v = res.report.voice!;
    expect(v.originalId).toBe(narr.id);
    const cleaned = res.newMedia.find((m) => m.id === v.mediaId)!;
    expect(cleaned.derived).toEqual(expect.objectContaining({ from: narr.id, kind: 'voice-cleanup' }));
    expect(res.sequence.tracks.some((t) => t.clips.some((c) => c.mediaId === cleaned.id))).toBe(true);
    expect(res.sequence.tracks.some((t) => t.clips.some((c) => c.mediaId === narr.id))).toBe(false);
    expect(Math.abs((v.afterLufs ?? 0) - DEFAULT_PREFERENCES.narrationLufs)).toBeLessThanOrEqual(1);
    const seq = res.sequence;
    expect(res.report.alignment.confidence).toBe(1);
    expect(res.report.entities).toEqual(expect.arrayContaining(['Spider-Man', 'Green Goblin', 'Venom']));
    for (const m of res.newMedia) project.media[m.id] = m;
    project.sequences[seq.id] = seq;
    project.activeSequenceId = seq.id;
    expect(validateProject(project)).toEqual([]);
    const name = (id: string | null) => (id ? project.media[id]!.name : null);
    const shots = seq.production!.shots;
    expect(name(shots[0]!.mediaId)).toBe('spider-man-vs-bouffon-vert.png');
    expect(name(shots.find((s) => s.text.includes('Osborn'))!.mediaId)).toBe('norman_osborn.png');
    expect(name(shots.find((s) => s.text.includes('Venom'))!.mediaId)).toBe('img_0042.png'); // via sidecar tags + hint
    expect(project.media[shots[0]!.mediaId!]!.rights?.usage).toBe('user-provided');
    expect(seq.production!.qcIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(seq.production!.qcScore).toBeGreaterThanOrEqual(80);
    // the Venom shot starts within 0.4 s of the spoken sentence
    const venomShot = shots.find((s) => s.text.includes('Venom'))!;
    expect(Math.abs(framesToSeconds(venomShot.start, seq.settings.frameRate) - truth[3]!.start)).toBeLessThan(0.4);

    const out = path.join(dir, 'auto.mp4');
    const r = await exportSequence({ project, sequenceId: seq.id, output: out });
    expect(r.ok).toBe(true);
    const expectedEnd = framesToSeconds(seq.tracks[0]!.clips.at(-1)!.start + seq.tracks[0]!.clips.at(-1)!.duration, seq.settings.frameRate);
    expect(r.durationSec).toBeCloseTo(expectedEnd, 0);
    // narration audible during speech, picture not black mid-video, Ken Burns motion changes the image
    expect(await audioRms(out, truth[0]!.start + 0.2, truth[0]!.end - 0.2)).toBeGreaterThan(0.02);
    const mid = await frameColor(out, truth[1]!.start + 0.3);
    expect(mid.some((c) => c > 40)).toBe(true);
    // portrait pages are not pillarboxed: the left edge shows the blurred fill, not black
    expect(seq.tracks[0]!.clips[0]!.fill).toBe('blur');
    const { stdout: edge } = await ffmpeg(['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'crop=iw*0.08:ih*0.5:0:ih*0.25,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { collectStdout: true });
    expect(Math.max(edge[0]!, edge[1]!, edge[2]!)).toBeGreaterThan(60);
    const shot0End = framesToSeconds(shots[0]!.end, seq.settings.frameRate);
    const { stdout: a } = await ffmpeg(['-v', 'error', '-ss', '0.6', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { collectStdout: true });
    const { stdout: b } = await ffmpeg(['-v', 'error', '-ss', (shot0End - 0.2).toFixed(2), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { collectStdout: true });
    let diff = 0;
    for (let i = 0; i < a.length; i += 7) diff += Math.abs(a[i]! - b[i]!);
    expect(diff / (a.length / 7)).toBeGreaterThan(3);
    // subtitles burned in: bottom band contains bright text pixels during speech
    const { stdout: sub } = await ffmpeg(['-v', 'error', '-ss', (truth[1]!.start + 0.5).toFixed(2), '-i', out, '-frames:v', '1', '-vf', 'crop=iw:ih*0.12:0:ih*0.82', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { collectStdout: true });
    const noCaps = path.join(dir, 'auto-nocaps.mp4');
    const p2 = { ...project, sequences: { [seq.id]: { ...seq, captions: [] } } };
    await exportSequence({ project: p2, sequenceId: seq.id, output: noCaps });
    const { stdout: sub2 } = await ffmpeg(['-v', 'error', '-ss', (truth[1]!.start + 0.5).toFixed(2), '-i', noCaps, '-frames:v', '1', '-vf', 'crop=iw:ih*0.12:0:ih*0.82', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { collectStdout: true });
    let changed = 0;
    for (let i = 0; i < sub.length; i++) if (Math.abs(sub[i]! - sub2[i]!) > 60) changed++;
    expect(changed).toBeGreaterThan(200); // the subtitle changes hundreds of pixels in the bottom band
    if (process.env.PRIMESTONE_SHOTS) {
      for (const [k, t] of [['a', 1.0], ['b', truth[2]!.start + 0.5], ['c', truth[3]!.start + 0.8]] as const)
        await ffmpeg(['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', path.join(process.env.PRIMESTONE_SHOTS, `auto-${k}.png`)]);
    }
  });
});

describe('comic page read panel by panel', async () => {
  const { detectPagePanels } = await import('../../src/engine');
  const { History, placeMedia, windowFor } = await import('../../src/core');
  it('detects panels on a real page image and the export frames each panel in order', async () => {
    const pageFile = path.join(dir, 'page.png');
    // white page 1000x1500, 2x2 panels: red, green / blue, yellow
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1000x1500', '-vf',
      'drawbox=x=40:y=40:w=440:h=680:c=red:t=fill,drawbox=x=520:y=40:w=440:h=680:c=green:t=fill,drawbox=x=40:y=780:w=440:h=680:c=blue:t=fill,drawbox=x=520:y=780:w=440:h=680:c=yellow:t=fill',
      '-frames:v', '1', pageFile]);
    const panels = await detectPagePanels(pageFile, 1000, 1500);
    expect(panels).toHaveLength(4);
    const project = createProject('Pages', { width: 640, height: 360, frameRate: { num: 30, den: 1 } });
    const a = await importMediaFile(pageFile);
    project.media[a.id] = a;
    const h = new History(project);
    h.commit('place', (d) => {
      const s = d.sequences[d.activeSequenceId]!;
      placeMedia(s, d.media[a.id]!, { videoTrack: 0, audioTrack: 0, start: 0, mode: 'overwrite' });
      const c = s.tracks[0]!.clips[0]!;
      c.duration = 240; // 8 s, 2 s per panel
      c.motion = { kind: 'panels', amount: 0, path: panels!.map((p) => windowFor(p, 1000 / 1500, 16 / 9)) };
    });
    const out = path.join(dir, 'panels.mp4');
    await exportSequence({ project: h.present, sequenceId: h.present.activeSequenceId, output: out });
    const centre = async (t: number) => {
      const { stdout } = await ffmpeg(['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'crop=iw/4:ih/4:iw*3/8:ih*3/8,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { collectStdout: true });
      return [stdout[0]!, stdout[1]!, stdout[2]!] as [number, number, number];
    };

    const [r1, g1, b1] = await centre(0.6);
    expect(r1 > 200 && g1 < 60 && b1 < 60).toBe(true); // panel 1 red
    const [r2, g2] = await centre(2.6);
    expect(g2 > 100 && r2 < 60).toBe(true); // panel 2 green
    const [, , b3] = await centre(4.6);
    expect(b3).toBeGreaterThan(200); // panel 3 blue
    const [r4, g4, b4] = await centre(6.6);
    expect(r4 > 200 && g4 > 200 && b4 < 60).toBe(true); // panel 4 yellow
  });
});

describe('faceless production with no illustrations at all', () => {
  it('fills the whole video with rendered, voice-reactive compositions and exports it', async () => {
    const project = createProject('Faceless', { width: 640, height: 360, frameRate: { num: 30, den: 1 } });
    const narr = await importMediaFile(narrationFile, dir);
    project.media[narr.id] = narr;
    const res = await produceVideo({ project, projectDir: path.join(dir, 'faceless'), script: SCRIPT, narrationMediaId: narr.id, mediaFolders: [], prefs: { ...DEFAULT_PREFERENCES, shotTarget: 3, shotMin: 1.5 } });
    const seq = res.sequence;
    expect(seq.production!.shots.every((s) => s.quality === 'generated')).toBe(true);
    for (const m of res.newMedia) {
      expect(fs.existsSync(m.path)).toBe(true);
      project.media[m.id] = m;
    }
    expect(new Set(res.newMedia.filter((m) => m.generator).map((m) => m.generator!.kind)).size).toBeGreaterThanOrEqual(2);
    project.sequences[seq.id] = seq;
    project.activeSequenceId = seq.id;
    expect(validateProject(project)).toEqual([]);
    expect(seq.production!.qcIssues.filter((i) => i.severity === 'error')).toEqual([]);
    const out = path.join(dir, 'faceless.mp4');
    expect((await exportSequence({ project, sequenceId: seq.id, output: out })).ok).toBe(true);
    for (const t of [0.8, truth[1]!.start + 0.3, truth[3]!.start + 0.3]) {
      const { stdout } = await ffmpeg(['-v', 'error', '-ss', t.toFixed(2), '-i', out, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:1'], { collectStdout: true });
      expect(Math.max(...stdout)).toBeGreaterThan(80); // never a black screen
    }
  }, 300000);
});

describe('multi-format versions', () => {
  for (const [label, width, height] of [['4:5', 1080, 1350], ['1:1', 1080, 1080]] as const) {
    it(`generates a ${label} version re-composed for that frame (no gaps, compositions rendered at that size)`, async () => {
      const project = createProject('Fmt', { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } });
      const narr = await importMediaFile(narrationFile, dir);
      project.media[narr.id] = narr;
      const res = await produceVideo({ project, projectDir: dir, script: SCRIPT, narrationMediaId: narr.id, mediaFolders: [path.join(dir, 'library')], prefs: { ...DEFAULT_PREFERENCES, shotTarget: 3, shotMin: 1.5 }, settings: { width, height }, name: `Auto · ${label}` });
      expect(res.sequence.settings).toMatchObject({ width, height });
      expect(res.sequence.production!.qcIssues.filter((i) => i.code === 'gap' || i.code === 'missing-visual')).toEqual([]);
      for (const g of res.newMedia.filter((m) => m.generator)) {
        const { stdout } = await ffmpeg(['-v', 'error', '-i', g.path, '-frames:v', '1', '-f', 'null', '-'], { collectStdout: true }).then(() => ({ stdout: 'ok' }));
        expect(stdout).toBe('ok');
        expect(g.probe.video).toMatchObject({ width, height });
      }
    }, 240000);
  }
});

describe('comics format detection on real files', () => {
  it('detects a manga page (black & white, right to left), a colour page and a webtoon strip', async () => {
    const { scanMediaFolders } = await import('../../src/engine/production');
    const d = tmpDir('ps-comic-');
    const lib = path.join(d, 'lib');
    fs.mkdirSync(lib);
    // 2×2 panel pages: white gutters, filled panels
    const page = (file: string, fill: string, w: number, h: number, cols: number, rows: number) => {
      const boxes = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) boxes.push(`drawbox=x=${Math.round((c * w) / cols + 20)}:y=${Math.round((r * h) / rows + 20)}:w=${Math.round(w / cols - 40)}:h=${Math.round(h / rows - 40)}:c=${fill}:t=fill`);
      return ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${w}x${h}`, '-vf', boxes.join(','), '-frames:v', '1', path.join(lib, file)]);
    };
    await page('page-nb.png', '0x303030', 1400, 2000, 2, 2);
    await page('page-couleur.png', 'red', 1400, 2000, 2, 2);
    await page('strip.png', 'blue', 600, 4200, 1, 5);
    const scan = await scanMediaFolders([lib], d, new Set());
    const by = (n: string) => scan.assets.find((a) => a.name === n)!;
    expect(by('page-nb.png').comic).toMatchObject({ format: 'planche', manga: true, readingOrder: 'rtl' });
    expect(by('page-nb.png').panels![0]!.x).toBeGreaterThan(0.4); // first panel read is the top-right one
    expect(by('page-couleur.png').comic).toMatchObject({ format: 'planche', manga: false, readingOrder: 'ltr' });
    expect(by('page-couleur.png').panels![0]!.x).toBeLessThan(0.1);
    expect(by('strip.png').comic!.format).toBe('webtoon');
    expect(by('strip.png').panels!.length).toBeGreaterThanOrEqual(4);
  }, 60000);
});

describe('pause tightening', () => {
  it('shortens long pauses in a derived copy and keeps the edit in sync', async () => {
    const { planTighten, remapTime } = await import('../../src/production');
    const d = tmpDir('ps-tight-');
    const n = await makeNarration(d, SENTENCES, 1.6);
    const project = createProject('T', { width: 640, height: 360, frameRate: { num: 30, den: 1 } });
    const narr = await importMediaFile(n.file, d);
    project.media[narr.id] = narr;
    const res = await produceVideo({ project, projectDir: d, script: SCRIPT, narrationMediaId: narr.id, mediaFolders: [], prefs: { ...DEFAULT_PREFERENCES, tightenPauses: true, voiceCleanup: false } });
    const narrClip = res.sequence.tracks.flatMap((t) => t.clips).find((c) => res.newMedia.find((m) => m.id === c.mediaId)?.derived)!;
    const tight = res.newMedia.find((m) => m.id === narrClip.mediaId)!;
    expect(tight.name).toMatch(/pauses resserrées/);
    expect(tight.probe.durationSec).toBeLessThan(narr.probe.durationSec - 2.5); // 3 pauses of 1.6 s → 0.45 s
    expect(res.sequence.production!.qcIssues.some((i) => i.code === 'pauses')).toBe(true);
    // sentence starts follow the tightened voice (truth remapped through the same cuts)
    const { analyzeAudio } = await import('../../src/engine');
    const plan = planTighten((await analyzeAudio(n.file)).silences, narr.probe.durationSec);
    res.timings!.forEach((t, i) => expect(Math.abs(t.start - remapTime(n.truth[i]!.start, plan.keep))).toBeLessThan(0.3));
  }, 120000);
});

describe('comic archives (CBZ)', () => {
  it('extracts the pages in natural reading order, safely, and reads them like a folder of pages', async () => {
    const { scanMediaFolders } = await import('../../src/engine/production');
    const { execFileSync } = await import('node:child_process');
    const d = tmpDir('ps-cbz-');
    const work = path.join(d, 'work');
    fs.mkdirSync(path.join(work, 'Batman 676 (2008)', '__MACOSX'), { recursive: true });
    const pg = (file: string, fill: string) => ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1400x2000', '-vf', ['drawbox=x=20:y=20:w=660:h=960', 'drawbox=x=720:y=20:w=660:h=960', 'drawbox=x=20:y=1020:w=660:h=960', 'drawbox=x=720:y=1020:w=660:h=960'].map((b) => `${b}:c=${fill}:t=fill`).join(','), '-frames:v', '1', path.join(work, 'Batman 676 (2008)', file)]);
    await pg('page10.jpg', 'blue');
    await pg('page2.jpg', 'green');
    await pg('page1.jpg', 'red');
    fs.writeFileSync(path.join(work, 'Batman 676 (2008)', 'notes.txt'), 'pas une image');
    fs.writeFileSync(path.join(work, 'Batman 676 (2008)', '__MACOSX', '._page1.jpg'), 'x');
    const lib = path.join(d, 'lib');
    fs.mkdirSync(lib);
    const cbz = path.join(lib, 'Batman 676 (2008).cbz');
    execFileSync('zip', ['-q', '-r', cbz, 'Batman 676 (2008)'], { cwd: work });
    // a hostile entry name must never be written outside the cache
    fs.mkdirSync(path.join(work, 'x', 'y'), { recursive: true });
    fs.copyFileSync(path.join(work, 'Batman 676 (2008)', 'page1.jpg'), path.join(work, 'x', 'evil.jpg'));
    execFileSync('zip', ['-q', cbz, '../evil.jpg'], { cwd: path.join(work, 'x', 'y') });
    const before = fs.readFileSync(cbz);
    const scan = await scanMediaFolders([lib], d, new Set());
    expect(scan.errors).toEqual([]);
    const pages = scan.assets.map((a) => a.name).sort();
    expect(pages).toEqual(['Batman 676 (2008) p001.jpg', 'Batman 676 (2008) p002.jpg', 'Batman 676 (2008) p003.jpg']);
    // natural order, byte-identical pages: page1 → p001, page2 → p002, page10 → p003
    const src = (n: string) => fs.readFileSync(path.join(work, 'Batman 676 (2008)', n));
    const out = (p: string) => fs.readFileSync(scan.assets.find((a) => a.name === `Batman 676 (2008) ${p}.jpg`)!.path);
    expect([out('p001').equals(src('page1.jpg')), out('p002').equals(src('page2.jpg')), out('p003').equals(src('page10.jpg'))]).toEqual([true, true, true]);
    expect(fs.existsSync(path.join(d, 'Cache', 'evil.jpg')) || fs.existsSync(path.join(d, 'evil.jpg'))).toBe(false);
    const p1 = scan.assets.find((a) => a.name.endsWith('p002.jpg'))!;
    expect(p1.comic).toBeTruthy();
    expect(p1.comic?.format).toBe('planche');
    expect(p1.tags).toEqual(expect.arrayContaining(['Batman 676 (2008)', 'page 2']));
    expect(fs.readFileSync(cbz).equals(before)).toBe(true);
    // second scan: served from the cache, same pages
    expect((await scanMediaFolders([lib], d, new Set())).assets).toHaveLength(3);
  }, 120000);
});

describe('duplicate pictures in the library', () => {
  it('a resized, recompressed copy is recognised and never shown right after the original', async () => {
    const { scanMediaFolders } = await import('../../src/engine/production');
    const d = tmpDir('ps-dup-');
    const lib = path.join(d, 'lib');
    fs.mkdirSync(lib);
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1600x2400', '-frames:v', '1', path.join(lib, 'spider-man-cover.png')]);
    await ffmpeg(['-v', 'error', '-i', path.join(lib, 'spider-man-cover.png'), '-vf', 'scale=800:1200', '-q:v', '8', path.join(lib, 'spider-man-cover-copie.jpg')]);
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=1600x2400', '-frames:v', '1', path.join(lib, 'spider-man-ville.png')]);
    const scan = await scanMediaFolders([lib], d, new Set());
    const { hamming } = await import('../../src/core');
    const h = (n: string) => scan.assets.find((a) => a.name === n)!.phash!;
    expect(hamming(h('spider-man-cover.png'), h('spider-man-cover-copie.jpg'))).toBeLessThanOrEqual(6);
    expect(hamming(h('spider-man-cover.png'), h('spider-man-ville.png'))).toBeGreaterThan(12);
    // a long passage about Spider-Man needs several shots: the copy never follows the original
    const project = createProject('Dup', { width: 640, height: 360, frameRate: { num: 30, den: 1 } });
    const n = await makeNarration(d, ['Spider-Man veille sur la ville depuis les toits.', 'Spider-Man protège encore la ville cette nuit.', 'Spider-Man repart enfin vers les toits de la ville.']);
    const narr = await importMediaFile(n.file, d);
    project.media[narr.id] = narr;
    const res = await produceVideo({ project, projectDir: d, script: 'Spider-Man veille sur la ville depuis les toits. Spider-Man protège encore la ville cette nuit. Spider-Man repart enfin vers les toits de la ville.', narrationMediaId: narr.id, mediaFolders: [lib], prefs: { ...DEFAULT_PREFERENCES, shotTarget: 2, shotMin: 1, voiceCleanup: false, proceduralVisuals: false } });
    const names = res.sequence.tracks[0]!.clips.map((c) => res.newMedia.find((m) => m.id === c.mediaId)?.name ?? '');
    for (let i = 1; i < names.length; i++) {
      const pair = [names[i - 1], names[i]].sort().join('+');
      expect(pair).not.toBe('spider-man-cover-copie.jpg+spider-man-cover.png');
    }
    expect(names.length).toBeGreaterThanOrEqual(3);
  }, 120000);
});
