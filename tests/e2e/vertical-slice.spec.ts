/**
 * Phase 1 acceptance: the complete vertical slice, driven through the real UI.
 * 1 launch · 2 create project · 3 import · 4 library · 5 add to timeline · 6 play/preview ·
 * 7 cut + move · 8 save · 9 close · 10 reopen · 11 edit restored · 12 export verified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { audioRms, frameColor, makeColorClip } from '../integration/fixtures';
import { readProjectFile } from '../../src/engine/projectStore';
import { ffprobe } from '../../src/engine/ffmpeg';
import { killAll, launch, stubOpenDialog, stubSaveDialog, workspace } from './harness';

test.afterEach(killAll);

const shots = process.env.PRIMESTONE_SHOTS;
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

async function clipBoxes(page: import('@playwright/test').Page) {
  return page.$$eval('[data-testid="clip"]', (els) =>
    els.map((e) => ({ kind: (e as HTMLElement).dataset.kind!, start: Number((e as HTMLElement).dataset.start), duration: Number((e as HTMLElement).dataset.duration) })).sort((a, b) => a.kind.localeCompare(b.kind) || a.start - b.start),
  );
}

test('vertical slice: create → import → edit → save → reopen → export', async () => {
  const w = workspace();
  const red = await makeColorClip(path.join(w.media, 'red.mp4'), 'red', 2, { size: '1280x720' });
  const blue = await makeColorClip(path.join(w.media, 'blue.mp4'), 'blue', 2, { size: '1280x720', freq: 880 });

  // 1. launch
  let { app, page } = await launch(w.userData);
  await expect(page.getByTestId('create-project')).toBeVisible();
  await shot(page, '01-home');

  // 2. create project
  await page.getByTestId('new-name').fill('E2E Film');
  await page.getByTestId('preset-1080p30').click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toContainText('E2E Film');
  const projectFile = path.join(w.projects, 'E2E Film', 'E2E Film.psproj');
  expect(fs.existsSync(projectFile)).toBe(true);

  // 3-4. import two videos, visible in the library with thumbnails
  await stubOpenDialog(app, [red, blue]);
  await page.getByTestId('import-media').click();
  await expect(page.getByTestId('media-item')).toHaveCount(2);
  await expect(page.locator('[data-testid="media-item"][data-name="red.mp4"] .media-thumb')).toHaveAttribute('style', /pmedia/, { timeout: 20000 });

  // 5. add both to the timeline (red at 0, blue at the end)
  await page.locator('[data-testid="media-item"][data-name="red.mp4"]').getByTestId('add-to-timeline').click();
  await page.keyboard.press('End');
  await page.locator('[data-testid="media-item"][data-name="blue.mp4"]').getByTestId('add-to-timeline').click();
  expect(await clipBoxes(page)).toEqual([
    { kind: 'audio', start: 0, duration: 60 },
    { kind: 'audio', start: 60, duration: 60 },
    { kind: 'video', start: 0, duration: 60 },
    { kind: 'video', start: 60, duration: 60 },
  ]);

  // 6. play and preview
  await page.keyboard.press('Home');
  await page.getByTestId('play').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('play').click();
  const tc = await page.getByTestId('timecode').innerText();
  expect(tc).not.toBe('00:00:00:00');
  const visibleVideo = () =>
    page.$$eval('[data-testid="viewer-canvas"] video', (vs) =>
      (vs as HTMLVideoElement[]).filter((v) => v.style.display === 'block').map((v) => ({ t: v.currentTime, ready: v.readyState, w: v.videoWidth, seeking: v.seeking })),
    );
  // After pausing, the preview seeks to the exact paused frame and must settle with a decoded frame.
  await expect.poll(async () => { const s = await visibleVideo(); return s.length === 1 && !s[0]!.seeking && s[0]!.ready >= 2; }, { timeout: 10000 }).toBe(true);
  const [videoState] = await visibleVideo();
  expect(videoState!.t).toBeGreaterThan(0.3);
  expect(videoState!.w).toBe(1280);
  await shot(page, '02-editor-playing');

  // 7. cut at frame 30 and move the red tail after the blue clip (drag with snapping)
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByTestId('timecode')).toHaveText('00:00:01:00');
  await page.keyboard.press('s');
  expect((await clipBoxes(page)).length).toBe(6);
  const tail = page.locator('[data-testid="clip"][data-kind="video"][data-start="30"]');
  const box = (await tail.boundingBox())!;
  const zoom = 4; // default px per frame
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45 * zoom, box.y + box.height / 2, { steps: 8 });
  await page.mouse.move(box.x + box.width / 2 + 88 * zoom, box.y + box.height / 2, { steps: 8 }); // snaps to 120
  await page.mouse.up();
  expect(await clipBoxes(page)).toEqual([
    { kind: 'audio', start: 0, duration: 30 },
    { kind: 'audio', start: 60, duration: 60 },
    { kind: 'audio', start: 120, duration: 30 },
    { kind: 'video', start: 0, duration: 30 },
    { kind: 'video', start: 60, duration: 60 },
    { kind: 'video', start: 120, duration: 30 },
  ]);
  // undo/redo round-trip
  await page.keyboard.press('Control+z');
  expect((await clipBoxes(page)).find((c) => c.kind === 'video' && c.start === 30)).toBeTruthy();
  await page.keyboard.press('Control+Shift+z');
  expect((await clipBoxes(page)).find((c) => c.kind === 'video' && c.start === 120)).toBeTruthy();
  await shot(page, '03-edited');

  // 8. save
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('toast-success').filter({ hasText: 'saved' })).toBeVisible();
  await expect(page.getByTestId('project-title').locator('.dirty')).toHaveCount(0);
  const onDisk = await readProjectFile(projectFile);
  expect(onDisk.issues).toEqual([]);

  // 9. close the application
  await app.close();

  // 10. relaunch and reopen from the recent list
  ({ app, page } = await launch(w.userData));
  await expect(page.getByTestId('recent-item')).toHaveCount(1);
  await page.getByTestId('recent-item').click();
  await expect(page.getByTestId('project-title')).toContainText('E2E Film');

  // 11. the edit is restored exactly
  expect(await clipBoxes(page)).toEqual([
    { kind: 'audio', start: 0, duration: 30 },
    { kind: 'audio', start: 60, duration: 60 },
    { kind: 'audio', start: 120, duration: 30 },
    { kind: 'video', start: 0, duration: 30 },
    { kind: 'video', start: 60, duration: 60 },
    { kind: 'video', start: 120, duration: 30 },
  ]);
  await expect(page.getByTestId('media-item')).toHaveCount(2);

  // 12. export and verify the file
  const out = path.join(w.out, 'e2e-film.mp4');
  await page.getByTestId('export-open').click();
  await stubSaveDialog(app, out);
  await page.getByTestId('export-browse').click();
  await expect(page.getByTestId('export-path')).toHaveValue(out);
  await page.getByTestId('export-start').click();
  await expect(page.locator('[data-testid="task-export"]').first()).toHaveAttribute('data-state', 'done', { timeout: 120000 });
  await shot(page, '04-exported');
  expect(fs.existsSync(out)).toBe(true);
  const probe = JSON.parse((await ffprobe(['-v', 'error', '-count_packets', '-print_format', 'json', '-show_streams', out])).stdout.toString());
  const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  expect(v.width).toBe(1920);
  expect(v.height).toBe(1080);
  expect(Number(v.nb_read_packets)).toBe(150);
  const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 60 && b! < 60;
  const isBlue = ([r, g, b]: number[]) => b! > 200 && r! < 60 && g! < 60;
  expect(isRed(await frameColor(out, 0.5))).toBe(true);
  expect(isBlue(await frameColor(out, 3))).toBe(true);
  expect(isRed(await frameColor(out, 4.5))).toBe(true);
  expect(await audioRms(out, 1.1, 1.9)).toBeLessThan(0.01); // gap is silent
  expect(await audioRms(out, 2.2, 3.8)).toBeGreaterThan(0.03);
  await app.close();
});

test('crash recovery: autosave restores unsaved edits after a hard kill', async () => {
  const w = workspace();
  const red = await makeColorClip(path.join(w.media, 'red.mp4'), 'red', 2);
  let { app, page } = await launch(w.userData);
  await page.getByTestId('new-name').fill('Crashy');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toContainText('Crashy');
  await stubOpenDialog(app, [red]);
  await page.getByTestId('import-media').click();
  await page.getByTestId('add-to-timeline').click();
  await expect(page.getByTestId('clip')).toHaveCount(2);
  const autosave = path.join(w.projects, 'Crashy', 'Autosave', 'Crashy.autosave.psproj');
  await expect.poll(() => fs.existsSync(autosave), { timeout: 20000 }).toBe(true);
  app.process().kill('SIGKILL');

  ({ app, page } = await launch(w.userData));
  await page.getByTestId('recent-item').click();
  await expect(page.getByRole('dialog', { name: 'Recover unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByTestId('clip')).toHaveCount(2);
  await expect(page.getByTestId('project-title').locator('.dirty')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('project-title').locator('.dirty')).toHaveCount(0);
  expect(fs.existsSync(autosave)).toBe(false);
  await app.close();
});
