/**
 * Comic books delivered as PDF: every page is rendered to a picture (pdf.js, Apache-2.0, drawn with
 * @napi-rs/canvas, MIT), in reading order, into the project cache. The PDF itself is never modified.
 *
 * A PDF in a media folder is treated as a comic when its pages are pictures (little selectable text);
 * a text document (a script, an article) is left alone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LIMITS = { pages: 400, bytes: 1024 ** 3 };

export interface PdfPages {
  dir: string;
  pages: string[];
  title: string;
  /** Average selectable characters per page (a comic has very few). */
  textPerPage: number;
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N} ._-]+/gu, '_').slice(0, 80) || 'comic';

type PdfJs = typeof import('pdfjs-dist');
async function loadPdfJs(): Promise<PdfJs> {
  return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
}

/** Selectable characters per page, measured on the first pages (cheap). */
export async function pdfTextDensity(file: string, sample = 4): Promise<{ pages: number; textPerPage: number }> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await fsp.readFile(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const n = Math.min(sample, doc.numPages);
    let chars = 0;
    for (let i = 1; i <= n; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      chars += tc.items.reduce((a, it) => a + ('str' in it ? it.str.replace(/\s+/g, '').length : 0), 0);
    }
    return { pages: doc.numPages, textPerPage: n ? chars / n : 0 };
  } finally {
    await doc.destroy();
  }
}

/** A comic PDF: pictures with at most a few hundred characters of text per page (credits, page numbers). */
export const isComicPdf = (d: { pages: number; textPerPage: number }) => d.pages >= 1 && d.textPerPage < 300;

/**
 * Renders every page (long side `longSide` px, PNG) into `<cacheDir>/pdf/<title>-<hash>/`.
 * Cached: a PDF already rendered at that size is not rendered again.
 */
export async function extractComicPdf(file: string, cacheDir: string, opts: { longSide?: number; signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<PdfPages> {
  const st = await fsp.stat(file);
  if (st.size > LIMITS.bytes) throw new Error(`PDF trop volumineux (${Math.round(st.size / 1024 ** 2)} Mo)`);
  const longSide = Math.max(1200, Math.min(4000, opts.longSide ?? 2400));
  const hash = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${longSide}`).digest('hex').slice(0, 10);
  const title = path.basename(file).replace(/\.pdf$/i, '');
  const dir = path.join(cacheDir, 'pdf', `${safeName(title)}-${hash}`);
  const done = path.join(dir, '.complete');
  const list = async () => (await fsp.readdir(dir)).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(dir, f));
  if (fs.existsSync(done)) {
    const info = JSON.parse(await fsp.readFile(done, 'utf8')) as { textPerPage: number };
    return { dir, pages: await list(), title, textPerPage: info.textPerPage };
  }
  const pdfjs = await loadPdfJs();
  const { createCanvas } = (await import('@napi-rs/canvas')) as typeof import('@napi-rs/canvas');
  const data = new Uint8Array(await fsp.readFile(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  await fsp.mkdir(dir, { recursive: true });
  let chars = 0;
  try {
    const n = Math.min(LIMITS.pages, doc.numPages);
    for (let i = 1; i <= n; i++) {
      if (opts.signal?.aborted) throw new Error('annulé');
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = longSide / Math.max(base.width, base.height);
      const vp = page.getViewport({ scale });
      const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
      const tc = await page.getTextContent();
      chars += tc.items.reduce((a, it) => a + ('str' in it ? it.str.replace(/\s+/g, '').length : 0), 0);
      const out = path.join(dir, `${safeName(title)} p${String(i).padStart(3, '0')}.png`);
      await fsp.writeFile(out, await canvas.encode('png'));
      page.cleanup();
      opts.progress?.(i, n);
    }
    const textPerPage = n ? chars / n : 0;
    await fsp.writeFile(done, JSON.stringify({ pages: n, textPerPage, longSide }), 'utf8');
    return { dir, pages: await list(), title, textPerPage };
  } finally {
    await doc.destroy();
  }
}
