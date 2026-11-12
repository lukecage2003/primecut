import path from 'node:path';
import { BrowserWindow, Menu, app, nativeTheme } from 'electron';
import { resolveFfmpeg, setFfmpegPaths } from '../engine/ffmpeg';
import { registerIpc } from './ipc';
import { registerProductionIpc } from './productionIpc';
import { registerMediaProtocol, registerSchemePrivileges } from './protocol';
import { loadSettings } from './settings';
import { registerPCoreIpc, renderPCore } from './pcoreRender';
import { pcoreFrames } from '../engine/pcore';
import { DEFAULT_PCORE_SETTINGS } from '../pcore/expression';

if (process.env.PRIMESTONE_USER_DATA) app.setPath('userData', process.env.PRIMESTONE_USER_DATA);

registerSchemePrivileges();
// P-CORE renders with WebGL2 on the GPU. Test machines without a GPU opt in to Chromium's software
// rasteriser explicitly with PRIMESTONE_SOFTWARE_GL=1 (never enabled by default in the app).
if (process.env.PRIMESTONE_SOFTWARE_GL === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

let mainWindow: BrowserWindow | null = null;
let closeAllowed = false;

function createWindow() {
  const settings = loadSettings();
  nativeTheme.themeSource = settings.theme;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    title: 'Primestone Motion Studio',
    backgroundColor: settings.theme === 'dark' ? '#0b0b0d' : '#f2f2f4',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    if (closeAllowed) return;
    e.preventDefault();
    mainWindow?.webContents.send('window:closeRequested');
  });
  mainWindow.on('closed', () => (mainWindow = null));
  // Never navigate away from the app or open external windows from content.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(app.getAppPath(), 'vendor', 'ffmpeg');
  setFfmpegPaths(resolveFfmpeg(bundled));
  if (!process.env.PRIMESTONE_DEVTOOLS) Menu.setApplicationMenu(null);
  registerMediaProtocol();
  registerIpc(() => mainWindow, () => (closeAllowed = true));
  registerProductionIpc();
  registerPCoreIpc();
  const cli = process.argv.indexOf('--pcore-render');
  if (cli >= 0) {
    // headless P-CORE render (tests, batch): electron . --pcore-render job.json
    void runPCoreCli(process.argv[cli + 1]!).then((code) => app.exit(code));
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (!process.argv.includes('--pcore-render')) app.quit();
});

async function runPCoreCli(jobFile: string): Promise<number> {
  const fs = await import('node:fs/promises');
  try {
    const j = JSON.parse(await fs.readFile(jobFile, 'utf8'));
    if (process.env.PRIMESTONE_DEBUG) console.error('pcore job', j.output);
    const fpsNum = j.fps.num / j.fps.den;
    const t0 = Date.now();
    const frames = await pcoreFrames(j.audioPath ?? null, { offsetSec: j.offsetSec ?? 0, durationSec: j.durationSec, fps: fpsNum, events: j.events, settings: j.settings });
    const t1 = Date.now();
    if (process.env.PRIMESTONE_DEBUG) console.error('frames', frames.length);
    const check = await renderPCore({ width: j.width, height: j.height, fps: j.fps, frames, settings: { ...DEFAULT_PCORE_SETTINGS, ...j.settings }, composition: j.composition ?? 'core', seed: j.seed ?? 7, format: j.format, output: j.output, quality: j.quality, audio: j.withAudio && j.audioPath ? { path: j.audioPath, offsetSec: j.offsetSec ?? 0 } : undefined });
    const states: Record<string, number> = {};
    for (const f of frames) states[f.state] = (states[f.state] ?? 0) + 1;
    await fs.writeFile(`${jobFile}.result.json`, JSON.stringify({ ok: true, check, analysisMs: t1 - t0, renderMs: Date.now() - t1, frames: frames.length, states, sample: frames.filter((_, i) => i % Math.max(1, Math.round(fpsNum / 2)) === 0).map((f) => [f.state, +f.energy.toFixed(2), +f.glow.toFixed(2), +f.fragment.toFixed(2), +f.rotY.toFixed(2)]) }, null, 1));
    return 0;
  } catch (e) {
    await fs.writeFile(`${jobFile}.result.json`, JSON.stringify({ ok: false, error: String((e as Error).stack ?? e) }));
    return 1;
  }
}
