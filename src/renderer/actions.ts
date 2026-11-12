import { type Draft, produce } from 'immer';
import {
  EditError,
  History,
  type MediaAsset,
  type Project,
  type Sequence,
  type SequenceSettings,
  createProject,
  placeMedia,
  sequenceDuration,
  splitAt,
  deleteClips,
  type MediaMap,
  normalizeSequence,
  addTransitionsAt,
  removeTransition,
  VISUAL_KINDS,
} from '../core';
import type { OpenResult } from '../shared/api';
import { api } from './api';
import { ask, currentSequence, store, toast } from './store';

function ed() {
  const e = store.state.editor;
  if (!e) throw new Error('No project open');
  return e;
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Strip Electron's IPC prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------------------------------------------------------- project lifecycle

export async function loadSettings() {
  const settings = await api.settings.get();
  store.set({ settings });
  document.documentElement.dataset.theme = settings.theme;
}

export async function updateSettings(patch: Parameters<typeof api.settings.set>[0]) {
  const settings = await api.settings.set(patch);
  store.set({ settings });
  document.documentElement.dataset.theme = settings.theme;
}

export async function newProject(dir: string, name: string, seq: Partial<SequenceSettings>) {
  try {
    const res = await api.project.create(dir, name, createProject(name, seq));
    await enterEditor(res, res.project);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function openProject(file: string) {
  if (!(await confirmDiscard())) return;
  try {
    const res = await api.project.open(file);
    let project = res.project;
    if (res.recovery) {
      const choice = await ask(
        'Recover unsaved changes?',
        `An autosave from ${new Date(res.recovery.savedAt).toLocaleString()} is newer than the saved project. Restore it?`,
        [
          { label: 'Keep saved version', value: 'discard' },
          { label: 'Recover', value: 'recover', kind: 'primary' },
        ],
      );
      if (choice === 'recover') project = res.recovery.project;
      else await api.project.discardRecovery(file);
    }
    await enterEditor(res, project, !!res.recovery && project === res.recovery.project);
    if (res.issues.length) toast(`Project opened with ${res.issues.length} integrity warning(s): ${res.issues[0]}`, 'error');
  } catch (e) {
    toast(`Cannot open project: ${errorText(e)}`, 'error');
  }
}

async function enterEditor(res: OpenResult, project: Project, recovered = false) {
  const history = new History(project);
  const mediaStatus: Record<string, 'online' | 'relocated' | 'changed' | 'missing'> = {};
  for (const m of res.media) mediaStatus[m.id] = m.status;
  // relocated media paths were updated → project differs from disk; recovered state is unsaved.
  if (recovered || res.media.some((m) => m.status === 'relocated')) history.replaceSilently({ ...project });
  const proxies: Record<string, string> = {};
  for (const m of Object.values(project.media)) if (m.proxy) proxies[m.id] = joinPath(res.cacheDir, 'proxies', m.proxy);
  store.set({
    screen: 'editor',
    overlay: null,
    editor: {
      file: res.file,
      cacheDir: res.cacheDir,
      history,
      preview: null,
      selection: [],
      playhead: 0,
      playing: false,
      zoom: 4,
      tool: 'select',
      snapping: true,
      mediaStatus,
      thumbs: {},
      peaks: {},
      proxies,
      selectedMedia: null,
      selectedTransition: null,
      productionTask: null,
      snapAt: null,
      savedAt: res.savedAt,
      version: 0,
    },
  });
  history.subscribe(() => store.setEditor((e) => ({ version: e.version + 1 })));
  const missing = res.media.filter((m) => m.status === 'missing' || m.status === 'changed').length;
  if (missing) toast(`${missing} media file(s) offline — use “Locate” in the Media Library to relink.`, 'error');
  for (const m of Object.values(project.media)) void prepareMedia(m);
}

function joinPath(...parts: string[]) {
  const sep = api.platform === 'win32' ? '\\' : '/';
  return parts.join(sep);
}

/** Thumbnails, waveform peaks and (if needed) preview proxies, generated in the background. */
async function prepareMedia(asset: MediaAsset) {
  const e = store.state.editor;
  if (!e) return;
  const status = e.mediaStatus[asset.id];
  if (status === 'missing' || status === 'changed') return;
  const file = e.file;
  api.media.thumbnail(file, asset).then(
    (p) => p && store.setEditor((x) => ({ thumbs: { ...x.thumbs, [asset.id]: p } })),
    () => undefined,
  );
  api.media.peaks(file, asset).then(
    (p) => p && store.setEditor((x) => ({ peaks: { ...x.peaks, [asset.id]: new Uint8Array(p) } })),
    () => undefined,
  );
  if (!e.proxies[asset.id] && (await api.media.needsProxy(asset))) {
    try {
      const name = await api.media.proxy(file, asset);
      const cur = store.state.editor;
      if (!cur || cur.file !== file) return;
      store.setEditor((x) => ({ proxies: { ...x.proxies, [asset.id]: joinPath(x.cacheDir, 'proxies', name) } }));
      // Record the proxy in the project without creating an undo step.
      const h = cur.history;
      const dirty = h.dirty;
      h.replaceSilently(
        produce(h.present, (d) => {
          if (d.media[asset.id]) d.media[asset.id]!.proxy = name;
        }),
      );
      if (!dirty) h.markSaved();
    } catch (err) {
      if (!/Cancel/.test(errorText(err))) toast(`Proxy failed for ${asset.name}: ${errorText(err)}`, 'error');
    }
  }
}

export async function save(): Promise<boolean> {
  const e = ed();
  try {
    const { savedAt } = await api.project.save(e.file, e.history.present);
    e.history.markSaved();
    store.setEditor({ savedAt });
    toast('Project saved', 'success', undefined, 2000);
    return true;
  } catch (err) {
    toast(`Save failed: ${errorText(err)}`, 'error');
    return false;
  }
}

export async function autosaveTick() {
  const e = store.state.editor;
  if (!e || !e.history.dirty) return;
  try {
    await api.project.autosave(e.file, e.history.present);
  } catch (err) {
    toast(`Autosave failed: ${errorText(err)}`, 'error');
  }
}

/** Asks to save when there are unsaved changes. Returns false if the user cancelled. */
export async function confirmDiscard(): Promise<boolean> {
  const e = store.state.editor;
  if (!e || !e.history.dirty) return true;
  const v = await ask('Save changes?', `“${e.history.present.name}” has unsaved changes.`, [
    { label: 'Cancel', value: 'cancel' },
    { label: "Don't save", value: 'discard', kind: 'danger' },
    { label: 'Save', value: 'save', kind: 'primary' },
  ]);
  if (v === 'save') return save();
  if (v === 'discard') {
    await api.project.discardRecovery(e.file).catch(() => undefined);
    return true;
  }
  return false;
}

export async function closeProject() {
  if (!(await confirmDiscard())) return;
  store.set({ screen: 'home', editor: null, overlay: null });
}

// ---------------------------------------------------------------- media

export async function importPaths(paths: string[]) {
  const e = ed();
  if (!paths.length) return;
  const existing = new Set(Object.values(e.history.present.media).map((m) => m.path));
  const fresh = paths.filter((p) => !existing.has(p));
  if (fresh.length < paths.length) toast(`${paths.length - fresh.length} file(s) already in the project`, 'info');
  if (!fresh.length) return;
  const res = await api.media.import(e.file, fresh);
  for (const err of res.errors) toast(`Import failed: ${err.path.split(/[\\/]/).pop()} — ${err.error}`, 'error');
  if (!res.assets.length) return;
  e.history.commit(`Import ${res.assets.length} file(s)`, (d) => {
    for (const a of res.assets) d.media[a.id] = a as Draft<MediaAsset>;
  });
  store.setEditor((x) => ({ mediaStatus: { ...x.mediaStatus, ...Object.fromEntries(res.assets.map((a) => [a.id, 'online' as const])) } }));
  for (const a of res.assets) void prepareMedia(a);
  toast(`Imported ${res.assets.length} file(s)`, 'success', undefined, 2000);
}

export async function importDialog() {
  const paths = await api.dialog.importMedia();
  await importPaths(paths);
}

export async function relink(asset: MediaAsset) {
  const e = ed();
  const candidate = await api.dialog.relinkFile(asset.name);
  if (!candidate) return;
  if (!(await api.media.checkRelink(asset, candidate))) {
    const v = await ask('Different file', 'The selected file does not match the original media (size or content differ). Link it anyway?', [
      { label: 'Cancel', value: 'no' },
      { label: 'Link anyway', value: 'yes', kind: 'danger' },
    ]);
    if (v !== 'yes') return;
  }
  // Re-probe to keep metadata accurate for the new file.
  const res = await api.media.import(e.file, [candidate]);
  const fresh = res.assets[0];
  if (!fresh) return toast(`Cannot read ${candidate}`, 'error');
  e.history.commit(`Relink ${asset.name}`, (d) => {
    d.media[asset.id] = { ...(fresh as Draft<MediaAsset>), id: asset.id, name: asset.name };
  });
  store.setEditor((x) => ({ mediaStatus: { ...x.mediaStatus, [asset.id]: 'online' } }));
  void prepareMedia(ed().history.present.media[asset.id]!);
  // Try to resolve the other missing files from the same folder.
  const missing = Object.values(ed().history.present.media).filter((m) => ['missing', 'changed'].includes(ed().mediaStatus[m.id] ?? ''));
  if (missing.length) {
    const folder = candidate.replace(/[\\/][^\\/]+$/, '');
    const found = await api.project.searchMissing(missing, folder);
    const ids = Object.keys(found);
    if (ids.length) {
      ed().history.commit(`Relink ${ids.length} file(s)`, (d) => {
        for (const id of ids) d.media[id]!.path = found[id]!;
      });
      store.setEditor((x) => ({ mediaStatus: { ...x.mediaStatus, ...Object.fromEntries(ids.map((id) => [id, 'online' as const])) } }));
      toast(`Also relinked ${ids.length} other file(s) found in the same folder`, 'success');
    }
  }
}

export function removeMedia(mediaId: string) {
  const e = ed();
  const used = Object.values(e.history.present.sequences).some((s) => s.tracks.some((t) => t.clips.some((c) => c.mediaId === mediaId)));
  if (used) return toast('This media is used in the timeline. Remove its clips first.', 'error');
  e.history.commit('Remove media', (d) => {
    delete d.media[mediaId];
  });
}

// ---------------------------------------------------------------- editing

/** Runs a timeline edit as one undoable step; illegal edits show a message and change nothing. */
export function edit<R>(label: string, fn: (seq: Draft<Sequence>, media: MediaMap, project: Draft<Project>) => R): R | undefined {
  const e = ed();
  try {
    return e.history.commit(label, (d) => {
      const seq = d.sequences[d.activeSequenceId]!;
      const r = fn(seq, d.media as MediaMap, d);
      normalizeSequence(seq, d.media as MediaMap);
      return r;
    });
  } catch (err) {
    if (err instanceof EditError) toast(err.message, 'error', undefined, 2500);
    else toast(errorText(err), 'error');
    return undefined;
  }
}

/** Computes a non-committed preview of an edit (used while dragging). */
export function previewEdit(fn: (seq: Draft<Sequence>, media: MediaMap) => void) {
  const e = ed();
  try {
    const next = produce(e.history.present, (d) => {
      fn(d.sequences[d.activeSequenceId]!, d.media as MediaMap);
      normalizeSequence(d.sequences[d.activeSequenceId]!, d.media as MediaMap);
    });
    store.setEditor({ preview: next });
  } catch {
    /* illegal intermediate states are simply not previewed */
  }
}

export function clearPreview() {
  store.setEditor({ preview: null, snapAt: null });
}

export function addToTimeline(mediaId: string, start?: number, videoTrack = 0, audioTrack = 0) {
  const e = ed();
  const at = start ?? e.playhead;
  const ids = edit('Add clip', (seq, media) => placeMedia(seq, media[mediaId]!, { videoTrack, audioTrack, start: at, mode: 'overwrite' }));
  if (ids) store.setEditor({ selection: ids });
}

export function splitAtPlayhead() {
  const e = ed();
  // Selected clips under the playhead are cut; if none of the selection is under it, cut every
  // unlocked track (Premiere-like behaviour).
  const seq = currentSequence(e);
  const under = e.selection.filter((id) => seq.tracks.some((t) => t.clips.some((c) => c.id === id && c.start < e.playhead && e.playhead < c.start + c.duration)));
  const ids = under.length ? under : undefined;
  const created = edit('Split', (seq) => splitAt(seq, e.playhead, ids));
  if (created && created.length === 0) toast('Nothing to split at the playhead', 'info', undefined, 1500);
}

export function deleteSelection(ripple: boolean) {
  if (deleteSelectedTransition()) return;
  const e = ed();
  if (!e.selection.length) return;
  edit(ripple ? 'Ripple delete' : 'Delete', (seq) => deleteClips(seq, e.selection, ripple));
  store.setEditor({ selection: [] });
}

/** Ctrl+D: default cross-dissolve (1 s) at the cut nearest the playhead on every unlocked track. */
export function addDefaultTransition() {
  const e = ed();
  const seq = currentSequence(e);
  const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
  const ids = edit('Add cross-dissolve', (s, media) => addTransitionsAt(s, media, e.playhead, Math.round(fps), Math.max(2, Math.round(10 / e.zoom))));
  if (ids?.length) store.setEditor({ selectedTransition: ids[0]!, selection: [] });
}

export function deleteSelectedTransition(): boolean {
  const e = ed();
  if (!e.selectedTransition) return false;
  const id = e.selectedTransition;
  edit('Remove transition', (s) => removeTransition(s, id));
  store.setEditor({ selectedTransition: null });
  return true;
}

export function undo() {
  const e = ed();
  if (e.history.undo()) store.setEditor({ selection: [] });
}
export function redo() {
  const e = ed();
  if (e.history.redo()) store.setEditor({ selection: [] });
}

export function setPlayhead(frame: number) {
  const e = ed();
  const end = Math.max(0, sequenceDuration(currentSequence(e)));
  store.setEditor({ playhead: Math.max(0, Math.min(Math.round(frame), Math.max(end, 0))) });
}

// ---------------------------------------------------------------- export

export async function startExport(output: string) {
  const e = ed();
  const project = e.history.present;
  try {
    const { taskId } = await api.export.start({ projectFile: e.file, project, sequenceId: project.activeSequenceId, output });
    store.set({ overlay: 'tasks' });
    return taskId;
  } catch (err) {
    toast(`Export failed to start: ${errorText(err)}`, 'error');
    return null;
  }
}

// ---------------------------------------------------------------- Script-to-Video

import type { ProductionInputs } from '../shared/api';
import type { ProductionPreferences } from '../production/preferences';
import { measureStyle } from '../production/qc';

const INPUTS_KEY = 'production.inputs';

export function savedProductionInputs(): ProductionInputs | null {
  const e = store.state.editor;
  const raw = e?.history.present.metadata[INPUTS_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProductionInputs;
  } catch {
    return null;
  }
}

/** Runs the Script-to-Video pipeline; the result becomes a new sequence (one undoable step). */
export async function runProduction(inputs: ProductionInputs, prefs: ProductionPreferences): Promise<boolean> {
  const e = ed();
  e.history.commit('Production inputs', (d) => {
    d.metadata[INPUTS_KEY] = JSON.stringify(inputs);
  });
  try {
    const { taskId } = await api.production.run(e.file, e.history.present, inputs, prefs);
    store.setEditor({ productionTask: taskId });
    await waitForTask(taskId);
    const r = await api.production.result(taskId);
    const cur = ed();
    cur.history.commit(`Generate “${r.sequence.name}”`, (d) => {
      for (const m of r.newMedia) d.media[m.id] = m as Draft<MediaAsset>;
      d.sequences[r.sequence.id] = r.sequence as Draft<Sequence>;
      d.activeSequenceId = r.sequence.id;
    });
    store.setEditor((x) => ({
      productionTask: null,
      selection: [],
      playhead: 0,
      mediaStatus: { ...x.mediaStatus, ...Object.fromEntries(r.newMedia.map((m) => [m.id, 'online' as const])) },
    }));
    for (const m of r.newMedia) void prepareMedia(m);
    const qc = r.sequence.production!;
    toast(`${r.sequence.name}: ${r.report.shots} shots, ${r.report.beats} sequences, QC ${qc.qcScore}/100${r.report.fixes.length ? ` · ${r.report.fixes.length} auto-fix(es)` : ''} · sync: ${r.report.alignment.method === 'transcript' ? 'word-level' : 'pauses'}${r.report.transcription ? ` (${r.report.transcription})` : ''}`, 'success', undefined, 8000);
    return true;
  } catch (err) {
    store.setEditor({ productionTask: null });
    toast(`Generation failed: ${errorText(err)}`, 'error');
    return false;
  }
}

function waitForTask(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const t = store.state.tasks[id];
      if (!t) return false;
      if (t.state === 'done') return resolve(), true;
      if (t.state === 'failed' || t.state === 'cancelled') return reject(new Error(t.error ?? t.state)), true;
      return false;
    };
    if (check()) return;
    const off = store.subscribe(() => {
      if (check()) off();
    });
  });
}

