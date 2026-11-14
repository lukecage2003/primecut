/**
 * Narrative structure of a script, by explicit rules: the function of each section (hook, context,
 * explanation, reveal, list, conclusion), an intensity estimate and a wanted musical mood. Every
 * result carries the cues it relies on and a confidence; nothing is invented about the story
 * itself (no facts are added, only the shape of the text is read).
 */
import type { Mood } from './music';
import type { ParsedScript } from './script';

export type NarrativeFunction = 'accroche' | 'contexte' | 'explication' | 'révélation' | 'liste' | 'conclusion' | 'transition';

export const NARRATIVE_LABEL: Record<NarrativeFunction, string> = {
  accroche: 'Accroche',
  contexte: 'Contexte',
  explication: 'Explication',
  révélation: 'Révélation ou tournant',
  liste: 'Élément de liste ou de classement',
  conclusion: 'Conclusion',
  transition: 'Transition',
};

export interface SectionNarrative {
  section: number;
  title: string;
  fn: NarrativeFunction;
  label: string;
  /** 0..1: how many independent cues agree. Never 1 for a rule-based reading. */
  confidence: number;
  /** Cues found in the text (quoted), in French. */
  evidence: string[];
  /** 0..1 estimated intensity (exclamations, short sentences, conflict vocabulary). */
  intensity: number;
  /** Moods that fit this function and intensity (for music selection). */
  moods: Mood[];
  sentences: number[];
}

const CUES: { fn: NarrativeFunction; re: RegExp; label: string }[] = [
  { fn: 'accroche', re: /\?|\b(et si|imaginez|saviez[- ]vous|vous allez|pourquoi|comment est[- ]ce|ce que personne)\b/i, label: 'question ou interpellation' },
  { fn: 'contexte', re: /\b(en (1[89]\d\d|20\d\d)|à l[’']époque|dans les années|au départ|à l[’']origine|tout commence|créé par|publié|naissance)\b/i, label: 'repère historique' },
  { fn: 'explication', re: /\b(parce que|car|c[’']est[- ]à[- ]dire|autrement dit|en fait|ce qui (signifie|explique)|cela veut dire|donc|ainsi)\b/i, label: 'connecteur explicatif' },
  { fn: 'révélation', re: /\b(en réalité|révèle|découvre|secret|démasqué|véritable|trahi|meurt|mort de|tournant|choc|surprise|personne ne savait|identité)\b/i, label: 'vocabulaire de révélation' },
  { fn: 'liste', re: /\b(num[ée]ro \d+|top \d+|en (première|deuxième|troisième|dernière) position|n°\s?\d+|\d+(e|ème|er) place)\b/i, label: 'marqueur de classement' },
  { fn: 'conclusion', re: /\b(en conclusion|finalement|au final|pour conclure|en résumé|abonnez|dites[- ]moi en commentaire|à la prochaine|merci d[’']avoir)\b/i, label: 'formule de conclusion' },
];

const CONFLICT = /\b(combat|affronte|guerre|bataille|tue|détruit|explose|attaque|menace|danger|furieux|vengeance|massacre|ennemi)\b/i;
const CALM = /\b(calme|paisible|souvenir|nostalgie|doux|tranquille|émouvant|tristesse|deuil)\b/i;

const MOODS_FOR: Record<NarrativeFunction, Mood[]> = {
  accroche: ['mystère', 'tension'],
  contexte: ['calme', 'lumineux', 'mystère'],
  explication: ['calme', 'lumineux'],
  révélation: ['tension', 'épique', 'mystère'],
  liste: ['action', 'lumineux', 'épique'],
  conclusion: ['épique', 'lumineux', 'mélancolie'],
  transition: ['calme'],
};

export function analyseNarrative(script: ParsedScript): SectionNarrative[] {
  const out: SectionNarrative[] = [];
  const sections = script.sections.filter((s) => script.sentences.some((x) => x.section === s.index));
  sections.forEach((sec, i) => {
    const sents = script.sentences.filter((x) => x.section === sec.index);
    const text = sents.map((s) => s.text).join(' ');
    const title = sec.title ?? script.titles.find((t) => t.section === sec.index)?.text ?? `Section ${i + 1}`;
    const votes = new Map<NarrativeFunction, string[]>();
    const vote = (fn: NarrativeFunction, why: string) => votes.set(fn, [...(votes.get(fn) ?? []), why]);
    for (const c of CUES) {
      const m = (title + ' ' + text).match(c.re);
      if (m) vote(c.fn, `${c.label} : « ${m[0].trim()} »`);
    }
    if (i === 0) vote('accroche', 'première section');
    if (i === sections.length - 1 && sections.length > 1) vote('conclusion', 'dernière section');
    if (sents.length <= 1 && i > 0 && i < sections.length - 1) vote('transition', 'section d’une seule phrase');
    let fn: NarrativeFunction = 'explication';
    let best = 0;
    for (const [k, v] of votes) if (v.length > best || (v.length === best && k === 'révélation')) ((fn = k), (best = v.length));
    const evidence = votes.get(fn) ?? ['aucun indice particulier : lecture par défaut'];
    const others = [...votes.values()].reduce((a, v) => a + v.length, 0) - (votes.get(fn)?.length ?? 0);
    const confidence = best === 0 ? 0.25 : +Math.min(0.85, 0.35 + 0.2 * best - 0.08 * others).toFixed(2);
    // intensity: exclamations, short sentences, conflict vocabulary; calm vocabulary lowers it
    const excl = sents.filter((s) => /!/.test(s.text)).length / Math.max(1, sents.length);
    const meanWords = sents.reduce((a, s) => a + s.text.split(/\s+/).length, 0) / Math.max(1, sents.length);
    const conflict = (text.match(new RegExp(CONFLICT.source, 'gi')) ?? []).length / Math.max(1, sents.length);
    const calm = CALM.test(text) ? 0.15 : 0;
    const intensity = +Math.max(0, Math.min(1, 0.25 + 0.4 * excl + 0.3 * Math.min(1, conflict) + (meanWords < 10 ? 0.15 : 0) + (fn === 'révélation' ? 0.15 : 0) - calm)).toFixed(2);
    const moods = [...MOODS_FOR[fn]];
    if (intensity >= 0.6 && !moods.includes('action')) moods.unshift(conflict > 0.3 ? 'action' : 'tension');
    if (intensity <= 0.3 && !moods.includes('calme')) moods.push('calme');
    out.push({ section: sec.index, title, fn, label: NARRATIVE_LABEL[fn], confidence, evidence, intensity, moods, sentences: sents.map((s) => s.index) });
  });
  return out;
}
