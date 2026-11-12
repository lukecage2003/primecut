/**
 * Entity recognition in narration text: longest-match lookup of knowledge-base names/aliases
 * (accent/case-insensitive), issue references (#123, "numéro 12"), and unknown capitalised
 * phrases (reported as candidates, never invented as facts).
 */
import { type KnowledgeEntry, SEED_KNOWLEDGE } from './knowledge';
import { STOPWORDS_FR, normalize } from './text';

export interface EntityMention {
  entityId: string | null;
  name: string;
  kind: KnowledgeEntry['kind'] | 'issue' | 'unknown';
  surface: string;
}

export class EntityIndex {
  private byPhrase = new Map<string, KnowledgeEntry>();
  private maxWords = 1;
  constructor(readonly entries: KnowledgeEntry[] = SEED_KNOWLEDGE) {
    for (const e of entries) {
      for (const n of [e.name, ...e.aliases]) {
        const k = normalize(n.replace(/-/g, ' ')).split(' ').map((w) => w.replace(/^(l|d|qu)'/, '')).join(' ');
        if (!k) continue;
        this.byPhrase.set(k, e);
        this.maxWords = Math.max(this.maxWords, k.split(' ').length);
      }
    }
  }
  get(id: string) {
    return this.entries.find((e) => e.id === id);
  }

  find(text: string): EntityMention[] {
    const out: EntityMention[] = [];
    const words = text.split(/\s+/).filter(Boolean);
    const norm = words.map((w) => normalize(w.replace(/-/g, ' ')).replace(/^(l|d|qu)'/, ''));
    const used = new Set<number>();
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(this.maxWords + 1, words.length - i); n >= 1; n--) {
        const phrase = norm.slice(i, i + n).join(' ').trim();
        const e = this.byPhrase.get(phrase);
        if (e) {
          out.push({ entityId: e.id, name: e.name, kind: e.kind, surface: words.slice(i, i + n).join(' ') });
          for (let k = i; k < i + n; k++) used.add(k);
          i += n - 1;
          break;
        }
      }
    }
    for (const m of text.matchAll(/(?:#\s?|num[ée]ro\s+|n°\s?|issue\s+)(\d{1,4})/gi)) out.push({ entityId: null, name: `#${m[1]}`, kind: 'issue', surface: m[0] });
    // unknown capitalised phrases (not sentence-initial words alone)
    let run: string[] = [];
    const flush = () => {
      const phrase = run.join(' ');
      if (run.length >= 1 && !out.some((o) => normalize(o.surface).includes(normalize(phrase)))) out.push({ entityId: null, name: phrase, kind: 'unknown', surface: phrase });
      run = [];
    };
    words.forEach((w, i) => {
      const clean = w.replace(/[.,;:!?«»"“”()]/g, '');
      const cap = /^[A-ZÀ-ÖØ-Þ][\p{L}'-]+$/u.test(clean);
      const sentenceStart = i === 0 || /[.!?]$/.test(words[i - 1]!);
      if (cap && !used.has(i) && !STOPWORDS_FR.has(normalize(clean)) && !(sentenceStart && run.length === 0)) run.push(clean);
      else if (run.length) flush();
      if (/[.,;:!?]$/.test(w) && run.length) flush();
    });
    if (run.length) flush();
    return out;
  }
}

const COMMON_CAPS = new Set(
  'mais et puis donc alors pourtant ensuite enfin aujourd hui imaginez imagine vous nous ce cette ces cela ici voici voila oui non car parce pourquoi comment quand dans avant apres pendant depuis selon chez tout tous rien personne chaque certains plusieurs autre autres premier premiere dernier derniere introduction conclusion source sources analyse critique'.split(' '),
);

/**
 * Names specific to this script (characters, places, concepts the curated knowledge base does not
 * know: Despair, Krakoa, Rao…): capitalised phrases repeated in the narration, plus the titles of
 * the comic references it cites. They are matched against media names like known entities but are
 * marked `uncertain` (no facts are attached to them).
 */
export function scriptEntities(script: { sentences: { text: string; sources?: string[] }[] }, base = new EntityIndex()): KnowledgeEntry[] {
  const counts = new Map<string, { name: string; n: number; source: boolean }>();
  const add = (name: string, source = false) => {
    const clean = name.replace(/^[«"“(]+|[»"”),.;:!?]+$/g, '').trim();
    const k = normalize(clean);
    if (clean.length < 3 || !k || COMMON_CAPS.has(k) || STOPWORDS_FR.has(k) || /^\d+$/.test(k)) return;
    if (base.find(clean).some((m) => m.entityId && normalize(m.surface) === k)) return; // already known
    const c = counts.get(k) ?? { name: clean, n: 0, source: false };
    c.n++;
    c.source ||= source;
    counts.set(k, c);
  };
  for (const s of script.sentences) {
    for (const m of base.find(s.text)) if (m.kind === 'unknown' && m.name.split(' ').length <= 4) add(m.name);
    for (const src of s.sources ?? []) {
      const title = src.split(/\s*(?:#|\(|,|—|–|:\s)/)[0]!.trim();
      if (title.length >= 3 && title.length <= 40) add(title, true);
    }
  }
  // count every occurrence of each candidate, including sentence-initial ones the first pass skips
  const all = normalize(script.sentences.map((s) => s.text).join(' '));
  for (const [k, c] of counts) {
    const n = all.split(new RegExp(`(?:^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`)).length - 1;
    c.n = Math.max(c.n, n);
  }
  return [...counts.entries()]
    .filter(([, c]) => c.n >= 2 || c.source)
    .map(([k, c]) => ({ id: `script:${k.replace(/\s+/g, '-')}`, name: c.name, kind: c.source ? 'series' : 'concept', aliases: [], status: 'uncertain' as const }));
}
