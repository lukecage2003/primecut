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
        <h2>Réglages et diagnostic</h2>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Thème</span>
            <select className="input" value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as 'dark' | 'light' })}>
              <option value="dark">Sombre</option>
              <option value="light">Clair</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Profil de performance</span>
            <select className="input" value={settings.performanceProfile} onChange={(e) => void updateSettings({ performanceProfile: e.target.value as never })}>
              <option value="quality">Qualité (par défaut)</option>
              <option value="deep-quality">Qualité maximale</option>
              <option value="balanced">Équilibré</option>
            </select>
          </label>
          <label className="field" style={{ width: 120 }}>
            <span>Sauvegarde auto (s)</span>
            <input className="input" type="number" min={10} max={3600} value={settings.autosaveSeconds} onChange={(e) => void updateSettings({ autosaveSeconds: Number(e.target.value) })} />
          </label>
        </div>
        <div className="tiny">
          Qualité et Qualité maximale exportent toujours avec l'encodeur processeur, à la qualité choisie. Équilibré n'utilise un encodeur matériel que s'il a été
          vérifié sur cette machine. Primestone ne baisse jamais la qualité sans vous le dire.
        </div>
        <TranscriberSettings />
        <div className="section-title">Matériel (inspection en lecture seule)</div>
        {!hw && !err && <div className="muted">Inspection…</div>}
        {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
        {hw && (
          <dl className="kv" data-testid="hw-report">
            <dt>Système</dt>
            <dd>{hw.platform} · {hw.arch}</dd>
            <dt>Processeur</dt>
            <dd>{hw.cpuModel} · {hw.cpuThreads} threads</dd>
            <dt>Mémoire</dt>
            <dd>{(hw.totalMemMB / 1024).toFixed(1)} GB ({(hw.freeMemMB / 1024).toFixed(1)} GB free)</dd>
            <dt>Carte graphique</dt>
            <dd>{hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramMB ? ` (${g.vramMB} MB)` : ''}`).join(', ') : 'Aucune détectée'}</dd>
            <dt>Encodeurs matériels</dt>
            <dd>{hw.hwEncoders.length ? hw.hwEncoders.join(', ') : 'Aucun vérifié (encodage processeur)'}</dd>
            <dt>FFmpeg</dt>
            <dd title={hw.ffmpeg.path}>{hw.ffmpeg.version ?? 'NOT FOUND'} ({hw.ffmpeg.source})</dd>
          </dl>
        )}
        <div className="actions">
          <button
            className="btn"
            data-testid="save-diagnostics"
            title="Matériel, espace libre et deux courts tests de performance, enregistrés dans un fichier JSON que vous pouvez partager. Rien n'est envoyé."
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
            Enregistrer le rapport de diagnostic…
          </button>
          <button className="btn primary" onClick={() => store.set({ overlay: null })}>
            Terminé
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Local transcription (optional). Primestone never installs Python packages or downloads a model by
 * itself: the user selects an engine and a model already on disk; "Vérifier" only runs a read-only test.
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
      <div className="section-title">Transcription locale (synchro mot à mot)</div>
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }} data-testid="transcriber-settings">
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="transcriber-enabled" />
          Utiliser la transcription locale pour Script → Vidéo
        </label>
        <select className="input" style={{ width: 170 }} value={cfg.backend} onChange={(e) => set({ backend: e.target.value as TranscriberConfig['backend'] })}>
          <option value="faster-whisper">faster-whisper (Python)</option>
          <option value="whisper.cpp">whisper.cpp (exécutable)</option>
        </select>
        <select className="input" style={{ width: 110 }} value={cfg.device} onChange={(e) => set({ device: e.target.value as TranscriberConfig['device'] })} title="La carte graphique (CUDA) n'est utilisée que si le moteur la prend en charge">
          <option value="auto">Auto</option>
          <option value="cuda">Carte graphique (CUDA)</option>
          <option value="cpu">Processeur</option>
        </select>
        <input className="input" style={{ width: 60 }} value={cfg.language} onChange={(e) => set({ language: e.target.value.trim() || 'fr' })} title="Code de langue" />
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
          {busy ? 'Vérification…' : 'Vérifier'}
        </button>
        {check && <span style={{ color: check.ok ? 'var(--ok, #6c6)' : 'var(--danger)' }}>{check.detail}</span>}
      </div>
      <div className="tiny">
        Fonctionne entièrement hors ligne une fois configuré. Primestone ne télécharge aucun modèle : procurez-vous un modèle Whisper (licence MIT, par ex. « small »
        ≈ 0,5 Go, « medium » ≈ 1,5 Go) et sélectionnez-le ici. Le son ne quitte jamais cet ordinateur. Sans transcription, la synchro se fait phrase par phrase à partir des pauses.
      </div>
    </>
  );
}
