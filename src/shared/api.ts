/**
 * The typed contract between the renderer (UI) and the main process (engine).
 * The renderer never touches the filesystem or spawns processes directly.
 */
import type { MediaAsset, Project, Sequence } from '../core/model';
import type { ProductionPreferences } from '../production/preferences';
import type { EditStyle } from '../production/preferences';
import type { HardwareReport, PerformanceProfile } from '../engine/hardware';
import type { MediaResolution } from '../engine/projectStore';
import type { TaskInfo } from '../engine/tasks';

export type { HardwareReport, MediaResolution, TaskInfo, PerformanceProfile };

export interface RecentProject {
  file: string;
  name: string;
  openedAt: string;
  exists: boolean;
}

export interface OpenResult {
  file: string;
  project: Project;
  savedAt: string;
  cacheDir: string;
  media: MediaResolution[];
  issues: string[];
  recovery?: { project: Project; savedAt: string };
}

export interface ImportResult {
  assets: MediaAsset[];
  errors: { path: string; error: string }[];
}

export interface AppSettings {
  theme: 'dark' | 'light';
  performanceProfile: PerformanceProfile;
  autosaveSeconds: number;
  projectsDir: string;
}

export interface ExportRequest {
  projectFile: string;
  project: Project;
  sequenceId: string;
  output: string;
}

export interface ExportOutcome {
  output: string;
  encoder: string;
  frames: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface ProductionInputs {
  script: string;
  narrationMediaId: string;
  musicMediaId: string | null;
  mediaFolders: string[];
}

export interface ProductionOutcome {
  sequence: Sequence;
  newMedia: MediaAsset[];
  report: {
    sentences: number;
    beats: number;
    shots: number;
    alignment: { method: string; confidence: number };
    fixes: string[];
    scanErrors: { path: string; error: string }[];
    notes: string[];
    entities: string[];
  };
}

export interface PreferencesState {
  current: ProductionPreferences;
  history: { version: number; at: string; changes: string[] }[];
}

export interface PrimestoneApi {
  platform: string;
  appVersion(): Promise<string>;
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  project: {
    create(dir: string, name: string, project: Project): Promise<OpenResult>;
    open(file: string): Promise<OpenResult>;
    save(file: string, project: Project): Promise<{ savedAt: string }>;
    autosave(file: string, project: Project): Promise<void>;
    discardRecovery(file: string): Promise<void>;
    recent(): Promise<RecentProject[]>;
    forgetRecent(file: string): Promise<void>;
    searchMissing(assets: MediaAsset[], root: string): Promise<Record<string, string>>;
  };
  dialog: {
    openProject(): Promise<string | null>;
    chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
    importMedia(): Promise<string[]>;
    exportTarget(defaultName: string): Promise<string | null>;
    relinkFile(name: string): Promise<string | null>;
  };
  media: {
    import(projectFile: string, paths: string[]): Promise<ImportResult>;
    thumbnail(projectFile: string, asset: MediaAsset): Promise<string | null>;
    peaks(projectFile: string, asset: MediaAsset): Promise<Uint8Array | null>;
    needsProxy(asset: MediaAsset): Promise<boolean>;
    proxy(projectFile: string, asset: MediaAsset): Promise<string>;
    checkRelink(asset: MediaAsset, candidate: string): Promise<boolean>;
    /** Returns the absolute filesystem path of a dropped File (Electron webUtils). */
    pathForFile(file: File): string;
  };
  export: {
    start(req: ExportRequest): Promise<{ taskId: string }>;
    result(taskId: string): Promise<ExportOutcome>;
  };
  production: {
    run(projectFile: string, project: Project, inputs: ProductionInputs, prefs: ProductionPreferences): Promise<{ taskId: string }>;
    result(taskId: string): Promise<ProductionOutcome>;
    preferences(): Promise<PreferencesState>;
    setPreferences(p: ProductionPreferences, reason: string): Promise<PreferencesState>;
    learn(generated: EditStyle, edited: EditStyle): Promise<{ state: PreferencesState; changes: string[] }>;
    revertPreferences(version: number): Promise<PreferencesState>;
    readTextFile(): Promise<{ path: string; text: string } | null>;
    chooseFolders(): Promise<string[]>;
  };
  tasks: {
    list(): Promise<TaskInfo[]>;
    cancel(id: string): Promise<boolean>;
    clearFinished(): Promise<void>;
    onChanged(cb: (t: TaskInfo | null) => void): () => void;
  };
  system: {
    hardware(): Promise<HardwareReport>;
    reveal(file: string): Promise<void>;
  };
  window: {
    onCloseRequested(cb: () => void): () => void;
    confirmClose(): Promise<void>;
  };
}

/** URL scheme used to stream local media into <video>/<img> elements with Range support. */
export const MEDIA_SCHEME = 'pmedia';
export function mediaUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absPath)}`;
}
