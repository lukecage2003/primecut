/**
 * Production-script import: turns real-world script documents (PDF text, Word/Docs exports, plain
 * text) into the canonical Markdown-with-directives format read by `parseScript`.
 *
 * Recognised conventions (from real Primestone scripts):
 * - document title and a metadata preamble (Format, Angle, Règle, Ton recommandé, Durée cible…)
 *   → kept as notes, never narrated;
 * - section headings in capitals, optionally timed: `0:00 - 1:35 | INTRODUCTION`, `00:00 — HOOK : …`,
 *   `01 — 1984 : …`, `1. 1986 - THE DARK KNIGHT RETURNS …` (multi-line headings are merged);
 * - editorial blocks: `VISUELS —`, `Montage :`, `À l'écran :`, `B-roll :` → visual hints;
 *   `Texte : « … »` → on-screen text; `Source(s) comics :`, `Sources d'ancrage :` → comic references;
 *   `Musique :`, `SFX :`, `Son :` → sound notes; `Note :` → notes. Indented continuation lines belong
 *   to the block;
 * - inline labels such as `ANALYSE / CRITIQUE :` at the start of a narrated paragraph are removed;
 * - running page headers/footers (`… 1 / 13`, `Page 3`) are dropped; hyphenated line breaks and
 *   paragraphs split by page/line breaks are re-joined;
 * - words glued together by PDF justification (`parcequ’il`, `TheDark`) are split again using the
 *   vocabulary of the document itself (plus an optional transcript vocabulary).
 */

export interface ImportedScript {
  /** Canonical script for `parseScript`. */
  markdown: string;
  title: string | null;
  /** Preamble metadata (label → value). */
  meta: Record<string, string>;
  /** Planned timing of each section, in heading order (seconds), when the script gives it. */
  sectionTargets: ({ start: number; end: number | null } | null)[];
  /** Word repairs that were applied (`glued` → `fixed`), for the report. */
  repairs: { from: string; to: string }[];
  /** True when the input looked like a structured production script (vs plain prose). */
  structured: boolean;
}

type DirKind = 'visual' | 'screen' | 'source' | 'sound' | 'note' | 'meta';

