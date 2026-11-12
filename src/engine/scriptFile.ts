/**
 * Reads a script document from disk: .txt / .md as UTF-8, .pdf through pdf.js (Apache-2.0).
 * PDF text items are re-ordered top-to-bottom, left-to-right and rebuilt into lines whose
 * indentation and blank lines reflect the page layout, so `importProductionScript` can tell
 * narration from indented editorial blocks.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Dictionary, type ImportedScript, importProductionScript, isCanonicalScript } from '../production/scriptImport';

export const SCRIPT_EXTENSIONS = ['txt', 'md', 'markdown', 'pdf'];

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist');
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items: Item[] = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, size: Math.hypot(it.transform[2], it.transform[3]) || 10 });
      }
      // group into lines (same baseline ± 30% of the font size)
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines: { y: number; size: number; items: Item[] }[] = [];
      for (const it of items) {
        const l = lines.find((L) => Math.abs(L.y - it.y) < Math.max(2, it.size * 0.3));
        if (l) l.items.push(it);
        else lines.push({ y: it.y, size: it.size, items: [it] });
      }
      lines.sort((a, b) => b.y - a.y);
      const minX = Math.min(...items.map((i) => i.x));
      const charW = 5;
      let prevY: number | null = null;
      let prevSize = 10;
      const out: string[] = [];
      for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x);
        let text = '';
        let end: number | null = null;
        for (const it of l.items) {
          if (end !== null && it.x - end > it.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
          text += it.str;
          end = it.x + it.w;
        }
        const gap = prevY === null ? 0 : prevY - l.y;
        if (prevY !== null && gap > Math.max(l.size, prevSize) * 1.75) out.push('');
        out.push(' '.repeat(Math.max(0, Math.round((l.items[0]!.x - minX) / charW))) + text.trimEnd());
        prevY = l.y;
        prevSize = l.size;
      }
      pages.push(out.join('\n'));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages.join('\n\n');
}

let dictionary: Dictionary | null = null;
/** French + English word lists (MIT) used to repair words glued by PDF justification. */
export function loadDictionary(): Dictionary {
  if (dictionary) return dictionary;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fr = require('an-array-of-french-words') as string[];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const en = require('an-array-of-english-words') as string[];
    const set = new Set<string>([...fr, ...en]);
    dictionary = (w) => set.has(w);
  } catch {
    dictionary = () => false;
  }
  return dictionary;
}

export interface ScriptDocument {
  path: string;
  /** Raw text as extracted. */
  raw: string;
  imported: ImportedScript;
}

export async function readScriptDocument(file: string, opts: { transcriptVocabulary?: Iterable<string> } = {}): Promise<ScriptDocument> {
  const st = await fsp.stat(file);
  if (st.size > 30 * 1024 * 1024) throw new Error('Script file is larger than 30 MB');
  const ext = path.extname(file).slice(1).toLowerCase();
  const buf = await fsp.readFile(file);
  const raw = ext === 'pdf' ? await pdfToText(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)) : buf.toString('utf8').replace(/^﻿/, '');
  // a script already written in Primestone Markdown is used as is
  const isMarkdown = ext !== 'pdf' && isCanonicalScript(raw);
  const imported = isMarkdown
    ? { markdown: raw, title: null, meta: {}, sectionTargets: [], repairs: [], structured: true }
    : importProductionScript(raw, { transcriptVocabulary: opts.transcriptVocabulary, dictionary: loadDictionary() });
  return { path: file, raw, imported };
}
