import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { MediaAsset, Project } from '../core/model';
import {
  TaskOrchestrator,
  cacheDirs,
  checkRelinkCandidate,
  chooseEncoder,
  discardAutosave,
  exportSequence,
  findRecovery,
  hardwareReport,
  importMediaFile,
  makePeaks,
  makeProxy,
  makeThumbnail,
  needsProxy,
  probeHwEncoders,
  projectPaths,
  readProjectFile,
  resolveMedia,
  saveProject,
  searchForMissing,
  writeAutosave,
  PROJECT_EXT,
} from '../engine';
import type { ExportOutcome, ExportRequest, ImportResult, OpenResult } from '../shared/api';
import { checkTranscriber } from '../engine/transcribe';
import { forgetRecent, listRecent, loadSettings, pushRecent, saveSettings } from './settings';

export const orchestrator = new TaskOrchestrator(2);
const exportResults = new Map<string, ExportOutcome>();
let hwEncoders: Promise<string[]> | null = null;

const MEDIA_FILTERS = [
  { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mxf', 'mts', 'm2ts', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] },
  { name: 'All files', extensions: ['*'] },
];

function win(e: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined;
}

function sanitizeName(name: string): string {
  const n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '');
  if (!n) throw new Error('Invalid project name');
  return n.slice(0, 120);
}

async function openProjectFile(file: string): Promise<OpenResult> {
  const parsed = await readProjectFile(file);
  const media = await resolveMedia(parsed.project, file);
  // Apply relocated paths in the returned project (the UI marks the project dirty).
  const project = structuredClone(parsed.project) as Project;
  for (const r of media) if (r.status === 'relocated' && project.media[r.id]) project.media[r.id]!.path = r.path;
  const recovery = await findRecovery(file);
  const cache = projectPaths(file).cache;
  cacheDirs(cache);
  await pushRecent(file, project.name);
  return {
    file,
    project,
    savedAt: parsed.savedAt,
    cacheDir: cache,
    media,
    issues: parsed.issues,
    recovery: recovery ? { project: recovery.project, savedAt: recovery.savedAt } : undefined,
  };
}

