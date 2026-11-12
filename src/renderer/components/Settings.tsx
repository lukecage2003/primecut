import { useEffect, useState } from 'react';
import type { HardwareReport } from '../../shared/api';
import { api } from '../api';
import { updateSettings } from '../actions';
import { store, useStore } from '../store';

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const [hw, setHw] = useState<HardwareReport | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.system.hardware().then(setHw, (e) => setErr(String(e)));
  }, []);
  if (!settings) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && store.set({ overlay: null })}>
      <div className="modal glass" style={{ width: 640 }} data-testid="settings">
        <h2>Settings & diagnostics</h2>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Theme</span>
            <select className="input" value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as 'dark' | 'light' })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Performance profile</span>
            <select className="input" value={settings.performanceProfile} onChange={(e) => void updateSettings({ performanceProfile: e.target.value as never })}>
              <option value="quality">Quality (default)</option>
              <option value="deep-quality">Deep Quality</option>
              <option value="balanced">Balanced</option>
            </select>
          </label>
          <label className="field" style={{ width: 120 }}>
            <span>Autosave (s)</span>
            <input className="input" type="number" min={10} max={3600} value={settings.autosaveSeconds} onChange={(e) => void updateSettings({ autosaveSeconds: Number(e.target.value) })} />
          </label>
        </div>
        <div className="tiny">
          Quality and Deep Quality always export with the CPU encoder at your chosen quality. Balanced uses a hardware encoder only if one was verified working on
          this machine. Primestone never lowers quality without telling you.
        </div>
        <div className="section-title">Hardware (read-only inspection)</div>
        {!hw && !err && <div className="muted">Inspecting…</div>}
        {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
        {hw && (
          <dl className="kv" data-testid="hw-report">
            <dt>System</dt>
            <dd>{hw.platform} · {hw.arch}</dd>
            <dt>CPU</dt>
            <dd>{hw.cpuModel} · {hw.cpuThreads} threads</dd>
            <dt>Memory</dt>
            <dd>{(hw.totalMemMB / 1024).toFixed(1)} GB ({(hw.freeMemMB / 1024).toFixed(1)} GB free)</dd>
            <dt>GPU</dt>
            <dd>{hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramMB ? ` (${g.vramMB} MB)` : ''}`).join(', ') : 'None detected'}</dd>
            <dt>HW encoders</dt>
            <dd>{hw.hwEncoders.length ? hw.hwEncoders.join(', ') : 'None verified (CPU encoding)'}</dd>
            <dt>FFmpeg</dt>
            <dd title={hw.ffmpeg.path}>{hw.ffmpeg.version ?? 'NOT FOUND'} ({hw.ffmpeg.source})</dd>
          </dl>
        )}
        <div className="actions">
          <button className="btn primary" onClick={() => store.set({ overlay: null })}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
