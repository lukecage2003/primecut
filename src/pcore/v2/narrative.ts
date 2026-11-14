/**
 * P-CORE V2 Narrative Intelligence (text side, local, rule-based). Reads each sentence IN CONTEXT:
 * its position in the narration, the sentence before and after, its connectors, its form (question,
 * exclamation, length) and its markers. A marker alone is a cue, not a trigger: its weight depends
 * on where it sits (start of the sentence, after a long explanation, before a question…).
 * Output: a category, a salience (how much the moment deserves a visual reaction), a confidence and
 * the reasons. Nothing is inferred about emotion; nothing is sent anywhere.
 */

export type NarrativeCategory = 'introduction' | 'presentation' | 'contexte' | 'explication' | 'analyse' | 'question' | 'opposition' | 'escalade' | 'revelation' | 'conclusion' | 'neutre';

export const CATEGORY_LABEL: Record<NarrativeCategory, string> = {
  introduction: 'Introduction',
  presentation: 'Présentation d’un personnage',
  contexte: 'Contexte historique',
  explication: 'Explication',
  analyse: 'Analyse',
  question: 'Question',
  opposition: 'Opposition',
  escalade: 'Montée (« mais ce n’est pas tout »)',
  revelation: 'Révélation',
  conclusion: 'Conclusion',
  neutre: 'Narration',
};

export interface NarrativeSentence {
  index: number;
  start: number;
  end: number;
  text: string;
  section?: number;
}

export interface SentenceReading {
  index: number;
  start: number;
  end: number;
  category: NarrativeCategory;
  /** 0..1: how much this moment deserves a visual reaction. */
  salience: number;
  confidence: number;
  reasons: string[];
  /** First sentence of a new section. */
  sectionStart: boolean;
}

const N = (s: string) => s.replace(/[’]/g, "'").toLowerCase();
// \b does not see accented letters: Unicode look-arounds
const W = (src: string) => new RegExp(`(?<!\\p{L})(?:${src})(?!\\p{L})`, 'iu');

const MARKERS: { cat: NarrativeCategory; re: RegExp; weight: number; label: string; leading?: boolean }[] = [
  { cat: 'revelation', re: W("en r[ée]alit[ée]|la v[ée]rit[ée]|r[ée]v[ée]l\\p{L}*|c'est l[àa] que tout change|tout change|le twist|personne ne savait|ce que personne|secret|d[ée]masqu\\p{L}*|identit[ée] (?:secr[èe]te|r[ée]elle)|on d[ée]couvre|d[ée]couvr\\p{L}*"), weight: 0.75, label: 'marqueur de révélation' },
  { cat: 'revelation', re: W("c'est l[àa] que (?:l'histoire|tout|les choses) (?:devient|bascule|change)\\p{L}*|devient (?:vraiment )?fascinant\\p{L}*|va tout changer|tout bascule"), weight: 0.6, label: 'tournant annoncé' },
  { cat: 'escalade', re: W("mais ce n'est pas tout|beaucoup plus int[ée]ressant|le plus (?:int[ée]ressant|incroyable|fou|surprenant)|et pourtant ce n'est que|encore plus|pire encore|mieux encore"), weight: 0.7, label: 'marqueur de montée' },
  { cat: 'opposition', re: W('pourtant|cependant|toutefois|n[ée]anmoins|au contraire|or,|sauf que'), weight: 0.45, label: 'connecteur d’opposition', leading: true },
  { cat: 'opposition', re: W('mais'), weight: 0.3, label: '« mais » en tête de phrase', leading: true },
  { cat: 'explication', re: W("voici pourquoi|c'est pourquoi|parce que|car|c'est-[àa]-dire|autrement dit|pour comprendre|le principe|cela signifie|ce qui explique|en clair"), weight: 0.45, label: 'connecteur explicatif' },
  { cat: 'analyse', re: W("si l'on regarde|en analysant|on remarque|on observe|ce qui montre|cela prouve|on peut (?:voir|dire)|en d[ée]tail|d'un point de vue|symbolis\\p{L}*|th[ée]orie|hypoth[èe]se"), weight: 0.45, label: 'vocabulaire d’analyse' },
  { cat: 'contexte', re: W("en (?:1[89]\\d\\d|20\\d\\d)|dans les ann[ée]es|[àa] l'[ée]poque|au d[ée]part|[àa] l'origine|tout commence|cr[ée][ée]e? par|publi[ée]e?s?|na[îi]t|naissance"), weight: 0.4, label: 'repère historique' },
  { cat: 'conclusion', re: W('en conclusion|finalement|au final|pour conclure|en r[ée]sum[ée]|abonnez|dites-moi en commentaire|[àa] la prochaine|merci d.avoir'), weight: 0.55, label: 'formule de conclusion' },
];

