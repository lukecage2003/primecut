/**
 * Comic archives (CBZ / ZIP) → page images. Minimal ZIP reader (stored + deflate, via zlib) with the
 * usual protections: names inside the archive are never used as paths (pages are written as
 * page-0001.jpg… in reading order), entry count and total size are bounded (zip bombs), only images
 * are extracted, and the original archive is never modified. CBR (RAR) is not supported: RAR
 * decompression needs a non-free licence.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const ARCHIVE_EXT = new Set(['.cbz', '.zip']);
const IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const LIMITS = { entries: 3000, totalBytes: 2 * 1024 ** 3, archiveBytes: 1024 ** 3 };

interface Entry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  localOffset: number;
}

/** Central directory of a ZIP file (no ZIP64, no encryption). */
export function zipEntries(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('archive ZIP/CBZ illisible (fin de répertoire introuvable)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('archive ZIP64 non prise en charge');
  if (count > LIMITS.entries) throw new Error(`archive trop grande (${count} fichiers)`);
  const out: Entry[] = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('répertoire ZIP corrompu');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString(flags & 0x800 ? 'utf8' : 'latin1');
    if (flags & 1) throw new Error('archive chiffrée non prise en charge');
    out.push({ name, method, compSize, size, localOffset });
    p += 46 + nl + el + cl;
  }
  return out;
}

function readEntry(buf: Buffer, e: Entry): Buffer {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('entrée ZIP corrompue');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) });
  throw new Error(`méthode de compression ${e.method} non prise en charge`);
}

/** Natural order: "page 2" before "page 10", folders first by name. */
/** File-name safe text: only characters Windows forbids are replaced (parentheses, # and years survive). */
const safeName = (t: string) => t.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim().slice(0, 60) || 'archive';

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Extracts the pages of an archive into `<cacheDir>/archives/<hash>/` (once; cached by content hash).
 * Returns the page files in reading order.
 */
export async function extractComicArchive(file: string, cacheDir: string): Promise<{ dir: string; pages: string[]; title: string }> {
  const st = await fsp.stat(file);
  if (st.size > LIMITS.archiveBytes) throw new Error('archive de plus de 1 Go : découpez-la');
  const buf = await fsp.readFile(file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const title = path.basename(file).replace(/\.(cbz|zip)$/i, '');
  const dir = path.join(cacheDir, 'archives', `${safeName(title)}-${hash}`);
  const done = path.join(dir, '.complete');
  if (await fsp.stat(done).catch(() => null)) {
    const pages = (await fsp.readdir(dir)).filter((f) => IMAGE.test(f)).sort(natural).map((f) => path.join(dir, f));
    return { dir, pages, title };
  }
  const entries = zipEntries(buf)
    .filter((e) => IMAGE.test(e.name) && !e.name.endsWith('/') && !/(^|\/)(__MACOSX|\.)/.test(e.name))
    .sort((a, b) => natural(a.name, b.name));
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > LIMITS.totalBytes) throw new Error('contenu décompressé trop volumineux (> 2 Go)');
  await fsp.mkdir(dir, { recursive: true });
  const pages: string[] = [];
  for (const [i, e] of entries.entries()) {
    const ext = path.extname(e.name).toLowerCase().replace('.jpeg', '.jpg');
    const out = path.join(dir, `${safeName(title)} p${String(i + 1).padStart(3, '0')}${ext}`);
    await fsp.writeFile(out, readEntry(buf, e));
    pages.push(out);
  }
  await fsp.writeFile(done, JSON.stringify({ source: path.basename(file), pages: pages.length, sha256: hash }));
  return { dir, pages, title };
}
