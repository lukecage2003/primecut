/**
 * Undo/redo history over immutable project snapshots (immer structural sharing keeps
 * memory proportional to what changed, not to project size).
 */
import { produce, type Draft } from 'immer';
import type { Project } from './model';

export interface HistoryEntry {
  label: string;
  project: Project;
}

type Listener = () => void;

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private current: Project;
  private currentLabel = 'Open';
  private savedRef: Project | null;
  private listeners = new Set<Listener>();

  constructor(project: Project, private readonly limit = 300) {
    this.current = project;
    this.savedRef = project;
  }

  get present(): Project {
    return this.current;
  }

  /** Applies a recipe as one undoable step. If the recipe throws, nothing changes. */
  commit<R>(label: string, recipe: (draft: Draft<Project>) => R): R {
    let result: R | undefined;
    const next = produce(this.current, (d) => {
      result = recipe(d);
      d.modifiedAt = new Date().toISOString();
    });
    if (next !== this.current) {
      this.past.push({ label, project: this.current });
      if (this.past.length > this.limit) this.past.shift();
      this.future = [];
      this.current = next;
      this.currentLabel = label;
      this.emit();
    }
    return result as R;
  }

  /** Replaces state without an undo step (e.g. media relink after open, runtime-only fixes). */
  replaceSilently(project: Project) {
    this.current = project;
    this.emit();
  }

  /** Resets history entirely (open / new project). */
  reset(project: Project) {
    this.past = [];
    this.future = [];
    this.current = project;
    this.savedRef = project;
    this.currentLabel = 'Open';
    this.emit();
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get undoLabel(): string | null {
    return this.past.length ? this.currentLabel : null;
  }
  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push({ label: this.currentLabel, project: this.current });
    this.current = prev.project;
    this.currentLabel = prev.label;
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push({ label: this.currentLabel, project: this.current });
    this.current = next.project;
    this.currentLabel = next.label;
    this.emit();
    return true;
  }

  markSaved() {
    this.savedRef = this.current;
    this.emit();
  }

  get dirty(): boolean {
    return this.savedRef !== this.current;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
