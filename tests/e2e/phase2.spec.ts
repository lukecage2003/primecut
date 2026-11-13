import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeColorClip } from '../integration/fixtures';
import { killAll, launch, stubOpenDialog, workspace } from './harness';

test.afterEach(killAll);

test('transitions and fades through the UI', async () => {
  const w = workspace();
  const clip = await makeColorClip(path.join(w.media, 'green.mp4'), 'green', 4);
  const { app, page } = await launch(w.userData);
  await page.getByTestId('new-name').fill('Transitions');
  await page.getByTestId('create-project').click();
  await stubOpenDialog(app, [clip]);
  await page.getByTestId('import-media').click();
  await page.getByTestId('add-to-timeline').click();
  // split at 2s, then Ctrl+D on the cut → video dissolve + audio crossfade
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('s');
  await page.keyboard.press('Control+d');
  await expect(page.getByTestId('transition')).toHaveCount(2);
  await expect(page.getByTestId('transition-inspector')).toContainText('Fondu enchaîné');
  // remove one with Delete, undo brings it back
  await page.getByTestId('transition').first().click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('transition')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('transition')).toHaveCount(2);
  // fade-in on the first clip via the inspector slider (keyboard)
  await page.locator('[data-testid="clip"][data-kind="video"][data-start="0"]').click({ position: { x: 30, y: 30 } });
  const fade = page.getByTestId('insp-fadeIn');
  await fade.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-testid="clip"][data-start="0"] .fade.in')).toHaveCount(2);
  if (process.env.PRIMESTONE_SHOTS) await page.screenshot({ path: path.join(process.env.PRIMESTONE_SHOTS, '05-transitions.png') });
  // closing with unsaved changes asks first; Cancel keeps the window open
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect(page.getByRole('dialog', { name: 'Enregistrer les modifications ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.getByTestId('project-title')).toBeVisible();
});