export function switchSequence(id: string) {
  const e = ed();
  if (e.history.present.activeSequenceId === id) return;
  e.history.commit('Switch sequence', (d) => {
    d.activeSequenceId = id;
  });
  store.setEditor({ selection: [], selectedTransition: null, playhead: 0 });
}

/** Compares the current (edited) generated sequence with its generation baseline and adapts preferences. */
export async function learnFromEdits() {
  const seq = currentSequence(ed());
  if (!seq.production) return toast('This sequence was not generated automatically', 'error');
  const { changes } = await api.production.learn(seq.production.style as never, measureStyle(seq));
  if (!changes.length) toast('No measurable difference from the generated version — preferences unchanged', 'info');
  else toast(`Preferences updated: ${changes.join(' · ')}`, 'success', undefined, 8000);
}

const VISUAL_LABEL: Record<string, string> = Object.fromEntries(VISUAL_KINDS.map((k) => [k.id, k.label]));

/** Re-renders a procedural composition after a manual change (one undoable step once rendered). */
export async function updateVisual(mediaId: string, patch: Partial<import('../core/generators').GeneratorSpec>) {
  const e = ed();
  const m = e.history.present.media[mediaId];
  if (!m?.generator) return;
  const seq = currentSequence(e);
  const spec = { ...m.generator, ...patch };
  const narr = spec.audio ? e.history.present.media[spec.audio.mediaId] : undefined;
  try {
    const r = await api.production.renderVisual(e.file, spec, { width: seq.settings.width, height: seq.settings.height, rate: `${seq.settings.frameRate.num}/${seq.settings.frameRate.den}` }, narr?.path ?? null);
    ed().history.commit('Edit motion design', (d) => {
      const a = d.media[mediaId]!;
      a.generator = spec as Draft<typeof spec>;
      a.path = r.path;
      a.fingerprint = r.fingerprint;
      a.name = `${VISUAL_LABEL[spec.kind] ?? spec.kind}${spec.title ? ` · ${spec.title}` : ''}`;
      for (const sq of Object.values(d.sequences)) for (const t of sq.tracks) for (const c of t.clips) if (c.mediaId === mediaId) c.name = a.name;
    });
    store.setEditor((x) => ({ thumbs: Object.fromEntries(Object.entries(x.thumbs).filter(([k]) => k !== mediaId)) }));
    void prepareMedia(ed().history.present.media[mediaId]!);
  } catch (err) {
    toast(`Render failed: ${errorText(err)}`, 'error');
  }
}
