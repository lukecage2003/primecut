import { useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, type ProductionPreferences } from '../../production/preferences';
import { parseScript } from '../../production/script';
import { NARRATION_KINDS, type NarrationKind } from '../../production/narrationFormat';
import type { OutputFormat, PreferencesState } from '../../shared/api';
import { api } from '../api';
import { errorText, importPaths, runProduction, savedProductionInputs } from '../actions';
import { store, toast, useEditor, useStore } from '../store';

export function ProductionPanel() {
  const media = useEditor((e) => e.history.present.media);
  const taskId = useEditor((e) => e.productionTask);
  const task = useStore((s) => (taskId ? s.tasks[taskId] : undefined));
  const transcriberOn = useStore((s) => !!s.settings?.transcriber?.enabled);
  const saved = savedProductionInputs();
  const [script, setScript] = useState(saved?.script ?? '');
  const [narration, setNarration] = useState(saved?.narrationMediaId ?? '');
  const [music, setMusic] = useState<string>(saved?.musicMediaId ?? '');
  const [format, setFormat] = useState<OutputFormat | ''>('');
  const [kind, setKind] = useState<NarrationKind | 'auto'>(saved?.narrationKind ?? 'auto');
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
          <h2 style={{ flex: 1 }}>Script → Vidéo</h2>
          <span className="tiny">Préférences v{prefsState?.current.version ?? 1}</span>
        </div>
        <div className="prod-grid">
          <div className="field" style={{ minHeight: 0 }}>
            <span>
              Script ({parsed.sentences.length} phrases · {parsed.sections.length} sections)
              <button className="btn ghost" style={{ height: 22, marginLeft: 8 }} onClick={async () => {
                try {
                  const f = await api.production.readTextFile();
                  if (f) {
                    setScript(f.text);
                    toast(`Script importé${f.sections ? ` · ${f.sections} sections` : ''}${f.repairs ? ` · ${f.repairs} mots collés réparés` : ''}`, 'info');
                  }
                } catch (e) {
                  toast(errorText(e), 'error');
                }
              }}>
                Charger un script (PDF, .txt, .md)…
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
              <span>Narration (votre voix enregistrée)</span>
              <div className="row">
                <select className="input" style={{ flex: 1 }} value={narration} onChange={(e) => setNarration(e.target.value)} data-testid="narration-select">
                  <option value="">— choisir —</option>
                  {audio.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.probe.durationSec.toFixed(1)} s)
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={async () => importPaths(await api.dialog.importMedia())}>
                  Importer…
                </button>
              </div>
            </label>
            <label className="field">
              <span>Musique de fond (facultative)</span>
              <select className="input" value={music} onChange={(e) => setMusic(e.target.value)}>
                <option value="">Aucune</option>
                {audio.filter((m) => m.id !== narration).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Dossiers de médias (images, couvertures, planches, vidéos)</span>
              {folders.map((f) => (
                <div key={f} className="row tiny" style={{ gap: 4 }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f}</span>
                  <button className="btn ghost icon" style={{ height: 20, width: 20 }} onClick={() => setFolders(folders.filter((x) => x !== f))}>✕</button>
                </div>
              ))}
              <button className="btn" data-testid="add-folder" onClick={async () => setFolders([...new Set([...folders, ...(await api.production.chooseFolders())])])}>
                + Ajouter un dossier
              </button>
              <span className="tiny">Les médias déjà dans le projet sont aussi utilisés. Étiquettes : noms de dossiers, noms de fichiers ou fichier « nom.tags.txt ».</span>
            </div>
            <div className="section-title">Réalisation</div>
            <div className="insp-row">
              <label>Durée des plans</label>
              <input type="range" min={1.5} max={10} step={0.25} value={prefs.shotTarget} onChange={(e) => {
                const v = Number(e.target.value);
                setPrefs((p) => ({ ...p, shotTarget: v, shotMin: Math.min(p.shotMin, v * 0.6), shotMax: Math.max(v * 1.6, v + 1) }));
              }} />
              <span className="val">{prefs.shotTarget.toFixed(1)} s</span>
            </div>
            <div className="insp-row">
              <label>Mouvement</label>
              <input type="range" min={0} max={0.35} step={0.01} value={prefs.motionAmount} onChange={(e) => set('motionAmount', Number(e.target.value))} />
              <span className="val">{Math.round(prefs.motionAmount * 100)}%</span>
            </div>
            <div className="insp-row">
              <label>Type de narration</label>
              <select className="input" data-testid="narration-kind" value={kind} onChange={(e) => setKind(e.target.value as NarrationKind | 'auto')} title="Détecté automatiquement depuis le script ou la narration ; la réalisation (rythme, cartes, transitions) s’y adapte">
                <option value="auto">Détection automatique</option>
                {(Object.keys(NARRATION_KINDS) as NarrationKind[]).map((k) => (
                  <option key={k} value={k}>
                    {NARRATION_KINDS[k]}
                  </option>
                ))}
              </select>
              <span />
            </div>
            <div className="insp-row">
              <label>Format</label>
              <select className="input" data-testid="format-select" value={format} onChange={(e) => setFormat(e.target.value as OutputFormat | '')} title="Chaque format est une nouvelle version recomposée pour ce cadre (cadrages, mises en page, sous-titres, placement de P-CORE)">
                <option value="">Format du projet</option>
                <option value="16:9">16:9 · YouTube</option>
                <option value="9:16">9:16 · Shorts / TikTok / Reels</option>
                <option value="1:1">1:1 · carré</option>
                <option value="4:5">4:5 · portrait (fil)</option>
              </select>
              <span />
            </div>
            <div className="insp-row">
              <label>Style visuel</label>
              <select className="input" value={prefs.visualStyle} onChange={(e) => set('visualStyle', e.target.value as never)}>
                <option value="gold">Or Primestone</option>
                <option value="hologram">Hologramme</option>
                <option value="crimson">Pourpre</option>
              </select>
              <span />
            </div>
            <div className="insp-row">
              <label>Niveau de la musique</label>
              <input type="range" min={-35} max={-8} step={1} value={prefs.musicRelativeDb} onChange={(e) => set('musicRelativeDb', Number(e.target.value))} />
              <span className="val">{prefs.musicRelativeDb} dB</span>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              {(
                [
                  ['subtitles', 'Sous-titres'],
                  ['sectionTitles', 'Titres de section'],
                  ['lowerThirds', 'Noms à l’écran'],
                  ['proceduralVisuals', 'Animations quand il n’y a pas d’image'],
                  ['panelReading', 'Lire les planches case par case'],
                  ['voiceCleanup', 'Nettoyer la voix (bruit, ronflement, volume)'],
                  ['sfx', 'Effets sonores'],
                  ['autoDirection', 'Adapter la réalisation au type de narration'],
                  ['tightenPauses', 'Resserrer les longues pauses'],
                  ['cutDisfluencies', 'Couper les « euh » et les répétitions'],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={prefs[k]} onChange={(e) => set(k, e.target.checked)} />
                  {l}
                </label>
              ))}
            </div>
            {prefsState && prefsState.history.length > 1 && (
              <details data-testid="prefs-history">
                <summary className="tiny">Historique des préférences (v{prefs.version}) — ce qui a été appris, et retour à une version antérieure</summary>
                {[...prefsState.history].reverse().slice(0, 8).map((h) => (
                  <div key={h.version} className="row tiny" style={{ gap: 8 }}>
                    <span style={{ flex: 1 }}>
                      v{h.version} · {new Date(h.at).toLocaleString()} · {h.changes.join(' · ') || 'initiale'}
                    </span>
                    {h.version !== prefsState.current.version && (
                      <button
                        className="btn ghost"
                        style={{ height: 20, padding: '0 6px', fontSize: 11 }}
                        onClick={async () => {
                          const st = await api.production.revertPreferences(h.version);
                          setPrefsState(st);
                          setPrefs(st.current);
                        }}
                      >
                        Restaurer
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
          </div>
        </div>
        {task && (
          <div className="task" data-testid="production-progress">
            <div className="row">
              <span style={{ flex: 1 }}>{task.message ?? 'Démarrage…'}</span>
              <span className={`pill ${task.state}`}>{task.state}</span>
            </div>
            <div className="progress">
              <div style={{ width: `${Math.round(task.progress * 100)}%` }} />
            </div>
          </div>
        )}
        {parsed.sentences.length === 0 && (
          <div className="tiny" data-testid="no-script-hint" style={{ padding: '0 0 8px' }}>
            {transcriberOn
              ? 'Pas de script : la narration sera transcrite sur cet ordinateur et servira de script (phrases, paragraphes, sections et prises ratées détectés automatiquement).'
              : 'Pas de script : collez ou chargez votre script, ou activez la transcription locale (⚙ Réglages → Transcription locale) pour que la narration serve de script.'}
          </div>
        )}
        <div className="actions">
          <span className="tiny" style={{ flex: 1 }}>
            Tout se fait sur cet ordinateur. Rien n'est envoyé. Chaque génération crée une nouvelle version ; vos retouches restent intactes.
          </span>
          <button className="btn" onClick={close} disabled={busy}>
            Annuler
          </button>
          <button
            className="btn primary"
            data-testid="generate"
            disabled={busy || !narration || (parsed.sentences.length === 0 && !transcriberOn)}
            onClick={async () => {
              if (JSON.stringify(prefs) !== JSON.stringify(prefsState?.current)) setPrefsState(await api.production.setPreferences(prefs, 'adjusted in the production panel'));
              const ok = await runProduction({ script, narrationMediaId: narration, musicMediaId: music || null, mediaFolders: folders, narrationKind: kind, ...(format ? { format } : {}) }, prefs);
              if (ok) store.set({ overlay: null });
            }}
          >
            {busy ? 'Génération…' : 'Générer la vidéo'}
          </button>
        </div>
      </div>
    </div>
  );
}
