import { useEffect } from 'react';
import { sequenceDuration } from '../../core';
import { closeProject, deleteSelection, edit, redo, save, setPlayhead, splitAtPlayhead, undo } from '../actions';
import { addMarker } from '../../core';
import { pause, play, togglePlay } from '../playback';
import { type Tool, currentSequence, store, useEditor, useStore } from '../store';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { MediaLibrary } from './MediaLibrary';
import { TaskPanel } from './Overlays';
import { SettingsPanel } from './Settings';
import { Timeline } from './Timeline';
import { Viewer } from './Viewer';

const TOOL_KEYS: Record<string, Tool> = { v: 'select', c: 'razor', b: 'ripple', n: 'roll', y: 'slip', u: 'slide' };

function onKey(ev: KeyboardEvent) {
  const t = ev.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (store.state.modal || store.state.overlay === 'export' || store.state.overlay === 'settings') return;
  const e = store.state.editor;
  if (!e) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key.toLowerCase();
  const handled = () => ev.preventDefault();
  if (mod && k === 'z' && !ev.shiftKey) return handled(), undo();
  if ((mod && k === 'z' && ev.shiftKey) || (mod && k === 'y')) return handled(), redo();
  if (mod && k === 's') return handled(), void save();
  if (mod && k === 'k') return handled(), splitAtPlayhead();
  if (mod) return;
  switch (ev.key) {
    case ' ':
      return handled(), togglePlay();
    case 'ArrowLeft':
      pause();
      return handled(), setPlayhead(e.playhead - (ev.shiftKey ? 10 : 1));
    case 'ArrowRight':
      pause();
      return handled(), setPlayhead(e.playhead + (ev.shiftKey ? 10 : 1));
    case 'Home':
      pause();
      return handled(), setPlayhead(0);
    case 'End':
      pause();
      return handled(), setPlayhead(sequenceDuration(currentSequence(e)));
    case 'Delete':
    case 'Backspace':
      return handled(), deleteSelection(ev.shiftKey);
  }
  if (k === 'l') return handled(), play(1);
  if (k === 'k') return handled(), pause();
  if (k === 'j') return handled(), play(-1);
  if (k === 's') return handled(), splitAtPlayhead();
  if (k === 'm') return handled(), edit('Add marker', (seq) => addMarker(seq, e.playhead));
  if (k === '=' || k === '+') return handled(), store.setEditor((x) => ({ zoom: Math.min(64, x.zoom * 1.4) }));
  if (k === '-') return handled(), store.setEditor((x) => ({ zoom: Math.max(0.05, x.zoom / 1.4) }));
  const tool = TOOL_KEYS[k];
  if (tool) return handled(), store.setEditor({ tool });
}

export function Editor() {
  const name = useEditor((e) => e.history.present.name);
  const dirty = useEditor((e) => e.history.dirty);
  const canUndo = useEditor((e) => e.history.canUndo);
  const canRedo = useEditor((e) => e.history.canRedo);
  const undoLabel = useEditor((e) => e.history.undoLabel);
  const overlay = useStore((s) => s.overlay);
  const running = useStore((s) => Object.values(s.tasks).filter((t) => t.state === 'running' || t.state === 'queued').length);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      pause();
    };
  }, []);

  return (
    <div className="editor">
      <div className="topbar">
        <div className="brand-mark" style={{ width: 28, height: 28, fontSize: 14, borderRadius: 8 }}>
          P
        </div>
        <span className="title" data-testid="project-title">
          {name}
          {dirty && <span className="dirty" title="Unsaved changes">●</span>}
        </span>
        <div className="spacer" />
        <button className="btn ghost" disabled={!canUndo} title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo'} onClick={undo} data-testid="undo">
          ↶ Undo
        </button>
        <button className="btn ghost" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" onClick={redo} data-testid="redo">
          ↷ Redo
        </button>
        <button className="btn" onClick={() => void save()} data-testid="save" title="Save (Ctrl+S)">
          Save
        </button>
        <button className="btn ghost" onClick={() => store.set({ overlay: overlay === 'tasks' ? null : 'tasks' })} data-testid="tasks-btn">
          Tasks{running ? ` · ${running}` : ''}
        </button>
        <button className="btn ghost icon" title="Settings & diagnostics" onClick={() => store.set({ overlay: 'settings' })}>
          ⚙
        </button>
        <button className="btn primary" onClick={() => store.set({ overlay: 'export' })} data-testid="export-open">
          Export
        </button>
        <button className="btn ghost" onClick={() => void closeProject()} data-testid="close-project">
          Close
        </button>
      </div>
      <div className="upper">
        <MediaLibrary />
        <Viewer />
        <Inspector />
      </div>
      <Splitter />
      <Timeline />
      {overlay === 'export' && <ExportDialog />}
      {overlay === 'tasks' && <TaskPanel />}
      {overlay === 'settings' && <SettingsPanel />}
    </div>
  );
}

function Splitter() {
  return (
    <div
      className="splitter"
      onPointerDown={(e) => {
        const el = (e.currentTarget.parentElement as HTMLElement)!;
        const startY = e.clientY;
        const startH = parseFloat(getComputedStyle(el).getPropertyValue('--timeline-h')) || 340;
        const move = (ev: PointerEvent) => el.style.setProperty('--timeline-h', `${Math.max(180, Math.min(window.innerHeight - 320, startH - (ev.clientY - startY)))}px`);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}
