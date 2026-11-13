/**
 * Script from the narration itself (no written script). The recogniser's words are joined back into
 * text, cut into sentences (punctuation, pauses, length), paragraphs (longer pauses) and sections
 * (very long pauses or spoken structure cues such as "passons à", "numéro 5", "pour conclure").
 * Section titles come from the names the section talks about most. Nothing is invented: every word
 * of the result was spoken, so the alignment of this script to the voice is exact.
 */
import { EntityIndex } from './entities';
import type { RecognisedWord } from './align';
import { STOPWORDS_FR, normalize } from './text';

export interface TranscriptScriptOptions {
  sentencePause: number;
  paragraphPause: number;
  sectionPause: number;
  maxSentenceWords: number;
  sentencesPerParagraph: number;
  minSectionSentences: number;
}

export const DEFAULT_TRANSCRIPT_SCRIPT: TranscriptScriptOptions = { sentencePause: 0.55, paragraphPause: 1.0, sectionPause: 1.8, maxSentenceWords: 26, sentencesPerParagraph: 4, minSectionSentences: 6 };

const CUE = /^(?:mais revenons|revenons|passons|maintenant|premi[èe]rement|deuxi[èe]mement|troisi[èe]mement|ensuite,|enfin,|pour conclure|en conclusion|pour finir|num[ée]ro \d+|en (?:premi[èe]re|deuxi[èe]me|troisi[èe]me|derni[èe]re) position|chapitre|partie|parlons)/i;

