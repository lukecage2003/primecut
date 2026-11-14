import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { MediaAsset, Project } from '../core/model';
import { captionsToSubtitleFile } from '../core/captions';
import {
  TaskOrchestrator,
  cacheDirs,
  checkRelinkCandidate,
  chooseEncoder,
  discardAutosave,
  exportSequence,
  findRecovery,
  hardwareReport,
  diagnostics,
  effectiveTrack,
  loadMusicIndex,
  scanMusicLibrary,
  setMusicOverride,
  dependencyReport,
  readLogs,
  log,
  logDir,
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
import { bundledWhisperCli, checkTranscriber } from '../engine/transcribe';
import { checkOcr } from '../engine/ocr';
import { subtitleDir } from '../core/captions';
import { cpuExportEncoder } from '../engine/videoEncoders';
import { writeCredits } from '../engine/webImages';
import { MODEL_CATALOG, downloadModel, importModelFile, modelStatus, removeModel } from '../engine/models';
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
  ipcMain.handle('ocr:check', (_e, cfg) => checkOcr(cfg));
  ipcMain.handle('ocr:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { title: 'Choisir tesseract', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'tesseract.exe', extensions: ['exe'] }] : [] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  // local AI models: listed with size/licence; downloaded only on an explicit request from the UI
  const modelsDir = () => path.join(app.getPath('userData'), 'models');
  ipcMain.handle('models:list', async () => ({ catalog: MODEL_CATALOG, status: await modelStatus(modelsDir()), dir: modelsDir(), bundledEngine: !!bundledWhisperCli() }));
  const useModel = async (p: string) => {
    const st = loadSettings();
    await saveSettings({ transcriber: { ...st.transcriber, enabled: true, backend: 'whisper.cpp', modelPath: p } });
  };
  // ---------- music library (user's own files, analysed locally, never modified) ----------
  const musicIndexFile = () => path.join(app.getPath('userData'), 'music-index.json');
  const musicDirs = () => loadSettings().musicLibrary?.dirs ?? [];
  ipcMain.handle('music:list', async () => {
    const idx = await loadMusicIndex(musicIndexFile());
    const dirs = musicDirs();
    const inLib = (p: string) => dirs.some((d) => p === d || p.startsWith(d + path.sep));
    const tracks = Object.values(idx.tracks).filter((t) => inLib(t.path)).map(effectiveTrack).sort((a, b) => a.title.localeCompare(b.title));
    return { dirs, updatedAt: Object.keys(idx.tracks).length ? idx.updatedAt : null, tracks };
  });
  ipcMain.handle('music:addFolder', async (e) => {
    const r = await dialog.showOpenDialog(win(e)!, { title: 'Dossier de musique', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return null;
    const dirs = [...new Set([...musicDirs(), ...r.filePaths])];
    await saveSettings({ musicLibrary: { dirs } });
    return dirs;
  });
  ipcMain.handle('music:removeFolder', async (_e, d: string) => {
    const dirs = musicDirs().filter((x) => x !== d);
    await saveSettings({ musicLibrary: { dirs } });
    return dirs;
  });
  ipcMain.handle('music:scan', () => {
    const { id: taskId } = orchestrator.submit({
      type: 'music-scan',
      label: 'Analyse de la bibliothèque musicale',
      priority: 'low',
      dedupeKey: 'music-scan',
      resources: { cpuSlots: 2 },
      run: async (c) => {
        const r = await scanMusicLibrary(musicDirs(), musicIndexFile(), { signal: c.signal, progress: (f, m) => c.progress(f, m) });
        c.log(`${r.found} fichier(s), ${r.analysed} analysé(s), ${r.reused} inchangé(s), ${r.moved} déplacé(s), ${r.missing} introuvable(s), ${r.failed.length} en échec, ${r.seconds} s`);
        for (const f of r.failed) c.log(`échec : ${path.basename(f.path)} — ${f.error}`);
        c.progress(1, `${r.found} piste(s) · ${r.analysed} analysée(s)`);
        return { found: r.found, analysed: r.analysed, failed: r.failed.length };
      },
    });
    return { taskId };
  });
  ipcMain.handle('music:setOverride', async (_e, id: string, o) => {
    await setMusicOverride(musicIndexFile(), id, o);
  });
  ipcMain.handle('models:download', (_e, id: string) => {
    const m = MODEL_CATALOG.find((x) => x.id === id);
    if (!m) throw new Error(`Modèle inconnu : ${id}`);
    const { id: taskId } = orchestrator.submit({
      type: 'download',
      label: `Téléchargement · ${m.label}`,
      priority: 'normal',
      resources: { cpuSlots: 1 },
      run: async (c) => {
        const p = await downloadModel(modelsDir(), id, { signal: c.signal, onProgress: (d, t) => c.progress(t ? Math.min(0.99, d / t) : 0, `${(d / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} Mo`) });
        c.progress(1, 'Vérifié (SHA-1)');
        await useModel(p);
        return { path: p };
      },
    });
    return { taskId };
  });
  ipcMain.handle('models:import', async (e, id: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(w, { title: 'Modèle ggml déjà téléchargé', properties: ['openFile'], filters: [{ name: 'Modèle ggml', extensions: ['bin'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = await importModelFile(modelsDir(), id, r.filePaths[0]);
    await useModel(p);
    return p;
  });
  ipcMain.handle('models:use', async (_e, id: string) => {
    const s = (await modelStatus(modelsDir())).find((x) => x.id === id);
    if (!s?.verified) throw new Error('Ce modèle n’est pas installé ou n’a pas été vérifié');
    await useModel(s.path);
    return s.path;
  });
  ipcMain.handle('models:remove', async (_e, id: string) => removeModel(modelsDir(), id));
  ipcMain.handle('transcriber:pick', async (e, kind: 'python' | 'whisper' | 'modelDir' | 'modelFile') => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r =
      kind === 'modelDir'
        ? await dialog.showOpenDialog(w, { title: 'Dossier du modèle (faster-whisper / CTranslate2)', properties: ['openDirectory'] })
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
    const r = await dialog.showOpenDialog(win(e)!, { title: 'Ouvrir un projet', filters: [{ name: 'Projet Primestone', extensions: ['psproj'] }], properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('dialog:chooseFolder', async (e, title: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win(e)!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('dialog:importMedia', async (e) => {
    const r = await dialog.showOpenDialog(win(e)!, { title: 'Importer des médias', filters: MEDIA_FILTERS, properties: ['openFile', 'multiSelections'] });
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
    orchestrator.submit({ type: 'thumbnail', label: `Vignette · ${asset.name}`, priority: 'high', dedupeKey: `thumb:${asset.id}`, run: (c) => makeThumbnail(asset, cacheDirs(projectPaths(projectFile).cache), c.signal) }).promise,
  );
  ipcMain.handle('media:peaks', (_e, projectFile: string, asset: MediaAsset) =>
    orchestrator.submit({ type: 'waveform', label: `Forme d’onde · ${asset.name}`, priority: 'high', dedupeKey: `peaks:${asset.id}`, run: (c) => makePeaks(asset, cacheDirs(projectPaths(projectFile).cache), c.signal) }).promise,
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
    const vc = req.project.exportSettings.videoCodec === 'hevc' ? 'hevc' : 'h264';
    const encoder = chooseEncoder(req.project.exportSettings.videoCodec, req.project.exportSettings.hardware, settings.performanceProfile, await hwEncoders, await cpuExportEncoder(vc));
    const { id } = orchestrator.submit({
      type: 'export',
      label: `Export · ${path.basename(req.output)}`,
      priority: 'normal',
      resources: { cpuSlots: 2, gpu: !encoder.startsWith('lib') },
      run: async (c) => {
        c.log(`encoder: ${encoder}`);
        const r = await exportSequence({ project: req.project, sequenceId: req.sequenceId, output: req.output, encoder, cacheDir: projectPaths(req.projectFile).cache, signal: c.signal, onProgress: (p) => c.progress(p), onLog: c.log });
        // subtitle files next to the video (same base name), only when the sequence has subtitles
        const seq = req.project.sequences[req.sequenceId];
        if (seq && req.project.exportSettings.subtitleFiles !== false && seq.captions.some((x) => x.style === 'subtitle')) {
          // subtitles are burned into the picture: files with the video's exact name would be loaded on top by
          // players (VLC, MPC, Films et TV) → double subtitles. They go in a separate folder, for upload only.
          const base = req.output.replace(/\.[^.\\/]+$/, '');
          const dir = subtitleDir(req.output);
          await fs.promises.mkdir(dir, { recursive: true });
          for (const f of ['srt', 'vtt'] as const) await fs.promises.writeFile(path.join(dir, `${path.basename(base)}.${f}`), captionsToSubtitleFile(seq, f), 'utf8');
          c.log(`subtitles: ${path.basename(dir)}/ (.srt, .vtt)`);
        }
        // pictures found on the Internet: their credits (CC BY requires attribution) go next to the video
        if (seq) {
          const used = new Set(seq.tracks.flatMap((t) => t.clips.map((cl) => cl.mediaId)));
          const rights = [...used].map((m) => req.project.media[m]?.rights).filter((r): r is NonNullable<typeof r> => !!r);
          const creditsFile = `${req.output.replace(/\.[^.\\/]+$/, '')} — crédits images.txt`;
          if (writeCredits(creditsFile, rights)) c.log(`credits: ${path.basename(creditsFile)}`);
        }
        const outcome: ExportOutcome = { output: req.output, encoder, frames: r.frames, durationSec: r.durationSec, width: r.width, height: r.height };
        exportResults.set(id, outcome);
        c.progress(1, `Vérifié · ${r.frames} images · ${r.width}×${r.height}`);
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
  ipcMain.handle('system:saveDiagnostics', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const st = loadSettings();
    const report = await diagnostics([st.projectsDir, app.getPath('userData'), app.getPath('temp')].filter((p) => fs.existsSync(p)), `Primestone ${app.getVersion()}`, st.transcriber?.enabled ? () => checkTranscriber(st.transcriber) : undefined);
    report.dependencies = await dependencyReport(modelsDir());
    report.recentProblems = readLogs(7, 'warn', 300);
    const r = await dialog.showSaveDialog(w, { title: 'Enregistrer le rapport de diagnostic', defaultPath: path.join(app.getPath('documents'), `primestone-diagnostic-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, JSON.stringify(report, null, 2));
    log('info', 'app', 'rapport de diagnostic enregistré');
    return r.filePath;
  });
  ipcMain.handle('system:dependencies', () => dependencyReport(modelsDir()));
  ipcMain.handle('system:recentProblems', () => readLogs(7, 'warn', 200));
  ipcMain.handle('system:openLogs', () => (logDir() ? shell.openPath(logDir()) : ''));
  // errors of the interface (window.onerror, unhandled promise rejections, React error boundary)
  ipcMain.on('system:reportError', (_e, m: { message?: unknown; stack?: unknown; source?: unknown }) => {
    log('error', 'ui', String(m?.message ?? 'erreur inconnue').slice(0, 500), { stack: String(m?.stack ?? '').slice(0, 2000), source: String(m?.source ?? '').slice(0, 200) });
  });
  ipcMain.handle('system:reveal', (_e, f: string) => shell.showItemInFolder(f));

  ipcMain.handle('window:confirmClose', () => {
    allowClose();
    getWindow()?.close();
  });
}
