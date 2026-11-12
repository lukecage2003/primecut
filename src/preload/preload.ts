import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PrimestoneApi, TaskInfo } from '../shared/api';

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

const api: PrimestoneApi = {
  platform: process.platform,
  appVersion: () => invoke('app:version'),
  transcriber: {
    check: (cfg) => invoke('transcriber:check', cfg),
    pick: (kind) => invoke('transcriber:pick', kind),
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
    renderVisual: (file, spec, size, audio) => invoke('production:renderVisual', file, spec, size, audio),
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
  system: {
    hardware: () => invoke('system:hardware'),
    saveDiagnostics: () => invoke('system:saveDiagnostics'),
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
