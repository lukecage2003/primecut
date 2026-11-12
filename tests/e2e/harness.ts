import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface Session {
  app: ElectronApplication;
  page: Page;
}

export function workspace(): { root: string; userData: string; projects: string; media: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-'));
  const w = { root, userData: path.join(root, 'userData'), projects: path.join(root, 'Projects'), media: path.join(root, 'Media'), out: path.join(root, 'Exports') };
  for (const d of [w.userData, w.projects, w.media, w.out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(w.userData, 'settings.json'), JSON.stringify({ projectsDir: w.projects, autosaveSeconds: 10 }));
  return w;
}

const launched: { app: ElectronApplication; pid?: number }[] = [];
const pids = new WeakMap<ElectronApplication, number | undefined>();

/** Kills an app and all its child processes (on Windows SIGKILL would orphan Chromium helpers). */
export function killTree(app: ElectronApplication) {
  const pid = pids.get(app);
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Kills any app instance still running (used in afterEach so a failure never hangs the worker). */
export async function killAll() {
  for (const { app } of launched.splice(0)) killTree(app);
}

export async function launch(userData: string): Promise<Session> {
  const app = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    env: { ...process.env, PRIMESTONE_USER_DATA: userData },
  });
  pids.set(app, app.process().pid);
  launched.push({ app });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Makes the next native open dialog return `paths`. */
export async function stubOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as typeof dialog.showOpenDialog;
  }, paths);
}

export async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as typeof dialog.showSaveDialog;
  }, file);
}
