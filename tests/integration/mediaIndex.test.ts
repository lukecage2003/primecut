import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpeg } from '../../src/engine/ffmpeg';
import { loadMediaIndex } from '../../src/engine/mediaIndex';
import { findTesseract, ocrImage } from '../../src/engine/ocr';
import { scanMediaFolders } from '../../src/engine/production';
import { tmpDir } from './fixtures';

const page = (file: string, fill: string) =>
  ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=800x1200', '-vf', ['drawbox=x=20:y=20:w=360:h=560', 'drawbox=x=420:y=20:w=360:h=560', 'drawbox=x=20:y=620:w=760:h=560'].map((b) => `${b}:c=${fill}:t=fill`).join(','), '-frames:v', '1', file]);

describe('persistent media index', () => {
  it('reuses analyses, recognises moved files, re-analyses changed ones and keeps missing ones', async () => {
    const d = tmpDir('ps-index-');
    const lib = path.join(d, 'lib');
    fs.mkdirSync(path.join(lib, 'sub'), { recursive: true });
    const indexFile = path.join(d, 'media-index.json');
    await page(path.join(lib, 'thanos-gant.png'), 'purple');
    await page(path.join(lib, 'sub', 'hulk.png'), 'green');
    await page(path.join(lib, 'iron-man.png'), 'red');
    fs.writeFileSync(path.join(lib, 'iron-man.json'), JSON.stringify({ description: 'Tony Stark dans son armure', tags: ['Avengers'] }));

    const first = await scanMediaFolders([lib], d, new Set(), undefined, 2000, { indexFile });
    expect(first.stats).toMatchObject({ analysed: 3, reused: 0, moved: 0, missing: 0 });
    const thanos = first.assets.find((a) => a.name === 'thanos-gant.png')!;
    expect(thanos.panels).toHaveLength(3);
    expect(thanos.panelConfidence).toBeGreaterThan(0.7);
    expect(first.assets.find((a) => a.name === 'iron-man.png')!.description).toBe('Tony Stark dans son armure');

    // unchanged: everything reused, no new analysis, same results
    const second = await scanMediaFolders([lib], d, new Set(), undefined, 2000, { indexFile });
    expect(second.stats).toMatchObject({ analysed: 0, reused: 3 });
    expect(second.assets.find((a) => a.name === 'thanos-gant.png')!.panels).toEqual(thanos.panels);

    // moved + renamed: recognised by content; changed: re-analysed; deleted: marked missing (kept)
    fs.renameSync(path.join(lib, 'sub', 'hulk.png'), path.join(lib, 'le-hulk.png'));
    await page(path.join(lib, 'thanos-gant.png'), 'yellow');
    fs.utimesSync(path.join(lib, 'thanos-gant.png'), new Date(), new Date(Date.now() + 5000));
    fs.rmSync(path.join(lib, 'iron-man.png'));
    const third = await scanMediaFolders([lib], d, new Set(), undefined, 2000, { indexFile });
    expect(third.stats).toMatchObject({ moved: 1, analysed: 1, missing: 1 });
    const idx = await loadMediaIndex(indexFile);
    const entries = Object.values(idx.entries);
    expect(entries.find((e) => e.path.endsWith('le-hulk.png'))).toBeDefined();
    expect(entries.find((e) => e.path.endsWith('iron-man.png'))!.missing).toBe(true);
    // a damaged index is set aside and rebuilt, never fatal
    fs.writeFileSync(indexFile, '{ broken');
    const again = await scanMediaFolders([lib], d, new Set(), undefined, 2000, { indexFile });
    expect(again.stats.analysed).toBe(2);
    expect(fs.readdirSync(d).some((f) => f.startsWith('media-index.json.damaged-'))).toBe(true);
  }, 120000);

  it.skipIf(!findTesseract())('reads the text of a page with a locally installed Tesseract', async () => {
    const d = tmpDir('ps-ocr-');
    const f = path.join(d, 'bulle.png');
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=900x300', '-vf', "drawtext=text='THANOS ATTAQUE':fontsize=72:fontcolor=black:x=60:y=110", '-frames:v', '1', f]);
    const r = await ocrImage(f, { enabled: true, languages: 'eng' });
    expect(r.text.toUpperCase()).toContain('THANOS');
    expect(r.zones.length).toBeGreaterThan(0);
  }, 60000);
});