export function registerIpc(getWindow: () => BrowserWindow | null, allowClose: () => void) {
  orchestrator.on('changed', (t) => getWindow()?.webContents.send('tasks:changed', t));

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));
  ipcMain.handle('transcriber:check', (_e, cfg) => checkTranscriber(cfg));
  ipcMain.handle('transcriber:pick', async (e, kind: 'python' | 'whisper' | 'modelDir' | 'modelFile') => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r =
      kind === 'modelDir'
        ? await dialog.showOpenDialog(w, { title: 'Model folder (faster-whisper / CTranslate2)', properties: ['openDirectory'] })
        : await dialog.showOpenDialog(w, {
            title: kind === 'python' ? 'Python interpreter with faster-whisper' : kind === 'whisper' ? 'whisper.cpp executable (whisper-cli)' : 'ggml model file',
            properties: ['openFile'],
            filters: kind === 'modelFile' ? [{ name: 'ggml model', extensions: ['bin'] }] : undefined,
          });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('project:create', async (_e, dir: string, name: string, project: Project) => {
    const safe = sanitizeName(name);
    const folder = path.join(dir, safe);
    const file = path.join(folder, `${safe}${PROJECT_EXT}`);
    if (fs.existsSync(file)) throw new Error(`A project already exists at ${file}`);
    await fsp.mkdir(folder, { recursive: true });
    await saveProject(file, { ...project, name: safe }, app.getVersion());
    return openProjectFile(file);
  });
  ipcMain.handle('project:open', (_e, file: string) => openProjectFile(file));
  ipcMain.handle('project:save', async (_e, file: string, project: Project) => {
    const r = await saveProject(file, project, app.getVersion());
    await pushRecent(file, project.name);
    return r;
  });
  ipcMain.handle('project:autosave', (_e, file: string, project: Project) => writeAutosave(file, project, app.getVersion()));
  ipcMain.handle('project:discardRecovery', (_e, file: string) => discardAutosave(file));
  ipcMain.handle('project:recent', () => listRecent());
  ipcMain.handle('project:forgetRecent', (_e, file: string) => forgetRecent(file));
  ipcMain.handle('project:searchMissing', (_e, assets: MediaAsset[], root: string) => searchForMissing(assets, root));

  ipcMain.handle('dialog:openProject', async (e) => {
    const r = await dialog.showOpenDialog(win(e)!, { title: 'Open project', filters: [{ name: 'Primestone project', extensions: ['psproj'] }], properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('dialog:chooseFolder', async (e, title: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win(e)!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('dialog:importMedia', async (e) => {
    const r = await dialog.showOpenDialog(win(e)!, { title: 'Import media', filters: MEDIA_FILTERS, properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:exportTarget', async (e, name: string) => {
    const r = await dialog.showSaveDialog(win(e)!, { title: 'Export', defaultPath: name, filters: [{ name: 'MPEG-4', extensions: ['mp4'] }, { name: 'QuickTime', extensions: ['mov'] }, { name: 'Matroska', extensions: ['mkv'] }] });
    return r.canceled ? null : (r.filePath ?? null);
  });
  ipcMain.handle('dialog:relinkFile', async (e, name: string) => {
    const r = await dialog.showOpenDialog(win(e)!, { title: `Locate ${name}`, filters: MEDIA_FILTERS, properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('media:import', async (_e, projectFile: string, paths: string[]): Promise<ImportResult> => {
    const dir = path.dirname(projectFile);
    const results = await Promise.allSettled(paths.map((p) => importMediaFile(p, dir)));
    const out: ImportResult = { assets: [], errors: [] };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.assets.push(r.value);
      else out.errors.push({ path: paths[i]!, error: (r.reason as Error).message });
    });
    return out;
  });
  ipcMain.handle('media:thumbnail', (_e, projectFile: string, asset: MediaAsset) =>
    orchestrator.submit({ type: 'thumbnail', label: `Thumbnail · ${asset.name}`, priority: 'high', dedupeKey: `thumb:${asset.id}`, run: (c) => makeThumbnail(asset, cacheDirs(projectPaths(projectFile).cache), c.signal) }).promise,
  );
  ipcMain.handle('media:peaks', (_e, projectFile: string, asset: MediaAsset) =>
    orchestrator.submit({ type: 'waveform', label: `Waveform · ${asset.name}`, priority: 'high', dedupeKey: `peaks:${asset.id}`, run: (c) => makePeaks(asset, cacheDirs(projectPaths(projectFile).cache), c.signal) }).promise,
  );
  ipcMain.handle('media:needsProxy', (_e, asset: MediaAsset) => needsProxy(asset));
  ipcMain.handle('media:proxy', (_e, projectFile: string, asset: MediaAsset) =>
    orchestrator.submit({
      type: 'proxy',
      label: `Proxy · ${asset.name}`,
      priority: 'low',
      resources: { cpuSlots: 1 },
      dedupeKey: `proxy:${asset.id}`,
      run: (c) => makeProxy(asset, cacheDirs(projectPaths(projectFile).cache), (p) => c.progress(p), c.signal),
    }).promise,
  );
  ipcMain.handle('media:checkRelink', (_e, asset: MediaAsset, candidate: string) => checkRelinkCandidate(asset, candidate));

  ipcMain.handle('export:start', async (_e, req: ExportRequest) => {
    const settings = loadSettings();
    hwEncoders ??= probeHwEncoders();
    const encoder = chooseEncoder(req.project.exportSettings.videoCodec, req.project.exportSettings.hardware, settings.performanceProfile, await hwEncoders);
    const { id } = orchestrator.submit({
      type: 'export',
      label: `Export · ${path.basename(req.output)}`,
      priority: 'normal',
      resources: { cpuSlots: 2, gpu: !encoder.startsWith('lib') },
      run: async (c) => {
        c.log(`encoder: ${encoder}`);
        const r = await exportSequence({ project: req.project, sequenceId: req.sequenceId, output: req.output, encoder, cacheDir: projectPaths(req.projectFile).cache, signal: c.signal, onProgress: (p) => c.progress(p), onLog: c.log });
        const outcome: ExportOutcome = { output: req.output, encoder, frames: r.frames, durationSec: r.durationSec, width: r.width, height: r.height };
        exportResults.set(id, outcome);
        c.progress(1, `Verified · ${r.frames} frames · ${r.width}×${r.height}`);
        return outcome;
      },
    });
    return { taskId: id };
  });
  ipcMain.handle('export:result', (_e, id: string) => {
    const r = exportResults.get(id);
    if (!r) throw new Error('No result for this export');
    return r;
  });

  ipcMain.handle('tasks:list', () => orchestrator.list());
  ipcMain.handle('tasks:cancel', (_e, id: string) => orchestrator.cancel(id));
  ipcMain.handle('tasks:clearFinished', () => orchestrator.clearFinished());

  ipcMain.handle('system:hardware', () => hardwareReport());
  ipcMain.handle('system:reveal', (_e, f: string) => shell.showItemInFolder(f));

  ipcMain.handle('window:confirmClose', () => {
    allowClose();
    getWindow()?.close();
  });
}
