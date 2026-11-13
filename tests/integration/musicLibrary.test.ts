import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeMusicFile, effectiveTrack, ffmpeg, loadMusicIndex, recordMusicUsage, scanMusicLibrary, setMusicOverride } from '../../src/engine';
import { tmpDir } from './fixtures';

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// beat at `bpm`: decaying noise bursts (aevalsrc), optional tags
const beat = (file: string, bpm: number, sec: number, meta: string[] = [], codec: string[] = []) =>
  ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='0.6*(random(0)*2-1)*exp(-30*mod(t\\,${(60 / bpm).toFixed(4)}))':s=44100:d=${sec}`, ...meta, ...codec, '-y', file]);
const pad = (file: string, sec: number) => ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='0.2*sin(2*PI*110*t)*(0.8+0.2*sin(2*PI*0.2*t))':s=44100:d=${sec}`, '-y', file]);

describe('music library index', () => {
  it('analyses, finds declared licences only, detects copies, and updates incrementally', async () => {
    const d = tmpDir('ps-music-');
    const lib = path.join(d, 'Musique');
    fs.mkdirSync(path.join(lib, 'Pack'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'Copies'), { recursive: true });
    await beat(path.join(lib, 'action.mp3'), 150, 20, ['-metadata', 'title=Course', '-metadata', 'artist=Studio X', '-metadata', 'copyright=CC BY 4.0 — Studio X'], ['-c:a', 'libmp3lame', '-b:a', '160k']);
    await pad(path.join(lib, 'ambiance.wav'), 20);
    await beat(path.join(lib, 'Pack', 'pulse.flac'), 100, 20);
    fs.writeFileSync(path.join(lib, 'Pack', 'LICENSE.txt'), 'Royalty free music pack — usage commercial autorisé');
    await beat(path.join(lib, 'sidecar.ogg'), 120, 20, [], ['-c:a', 'libvorbis']);
    fs.writeFileSync(path.join(lib, 'sidecar.json'), JSON.stringify({ license: 'CC0 1.0', author: 'Anonyme', url: 'https://example.org/piste' }));
    fs.copyFileSync(path.join(lib, 'action.mp3'), path.join(lib, 'Copies', 'action (1).mp3'));
    const before = Object.fromEntries(fs.readdirSync(lib, { recursive: true }).map(String).filter((f) => /\.(mp3|wav|flac|ogg)$/.test(f)).map((f) => [f, sha(path.join(lib, f))]));
    const idx = path.join(d, 'music-index.json');

    const r1 = await scanMusicLibrary([lib], idx);
    expect(r1).toMatchObject({ found: 5, analysed: 4, failed: [] });
    const tracks = Object.values(r1.index.tracks);
    const by = (n: string) => tracks.find((t) => t.path.endsWith(n))!;
    expect(by('action.mp3').licence).toMatchObject({ status: 'déclarée', source: 'métadonnées', family: 'CC-BY' });
    expect(by('action.mp3').title).toBe('Course');
    expect(by('ambiance.wav').licence).toEqual({ status: 'inconnue' });
    expect(by('pulse.flac').licence).toMatchObject({ status: 'déclarée', source: 'dossier', family: 'libre de droits' });
    expect(by('sidecar.ogg').licence).toMatchObject({ status: 'déclarée', source: 'fichier voisin', family: 'CC0', url: 'https://example.org/piste' });
    const [a1, a2] = [by('action.mp3'), by('action (1).mp3')];
    expect([a1.duplicateOf, a2.duplicateOf].filter(Boolean)).toHaveLength(1);
    expect(a1.duplicateOf ?? a2.duplicateOf).toBe((a1.duplicateOf ? a2 : a1).id);
    // measurements: tempo of the beats, loudness, no tempo invented for the pad
    for (const [n, bpm] of [['action.mp3', 150], ['pulse.flac', 100], ['sidecar.ogg', 120]] as const) {
      const f = by(n).features;
      expect([f.bpm!, ...f.bpmAlternatives].some((b) => Math.abs(b - bpm) / bpm <= 0.04), `${n}: ${f.bpm}`).toBe(true);
    }
    expect(by('ambiance.wav').classification.energy).toBe('basse');
    expect(by('action.mp3').classification.energyScore).toBeGreaterThan(by('ambiance.wav').classification.energyScore);
    expect(by('action.mp3').loudness.integratedLufs).toBeLessThan(0);
    expect(by('action.mp3').classification.reasons.join(' ')).toMatch(/énergie/);

    // unchanged → nothing re-analysed
    const r2 = await scanMusicLibrary([lib], idx);
    expect(r2).toMatchObject({ found: 5, analysed: 0, reused: 5, missing: 0 });

    // corrections and usage survive a move; a removed file is kept as missing; a changed file is re-analysed
    const id = by('ambiance.wav').id;
    await setMusicOverride(idx, id, { moods: ['mystère'], licence: { status: 'déclarée', text: 'achetée sur une banque de sons' } });
    await recordMusicUsage(idx, id, { project: 'Projet A' });
    fs.renameSync(path.join(lib, 'ambiance.wav'), path.join(lib, 'Pack', 'nuit.wav'));
    fs.rmSync(path.join(lib, 'sidecar.ogg'));
    await beat(path.join(lib, 'Pack', 'pulse.flac'), 90, 20);
    const r3 = await scanMusicLibrary([lib], idx);
    expect(r3).toMatchObject({ moved: 1, missing: 1, analysed: 1 });
    const moved = (await loadMusicIndex(idx)).tracks[id]!;
    expect(moved.path).toMatch(/nuit\.wav$/);
    expect(moved.usage).toHaveLength(1);
    expect(effectiveTrack(moved).moods).toEqual(['mystère']);
    expect(effectiveTrack(moved).licence.source).toBe('utilisateur');
    expect(Object.values(r3.index.tracks).find((t) => t.path.endsWith('sidecar.ogg'))!.missing).toBe(true);

    // originals never written (the pulse file was replaced by the test itself)
    for (const [f, h] of Object.entries(before)) if (!/pulse|ambiance|sidecar/.test(f)) expect(sha(path.join(lib, f))).toBe(h);
  }, 180000);

  it('analyses a 3-minute track in under 5 seconds', async () => {
    const d = tmpDir('ps-music-perf-');
    const f = path.join(d, 'long.mp3');
    await beat(f, 128, 180, [], ['-c:a', 'libmp3lame', '-b:a', '192k']);
    const t0 = Date.now();
    const a = await analyzeMusicFile(f);
    const sec = (Date.now() - t0) / 1000;
    console.log(`analyse d'une piste de 3 min : ${sec.toFixed(2)} s`);
    expect(a.analysedSec).toBeGreaterThan(179);
    expect(sec).toBeLessThan(5);
  }, 120000);
});
