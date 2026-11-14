/**
 * Optional search for freely licensed pictures on the Internet (opt-in, off by default).
 *
 * Sources: Openverse (api.openverse.org, keyless, CC-licensed and public-domain works) and Wikimedia
 * Commons (keyless MediaWiki API). Only licences that allow commercial use AND modification are kept
 * (CC0, public domain mark, CC BY, CC BY-SA): a monetised video crops, zooms and pans every picture.
 *
 * What leaves the machine: the search words only (names and [VISUEL: …] hints of the script). No media,
 * no narration, no account, no key. Every downloaded picture keeps its licence, author and source page
 * (MediaRights) and a credits file is written next to the downloads — attribution is required by CC BY.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MediaRights } from '../core/model';
import type { ParsedScript } from '../production/script';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>;

export interface WebImageCandidate {
  provider: 'openverse' | 'wikimedia-commons';
  id: string;
  title: string;
  url: string;
  sourceUrl: string;
  creator: string | null;
  license: string; // normalised: 'cc0' | 'pdm' | 'by' | 'by-sa'
  licenseVersion: string | null;
  licenseUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface WebImageResult {
  query: string;
  file: string;
  candidate: WebImageCandidate;
  rights: MediaRights;
}

export interface WebSearchReport {
  queries: string[];
  downloaded: WebImageResult[];
  errors: string[];
  creditsFile: string | null;
}

const UA = 'Primestone/1.0 (local video editor; free-licence image search)';
const ALLOWED = new Set(['cc0', 'pdm', 'by', 'by-sa']);
const MIN_SIDE = 640;
const MAX_BYTES = 15 * 1024 * 1024;
const RIGHTS_FILE = 'licences.json';

/** Licence records of the pictures already downloaded in a folder (file name → rights). */
export function loadWebRights(dir: string): Record<string, MediaRights> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, RIGHTS_FILE), 'utf8')) as Record<string, MediaRights>;
  } catch {
    return {};
  }
}

