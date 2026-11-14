import { useEffect, useState } from 'react';
import type { EngineCheck, HardwareReport, TranscriberConfig } from '../../shared/api';
import { api } from '../api';
import { errorText, updateSettings } from '../actions';
import { ask, store, toast, useStore } from '../store';
import type { ModelEntry, ModelStatus } from '../../engine/models';

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
        <OcrSettings />
        <div className="section-title">Matériel (inspection en lecture seule)</div>
        {!hw && !err && <div className="muted">Inspection…</div>}
        {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
        {hw && (
          <dl className="kv" data-testid="hw-report">
            <dt>Système</dt>
            <dd>{hw.platform} · {hw.arch}</dd>
            <dt>Processeur</dt>
            <dd>{hw.cpuModel} · {hw.cpuThreads} cœurs logiques</dd>
            <dt>Mémoire</dt>
            <dd>{(hw.totalMemMB / 1024).toFixed(1)} Go ({(hw.freeMemMB / 1024).toFixed(1)} Go libres)</dd>
            <dt>Carte graphique</dt>
            <dd>{hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramMB ? ` (${g.vramMB} MB)` : ''}`).join(', ') : 'Aucune détectée'}</dd>
            <dt>Encodeurs matériels</dt>
            <dd>{hw.hwEncoders.length ? hw.hwEncoders.join(', ') : 'Aucun vérifié (encodage processeur)'}</dd>
            <dt>FFmpeg</dt>
            <dd title={hw.ffmpeg.path}>{hw.ffmpeg.version ?? 'INTROUVABLE'} ({hw.ffmpeg.source})</dd>
          </dl>
        )}
        <DependencyPanel />
        <div className="actions">
          <button
            className="btn"
            data-testid="save-diagnostics"
            title="Matériel, espace libre et deux courts tests de performance, enregistrés dans un fichier JSON que vous pouvez partager. Rien n'est envoyé."
            onClick={async () => {
              setErr('');
              try {
                const f = await api.system.saveDiagnostics();
                if (f) setErr(`Rapport enregistré : ${f}`);
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
 * Local OCR (optional): Tesseract installed by the user reads the text of comic pages (balloons,
 * captions) so matching can rely on what the page says, not only on its file name. Off by default;
 * Primestone never installs Tesseract nor downloads its language data.
 */
function OcrSettings() {
  const settings = useStore((s) => s.settings)!;
  const cfg = settings.ocr ?? { enabled: false, languages: 'fra+eng' };
  const [check, setCheck] = useState<Awaited<ReturnType<typeof api.ocr.check>> | null>(null);
  const set = (patch: Partial<typeof cfg>) => void updateSettings({ ocr: { ...cfg, ...patch } });
  return (
    <div data-testid="ocr-settings">
      <div className="section-title">OCR local (texte des bulles et des cases)</div>
      <div className="tiny">
        Facultatif. Utilise Tesseract (licence Apache-2.0) s’il est installé sur cet ordinateur ; rien n’est téléchargé ni envoyé. Le lettrage des comics (majuscules,
        onomatopées) est souvent mal lu : la confiance est affichée et une lecture douteuse ne suffit jamais à choisir une image.
      </div>
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="ocr-enabled" />
        Lire le texte des images lors de l’indexation des médias
      </label>
      <div className="insp-row">
        <label>Langues</label>
        <input className="input" value={cfg.languages ?? 'fra+eng'} onChange={(e) => set({ languages: e.target.value })} aria-label="Langues Tesseract" />
        <span />
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="tiny" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={cfg.path}>{cfg.path || 'Recherche automatique (PATH, Program Files)'}</span>
        <button className="btn ghost" onClick={async () => { const p = await api.ocr.pick(); if (p) set({ path: p }); }}>Choisir…</button>
        <button className="btn" data-testid="ocr-check" onClick={async () => setCheck(await api.ocr.check(cfg))}>Vérifier</button>
      </div>
      {check && <div className="tiny" data-testid="ocr-status" style={{ color: check.ok ? 'var(--ok)' : 'var(--warn, #e0a800)' }}>{check.message}{check.languages.length ? ` · langues installées : ${check.languages.join(', ')}` : ''}</div>}
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
      <div className="section-title">Transcription locale (synchro mot à mot, mode sans script)</div>
      <ModelManager />
      <details>
        <summary className="tiny">Réglages avancés (autre moteur, modèle personnalisé)</summary>
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
      </details>
    </>
  );
}

const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1).replace('.', ',')} Go` : `${Math.round(b / (1 << 20))} Mo`);

/**
 * Built-in transcription: the whisper.cpp engine ships with Primestone; a model is downloaded only when
 * the user asks for it (size, source and licence confirmed first), then checked (SHA-1) before use.
 */
function ModelManager() {
  const settings = useStore((s) => s.settings)!;
  const tasks = useStore((s) => s.tasks);
  const [info, setInfo] = useState<{ catalog: ModelEntry[]; status: ModelStatus[]; dir: string; bundledEngine: boolean } | null>(null);
  const [taskOf, setTaskOf] = useState<Record<string, string>>({});
  // the main process records the model in the settings: reload both
  const refresh = () => void Promise.all([api.models.list().then(setInfo), api.settings.get().then((st) => store.set({ settings: st }))]);
  useEffect(refresh, []);
  // refresh when a download task ends
  const finished = Object.values(taskOf).map((id) => tasks[id]?.state).join(',');
  useEffect(() => {
    if (/done|failed|cancelled/.test(finished)) refresh();
  }, [finished]);
  if (!info) return <div className="tiny">Chargement…</div>;
  const current = settings.transcriber.backend === 'whisper.cpp' ? settings.transcriber.modelPath : undefined;
  return (
    <div data-testid="model-manager">
      <div className="tiny" style={{ marginBottom: 6 }}>
        {info.bundledEngine
          ? 'Moteur intégré : whisper.cpp (licence MIT), inclus dans Primestone — rien à installer. Choisissez un modèle de reconnaissance :'
          : 'Moteur whisper.cpp introuvable dans cette installation : réinstallez Primestone ou utilisez les réglages avancés.'}
      </div>
      {info.catalog.map((m) => {
        const st = info.status.find((x) => x.id === m.id)!;
        const t = taskOf[m.id] ? tasks[taskOf[m.id]!] : undefined;
        const running = t && (t.state === 'running' || t.state === 'queued');
        const inUse = !!current && st.verified && current === st.path;
        return (
          <div key={m.id} className="row" style={{ gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line, #222)' }} data-testid={`model-${m.id}`}>
            <div style={{ flex: 1 }}>
              <b>{m.label}</b> <span className="tiny">· {size(m.sizeBytes)}</span>
              <div className="tiny">{m.note}</div>
              {running && (
                <div className="progress" style={{ marginTop: 4 }}>
                  <div style={{ width: `${Math.round((t!.progress ?? 0) * 100)}%` }} />
                </div>
              )}
              {running && <div className="tiny">{t!.message ?? 'Démarrage…'}</div>}
              {t?.state === 'failed' && <div className="tiny" style={{ color: 'var(--danger)' }}>{t.error}</div>}
            </div>
            {st.verified ? (
              <>
                <span className="tiny" style={{ color: 'var(--ok, #6c6)' }}>{inUse ? '✓ utilisé' : '✓ installé et vérifié'}</span>
                {!inUse && (
                  <button className="btn ghost" onClick={async () => (await api.models.use(m.id), refresh())}>
                    Utiliser
                  </button>
                )}
                <button
                  className="btn ghost"
                  onClick={async () => {
                    if ((await ask('Supprimer le modèle ?', `${m.label} (${size(m.sizeBytes)}) sera supprimé de cet ordinateur. Vous pourrez le retélécharger.`, [{ label: 'Annuler', value: 'no' }, { label: 'Supprimer', value: 'yes', kind: 'danger' }])) === 'yes') {
                      await api.models.remove(m.id);
                      refresh();
                    }
                  }}
                >
                  Supprimer
                </button>
              </>
            ) : running ? (
              <button className="btn ghost" onClick={() => void api.tasks.cancel(taskOf[m.id]!)}>
                Mettre en pause
              </button>
            ) : (
              <>
                <button
                  className="btn"
                  data-testid={`model-download-${m.id}`}
                  onClick={async () => {
                    const ok = await ask(
                      'Télécharger ce modèle ?',
                      `${m.label} — ${size(m.sizeBytes)}${st.partialBytes ? ` (${size(st.partialBytes)} déjà reçus, le téléchargement reprendra)` : ''}.\n\nSource : ${m.source}\nLicence : ${m.license}\n\nLe fichier est vérifié (SHA-1) avant d’être utilisé. Vos fichiers audio ne sont jamais envoyés : seule cette requête de téléchargement passe par Internet.`,
                      [{ label: 'Annuler', value: 'no' }, { label: `Télécharger ${size(m.sizeBytes)}`, value: 'yes', kind: 'primary' }],
                    );
                    if (ok !== 'yes') return;
                    try {
                      const { taskId } = await api.models.download(m.id);
                      setTaskOf((x) => ({ ...x, [m.id]: taskId }));
                    } catch (e) {
                      toast(`Téléchargement impossible : ${errorText(e)}`, 'error');
                    }
                  }}
                >
                  {st.partialBytes ? 'Reprendre' : 'Télécharger'} ({size(m.sizeBytes)})
                </button>
                <button className="btn ghost" title="Vous avez déjà ce fichier (ggml) : il est vérifié puis copié" onClick={async () => {
                  try {
                    if (await api.models.importFile(m.id)) refresh();
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                }}>
                  J’ai déjà le fichier…
                </button>
              </>
            )}
          </div>
        );
      })}
      <div className="tiny" style={{ marginTop: 6 }}>
        Rien n’est téléchargé sans votre accord. Une fois le modèle installé, tout fonctionne hors ligne et le son ne quitte jamais cet ordinateur. Dossier : {info.dir}
      </div>
    </div>
  );
}

/** Failing dependencies and recent problems from the technical log (read-only). */
function DependencyPanel() {
  const [deps, setDeps] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null);
  const [probs, setProbs] = useState<{ t: string; level: string; cat: string; msg: string }[]>([]);
  useEffect(() => {
    void api.system.dependencies().then(setDeps).catch(() => setDeps([]));
    void api.system.recentProblems().then(setProbs).catch(() => setProbs([]));
  }, []);
  return (
    <section data-testid="dependencies">
      <div className="section-title">Dépendances et journal</div>
      {!deps ? (
        <p className="muted">Vérification…</p>
      ) : (
        <ul className="deps">
          {deps.map((d) => (
            <li key={d.name} className={d.ok ? 'ok' : 'bad'}>
              {d.ok ? '✓' : '✗'} <b>{d.name}</b> — {d.detail}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {probs.length ? `${probs.length} avertissement(s) ou erreur(s) sur 7 jours, dernier : ${probs[probs.length - 1]!.msg}` : 'Aucune erreur enregistrée sur 7 jours.'}{' '}
        <button className="btn small" data-testid="open-logs" onClick={() => void api.system.openLogs()}>
          Ouvrir le dossier des journaux
        </button>
      </p>
    </section>
  );
}
