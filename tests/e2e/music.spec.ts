/** Music library through the real UI: folder → local analysis task → table, licences, correction. */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ffmpeg } from '../../src/engine/ffmpeg';
import { killAll, launch, stubOpenDialog, workspace } from './harness';

test.afterEach(killAll);

test('music library: analyse a folder, show tempo/energy/licence, correct a mood', async () => {
  const w = workspace();
  const lib = path.join(w.media, 'Musique');
  fs.mkdirSync(lib, { recursive: true });
  const beat = (f: string, bpm: number, meta: string[] = []) => ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='0.6*(random(0)*2-1)*exp(-30*mod(t\\,${(60 / bpm).toFixed(4)}))':s=44100:d=20`, ...meta, '-y', path.join(lib, f)]);
  await beat('Course poursuite.mp3', 150, ['-metadata', 'title=Course poursuite', '-metadata', 'copyright=CC BY 4.0 — Studio X']);
  await beat('Marche lente.wav', 80);
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*110*t)':s=44100:d=20", '-y', path.join(lib, 'Nappe.flac')]);

  const { app, page } = await launch(w.userData);
  await page.getByTestId('new-name').fill('Musique');
  await page.getByTestId('create-project').click();
  await page.getByTestId('open-music').click();
  await expect(page.getByTestId('music-library')).toContainText('Ajoutez le dossier');
  await stubOpenDialog(app, [lib]);
  await page.getByTestId('music-add-folder').click();
  await expect(page.getByTestId('music-dirs')).toContainText('Musique');
  await page.getByTestId('music-scan').click();
  await expect(page.getByTestId('music-track')).toHaveCount(3, { timeout: 60000 });
  const course = page.getByTestId('music-track').filter({ hasText: 'Course poursuite' });
  await expect(course).toContainText('150');
  await expect(course).toContainText('CC-BY');
  await expect(page.getByTestId('music-track').filter({ hasText: 'Nappe' })).toContainText('inconnue');
  await expect(page.getByTestId('music-library')).toContainText('2 licence(s) inconnue(s)');
  // details and a user correction (kept in the index)
  await course.locator('.music-row').click();
  await expect(course).toContainText('rythme');
  await course.getByRole('button', { name: 'mystère' }).click();
  await expect(course.locator('.music-row')).toContainText('mystère');
  if (process.env.PRIMESTONE_SHOTS) await page.screenshot({ path: path.join(process.env.PRIMESTONE_SHOTS, '10-bibliotheque-musicale.png') });
  // originals untouched, index outside the library
  expect(fs.readdirSync(lib).sort()).toEqual(['Course poursuite.mp3', 'Marche lente.wav', 'Nappe.flac']);
  expect(fs.existsSync(path.join(w.userData, 'music-index.json'))).toBe(true);
});
