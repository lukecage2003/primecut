import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl, type MusicTrackView } from '../../shared/api';
import { MOODS } from '../../production/music';
import { api } from '../api';
import { errorText } from '../actions';
import { store, toast, useStore } from '../store';

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Music library: the user's own files, analysed locally (never modified), with licences as declared. */
export function MusicLibrary() {
  const [data, setData] = useState<{ dirs: string[]; updatedAt: string | null; tracks: MusicTrackView[] } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const task = useStore((s) => (taskId ? s.tasks[taskId] : undefined));
  const reload = useCallback(() => void api.music.list().then(setData, (e) => toast(errorText(e), 'error')), []);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (task && ['done', 'failed', 'cancelled'].includes(task.state)) {
      reload();
      if (task.state === 'failed') toast(`Analyse musicale : ${task.error}`, 'error');
      setTaskId(null);
    }
  }, [task?.state]);
  useEffect(() => () => audio.current?.pause(), []);

  const scan = async () => setTaskId((await api.music.scan()).taskId);
  const play = (t: MusicTrackView) => {
    if (!audio.current) audio.current = new Audio();
    if (playing === t.id) {
      audio.current.pause();
      setPlaying(null);
      return;
    }
    audio.current.src = mediaUrl(t.path);
    audio.current.currentTime = Math.min(30, t.format.durationSec / 3);
    void audio.current.play();
    setPlaying(t.id);
  };
  const tracks = (data?.tracks ?? []).filter((t) => !filter || `${t.title} ${t.artist ?? ''} ${t.moods.join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  const unknown = (data?.tracks ?? []).filter((t) => !t.missing && t.licence.status === 'inconnue').length;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && store.set({ overlay: null })}>
      <div className="modal glass music-lib" data-testid="music-library">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2>Bibliothèque musicale</h2>
          <span className="muted">{data?.tracks.length ?? 0} piste(s){unknown ? ` · ${unknown} licence(s) inconnue(s)` : ''}</span>
        </div>
        <p className="muted small">
          Vos propres fichiers, analysés sur cet ordinateur (FFmpeg) : rien n’est envoyé, rien n’est modifié. Tempo, énergie et ambiance sont des
          <b> estimations par règles</b>, expliquées et corrigeables ; la licence est celle que déclarent les fichiers, sinon « inconnue ».
        </p>
        <div className="chips" data-testid="music-dirs">
          {data?.dirs.map((d) => (
            <span key={d} className="chip" title={d}>
              {d.split(/[\\/]/).slice(-2).join('/')}
              <button className="chip-x" title="Retirer ce dossier (les fichiers ne sont pas touchés)" onClick={async () => { await api.music.removeFolder(d); reload(); }}>
                ×
              </button>
            </span>
          ))}
          <button className="btn small" data-testid="music-add-folder" onClick={async () => { if (await api.music.addFolder()) reload(); }}>
            + Ajouter un dossier
          </button>
          <button className="btn small primary" data-testid="music-scan" disabled={!data?.dirs.length || !!taskId} onClick={() => void scan()}>
            {task ? `Analyse… ${Math.round((task.progress ?? 0) * 100)} %` : 'Analyser'}
          </button>
          <input className="input small" placeholder="Filtrer (titre, ambiance…)" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginLeft: 'auto', width: 200 }} />
        </div>
        <div className="music-table" role="table">
          <div className="music-row head" role="row">
            <span />
            <span>Titre</span>
            <span>Durée</span>
            <span>Tempo</span>
            <span>Énergie</span>
            <span>Ambiance</span>
            <span>Licence</span>
          </div>
          {!tracks.length && <p className="muted" style={{ padding: 16 }}>{data?.dirs.length ? 'Aucune piste analysée : cliquez sur « Analyser ».' : 'Ajoutez le dossier de votre musique.'}</p>}
          {tracks.map((t) => (
            <div key={t.id} className={`music-item${t.missing ? ' missing' : ''}`} data-testid="music-track">
              <div className="music-row" role="row" onClick={() => setOpen(open === t.id ? null : t.id)}>
                <button className="btn ghost icon" title={playing === t.id ? 'Arrêter' : 'Écouter un extrait'} disabled={t.missing} onClick={(e) => { e.stopPropagation(); play(t); }}>
                  {playing === t.id ? '■' : '▶'}
                </button>
                <span className="title" title={t.path}>
                  {t.title}
                  {t.artist && <small> · {t.artist}</small>}
                  {t.duplicateOf && <em className="tag warn">copie</em>}
                  {t.similarTo?.length ? <em className="tag">semblable</em> : null}
                  {t.classification.vocalsLikely && <em className="tag warn" title="Une voix chantée gêne la narration">voix ?</em>}
                  {t.missing && <em className="tag warn">introuvable</em>}
                </span>
                <span>{fmtDur(t.format.durationSec)}</span>
                <span title={t.features.bpmOctaveAmbiguous ? `ou ${t.features.bpmAlternatives.join(' / ')} BPM` : ''}>{t.features.bpm && t.features.bpmConfidence >= 0.2 ? `${Math.round(t.features.bpm)}${t.features.bpmOctaveAmbiguous ? '*' : ''}` : '—'}</span>
                <span><i className={`meter e-${t.energy}`} />{t.energy}</span>
                <span>{t.moods.join(', ') || '—'}</span>
                <span className={t.licence.status === 'inconnue' ? 'lic unknown' : 'lic'} title={t.licence.text ?? 'Aucune licence déclarée par le fichier ou son dossier'}>
                  {t.licence.status === 'inconnue' ? 'inconnue' : t.licence.family ?? 'déclarée'}
                </span>
              </div>
              {open === t.id && (
                <div className="music-detail">
                  <ul>
                    {t.classification.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                    <li>
                      niveau {t.loudness.integratedLufs?.toFixed(1) ?? '?'} LUFS, crête {t.loudness.truePeakDb?.toFixed(1) ?? '?'} dBTP
                      {t.analysedSec < t.format.durationSec - 1 ? ` · analysé sur les ${Math.round(t.analysedSec / 60)} premières minutes` : ''}
                    </li>
                    <li>licence : {t.licence.status === 'inconnue' ? 'inconnue (rien n’est déclaré)' : `${t.licence.text?.slice(0, 160)} — source : ${t.licence.source}`}</li>
                    {t.usage.length > 0 && <li>utilisée {t.usage.length} fois, dernière : {t.usage[t.usage.length - 1]!.project}</li>}
                  </ul>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="muted small">Corriger l’ambiance :</span>
                    {MOODS.map((m) => (
                      <button
                        key={m}
                        className={`chip toggle${t.moods.includes(m) ? ' on' : ''}`}
                        onClick={async () => {
                          const next = t.moods.includes(m) ? t.moods.filter((x) => x !== m) : [...t.moods, m];
                          await api.music.setOverride(t.id, { moods: next });
                          reload();
                        }}
                      >
                        {m}
                      </button>
                    ))}
                    {t.overrides && (
                      <button className="btn small ghost" onClick={async () => { await api.music.setOverride(t.id, null); reload(); }}>
                        Revenir à l’estimation
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => store.set({ overlay: null })}>
            Terminé
          </button>
        </div>
      </div>
    </div>
  );
}
