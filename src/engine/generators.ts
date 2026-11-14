/**
 * Primestone Visuals renderer: procedural, audio-reactive compositions built from FFmpeg sources
 * and filters (gradients, geq ring textures, rotate, avectorscope, showwaves, showfreqs, life,
 * noise, lagfun, gblur/blend glow) plus libass typography. Output: an H.264 file cached by spec hash.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type GeneratorSpec, STYLE_COLORS, rand, specHash, wrapLines } from '../core';
import { escapeFilterPath } from './exporter';
import { intermediateVideoArgs } from './videoEncoders';
import { ffmpeg } from './ffmpeg';

const f3 = (n: number) => n.toFixed(3);

/** Ring/HUD texture (RGBA PNG) generated once per variant with geq. */
async function ringTexture(dir: string, size: number, accent: string, variant: number): Promise<string> {
  const file = path.join(dir, `ring-${size}-${accent}-${variant}.png`);
  if (fs.existsSync(file)) return file;
  const D = `(hypot(X-${size / 2},Y-${size / 2})/${size / 2})`;
  const A = `(atan2(Y-${size / 2},X-${size / 2})/PI)`; // -1..1
  const ring = (r: number, w: number) => `lt(abs(${D}-${r}),${w})`;
  const k = 6 + (variant % 4) * 2;
  const parts =
    variant % 2 === 0
      ? [ring(0.95, 0.004), `${ring(0.83, 0.005)}*lt(mod(${A}*${k}+10,1),0.62)`, `between(${D},0.87,0.9)*lt(mod(${A}*90+90,1),0.14)`, `${ring(0.64, 0.014)}*lt(mod(${A}*3+6,1),0.7)`, ring(0.5, 0.003)]
      : [ring(0.93, 0.003), `${ring(0.78, 0.009)}*lt(mod(${A}*${k / 2}+10,1),0.45)`, `between(${D},0.7,0.72)*lt(mod(${A}*60+60,1),0.2)`, ring(0.58, 0.004), `${ring(0.42, 0.02)}*lt(mod(${A}*2+4,1),0.3)`];
  const alpha = `255*min(1,${parts.join('+')})*0.85`;
  const r = parseInt(accent.slice(0, 2), 16);
  const g = parseInt(accent.slice(2, 4), 16);
  const b = parseInt(accent.slice(4, 6), 16);
  await fsp.mkdir(dir, { recursive: true });
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}`, '-frames:v', '1', '-vf', `format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${alpha}'`, file]);
  return file;
}

/** Static background (radial gradient + optional grid), rendered once per size/style/variant. */
async function backgroundTexture(dir: string, W: number, H: number, bg0: string, bg1: string, accent: string, x0: number, gridAlpha: number): Promise<string> {
  const file = path.join(dir, `bg-${W}x${H}-${bg0}-${bg1}-${accent}-${x0}-${gridAlpha}.png`);
  if (fs.existsSync(file)) return file;
  await fsp.mkdir(dir, { recursive: true });
  const grid = gridAlpha ? `,drawgrid=w=${Math.round(W / 32)}:h=${Math.round(W / 32)}:t=1:c=0x${accent}@${gridAlpha}` : '';
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=0x${bg1}:c1=0x${bg0}:x0=${x0}:y0=${Math.round(H * 0.45)}:x1=${W}:y1=${H}:type=radial`, '-frames:v', '1', '-vf', `format=rgb24${grid}`, file]);
  return file;
}

/** Star field: sparse bright points with a slight glow (RGBA, transparent background). */
async function starTexture(dir: string, W: number, H: number, variant: number): Promise<string> {
  const file = path.join(dir, `stars-${W}x${H}-${variant}.png`);
  if (fs.existsSync(file)) return file;
  await fsp.mkdir(dir, { recursive: true });
  await ffmpeg([
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}`, '-frames:v', '1',
    '-vf', `noise=alls=100:allf=u:all_seed=${1000 + variant},lutyuv=y='if(gt(val,251),255,0)':u=128:v=128,gblur=sigma=0.7,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='min(255,r(X,Y)*3)'`,
    file,
  ]);
  return file;
}

