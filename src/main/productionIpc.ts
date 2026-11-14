import { SCRIPT_EXTENSIONS, readScriptDocument } from '../engine/scriptFile';
import { transcribe } from '../engine/transcribe';
import { renderPCoreAsset } from './pcoreRender';
import { loadSettings } from './settings';
import type { RecognisedWord } from '../production';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, net } from 'electron';
import type { FetchLike } from '../engine/webImages';

/** Internet access for the opt-in free-picture search: Chromium's network stack (system proxy settings). */
const webFetch: FetchLike = (url, init) => net.fetch(url, { headers: init?.headers, signal: init?.signal }) as ReturnType<FetchLike>;
import type { Project } from '../core/model';
import { produceVideo, projectPaths, atomicWrite, renderGenerator, fingerprintFile, importMediaFile } from '../engine';
import { loadMusicIndex } from '../engine/musicLibrary';
import type { GeneratorSpec } from '../core/generators';
import { DEFAULT_PREFERENCES, type ProductionPreferences, adaptPreferences, type EditStyle } from '../production';
import { FORMAT_SIZES, type PreferencesState, type ProductionInputs, type ProductionOutcome } from '../shared/api';
import { orchestrator } from './ipc';
import { parseVocabulary } from '../production/vocabulary';
import { analyzeReference, prefsFromProfile } from '../engine/styleReference';
import { findTesseract } from '../engine/ocr';

const prefsFile = () => path.join(app.getPath('userData'), 'production-preferences.json');
const musicIndexFile = () => path.join(app.getPath('userData'), 'music-index.json');
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
              // with hesitation cutting, the prompt shows Whisper that hesitations are written (otherwise it leaves them out)
              prompt: [prefs.cutDisfluencies ? 'Euh, alors, hum, ben…' : '', parseVocabulary(inputs.vocabulary ?? '').join(', '), promptFromScript(inputs.script)].filter(Boolean).join(', ').slice(0, 800),
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
          { project, projectDir: path.dirname(projectFile), ...(inputs.format ? { settings: FORMAT_SIZES[inputs.format], name: `Auto v${Object.values(project.sequences).filter((x) => x.production).length + 1} · ${inputs.format}` } : {}), script: inputs.script, vocabulary: parseVocabulary(inputs.vocabulary ?? ''), narrationKind: inputs.narrationKind, narrationMediaId: inputs.narrationMediaId, musicMediaId: inputs.musicMediaId, mediaFolders: inputs.mediaFolders, prefs, transcript, musicIndexFile: musicIndexFile(), mediaIndexFile: path.join(app.getPath('userData'), 'media-index.json'), ocr: loadSettings().ocr ?? (findTesseract() ? { enabled: true, languages: 'eng+fra' } : undefined), pcoreEngine: loadSettings().pcore?.engine ?? 'v2', pcoreV2: loadSettings().pcore?.v2, pcorePlacement: loadSettings().pcore?.placement, webImages: prefs.webImages ? { fetchImpl: webFetch } : null, renderPCore: (a, n, st, sig) => renderPCoreAsset(a, n, st, path.join(path.dirname(projectFile), 'Cache'), sig) },
          (f, m) => {
            const base = transcript ? 0.31 : 0;
            c.progress(base + (1 - base) * f, m);
            c.log(m);
          },
          c.signal,
          (patch) => c.live?.(patch),
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
  ipcMain.handle('production:musicTrack', async (_e, projectFile: string, trackId: string) => {
    const idx = await loadMusicIndex(musicIndexFile());
    const t = idx.tracks[trackId];
    if (!t || t.missing || !fs.existsSync(t.path)) throw new Error('Piste introuvable (fichier déplacé ou supprimé : relancez l’analyse de la bibliothèque)');
    const media = await importMediaFile(t.path, path.dirname(projectFile));
    const lic = t.overrides?.licence ?? t.licence;
    media.rights = { usage: 'user-provided', source: 'music-library', license: lic.family ?? lic.text, checkedAt: new Date().toISOString(), note: lic.status === 'inconnue' ? 'Licence non déclarée : vérifiez vos droits avant publication.' : 'Licence déclarée dans la bibliothèque musicale.' };
    return { media, lufs: t.loudness.integratedLufs };
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
  // "S'inspirer d'une vidéo": the editing of a video on this computer, measured locally, as preferences
  ipcMain.handle('production:inspire', async (e, prefs: ProductionPreferences) => {
    const w = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(w, { title: 'Vidéo de référence (sur cet ordinateur)', properties: ['openFile'], filters: [{ name: 'Vidéo', extensions: ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    return orchestrator.submit({
      type: 'analysis',
      label: `Style de « ${path.basename(file)} »`,
      priority: 'high',
      run: async (c) => {
        const profile = await analyzeReference(file, { signal: c.signal, progress: (f, m) => c.progress(f, m) });
        return { profile, ...prefsFromProfile(profile, prefs) };
      },
    }).promise;
  });
  // spoken edit instruction: recorded in the window, transcribed here with the local Whisper model
  ipcMain.handle('production:transcribeCommand', async (_e, audio: Uint8Array) => {
    const tcfg = loadSettings().transcriber;
    if (!tcfg?.enabled || !tcfg.modelPath) throw new Error('Transcription locale non configurée (Réglages → Transcription) : tapez l’instruction à la place.');
    const dir = path.join(app.getPath('userData'), 'commandes');
    await fsp.mkdir(dir, { recursive: true });
    const raw = path.join(dir, `instruction-${Date.now()}.webm`);
    const wav = raw.replace(/\.webm$/, '.wav');
    await fsp.writeFile(raw, Buffer.from(audio));
    try {
      const { ffmpeg } = await import('../engine/ffmpeg');
      await ffmpeg(['-v', 'error', '-y', '-i', raw, '-ac', '1', '-ar', '16000', wav]);
      const r = await transcribe(wav, tcfg, dir, { prompt: 'plans plus courts, baisse la musique, enlève les sous-titres, logo en haut à gauche, voix radio' });
      return r.words.map((w) => w.text).join(' ').replace(/\s+([,.!?])/g, '$1').trim();
    } finally {
      await fsp.rm(raw, { force: true });
      await fsp.rm(wav, { force: true });
    }
  });
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
