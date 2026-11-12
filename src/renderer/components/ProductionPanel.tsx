import { useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, type ProductionPreferences } from '../../production/preferences';
import { parseScript } from '../../production/script';
import type { PreferencesState } from '../../shared/api';
import { api } from '../api';
import { errorText, importPaths, runProduction, savedProductionInputs } from '../actions';
import { store, toast, useEditor, useStore } from '../store';

export function ProductionPanel() {
  const media = useEditor((e) => e.history.present.media);
  const taskId = useEditor((e) => e.productionTask);
  const task = useStore((s) => (taskId ? s.tasks[taskId] : undefined));
  const saved = savedProductionInputs();
  const [script, setScript] = useState(saved?.script ?? '');
  const [narration, setNarration] = useState(saved?.narrationMediaId ?? '');
  const [music, setMusic] = useState<string>(saved?.musicMediaId ?? '');
  const [folders, setFolders] = useState<string[]>(saved?.mediaFolders ?? []);
  const [prefsState, setPrefsState] = useState<PreferencesState | null>(null);
  const [prefs, setPrefs] = useState<ProductionPreferences>(DEFAULT_PREFERENCES);
  const audio = Object.values(media).filter((m) => m.probe.audio && !m.probe.video);
  const parsed = parseScript(script);

  useEffect(() => {
    void api.production.preferences().then((s) => {
      setPrefsState(s);
      setPrefs(s.current);
    });
  }, []);
  useEffect(() => {
    if (!narration && audio[0]) setNarration(audio[0].id);
  }, [audio.length]);

  const busy = !!taskId;
  const close = () => !busy && store.set({ overlay: null });
  const set = <K extends keyof ProductionPreferences>(k: K, v: ProductionPreferences[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal glass production" data-testid="production-panel">
        <div className="row">
          <h2 style={{ flex: 1 }}>Script-to-Video</h2>
          <span className="tiny">Preferences v{prefsState?.current.version ?? 1}</span>
        </div>
        <div className="prod-grid">
          <div className="field" style={{ minHeight: 0 }}>
            <span>
              Script ({parsed.sentences.length} sentences · {parsed.sections.length} sections)
              <button className="btn ghost" style={{ height: 22, marginLeft: 8 }} onClick={async () => {
                try {
                  const f = await api.production.readTextFile();
                  if (f) {
                    setScript(f.text);
                    toast(`Script imported${f.sections ? ` · ${f.sections} sections` : ''}${f.repairs ? ` · ${f.repairs} glued words repaired` : ''}`, 'info');
                  }
                } catch (e) {
                  toast(errorText(e), 'error');
                }
              }}>
                Load script (PDF, .txt, .md)…
              </button>
            </span>
            <textarea
              className="input script"
              data-testid="script-input"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={'# Titre de section\n\nVotre narration, phrase par phrase…\n[VISUEL: couverture Amazing Spider-Man 14] indique l’image voulue pour la phrase suivante.\n[TITRE: …] titre à l’écran · [PAUSE] coupure · [NOTE: …] note ignorée'}
            />
          </div>
          <div className="prod-side">
            <label className="field">
              <span>Narration (your recorded voice)</span>
              <div className="row">
                <select className="input" style={{ flex: 1 }} value={narration} onChange={(e) => setNarration(e.target.value)} data-testid="narration-select">
                  <option value="">— choose —</option>
                  {audio.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.probe.durationSec.toFixed(1)} s)
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={async () => importPaths(await api.dialog.importMedia())}>
                  Import…
                </button>
              </div>
            </label>
            <label className="field">
              <span>Music bed (optional)</span>
              <select className="input" value={music} onChange={(e) => setMusic(e.target.value)}>
                <option value="">None</option>
                {audio.filter((m) => m.id !== narration).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Media folders (images, covers, panels, videos)</span>
              {folders.map((f) => (
                <div key={f} className="row tiny" style={{ gap: 4 }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f}</span>
                  <button className="btn ghost icon" style={{ height: 20, width: 20 }} onClick={() => setFolders(folders.filter((x) => x !== f))}>✕</button>
                </div>
              ))}
              <button className="btn" data-testid="add-folder" onClick={async () => setFolders([...new Set([...folders, ...(await api.production.chooseFolders())])])}>
                + Add folder
              </button>
              <span className="tiny">Media already in the project are used too. Tags: folder names, file names, or a sidecar “name.tags.txt”.</span>
            </div>
            <div className="section-title">Direction</div>
            <div className="insp-row">
              <label>Shot length</label>
              <input type="range" min={1.5} max={10} step={0.25} value={prefs.shotTarget} onChange={(e) => {
                const v = Number(e.target.value);
                setPrefs((p) => ({ ...p, shotTarget: v, shotMin: Math.min(p.shotMin, v * 0.6), shotMax: Math.max(v * 1.6, v + 1) }));
              }} />
              <span className="val">{prefs.shotTarget.toFixed(1)} s</span>
            </div>
            <div className="insp-row">
              <label>Motion</label>
              <input type="range" min={0} max={0.35} step={0.01} value={prefs.motionAmount} onChange={(e) => set('motionAmount', Number(e.target.value))} />
              <span className="val">{Math.round(prefs.motionAmount * 100)}%</span>
            </div>
            <div className="insp-row">
              <label>Visual style</label>
              <select className="input" value={prefs.visualStyle} onChange={(e) => set('visualStyle', e.target.value as never)}>
                <option value="gold">Primestone gold</option>
                <option value="hologram">Hologram</option>
                <option value="crimson">Crimson</option>
              </select>
              <span />
            </div>
            <div className="insp-row">
              <label>Music level</label>
              <input type="range" min={-35} max={-8} step={1} value={prefs.musicRelativeDb} onChange={(e) => set('musicRelativeDb', Number(e.target.value))} />
              <span className="val">{prefs.musicRelativeDb} dB</span>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              {(
                [
                  ['subtitles', 'Subtitles'],
                  ['sectionTitles', 'Section titles'],
                  ['lowerThirds', 'Name tags'],
                  ['proceduralVisuals', 'Motion design when no image'],
                  ['panelReading', 'Read pages panel by panel'],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={prefs[k]} onChange={(e) => set(k, e.target.checked)} />
                  {l}
                </label>
              ))}
            </div>
          </div>
        </div>
        {task && (
          <div className="task" data-testid="production-progress">
            <div className="row">
              <span style={{ flex: 1 }}>{task.message ?? 'Starting…'}</span>
              <span className={`pill ${task.state}`}>{task.state}</span>
            </div>
            <div className="progress">
              <div style={{ width: `${Math.round(task.progress * 100)}%` }} />
            </div>
          </div>
        )}
        <div className="actions">
          <span className="tiny" style={{ flex: 1 }}>
            Runs fully on this computer. Nothing is uploaded. Each generation is a new sequence version; your edits stay intact.
          </span>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="generate"
            disabled={busy || !narration || parsed.sentences.length === 0}
            onClick={async () => {
              if (JSON.stringify(prefs) !== JSON.stringify(prefsState?.current)) setPrefsState(await api.production.setPreferences(prefs, 'adjusted in the production panel'));
              const ok = await runProduction({ script, narrationMediaId: narration, musicMediaId: music || null, mediaFolders: folders }, prefs);
              if (ok) store.set({ overlay: null });
            }}
          >
            {busy ? 'Generating…' : 'Generate video'}
          </button>
        </div>
      </div>
    </div>
  );
}