/** Vignette as a static black RGBA mask (overlaying it is ~3× cheaper than the vignette filter per frame). */
async function vignetteTexture(dir: string, W: number, H: number): Promise<string> {
  const file = path.join(dir, `vignette-${W}x${H}.png`);
  if (fs.existsSync(file)) return file;
  await fsp.mkdir(dir, { recursive: true });
  const d = `hypot((X-${W / 2})/${W / 2},(Y-${H / 2})/${H / 2})/1.4142`;
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}`, '-frames:v', '1', '-vf', `format=rgba,geq=r=0:g=0:b=0:a='255*min(0.72,pow(max(0,${d}-0.25)/0.75,1.6))'`, file]);
  return file;
}

function assHeader(W: number, H: number, accent: string) {
  const U = Math.min(H, W); // portrait frames: size text from the short side
  const bgr = accent.slice(4, 6) + accent.slice(2, 4) + accent.slice(0, 2);
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Big,Arial,${Math.round(U * 0.09)},&H00${bgr},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,${Math.round(U / 270)},0,1,0,0,5,0,0,0,1`,
    `Style: Sub,Arial,${Math.round(U * 0.035)},&H00E8E8E8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,${Math.round(U / 180)},0,1,0,0,5,0,0,0,1`,
    `Style: Lab,Arial,${Math.round(U * 0.032)},&H00${bgr},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,0,0,5,0,0,0,1`,
    `Style: Draw,Arial,20,&H00${bgr},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
}

const assT = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const esc = (t: string) => t.replace(/[{}\\]/g, '').replace(/\n/g, '\\N');

/** Animated typography / diagrams for the composition (libass). Returns null when there is no text. */
function typographyAss(spec: GeneratorSpec, W: number, H: number, accent: string): string | null {
  const d = spec.durationSec;
  const L = assHeader(W, H, accent);
  const ev = (layer: number, s: number, e: number, style: string, text: string) => L.push(`Dialogue: ${layer},${assT(s)},${assT(e)},${style},,0,0,0,,${text}`);
  const end = Math.max(0.5, d - 0.1);
  const portrait = H > W * 1.2;
  if (spec.kind === 'character-card' && spec.title && portrait) {
    // ring above, name card centred below
    const cx = Math.round(W / 2);
    ev(1, 0.15, end, 'Big', `{\\an5\\pos(${cx},${Math.round(H * 0.7)})\\fad(300,300)\\t(0,600,\\fsp${Math.round(W / 120)})}${esc(spec.title.toUpperCase())}`);
    if (spec.subtitle) ev(1, 0.5, end, 'Sub', `{\\an5\\pos(${cx},${Math.round(H * 0.755)})\\fad(400,300)}${esc(spec.subtitle)}`);
    const bw = Math.round(W * 0.6);
    ev(0, 0.1, end, 'Draw', `{\\an7\\pos(${cx - bw / 2},${Math.round(H * 0.655)})\\fad(200,300)\\p1}m 0 0 l ${bw} 0 ${bw} 3 0 3{\\p0}`);
    ev(0, 0.25, end, 'Draw', `{\\an7\\pos(${cx - bw / 4},${Math.round(H * 0.79)})\\fad(200,300)\\p1}m 0 0 l ${bw / 2} 0 ${bw / 2} 3 0 3{\\p0}`);
    return L.join('\n') + '\n';
  }
  if (spec.kind === 'character-card' && spec.title) {
    const x = Math.round(W * 0.66);
    ev(1, 0.15, end, 'Big', `{\\an4\\pos(${x - Math.round(W * 0.14)},${Math.round(H * 0.46)})\\fad(300,300)\\t(0,600,\\fsp${Math.round(H / 120)})}${esc(spec.title.toUpperCase())}`);
    if (spec.subtitle) ev(1, 0.5, end, 'Sub', `{\\an4\\pos(${x - Math.round(W * 0.14)},${Math.round(H * 0.56)})\\fad(400,300)}${esc(spec.subtitle)}`);
    // bracket lines (vector drawing)
    const bx = x - Math.round(W * 0.16);
    ev(0, 0.1, end, 'Draw', `{\\an7\\pos(${bx},${Math.round(H * 0.36)})\\fad(200,300)\\p1}m 0 0 l ${Math.round(W * 0.3)} 0 ${Math.round(W * 0.3)} 3 0 3{\\p0}`);
    ev(0, 0.25, end, 'Draw', `{\\an7\\pos(${bx},${Math.round(H * 0.64)})\\fad(200,300)\\p1}m 0 0 l ${Math.round(W * 0.18)} 0 ${Math.round(W * 0.18)} 3 0 3{\\p0}`);
    return L.join('\n') + '\n';
  }
  if (spec.kind === 'timeline' && spec.items?.length) {
    const items = spec.items.slice(0, 6);
    const y = Math.round(H * 0.55);
    const x0 = Math.round(W * 0.12);
    const x1 = Math.round(W * 0.88);
    ev(0, 0, end, 'Draw', `{\\an7\\pos(${x0},${y})\\fad(200,300)\\clip(${x0},0,${x0},${H})\\t(0,${Math.round(Math.min(1.2, d / 3) * 1000)},\\clip(${x0},0,${x1},${H}))\\p1}m 0 0 l ${x1 - x0} 0 ${x1 - x0} 3 0 3{\\p0}`);
    items.forEach((it, i) => {
      const x = x0 + ((i + 0.5) / items.length) * (x1 - x0);
      const s = Math.min(d - 0.4, 0.3 + (i * (d * 0.6)) / items.length);
      ev(1, s, end, 'Draw', `{\\an7\\pos(${Math.round(x - 9)},${y - 8})\\fad(250,200)\\p1}m 9 0 b 14 0 18 4 18 9 b 18 14 14 18 9 18 b 4 18 0 14 0 9 b 0 4 4 0 9 0{\\p0}`);
      ev(1, s, end, 'Lab', `{\\an5\\pos(${Math.round(x)},${y - Math.round(H * 0.06)})\\fad(300,200)}${esc(it)}`);
    });
    if (spec.title) ev(1, 0.1, end, 'Sub', `{\\an5\\pos(${W / 2},${Math.round(H * 0.3)})\\fad(300,300)}${esc(spec.title)}`);
    return L.join('\n') + '\n';
  }
  if (spec.kind === 'typography' && spec.title) {
    const lines = (portrait ? wrapLines(spec.title, 16, 5) : wrapLines(spec.title, 26, 3)) ?? [spec.title.slice(0, 70)];
    const words = lines.join(' \\N ').split(' ');
    let t = 0.15;
    const per = Math.min(0.35, (d * 0.5) / Math.max(1, words.length));
    const text = words.map((w) => (w === '\\N' ? '\\N' : `{\\alpha&HFF&\\t(${Math.round(t * 1000)},${Math.round((t += per) * 1000 + 200)},\\alpha&H00&)}${esc(w)}`)).join(' ');
    ev(1, 0, end, 'Big', `{\\an5\\pos(${W / 2},${H / 2})\\fad(0,300)}${text}`);
    return L.join('\n') + '\n';
  }
  if (spec.title) {
    ev(1, 0.2, end, 'Sub', `{\\an5\\pos(${W / 2},${Math.round(H * 0.86)})\\fad(400,400)}${esc(spec.title.toUpperCase())}`);
    return L.join('\n') + '\n';
  }
  return null;
}

/** Glow disc texture (accent colour, gaussian alpha falloff). */
async function coreTexture(dir: string, size: number, accent: string): Promise<string> {
  const file = path.join(dir, `core-${size}-${accent}.png`);
  if (fs.existsSync(file)) return file;
  const D = `(hypot(X-${size / 2},Y-${size / 2})/${size / 2})`;
  const r = parseInt(accent.slice(0, 2), 16);
  const g = parseInt(accent.slice(2, 4), 16);
  const b = parseInt(accent.slice(4, 6), 16);
  await fsp.mkdir(dir, { recursive: true });
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}`, '-frames:v', '1', '-vf', `format=rgba,geq=r=${r}:g=${g}:b=${b}:a='255*min(1,exp(-pow(${D}*2.6,2))+0.9*lt(abs(${D}-0.34),0.012))'`, file]);
  return file;
}

