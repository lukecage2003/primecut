import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** FFmpeg filters that exist only in GPL builds (libavfilter, CONFIG_GPL). The installer ships an LGPL FFmpeg. */
const GPL_ONLY = ['blackframe', 'boxblur', 'colormatrix', 'cover_rect', 'cropdetect', 'delogo', 'eq', 'find_rect', 'fspp', 'histeq', 'hqdn3d', 'interlace', 'kerndeint', 'mcdeint', 'mpdecimate', 'owdenoise', 'perspective', 'phase', 'pp', 'pp7', 'repeatfields', 'sab', 'smartblur', 'spp', 'stereo3d', 'super2xsai', 'tinterlace', 'uspp', 'vaguedenoiser'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

describe('LGPL FFmpeg', () => {
  it('no filter that only exists in GPL builds of FFmpeg is used by the app', () => {
    const used: string[] = [];
    for (const f of files(path.resolve('src'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const name of GPL_ONLY) {
        // a filter in a filter graph: start of a chain or after a comma/semicolon/label, followed by = or , or end
        const re = new RegExp(`(?:^|[,;'"\\]\`])${name}(?:=|,|'|"|\`|\\[|$)`, 'gm');
        if (re.test(src)) used.push(`${path.relative(process.cwd(), f)}: ${name}`);
      }
    }
    expect(used).toEqual([]);
  });
});
