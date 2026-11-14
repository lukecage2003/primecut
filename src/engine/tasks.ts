/**
 * Task orchestrator shared by media processing, proxies, exports and (later) local AI.
 *
 * Each task has: id, type, label, priority, resource needs (cpu slots, gpu), dependencies,
 * a dedupe key (identical pending work is never queued twice), progress, a log, a result and
 * cancellation via AbortSignal. A task is only marked `done` after its optional verify step passes.
 */
import { EventEmitter } from 'node:events';
import { CancelledError, ProcessError } from './ffmpeg';
import { log as writeLog } from './log';

export type TaskState = 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled';
export type TaskPriority = 'high' | 'normal' | 'low';
const PRIO: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

export interface TaskResources {
  cpuSlots: number;
  gpu?: boolean;
}

/** Live view of a long task (production): what is being built, shown while it runs. */
export interface TaskLive {
  stage: string;
  /** Storyboard of the edit as it is decided and rendered (thumbnail files appear when ready). */
  board?: { start: number; end: number; kind: 'image' | 'composition' | 'missing'; label: string; text: string; thumb?: string }[];
  /** Most recent picture produced (rendered composition, P-CORE frame…). */
  latest?: string;
  detail?: string;
}

export interface TaskContext {
  signal: AbortSignal;
  progress(fraction: number, message?: string): void;
  /** Updates the live view (merged into the previous one). */
  live?(patch: Partial<TaskLive>): void;
  log(line: string): void;
}

export interface TaskSpec<R = unknown> {
  type: string;
  label: string;
  priority?: TaskPriority;
  resources?: TaskResources;
  dependsOn?: string[];
  dedupeKey?: string;
  input?: unknown;
  run(ctx: TaskContext): Promise<R>;
  verify?(result: R): Promise<void> | void;
}

export interface TaskInfo {
  id: string;
  type: string;
  label: string;
  priority: TaskPriority;
  state: TaskState;
  progress: number;
  message?: string;
  error?: string;
  log: string[];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  dependsOn: string[];
  resources: TaskResources;
  live?: TaskLive;
}

interface Internal {
  info: TaskInfo;
  spec: TaskSpec;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  result?: unknown;
}

let seq = 0;

export class TaskOrchestrator extends EventEmitter {
  private tasks = new Map<string, Internal>();
  private usedCpu = 0;
  private gpuBusy = false;

  constructor(public maxCpuSlots = 2) {
    super();
  }

