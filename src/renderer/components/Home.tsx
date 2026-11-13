import { useEffect, useState } from 'react';
import type { SequenceSettings } from '../../core';
import type { RecentProject } from '../../shared/api';
import { api } from '../api';
import { newProject, openProject, updateSettings } from '../actions';
import { store, useStore } from '../store';
import { SettingsPanel } from './Settings';

export const SEQUENCE_PRESETS: { id: string; label: string; detail: string; s: Partial<SequenceSettings> }[] = [
  { id: '1080p30', label: 'HD 1080p · 30', detail: '1920×1080 · 30 fps', s: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } } },
  { id: '1080p2997', label: 'HD 1080p · 29.97', detail: '1920×1080 · 29.97 DF', s: { width: 1920, height: 1080, frameRate: { num: 30000, den: 1001 } } },
  { id: '1080p25', label: 'HD 1080p · 25', detail: '1920×1080 · 25 fps', s: { width: 1920, height: 1080, frameRate: { num: 25, den: 1 } } },
  { id: '1080p24', label: 'HD 1080p · 23.976', detail: '1920×1080 · 23.976', s: { width: 1920, height: 1080, frameRate: { num: 24000, den: 1001 } } },
  { id: '2160p30', label: 'UHD 4K · 30', detail: '3840×2160 · 30 fps', s: { width: 3840, height: 2160, frameRate: { num: 30, den: 1 } } },
  { id: 'vertical', label: 'Vertical · 30', detail: '1080×1920 · 30 fps', s: { width: 1080, height: 1920, frameRate: { num: 30, den: 1 } } },
];

export function Home() {
  const settings = useStore((s) => s.settings);
  const overlay = useStore((s) => s.overlay);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [name, setName] = useState('Projet sans titre');
  const [preset, setPreset] = useState('1080p30');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    void api.project.recent().then(setRecent);
    void api.appVersion().then(setVersion);
  }, []);

  const dir = settings?.projectsDir ?? '';

  async function create() {
    setBusy(true);
    await newProject(dir, name, SEQUENCE_PRESETS.find((p) => p.id === preset)!.s);
    setBusy(false);
  }

  return (
    <div className="home">
      <div className="home-left">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <h1>Primestone Motion Studio</h1>
            <small>Local-first video editing · v{version}</small>
          </div>
          <div className="spacer" />
          <button className="btn ghost icon" title="Réglages et diagnostic" onClick={() => store.set({ overlay: 'settings' })}>
            ⚙
          </button>
        </div>

        <div className="card glass">
          <h2>Nouveau projet</h2>
          <label className="field">
            <span>Nom</span>
            <input className="input" data-testid="new-name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Emplacement</span>
            <div className="row">
              <input className="input" style={{ flex: 1 }} value={dir} readOnly data-testid="new-dir" />
              <button
                className="btn"
                onClick={async () => {
                  const d = await api.dialog.chooseFolder('Dossier des projets', dir);
                  if (d) await updateSettings({ projectsDir: d });
                }}
              >
                Parcourir…
              </button>
            </div>
          </label>
          <div className="field">
            <span>Séquence</span>
            <div className="preset-grid">
              {SEQUENCE_PRESETS.map((p) => (
                <div key={p.id} className={`preset ${preset === p.id ? 'on' : ''}`} onClick={() => setPreset(p.id)} data-testid={`preset-${p.id}`}>
                  <b>{p.label}</b>
                  <span>{p.detail}</span>
                </div>
              ))}
            </div>
          </div>
          <button className="btn primary" disabled={busy || !name.trim() || !dir} onClick={create} data-testid="create-project">
            Créer le projet
          </button>
        </div>

        <button
          className="btn"
          data-testid="open-project"
          onClick={async () => {
            const f = await api.dialog.openProject();
            if (f) await openProject(f);
          }}
        >
          Ouvrir un projet…
        </button>
      </div>

      <div className="recent glass">
        <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>Projets récents</h2>
        {recent.length === 0 && <div className="muted">Aucun projet récent. Créez-en un pour commencer.</div>}
        {recent.map((r) => (
          <div
            key={r.file}
            className={`recent-item ${r.exists ? '' : 'missing'}`}
            data-testid="recent-item"
            onClick={() => (r.exists ? void openProject(r.file) : undefined)}
          >
            <div className="ico">{r.name.slice(0, 1).toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{r.name}</div>
              <div className="tiny" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.exists ? r.file : `Missing — ${r.file}`}
              </div>
            </div>
            <div className="tiny">{new Date(r.openedAt).toLocaleDateString()}</div>
            <button
              className="btn ghost icon"
              title="Retirer de la liste"
              onClick={async (e) => {
                e.stopPropagation();
                await api.project.forgetRecent(r.file);
                setRecent(await api.project.recent());
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {overlay === 'settings' && <SettingsPanel />}
    </div>
  );
}
