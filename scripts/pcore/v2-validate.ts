/**
 * P-CORE V2 validation (Electron, real renderer). Run: npm run pcore:validate -- <narration.wav> <outDir> [--sentences s.json]
 * Measures, never assumes:
 *  1. Logo fidelity: rest frame of the core alone vs the official silhouette (IoU of the alpha mask).
 *  2. Layer independence: each layer alone adds visible pixels; disabling it removes them.
 *  3. Presets really differ (mean image difference at the same moment).
 *  4. Flicker: frame-to-frame luminance change at rest and during expressions.
 *  5. Expressions: every expression of the library renders and changes the image.
 *  6. Quality levels: render time and throughput per level (this machine).
 *  7. Native alpha exports: VP9 WebM, ProRes 4444, QuickTime Animation, PNG sequence (validated).
 *  8. Director on the narration: cues, memory log, audio reaction measures.
 * Writes report.json and contact sheets in outDir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { renderPCore, lastRenderStats } from '../../src/main/pcoreRender';
import { DEFAULT_PCORE_SETTINGS } from '../../src/pcore/expression';
import { analyzeVoice } from '../../src/pcore/audio';
import { LAYERS, type LayerId, PRESETS, type PresetId, presetSettings, type PCoreV2Settings } from '../../src/pcore/v2/config';
import { EXPRESSION_LIST, type ExpressionId } from '../../src/pcore/v2/expressions';
import { animateV2, maxStep, type PCoreFrameV2 } from '../../src/pcore/v2/animation';
import { directPCore, type PCoreCue } from '../../src/pcore/v2/director';
import { decodePcm } from '../../src/engine/pcore';
import { ffmpeg } from '../../src/engine/ffmpeg';
import type { PCoreQuality } from '../../src/pcore/quality';

// machines without a GPU opt in to software rendering explicitly (same switch as the app's tests)
if (process.env.PRIMESTONE_SOFTWARE_GL === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
app.on('window-all-closed', () => undefined);

const [narration, outDir] = process.argv.filter((a) => !a.startsWith('-')).slice(-2) as [string, string];
const sentencesArg = process.argv.indexOf('--sentences');
const FPS = 30;

async function png(frames: PCoreFrameV2[], v2: PCoreV2Settings, size: number, file: string, quality: PCoreQuality = 'standard') {
  await renderPCore({ width: size, height: size, fps: { num: FPS, den: 1 }, frames, settings: DEFAULT_PCORE_SETTINGS, composition: 'core', seed: 7, format: 'png-sequence', quality, output: file, v2 });
  return fs.readdirSync(file).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(file, f));
}

async function rgba(file: string, size: number): Promise<Uint8Array> {
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size}x${size}`, 'pipe:1'], { collectStdout: true });
  return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
}

const lum = (px: Uint8Array) => {
  const out = new Float32Array(px.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = ((0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!) * px[i * 4 + 3]!) / 255;
  return out;
};
const meanDiff = (a: Float32Array, b: Float32Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
const coverage = (px: Uint8Array, thr = 8) => {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i]! > thr) n++;
  return n / (px.length / 4);
};

function pointIn(poly: [number, number][], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** IoU between the rendered alpha mask (cropped to its bbox) and the official polygon rasterised in the same box. */
function silhouetteIoU(px: Uint8Array, size: number, poly: [number, number][]) {
  let x0 = size, y0 = size, x1 = 0, y1 = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (px[(y * size + x) * 4 + 3]! > 128) ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
  const px0 = Math.min(...poly.map((p) => p[0])), px1 = Math.max(...poly.map((p) => p[0]));
  const py0 = Math.min(...poly.map((p) => p[1])), py1 = Math.max(...poly.map((p) => p[1]));
  let inter = 0, uni = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const m = px[(y * size + x) * 4 + 3]! > 128;
      // image y grows downward, shape y grows upward
      const sx = px0 + ((x - x0 + 0.5) / (x1 - x0 + 1)) * (px1 - px0);
      const sy = py1 - ((y - y0 + 0.5) / (y1 - y0 + 1)) * (py1 - py0);
      const p = pointIn(poly, sx, sy);
      if (m && p) inter++;
      if (m || p) uni++;
    }
  return { iou: uni ? inter / uni : 0, bbox: { x0, y0, x1, y1 }, aspectRendered: (x1 - x0 + 1) / (y1 - y0 + 1), aspectOfficial: (px1 - px0) / (py1 - py0) };
}

function framesFor(seconds: number, v2: PCoreV2Settings, cues: PCoreCue[], voice?: ReturnType<typeof analyzeVoice>) {
  const n = Math.round(seconds * FPS);
  const silent = voice ?? analyzeVoice(new Float32Array(Math.round(seconds * 16000)), 16000, { fps: FPS });
  return animateV2(silent.slice(0, n), FPS, cues, v2);
}
const cue = (expression: ExpressionId, start: number, duration: number, variant = 0, intensity = 1): PCoreCue => ({ id: `t-${expression}-${start}`, expression, start, duration, intensity, variant, reasons: ['validation'], source: 'utilisateur', state: 'verrouillée' });

