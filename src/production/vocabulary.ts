/**
 * Proper names of a video (given by the creator) applied to a local transcription. Whisper often
 * misspells rare names ("N. Sabanour" for "En Sabah Nur"); each window of 1–4 recognised words whose
 * letters are close to a name (edit distance on letters, spaces and punctuation ignored) is replaced
 * by the name, keeping the timing. Every correction is reported; nothing else is changed.
 */
import type { RecognisedWord } from './align';

const letters = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/** Rough French/English phonetic key: spellings that sound alike get the same key (sabanour ≈ sabahnur). */
const phonetic = (s: string) =>
  letters(s)
    .replace(/ph/g, 'f')
    .replace(/ch/g, 'sh')
    .replace(/qu|ck|c(?=[aou])/g, 'k')
    .replace(/h/g, '')
    .replace(/ou/g, 'u')
    .replace(/ee|ea/g, 'i')
    .replace(/y/g, 'i')
    .replace(/z/g, 's')
    .replace(/^e(?=n)/, '')
    .replace(/(.)\1+/g, '$1');

function lev(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Similarity 0..1 of two spellings (1 = same letters). */
export function spellingSimilarity(a: string, b: string): number {
  const x = letters(a);
  const y = letters(b);
  if (!x || !y) return 0;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
}

export interface VocabularyCorrection {
  at: number;
  heard: string;
  name: string;
  similarity: number;
}

export function parseVocabulary(text: string): string[] {
  return [...new Set(text.split(/[,;\n]/).map((s) => s.trim()).filter((s) => s.length >= 3))];
}

/**
 * Applies the names to the words. A window is replaced only when it is close enough (≥ 0.72, ≥ 0.8 for
 * short names) and not already exact; the best-scoring name wins; windows never overlap.
 */
/** Small words that may sit next to a name but are never part of it. */
const EDGE = new Set(['a', 'à', 'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'si', 'pas', 'ou', 'où', 'ce', 'et', 'en', 'au', 'aux', 'par', 'pour', 'sur', 'dans', 'que', 'qui', 'of', 'the', 'and', 'là', 'est', 'son', 'sa', 'ses']);
const ELISION = /^((?:jusqu|lorsqu|puisqu|qu|[dlcjmnst])['’])(.+)$/i;
const bare = (t: string) => t.toLowerCase().replace(/[.,;:!?…«»“”()]/g, '');

/**
 * Applies the names to the words. A window is replaced only when it is close enough (≥ 0.72, ≥ 0.8 for
 * short names) and not already exact; the best-scoring name wins (spelling counts more than sound);
 * small words at the edges ("à", "de", "si", "of") and elisions ("d'", "qu'") are kept as they are.
 */
export function applyVocabulary(words: RecognisedWord[], names: string[]): { words: RecognisedWord[]; corrections: VocabularyCorrection[] } {
  const terms = names.map((n) => ({ name: n, key: letters(n), ph: phonetic(n), tokens: n.split(/\s+/).length, edgeOk: new Set(n.split(/\s+/).map(bare)) })).filter((t) => t.key.length >= 3);
  if (!terms.length) return { words, corrections: [] };
  const out: RecognisedWord[] = [];
  const corrections: VocabularyCorrection[] = [];
  const score = (heard: string, term: (typeof terms)[number]) => {
    const hk = letters(heard);
    if (!hk || Math.abs(hk.length - term.key.length) > Math.max(2, term.key.length * 0.4)) return 0;
    const ls = 1 - lev(hk, term.key) / Math.max(hk.length, term.key.length);
    const hp = phonetic(heard);
    const ps = hp && term.ph ? 1 - lev(hp, term.ph) / Math.max(hp.length, term.ph.length) : 0;
    return Math.max(ls, 0.6 * ls + 0.4 * ps, ps - 0.05);
  };
  for (let i = 0; i < words.length; ) {
    let best: { a: number; n: number; term: (typeof terms)[number]; sim: number; prefix: string } | null = null;
    for (const term of terms) {
      for (let n = Math.max(1, term.tokens - 1); n <= Math.min(4, term.tokens + 1) && i + n <= words.length; n++) {
        const win = words.slice(i, i + n);
        // (a single letter with a dot is an initial, not a sentence end: "N. Sabanour")
        if (win.slice(0, -1).some((w) => /[.!?…]$/.test(w.text) && !/^\p{L}\.$/u.test(w.text))) break;
        // edge words that are not part of the name are never swallowed
        const first = bare(win[0]!.text);
        const last = bare(win.at(-1)!.text);
        if (n > 1 && ((EDGE.has(first) && !term.edgeOk.has(first)) || (EDGE.has(last) && !term.edgeOk.has(last)))) continue;
        // an elided particle stays in front: "d'apocalypse" → "d'Apocalypse"
        const el = ELISION.exec(win[0]!.text);
        const prefix = el ? el[1]! : '';
        const heard = [el ? el[2]! : win[0]!.text, ...win.slice(1).map((w) => w.text)].join(' ');
        const sim = score(heard, term);
        const need = term.key.length <= 5 ? 0.8 : 0.72;
        if (sim >= need && (!best || sim > best.sim + 1e-9 || (Math.abs(sim - best.sim) < 1e-9 && n > best.n))) best = { a: i, n, term, sim, prefix };
      }
    }
    if (!best) {
      out.push(words[i]!);
      i++;
      continue;
    }
    const win = words.slice(i, i + best.n);
    const heardFull = win.map((w) => w.text).join(' ');
    const trail = /[.,;:!?…»”)]+$/.exec(win.at(-1)!.text)?.[0] ?? '';
    const lead = /^[«“(]+/.exec(win[0]!.text)?.[0] ?? '';
    const replaced = `${lead}${best.prefix}${best.term.name}${trail}`;
    const replacedOther = `${lead}${best.prefix}${best.term.name.replace(/s$/i, '')}${trail}`;
    if (heardFull === replaced || heardFull === replacedOther || heardFull === `${lead}${best.prefix}${best.term.name}s${trail}`) {
      out.push(...win);
      i += best.n;
      continue;
    }
    // singular / plural as heard: "céleste" stays singular even if the name was given as "Célestes"
    const heardKey = letters(win.map((w) => w.text).join(' ').replace(ELISION, '$2'));
    let name = best.term.name;
    if (heardKey + 's' === best.term.key && /s$/i.test(name)) name = name.slice(0, -1);
    else if (heardKey === best.term.key + 's' && !/s$/i.test(name)) name = `${name}s`;
    const toks = name.split(/\s+/);
    const t0 = win[0]!.start;
    const t1 = win.at(-1)!.end;
    toks.forEach((tok, k) => {
      const a = t0 + ((t1 - t0) * k) / toks.length;
      const b = t0 + ((t1 - t0) * (k + 1)) / toks.length;
      out.push({ ...win[Math.min(k, win.length - 1)]!, text: `${k === 0 ? lead + best!.prefix : ''}${tok}${k === toks.length - 1 ? trail : ''}`, start: +a.toFixed(3), end: +b.toFixed(3) });
    });
    corrections.push({ at: t0, heard: heardFull, name, similarity: +best.sim.toFixed(2) });
    i += best.n;
  }
  return { words: out, corrections };
}
