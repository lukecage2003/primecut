/**
 * Script parsing. Accepted input: plain text or Markdown.
 * - `#`/`##` headings start a new section (used as on-screen chapter titles).
 * - Blank lines separate paragraphs.
 * - Editorial directives in brackets are kept out of the narration:
 *   [TITRE: …] on-screen title, [VISUEL: …] / [VISUAL: …] visual hint for the surrounding sentence,
 *   [NOTE: …] ignored note for the editor, [PAUSE] explicit beat break.
 */
import { syllables } from './text';

export interface ScriptSentence {
  index: number;
  text: string;
  section: number;
  paragraph: number;
  syllables: number;
  /** Visual hints attached by directives in the same paragraph. */
  hints: string[];
  /** A [PAUSE] directive follows this sentence. */
  breakAfter: boolean;
}

export interface ScriptSection {
  index: number;
  title: string | null;
}

export interface ParsedScript {
  sections: ScriptSection[];
  sentences: ScriptSentence[];
  titles: { section: number; text: string }[];
  notes: string[];
}

const ABBREV = /(?:\b(?:M|Mme|Mlle|Dr|St|Ste|vol|n°|No|cf|etc|ex|p|pp|Mr|Mrs|Jr|Sr|vs)\.)$/i;

export function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  let cur = '';
  const s = paragraph.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    cur += ch;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      while (i + 1 < s.length && /[.!?…»"”)]/.test(s[i + 1]!)) cur += s[++i];
      const next = s[i + 1];
      const after = s.slice(i + 1).trimStart()[0];
      const isEnd = next === undefined || (next === ' ' && after !== undefined && /[A-ZÀ-ÖØ-Þ0-9«"“(\-—\u2063]/.test(after));
      const t = cur.trim();
      const acronym = /(?:\b[A-Z]\.){2,}$/.test(t); // S.H.I.E.L.D. followed by a capital ends the sentence
      if (isEnd && !(ch === '.' && ABBREV.test(t)) && !(ch === '.' && !acronym && /\b[A-Z]\.$/.test(t))) {
        out.push(cur.trim());
        cur = '';
      }
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((x) => /[\p{L}\p{N}]/u.test(x));
}

export function parseScript(source: string): ParsedScript {
  const sections: ScriptSection[] = [{ index: 0, title: null }];
  const sentences: ScriptSentence[] = [];
  const titles: { section: number; text: string }[] = [];
  const notes: string[] = [];
  let section = 0;
  let paragraph = 0;
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    let text = block.trim();
    if (!text) continue;
    const heading = /^#{1,3}\s+(.+)$/m.exec(text);
    if (heading && text.split('\n').length === 1) {
      if (sentences.length > 0 || sections[section]!.title) {
        section++;
        sections.push({ index: section, title: heading[1]!.trim() });
      } else sections[section]!.title = heading[1]!.trim();
      titles.push({ section, text: heading[1]!.trim() });
      continue;
    }
    // headings at the top of a block followed by text
    text = text.replace(/^#{1,3}\s+(.+)\n/, (_, t: string) => {
      if (sentences.length > 0 || sections[section]!.title) {
        section++;
        sections.push({ index: section, title: t.trim() });
      } else sections[section]!.title = t.trim();
      titles.push({ section, text: t.trim() });
      return '';
    });
    const hints: string[] = [];
    let pauseMarks = 0;
    // visual hints are attached to the sentence that follows them (marker \u2063<n>\u2063)
    const cleaned = text
      .replace(/\[(TITRE|TITLE)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        titles.push({ section, text: t.trim() });
        return ' ';
      })
      .replace(/\[(VISUEL|VISUAL|IMAGE)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        hints.push(t.trim());
        return ` \u2063${hints.length - 1}\u2063 `;
      })
      .replace(/\[NOTE\s*:\s*([^\]]+)\]/gi, (_, t: string) => {
        notes.push(t.trim());
        return ' ';
      })
      .replace(/\[PAUSE\]/gi, () => {
        pauseMarks++;
        return ' \u2029 ';
      })
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
    const parts = cleaned.split(' ');
    let pending: string[] = [];
    parts.forEach((part, pi) => {
      const ss = splitSentences(part);
      ss.forEach((raw, si) => {
        const own = [...raw.matchAll(/⁣(\d+)⁣/g)].map((m) => hints[Number(m[1])]!);
        const text = raw.replace(/\s*⁣\d+⁣\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/[\p{L}\p{N}]/u.test(text)) {
          pending.push(...own); // a hint alone goes to the next sentence
          return;
        }
        sentences.push({
          index: sentences.length,
          text,
          section,
          paragraph,
          syllables: syllables(text),
          hints: [...pending, ...own],
          breakAfter: pi < parts.length - 1 && si === ss.length - 1,
        });
        pending = [];
      });
    });
    if (pending.length && sentences.length) sentences.at(-1)!.hints.push(...pending);
    void pauseMarks;
    paragraph++;
  }
  return { sections, sentences, titles, notes };
}
