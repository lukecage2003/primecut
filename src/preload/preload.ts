import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PrimestoneApi, TaskInfo } from '../shared/api';

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

const api: PrimestoneApi = {
  platform: process.platform,
  appVersion: () => invoke('app:version'),
  pcore: {
    analyze: (r) => invoke('pcore:analyze', r),
    preview: (file, r) => invoke('pcore:preview', file, r),
    exportFile: (r) => invoke('pcore:export', r),
    stats: () => invoke('pcore:stats'),
    renderAsset: (file, asset, narration, settings) => invoke('pcore:renderAsset', file, asset, narration, settings),
    onProgress: (cb) => {
      const l = (_e: unknown, f: number) => cb(f);
      ipcRenderer.on('pcore:progress', l);
      return () => ipcRenderer.removeListener('pcore:progress', l);
    },
  },
  ocr: {
    check: (cfg) => invoke('ocr:check', cfg),
    pick: () => invoke('ocr:pick'),
  },
  transcriber: {
    check: (cfg) => invoke('transcriber:check', cfg),
    pick: (kind) => invoke('transcriber:pick', kind),
  },
  models: {
    list: () => invoke('models:list'),
    download: (id) => invoke('models:download', id),
    importFile: (id) => invoke('models:import', id),
    use: (id) => invoke('models:use', id),
    remove: (id) => invoke('models:remove', id),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  project: {
    create: (dir, name, project) => invoke('project:create', dir, name, project),
    open: (file) => invoke('project:open', file),
    save: (file, project) => invoke('project:save', file, project),
    autosave: (file, project) => invoke('project:autosave', file, project),
    discardRecovery: (file) => invoke('project:discardRecovery', file),
    recent: () => invoke('project:recent'),
    forgetRecent: (file) => invoke('project:forgetRecent', file),
    searchMissing: (assets, root) => invoke('project:searchMissing', assets, root),
  },
  dialog: {
    openProject: () => invoke('dialog:openProject'),
    chooseFolder: (title, defaultPath) => invoke('dialog:chooseFolder', title, defaultPath),
    importMedia: () => invoke('dialog:importMedia'),
    exportTarget: (name) => invoke('dialog:exportTarget', name),
    relinkFile: (name) => invoke('dialog:relinkFile', name),
  },
  media: {
    import: (file, paths) => invoke('media:import', file, paths),
    thumbnail: (file, asset) => invoke('media:thumbnail', file, asset),
    peaks: (file, asset) => invoke('media:peaks', file, asset),
    needsProxy: (asset) => invoke('media:needsProxy', asset),
    proxy: (file, asset) => invoke('media:proxy', file, asset),
    checkRelink: (asset, candidate) => invoke('media:checkRelink', asset, candidate),
    pathForFile: (f) => webUtils.getPathForFile(f),
  },
  export: {
    start: (req) => invoke('export:start', req),
    result: (id) => invoke('export:result', id),
  },
  production: {
    run: (file, project, inputs, prefs) => invoke('production:run', file, project, inputs, prefs),
    result: (id) => invoke('production:result', id),
    preferences: () => invoke('production:preferences'),
    setPreferences: (p, reason) => invoke('production:setPreferences', p, reason),
    learn: (g, e) => invoke('production:learn', g, e),
    revertPreferences: (v) => invoke('production:revertPreferences', v),
    readTextFile: () => invoke('production:readTextFile'),
    chooseFolders: () => invoke('production:chooseFolders'),
    transcribeCommand: (audio) => invoke('production:transcribeCommand', audio),
    inspire: (prefs) => invoke('production:inspire', prefs),
    renderVisual: (file, spec, size, audio) => invoke('production:renderVisual', file, spec, size, audio),
    musicTrack: (file, trackId) => invoke('production:musicTrack', file, trackId),
  },
  tasks: {
    list: () => invoke('tasks:list'),
    cancel: (id) => invoke('tasks:cancel', id),
    clearFinished: () => invoke('tasks:clearFinished'),
    onChanged: (cb) => {
      const l = (_: unknown, t: TaskInfo | null) => cb(t);
      ipcRenderer.on('tasks:changed', l);
      return () => ipcRenderer.removeListener('tasks:changed', l);
    },
  },
  music: {
    list: () => invoke('music:list'),
    addFolder: () => invoke('music:addFolder'),
    removeFolder: (d) => invoke('music:removeFolder', d),
    scan: () => invoke('music:scan'),
    setOverride: (id, o) => invoke('music:setOverride', id, o),
  },
  system: {
    hardware: () => invoke('system:hardware'),
    saveDiagnostics: () => invoke('system:saveDiagnostics'),
    dependencies: () => invoke('system:dependencies'),
    recentProblems: () => invoke('system:recentProblems'),
    openLogs: () => invoke('system:openLogs'),
    reportError: (e) => ipcRenderer.send('system:reportError', e),
    reveal: (f) => invoke('system:reveal', f),
  },
  window: {
    onCloseRequested: (cb) => {
      const l = () => cb();
      ipcRenderer.on('window:closeRequested', l);
      return () => ipcRenderer.removeListener('window:closeRequested', l);
    },
    confirmClose: () => invoke('window:confirmClose'),
  },
};

contextBridge.exposeInMainWorld('primestone', api);
