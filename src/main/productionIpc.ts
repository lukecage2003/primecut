import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import type { Project } from '../core/model';
import { produceVideo, projectPaths, atomicWrite } from '../engine';
import { DEFAULT_PREFERENCES, type ProductionPreferences, adaptPreferences, type EditStyle } from '../production';
import type { PreferencesState, ProductionInputs, ProductionOutcome } from '../shared/api';
import { orchestrator } from './ipc';

const prefsFile = () => path.join(app.getPath('userData'), 'production-preferences.json');
interface Stored extends PreferencesState {
  versions: Record<number, ProductionPreferences>;
}

function load(): Stored {
  try {
    const s = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as Stored;
    s.current = { ...DEFAULT_PREFERENCES, ...s.current, motionWeights: { ...DEFAULT_PREFERENCES.motionWeights, ...s.current.motionWeights } };
    return s;
  } catch {
    return { current: DEFAULT_PREFERENCES, history: [], versions: { 1: DEFAULT_PREFERENCES } };
  }
}

async function store(next: ProductionPreferences, changes: string[]): Promise<PreferencesState> {
  const s = load();
  const version = Math.max(next.version, ...Object.keys(s.versions).map(Number)) + (s.versions[next.version] ? 1 : 0);
  const p = { ...next, version };
  s.versions[version] = p;
  s.current = p;
  s.history.unshift({ version, at: new Date().toISOString(), changes });
  s.history = s.history.slice(0, 100);
  await atomicWrite(prefsFile(), JSON.stringify(s, null, 1));
  return { current: s.current, history: s.history };
}

const results = new Map<string, ProductionOutcome>();

export function registerProductionIpc() {
  ipcMain.handle('production:run', async (_e, projectFile: string, project: Project, inputs: ProductionInputs, prefs: ProductionPreferences) => {
    const { id } = orchestrator.submit({
      type: 'production',
      label: 'Script-to-Video',
      priority: 'high',
      resources: { cpuSlots: 2 },
      run: async (c) => {
        const r = await produceVideo(
          { project, projectDir: path.dirname(projectFile), script: inputs.script, narrationMediaId: inputs.narrationMediaId, musicMediaId: inputs.musicMediaId, mediaFolders: inputs.mediaFolders, prefs },
          (f, m) => {
            c.progress(f, m);
            c.log(m);
          },
          c.signal,
        );
        results.set(id, r);
        return r;
      },
      verify: (r) => {
        if (!r.sequence.tracks.some((t) => t.clips.length)) throw new Error('Generation produced an empty timeline');
      },
    });
    void projectPaths;
    return { taskId: id };
  });
  ipcMain.handle('production:result', (_e, id: string) => {
    const r = results.get(id);
    if (!r) throw new Error('No production result for this task');
    results.delete(id);
    return r;
  });
  ipcMain.handle('production:preferences', () => {
    const s = load();
    return { current: s.current, history: s.history };
  });
  ipcMain.handle('production:setPreferences', (_e, p: ProductionPreferences, reason: string) => store(p, [reason]));
  ipcMain.handle('production:learn', async (_e, generated: EditStyle, edited: EditStyle) => {
    const s = load();
    const { prefs, changes } = adaptPreferences(s.current, generated, edited);
    if (!changes.length) return { state: { current: s.current, history: s.history }, changes };
    return { state: await store(prefs, changes), changes };
  });
  ipcMain.handle('production:revertPreferences', async (_e, version: number) => {
    const s = load();
    const p = s.versions[version];
    if (!p) throw new Error(`No preferences version ${version}`);
    return store({ ...p }, [`reverted to version ${version}`]);
  });
  ipcMain.handle('production:readTextFile', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(w, { title: 'Open script', filters: [{ name: 'Text', extensions: ['txt', 'md', 'markdown'] }], properties: ['openFile'] });
    const f = r.canceled ? null : r.filePaths[0];
    if (!f) return null;
    const st = await fsp.stat(f);
    if (st.size > 5 * 1024 * 1024) throw new Error('Script file is larger than 5 MB');
    return { path: f, text: await fsp.readFile(f, 'utf8') };
  });
  ipcMain.handle('production:chooseFolders', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(w, { title: 'Media folders', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
}
