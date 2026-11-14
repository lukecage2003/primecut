/**
 * Free-text search over media (pure, used by the engine index and the media panel). Fields: user
 * description, OCR text, tags, file name, folder. Nothing here looks at pixels: a hit says which
 * field matched.
 */
import { contentWords, normalize, tokens } from './text';

/** Which fields matched a query (shown to the user). */
export type SearchMatch = { field: 'description' | 'texte' | 'étiquettes' | 'nom' | 'dossier'; terms: string[] }[];

const FIELD_WEIGHT = { description: 3, texte: 2, étiquettes: 2, nom: 1.5, dossier: 1 } as const;

interface Searchable {
  name: string;
  path: string;
  tags?: string[];
  description?: string;
  ocr?: { text: string };
}

/** Field texts of a media item for search. */
export function searchFields(m: Searchable): Record<keyof typeof FIELD_WEIGHT, string> {
  return {
    description: m.description ?? '',
    texte: m.ocr?.text ?? '',
    étiquettes: (m.tags ?? []).join(' '),
    nom: (m.path || m.name).split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '').replace(/[_.-]+/g, ' '),
    dossier: (m.path || '').split(/[\\/]/).slice(-3, -1).join(' '),
  };
}

/**
 * Ranks items for a free-text query (French or English): every query term found in a field adds
 * that field's weight, divided by how common the term is across the items (rare terms count more).
 * A phrase found as is adds a bonus. Returns only items matching at least one term.
 */
export function searchEntries<T extends Searchable>(items: T[], query: string, limit = 50): { item: T; score: number; matched: SearchMatch }[] {
  const cw = contentWords(query);
  const q = [...new Set((cw.length ? cw : tokens(query)).filter((t) => t.length > 1))];
  if (!q.length) return [];
  const fields = items.map((m) => {
    const f = searchFields(m);
    return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, new Set(tokens(v))])) as Record<keyof typeof FIELD_WEIGHT, Set<string>>;
  });
  const df = new Map(q.map((t) => [t, fields.filter((f) => Object.values(f).some((s) => s.has(t))).length]));
  const phrase = normalize(query);
  const out: { item: T; score: number; matched: SearchMatch }[] = [];
  items.forEach((m, i) => {
    let score = 0;
    const matched: SearchMatch = [];
    for (const [field, set] of Object.entries(fields[i]!) as [keyof typeof FIELD_WEIGHT, Set<string>][]) {
      const terms = q.filter((t) => set.has(t));
      if (!terms.length) continue;
      for (const t of terms) score += FIELD_WEIGHT[field] * Math.log(1 + items.length / (df.get(t) || 1));
      matched.push({ field, terms });
    }
    if (!score) return;
    const all = Object.values(searchFields(m)).map(normalize).join(' ');
    if (q.length > 1 && all.includes(phrase)) score *= 1.5;
    const covered = new Set(matched.flatMap((x) => x.terms)).size / q.length;
    out.push({ item: m, score: +(score * (0.5 + covered)).toFixed(3), matched });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
