/**
 * Production test campaign (reproducible). Runs the real Script-to-Video pipeline end to end on a
 * real script, a narration with ground-truth sentence timings, and a media library, then exports and
 * measures the result.
 *
 *   node .scratch/campaign.cjs --scenario <name> --script <file>[,<file>…] --out <dir>
 *        [--words N] [--media rich|sparse|none] [--size 1920x1080] [--range-sec S] [--narration wav --truth json]
 *
 * Narration: built with scripts/eval/make-narration.py (espeak-ng) unless --narration is given.
 * Transcription: used when PRIMESTONE_FW_PYTHON and PRIMESTONE_FW_MODEL point to faster-whisper.
 * Metrics: timings, sync error vs truth, QC, shot relevance proxy, repetition, black frames,
 * loudness/true peak, export verification, peak memory.
 *
 * WARNING (audit of 13/11/2026): with `--media rich|sparse` the library is made of synthetic pictures
 * NAMED FROM THE SCRIPT, so the "shot relevance proxy" is circular (it measures name matching against
 * names derived from the same text). It must not be read as visual relevance. The real protocol is
 * scripts/bench (human annotations on real pages and real productions): see docs/BENCHMARK.md.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createProject, framesToSeconds, type MediaAsset } from '../../src/core';
import { DEFAULT_PREFERENCES, EntityIndex, SEED_KNOWLEDGE, parseScript, scriptEntities } from '../../src/production';
import { analyzeNarration, exportSequence, ffmpeg, importMediaFile, produceVideo, readScriptDocument, transcribe } from '../../src/engine';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split(/\s--/)
    .map((x) => x.replace(/^--/, '').split(/\s+/))
    .map(([k, ...v]) => [k, v.join(' ')]),
) as Record<string, string>;

let peakRss = 0;
const mem = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 500);
const t = () => Date.now();
const secs = (a: number) => +((Date.now() - a) / 1000).toFixed(1);

async function lavfi(out: string, graph: string) {
  await ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', graph, '-frames:v', '1', out]);
}

const PALETTE = ['0x1b2a49', '0x6b1d1d', '0x123d2b', '0x3d2b5c', '0x5c4a12', '0x1d4f5c', '0x4a1d3d'];

/** Synthetic library: covers / pages / scenes named after the entities and comic references the script cites. */
async function makeLibrary(dir: string, markdown: string, mode: string): Promise<string[]> {
  if (mode === 'none') return [];
  fs.mkdirSync(dir, { recursive: true });
  const p = parseScript(markdown);
  const index = new EntityIndex([...SEED_KNOWLEDGE, ...scriptEntities(p)]);
  const names = new Map<string, number>();
  for (const s of p.sentences) for (const e of index.find(s.text)) if (e.entityId) names.set(e.name, (names.get(e.name) ?? 0) + 1);
  const refs = new Set<string>();
  for (const s of p.sentences) for (const src of s.sources) refs.add(src.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60).trim());
  for (const s of p.sentences) for (const h of s.hints) refs.add(h.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60).trim());
  const items = [...[...names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n), ...refs];
  const keep = mode === 'sparse' ? items.filter((_, i) => i % 4 === 0) : items;
  let k = 0;
  for (const name of keep.slice(0, 160)) {
    const c0 = PALETTE[k % PALETTE.length]!;
    const c1 = PALETTE[(k + 3) % PALETTE.length]!;
    const kind = k % 3;
    const file = path.join(dir, `${name}${kind === 0 ? ' cover' : kind === 1 ? ' page' : ''}.jpg`);
    if (kind === 0) await lavfi(file, `gradients=s=1000x1500:c0=${c0}:c1=${c1}:seed=${k},drawbox=x=80:y=1100:w=840:h=300:color=black@0.5:t=fill`);
    else if (kind === 1)
      // comic page with white gutters: 2×3 panels
      await lavfi(
        file,
        `color=c=white:s=1000x1500,drawbox=x=40:y=40:w=440:h=440:color=${c0}:t=fill,drawbox=x=520:y=40:w=440:h=440:color=${c1}:t=fill,drawbox=x=40:y=520:w=920:h=440:color=${c1}:t=fill,drawbox=x=40:y=1000:w=440:h=460:color=${c0}:t=fill,drawbox=x=520:y=1000:w=440:h=460:color=${c1}:t=fill`,
      );
    else await lavfi(file, `gradients=s=1920x1080:c0=${c1}:c1=${c0}:seed=${k}:type=radial`);
    k++;
  }
  return [dir];
}

