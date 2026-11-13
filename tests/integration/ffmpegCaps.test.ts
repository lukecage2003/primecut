import { describe, expect, it } from 'vitest';
import { dependencyReport, ffmpegCapabilities } from '../../src/engine';

describe('FFmpeg capabilities (non-regression gate for any FFmpeg binary)', () => {
  it('the FFmpeg in use has every encoder, decoder, filter and format Primestone needs, and is redistributable', async () => {
    const c = await ffmpegCapabilities();
    expect(c.missing).toEqual([]);
    expect(c.nonfree).toBe(false);
    expect(c.licence).toMatch(/GPL/);
    const deps = await dependencyReport();
    expect(deps.find((d) => d.name === 'Fonctions FFmpeg')).toMatchObject({ ok: true });
  });
});
