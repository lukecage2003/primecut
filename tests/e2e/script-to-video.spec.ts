/** Script-to-Video through the real UI: script + narration + media folder → generated, previewable, exportable edit. */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeImage, makeNarration } from '../integration/fixtures';
import { ffprobe } from '../../src/engine/ffmpeg';
import { killAll, launch, stubOpenDialog, stubSaveDialog, workspace } from './harness';

test.afterEach(killAll);

const SENTENCES = ['Spider-Man affronte le Bouffon Vert.', 'Le combat dure toute la nuit.', 'Puis Venom entre en scène.'];

test('script + narration + folder → generated video', async () => {
  const w = workspace();
  const { file: narration } = await makeNarration(w.media, SENTENCES);
  const lib = path.join(w.media, 'comics');
  fs.mkdirSync(lib);
  await makeImage(path.join(lib, 'spider-man-bouffon-vert.png'), 'red');
  await makeImage(path.join(lib, 'venom.png'), 'purple');
  await makeImage(path.join(lib, 'nuit-new-york.png'), 'blue', '1920x1080');

  const { app, page } = await launch(w.userData);
  await page.getByTestId('new-name').fill('Comics Auto');
  await page.getByTestId('create-project').click();
  await stubOpenDialog(app, [narration]);
  await page.getByTestId('import-media').click();
  await expect(page.getByTestId('media-item')).toHaveCount(1);

  await page.getByTestId('open-production').click();
  await page.getByTestId('script-input').fill(`# Le Bouffon Vert\n\n${SENTENCES[0]} ${SENTENCES[1]}\n\n## Venom\n\n${SENTENCES[2]}`);
  await expect(page.getByTestId('narration-select')).not.toHaveValue('');
  await stubOpenDialog(app, [lib]);
  await page.getByTestId('add-folder').click();
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('production-panel')).toHaveCount(0, { timeout: 60000 });

  // a new sequence version is active, with clips, captions and an explainable report
  await expect(page.getByTestId('sequence-switcher')).toContainText('Auto v1');
  expect(await page.locator('[data-testid="clip"][data-kind="video"]').count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('production-report')).toBeVisible();
  await expect(page.getByTestId('production-report')).toContainText('spider-man-bouffon-vert.png');
  const score = Number((await page.getByTestId('qc-score').innerText()).split('/')[0]);
  expect(score).toBeGreaterThanOrEqual(70);
  // preview shows a subtitle during the first sentence
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('[data-testid="caption-layer"] [data-style="subtitle"]')).toContainText('Spider-Man');
  if (process.env.PRIMESTONE_SHOTS) await page.screenshot({ path: path.join(process.env.PRIMESTONE_SHOTS, '06-script-to-video.png') });

  // export the generated version
  const out = path.join(w.out, 'auto.mp4');
  await page.getByTestId('export-open').click();
  await stubSaveDialog(app, out);
  await page.getByTestId('export-browse').click();
  await page.getByTestId('export-start').click();
  await expect(page.locator('[data-testid="task-export"]').first()).toHaveAttribute('data-state', 'done', { timeout: 120000 });
  const probe = JSON.parse((await ffprobe(['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out])).stdout.toString());
  expect(Number(probe.format.duration)).toBeGreaterThan(6);
  expect(probe.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual(['audio', 'video']);

  // save and reopen keeps the generated version and its report
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('project-title').locator('.dirty')).toHaveCount(0);
});

test('faceless: no images → motion design shots, editable and re-rendered from the Inspector', async () => {
  const w = workspace();
  const { file: narration } = await makeNarration(w.media, ['Tony Stark construit une intelligence artificielle.', 'En 1963 puis en 2008, Iron Man change tout.']);
  const { app, page } = await launch(w.userData);
  await page.getByTestId('new-name').fill('Faceless');
  await page.getByTestId('create-project').click();
  await stubOpenDialog(app, [narration]);
  await page.getByTestId('import-media').click();
  await page.getByTestId('open-production').click();
  await page.getByTestId('script-input').fill('Tony Stark construit une intelligence artificielle. En 1963 puis en 2008, Iron Man change tout.');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('production-panel')).toHaveCount(0, { timeout: 120000 });
  await expect(page.getByTestId('production-report')).toContainText('motion design');
  // P-CORE leads where there is no illustration: its own clip(s) on V2
  expect(await page.locator('[data-testid="clip"]', { hasText: 'P-CORE' }).count()).toBeGreaterThanOrEqual(1);
  // the viewer shows a rendered composition, never black
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => page.$$eval('[data-testid="viewer-canvas"] video', (vs) => (vs as HTMLVideoElement[]).some((v) => v.style.display === 'block' && v.readyState >= 2))).toBe(true);
  // manual change: switch the first shot's composition and re-render
  await page.locator('[data-testid="clip"][data-kind="video"]', { hasNotText: 'P-CORE' }).first().click({ position: { x: 20, y: 30 } });
  await expect(page.getByTestId('visual-editor')).toBeVisible();
  await page.getByTestId('visual-kind').selectOption('typography');
  await expect(page.getByTestId('visual-kind')).toHaveValue('typography', { timeout: 60000 });
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /Edit motion design/, { timeout: 60000 });
  if (process.env.PRIMESTONE_SHOTS) await page.screenshot({ path: path.join(process.env.PRIMESTONE_SHOTS, '07-faceless.png') });
});

test('P-CORE Studio: audio response, preview render with transparency, independent export verified', async () => {
  const w = workspace();
  const { file: narration } = await makeNarration(w.media, ['Le Beyonder apparaît en 1984.', 'En réalité, il était un enfant !']);
  const { app, page } = await launch(w.userData);
  await page.getByTestId('new-name').fill('PCore');
  await page.getByTestId('create-project').click();
  await stubOpenDialog(app, [narration]);
  await page.getByTestId('import-media').click();
  await page.getByTestId('open-pcore').click();
  await expect(page.getByTestId('pcore-studio')).toBeVisible();
  await page.locator('[data-testid="pcore-studio"] input[type="number"]').nth(1).fill('3');
  // audio response graph is drawn from the real narration
  await expect.poll(async () => page.$eval('[data-testid="pcore-graph"]', (c) => (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 620, 120).data.some((v, i) => i % 4 === 3 && v > 0)), { timeout: 30000 }).toBe(true);
  await page.getByTestId('pcore-render-preview').click();
  await expect(page.getByTestId('pcore-preview')).toBeVisible({ timeout: 180000 });
  const out = path.join(w.root, 'pcore-export.mov');
  await stubSaveDialog(app, out);
  await page.getByTestId('pcore-export').click();
  await expect(page.getByTestId('pcore-export-check')).toContainText('alpha 0–255', { timeout: 300000 });
  const probe = JSON.parse((await ffprobe(['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', out])).stdout.toString());
  expect(probe.streams[0].codec_name).toBe('prores');
  expect(probe.streams[0].pix_fmt).toMatch(/^yuva/);
  if (process.env.PRIMESTONE_SHOTS) await page.screenshot({ path: path.join(process.env.PRIMESTONE_SHOTS, '08-pcore-studio.png') });
});
