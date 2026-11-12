import { api } from '../api';
import { store, useStore } from '../store';

export function ModalHost() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && modal.resolve(null)}>
      <div className="modal glass" role="dialog" aria-label={modal.title}>
        <h2>{modal.title}</h2>
        {modal.body && <div className="muted">{modal.body}</div>}
        <div className="actions">
          {modal.buttons.map((b) => (
            <button key={b.value} className={`btn ${b.kind ?? ''}`} onClick={() => modal.resolve(b.value)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass ${t.kind}`} data-testid={`toast-${t.kind}`}>
          <div className="row">
            <span style={{ flex: 1 }}>{t.text}</span>
            {t.action && (
              <button className="btn" onClick={t.action.run}>
                {t.action.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = { queued: 'Queued', running: 'Running', verifying: 'Verifying', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

export function TaskPanel() {
  const tasks = useStore((s) => s.tasks);
  const list = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  return (
    <div className="tasks glass" data-testid="task-panel">
      <div className="row">
        <b style={{ flex: 1 }}>Background tasks</b>
        <button className="btn ghost" onClick={() => void api.tasks.clearFinished()}>
          Clear finished
        </button>
        <button className="btn ghost icon" onClick={() => store.set({ overlay: null })} aria-label="Close">
          ✕
        </button>
      </div>
      {list.length === 0 && <div className="tiny">No tasks yet.</div>}
      {list.map((t) => (
        <div key={t.id} className="task" data-testid={`task-${t.type}`} data-state={t.state}>
          <div className="row">
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
            <span className={`pill ${t.state}`}>{STATE_LABEL[t.state]}</span>
          </div>
          {(t.state === 'running' || t.state === 'verifying') && (
            <div className="progress">
              <div style={{ width: `${Math.round(t.progress * 100)}%` }} />
            </div>
          )}
          {t.message && <div className="tiny">{t.message}</div>}
          {t.error && t.state === 'failed' && <div className="tiny" style={{ color: 'var(--danger)' }}>{t.error}</div>}
          <div className="row">
            {(t.state === 'running' || t.state === 'queued') && (
              <button className="btn ghost" onClick={() => void api.tasks.cancel(t.id)}>
                Cancel
              </button>
            )}
            {t.type === 'export' && t.state === 'done' && (
              <button className="btn ghost" onClick={() => void api.export.result(t.id).then((r) => api.system.reveal(r.output))}>
                Show in folder
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