async function measure(file: string) {
  const r = await ffmpeg(['-v', 'info', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.06', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], {}).catch((e) => e);
  const err = String((r as { stderr?: string }).stderr ?? '');
  const blacks = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: +m[1]!, end: +m[2]! }));
  const I = /I:\s+([-\d.]+) LUFS/.exec(err.split('Summary:').pop() ?? '')?.[1];
  const tp = /Peak:\s+([-\d.]+) dBFS/.exec(err.split('Summary:').pop() ?? '')?.[1];
  return { blacks, integratedLufs: I ? +I : null, truePeakDbfs: tp ? +tp : null };
}

(async () => {
  const out = path.resolve(args.out ?? '.scratch/campaign');
  const name = args.scenario ?? 'scenario';
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  const [W, H] = (args.size ?? '1920x1080').split('x').map(Number) as [number, number];
  const report: Record<string, unknown> = { scenario: name, size: `${W}x${H}`, startedAt: new Date().toISOString() };

  // 1. script(s)
  let t0 = t();
  const docs = await Promise.all(args.script!.split(',').map((f) => readScriptDocument(f.trim())));
  let markdown = docs.map((d) => d.imported.markdown).join('\n\n');
  if (args.words) {
    // keep whole paragraphs up to N words
    const paras = markdown.split(/\n\s*\n/);
    let n = 0;
    const kept: string[] = [];
    for (const p of paras) {
      if (n >= Number(args.words)) break;
      kept.push(p);
      if (!/^\s*(#|\[)/.test(p)) n += p.split(/\s+/).length;
    }
    markdown = kept.join('\n\n');
  }
  const parsed = parseScript(markdown);
  report.script = { files: docs.map((d) => path.basename(d.path)), sentences: parsed.sentences.length, words: parsed.sentences.reduce((a, s) => a + s.text.split(/\s+/).length, 0), sections: parsed.sections.length, repairs: docs.reduce((a, d) => a + d.imported.repairs.length, 0), importSec: secs(t0) };
  fs.writeFileSync(path.join(dir, 'script.md'), markdown);

  // 2. narration with ground truth
  t0 = t();
  let wav = args.narration;
  let truthFile = args.truth;
  if (!wav) {
    const sj = path.join(dir, 'sentences.json');
    fs.writeFileSync(sj, JSON.stringify(parsed.sentences.map((s, i) => ({ index: s.index, text: s.text, paragraphEnd: parsed.sentences[i + 1]?.paragraph !== s.paragraph }))));
    wav = path.join(dir, 'narration.wav');
    truthFile = path.join(dir, 'truth.json');
    if (!fs.existsSync(wav)) execFileSync('python3', [path.join(__dirname, '..', 'scripts', 'eval', 'make-narration.py'), sj, wav, truthFile], { stdio: 'inherit' });
  }
  // a real narration has no ground truth: sync is then judged against speech onsets (proxy)
  const truth: { index: number; start: number; end: number }[] = truthFile ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : [];
  report.narration = truthFile ? { seconds: +truth.at(-1)!.end.toFixed(1), ttsSec: secs(t0) } : { file: path.basename(wav), real: true };

  // 3. project + media
  const project = createProject(name, { width: W, height: H, frameRate: { num: 30, den: 1 } });
  const narr = await importMediaFile(wav, dir);
  project.media[narr.id] = narr;
  t0 = t();
  const folders = await makeLibrary(path.join(dir, 'library'), markdown, args.media ?? 'rich');
  report.library = { mode: args.media ?? 'rich', files: folders.length ? fs.readdirSync(folders[0]!).length : 0, makeSec: secs(t0) };

  // 4. optional local transcription (real product code path)
  let transcript = null;
  if (process.env.PRIMESTONE_FW_PYTHON && process.env.PRIMESTONE_FW_MODEL) {
    t0 = t();
    const tr = await transcribe(wav, { enabled: true, backend: 'faster-whisper', pythonPath: process.env.PRIMESTONE_FW_PYTHON, modelPath: process.env.PRIMESTONE_FW_MODEL, language: 'fr', device: 'cpu' }, path.join(dir, 'Cache'), {
      fingerprint: narr.fingerprint.partialHash,
    });
    transcript = tr.words;
    report.transcription = { engine: tr.engine, words: tr.words.length, seconds: tr.seconds, cached: tr.cached, realtimeFactor: +(tr.seconds / (report.narration as { seconds: number }).seconds).toFixed(3) };
  }

  // 5. production
  t0 = t();
  const stages: { at: number; msg: string }[] = [];
  const res = await produceVideo(
    { project, projectDir: dir, script: markdown, narrationMediaId: narr.id, mediaFolders: folders, prefs: DEFAULT_PREFERENCES, transcript },
    (_f, m) => {
      if (!stages.length || stages.at(-1)!.msg.split(' (')[0] !== m.split(' (')[0]) stages.push({ at: secs(t0), msg: m });
    },
  );
  const genSec = secs(t0);
  for (const m of res.newMedia) project.media[m.id] = m;
  project.sequences[res.sequence.id] = res.sequence;
  project.activeSequenceId = res.sequence.id;
  const seq = res.sequence;
  const r = seq.settings.frameRate;
  // sync vs truth
  const byIdx = new Map(res.timings!.map((x) => [x.index, x]));
  const errs = truth.map((tr) => Math.abs((byIdx.get(tr.index)?.start ?? NaN) - tr.start)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!truth.length) {
    // proxy: distance from each sentence start to the nearest speech onset (silence → speech)
    const na = await analyzeNarration(wav!);
    const onsets = na.silences.map((x) => x.end);
    for (const x of res.timings!) errs.push(Math.min(...onsets.map((o) => Math.abs(o - x.start)), Infinity));
    errs.sort((a, b) => a - b);
    report.syncProxy = 'no ground truth: sentence start vs nearest speech onset after a pause (upper bound for sentences that start after a pause; sentences joined without pause are counted too)';
  }
  const q = (p: number) => +(errs[Math.min(errs.length - 1, Math.floor(p * errs.length))] ?? NaN).toFixed(3);
  const shots = seq.production!.shots;
  const v1 = seq.tracks[0]!;
  // repetition: same media back to back, same composition kind back to back
  let sameMedia = 0;
  let sameKind = 0;
  for (let i = 0; i + 1 < v1.clips.length; i++) {
    if (v1.clips[i]!.mediaId === v1.clips[i + 1]!.mediaId) sameMedia++;
    const a = project.media[v1.clips[i]!.mediaId]?.generator?.kind;
    const b = project.media[v1.clips[i + 1]!.mediaId]?.generator?.kind;
    if (a && a === b) sameKind++;
  }
  const lens = v1.clips.map((c) => framesToSeconds(c.duration, r));
  // relevance proxy: shots whose media name contains an entity mentioned in the beat
  const strong = shots.filter((s) => s.quality === 'strong').length;
  report.production = {
    seconds: genSec,
    stages,
    qcScore: seq.production!.qcScore,
    qcIssues: seq.production!.qcIssues.map((i) => i.message ?? i),
    alignment: res.report.alignment,
    sync: { sentences: errs.length, median: q(0.5), p90: q(0.9), max: q(1), within250ms: +(errs.filter((e) => e <= 0.25).length / errs.length).toFixed(3) },
    shots: shots.length,
    quality: { strong, weak: shots.filter((s) => s.quality === 'weak').length, generated: shots.filter((s) => s.quality === 'generated').length, missing: shots.filter((s) => s.quality === 'missing').length },
    meanShotSec: +(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)).toFixed(2),
    maxShotSec: +Math.max(...lens).toFixed(2),
    repetition: { sameMediaBackToBack: sameMedia, sameCompositionBackToBack: sameKind },
    transitions: v1.transitions.length,
    captions: Object.fromEntries(['subtitle', 'title', 'lower-third', 'placeholder'].map((k) => [k, seq.captions.filter((c) => c.style === k).length])),
    sfxClips: seq.tracks.find((tr) => tr.name === 'SFX')?.clips.length ?? 0,
    generatedAssets: res.newMedia.filter((m: MediaAsset) => m.generator || m.sfx).length,
    report: res.report,
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));

  // 6. export (whole video, or the first N seconds)
  if (args['no-export'] === undefined) {
    t0 = t();
    const outFile = path.join(dir, `${name}.mp4`);
    const range = args['range-sec'] ? { start: 0, end: Math.round(Number(args['range-sec']) * 30) } : undefined;
    const vr = await exportSequence({ project, sequenceId: seq.id, output: outFile, range, cacheDir: path.join(dir, 'Cache') });
    const exportSec = secs(t0);
    const m = await measure(outFile);
    const dur = vr.frames / 30;
    report.export = {
      file: path.basename(outFile),
      seconds: exportSec,
      videoSeconds: +dur.toFixed(1),
      realtimeFactor: +(exportSec / dur).toFixed(2),
      verified: vr.ok,
      problems: vr.problems,
      sizeMB: +(fs.statSync(outFile).size / 1e6).toFixed(1),
      ...m,
      // fades at the very start/end are intended
      unexpectedBlack: m.blacks.filter((b) => b.start > 1 && b.end < dur - 1.5),
    };
  }
  report.peakRssMB = Math.round(peakRss / 1e6);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
  clearInterval(mem);
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