/** Spoken markers of a failed take (swearing, "je recommence", "on la refait"…). */
const OUTTAKE = /(?<!\p{L})(merde|putain|chier|bordel|je recommence|on recommence|je la refais|on la refait|je reprends|on reprend|attends,? attends|c'?est quoi (?:ce|cette) (?:bordel|merde))(?!\p{L})/iu;

interface Sent {
  text: string;
  start: number;
  end: number;
  pauseBefore: number;
}

/** Joins recogniser tokens: "l" + "'histoire" → "l'histoire", "Spider" + "-Man" → "Spider-Man". */
export function joinTokens(words: string[]): string {
  let out = '';
  for (const raw of words) {
    const w = raw.trim();
    if (!w) continue;
    if (!out || /^['’\-,.;:!?)…]/.test(w) || /['’(\-]$/.test(out)) out += w;
    else out += ` ${w}`;
  }
  return out.replace(/\s+([,.;:!?])/g, '$1').trim();
}

export function sentencesFromTranscript(words: RecognisedWord[], o: TranscriptScriptOptions = DEFAULT_TRANSCRIPT_SCRIPT): Sent[] {
  const out: Sent[] = [];
  let cur: RecognisedWord[] = [];
  let pauseBefore = 0;
  const flush = () => {
    if (!cur.length) return;
    let text = joinTokens(cur.map((w) => w.text)).replace(/[,;:\s]+$/, '');
    if (!/[.!?…]$/.test(text)) text += '.';
    out.push({ text: text.charAt(0).toUpperCase() + text.slice(1), start: cur[0]!.start, end: cur.at(-1)!.end, pauseBefore });
    cur = [];
  };
  words.forEach((w, i) => {
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    if (!cur.length) pauseBefore = i === 0 ? w.start : w.start - words[i - 1]!.end;
    cur.push(w);
    const n = cur.length;
    const t = w.text.trim();
    const endsSentence = /[.!?…]$/.test(t);
    const comma = /[,;:]$/.test(t);
    if (endsSentence && n >= 3) flush();
    else if (gap >= o.sentencePause && n >= 6) flush();
    else if (n >= 12 && comma && gap >= 0.25) flush();
    else if (n >= o.maxSentenceWords && (comma || gap >= 0.15)) flush();
    // forced cut for very long runs, never right after a short tool word ("a", "de", "que"…)
    else if (n >= o.maxSentenceWords + 12 && !(t.length <= 3 || STOPWORDS_FR.has(normalize(t))) && !(next && /^['’\-]/.test(next.text.trim()))) flush();
  });
  flush();
  return out;
}

function sectionTitle(sents: Sent[], index: EntityIndex, used: Set<string>): string {
  const counts = new Map<string, { name: string; n: number; forms: Map<string, number> }>();
  for (const s of sents)
    for (const m of index.find(s.text)) {
      if (m.kind === 'issue') continue;
      const k = normalize(m.name);
      if (k.length < 3 || STOPWORDS_FR.has(k)) continue;
      // titled with the words actually spoken ("Bouffon Vert"), not the reference name ("Green Goblin")
      const c = counts.get(k) ?? { name: m.name, n: 0, forms: new Map<string, number>() };
      c.n++;
      const form = m.surface.replace(/^[«"“(]+|[»"”),.;:!?]+$/g, '').replace(/^(?:le|la|les|l'|du|des|de)\s+/i, '');
      c.forms.set(form, (c.forms.get(form) ?? 0) + 1);
      counts.set(k, c);
    }
  const best = [...counts.entries()].filter(([k]) => !used.has(k)).sort((a, b) => b[1].n - a[1].n)[0];
  if (best && best[1].n >= 2) {
    used.add(best[0]);
    return [...best[1].forms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || best[1].name;
  }
  // otherwise the first words of the section
  return sents[0]!.text.split(/\s+/).slice(0, 6).join(' ').replace(/[,.;:!?]+$/, '') + '…';
}

/** Primestone Markdown script built from the spoken words. */
const FILLER_WORD = /^(euh|heu|euhm|heum|hum|hmm|mmh|hm)[.,!?…]*$/i;

export function scriptFromTranscript(words: RecognisedWord[], opts: Partial<TranscriptScriptOptions> = {}, index = new EntityIndex()): { markdown: string; title: string; sentences: number; sections: number; outtakes: { start: number; end: number; text: string }[] } {
  const o = { ...DEFAULT_TRANSCRIPT_SCRIPT, ...opts };
  // hesitations are never written into the script or the subtitles (they stay in the recording)
  let sents = sentencesFromTranscript(words.filter((w) => !FILLER_WORD.test(w.text.trim())), o);
  if (!sents.length) return { markdown: '', title: '', sentences: 0, sections: 0, outtakes: [] };
  // retakes / outtakes: from the first retake marker in the last 20 % of the recording, the rest is
  // not narration (it stays in the recording; the edit leaves it out and QC reports it)
  const outtakes: { start: number; end: number; text: string }[] = [];
  const total = sents.at(-1)!.end;
  const cut = sents.findIndex((x, i) => (x.start >= total * 0.8 || i >= sents.length - 2) && OUTTAKE.test(x.text));
  if (cut > 0) {
    for (const x of sents.slice(cut)) outtakes.push({ start: x.start, end: x.end, text: x.text });
    sents = sents.slice(0, cut);
  }
  // sections: very long pause or spoken cue, never shorter than minSectionSentences
  const sections: Sent[][] = [[]];
  for (const s of sents) {
    const curSec = sections.at(-1)!;
    const isBreak = curSec.length >= o.minSectionSentences && (s.pauseBefore >= o.sectionPause || CUE.test(s.text));
    if (isBreak) sections.push([s]);
    else curSec.push(s);
  }
  const used = new Set<string>();
  const title = sectionTitle(sents, index, new Set());
  const md: string[] = [`# ${title}`];
  for (const sec of sections) {
    md.push('', `## ${sectionTitle(sec, index, used)}`, '');
    let para: string[] = [];
    sec.forEach((s, i) => {
      if (para.length && (s.pauseBefore >= o.paragraphPause || para.length >= o.sentencesPerParagraph)) {
        md.push(para.join(' '), '');
        para = [];
      }
      para.push(s.text);
      if (i === sec.length - 1) md.push(para.join(' '));
    });
  }
  return { markdown: md.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', title, sentences: sents.length, sections: sections.length, outtakes };
}
