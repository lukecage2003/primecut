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
import type { EngineCheck, TranscriberConfig } from '../engine/transcribe';
import type { AlphaCheck, PCoreFormat } from '../engine/pcore';
import type { PCoreStudioRequest } from '../main/pcoreRender';

export type { AlphaCheck, PCoreFormat, PCoreStudioRequest };
export type { HardwareReport, MediaResolution, TaskInfo, PerformanceProfile, TranscriberConfig, EngineCheck };

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
  /** Optional local speech recognition for word-level sync (off until the user configures it). */
  transcriber: TranscriberConfig;
  /** P-CORE appearance / reactions / placement (brand-wide). */
  pcore?: { settings?: Partial<import('../pcore/expression').PCoreSettings>; placement?: Partial<import('../pcore/placement').PlacementSettings>; /** Render quality of P-CORE clips in productions (default 'high'). */ quality?: import('../pcore/quality').PCoreQuality };
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
  /** Frame format of the generated version; omitted = the project's own format. */
  format?: OutputFormat;
  /** Narration format: 'auto' (detected) or forced. */
  narrationKind?: import('../production/narrationFormat').NarrationKind | 'auto';
}

export type OutputFormat = '16:9' | '9:16' | '1:1' | '4:5';
export const FORMAT_SIZES: Record<OutputFormat, { width: number; height: number }> = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 }, '4:5': { width: 1080, height: 1350 } };

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
    scriptImport?: { title: string | null; sections: number; repairs: number };
    transcription?: string;
    voice?: { steps: { id: string; reason: string }[]; afterLufs: number | null };
    scriptSource?: { kind: 'script' } | { kind: 'narration'; title: string; sentences: number; sections: number; markdown: string };
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
  pcore: {
    analyze(r: PCoreStudioRequest): Promise<{ fps: number; voice: { env: number; low: number; mid: number; high: number; speaking: boolean }[]; states: string[]; energy: number[]; fragment: number[] }>;
    preview(projectFile: string, r: PCoreStudioRequest & { size: number }): Promise<string>;
    exportFile(r: PCoreStudioRequest & { width: number; height: number; format: PCoreFormat; withAudio: boolean; quality?: import('../pcore/quality').PCoreQuality }): Promise<{ path: string; check: AlphaCheck; quality: import('../pcore/quality').PCoreQuality; renderSec: number; fps: number } | null>;
    onProgress(cb: (f: number) => void): () => void;
  };
  transcriber: {
    /** Read-only check of the configured engine/model (never installs or downloads). */
    check(cfg: TranscriberConfig): Promise<EngineCheck>;
    /** Native picker for the engine executable, a model folder or a model file. */
    pick(kind: 'python' | 'whisper' | 'modelDir' | 'modelFile'): Promise<string | null>;
  };
  /** Local AI models: nothing is downloaded without an explicit request (size and licence shown first). */
  models: {
    list(): Promise<{ catalog: import('../engine/models').ModelEntry[]; status: import('../engine/models').ModelStatus[]; dir: string; bundledEngine: boolean }>;
    download(id: string): Promise<{ taskId: string }>;
    importFile(id: string): Promise<string | null>;
    use(id: string): Promise<string>;
    remove(id: string): Promise<void>;
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
    /** Opens a script (.pdf/.txt/.md); production scripts are converted to Primestone Markdown. */
    readTextFile(): Promise<{ path: string; text: string; title?: string | null; meta?: Record<string, string>; repairs?: number; sections?: number } | null>;
    chooseFolders(): Promise<string[]>;
    /** Renders a procedural composition; returns the cached file and its fingerprint. */
    renderVisual(projectFile: string, spec: import('../core/generators').GeneratorSpec, size: { width: number; height: number; rate: string }, audioPath: string | null): Promise<{ path: string; fingerprint: import('../core/model').MediaFingerprint }>;
  };
  tasks: {
    list(): Promise<TaskInfo[]>;
    cancel(id: string): Promise<boolean>;
    clearFinished(): Promise<void>;
    onChanged(cb: (t: TaskInfo | null) => void): () => void;
  };
  system: {
    hardware(): Promise<HardwareReport>;
    /** Runs read-only diagnostics + short benchmarks and saves them as JSON where the user chooses. */
    saveDiagnostics(): Promise<string | null>;
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
