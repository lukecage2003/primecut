import { useState } from 'react';
import { type ExportSettings, framesToTimecode, sequenceDuration } from '../../core';
import { api } from '../api';
import { edit, startExport } from '../actions';
import { currentSequence, store, useEditor, useStore } from '../store';

const QUALITY: { id: string; label: string; detail: string; s: Partial<ExportSettings> }[] = [
  { id: 'quality', label: 'Qualité', detail: 'CRF 18 · lent · par défaut', s: { crf: 18, preset: 'slow' } },
  { id: 'deep', label: 'Qualité maximale', detail: 'CRF 14 · lent · fichiers plus lourds', s: { crf: 14, preset: 'slow' } },
  { id: 'balanced', label: 'Équilibré', detail: 'CRF 20 · moyen · plus rapide', s: { crf: 20, preset: 'medium' } },
];

export function ExportDialog() {
  const project = useEditor((e) => e.history.present);
  const seq = useEditor((e) => currentSequence(e));
  const profile = useStore((s) => s.settings?.performanceProfile);
  const s = project.exportSettings;
  const [output, setOutput] = useState<string>('');
  const duration = sequenceDuration(seq);
  const q = QUALITY.find((x) => x.s.crf === s.crf && x.s.preset === s.preset)?.id ?? 'custom';
  const setS = (patch: Partial<ExportSettings>) => edit('Réglages d’export', (_seq, _m, p) => Object.assign(p.exportSettings, patch));
  const close = () => store.set({ overlay: null });

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal glass" style={{ width: 580 }} data-testid="export-dialog">
        <h2>Exporter</h2>
        <dl className="kv">
          <dt>Séquence</dt>
          <dd>{seq.name}</dd>
          <dt>Format</dt>
          <dd>{seq.settings.width}×{seq.settings.height} · {(seq.settings.frameRate.num / seq.settings.frameRate.den).toFixed(3)} fps · {seq.settings.sampleRate} Hz</dd>
          <dt>Durée</dt>
          <dd>{framesToTimecode(duration, seq.settings.frameRate)} ({duration} images)</dd>
        </dl>
        <label className="field">
          <span>Fichier de sortie</span>
          <div className="row">
            <input className="input" style={{ flex: 1 }} value={output} readOnly placeholder="Choisir l'emplacement…" data-testid="export-path" />
            <button
              className="btn"
              data-testid="export-browse"
              onClick={async () => {
                const f = await api.dialog.exportTarget(`${project.name}.${s.container}`);
                if (f) {
                  setOutput(f);
                  const ext = f.split('.').pop()?.toLowerCase();
                  if (ext === 'mp4' || ext === 'mov' || ext === 'mkv') if (ext !== s.container) setS({ container: ext });
                }
              }}
            >
              Parcourir…
            </button>
          </div>
        </label>
        <div className="field">
          <span>Qualité</span>
          <div className="preset-grid">
            {QUALITY.map((x) => (
              <div key={x.id} className={`preset ${q === x.id ? 'on' : ''}`} onClick={() => setS(x.s)} data-testid={`q-${x.id}`}>
                <b>{x.label}</b>
                <span>{x.detail}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Codec vidéo</span>
            <select className="input" value={s.videoCodec} onChange={(e) => setS({ videoCodec: e.target.value as 'h264' | 'hevc' })}>
              <option value="h264">H.264 / AVC</option>
              <option value="hevc">H.265 / HEVC</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Encodeur</span>
            <select className="input" value={s.hardware} onChange={(e) => setS({ hardware: e.target.value as 'auto' | 'cpu' })}>
              <option value="cpu">Processeur (meilleure qualité)</option>
              <option value="auto">Matériel si vérifié</option>
            </select>
          </label>
          <label className="field" style={{ width: 120 }}>
            <span>Audio</span>
            <select className="input" value={s.audioBitrateKbps} onChange={(e) => setS({ audioBitrateKbps: Number(e.target.value) })}>
              {[128, 192, 256, 320].map((b) => (
                <option key={b} value={b}>
                  AAC {b}k
                </option>
              ))}
            </select>
          </label>
        </div>
        {s.hardware === 'auto' && profile !== 'balanced' && (
          <div className="tiny">L'encodage matériel n'est utilisé qu'avec le profil de performance Équilibré (Réglages). Le profil actuel garde l'encodeur processeur.</div>
        )}
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" data-testid="export-subtitle-files" checked={s.subtitleFiles !== false} onChange={(e) => setS({ subtitleFiles: e.target.checked })} />
          Écrire aussi les sous-titres en fichiers (.srt et .vtt) dans un dossier à part, pour YouTube et TikTok — jamais à côté de la vidéo, où les lecteurs les afficheraient par-dessus les sous-titres incrustés
        </label>
        <div className="tiny">Le fichier est rendu sous un nom temporaire puis vérifié (flux, résolution, nombre exact d'images) avant d'être publié.</div>
        <div className="actions">
          <button className="btn" onClick={close}>
            Annuler
          </button>
          <button
            className="btn primary"
            disabled={!output || duration === 0}
            data-testid="export-start"
            onClick={async () => {
              await startExport(output);
            }}
          >
            Exporter
          </button>
        </div>
      </div>
    </div>
  );
}
