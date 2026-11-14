/**
 * Optional local OCR with Tesseract (Apache-2.0), run as a separate program the user installed
 * themselves. Primestone never downloads it nor its language data: when it is not found, OCR is
 * simply unavailable and every feature keeps working on file names, tags and descriptions.
 *
 * Output: the words kept above a confidence threshold, their mean confidence and the text zones
 * (word boxes grouped by block), normalised to the image. Lettering in comics (capitals, stylised
 * fonts, sound effects) is often read poorly: the confidence is shown, never hidden.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaOcr } from '../core';

export interface OcrConfig {
  enabled: boolean;
  /** Path of tesseract(.exe); empty = searched in PATH and the usual install folders. */
  path?: string;
  /** Tesseract language codes, e.g. "fra+eng". */
  languages?: string;
}

export interface OcrCheck {
  ok: boolean;
  bin: string | null;
  version: string | null;
  languages: string[];
  missingLanguages: string[];
  message: string;
}

const isWin = process.platform === 'win32';

/** Finds the tesseract executable without installing anything. */
export function findTesseract(configured?: string): string | null {
  const cands: string[] = [];
  if (configured) cands.push(configured);
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) if (d) cands.push(path.join(d, isWin ? 'tesseract.exe' : 'tesseract'));
  if (isWin) cands.push('C:\\Program Files\\Tesseract-OCR\\tesseract.exe', 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe');
  else cands.push('/usr/bin/tesseract', '/usr/local/bin/tesseract', '/opt/homebrew/bin/tesseract');
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not here */
    }
  }
  return null;
}

