import { useEffect, useRef, useState } from 'react';
import { applyCommand } from '../../production/commands';
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
  const [vocabulary, setVocabulary] = useState(saved?.vocabulary ?? '');
  const [inspired, setInspired] = useState<{ summary: string[]; changes: string[]; prefs: ProductionPreferences; name: string } | null>(null);
  const [inspiring, setInspiring] = useState(false);
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
            <CommandBox prefs={prefs} onApply={(p) => setPrefs(p)} />
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
              <select className="input" value={music} onChange={(e) => setMusic(e.target.value)} data-testid="music-select">
                <option value="">{prefs.musicFromLibrary ? 'Automatique : une piste par partie, depuis votre bibliothèque musicale' : 'Aucune'}</option>
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
              <label className="row" style={{ gap: 6, marginTop: 6 }}>
                <input type="checkbox" data-testid="web-images" checked={prefs.webImages} onChange={(e) => set('webImages', e.target.checked)} />
                Chercher aussi des images libres de droits sur Internet
              </label>
              <span className="tiny">
                Désactivé par défaut. Si vous cochez : seuls les mots-clés (vos [VISUEL: …], noms propres et titres de section) sont envoyés à Openverse et Wikimedia Commons ; aucun fichier, aucune voix, aucun compte. Seules les licences CC0, domaine public, CC BY et CC BY-SA sont gardées ; les crédits sont enregistrés et joints à l'export. Les planches de comics sous droits restent vos propres fichiers.
              </span>
            </div>
            <label className="field">
              <span>Noms propres de la vidéo (facultatif, séparés par des virgules)</span>
              <input className="input" data-testid="vocabulary" value={vocabulary} onChange={(e) => setVocabulary(e.target.value)} placeholder="Ex. : Apocalypse, En Sabah Nur, Archangel" />
              <span className="tiny">Guident la transcription locale et corrigent les noms mal reconnus (chaque correction est listée dans le rapport).</span>
            </label>
            <label className="field">
              <span>Pages de comics (CBZ, PDF, dossier de pages numérotées)</span>
              <select className="input" data-testid="story-order" value={prefs.storyOrder ?? 'auto'} onChange={(e) => set('storyOrder', e.target.value as ProductionPreferences['storyOrder'])}>
                <option value="auto">Automatique : suivre l’ordre du livre quand vos images sont surtout ses pages</option>
                <option value="on">Toujours suivre l’ordre des pages au fil de la narration</option>
                <option value="off">Choisir chaque image selon le passage (noms, étiquettes, texte lu)</option>
              </select>
              <span className="tiny">Mode histoire : les pages défilent dans l’ordre, lues case par case, calées sur votre voix. Écrivez [VISUEL: page 12] pour imposer une page à un passage.</span>
            </label>
            <div className="field" data-testid="inspire">
              <span>S’inspirer d’une vidéo</span>
              <button className="btn" disabled={inspiring} data-testid="inspire-open" onClick={async () => {
                setInspiring(true);
                try {
                  const r = await api.production.inspire(prefs);
                  if (r) setInspired({ summary: r.profile.summary, changes: r.changes, prefs: r.prefs, name: r.profile.file.split(/[\\/]/).pop() ?? '' });
                } catch (e) {
                  toast(errorText(e), 'error');
                } finally {
                  setInspiring(false);
                }
              }}>
                {inspiring ? 'Analyse en cours…' : 'Analyser une vidéo de référence…'}
              </button>
              <span className="tiny">Choisissez une vidéo enregistrée sur cet ordinateur : ses coupes, la durée de ses plans, ses mouvements et son volume sont mesurés ici, puis proposés comme réglages. Rien n’est envoyé.</span>
              {inspired && (
                <div className="live-view" data-testid="inspire-result">
                  <div className="section-title" style={{ marginTop: 0 }}>Style de « {inspired.name} »</div>
                  {inspired.summary.map((l, i) => <div key={i} className="tiny">{l}</div>)}
                  {inspired.changes.length ? (
                    <div className="row" style={{ gap: 8, marginTop: 6 }}>
                      <button className="btn primary" data-testid="inspire-apply" onClick={() => {
                        setPrefs(inspired.prefs);
                        toast(`Réglages repris : ${inspired.changes.join(' · ')}`, 'info');
                        setInspired(null);
                      }}>Appliquer ce style</button>
                      <span className="tiny">{inspired.changes.join(' · ')}</span>
                    </div>
                  ) : <div className="tiny">Vos réglages correspondent déjà à ce style.</div>}
                </div>
              )}
            </div>
            <label className="field">
              <span>Traitement de la voix</span>
              <select className="input" data-testid="voice-style" value={prefs.voiceStyle ?? 'radio'} onChange={(e) => set('voiceStyle', e.target.value as ProductionPreferences['voiceStyle'])}>
                <option value="radio">Voix radio : nettoyée, chaude, présente, niveau constant</option>
                <option value="natural">Naturelle : seulement les corrections (bruit, ronflement, volume)</option>
              </select>
              <span className="tiny">Chaque traitement est choisi d’après les mesures de votre enregistrement et listé dans le rapport. Votre fichier d’origine n’est jamais modifié.</span>
            </label>
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
                  ['musicFromLibrary', 'Musique par section depuis ma bibliothèque musicale'],
                  ['keepUnchanged', 'En régénérant, garder les plans des passages inchangés'],
                  ['fillUnrelated', 'Remplir avec des images sans rapport avec le passage (déconseillé)'],
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
        {task?.live && <LiveView live={task.live} />}
        {task && (
          <div className="task" data-testid="production-progress">
            <div className="row">
              <span style={{ flex: 1 }}>{task.message ?? 'Démarrage…'}</span>
              <span className={`pill ${task.state}`}>{({ queued: 'en attente', running: 'en cours', verifying: 'vérification', done: 'terminé', failed: 'échec', cancelled: 'annulé' } as Record<string, string>)[task.state] ?? task.state}</span>
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
            {prefs.webImages ? 'Tout se fait sur cet ordinateur, sauf la recherche d\'images libres que vous avez activée (mots-clés seulement). Chaque' : 'Tout se fait sur cet ordinateur. Rien n\'est envoyé. Chaque'} génération crée une nouvelle version ; vos retouches restent intactes, et vos décisions verrouillées ou acceptées sont reprises.
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
              const ok = await runProduction({ script, narrationMediaId: narration, musicMediaId: music || null, mediaFolders: folders, vocabulary, narrationKind: kind, ...(format ? { format } : {}) }, prefs);
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

/** Live view while the edit is being built: current stage, latest rendered picture, storyboard filling up. */
function LiveView({ live }: { live: NonNullable<import('../../shared/api').TaskInfo['live']> }) {
  const url = (f: string) => `pmedia://local/${encodeURIComponent(f)}`;
  const board = live.board ?? [];
  const ready = board.filter((b) => b.thumb).length;
  return (
    <div className="live-view" data-testid="production-live">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="live-latest">{live.latest ? <img src={url(live.latest)} alt="Dernier rendu" /> : <span className="tiny muted">En attente du premier rendu…</span>}</div>
        <div style={{ flex: 1 }}>
          <div className="section-title" style={{ marginTop: 0 }}>En direct : {live.stage}</div>
          {live.detail && <div className="tiny">{live.detail}</div>}
          {board.length > 0 && (
            <div className="tiny">
              Storyboard : {board.length} plans · {ready} prêts · {board.filter((b) => b.kind === 'missing').length} sans visuel
            </div>
          )}
        </div>
      </div>
      {board.length > 0 && (
        <div className="live-board" data-testid="production-board">
          {board.map((b, i) => (
            <div key={i} className={`live-shot ${b.kind}`} title={`${b.start.toFixed(1)}–${b.end.toFixed(1)} s · ${b.label}\n${b.text}`}>
              {b.thumb ? <img src={url(b.thumb)} alt={b.label} loading="lazy" /> : <div className="live-pending">{b.kind === 'missing' ? 'manquant' : '…'}</div>}
              <span>{b.start.toFixed(0)} s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Edit instructions in plain French, typed or spoken (recorded here, transcribed by the local model):
 * the changes are listed, then applied to the settings; "Générer" makes the new version.
 */
function CommandBox({ prefs, onApply }: { prefs: ProductionPreferences; onApply: (p: ProductionPreferences) => void }) {
  const [text, setText] = useState('');
  const [rec, setRec] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [last, setLast] = useState<{ changes: string[]; unknown: string[] } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const apply = async () => {
    const r = applyCommand(text, prefs);
    setLast({ changes: r.changes, unknown: r.unknown });
    if (r.placement) {
      const st = await api.settings.get();
      await api.settings.set({ pcore: { ...st.pcore, placement: { ...st.pcore?.placement, ...r.placement } } });
    }
    if (r.changes.length) {
      onApply(r.prefs);
      toast(`Compris : ${r.changes.join(' · ')}. Cliquez sur « Générer la vidéo » pour la nouvelle version.`, 'info');
    }
  };
  const record = async () => {
    if (rec === 'recording') return recorder.current?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      recorder.current = mr;
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec('transcribing');
        try {
          const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
          const said = await api.production.transcribeCommand(buf);
          setText((t) => (t ? `${t}. ${said}` : said));
        } catch (e) {
          toast(errorText(e), 'error');
        } finally {
          setRec('idle');
        }
      };
      mr.start();
      setRec('recording');
    } catch (e) {
      toast(`Micro indisponible : ${errorText(e)}`, 'error');
    }
  };
  return (
    <div className="field" data-testid="command-box">
      <span>Retouches en français (texte ou voix)</span>
      <textarea className="input" data-testid="command-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex. : plans plus courts, baisse la musique de 3 dB, logo en haut à gauche, voix radio" />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" data-testid="command-mic" disabled={rec === 'transcribing'} onClick={record}>
          {rec === 'recording' ? '■ Arrêter' : rec === 'transcribing' ? 'Transcription…' : '🎤 Dicter'}
        </button>
        <button className="btn primary" data-testid="command-apply" disabled={!text.trim()} onClick={apply}>
          Appliquer
        </button>
      </div>
      {last && (
        <div className="tiny" data-testid="command-result">
          {last.changes.length ? `Appliqué : ${last.changes.join(' · ')}` : 'Rien n’a été changé.'}
          {last.unknown.length ? ` — Pas compris : « ${last.unknown.join(' », « ')} » (reformulez : plans, cases, musique, voix, sous-titres, titres, noms, logo, mouvement, fondus, pauses, hésitations…)` : ''}
        </div>
      )}
      <span className="tiny">La voix est transcrite sur cet ordinateur. Chaque changement est listé ; rien n’est deviné.</span>
    </div>
  );
}