/**
 * Voice envelope per video frame (0..1): RMS with fast attack / slow release, normalised to the
 * 95th percentile so quiet and loud narrations both drive the visuals fully.
 */
export async function voiceEnvelope(audioPath: string, offsetSec: number, durationSec: number, fps: number, signal?: AbortSignal): Promise<number[]> {
  const SR = 8000;
  const { stdout } = await ffmpeg(['-v', 'error', '-ss', f3(offsetSec), '-t', f3(durationSec), '-i', audioPath, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { collectStdout: true, signal });
  const x = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const n = Math.ceil(durationSec * fps);
  const per = SR / fps;
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = Math.floor(i * per); j < Math.min(x.length, Math.floor((i + 1) * per)); j++, c++) sum += (x[j]! / 32768) ** 2;
    raw.push(c ? Math.sqrt(sum / c) : 0);
  }
  const sorted = [...raw].sort((a, b) => a - b);
  const ref = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.95)] ?? 0);
  const env: number[] = [];
  let e = 0;
  for (const v of raw) {
    const t = Math.min(1, v / ref);
    e = t > e ? e + (t - e) * 0.6 : e + (t - e) * 0.12;
    env.push(e);
  }
  return env;
}

export interface RenderGeneratorOptions {
  width: number;
  height: number;
  rate: string; // "30/1"
  audioPath?: string | null;
  cacheDir: string;
  signal?: AbortSignal;
}