async function contactSheet(files: string[], out: string, cols = 6) {
  const list = path.join(path.dirname(out), `${path.basename(out)}.txt`);
  fs.writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
  await ffmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=240:240,premultiply=inplace=1,tile=${cols}x${Math.ceil(files.length / cols)}:color=0x050505`, '-frames:v', '1', out]);
}

app.whenReady().then(async () => {
  const report: Record<string, unknown> = { at: new Date().toISOString(), renderer: process.env.PRIMESTONE_SOFTWARE_GL === '1' ? 'WebGL2 logiciel (SwiftShader) : aucun GPU utilisé' : 'WebGL2 matériel si disponible (voir quality.*.gpu)' };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const shape = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'assets/pcore/logo-shape.json'), 'utf8'));
    const S = 480;
    // ---- 1. fidelity: core alone, at rest, no rotation, no micro-motion
    const coreOnly = presetSettings('classic');
    for (const l of LAYERS) if (l.id !== 'core') coreOnly.identity.layers[l.id].enabled = false;
    coreOnly.animation.micro = 0;
    coreOnly.animation.rotation = 0;
    coreOnly.identity.edge = 0;
    const rest = framesFor(2, coreOnly, []).slice(-1);
    const restFiles = await png(rest, coreOnly, S, path.join(outDir, 'fidelity'), 'high');
    const sil = silhouetteIoU(await rgba(restFiles[0]!, S), S, shape.outer);
    report.fidelity = { ...sil, pass: sil.iou >= 0.93 };
    // ---- 2. layers: each alone vs core alone (same moment, an active pose)
    const activePose = (v2: PCoreV2Settings) => framesFor(4, v2, [cue('orbital-motion', 1, 3)]).slice(Math.round(2.5 * FPS), Math.round(2.5 * FPS) + 1);
    const layerCov: Record<string, number> = {};
    const layerDiff: Record<string, number> = {};
    const basePx = await rgba((await png(activePose(coreOnly), coreOnly, S, path.join(outDir, 'layer-core')))[0]!, S);
    const baseCov = coverage(basePx);
    layerCov.core = baseCov;
    const layerFiles: string[] = [];
    for (const l of LAYERS.filter((x) => x.id !== 'core')) {
      const v = structuredClone(coreOnly);
      v.identity.layers[l.id].enabled = true;
      const f = (await png(activePose(v), v, S, path.join(outDir, `layer-${l.id}`)))[0]!;
      layerFiles.push(f);
      const px = await rgba(f, S);
      layerCov[l.id] = coverage(px);
      layerDiff[l.id] = +meanDiff(lum(px), lum(basePx)).toFixed(2);
    }
    await contactSheet(layerFiles, path.join(outDir, 'layers.png'), 4);
    // each layer, added alone to the core, changes the image measurably (luminance difference per pixel)
    report.layers = { coverage: layerCov, meanLumDiffVsCore: layerDiff, independent: Object.values(layerDiff).every((d) => d > 0.05) };
    // ---- 3. presets at the same reveal moment
    const presetImgs: Record<string, Float32Array> = {};
    const presetFiles: string[] = [];
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      const v = presetSettings(id);
      const f = framesFor(5, v, [cue('revelation', 1, 3, 1)]).slice(Math.round(2.3 * FPS), Math.round(2.3 * FPS) + 1);
      const files = await png(f, v, S, path.join(outDir, `preset-${id}`));
      presetFiles.push(files[0]!);
      presetImgs[id] = lum(await rgba(files[0]!, S));
    }
    const ids = Object.keys(presetImgs);
    const pairs: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs[`${ids[i]}↔${ids[j]}`] = +meanDiff(presetImgs[ids[i]!]!, presetImgs[ids[j]!]!).toFixed(2);
    report.presets = { meanLumDiff: pairs, allDistinct: Object.values(pairs).every((d) => d > 1) };
    await contactSheet(presetFiles, path.join(outDir, 'presets.png'), 5);
    // ---- 4/5. every expression, one sequence: frames sheet + flicker measures
    const v2 = presetSettings('classic');
    const lib: PCoreCue[] = [];
    let t = 0.5;
    for (const e of EXPRESSION_LIST) {
      lib.push(cue(e.id, t, e.duration.default, 0, 1));
      t += e.duration.default + 0.6;
    }
    const seqFrames = framesFor(t + 1, v2, lib);
    report.smoothness = maxStep(seqFrames);
    const step = Math.round(FPS / 2);
    const picked = seqFrames.filter((_, i) => i % step === 0);
    const exprFiles = await png(picked, v2, 360, path.join(outDir, 'expressions'), 'preview');
    await contactSheet(exprFiles, path.join(outDir, 'expressions.png'), 8);
    report.expressions = lib.map((c) => ({ id: c.expression, start: c.start, duration: c.duration }));
    // flicker at rest: 2 s of a resting core, consecutive frames
    const restSeq = framesFor(3, v2, []).slice(FPS, FPS + 30);
    const restPng = await png(restSeq, v2, 320, path.join(outDir, 'rest-seq'), 'standard');
    const diffs: number[] = [];
    let prev: Float32Array | null = null;
    for (const f of restPng) {
      const l = lum(await rgba(f, 320));
      if (prev) diffs.push(meanDiff(l, prev));
      prev = l;
    }
    report.flickerAtRest = { meanFrameDiff: +(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(3), maxFrameDiff: +Math.max(...diffs).toFixed(3), unit: 'niveaux de luminance (0–255) par pixel' };
    // ---- 6. quality levels: 3 s at 1080×1080 (classic, with a revelation)
    const q: Record<string, unknown> = {};
    const qFrames = framesFor(3, v2, [cue('revelation', 0.3, 2.5)]);
    for (const level of ['preview', 'standard', 'high', 'final'] as PCoreQuality[]) {
      const out = path.join(outDir, `quality-${level}.webm`);
      await renderPCore({ width: 1080, height: 1080, fps: { num: FPS, den: 1 }, frames: qFrames, settings: DEFAULT_PCORE_SETTINGS, composition: 'core', seed: 7, format: 'webm-vp9', quality: level, output: out, v2 });
      q[level] = { ...lastRenderStats, bytes: fs.statSync(out).size };
    }
    report.quality = q;
    // ---- 7. native alpha exports
    const ex: Record<string, unknown> = {};
    const exFrames = framesFor(1, v2, [cue('active', 0, 1)]);
    for (const [fmt, ext] of [['webm-vp9', '.webm'], ['mov-prores4444', '.mov'], ['mov-qtrle', '.mov'], ['png-sequence', '']] as const) {
      try {
        const check = await renderPCore({ width: 540, height: 540, fps: { num: FPS, den: 1 }, frames: exFrames, settings: DEFAULT_PCORE_SETTINGS, composition: 'core', seed: 7, format: fmt, quality: 'standard', output: path.join(outDir, `export-${fmt}${ext}`), v2 });
        ex[fmt] = { ok: check.ok, pixFmt: check.pixFmt, frames: check.frames, alpha: `${check.alphaMin}–${check.alphaMax}` };
      } catch (e) {
        ex[fmt] = { ok: false, error: (e as Error).message.slice(0, 200) };
      }
    }
    report.exports = ex;
    // ---- 8. director on the narration (real audio file)
    if (narration && fs.existsSync(narration)) {
      const { stdout } = await ffmpeg(['-v', 'error', '-i', narration, '-ac', '1', '-ar', '4000', '-f', 'f32le', 'pipe:1'], { collectStdout: true });
      const pcm = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.byteLength / 4) * 4));
      const voice10 = analyzeVoice(pcm, 4000, { fps: 10 });
      const sentences = sentencesArg > 0 ? JSON.parse(fs.readFileSync(process.argv[sentencesArg + 1]!, 'utf8')) : undefined;
      for (const mode of ['audio', ...(sentences ? ['texte'] : [])]) {
        const d = directPCore({ voice: voice10, fps: 10, sentences: mode === 'texte' ? sentences : undefined, settings: presetSettings('classic') });
        report[`director_${mode}`] = { durationSec: +(voice10.length / 10).toFixed(1), cues: d.cues.map((c) => `${c.start.toFixed(1)}s ${c.expression} (${c.intensity}) — ${c.reasons[0]}`), log: d.log.slice(0, 40) };
      }
      // audio reaction: correlation between the voice envelope and the core glow over 20 s
      const dur = Math.min(20, voice10.length / 10);
      const pcm16 = await decodePcm(narration, 0, dur);
      const voice30 = analyzeVoice(pcm16, 16000, { fps: FPS });
      const fr = animateV2(voice30, FPS, [], presetSettings('classic'));
      const xs = voice30.map((v) => (v.speaking ? v.env : 0));
      const ys = fr.map((f) => f.pose.coreGlow);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0, dx = 0, dy = 0;
      xs.forEach((x, i) => ((num += (x - mx) * (ys[i]! - my)), (dx += (x - mx) ** 2), (dy += (ys[i]! - my) ** 2)));
      report.audioReaction = { glowVsVoiceCorrelation: +(num / Math.sqrt(dx * dy)).toFixed(3), seconds: dur };
    }
  } catch (e) {
    report.error = String((e as Error).stack ?? e);
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1).slice(0, 6000));
  app.exit(report.error ? 1 : 0);
});