/** Search words from the script: [VISUEL: …] hints first, then the creator's names, then section titles. */
export function webQueries(script: Pick<ParsedScript, 'sentences' | 'sections'>, vocabulary: string[] = [], max = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const clean = q.replace(/\s+/g, ' ').replace(/^[\s«"'(]+|[\s»"'.,;:!?)]+$/g, '').trim();
    const key = clean.toLowerCase();
    if (clean.length < 3 || clean.length > 80 || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  for (const s of script.sentences) for (const h of s.hints) push(h);
  for (const v of vocabulary) push(v);
  for (const s of script.sections) if (s.title) push(s.title);
  return out.slice(0, max);
}

export function normaliseLicense(raw: string | null | undefined): { license: string; version: string | null } | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[_]/g, ' ').trim();
  if (/^(cc0|cc-zero|cc zero)/.test(s)) return { license: 'cc0', version: '1.0' };
  if (/^(pdm|public domain|pd\b|pd-)/.test(s)) return { license: 'pdm', version: null };
  const m = s.match(/^(?:cc[- ])?(by(?:[- ](?:sa|nc|nd|nc[- ]sa|nc[- ]nd))?)(?:[- ]?(\d(?:\.\d)?))?/);
  if (!m) return null;
  const license = m[1]!.replace(/ /g, '-');
  return { license, version: m[2] ?? null };
}

function licenseUrlOf(license: string, version: string | null): string | null {
  if (license === 'cc0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (license === 'pdm') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  return `https://creativecommons.org/licenses/${license}/${version ?? '4.0'}/`;
}

const stripHtml = (s: string | undefined | null) => (s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;

export async function searchOpenverse(query: string, n: number, fetchImpl: FetchLike, signal?: AbortSignal): Promise<WebImageCandidate[]> {
  const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(20, n * 3)}&license_type=commercial,modification&mature=false`;
  const r = await fetchImpl(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
  if (!r.ok) throw new Error(`Openverse : HTTP ${r.status}`);
  const j = (await r.json()) as { results?: { id: string; title?: string; url: string; foreign_landing_url?: string; creator?: string; license: string; license_version?: string; license_url?: string; width?: number; height?: number }[] };
  return (j.results ?? []).flatMap((x) => {
    const lic = normaliseLicense(x.license);
    if (!lic || !ALLOWED.has(lic.license)) return [];
    return [{ provider: 'openverse' as const, id: x.id, title: x.title ?? query, url: x.url, sourceUrl: x.foreign_landing_url ?? x.url, creator: x.creator ?? null, license: lic.license, licenseVersion: x.license_version ?? lic.version, licenseUrl: x.license_url ?? licenseUrlOf(lic.license, x.license_version ?? lic.version), width: x.width ?? null, height: x.height ?? null }];
  });
}

export async function searchCommons(query: string, n: number, fetchImpl: FetchLike, signal?: AbortSignal): Promise<WebImageCandidate[]> {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}&gsrnamespace=6&gsrlimit=${Math.min(20, n * 3)}&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize%7Cmime&iiurlwidth=1920&format=json&origin=*`;
  const r = await fetchImpl(u, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' }, signal });
  if (!r.ok) throw new Error(`Wikimedia Commons : HTTP ${r.status}`);
  const j = (await r.json()) as { query?: { pages?: Record<string, { pageid: number; title: string; imageinfo?: { url: string; thumburl?: string; descriptionurl: string; width: number; height: number; mime: string; extmetadata?: Record<string, { value?: string }> }[] }> } };
  return Object.values(j.query?.pages ?? {}).flatMap((p) => {
    const ii = p.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime)) return [];
    const md = ii.extmetadata ?? {};
    const lic = normaliseLicense(md.LicenseShortName?.value ?? md.License?.value);
    if (!lic || !ALLOWED.has(lic.license)) return [];
    // non-free / fair-use files are refused even when tagged loosely
    if (/fair use|non-free/i.test(`${md.UsageTerms?.value ?? ''} ${md.Restrictions?.value ?? ''}`)) return [];
    return [{ provider: 'wikimedia-commons' as const, id: String(p.pageid), title: p.title.replace(/^File:/, '').replace(/\.[^.]+$/, ''), url: ii.thumburl ?? ii.url, sourceUrl: ii.descriptionurl, creator: stripHtml(md.Artist?.value), license: lic.license, licenseVersion: lic.version, licenseUrl: md.LicenseUrl?.value ?? licenseUrlOf(lic.license, lic.version), width: ii.width, height: ii.height }];
  });
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'image';

function credit(c: WebImageCandidate): string {
  const lic = c.license === 'cc0' ? 'CC0 1.0' : c.license === 'pdm' ? 'Domaine public' : `CC ${c.license.toUpperCase()} ${c.licenseVersion ?? ''}`.trim();
  return `« ${c.title} »${c.creator ? ` par ${c.creator}` : ''} — ${lic}${c.licenseUrl ? ` (${c.licenseUrl})` : ''} — ${c.sourceUrl}`;
}

/** Searches, downloads and records pictures for each query. Never throws for a network problem: it reports. */
export async function fetchWebImages(opts: { queries: string[]; dir: string; perQuery?: number; fetchImpl: FetchLike; signal?: AbortSignal; providers?: ('openverse' | 'wikimedia-commons')[]; progress?: (f: number, msg: string) => void }): Promise<WebSearchReport> {
  const per = opts.perQuery ?? 2;
  const providers = opts.providers ?? ['openverse', 'wikimedia-commons'];
  const report: WebSearchReport = { queries: opts.queries, downloaded: [], errors: [], creditsFile: null };
  if (!opts.queries.length) return report;
  fs.mkdirSync(opts.dir, { recursive: true });
  const takenUrls = new Set<string>();
  const disabled = new Set<string>();
  for (const [qi, query] of opts.queries.entries()) {
    if (opts.signal?.aborted) break;
    opts.progress?.(qi / opts.queries.length, `Recherche d'images libres : « ${query} »`);
    const found: WebImageCandidate[] = [];
    for (const p of providers) {
      if (disabled.has(p)) continue;
      try {
        found.push(...(p === 'openverse' ? await searchOpenverse(query, per, opts.fetchImpl, opts.signal) : await searchCommons(query, per, opts.fetchImpl, opts.signal)));
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        report.errors.push(`${(e as Error).message} (« ${query} »)`);
        // a refused or rate-limited service is not asked again during this production
        if (/HTTP (403|429)/.test((e as Error).message)) disabled.add(p);
      }
    }
    const usable = found.filter((c) => !takenUrls.has(c.url) && (c.width == null || c.height == null || Math.max(c.width, c.height) >= MIN_SIDE));
    let got = 0;
    for (const c of usable) {
      if (got >= per || opts.signal?.aborted) break;
      try {
        const r = await opts.fetchImpl(c.url, { headers: { 'User-Agent': UA }, signal: opts.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const type = r.headers.get('content-type') ?? '';
        const ext = /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : /jpe?g/.test(type) ? 'jpg' : null;
        if (!ext) throw new Error(`type ${type || 'inconnu'}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 8_000 || buf.length > MAX_BYTES) throw new Error(`taille ${buf.length} o`);
        const h = crypto.createHash('sha1').update(c.provider + c.id).digest('hex').slice(0, 8);
        const file = path.join(opts.dir, `${slug(query)} - ${slug(c.title).slice(0, 30)} - ${c.provider === 'openverse' ? 'ov' : 'wc'}${h}.${ext}`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { flag: 'wx' });
        takenUrls.add(c.url);
        got++;
        report.downloaded.push({
          query,
          file,
          candidate: c,
          rights: { usage: 'reusable', source: c.provider, license: c.license === 'cc0' ? 'CC0-1.0' : c.license === 'pdm' ? 'PDM-1.0' : `CC-${c.license.toUpperCase()}-${c.licenseVersion ?? '4.0'}`, licenseUrl: c.licenseUrl ?? undefined, attribution: credit(c), sourceUrl: c.sourceUrl, checkedAt: new Date().toISOString(), note: c.license === 'by' || c.license === 'by-sa' ? 'Attribution obligatoire (voir le fichier de crédits).' : 'Libre de droits.' },
        });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        report.errors.push(`Téléchargement refusé (${(e as Error).message}) : ${c.sourceUrl}`);
      }
    }
  }
  if (report.downloaded.length) {
    const all = { ...loadWebRights(opts.dir), ...Object.fromEntries(report.downloaded.map((d) => [path.basename(d.file), d.rights])) };
    fs.writeFileSync(path.join(opts.dir, RIGHTS_FILE), JSON.stringify(all, null, 2), 'utf8');
    report.creditsFile = path.join(opts.dir, 'CRÉDITS IMAGES.txt');
    writeCredits(report.creditsFile, Object.values(all));
  }
  opts.progress?.(1, `Images libres : ${report.downloaded.length} téléchargée(s)`);
  return report;
}

/** Credits for the pictures that need them (also written next to an export that uses them). */
export function writeCredits(file: string, rights: MediaRights[]): boolean {
  const lines = [...new Set(rights.filter((r) => r.source === 'openverse' || r.source === 'wikimedia-commons').map((r) => r.attribution).filter(Boolean))];
  if (!lines.length) return false;
  fs.writeFileSync(file, `Crédits des images (licences libres) — à copier dans la description de la vidéo\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`, 'utf8');
  return true;
}
