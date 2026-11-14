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
  reconcileGraph,
  setDecisionState,
  rejectDecision,
  chooseCandidate,
  replaceMusic,
  type DecisionState,
} from '../core';
import type { OpenResult } from '../shared/api';
import { api } from './api';
import { ask, currentSequence, store, toast } from './store';

function ed() {
  const e = store.state.editor;
  if (!e) throw new Error('Aucun projet ouvert');
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
        'Récupérer les modifications non enregistrées ?',
        `An autosave from ${new Date(res.recovery.savedAt).toLocaleString()} is newer than the saved project. Restore it?`,
        [
          { label: 'Garder la version enregistrée', value: 'discard' },
          { label: 'Récupérer', value: 'recover', kind: 'primary' },
        ],
      );
      if (choice === 'recover') project = res.recovery.project;
      else await api.project.discardRecovery(file);
    }
    await enterEditor(res, project, !!res.recovery && project === res.recovery.project);
    if (res.issues.length) toast(`Projet ouvert avec ${res.issues.length} avertissement(s) d'intégrité : ${res.issues[0]}`, 'error');
  } catch (e) {
    toast(`Impossible d'ouvrir le projet : ${errorText(e)}`, 'error');
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
  if (missing) toast(`${missing} fichier(s) média hors ligne — utilisez « Localiser… » dans la bibliothèque pour les retrouver.`, 'error');
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
      if (!/Cancel/.test(errorText(err))) toast(`Échec du proxy pour ${asset.name} : ${errorText(err)}`, 'error');
    }
  }
}

export async function save(): Promise<boolean> {
  const e = ed();
  try {
    const { savedAt } = await api.project.save(e.file, e.history.present);
    e.history.markSaved();
    store.setEditor({ savedAt });
    toast('Projet enregistré', 'success', undefined, 2000);
    return true;
  } catch (err) {
    toast(`Échec de l'enregistrement : ${errorText(err)}`, 'error');
    return false;
  }
}

export async function autosaveTick() {
  const e = store.state.editor;
  if (!e || !e.history.dirty) return;
  try {
    await api.project.autosave(e.file, e.history.present);
  } catch (err) {
    toast(`Échec de la sauvegarde automatique : ${errorText(err)}`, 'error');
  }
}

/** Asks to save when there are unsaved changes. Returns false if the user cancelled. */
export async function confirmDiscard(): Promise<boolean> {
  const e = store.state.editor;
  if (!e || !e.history.dirty) return true;
  const v = await ask('Enregistrer les modifications ?', `“${e.history.present.name}” has unsaved changes.`, [
    { label: 'Annuler', value: 'cancel' },
    { label: "Don't save", value: 'discard', kind: 'danger' },
    { label: 'Enregistrer', value: 'save', kind: 'primary' },
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
  if (fresh.length < paths.length) toast(`${paths.length - fresh.length} fichier(s) déjà dans le projet`, 'info');
  if (!fresh.length) return;
  const res = await api.media.import(e.file, fresh);
  for (const err of res.errors) toast(`Échec de l'import : ${err.path.split(/[\\/]/).pop()} — ${err.error}`, 'error');
  if (!res.assets.length) return;
  e.history.commit(`Import ${res.assets.length} file(s)`, (d) => {
    for (const a of res.assets) d.media[a.id] = a as Draft<MediaAsset>;
  });
  store.setEditor((x) => ({ mediaStatus: { ...x.mediaStatus, ...Object.fromEntries(res.assets.map((a) => [a.id, 'online' as const])) } }));
  for (const a of res.assets) void prepareMedia(a);
  toast(`${res.assets.length} fichier(s) importé(s)`, 'success', undefined, 2000);
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
    const v = await ask('Fichier différent', 'Le fichier choisi ne correspond pas au média d’origine (taille ou contenu différents). Le lier quand même ?', [
      { label: 'Annuler', value: 'no' },
      { label: 'Lier quand même', value: 'yes', kind: 'danger' },
    ]);
    if (v !== 'yes') return;
  }
  // Re-probe to keep metadata accurate for the new file.
  const res = await api.media.import(e.file, [candidate]);
  const fresh = res.assets[0];
  if (!fresh) return toast(`Impossible de lire ${candidate}`, 'error');
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
      toast(`${ids.length} autre(s) fichier(s) retrouvé(s) dans le même dossier`, 'success');
    }
  }
}