const DIRECTIVES: { re: RegExp; kind: DirKind }[] = [
  { re: /^(?:visuels?|visual(?:s)?|images?|b-?roll|plans?|inserts?|montage|à l['’]écran|a l['’]ecran|écran|ecran|on[- ]screen|illustrations?)\b/i, kind: 'visual' },
  { re: /^(?:texte(?: à l['’]écran| écran)?|text|titre(?: écran)?|carton|incrustation)\b/i, kind: 'screen' },
  { re: /^(?:sources?(?:\(s\))?(?: comics?| d['’]ancrage| principales?)?|références?(?: comics?)?|refs?)\b/i, kind: 'source' },
  { re: /^(?:musique|music|sfx|son|sound(?: design)?|ambiance|bruitage)\b/i, kind: 'sound' },
  { re: /^(?:note(?: éditoriale| de montage)?|remarque|n\.?b\.?)\b/i, kind: 'note' },
  {
    re: /^(?:format|angle|règle|regle|méthode|methode|principe(?: éditorial)?|point de rigueur|ton(?: recommandé)?|durée(?: cible)?|duree(?: cible)?|cible|public|légende|legende|objectif|style|rythme|script)\b/i,
    kind: 'meta',
  },
];
const LABEL_SEP = /^\s*(?:\([^)]*\)\s*)?(?:[:：—–-]|\s—)\s*/;

/** Lines that should not be read aloud even though they look like prose labels. */
const INLINE_LABEL = /^([A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ' /&-]{2,40})\s*:\s+(?=\S)/;

const TIME = String.raw`(\d{1,2}(?::\d{2}){1,2})`;
const TIMED_HEADING = new RegExp(String.raw`^${TIME}\s*(?:[-–—]|à)\s*${TIME}\s*(?:[|—–:-]\s*)?(.*)$`);
const START_HEADING = new RegExp(String.raw`^${TIME}\s*[|—–:-]\s*(.*)$`);

function seconds(tc: string): number {
  return tc.split(':').reduce((a, p) => a * 60 + Number(p), 0);
}

function upperRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) return 0;
  return letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / letters.length;
}

function isHeadingText(s: string): boolean {
  const t = s.replace(/^(?:\d{1,2}[.)]|\d{1,2}\s*[—–-])\s*/, '');
  return upperRatio(t) >= 0.75 && /\p{L}{2,}/u.test(t) && t.length <= 140;
}

interface Line {
  text: string;
  indent: number;
  blankBefore: boolean;
}

function toLines(source: string): Line[] {
  const raw = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  // running headers/footers: lines that repeat (digits ignored) or carry page counters
  const shape = (s: string) => s.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const counts = new Map<string, number>();
  for (const l of raw) if (l.trim().length > 6) counts.set(shape(l), (counts.get(shape(l)) ?? 0) + 1);
  const out: Line[] = [];
  let blank = true;
  for (const l of raw) {
    const t = l.replace(/\f/g, '').trimEnd();
    const trimmed = t.trim();
    const isFooter =
      trimmed.length > 0 &&
      ((/(?:\b\d+\s*\/\s*\d+|\bpage\s+\d+(?:\s*(?:\/|sur|of)\s*\d+)?)\s*$/i.test(trimmed) && trimmed.length < 120) ||
        ((counts.get(shape(t)) ?? 0) >= 3 && /#/.test(shape(t))));
    if (!trimmed || isFooter) {
      if (!trimmed) blank = true;
      continue;
    }
    out.push({ text: trimmed, indent: t.length - t.trimStart().length, blankBefore: blank });
    blank = false;
  }
  return out;
}

function classify(text: string): { kind: DirKind; label: string; body: string } | null {
  for (const d of DIRECTIVES) {
    const m = d.re.exec(text);
    if (!m) continue;
    const rest = text.slice(m[0].length);
    const sep = LABEL_SEP.exec(rest) ?? (d.kind === 'meta' ? /^\s{2,}/.exec(rest) : null);
    if (!sep) continue;
    // "À l'écran : …" nested inside "Montage : …" stays one visual block
    return { kind: d.kind, label: m[0], body: rest.slice(sep[0].length).trim() };
  }
  return null;
}

const FUNCTION_WORDS = new Set(
  (
    'a à au aux avec ce ces cet cette dans de des du elle elles en est et il ils je la le les leur leurs lui mais ne ni nous on ou où par pas pour qu que qui sa se ses si son sont sur un une vous y ' +
    'alors aussi avant après bien car comme donc encore entre été être fait ici jamais lors même moins notre peu plus puis quand sans sous tout tous toute très voici était avait ' +
    'the of and to in on for'
  ).split(' '),
);

/** A word list lookup (lower-case, accents kept). Injected by the engine; optional. */
export type Dictionary = (word: string) => boolean;

const ELISIONS = ['l', 'd', 'qu', 'n', 's', 'c', 'j', 'm', 't', 'jusqu', 'lorsqu', 'puisqu', 'quelqu', 'presqu', 'quoiqu', 'aujourd'];

/**
 * Splits words glued together by PDF justification (`parcequ’il`, `dese`, `TheDark`) using a word
 * list plus the vocabulary of the document itself. A word that is itself known is never split.
 */
export function repairGluedWords(text: string, extraVocab: Iterable<string> = [], dictionary?: Dictionary): { text: string; repairs: { from: string; to: string }[] } {
  const low = (w: string) => w.toLowerCase().replace(/'/g, '’');
  const freq = new Map<string, number>();
  for (const w of text.match(/[\p{L}][\p{L}’'-]*/gu) ?? []) freq.set(low(w), (freq.get(low(w)) ?? 0) + 1);
  for (const w of extraVocab) freq.set(low(w), (freq.get(low(w)) ?? 0) + 3);
  const caps = new Set<string>([...extraVocab].map(low));
  for (const w of text.match(/\p{Lu}[\p{Ll}’']+(?:\p{Lu}\p{Ll}+)?|\b\p{Lu}{2,}\b/gu) ?? []) caps.add(low(w));
  const inDict = (k: string) => (dictionary ? dictionary(k) : false) || FUNCTION_WORDS.has(k);
  const knownWord = (k: string): boolean => {
    if (inDict(k)) return true;
    // document vocabulary: names (capitalised in the text) or, without a word list, any repeated word
    if ((freq.get(k) ?? 0) >= 2 && (!dictionary || caps.has(k))) return true;
    const m = /^([a-z]+)’(.+)$/.exec(k); // l’univers, qu’il
    return !!m && ELISIONS.includes(m[1]!) && knownWord(m[2]!);
  };
  const repairs: { from: string; to: string }[] = [];
  const split = (word: string): string[] | null => {
    const k = low(word);
    if (k.length < 4 || knownWord(k)) return null;
    const n = word.length;
    const best: ({ cost: number; prev: number } | null)[] = Array(n + 1).fill(null);
    best[0] = { cost: 0, prev: -1 };
    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      for (let j = i + 1; j <= n; j++) {
        const pk = low(word.slice(i, j));
        const elision = /’$/.test(pk) && ELISIONS.includes(pk.slice(0, -1));
        if (!elision && (pk.length <= 3 ? !(FUNCTION_WORDS.has(pk) || caps.has(pk)) : !knownWord(pk))) continue;
        if (/’/.test(pk) && !elision) continue;
        // prefer few, long pieces; short pieces must be function words; frequent document words win ties
        const fn = FUNCTION_WORDS.has(pk) || elision;
        const cost =
          best[i]!.cost + 1 + (pk.length <= 3 && !fn ? 0.6 : 0) + (dictionary && !inDict(pk) && !elision ? 0.4 : 0) - Math.min(0.3, Math.log10(1 + (freq.get(pk) ?? 0)) / 6);
        if (!best[j] || cost < best[j]!.cost) best[j] = { cost, prev: i };
      }
    }
    if (!best[n] || best[n]!.prev <= 0) return null;
    const parts: string[] = [];
    for (let j = n; j > 0; j = best[j]!.prev) parts.unshift(word.slice(best[j]!.prev, j));
    // an elision alone is not a split (l’univers stays as is)
    const real = parts.filter((p) => !/’$/.test(low(p)));
    if (real.length < 2) return null;
    // genuine glued text almost always involves a function word (« dese », « Ilest »); long tokens are
    // the exception. This keeps compounds and proper nouns (Catwoman, métahumain) intact.
    const hasFn = parts.some((p) => FUNCTION_WORDS.has(low(p)));
    let pos = 0;
    const camel = parts.slice(0, -1).every((p) => {
      pos += p.length;
      return /\p{Ll}/u.test(word[pos - 1]!) && /\p{Lu}/u.test(word[pos]!);
    });
    if (!hasFn && !camel && k.length < 14) return null;
    // a capitalised word only splits after a function word (Ilest, Puisarrive), never Cat|woman
    if (/^\p{Lu}/u.test(word) && (!FUNCTION_WORDS.has(low(parts[0]!)) || parts[0]!.length < 2) && !/’$/.test(parts[0]!) && !/\p{Lu}/u.test(word.slice(1))) return null;
    return parts;
  };
  const out = text.replace(/[\p{L}][\p{L}’'-]*/gu, (w) => {
    if (w.includes('-')) return w;
    const parts = split(w);
    if (!parts) return w;
    const joined = parts.reduce((acc, p) => (acc && /[’']$/.test(acc) ? acc + p : acc ? `${acc} ${p}` : p), '');
    repairs.push({ from: w, to: joined });
    return joined;
  });
  return { text: out, repairs };
}

export function importProductionScript(source: string, opts: { transcriptVocabulary?: Iterable<string>; dictionary?: Dictionary } = {}): ImportedScript {
  const lines = toLines(source);
  const meta: Record<string, string> = {};
  const sectionTargets: ImportedScript['sectionTargets'] = [];
  let title: string | null = null;
  const indents = new Map<number, number>();
  for (const l of lines) indents.set(l.indent, (indents.get(l.indent) ?? 0) + l.text.length);
  const bodyIndent = [...indents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

  type Block = { type: 'heading'; text: string; target: { start: number; end: number | null } | null } | { type: 'para'; text: string } | { type: 'dir'; kind: DirKind; label: string; text: string; indent: number };
  const blocks: Block[] = [];
  let seenHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const last = blocks.at(-1);
    let text = l.text;
    // timed heading (timecode prefix makes it a heading even if not all caps)
    let target: { start: number; end: number | null } | null = null;
    const tm = TIMED_HEADING.exec(text) ?? START_HEADING.exec(text);
    if (tm) {
      const rest = (tm.length === 4 ? tm[3] : tm[2])!.trim();
      if (rest && isHeadingText(rest)) {
        target = tm.length === 4 ? { start: seconds(tm[1]!), end: seconds(tm[2]!) } : { start: seconds(tm[1]!), end: null };
        text = rest;
      }
    }
    if (target || (isHeadingText(text) && text.split(/\s+/).length >= 1 && !/[.…]["»”]?$/.test(text) && !classify(text))) {
      if (last?.type === 'heading' && !l.blankBefore && !target) {
        last.text = `${last.text} ${text}`;
        continue;
      }
      if (last?.type === 'heading' && !target && !last.target && blocks.length === 1 && !title) {
        // two separate capitalised blocks at the very top: the first is the document title
      }
      blocks.push({ type: 'heading', text, target });
      seenHeading = true;
      continue;
    }
    const bullet = /^[■▪•●◆]\s*/.exec(text);
    if (bullet && l.indent > bodyIndent) {
      blocks.push({ type: 'dir', kind: 'source', label: 'Source', text: text.replace(/[■▪•●◆]/g, ';'), indent: l.indent });
      continue;
    }
    const d = classify(text);
    if (d) {
      blocks.push({ type: 'dir', kind: d.kind, label: d.label, text: d.body, indent: l.indent });
      continue;
    }
    // continuation of a directive block: indented deeper than the body, or a parenthesised tail
    if (last?.type === 'dir' && (l.indent > bodyIndent || (!l.blankBefore && l.indent >= last.indent))) {
      last.text = `${last.text} ${text}`.trim();
      continue;
    }
    if (l.indent > bodyIndent + 1 && /^\(/.test(text)) {
      const prevDir = [...blocks].reverse().find((b) => b.type === 'dir');
      if (prevDir && prevDir.type === 'dir') {
        prevDir.text = `${prevDir.text} ${text}`;
        continue;
      }
    }
    // an inline label (« ANALYSE / CRITIQUE : … ») starts a new paragraph and becomes an on-screen tag
    const label = INLINE_LABEL.exec(text);
    if (label && upperRatio(label[1]!) > 0.9 && label[1]!.trim().length >= 4) {
      blocks.push({ type: 'dir', kind: 'screen', label: 'Tag', text: label[1]!.trim(), indent: l.indent });
      blocks.push({ type: 'para', text: text.slice(label[0].length) });
      continue;
    }
    if (last?.type === 'para') {
      const prevEnds = /[.!?…:]["»”)]?$/.test(last.text);
      const startsLower = /^[\p{Ll}0-9«"(]/u.test(text);
      if (!l.blankBefore || (!prevEnds && (startsLower || !seenHeading))) {
        last.text = last.text.endsWith('-') && /^\p{Ll}/u.test(text) ? last.text.slice(0, -1) + text : `${last.text} ${text}`;
        continue;
      }
    }
    blocks.push({ type: 'para', text });
  }

  // document title = leading heading(s) before any narration; preamble before the first real
  // section heading is metadata
  const headingIdx = blocks.map((b, i) => (b.type === 'heading' ? i : -1)).filter((i) => i >= 0);
  const structured = headingIdx.length >= 2 || blocks.some((b) => b.type === 'dir');
  let firstSection = headingIdx[0] ?? -1;
  if (headingIdx.length >= 2 && headingIdx[0] === 0) {
    title = (blocks[0] as { text: string }).text;
    firstSection = headingIdx[1]!;
  }
  const out: string[] = [];
  const notes: string[] = [];
  // end matter (sources list, checklists, production tables) is never narrated
  const END_MATTER = /^(?:sources?\b|références|references|bibliographie|fiche\b|réalisation\b|realisation\b|annexes?\b|crédits|credits|checklist|notes? de production|plan de montage|découpage|decoupage)/i;
  let inEndMatter = false;
  const endMatter: string[] = [];
  blocks.forEach((b, i) => {
    if (structured && firstSection > 0 && i < firstSection) {
      if (i === 0 && b.type === 'heading') return;
      if (b.type === 'dir') meta[b.label.trim()] = b.text;
      else if (b.type === 'para') notes.push(b.text);
      return;
    }
    if (b.type === 'heading') {
      const bare = b.text.replace(/^[\d\s.—–-]+/, '');
      if (END_MATTER.test(bare)) inEndMatter = true;
      else if (inEndMatter && (b.target || /^\d/.test(b.text) || /^(?:conclusion|introduction|outro|hook|intro|épilogue|epilogue)\b/i.test(bare))) inEndMatter = false;
      if (inEndMatter) {
        endMatter.push(b.text);
        return;
      }
      sectionTargets.push(b.target);
      out.push(`## ${b.text.replace(/\s+/g, ' ')}`);
      return;
    }
    if (inEndMatter) {
      endMatter.push(b.text);
      return;
    }
    if (b.type === 'para') {
      out.push(b.text.replace(INLINE_LABEL, ''));
    } else {
      const body = b.text.replace(/[[\]]/g, '');
      if (!body) return;
      if (b.kind === 'visual') {
        // an arrow list is a sequence of shots
        const items = body.split(/\s*(?:→|->|⇒|➜)\s*/).map((x) => x.trim()).filter(Boolean);
        const screen = /\b(?:texte|text)\s*:\s*«([^»]+)»/i.exec(body);
        out.push(items.map((it) => `[VISUEL: ${it.replace(/\b(?:texte|text)\s*:\s*«[^»]+»/i, '').trim()}]`).join(' ') + (screen ? ` [ECRAN: ${screen[1]!.trim()}]` : ''));
      } else if (b.kind === 'screen') out.push(`[ECRAN: ${body.replace(/^«\s*|\s*»$/g, '')}]`);
      else if (b.kind === 'source') out.push(body.split(/\s*[•;]\s*/).map((x) => x.trim()).filter((x) => x.length > 2).map((x) => `[SOURCE: ${x}]`).join(' '));
      else if (b.kind === 'sound') out.push(`[SON: ${body}]`);
      else if (b.kind === 'meta') meta[b.label.trim()] = body;
      else out.push(`[NOTE: ${body}]`);
    }
  });
  if (endMatter.length) meta['Annexes'] = endMatter.join('\n');
  if (notes.length) meta['Notes'] = notes.join(' ');
  const repaired = repairGluedWords(out.join('\n\n'), opts.transcriptVocabulary, opts.dictionary);
  return { markdown: repaired.text, title, meta, sectionTargets, repairs: repaired.repairs, structured };
}

/** True when the text is already in Primestone Markdown (headings `#` or bracket directives). */
export function isCanonicalScript(text: string): boolean {
  return /^\s*#{1,3}\s|\[(?:VISUEL|VISUAL|IMAGE|TITRE|TITLE|SOURCE|ECRAN|ÉCRAN|PAUSE|NOTE|SON)\b/im.test(text) && !/\b\d+\s*\/\s*\d+\s*$/m.test(text);
}
