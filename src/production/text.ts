/** French-aware text normalisation and tokenisation helpers. */

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9#' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words for matching (keeps #numbers, drops elisions like l', d'). */
export function tokens(s: string): string[] {
  return normalize(s.replace(/[-_.]/g, ' '))
    .split(' ')
    .map((w) => w.replace(/^(l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu)'/, '').replace(/'/g, ''))
    .filter(Boolean);
}

export const STOPWORDS_FR = new Set(
  (
    'le la les un une des du de d l au aux et ou mais donc or ni car que qui quoi dont ou ce cet cette ces son sa ses leur leurs mon ma mes ton ta tes notre nos votre vos ' +
    'il elle ils elles on nous vous je tu me te se lui y en ne pas plus moins tres tout tous toute toutes est sont etait etaient sera etre avoir a ont avait avaient fait faire ' +
    'dans sur sous avec sans pour par entre vers chez apres avant pendant depuis comme si alors aussi encore deja meme bien tres peu ici la cela ceci ca c qu ' +
    'the a an of and or to in on for with is are was were be by as at this that these those it its from his her their'
  ).split(' '),
);

export function contentWords(s: string): string[] {
  return tokens(s).filter((w) => w.length > 2 && !STOPWORDS_FR.has(w));
}

/** Rough syllable count for French/English words (vowel groups) — used to estimate speech time. */
export function syllables(text: string): number {
  let n = 0;
  for (const w of normalize(text).split(' ')) {
    if (!w) continue;
    if (/^\d+$/.test(w)) {
      n += Math.max(1, w.length); // numbers are spoken long
      continue;
    }
    const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
    n += Math.max(1, groups ? groups.length : 1);
  }
  return n;
}
