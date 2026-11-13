/**
 * Narration format detection (rule-based, explainable). Reads the script (or the transcript) and
 * recognises the kind of comics video — ranking, versus, origin story, arc recap, theory, explainer,
 * news — and its length class (Short, standard, documentary). Each format maps to a direction preset
 * (pacing, transitions, on-screen cards) applied to a copy of the preferences; the report lists the
 * evidence and every change, and the user can force another format.
 */
import type { ProductionPreferences } from './preferences';
import type { ParsedScript } from './script';

export type NarrationKind = 'classement' | 'versus' | 'origine' | 'recap' | 'theorie' | 'explication' | 'actualite';
export type LengthClass = 'short' | 'standard' | 'documentaire';

export const NARRATION_KINDS: Record<NarrationKind, string> = {
  classement: 'Classement / top',
  versus: 'Versus / qui gagnerait',
  origine: 'Origine / biographie',
  recap: 'Résumé d’histoire (arc, événement)',
  theorie: 'Théorie / hypothèse',
  explication: 'Analyse / explication',
  actualite: 'Actualité / annonce',
};

const CUES: Record<NarrationKind, RegExp[]> = {
  classement: [/(?<!\p{L})(?:num[ée]ro|n°)\s*\d+\s*[:,.]/giu, /(?<!\p{L})top\s*\d+/giu, /(?<!\p{L})(?:en|à la)\s+(?:premi[èe]re|deuxi[èe]me|troisi[èe]me|quatri[èe]me|cinqui[èe]me|derni[èe]re|\d+e)\s+(?:position|place)/giu, /(?<!\p{L})classement(?!\p{L})/giu],
  versus: [/(?<!\p{L})(?:vs\.?|versus|face à face)(?!\p{L})/giu, /qui (?:gagnerait|l'emporterait|est le plus fort|est le plus puissant)/giu, /(?<!\p{L})(?:affrontement|duel)(?!\p{L})/giu],
  origine: [/(?<!\p{L})(?:origine|est n[ée]e?|enfance|premi[èe]re apparition|cr[ée]{1,2}e? par|naissance|devenu)(?!\p{L})/giu],
  recap: [/(?<!\p{L})(?:dans ce num[ée]ro|l'histoire commence|ensuite|puis|à la fin d[eu]|finalement|pendant ce temps|l'arc|cet arc)(?!\p{L})/giu],
  theorie: [/(?<!\p{L})(?:et si|th[ée]orie|hypoth[èe]se|serait|pourrait|probablement|selon moi|je pense que)(?!\p{L})/giu],
  explication: [/(?<!\p{L})(?:pouvoirs?|capacit[ée]s?|fonctionne|autrement dit|c'est-à-dire|explique|pourquoi|comment)(?!\p{L})/giu],
  actualite: [/(?<!\p{L})(?:annonc\p{L}*|sortie|sortira|bient[ôo]t|prochain\p{L}*|vient de|nouvelle s[ée]rie|cette semaine|ce mois-ci|officiel\p{L}*)(?!\p{L})/giu],
};

export interface NarrationFormat {
  kind: NarrationKind;
  confidence: number;
  length: LengthClass;
  scores: Record<NarrationKind, number>;
  evidence: string[];
}

export function detectNarrationFormat(script: Pick<ParsedScript, 'sentences' | 'sections'>, durationSec: number, portrait = false): NarrationFormat {
  const text = script.sentences.map((s) => s.text).join(' ').replace(/[’]/g, "'");
  const words = Math.max(1, text.split(/\s+/).length);
  const scores = {} as Record<NarrationKind, number>;
  const evidence: string[] = [];
  for (const k of Object.keys(CUES) as NarrationKind[]) {
    const hits = CUES[k].flatMap((re) => [...text.matchAll(re)].map((m) => m[0].toLowerCase()));
    // per 1000 words; rankings and versus are structural, so their cues weigh more
    const w = k === 'classement' || k === 'versus' ? 3 : k === 'explication' ? 0.6 : 1;
    scores[k] = +((hits.length * 1000 * w) / words).toFixed(1);
    if (hits.length) evidence.push(`${NARRATION_KINDS[k]} : ${[...new Set(hits)].slice(0, 4).map((h) => `« ${h} »`).join(', ')} (${hits.length})`);
  }
  // headings like "N°5 — …" or "5. …" over several sections are a ranking
  // (chapter numbering 1, 2, 3… is not a ranking: a ranking counts down or says "N°")
  const nums = script.sections.map((s) => /^(?:(n°|num[ée]ro|#)\s*)?(\d+)\s*[.:—–-]/i.exec(s.title ?? '')).filter((m): m is RegExpExecArray => !!m);
  const countdown = nums.length >= 3 && nums.every((m, i) => i === 0 || Number(m[2]) < Number(nums[i - 1]![2]));
  const rankedHeadings = nums.some((m) => m[1]) || countdown ? nums.length : 0;
  if (rankedHeadings >= 3) {
    scores.classement += 20;
    evidence.push(`${rankedHeadings} sections numérotées`);
  }
  const ranked = (Object.entries(scores) as [NarrationKind, number][]).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, [, v]) => a + v, 0);
  const [kind, top] = ranked[0]!;
  const length: LengthClass = durationSec <= 180 || (portrait && durationSec <= 240) ? 'short' : durationSec >= 30 * 60 ? 'documentaire' : 'standard';
  return { kind: top > 0 ? kind : 'explication', confidence: total > 0 ? +(top / total).toFixed(2) : 0, length, scores, evidence };
}

/** Direction preset for a format, applied to a copy of the preferences. Returns the changes made. */
export function directionFor(f: Pick<NarrationFormat, 'kind' | 'length'>, base: ProductionPreferences): { prefs: ProductionPreferences; changes: string[] } {
  const p: ProductionPreferences = { ...base, motionWeights: { ...base.motionWeights } };
  const changes: string[] = [];
  const set = <K extends keyof ProductionPreferences>(k: K, v: ProductionPreferences[K], why: string) => {
    if (p[k] === v) return;
    p[k] = v;
    changes.push(why);
  };
  if (f.length === 'short') {
    set('shotTarget', Math.min(p.shotTarget, 2.8), 'Short : plans courts (≈ 2,8 s)');
    set('shotMin', Math.min(p.shotMin, 1.5), 'Short : plans de 1,5 s minimum');
    set('shotMax', Math.min(p.shotMax, 4.5), 'Short : plans de 4,5 s maximum');
    set('motionAmount', Math.min(0.3, +(p.motionAmount + 0.05).toFixed(2)), 'Short : mouvements de caméra plus marqués');
    set('dissolveShare', 0, 'Short : coupes franches, pas de fondus internes');
  } else if (f.length === 'documentaire') {
    set('shotTarget', Math.max(p.shotTarget, 5.5), 'Documentaire : plans plus longs (≈ 5,5 s)');
    set('dissolveShare', Math.max(p.dissolveShare, 0.3), 'Documentaire : plus de fondus enchaînés');
  }
  switch (f.kind) {
    case 'classement':
      set('sectionTitles', true, 'Classement : un titre par entrée du classement');
      break;
    case 'versus':
      set('lowerThirds', true, 'Versus : noms des adversaires à l’écran');
      break;
    case 'origine':
      set('lowerThirds', true, 'Origine : noms des personnages à l’écran');
      break;
    case 'recap':
      set('panelReading', true, 'Résumé : lecture des planches case par case');
      if (f.length !== 'short') set('shotTarget', Math.max(p.shotTarget, 5), 'Résumé : plans de lecture plus longs (≈ 5 s)');
      set('motionAmount', Math.max(0.06, +(p.motionAmount - 0.03).toFixed(2)), 'Résumé : mouvements plus doux pour lire les cases');
      break;
    case 'theorie':
      set('dissolveShare', Math.min(0.5, +(p.dissolveShare + 0.15).toFixed(2)), 'Théorie : enchaînements plus fluides');
      break;
    case 'actualite':
      if (f.length !== 'short') set('shotTarget', Math.min(p.shotTarget, 4), 'Actualité : rythme plus soutenu (≈ 4 s)');
      break;
    case 'explication':
      break;
  }
  return { prefs: p, changes };
}

/** Rank cues ("numéro 5 :", "en troisième position") → on-screen rank card text, for rankings. */
export function rankCard(sentence: string): string | null {
  const m = /^(?:et\s+)?(?:en\s+)?(?:num[ée]ro|n°)\s*(\d+)/i.exec(sentence.trim()) ?? /^(?:et\s+)?(?:en|à la)\s+(premi[èe]re|deuxi[èe]me|troisi[èe]me|quatri[èe]me|cinqui[èe]me|derni[èe]re)\s+(?:position|place)/i.exec(sentence.trim());
  if (!m) return null;
  const words: Record<string, string> = { premiere: '1', première: '1', deuxieme: '2', deuxième: '2', troisieme: '3', troisième: '3', quatrieme: '4', quatrième: '4', cinquieme: '5', cinquième: '5', derniere: 'Dernier', dernière: 'Dernier' };
  const n = /^\d+$/.test(m[1]!) ? m[1]! : words[m[1]!.toLowerCase()] ?? m[1]!;
  return n === 'Dernier' ? 'DERNIÈRE PLACE' : `N°${n}`;
}
