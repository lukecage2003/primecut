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
  /** Comic references ([SOURCE: …]) that back this sentence: strong entity/issue hints. */
  sources: string[];
  /** On-screen texts ([ECRAN: …]) to show while this sentence is spoken. */
  onScreen: string[];
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
  /** Sound directions ([SON: …]) with the sentence they follow (-1 = before any narration). */
  sound: { afterSentence: number; text: string }[];
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
  const sound: { afterSentence: number; text: string }[] = [];
  let section = 0;
  let prevParagraph: ScriptSentence[] = [];
  let carry = { hints: [] as string[], sources: [] as string[], onScreen: [] as string[] };
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
    const sources: string[] = [];
    const screens: string[] = [];
    // visual hints are attached to the sentence that follows them (marker ⁣<n>⁣)
    const cleaned = text
      .replace(/\[(TITRE|TITLE)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        titles.push({ section, text: t.trim() });
        return ' ';
      })
      .replace(/\[(VISUEL|VISUAL|IMAGE)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        hints.push(t.trim());
        return ` ⁣${hints.length - 1}⁣ `;
      })
      .replace(/\[(SOURCE|SOURCES|REF)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        sources.push(t.trim());
        return ' ';
      })
      .replace(/\[(ECRAN|ÉCRAN|SCREEN|TEXTE)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        screens.push(t.trim());
        return ' ';
      })
      .replace(/\[(SON|SOUND|MUSIQUE|MUSIC|SFX)\s*:\s*([^\]]+)\]/gi, (_, __, t: string) => {
        sound.push({ afterSentence: sentences.length - 1, text: t.trim() });
        return ' ';
      })
      .replace(/\[NOTE\s*:\s*([^\]]+)\]/gi, (_, t: string) => {
        notes.push(t.trim());
        return ' ';
      })
      .replace(/\[PAUSE\]/gi, () => '   ')
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
    const parts = cleaned.split(' ');
    const before = sentences.length;
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
          sources: [...sources],
          onScreen: [],
        });
        pending = [];
      });
    });
    const mine = sentences.slice(before);
    if (mine.length) {
      if (pending.length) mine.at(-1)!.hints.push(...pending);
      if (screens.length) mine[0]!.onScreen.push(...screens);
      prevParagraph = mine;
      paragraph++;
    } else if (prevParagraph.length && prevParagraph[0]!.section === section) {
      // a block made only of directives describes the paragraph just before it:
      // shots are spread over its sentences in order, sources back all of them
      pending.forEach((h, i) => prevParagraph[Math.min(prevParagraph.length - 1, Math.floor((i * prevParagraph.length) / pending.length))]!.hints.push(h));
      for (const s of prevParagraph) s.sources.push(...sources.filter((x) => !s.sources.includes(x)));
      prevParagraph[0]!.onScreen.push(...screens);
    } else {
      // directives before any narration in this section go to the next sentence
      carry.hints.push(...pending);
      carry.sources.push(...sources);
      carry.onScreen.push(...screens);
    }
    if (mine.length && (carry.hints.length || carry.sources.length || carry.onScreen.length)) {
      mine[0]!.hints.unshift(...carry.hints);
      for (const s of mine) s.sources.push(...carry.sources);
      mine[0]!.onScreen.unshift(...carry.onScreen);
      carry = { hints: [], sources: [], onScreen: [] };
    }
  }
  return { sections, sentences, titles, notes, sound };
}