const PRESENT = /(?<!^)(?<![.!?]\s)\b\p{Lu}[\p{L}'-]+(?:\s\p{Lu}[\p{L}'-]+)*\s+(?:est|était|devient|c'est|se nomme|s'appelle)\b|(?:^|\s)(?:voici|je vous présente|c'est)\s+\p{Lu}/u;

export function readNarration(sentences: NarrativeSentence[]): SentenceReading[] {
  const total = sentences.length;
  const duration = sentences.at(-1)?.end ?? 0;
  const lens = sentences.map((s) => s.text.split(/\s+/).length);
  const medianLen = [...lens].sort((a, b) => a - b)[Math.floor(lens.length / 2)] ?? 12;
  const out: SentenceReading[] = [];
  sentences.forEach((s, i) => {
    const t = N(s.text);
    const scores = new Map<NarrativeCategory, number>();
    const reasons: string[] = [];
    const add = (c: NarrativeCategory, w: number, why: string) => {
      scores.set(c, (scores.get(c) ?? 0) + w);
      reasons.push(why);
    };
    const sectionStart = i > 0 && s.section !== undefined && sentences[i - 1]!.section !== s.section;
    for (const m of MARKERS) {
      const hit = m.re.exec(t);
      if (!hit) continue;
      const leading = hit.index <= 3;
      if (m.leading && !leading) continue;
      // a marker opening the sentence weighs more; inside a question it weighs less (it is asked, not stated)
      let w = m.weight * (leading ? 1.25 : 1) * (/\?\s*$/.test(t) && m.cat !== 'explication' ? 0.6 : 1);
      // context: "pourtant"/"mais" right after an explanation is a real turn; at the very start it is not
      if (m.cat === 'opposition' && i > 0 && out[i - 1] && ['explication', 'contexte', 'analyse'].includes(out[i - 1]!.category)) w += 0.15;
      // a reveal marker in the first sentence is usually a teaser ("vous allez découvrir"), not the reveal
      if (m.cat === 'revelation' && i === 0) w *= 0.5;
      add(m.cat, w, `${m.label} : « ${hit[0]} »`);
    }
    if (/\?\s*$/.test(t)) {
      // a question answered by the next sentence is a rhetorical setup: lighter
      const answered = sentences[i + 1] && !/\?\s*$/.test(sentences[i + 1]!.text);
      add('question', answered ? 0.45 : 0.55, answered ? 'question (rhétorique, suivie d’une réponse)' : 'question');
    }
    if (PRESENT.test(s.text)) add('presentation', 0.4, 'un nom propre présenté (« X est… », « voici X »)');
    // position in the narration
    const pos = duration > 0 ? s.start / duration : i / Math.max(1, total);
    if (i === 0 || pos < 0.06) add('introduction', i === 0 ? 0.5 : 0.25, 'début de la narration');
    if (i === total - 1 || pos > 0.93) add('conclusion', i === total - 1 ? 0.45 : 0.2, 'fin de la narration');
    let [category, best] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['neutre' as NarrativeCategory, 0];
    // an introduction that is also a question stays an introduction (the hook)
    if (i === 0 && scores.has('question') && category === 'question') category = 'introduction';
    // salience: the category's base weight, raised by form and contrast with the neighbours
    const base: Record<NarrativeCategory, number> = { revelation: 0.85, escalade: 0.75, opposition: 0.5, question: 0.45, introduction: 0.6, conclusion: 0.55, presentation: 0.5, contexte: 0.35, explication: 0.3, analyse: 0.35, neutre: 0.15 };
    let salience = base[category] * Math.min(1, 0.55 + best * 0.6);
    if (/!\s*$/.test(t)) ((salience += 0.1), reasons.push('exclamation'));
    // a short sentence after a long one lands harder ("Il est mort.")
    if (i > 0 && lens[i]! <= Math.max(4, medianLen * 0.45) && lens[i - 1]! >= medianLen) ((salience += 0.12), reasons.push('phrase courte après une longue'));
    if (sectionStart) ((salience += 0.1), reasons.push('début d’une nouvelle partie'));
    const confidence = best === 0 ? 0.2 : +Math.min(0.85, 0.3 + 0.35 * best).toFixed(2);
    out.push({ index: s.index, start: s.start, end: s.end, category: best === 0 ? 'neutre' : category, salience: +Math.max(0, Math.min(1, salience)).toFixed(2), confidence, reasons: reasons.length ? reasons : ['aucun indice : narration'], sectionStart });
  });
  return out;
}
