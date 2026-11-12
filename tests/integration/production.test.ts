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
    expect(stages).toEqual(['Analysing narration', 'Synchronising text and voice', 'Indexing media', 'Building the edit', 'Quality control', expect.stringMatching(/QC score/)]);
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