  submit<R>(spec: TaskSpec<R>): { id: string; promise: Promise<R> } {
    if (spec.dedupeKey) {
      for (const t of this.tasks.values()) {
        if (t.spec.dedupeKey === spec.dedupeKey && ['queued', 'running', 'verifying'].includes(t.info.state)) {
          return { id: t.info.id, promise: t.promise as Promise<R> };
        }
      }
    }
    const id = `task-${++seq}`;
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined); // avoid unhandled rejections; callers observe via returned promise
    const info: TaskInfo = {
      id,
      type: spec.type,
      label: spec.label,
      priority: spec.priority ?? 'normal',
      state: 'queued',
      progress: 0,
      log: [],
      createdAt: Date.now(),
      dependsOn: spec.dependsOn ?? [],
      resources: spec.resources ?? { cpuSlots: 1 },
    };
    this.tasks.set(id, { info, spec: spec as TaskSpec, controller: new AbortController(), promise, resolve, reject });
    this.changed(info);
    queueMicrotask(() => this.pump());
    return { id, promise: promise as Promise<R> };
  }

  cancel(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.info.state === 'queued') {
      this.finish(t, 'cancelled', new CancelledError());
      return true;
    }
    if (t.info.state === 'running' || t.info.state === 'verifying') {
      t.controller.abort();
      return true;
    }
    return false;
  }

  get(id: string): TaskInfo | undefined {
    return this.tasks.get(id)?.info;
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((t) => t.info);
  }

  /** Drops finished tasks from the list. */
  clearFinished() {
    for (const [id, t] of this.tasks) if (['done', 'failed', 'cancelled'].includes(t.info.state)) this.tasks.delete(id);
    this.emit('changed', null);
  }

  private changed(info: TaskInfo) {
    this.emit('changed', { ...info, log: info.log.slice(-50) });
  }

  private depsState(t: Internal): 'ready' | 'wait' | 'failed' {
    for (const d of t.info.dependsOn) {
      const dt = this.tasks.get(d);
      if (!dt) continue;
      if (dt.info.state === 'failed' || dt.info.state === 'cancelled') return 'failed';
      if (dt.info.state !== 'done') return 'wait';
    }
    return 'ready';
  }

  private pump() {
    const queued = [...this.tasks.values()]
      .filter((t) => t.info.state === 'queued')
      .sort((a, b) => PRIO[a.info.priority] - PRIO[b.info.priority] || a.info.createdAt - b.info.createdAt);
    for (const t of queued) {
      const ds = this.depsState(t);
      if (ds === 'failed') {
        this.finish(t, 'failed', new Error('A dependency failed'));
        continue;
      }
      if (ds === 'wait') continue;
      const need = Math.min(t.info.resources.cpuSlots, this.maxCpuSlots);
      if (this.usedCpu + need > this.maxCpuSlots) continue;
      if (t.info.resources.gpu && this.gpuBusy) continue;
      this.start(t, need);
    }
  }

  private start(t: Internal, cpu: number) {
    this.usedCpu += cpu;
    if (t.info.resources.gpu) this.gpuBusy = true;
    t.info.state = 'running';
    t.info.startedAt = Date.now();
    writeLog('info', 'task', `début : ${t.info.label}`, { cpu }, t.info.id);
    this.changed(t.info);
    let lastEmit = 0;
    const ctx: TaskContext = {
      signal: t.controller.signal,
      progress: (f, message) => {
        t.info.progress = Math.max(0, Math.min(1, f));
        if (message) t.info.message = message;
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          this.changed(t.info);
        }
      },
      live: (patch) => {
        t.info.live = { stage: '', ...t.info.live, ...patch };
        const now = Date.now();
        if (now - lastEmit > 150) {
          lastEmit = now;
          this.changed(t.info);
        }
      },
      log: (line) => {
        writeLog('debug', 'task', line, undefined, t.info.id);
        t.info.log.push(line);
        if (t.info.log.length > 500) t.info.log.shift();
      },
    };
    const release = () => {
      this.usedCpu -= cpu;
      if (t.info.resources.gpu) this.gpuBusy = false;
    };
    (async () => {
      try {
        const result = await t.spec.run(ctx);
        if (t.controller.signal.aborted) throw new CancelledError();
        if (t.spec.verify) {
          t.info.state = 'verifying';
          this.changed(t.info);
          await t.spec.verify(result);
        }
        t.result = result;
        release();
        this.finish(t, 'done', undefined, result);
      } catch (e) {
        release();
        const cancelled = e instanceof CancelledError || t.controller.signal.aborted;
        this.finish(t, cancelled ? 'cancelled' : 'failed', e);
      }
    })();
  }

  private finish(t: Internal, state: TaskState, error?: unknown, result?: unknown) {
    t.info.state = state;
    t.info.endedAt = Date.now();
    if (state === 'done') {
      t.info.progress = 1;
      t.resolve(result);
    } else {
      t.info.error = error instanceof Error ? error.message : String(error);
      t.reject(error);
    }
    const sec = t.info.startedAt ? +((t.info.endedAt! - t.info.startedAt) / 1000).toFixed(2) : 0;
    if (state === 'failed') {
      const pe = error instanceof ProcessError ? { code: error.code, stderr: error.stderr.slice(-2000) } : {};
      writeLog('error', 'task', `échec : ${t.info.label} — ${t.info.error}`, { sec, ...pe, stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined }, t.info.id);
    } else writeLog(state === 'done' ? 'info' : 'warn', 'task', `${state === 'done' ? 'terminé' : 'annulé'} : ${t.info.label}`, { sec }, t.info.id);
    this.changed(t.info);
    queueMicrotask(() => this.pump());
  }
}
