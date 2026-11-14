/**
 * Persistent media index (images and videos of the user's folders): the expensive analyses
 * (probe, panels, perceptual fingerprint, comics format, OCR) are done once per file content and
 * reused by every production and every project.
 * - A file whose size and modification time did not change is reused as is.
 * - A moved or renamed file is recognised by its content fingerprint and keeps its analyses.
 * - A file no longer found is marked `missing` (kept, never deleted); it comes back if it reappears.
 * - Written atomically (temporary file + rename); a damaged index is set aside and rebuilt.
 * - Text search over names, tags, folders, user descriptions and OCR text (production/search.ts).
 * Source files are only read.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ComicImageInfo, MediaOcr, MediaProbe, MediaRights } from '../core';

export const MEDIA_INDEX_VERSION = 1;
/** Bump when the image analysis changes so entries are re-analysed. */
export const IMAGE_ANALYSER = 3;

export interface MediaIndexEntry {
  /** Content fingerprint (sha256 of head + tail + size): identity across moves. */
  hash: string;
  path: string;
  size: number;
  mtimeMs: number;
  kind: 'image' | 'video' | 'audio';
  probe: MediaProbe;
  panels?: { x: number; y: number; w: number; h: number }[];
  panelConfidence?: number;
  phash?: string;
  comic?: ComicImageInfo;
  ocr?: MediaOcr;
  /** Sidecar tags and description (re-read at every scan: cheap, and the user may edit them). */
  tags: string[];
  description?: string;
  rights?: MediaRights;
  missing?: boolean;
  analyser: number;
  analysedAt: string;
  seenAt: string;
}

export interface MediaIndex {
  version: number;
  updatedAt: string;
  entries: Record<string, MediaIndexEntry>;
}

export const emptyIndex = (): MediaIndex => ({ version: MEDIA_INDEX_VERSION, updatedAt: new Date().toISOString(), entries: {} });

export async function loadMediaIndex(file: string): Promise<MediaIndex> {
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8')) as MediaIndex;
    if (j.version !== MEDIA_INDEX_VERSION || typeof j.entries !== 'object') throw new Error('version');
    return j;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await fsp.rename(file, `${file}.damaged-${Date.now()}`).catch(() => undefined);
    return emptyIndex();
  }
}

export async function saveMediaIndex(file: string, idx: MediaIndex) {
  idx.updatedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(idx));
  await fsp.rename(tmp, file);
}

/** Entry for a path (exact path, same size and modification time), if still valid. */
export function entryForPath(idx: MediaIndex, file: string, size: number, mtimeMs: number): MediaIndexEntry | undefined {
  for (const e of Object.values(idx.entries)) if (e.path === file && e.size === size && Math.round(e.mtimeMs) === Math.round(mtimeMs)) return e;
  return undefined;
}

/** Marks entries under `roots` that were not seen in this scan as missing; returns how many. */
export function markMissing(idx: MediaIndex, roots: string[], seen: Set<string>): number {
  let n = 0;
  const norm = roots.map((r) => path.resolve(r) + path.sep);
  for (const e of Object.values(idx.entries)) {
    if (seen.has(e.hash) || e.missing) continue;
    if (norm.some((r) => e.path.startsWith(r))) {
      e.missing = true;
      n++;
    }
  }
  return n;
}

export { searchEntries, searchFields, type SearchMatch } from '../production/search';
