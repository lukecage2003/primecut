import { useEffect, useState } from 'react';
import type { EngineCheck, HardwareReport, TranscriberConfig } from '../../shared/api';
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
        <TranscriberSettings />
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
          <button
            className="btn"
            data-testid="save-diagnostics"
            title="Hardware, free space and two short benchmarks, saved as a JSON file you can share. Nothing is sent anywhere."
            onClick={async () => {
              setErr('');
              try {
                const f = await api.system.saveDiagnostics();
                if (f) setErr(`Diagnostics saved: ${f}`);
              } catch (e) {
                setErr(String(e));
              }
            }}
          >
            Save diagnostics report…
          </button>
          <button className="btn primary" onClick={() => store.set({ overlay: null })}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Local transcription (optional). Primestone never installs Python packages or downloads a model by
 * itself: the user selects an engine and a model already on disk; "Check" only runs a read-only test.
 */
function TranscriberSettings() {
  const settings = useStore((s) => s.settings)!;
  const cfg = settings.transcriber;
  const [check, setCheck] = useState<EngineCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TranscriberConfig>) => {
    setCheck(null);
    void updateSettings({ transcriber: { ...cfg, ...patch } });
  };
  const pick = async (kind: 'python' | 'whisper' | 'modelDir' | 'modelFile', key: keyof TranscriberConfig) => {
    const p = await api.transcriber.pick(kind);
    if (p) set({ [key]: p } as Partial<TranscriberConfig>);
  };
  return (
    <>
      <div className="section-title">Local transcription (word-level sync)</div>
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }} data-testid="transcriber-settings">
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="transcriber-enabled" />
          Use local transcription for Script-to-Video
        </label>
        <select className="input" style={{ width: 170 }} value={cfg.backend} onChange={(e) => set({ backend: e.target.value as TranscriberConfig['backend'] })}>
          <option value="faster-whisper">faster-whisper (Python)</option>
          <option value="whisper.cpp">whisper.cpp (executable)</option>
        </select>
        <select className="input" style={{ width: 110 }} value={cfg.device} onChange={(e) => set({ device: e.target.value as TranscriberConfig['device'] })} title="GPU (CUDA) is used only if the engine supports it">
          <option value="auto">Auto</option>
          <option value="cuda">GPU (CUDA)</option>
          <option value="cpu">CPU</option>
        </select>
        <input className="input" style={{ width: 60 }} value={cfg.language} onChange={(e) => set({ language: e.target.value.trim() || 'fr' })} title="Language code" />
      </div>
      <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        {cfg.backend === 'faster-whisper' ? (
          <button className="btn ghost" onClick={() => void pick('python', 'pythonPath')}>Python… {cfg.pythonPath ? `(${cfg.pythonPath.split(/[\\/]/).slice(-3).join('/')})` : '(system default)'}</button>
        ) : (
          <button className="btn ghost" onClick={() => void pick('whisper', 'whisperCppPath')}>whisper-cli… {cfg.whisperCppPath ? `(${cfg.whisperCppPath.split(/[\\/]/).pop()})` : ''}</button>
        )}
        <button className="btn ghost" onClick={() => void pick(cfg.backend === 'faster-whisper' ? 'modelDir' : 'modelFile', 'modelPath')}>
          Model… {cfg.modelPath ? `(${cfg.modelPath.split(/[\\/]/).pop()})` : '(none)'}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setCheck(await api.transcriber.check(cfg));
            } finally {
              setBusy(false);
            }
          }}
          data-testid="transcriber-check"
        >
          {busy ? 'Checking…' : 'Check'}
        </button>
        {check && <span style={{ color: check.ok ? 'var(--ok, #6c6)' : 'var(--danger)' }}>{check.detail}</span>}
      </div>
      <div className="tiny">
        Runs fully offline once set up. Primestone does not download models: get a Whisper model yourself (Whisper weights are MIT-licensed, e.g. “small” ≈ 0.5 GB,
        “medium” ≈ 1.5 GB) and select it here. Audio never leaves this computer. Without transcription, sync is sentence-level from pauses.
      </div>
    </>
  );
}