export function removeMedia(mediaId: string) {
  const e = ed();
  const used = Object.values(e.history.present.sequences).some((s) => s.tracks.some((t) => t.clips.some((c) => c.mediaId === mediaId)));
  if (used) return toast('Ce média est utilisé dans la timeline. Retirez d’abord ses clips.', 'error');
  e.history.commit('Retirer le média', (d) => {
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
      // manual edits flow back into the decision graph in the same undoable step
      reconcileGraph(seq as Sequence, d.media as MediaMap);
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
  const ids = edit('Ajouter un clip', (seq, media) => placeMedia(seq, media[mediaId]!, { videoTrack, audioTrack, start: at, mode: 'overwrite' }));
  if (ids) store.setEditor({ selection: ids });
}

export function splitAtPlayhead() {
  const e = ed();
  // Selected clips under the playhead are cut; if none of the selection is under it, cut every
  // unlocked track (Premiere-like behaviour).
  const seq = currentSequence(e);
  const under = e.selection.filter((id) => seq.tracks.some((t) => t.clips.some((c) => c.id === id && c.start < e.playhead && e.playhead < c.start + c.duration)));
  const ids = under.length ? under : undefined;
  const created = edit('Couper', (seq) => splitAt(seq, e.playhead, ids));
  if (created && created.length === 0) toast('Rien à couper à la tête de lecture', 'info', undefined, 1500);
}

export function deleteSelection(ripple: boolean) {
  if (deleteSelectedTransition()) return;
  const e = ed();
  if (!e.selection.length) return;
  edit(ripple ? 'Suppression ripple' : 'Delete', (seq) => deleteClips(seq, e.selection, ripple));
  store.setEditor({ selection: [] });
}

/** Ctrl+D: default cross-dissolve (1 s) at the cut nearest the playhead on every unlocked track. */
export function addDefaultTransition() {
  const e = ed();
  const seq = currentSequence(e);
  const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
  const ids = edit('Ajouter un fondu enchaîné', (s, media) => addTransitionsAt(s, media, e.playhead, Math.round(fps), Math.max(2, Math.round(10 / e.zoom))));
  if (ids?.length) store.setEditor({ selectedTransition: ids[0]!, selection: [] });
}

export function deleteSelectedTransition(): boolean {
  const e = ed();
  if (!e.selectedTransition) return false;
  const id = e.selectedTransition;
  edit('Supprimer la transition', (s) => removeTransition(s, id));
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
    toast(`L'export n'a pas pu démarrer : ${errorText(err)}`, 'error');
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
  e.history.commit('Éléments de production', (d) => {
    d.metadata[INPUTS_KEY] = JSON.stringify(inputs);
  });
  try {
    const { taskId } = await api.production.run(e.file, e.history.present, inputs, prefs);
    store.setEditor({ productionTask: taskId });
    await waitForTask(taskId);
    const r = await api.production.result(taskId);
    const cur = ed();
    const rebuilt = r.report.scriptSource?.kind === 'narration' ? r.report.scriptSource : null;
    cur.history.commit(`Générer « ${r.sequence.name} »`, (d) => {
      // a script rebuilt from the narration is kept as the production script, ready to be corrected
      if (rebuilt) d.metadata[INPUTS_KEY] = JSON.stringify({ ...inputs, script: rebuilt.markdown });
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
    if (rebuilt) toast(`Script reconstruit depuis la narration : ${rebuilt.sentences} phrases, ${rebuilt.sections} sections. Rouvrez Script → Vidéo pour le relire ou le corriger.`, 'info', undefined, 10000);
    toast(`${r.sequence.name} : ${r.report.shots} plans, ${r.report.beats} séquences, contrôle ${qc.qcScore}/100${r.report.fixes.length ? ` · ${r.report.fixes.length} correction(s) auto` : ''} · synchro : ${r.report.alignment.method === 'transcript' ? 'mot à mot' : 'pauses'}${r.report.alignment.method === 'transcript' && r.report.transcription ? ` (${r.report.transcription})` : ''}${r.report.voice ? ` · voix nettoyée (${r.report.voice.steps.length} traitements)` : ''}`, 'success', undefined, 8000);
    return true;
  } catch (err) {
    store.setEditor({ productionTask: null });
    toast(`Échec de la génération : ${errorText(err)}`, 'error');
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
  e.history.commit('Changer de séquence', (d) => {
    d.activeSequenceId = id;
  });
  store.setEditor({ selection: [], selectedTransition: null, playhead: 0 });
}

/** Compares the current (edited) generated sequence with its generation baseline and adapts preferences. */
export async function learnFromEdits() {
  const seq = currentSequence(ed());
  if (!seq.production) return toast('Cette séquence n’a pas été générée automatiquement', 'error');
  const { changes } = await api.production.learn(seq.production.style as never, measureStyle(seq));
  if (!changes.length) toast('Aucune différence mesurable avec la version générée — préférences inchangées', 'info');
  else toast(`Préférences mises à jour : ${changes.join(' · ')}`, 'success', undefined, 8000);
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
    ed().history.commit('Modifier l’animation', (d) => {
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
    toast(`Échec du rendu : ${errorText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------- edit decisions (EDG)

const STATE_LABEL: Record<DecisionState, string> = { proposée: 'Remettre en proposition', acceptée: 'Accepter la décision', rejetée: 'Rejeter la décision', verrouillée: 'Verrouiller la décision' };

/** Accept, lock or unlock a decision (one undoable step). Rejection goes through rejectEditDecision. */
export function setEditDecision(id: string, state: Exclude<DecisionState, 'rejetée'>) {
  edit(STATE_LABEL[state], (s) => void setDecisionState(s as Sequence, id, state));
}

/** Rejects the current choice; the next proposal (if any) replaces it at once. */
export function rejectEditDecision(id: string) {
  const d = edit('Rejeter la décision', (s, m) => rejectDecision(s as Sequence, m, id));
  if (d) toast(d.state === 'rejetée' ? 'Choix rejeté : aucune autre proposition, choisissez un média (ou régénérez)' : `Choix rejeté, remplacé par : ${d.chosen.label}`, 'info');
}

/** Puts a candidate (or any picture of the project) in place of the decision's choice; locks it. */
export function chooseForDecision(id: string, mediaId: string) {
  edit('Remplacer l’image', (s, m) => void chooseCandidate(s as Sequence, m, id, mediaId));
}

/** Replaces the music of a section by a track of the music library (imported, then laid in place). */
export async function chooseMusicForDecision(id: string, trackId: string) {
  const e = ed();
  try {
    const r = await api.production.musicTrack(e.file, trackId);
    const seq = currentSequence(e);
    const prefs = (await api.production.preferences()).current;
    const duck = Math.min(0, prefs.duckDepthDb ?? 0);
    const level = prefs.narrationLufs + prefs.musicRelativeDb - duck;
    const gain = r.lufs != null ? Math.max(-40, Math.min(12, level - r.lufs)) : prefs.musicRelativeDb - duck;
    void seq;
    ed().history.commit('Remplacer la musique', (d) => {
      d.media[r.media.id] = r.media as Draft<MediaAsset>;
      const s = d.sequences[d.activeSequenceId]!;
      replaceMusic(s as Sequence, id, r.media, gain, trackId);
      normalizeSequence(s, d.media as MediaMap);
    });
    store.setEditor((x) => ({ mediaStatus: { ...x.mediaStatus, [r.media.id]: 'online' as const } }));
    void prepareMedia(r.media);
  } catch (err) {
    toast(`Musique non remplacée : ${errorText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------- P-CORE V2 cues (direction of the version)

import type { CueEdit, PCoreCue } from '../pcore/v2/director';
import type { ExpressionId } from '../pcore/v2/expressions';

/** Media ids of the version's P-CORE V2 clips whose window overlaps [t0, t1] (narration seconds). */
function pcoreAssetsAround(p: Project, seq: Sequence, t0: number, t1: number): string[] {
  const used = new Set(seq.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)));
  return Object.values(p.media)
    .filter((m) => used.has(m.id) && m.pcore?.engine === 'v2' && m.pcore.offsetSec < t1 + 1 && m.pcore.offsetSec + m.pcore.durationSec > t0 - 6)
    .map((m) => m.id);
}

/**
 * Changes the P-CORE direction of the active version (one undoable step), then re-renders only the
 * P-CORE clips around the change. `edit` null restores the automatic proposal.
 */
export async function editPCoreCues(label: string, change: (cues: PCoreCue[], edits: CueEdit[], added: PCoreCue[]) => { t0: number; t1: number } | null) {
  const e = ed();
  let touched: string[] = [];
  e.history.commit(label, (d) => {
    const seq = d.sequences[d.activeSequenceId]!;
    const pc = seq.production?.pcore;
    if (!pc) throw new EditError('Cette version n’a pas de direction P-CORE V2 (régénérez-la avec P-CORE V2)');
    const span = change(pc.cues as PCoreCue[], pc.edits as CueEdit[], pc.added as PCoreCue[]);
    if (!span) return;
    pc.cues.sort((a, b) => a.start - b.start);
    touched = pcoreAssetsAround(d as Project, seq as Sequence, span.t0, span.t1);
    for (const id of touched) {
      const a = d.media[id]!.pcore!;
      a.cues = (pc.cues as PCoreCue[]).filter((c) => c.start < a.offsetSec + a.durationSec + 1 && c.start + c.duration > a.offsetSec - 6) as Draft<PCoreCue>[];
    }
  });
  if (!touched.length) return;
  const cur = ed();
  const seq = currentSequence(cur);
  const narr = cur.history.present.media[seq.production!.narrationMediaId] ?? Object.values(cur.history.present.media).find((m) => m.id === cur.history.present.media[touched[0]!]?.pcore?.audioMediaId);
  if (!narr) return toast('Narration introuvable : rendu P-CORE impossible', 'error');
  toast(`Nouveau rendu de ${touched.length} clip(s) P-CORE…`, 'info');
  try {
    const results = await Promise.all(touched.map((id) => api.pcore.renderAsset(cur.file, ed().history.present.media[id]!, narr, seq.settings).then((r) => [id, r] as const)));
    ed().history.commit('Rendu de P-CORE', (d) => {
      for (const [id, r] of results) {
        const a = d.media[id];
        if (!a) continue;
        a.path = r.path;
        a.fingerprint = r.fingerprint;
      }
    });
    store.setEditor((x) => ({ thumbs: Object.fromEntries(Object.entries(x.thumbs).filter(([k]) => !touched.includes(k))) }));
    for (const id of touched) void prepareMedia(ed().history.present.media[id]!);
  } catch (err) {
    toast(`Rendu P-CORE impossible : ${errorText(err)}`, 'error');
  }
}

const upsertEdit = (edits: CueEdit[], cue: PCoreCue, patch: Omit<CueEdit, 'id' | 'original'>) => {
  const i = edits.findIndex((x) => x.id === cue.id);
  if (i < 0) edits.push({ id: cue.id, original: { ...cue }, ...patch });
  else Object.assign(edits[i]!, patch);
};

/** Accept, lock, disable or modify one P-CORE reaction. */
export function setPCoreCue(id: string, patch: { expression?: ExpressionId; duration?: number; intensity?: number; start?: number; state?: PCoreCue['state'] }, label = 'Modifier la réaction P-CORE') {
  return editPCoreCues(label, (cues, edits, added) => {
    const c = cues.find((x) => x.id === id);
    if (!c) return null;
    const before = { t0: c.start, t1: c.start + c.duration };
    Object.assign(c, patch, patch.expression ? { variant: 0 } : {});
    if (patch.expression || patch.duration !== undefined || patch.intensity !== undefined || patch.start !== undefined) c.source = 'utilisateur';
    if (!patch.state && c.state === 'proposée') c.state = 'acceptée';
    const userAdded = added.find((x) => x.id === id);
    if (userAdded) Object.assign(userAdded, c);
    else upsertEdit(edits, c, { ...patch, state: c.state });
    return { t0: Math.min(before.t0, c.start), t1: Math.max(before.t1, c.start + c.duration) };
  });
}

/** Restores the automatic proposal of a reaction (removes the edit). */
export function resetPCoreCue(id: string) {
  return editPCoreCues('Rétablir la proposition P-CORE', (cues, edits, added) => {
    const i = edits.findIndex((x) => x.id === id);
    const j = cues.findIndex((x) => x.id === id);
    if (added.some((x) => x.id === id)) {
      // a reaction you added: removing it is the way back
      added.splice(added.findIndex((x) => x.id === id), 1);
      const c = cues.splice(j, 1)[0];
      return c ? { t0: c.start, t1: c.start + c.duration } : null;
    }
    if (i < 0 || j < 0) return null;
    const orig = edits[i]!.original;
    const cur = cues[j]!;
    const span = { t0: Math.min(cur.start, orig?.start ?? cur.start), t1: Math.max(cur.start + cur.duration, (orig?.start ?? 0) + (orig?.duration ?? 0)) };
    if (orig) cues[j] = { ...orig };
    edits.splice(i, 1);
    return span;
  });
}

/** Adds a reaction of your choice at the playhead. */
export function addPCoreCue(expression: ExpressionId, duration: number) {
  const e = ed();
  const seq = currentSequence(e);
  const t = (e.playhead * seq.settings.frameRate.den) / seq.settings.frameRate.num;
  return editPCoreCues('Ajouter une réaction P-CORE', (cues, _edits, added) => {
    const c: PCoreCue = { id: `pc-u-${Date.now().toString(36)}`, expression, start: +t.toFixed(2), duration, intensity: 1, variant: 0, reasons: ['ajoutée par vous'], source: 'utilisateur', state: 'verrouillée' };
    cues.push(c);
    added.push({ ...c });
    return { t0: c.start, t1: c.start + c.duration };
  });
}

/** Disables every automatic reaction (the base states stay) — reversible one by one or by undo. */
export function disableAutoPCoreCues() {
  return editPCoreCues('Désactiver les réactions automatiques', (cues, edits) => {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const c of cues) {
      if (c.source !== 'auto' || c.state !== 'proposée' || ['dormant', 'awakening', 'final-stabilization', 'silence', 'active'].includes(c.expression)) continue;
      c.state = 'désactivée';
      upsertEdit(edits, c, { state: 'désactivée' });
      t0 = Math.min(t0, c.start);
      t1 = Math.max(t1, c.start + c.duration);
    }
    return t0 < t1 ? { t0, t1 } : null;
  });
}