/** Renders (or reuses) the composition; returns the absolute output path. */
export async function renderGenerator(spec: GeneratorSpec, o: RenderGeneratorOptions): Promise<string> {
  const { width: W, height: H, rate } = o;
  const dir = path.join(o.cacheDir, 'generated');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${spec.kind}-${specHash(spec, W, H, rate)}.mp4`);
  if (fs.existsSync(out)) return out;
  const c = STYLE_COLORS[spec.style];
  const d = Math.max(0.2, spec.durationSec);
  const portrait = H > W * 1.2;
  const S = Math.round(Math.min(H * 0.82, W * (portrait ? 0.86 : 0.95)) / 2) * 2;
  const r1 = rand(spec.seed, 1);
  const r2 = rand(spec.seed, 2);
  const inten = Math.max(0.1, Math.min(1, spec.intensity));
  const tex1 = await ringTexture(path.join(o.cacheDir, 'textures'), S, c.accent, Math.floor(r1 * 8));
  const tex2 = await ringTexture(path.join(o.cacheDir, 'textures'), Math.round(S * 0.62 / 2) * 2, c.accent2, Math.floor(r2 * 8) | 1);
  const core = await coreTexture(path.join(o.cacheDir, 'textures'), Math.round(S * 0.7 / 2) * 2, c.accent);
  const gridAlpha = spec.kind === 'data-matrix' ? 0.1 : spec.kind === 'cosmic' ? 0 : 0.045;
  const bgTex = await backgroundTexture(path.join(o.cacheDir, 'textures'), W, H, c.bg0, c.bg1, c.accent, Math.round(W * (0.3 + 0.4 * Math.round(r1 * 4) / 4)), gridAlpha);
  const vigTex = await vignetteTexture(path.join(o.cacheDir, 'textures'), W, H);
  const fpsNum = (() => {
    const [a, b] = rate.split('/').map(Number);
    return (a ?? 30) / (b || 1);
  })();
  const env = o.audioPath && spec.audio ? await voiceEnvelope(o.audioPath, spec.audio.offsetSec, d, fpsNum, o.signal) : [];
  const cmdFile = path.join(dir, `.${specHash(spec, W, H, rate)}.cmd`);
  // per-frame commands: core glow and inner ring follow the voice
  await fsp.writeFile(
    cmdFile,
    env.length
      ? env.map((v, i) => `${f3(i / fpsNum)} colorchannelmixer@core aa ${f3(0.25 + 0.75 * v)}, colorchannelmixer@r2 aa ${f3(0.35 + 0.65 * v)};`).join('\n') + '\n'
      : `0 colorchannelmixer@core aa 0.5;\n`,
  );
  const inputs: string[] = [
    '-loop', '1', '-framerate', rate, '-t', f3(d), '-i', bgTex,
    '-loop', '1', '-framerate', rate, '-t', f3(d), '-i', tex1,
    '-loop', '1', '-framerate', rate, '-t', f3(d), '-i', tex2,
  ];
  const coreInput = 4;
  if (o.audioPath && spec.audio) inputs.push('-ss', f3(spec.audio.offsetSec), '-t', f3(d), '-i', o.audioPath);
  else inputs.push('-f', 'lavfi', '-t', f3(d), '-i', 'anullsrc=r=48000:cl=mono');
  inputs.push('-loop', '1', '-framerate', rate, '-t', f3(d), '-i', core);
  inputs.push('-loop', '1', '-framerate', rate, '-t', f3(d), '-i', vigTex);
  const vigInput = 5;
  let nextInput = 6;
  const f: string[] = [];
  const spin = (0.08 + 0.12 * r1) * (r2 > 0.5 ? 1 : -1);
  const kind = spec.kind;
  f.push(`[0:v]format=yuv420p[bg]`);
  // audio → reactive layers
  const useOrb = kind === 'cosmic';
  const useWave = kind === 'audio-hud' || kind === 'dramatic' || kind === 'data-matrix';
  // audio → reactive layers (only the ones this composition shows are computed)
  const aOut = [...(useOrb ? ['[aa]', '[ab]'] : []), ...(useWave ? ['[ac]'] : [])];
  f.push(`[3:a]aformat=sample_rates=48000:channel_layouts=mono,volume=${f3(1 + inten)}${aOut.length > 1 ? `,asplit=${aOut.length}${aOut.join('')}` : aOut.length ? `,anull${aOut[0]}` : ',anullsink'}`);
  if (useOrb) f.push(`[ab]adelay=6[abd];[aa][abd]amerge=inputs=2,avectorscope=s=${S}x${S}:r=${rate}:mode=lissajous_xy:draw=dot:scale=sqrt:zoom=${f3(0.6 + inten * 0.6)}:rc=255:gc=${parseInt(c.accent.slice(2, 4), 16)}:bc=${parseInt(c.accent.slice(4, 6), 16)}:ac=255:rf=60:gf=60:bf=60:af=60,format=rgba,lagfun=decay=0.85[orb]`);
  if (useWave) f.push(`[ac]showwaves=s=${W}x${Math.round(H / 7)}:mode=cline:r=${rate}:colors=0x${c.accent}:scale=cbrt:draw=full,format=rgba,colorchannelmixer=aa=0.45[wave]`);
  f.push(`[${coreInput}:v]format=rgba,sendcmd=f='${escapeFilterPath(cmdFile)}',colorchannelmixer@core=aa=0.5[core]`);
  const ringAlpha = kind === 'timeline' ? 0.22 : kind === 'typography' ? 0.45 : 1;
  f.push(`[1:v]format=rgba,rotate=a='t*${f3(spin)}':c=none:ow=iw:oh=ih${ringAlpha < 1 ? `,colorchannelmixer=aa=${ringAlpha}` : ''}[ring1]`);
  f.push(`[2:v]format=rgba,rotate=a='-t*${f3(spin * 1.7)}':c=none:ow=iw:oh=ih,colorchannelmixer@r2=aa=0.6${ringAlpha < 1 ? `,colorchannelmixer=aa=${ringAlpha}` : ''}[ring2]`);
  const cx = kind === 'character-card' && !portrait ? Math.round(W * 0.3) : Math.round(W / 2);
  const cy = portrait ? Math.round(H * (kind === 'character-card' ? 0.36 : 0.42)) : Math.round(H / 2);
  const fx = Math.max(0, Math.min(W - S, cx - S / 2));
  const fy = Math.max(0, Math.min(H - S, cy - S / 2));
  let last = 'bg';
  const over = (label: string, x: string, y: string) => {
    const n = `o${f.length}`;
    f.push(`[${last}][${label}]overlay=x=${x}:y=${y}:format=auto[${n}]`);
    last = n;
  };
  if (kind === 'data-matrix') {
    f.push(`life=s=${Math.round(W / 12)}x${Math.round(H / 12)}:r=${rate}:ratio=0.08:seed=${Math.floor(r1 * 1e6)}:mold=20:life_color=0x${c.accent}:death_color=0x${c.bg1}:mold_color=0x${c.bg0},trim=duration=${f3(d)},scale=${W}:${H}:flags=neighbor,format=rgba,colorchannelmixer=aa=0.22[life]`);
    over('life', '0', '0');
  }
  if (kind === 'cosmic') {
    // star field (static texture, cheap) + slow nebula drift computed at 1/8 size
    inputs.push('-loop', '1', '-framerate', rate, '-t', f3(d), '-i', await starTexture(path.join(o.cacheDir, 'textures'), W, H, spec.seed % 4));
    f.push(`[${nextInput++}:v]format=rgba[stars]`);
    over('stars', '0', '0');
    f.push(`mandelbrot=s=${Math.round(W / 8)}x${Math.round(H / 8)}:r=${rate}:start_scale=${f3(2 + r1)}:end_scale=0.3:end_pts=${f3(d * 6)}:outer=normalized_iteration_count,trim=duration=${f3(d)},gblur=sigma=1.2,scale=${W}:${H}:flags=bicubic,format=gray,format=rgba,colorchannelmixer=rr=${f3(parseInt(c.accent.slice(0, 2), 16) / 255)}:gg=${f3(parseInt(c.accent.slice(2, 4), 16) / 255 * 0.8)}:bb=${f3(parseInt(c.accent.slice(4, 6), 16) / 255 * 0.6)}:aa=0.28[neb]`);
    over('neb', '0', '0');
  }
  // hologram (rings + core) composed on black at S×S, bloomed at quarter size, then screened onto
  // the background region: the glow costs a fraction of a full-frame pass
  const q = Math.max(16, Math.round(S / 8) * 2);
  f.push(`color=c=black:s=${S}x${S}:r=${rate}:d=${f3(d)},format=gbrp[cv]`);
  f.push(`[cv][ring1]overlay=x=0:y=0:format=gbrp[h1]`);
  f.push(`[h1][ring2]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:format=gbrp[h2]`);
  if (kind !== 'typography' && kind !== 'timeline') f.push(`[h2][core]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:format=gbrp[h3]`);
  else f.push('[core]nullsink', '[h2]null[h3]');
  if (useOrb) f.push(`[h3][orb]overlay=x=0:y=0:format=gbrp[h4]`);
  else f.push('[h3]null[h4]');
  if (spec.backdrop) {
    // background only: the hologram stays out (P-CORE is composited above)
    f.push('[h4]nullsink');
  } else f.push(`[h4]split[hA][hB];[hB]scale=${q}:${q}:flags=bilinear,gblur=sigma=${Math.max(1, Math.round(q / 90))},scale=${S}:${S}:flags=bicubic[hG];[hA][hG]blend=all_mode=screen:all_opacity=0.6[holo]`);
  const grade = kind === 'dramatic' ? ',eq=contrast=1.25:saturation=1.2' : '';
  if (spec.backdrop) f.push(`[${last}]format=gbrp${grade}[o_h]`);
  else f.push(`[${last}]format=gbrp,split[bA][bB];[bB]crop=${S}:${S}:${fx}:${fy}[bC];[bC][holo]blend=all_mode=screen[bH];[bA][bH]overlay=x=${fx}:y=${fy}:format=gbrp${grade}[o_h]`);
  last = 'o_h';
  if (useWave) over('wave', '0', `${Math.round(H * (portrait ? 0.86 : 0.78))}`);
  f.push(`[${last}][${vigInput}:v]overlay=format=auto,format=yuv420p[comp]`);
  let vout = 'comp';
  const ass = typographyAss(spec, W, H, c.accent);
  const assFile = ass ? path.join(dir, `.${specHash(spec, W, H, rate)}.ass`) : null;
  if (ass && assFile) {
    await fsp.writeFile(assFile, ass, 'utf8');
    f.push(`[comp]ass='${escapeFilterPath(assFile)}'[vt]`);
    vout = 'vt';
  }
  const tmp = `${out}.part.mp4`;
  if (process.env.PRIMESTONE_DEBUG_GEN) await fsp.writeFile(process.env.PRIMESTONE_DEBUG_GEN, JSON.stringify(['-v', 'error', ...inputs, '-filter_complex', f.join(';')]));
  try {
    await ffmpeg(
      ['-v', 'error', ...inputs, '-filter_complex', f.join(';'), '-map', `[${vout}]`, '-an', ...(await intermediateVideoArgs(18)), '-pix_fmt', 'yuv420p', '-r', rate, '-t', f3(d), '-movflags', '+faststart', tmp],
      { signal: o.signal },
    );
  } finally {
    if (assFile) await fsp.rm(assFile, { force: true });
    await fsp.rm(cmdFile, { force: true });
  }
  await fsp.rename(tmp, out);
  return out;
}
