/**
 * Comics image format (pure): cover, page, double page, webtoon strip, single panel or illustration,
 * and manga (black & white, read right to left). Decided from the picture itself — proportions,
 * detected panels, colour saturation — plus the file name as a hint. Drives how the shot is read.
 */
import type { Rect } from './panels';

export type ComicFormat = 'couverture' | 'planche' | 'double-page' | 'webtoon' | 'case' | 'illustration' | 'générique';

export interface ComicImageInfo {
  format: ComicFormat;
  manga: boolean;
  readingOrder: 'ltr' | 'rtl';
  reason: string;
  /** Speech balloons / caption boxes found on the picture. */
  balloons?: number;
  /** Share of the picture without texture (0..1). */
  flat?: number;
}

export const COMIC_FORMAT_LABEL: Record<ComicFormat, string> = {
  couverture: 'couverture',
  planche: 'planche',
  'double-page': 'double page',
  webtoon: 'webtoon (bande verticale)',
  case: 'case isolée',
  illustration: 'illustration',
  'générique': 'page de titre / générique (auteurs, crédits)',
};

export function classifyComicImage(o: { width: number; height: number; panels?: Rect[] | null; saturation?: number | null; name?: string; ink?: number | null; flat?: number | null; pageNumber?: number; balloons?: number }): ComicImageInfo {
  const ar = o.width / o.height;
  const n = o.panels?.length ?? 0;
  const name = (o.name ?? '').toLowerCase();
  const gray = o.saturation != null && o.saturation < 0.07;
  const mangaName = /(?<![a-z])(manga|manhwa|tankobon|chapitre|chapter|vol\.? ?\d+ ch)/.test(name);
  let format: ComicFormat;
  let why: string;
  // the first page of a book is its cover
  if (o.pageNumber === 1 && ar > 0.45 && ar < 1.25) return { format: 'couverture', manga: false, readingOrder: 'ltr', reason: 'première page du livre' };
  // a flat page (title, writer and artist credits, text, an ad) without a real layout of panels is not story;
  // a page with speech balloons always is
  if (o.flat != null && o.flat >= 0.6 && n < 3 && (o.balloons ?? 0) < 4 && ar > 0.45 && ar < 1.25 && !/(?<![a-z])(cover|couv|couverture|variant)(?![a-z])/.test(name)) {
    return { format: 'générique', manga: false, readingOrder: 'ltr', reason: `page unie à ${Math.round(o.flat * 100)} % sans mise en page de cases : titre, auteurs, crédits, texte ou publicité` };
  }
  if (ar <= 0.45) {
    format = 'webtoon';
    why = `bande très haute (${(1 / ar).toFixed(1)}× plus haute que large)`;
  } else if (ar >= 1.25 && n >= 3) {
    format = 'double-page';
    why = `image large avec ${n} cases`;
  } else if (n >= 2) {
    format = 'planche';
    why = `${n} cases détectées`;
  } else if (o.pageNumber !== undefined && o.pageNumber > 1 && ar >= 0.45 && ar < 1.25 && !/(?<![a-z])(cover|couv|couverture|variant)(?![a-z])/.test(name)) {
    // inside a book, a page without separate panels is a full-page picture (splash page) of the story
    format = 'planche';
    why = 'pleine page (une seule image) dans le livre';
  } else if (/(?<![a-z])(cover|couv|couverture|variant)(?![a-z])/.test(name) || (ar >= 0.6 && ar <= 0.8)) {
    format = 'couverture';
    why = /(cover|couv|variant)/.test(name) ? 'nom du fichier' : 'proportions de couverture, sans cases';
  } else if (ar > 0.8 && ar < 1.25 && n === 1) {
    format = 'case';
    why = 'une seule case';
  } else {
    format = 'illustration';
    why = 'ni cases ni proportions de page';
  }
  // black & white pages read right to left are manga (a grey page alone is not enough for a cover)
  const manga = (mangaName || gray) && (format === 'planche' || format === 'double-page' || (mangaName && format !== 'webtoon'));
  if (manga) why += gray ? ', noir et blanc' : ', nommé manga';
  return { format, manga, readingOrder: manga ? 'rtl' : 'ltr', reason: why };
}

/** Panels in reading order: rows top to bottom, within a row left→right (or right→left for manga). */
export function orderPanels(panels: Rect[], order: 'ltr' | 'rtl'): Rect[] {
  const rows: Rect[][] = [];
  for (const p of [...panels].sort((a, b) => a.y - b.y)) {
    const row = rows.find((r) => {
      const top = Math.max(...r.map((q) => q.y));
      const bot = Math.min(...r.map((q) => q.y + q.h));
      return Math.min(bot, p.y + p.h) - Math.max(top, p.y) > 0.5 * Math.min(p.h, bot - top);
    });
    if (row) row.push(p);
    else rows.push([p]);
  }
  return rows.flatMap((r) => r.sort((a, b) => (order === 'rtl' ? b.x - a.x : a.x - b.x)));
}
