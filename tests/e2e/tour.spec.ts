/**
 * Guided tour of the real application, with screenshots of every step (documentation / acceptance).
 * Runs only when PRIMESTONE_TOUR=<narration.wav> is set (optional: PRIMESTONE_TOUR_MODEL=<ggml model>,
 * PRIMESTONE_TOUR_PAGES=<folder of comic pages>, PRIMESTONE_TOUR_VOCAB="Name, Name",
 * PRIMESTONE_TOUR_WEB=1 to tick the free-picture Internet search). Screenshots go to
 * PRIMESTONE_SHOTS (default: test-results/tour).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ffmpeg } from '../../src/engine/ffmpeg';
import { launch, stubOpenDialog, stubSaveDialog, workspace } from './harness';

const NARRATION = process.env.PRIMESTONE_TOUR;
const SHOTS = process.env.PRIMESTONE_SHOTS ?? path.resolve('test-results/tour');

test.skip(!NARRATION, 'tour: set PRIMESTONE_TOUR to a narration file');

/** Synthetic comic-like test pages (gutters, panels, a balloon) when no real pages are given. */
async function testPages(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const pages: [string, string[]][] = [
    ['apocalypse-x-men-page-01.png', ['0x6b2a8a', '0x1d3f8f', '0xb8860b', '0x7a1f1f']],
    ['apocalypse-archangel-page-02.png', ['0x2f6f4f', '0x8f1d5f', '0x1d5f8f']],
    ['x-men-apocalypse-page-03.png', ['0x8f5f1d', '0x3a3a8f', '0x6f2f2f', '0x2f6f6f', '0x5f5f1d']],
  ];
  for (const [name, colors] of pages) {
    const W = 1200, H = 1800;
    const rows = colors.length <= 3 ? colors.length : 3;
    const boxes: string[] = [];
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const inRow = colors.length > 3 && r < colors.length - 3 ? 2 : 1;
      for (let c = 0; c < inRow && k < colors.length; c++, k++) {
        const x = 30 + (c * (W - 60)) / inRow, y = 30 + (r * (H - 60)) / rows;
        const w = (W - 60) / inRow - 30, h = (H - 60) / rows - 30;
        boxes.push(`drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(w)}:h=${Math.round(h)}:c=${colors[k]}:t=fill`, `drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(w)}:h=${Math.round(h)}:c=black:t=6`);
        boxes.push(`drawbox=x=${Math.round(x + w * 0.55)}:y=${Math.round(y + 30)}:w=${Math.round(w * 0.38)}:h=90:c=white:t=fill`);
      }
    }
    await ffmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}`, '-vf', boxes.join(','), '-frames:v', '1', path.join(dir, name)]);
  }
  return dir;
}

test('visite guidée : script + voix + planches → montage local, avec vue en direct', async () => {
  test.setTimeout(1_800_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = (page: import('@playwright/test').Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const w = workspace();
  if (process.env.PRIMESTONE_TOUR_MODEL) {
    const s = JSON.parse(fs.readFileSync(path.join(w.userData, 'settings.json'), 'utf8'));
    s.transcriber = { enabled: true, backend: 'whisper.cpp', whisperCppPath: path.resolve('vendor/whisper/whisper-cli'), modelPath: process.env.PRIMESTONE_TOUR_MODEL, language: 'fr', device: 'auto' };
    fs.writeFileSync(path.join(w.userData, 'settings.json'), JSON.stringify(s));
  }
  const pages = process.env.PRIMESTONE_TOUR_PAGES ?? (await testPages(path.join(w.media, 'Planches')));
  const { app, page } = await launch(w.userData);
  await page.setViewportSize({ width: 1600, height: 960 });
  await shot(page, '01-accueil');
  await page.getByTestId('new-name').fill('Apocalypse');
  await page.getByTestId('create-project').click();
  await stubOpenDialog(app, [NARRATION!]);
  await page.getByTestId('import-media').click();
  await expect(page.getByTestId('media-item')).toHaveCount(1);
  await shot(page, '02-projet-narration-importee');
  await page.getByTestId('open-production').click();
  if (process.env.PRIMESTONE_TOUR_SCRIPT) await page.getByTestId('script-input').fill(fs.readFileSync(process.env.PRIMESTONE_TOUR_SCRIPT, 'utf8'));
  if (process.env.PRIMESTONE_TOUR_VOCAB) await page.getByTestId('vocabulary').fill(process.env.PRIMESTONE_TOUR_VOCAB);
  await stubOpenDialog(app, [pages]);
  await page.getByTestId('add-folder').click();
  // opt-in Internet search for freely licensed pictures (PRIMESTONE_TOUR_WEB=1)
  if (process.env.PRIMESTONE_TOUR_WEB) await page.getByTestId('web-images').check();
  // an edit instruction in plain French: understood, listed, applied to the settings
  await page.getByTestId('command-input').fill('lis les cases plus lentement, voix radio');
  await page.getByTestId('command-apply').click();
  await expect(page.getByTestId('command-result')).toContainText('Appliqué');
  await shot(page, '03-script-video-reglages');
  await page.getByTestId('generate').click();
  // live view while the edit is built
  await expect(page.getByTestId('production-progress')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await shot(page, '04-generation-transcription');
  await expect(page.getByTestId('production-board')).toBeVisible({ timeout: 600_000 });
  await shot(page, '05-vue-en-direct-storyboard');
  await page.waitForTimeout(25_000);
  await shot(page, '06-vue-en-direct-rendus');
  await expect(page.getByTestId('production-panel')).toHaveCount(0, { timeout: 1_500_000 });
  await page.waitForTimeout(1500);
  await shot(page, '07-montage-genere');
  await page.keyboard.press('Home');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(1500);
  await shot(page, '08-apercu-planche-et-logo');
  await page.getByTestId('production-report').scrollIntoViewIfNeeded();
  await page.getByTestId('production-report').screenshot({ path: path.join(SHOTS, '09-rapport.png') });
  if (await page.getByTestId('pcore-direction').count()) await page.getByTestId('pcore-direction').screenshot({ path: path.join(SHOTS, '10-direction-pcore.png') });
  await page.getByTestId('decision-list').screenshot({ path: path.join(SHOTS, '11-decisions.png') });
  // P-CORE Studio
  await page.getByTestId('open-pcore').click();
  await expect(page.getByTestId('pcore-studio')).toBeVisible();
  await page.waitForTimeout(3000);
  await shot(page, '12-pcore-studio');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  // export
  const out = path.join(w.out, 'apocalypse.mp4');
  await page.getByTestId('export-open').click();
  await stubSaveDialog(app, out);
  await page.getByTestId('export-browse').click();
  await shot(page, '13-export');
  await page.getByTestId('export-start').click();
  await expect(page.locator('[data-testid="task-export"]').first()).toHaveAttribute('data-state', 'done', { timeout: 1_200_000 });
  await shot(page, '14-export-termine');
  fs.copyFileSync(out, path.join(SHOTS, 'export-visite.mp4'));
});
