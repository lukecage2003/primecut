import path from 'node:path';
import { BrowserWindow, Menu, app, nativeTheme } from 'electron';
import { resolveFfmpeg, setFfmpegPaths } from '../engine/ffmpeg';
import { registerIpc } from './ipc';
import { registerMediaProtocol, registerSchemePrivileges } from './protocol';
import { loadSettings } from './settings';

if (process.env.PRIMESTONE_USER_DATA) app.setPath('userData', process.env.PRIMESTONE_USER_DATA);

registerSchemePrivileges();

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
  createWindow();
});

app.on('window-all-closed', () => app.quit());
