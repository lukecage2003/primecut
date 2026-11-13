import { SCRIPT_EXTENSIONS, readScriptDocument } from '../engine/scriptFile';
import { transcribe } from '../engine/transcribe';
import { renderPCoreAsset } from './pcoreRender';
import { loadSettings } from './settings';
import type { RecognisedWord } from '../production';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import type { Project } from '../core/model';
import { produceVideo, projectPaths, atomicWrite, renderGenerator, fingerprintFile } from '../engine';
import type { GeneratorSpec } from '../core/generators';
import { DEFAULT_PREFERENCES, type ProductionPreferences, adaptPreferences, type EditStyle } from '../production';
import { FORMAT_SIZES, type PreferencesState, type ProductionInputs, type ProductionOutcome } from '../shared/api';
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
        // optional local transcription (word-level sync); any failure falls back to pause alignment
        const tcfg = loadSettings().transcriber;
        let transcript: RecognisedWord[] | null = null;
        let transcription = 'non configurée (synchro phrase par phrase sur les pauses)';
        const narr = project.media[inputs.narrationMediaId];
        if (tcfg?.enabled && narr) {
          try {
            c.progress(0.01, 'Transcription locale de la narration');
            const t = await transcribe(narr.path, tcfg, path.join(path.dirname(projectFile), 'Cache'), {
              signal: c.signal,
              fingerprint: narr.fingerprint.partialHash + narr.fingerprint.size,
              prompt: promptFromScript(inputs.script),
              progress: (f) => c.progress(0.01 + 0.3 * f, `Transcription locale de la narration (${Math.round(f * 100)}%)`),
            });
            transcript = t.words;
            transcription = `${t.engine} · ${t.words.length} mots${t.cached ? ' (en cache)' : ` en ${t.seconds.toFixed(0)} s`}`;
            c.log(`Transcription: ${transcription}`);
          } catch (e) {
            if (c.signal.aborted) throw e;
            transcription = `échec, synchro sur les pauses : ${(e as Error).message}`;
            c.log(`Transcription ${transcription}`);
          }
        }
        const r = await produceVideo(
          { project, projectDir: path.dirname(projectFile), ...(inputs.format ? { settings: FORMAT_SIZES[inputs.format], name: `Auto v${Object.values(project.sequences).filter((x) => x.production).length + 1} · ${inputs.format}` } : {}), script: inputs.script, narrationKind: inputs.narrationKind, narrationMediaId: inputs.narrationMediaId, musicMediaId: inputs.musicMediaId, mediaFolders: inputs.mediaFolders, prefs, transcript, pcorePlacement: loadSettings().pcore?.placement, renderPCore: (a, n, st, sig) => renderPCoreAsset(a, n, st, path.join(path.dirname(projectFile), 'Cache'), sig) },
          (f, m) => {
            const base = transcript ? 0.31 : 0;
            c.progress(base + (1 - base) * f, m);
            c.log(m);
          },
          c.signal,
        );
        r.report.transcription = transcription;
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
    const r = await dialog.showOpenDialog(w, { title: 'Ouvrir un script', filters: [{ name: 'Script (PDF, texte, Markdown)', extensions: SCRIPT_EXTENSIONS }], properties: ['openFile'] });
    const f = r.canceled ? null : r.filePaths[0];
    if (!f) return null;
    const doc = await readScriptDocument(f);
    const im = doc.imported;
    return { path: f, text: im.markdown, title: im.title, meta: im.meta, repairs: im.repairs.length, sections: im.sectionTargets.length };
  });
  ipcMain.handle('production:renderVisual', (_e, projectFile: string, spec: GeneratorSpec, size: { width: number; height: number; rate: string }, audioPath: string | null) =>
    orchestrator.submit({
      type: 'visual',
      label: `Animation · ${spec.kind}`,
      priority: 'high',
      dedupeKey: `visual:${JSON.stringify(spec)}:${size.width}x${size.height}`,
      run: async (c) => {
        const p = await renderGenerator(spec, { ...size, audioPath, cacheDir: projectPaths(projectFile).cache, signal: c.signal });
        return { path: p, fingerprint: await fingerprintFile(p) };
      },
    }).promise,
  );
  ipcMain.handle('production:chooseFolders', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(w, { title: 'Dossiers de médias', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
}

/** Proper names from the script bias the recogniser toward the right spelling (Krakoa, Darkseid…). */
function promptFromScript(script: string): string {
  const names = new Map<string, number>();
  for (const m of script.matchAll(/\b\p{Lu}[\p{L}’'-]{2,}(?:\s+\p{Lu}[\p{L}’'-]{2,})*/gu)) {
    const n = m[0];
    if (/^[\p{Lu}\s’'-]+$/u.test(n)) continue; // headings in capitals
    names.set(n, (names.get(n) ?? 0) + 1);
  }
  return [...names.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([n]) => n)
    .join(', ')
    .slice(0, 600);
}
