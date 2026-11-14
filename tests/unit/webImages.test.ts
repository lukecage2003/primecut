import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FetchLike, fetchWebImages, loadWebRights, normaliseLicense, webQueries, writeCredits } from '../../src/engine/webImages';

const jpeg = Buffer.alloc(20_000, 7);
function fakeFetch(log: string[], opts: { commonsStatus?: number } = {}): FetchLike {
  return async (url) => {
    log.push(url);
    const res = (status: number, body: unknown, type = 'application/json') => ({ ok: status < 400, status, headers: { get: (n: string) => (n === 'content-type' ? type : null) }, json: async () => body, arrayBuffer: async () => (body as Buffer).buffer.slice(0) as ArrayBuffer });
    if (url.startsWith('https://api.openverse.org')) {
      return res(200, { results: [
        { id: 'a1', title: 'Apocalypse figure', url: 'https://img.example/a1.jpg', foreign_landing_url: 'https://flickr.example/a1', creator: 'JD', license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', width: 1600, height: 1200 },
        { id: 'a2', title: 'NC picture', url: 'https://img.example/a2.jpg', license: 'by-nc', width: 1600, height: 1200 },
        { id: 'a3', title: 'Tiny', url: 'https://img.example/a3.jpg', license: 'cc0', width: 200, height: 150 },
        { id: 'a4', title: 'Public domain art', url: 'https://img.example/a4.jpg', license: 'pdm', width: 2000, height: 1400 },
      ] });
    }
    if (url.startsWith('https://commons.wikimedia.org')) return res(opts.commonsStatus ?? 200, { query: { pages: { 1: { pageid: 1, title: 'File:Fair.jpg', imageinfo: [{ url: 'https://up.example/f.jpg', descriptionurl: 'https://c/f', width: 2000, height: 1500, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'Fair use' } } }] } } } });
    return res(200, jpeg, 'image/jpeg');
  };
}

describe('free-picture search (opt-in)', () => {
  it('builds search words from visual hints, names and section titles', () => {
    const q = webQueries({ sentences: [{ hints: ['couverture X-Men 1'] } as never, { hints: ['couverture X-Men 1'] } as never], sections: [{ index: 0, title: 'Les origines' } as never] }, ['Apocalypse', 'En Sabah Nur']);
    expect(q).toEqual(['couverture X-Men 1', 'Apocalypse', 'En Sabah Nur', 'Les origines']);
  });

  it('normalises licences and keeps only those allowing commercial use and modification', () => {
    expect(normaliseLicense('CC BY-SA 4.0')).toEqual({ license: 'by-sa', version: '4.0' });
    expect(normaliseLicense('Public domain')?.license).toBe('pdm');
    expect(normaliseLicense('CC0')?.license).toBe('cc0');
    expect(normaliseLicense('by-nc')?.license).toBe('by-nc');
    expect(normaliseLicense('Fair use')).toBeNull();
  });

  it('downloads only licensed, large-enough pictures and records licence, author and credits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-web-'));
    const log: string[] = [];
    const r = await fetchWebImages({ queries: ['Apocalypse'], dir, perQuery: 3, fetchImpl: fakeFetch(log) });
    expect(r.downloaded.map((d) => d.candidate.id)).toEqual(['a1', 'a4']); // NC, too small and fair use refused
    expect(r.downloaded[0]!.rights).toMatchObject({ usage: 'reusable', source: 'openverse', license: 'CC-BY-2.0', sourceUrl: 'https://flickr.example/a1' });
    expect(r.downloaded[0]!.rights.attribution).toContain('par JD');
    expect(fs.readFileSync(r.creditsFile!, 'utf8')).toContain('Apocalypse figure');
    expect(Object.keys(loadWebRights(dir))).toHaveLength(2);
    // only search words and picture URLs were requested: no upload of any kind
    expect(log.every((u) => !/narration|\.wav/.test(u))).toBe(true);
  });

  it('reports a refused service instead of failing, and stops asking it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-web-'));
    const log: string[] = [];
    const r = await fetchWebImages({ queries: ['Apocalypse', 'Archangel'], dir, perQuery: 1, fetchImpl: fakeFetch(log, { commonsStatus: 429 }) });
    expect(r.errors.filter((e) => e.includes('HTTP 429'))).toHaveLength(1);
    expect(log.filter((u) => u.includes('wikimedia'))).toHaveLength(1);
    expect(r.downloaded.length).toBe(2);
  });

  it('writes credits only for Internet pictures', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-web-')), 'c.txt');
    expect(writeCredits(f, [{ usage: 'user-provided', source: 'user-library', checkedAt: '' }])).toBe(false);
    expect(writeCredits(f, [{ usage: 'reusable', source: 'openverse', attribution: '« A » par B — CC BY 2.0', checkedAt: '' }])).toBe(true);
  });
});