function run(bin: string, args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

export async function checkOcr(cfg: OcrConfig): Promise<OcrCheck> {
  const bin = findTesseract(cfg.path);
  const want = (cfg.languages || 'fra+eng').split('+').filter(Boolean);
  if (!bin) return { ok: false, bin: null, version: null, languages: [], missingLanguages: want, message: 'Tesseract n’est pas installé (facultatif). Sans lui, la correspondance utilise les noms, étiquettes et descriptions.' };
  try {
    const v = await run(bin, ['--version'], undefined, 15_000);
    const version = (v.stdout + v.stderr).match(/tesseract\s+v?([\d.]+)/i)?.[1] ?? null;
    const l = await run(bin, ['--list-langs'], undefined, 15_000);
    const languages = (l.stdout + l.stderr).split(/\r?\n/).map((x) => x.trim()).filter((x) => /^[a-z_]{3,}$/i.test(x));
    const missingLanguages = want.filter((x) => !languages.includes(x));
    return { ok: missingLanguages.length < want.length, bin, version, languages, missingLanguages, message: missingLanguages.length ? `Langue(s) absente(s) : ${missingLanguages.join(', ')} (à ajouter dans votre installation de Tesseract)` : `Tesseract ${version ?? ''} prêt` };
  } catch (e) {
    return { ok: false, bin, version: null, languages: [], missingLanguages: want, message: `Tesseract trouvé mais inutilisable : ${(e as Error).message}` };
  }
}

interface TsvWord {
  block: number;
  par: number;
  line: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
}

/** Parses Tesseract's TSV output into kept words, text and grouped zones (normalised). */
export function parseTesseractTsv(tsv: string, minConf = 55): Omit<MediaOcr, 'engine' | 'at'> {
  const rows = tsv.split(/\r?\n/).map((l) => l.split('\t'));
  let W = 0;
  let H = 0;
  const words: TsvWord[] = [];
  for (const r of rows) {
    if (r.length < 12 || r[0] === 'level') continue;
    const level = Number(r[0]);
    const [left, top, width, height, conf] = [r[6], r[7], r[8], r[9], r[10]].map(Number) as [number, number, number, number, number];
    if (level === 1) {
      W = Math.max(W, left + width);
      H = Math.max(H, top + height);
    }
    const text = (r[11] ?? '').trim();
    if (level !== 5 || !text || conf < minConf) continue;
    // a "word" made only of punctuation or a single non-alphanumeric glyph is noise from the artwork
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    words.push({ block: Number(r[2]), par: Number(r[3]), line: Number(r[4]), left, top, width, height, conf, text });
  }
  if (!W || !H) {
    for (const w of words) {
      W = Math.max(W, w.left + w.width);
      H = Math.max(H, w.top + w.height);
    }
  }
  const byBlock = new Map<number, TsvWord[]>();
  for (const w of words) byBlock.set(w.block, [...(byBlock.get(w.block) ?? []), w]);
  const zones = [...byBlock.values()].map((ws) => {
    const x0 = Math.min(...ws.map((w) => w.left));
    const y0 = Math.min(...ws.map((w) => w.top));
    const x1 = Math.max(...ws.map((w) => w.left + w.width));
    const y1 = Math.max(...ws.map((w) => w.top + w.height));
    return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  });
  const lines: string[] = [];
  let key = '';
  for (const w of words) {
    const k = `${w.block}.${w.par}.${w.line}`;
    if (k !== key) lines.push(w.text);
    else lines[lines.length - 1] += ` ${w.text}`;
    key = k;
  }
  const confidence = words.length ? words.reduce((a, w) => a + w.conf, 0) / words.length / 100 : 0;
  return { text: lines.join('\n'), confidence: +confidence.toFixed(2), zones: W && H ? zones : [] };
}

/** Runs Tesseract on one picture (sparse text mode: balloons and captions scattered on a page). */
export async function ocrImage(file: string, cfg: OcrConfig, signal?: AbortSignal): Promise<MediaOcr> {
  const bin = findTesseract(cfg.path);
  if (!bin) throw new Error('Tesseract introuvable');
  const { stdout } = await run(bin, [file, 'stdout', '-l', cfg.languages || 'fra+eng', '--psm', '11', 'tsv'], signal);
  const r = parseTesseractTsv(stdout);
  return { engine: 'Tesseract', ...r, at: new Date().toISOString() };
}

/**
 * Comic pages: each speech balloon / caption box is read on its own — cropped, enlarged, turned into clean
 * black-on-white — which is far more reliable on comic lettering than reading the whole page at once.
 * Falls back to the whole-page read when no balloon is found.
 */
export async function ocrComicPage(file: string, cfg: OcrConfig, signal?: AbortSignal): Promise<MediaOcr> {
  const bin = findTesseract(cfg.path);
  if (!bin) throw new Error('Tesseract introuvable');
  const { ffmpeg } = await import('./ffmpeg');
  const { detectBalloons } = await import('../core/panels');
  const { probeMedia } = await import('./probe');
  const v = (await probeMedia(file, signal)).probe.video;
  if (!v) return ocrImage(file, cfg, signal);
  const W = 600, H = Math.max(2, Math.round((W * v.height) / v.width / 2) * 2);
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'], { collectStdout: true, signal });
  const balloons = detectBalloons(new Uint8Array(stdout.buffer, stdout.byteOffset, W * H), W, H);
  if (!balloons.length) return ocrImage(file, cfg, signal);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ps-ocr-'));
  const texts: string[] = [];
  const zones: MediaOcr['zones'] = [];
  let confSum = 0, confN = 0;
  try {
    for (const [i, b] of balloons.entries()) {
      const pad = 0.004;
      const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad), w = Math.min(1 - x, b.w + 2 * pad), h = Math.min(1 - y, b.h + 2 * pad);
      const crop = path.join(tmp, `b${i}.png`);
      // 3× enlargement, grey, contrast stretched to black lettering on white
      await ffmpeg(['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', `crop=iw*${w.toFixed(5)}:ih*${h.toFixed(5)}:iw*${x.toFixed(5)}:ih*${y.toFixed(5)},scale=iw*3:ih*3:flags=lanczos,format=gray,lutyuv=y='if(lt(val,140),0,255)'`, crop], { signal });
      const r = parseTesseractTsv((await run(bin, [crop, 'stdout', '-l', cfg.languages || 'fra+eng', '--psm', '6', 'tsv'], signal)).stdout, 45);
      const text = r.text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      // a balloon read as a few letters of noise is dropped
      if (text.replace(/[^\p{L}]/gu, '').length < 2) continue;
      texts.push(text);
      zones.push(b);
      confSum += r.confidence;
      confN++;
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
  // lines of the whole-page read that no balloon gave (balloons the detector missed, captions on art)
  const page = await ocrImage(file, cfg, signal).catch(() => null);
  const have = new Set(texts.join(' ').toLowerCase().match(/\p{L}{3,}/gu) ?? []);
  for (const line of page?.text.split('\n') ?? []) {
    const words = line.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
    if (words.length && words.filter((w) => !have.has(w)).length >= Math.ceil(words.length / 2)) texts.push(line.trim());
  }
  if (!texts.length) return page ?? ocrImage(file, cfg, signal);
  return { engine: 'Tesseract (bulles + page)', text: texts.join('\n'), confidence: +(confN ? confSum / confN : 0).toFixed(2), zones: [...zones, ...(page?.zones ?? [])], at: new Date().toISOString() };
}
