/**
 * P-CORE V2 demonstration through the REAL pipeline (Script-to-Video + director + V2 renderer + export).
 * Run: npm run pcore:demo -- <narration> <script.md | -> <outDir> [--format 16:9|9:16|1:1] [--preset classic|cinematic|cosmic|minimal|revelation|hud]
 *      [--transcript words.json] (word timings from the local transcription; with '-' as script, the narration becomes the script)
 *      [--quality preview|standard|high|final] [--start s --end s] (excerpt)
 * Writes <outDir>/pcore-v2-demo-<format>.mp4 and direction.json (the director's cues with their reasons).
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { createProject } from '../../src/core';
import { DEFAULT_PREFERENCES } from '../../src/production';
import { exportSequence, ffmpeg, importMediaFile, produceVideo } from '../../src/engine';
import { renderPCoreAsset, lastRenderStats } from '../../src/main/pcoreRender';
import { presetSettings, type PresetId } from '../../src/pcore/v2/config';
import type { PCoreQuality } from '../../src/pcore/quality';

if (process.env.PRIMESTONE_SOFTWARE_GL === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
app.on('window-all-closed', () => undefined);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--no-sandbox'));
const flag = (k: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
const [narrationFile, scriptFile, outDir] = pos as [string, string, string];
const SIZES: Record<string, { width: number; height: number }> = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 } };

app.whenReady().then(async () => {
  try {
    const format = flag('--format') ?? '16:9';
    const preset = (flag('--preset') ?? 'classic') as PresetId;
    const size = SIZES[format]!;
    const pdir = path.join(outDir, `projet-${format.replace(':', 'x')}`);
    fs.mkdirSync(pdir, { recursive: true });
    const project = createProject('Démo P-CORE V2', { ...size, frameRate: { num: 30, den: 1 } });
    // excerpt: the narration window is cut into a WAV (the original file is only read) and the words shifted
    const from = flag('--start') ? Number(flag('--start')) : null;
    const to = flag('--end') ? Number(flag('--end')) : null;
    let narrPath = narrationFile;
    let words = flag('--transcript') ? (JSON.parse(fs.readFileSync(flag('--transcript')!, 'utf8')) as { words: { text: string; start: number; end: number }[] }).words : null;
    if (from !== null && to !== null) {
      narrPath = path.join(pdir, `extrait-${from}-${to}.wav`);
      await ffmpeg(['-v', 'error', '-y', '-ss', String(from), '-to', String(to), '-i', narrationFile, '-c:a', 'pcm_s16le', narrPath]);
      words = words?.filter((w) => w.start >= from && w.end <= to).map((w) => ({ ...w, start: +(w.start - from).toFixed(3), end: +(w.end - from).toFixed(3) })) ?? null;
    }
    const narr = await importMediaFile(narrPath, pdir);
    project.media[narr.id] = narr;
    const t0 = Date.now();
    const r = await produceVideo(
      {
        project,
        projectDir: pdir,
        script: scriptFile === '-' ? '' : fs.readFileSync(scriptFile, 'utf8'),
        transcript: words,
        narrationMediaId: narr.id,
        vocabulary: flag('--vocabulary')?.split(',').map((x) => x.trim()).filter(Boolean),
        mediaFolders: [],
        settings: size,
        prefs: { ...DEFAULT_PREFERENCES, pcore: 'hero', sfx: true, musicFromLibrary: false },
        pcoreEngine: 'v2',
        pcoreV2: presetSettings(preset),
        renderPCore: (a, n, st, sig) => renderPCoreAsset(a, n, st, path.join(pdir, 'Cache'), sig, (flag('--quality') as PCoreQuality | undefined) ?? 'high'),
      },
      (f, m) => console.log(`${Math.round(f * 100)}% ${m}`),
    );
    for (const m of r.newMedia) project.media[m.id] = m;
    project.sequences[r.sequence.id] = r.sequence;
    const out = path.join(outDir, `${flag('--name') ?? 'pcore-v2-demo'}-${format.replace(':', 'x')}.mp4`);
    await exportSequence({ project, sequenceId: r.sequence.id, output: out });
    const pc = r.sequence.production!.pcore!;
    const clips = r.sequence.tracks.flatMap((t) => t.clips.filter((c) => project.media[c.mediaId]?.pcore).map((c) => ({ track: t.name, start: c.start / 30, dur: c.duration / 30, mode: project.media[c.mediaId]!.pcore!.mode })));
    fs.writeFileSync(path.join(outDir, `${flag('--name') ?? 'pcore-v2-demo'}-${format.replace(':', 'x')}-direction.json`), JSON.stringify({ preset, seconds: (Date.now() - t0) / 1000, usedText: pc.usedText, cues: pc.cues, log: pc.log, clips, lastRender: lastRenderStats, qc: r.sequence.production!.qcScore, notes: r.report.notes }, null, 2));
    console.log(`RESULT ${out} · ${pc.cues.length} réactions · ${clips.length} clips P-CORE · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    app.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    app.exit(1);
  }
});
