/**
 * Renderer state. The project document lives in a core `History` (undo/redo); this store holds
 * UI/session state around it. Components subscribe with selectors so playback-rate updates
 * (playhead) only re-render what depends on them.
 */
import { useSyncExternalStore } from 'react';
import { type History, type Project, type Sequence } from '../core';
import type { AppSettings, MediaResolution, TaskInfo } from '../shared/api';

export type Tool = 'select' | 'razor' | 'ripple' | 'roll' | 'slip' | 'slide';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

export interface ModalSpec {
  title: string;
  body?: string;
  buttons: { label: string; kind?: 'primary' | 'danger'; value: string }[];
  resolve: (value: string | null) => void;
}

export interface EditorSession {
  file: string;
  cacheDir: string;
  history: History;
  /** Transient project shown while dragging (not committed). */
  preview: Project | null;
  selection: string[];
  playhead: number;
  playing: boolean;
  zoom: number; // px per frame
  tool: Tool;
  snapping: boolean;
  mediaStatus: Record<string, MediaResolution['status']>;
  thumbs: Record<string, string>;
  peaks: Record<string, Uint8Array>;
  proxies: Record<string, string>;
  selectedMedia: string | null;
  selectedTransition: string | null;
  productionTask: string | null;
  snapAt: number | null;
  savedAt: string;
  version: number; // bumps on history change
}

export interface AppState {
  screen: 'home' | 'editor';
  editor: EditorSession | null;
  settings: AppSettings | null;
  tasks: Record<string, TaskInfo>;
  toasts: Toast[];
  modal: ModalSpec | null;
  overlay: null | 'export' | 'settings' | 'tasks' | 'production';
}

type Listener = () => void;

class Store {
  state: AppState = { screen: 'home', editor: null, settings: null, tasks: {}, toasts: [], modal: null, overlay: null };
  private listeners = new Set<Listener>();

  get = () => this.state;

  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  setEditor(patch: Partial<EditorSession> | ((e: EditorSession) => Partial<EditorSession>)) {
    const e = this.state.editor;
    if (!e) return;
    const p = typeof patch === 'function' ? patch(e) : patch;
    this.set({ editor: { ...e, ...p } });
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}

export const store = new Store();

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.state));
}

export function useEditor<T>(selector: (e: EditorSession) => T): T {
  return useStore((s) => selector(s.editor!));
}

/** The project currently displayed (drag preview if any, else the committed state). */
export function currentProject(e: EditorSession): Project {
  return e.preview ?? e.history.present;
}

export function currentSequence(e: EditorSession): Sequence {
  const p = currentProject(e);
  return p.sequences[p.activeSequenceId]!;
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 5000) {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? ms * 2 : ms);
}

export function ask(title: string, body: string, buttons: ModalSpec['buttons']): Promise<string | null> {
  return new Promise((resolve) => {
    store.set({
      modal: {
        title,
        body,
        buttons,
        resolve: (v) => {
          store.set({ modal: null });
          resolve(v);
        },
      },
    });
  });
}
