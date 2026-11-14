/**
 * Edit decisions (EDG) in the interface: every automatic choice can be accepted, locked, rejected
 * or replaced, with its evidence and confidence. Matching evidence says plainly where it comes from
 * (file name, tags, folder, OCR, description): a name match is never shown as visual understanding.
 */
import { useEffect, useState } from 'react';
import { BASIS_LABEL, CONTENT_BASES, type EditDecision, type MediaAsset, decisionForClip, summariseGraph } from '../../core';
import { chooseForDecision, chooseMusicForDecision, edit, rejectEditDecision, setEditDecision, setPlayhead } from '../actions';
import { currentProject, currentSequence, store, useEditor } from '../store';

const STATE: Record<EditDecision['state'], { label: string; cls: string }> = {
  proposée: { label: 'Proposée', cls: 'proposed' },
  acceptée: { label: 'Acceptée', cls: 'accepted' },
  verrouillée: { label: 'Verrouillée', cls: 'locked' },
  rejetée: { label: 'Rejetée', cls: 'rejected' },
};

function Confidence({ d }: { d: EditDecision }) {
  if (d.chosen.generated) return <span className="tiny">composition animée (aucune image liée)</span>;
  if (!d.chosen.mediaId) return <span className="tiny">visuel manquant</span>;
  const pct = Math.round(d.confidence * 100);
  const content = d.chosen.evidence.some((e) => CONTENT_BASES.has(e.basis));
  return (
    <span className="conf" title={content ? 'Confiance fondée en partie sur le contenu (texte lu dans l’image, votre description ou votre choix)' : 'Confiance fondée seulement sur les métadonnées : le contenu de l’image n’est pas analysé'}>
      <span className="conf-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} className={pct < 45 ? 'low' : pct < 65 ? 'mid' : 'high'} />
      </span>
      <span className="tiny">{pct} %{content ? '' : ' · métadonnées seulement'}</span>
    </span>
  );
}

function Evidence({ d }: { d: EditDecision }) {
  const ev = d.chosen.evidence.filter((e) => e.basis !== 'aucune' || d.chosen.evidence.length === 1);
  if (!ev.length) return null;
  return (
    <ul className="evidence tiny" aria-label="Preuves">
      {ev.slice(0, 5).map((e, i) => (
        <li key={i}>
          <b>{BASIS_LABEL[e.basis]}</b> : {e.detail}
        </li>
      ))}
    </ul>
  );
}

export function DecisionCard({ d, compact, reasons }: { d: EditDecision; compact?: boolean; reasons?: string[] }) {
  const media = useEditor((e) => currentProject(e).media);
  const visualCandidates = d.candidates.filter((c) => c.mediaId && c.mediaId !== d.chosen.mediaId && media[c.mediaId] && !d.rejected.includes(c.mediaId));
  const musicCandidates = d.candidates.filter((c) => c.trackId && c.trackId !== d.chosen.trackId && !d.rejected.includes(c.trackId));
  const images = Object.values(media).filter((m) => (m.kind === 'image' || (m.kind === 'video' && m.probe.video && !m.pcore)) && !m.generator && m.id !== d.chosen.mediaId);
  const st = STATE[d.state];
  return (
    <div className={`decision ${st.cls}`} data-testid="decision" data-decision={d.id} data-state={d.state}>
      <div className="row" style={{ gap: 6 }}>
        <span className={`pill ${st.cls}`}>{st.label}</span>
        <span className="tiny" style={{ flex: 1 }}>
          {d.kind === 'musique' ? '♪ ' : ''}
          {d.author === 'utilisateur' ? 'votre choix' : 'proposition automatique'}
        </span>
        <Confidence d={d} />
      </div>
      {!compact && <div className="tiny decision-text">« {d.anchor.text.slice(0, 140)}{d.anchor.text.length > 140 ? '…' : ''} »</div>}
      <div className="decision-choice">{d.chosen.label}</div>
      <Evidence d={d} />
      {reasons && reasons.length > 0 && <div className="tiny muted">{reasons.join(' · ')}</div>}
      {d.criteria.length > 0 && !compact && <div className="tiny muted">Règles : {d.criteria.join(' · ')}</div>}
      <div className="row decision-actions" style={{ gap: 4, flexWrap: 'wrap' }}>
        {d.state !== 'acceptée' && d.state !== 'verrouillée' && d.state !== 'rejetée' && (
          <button className="btn ghost" data-testid="decision-accept" onClick={() => setEditDecision(d.id, 'acceptée')} title="Garder ce choix ; il sera conservé à la régénération">
            ✓ Accepter
          </button>
        )}
        {d.state !== 'verrouillée' ? (
          <button className="btn ghost" data-testid="decision-lock" onClick={() => setEditDecision(d.id, 'verrouillée')} title="Ce choix ne changera plus, même en régénérant">
            🔒 Verrouiller
          </button>
        ) : (
          <button className="btn ghost" data-testid="decision-unlock" onClick={() => setEditDecision(d.id, 'proposée')}>
            Déverrouiller
          </button>
        )}
        {d.state !== 'rejetée' && d.chosen.mediaId && !d.chosen.generated && (
          <button className="btn ghost danger" data-testid="decision-reject" onClick={() => rejectEditDecision(d.id)} title="Ne plus proposer ce média pour ce passage">
            ✕ Rejeter
          </button>
        )}
        {d.kind === 'visuel' && (
          <select
            className="input"
            aria-label="Remplacer par"
            data-testid="decision-replace"
            value=""
            onChange={(e) => e.target.value && chooseForDecision(d.id, e.target.value)}
          >
            <option value="">Remplacer par…</option>
            {visualCandidates.length > 0 && (
              <optgroup label="Autres propositions">
                {visualCandidates.map((c) => (
                  <option key={c.mediaId} value={c.mediaId!}>
                    {c.label} ({Math.round(c.confidence * 100)} %)
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Toutes les images du projet">
              {images.slice(0, 300).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        )}
        {d.kind === 'musique' && musicCandidates.length > 0 && (
          <select className="input" aria-label="Autre musique" value="" onChange={(e) => e.target.value && void chooseMusicForDecision(d.id, e.target.value)}>
            <option value="">Autre musique…</option>
            {musicCandidates.map((c) => (
              <option key={c.trackId} value={c.trackId!}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {!compact && d.history.length > 1 && (
        <details className="tiny">
          <summary>Historique ({d.history.length})</summary>
          {d.history.slice(-8).map((h, i) => (
            <div key={i}>
              {new Date(h.at).toLocaleString()} · {h.action} ({h.by === 'auto' ? 'automatique' : 'vous'}){h.detail ? ` · ${h.detail}` : ''}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** Decision list of a generated version, with a "to review" filter. */
export function DecisionList() {
  const seq = useEditor((e) => currentSequence(e));
  const [filter, setFilter] = useState<'review' | 'all' | 'music'>('all');
  const g = seq.production?.edg;
  if (!g) return null;
  const threshold = 0.45;
  const sum = summariseGraph(g, threshold);
  const sec = (f: number) => ((f * seq.settings.frameRate.den) / seq.settings.frameRate.num).toFixed(1);
  const toReview = (d: EditDecision) => d.state === 'rejetée' || (d.state === 'proposée' && d.kind === 'visuel' && (d.confidence < threshold || !d.chosen.mediaId));
  const why = new Map((seq.production?.shots ?? []).filter((s) => s.decisionId).map((s) => [s.decisionId!, s.reasons]));
  const list = g.decisions.filter((d) => (filter === 'all' ? true : filter === 'music' ? d.kind === 'musique' : toReview(d)));
  return (
    <div data-testid="decision-list">
      <div className="section-title">Décisions de montage</div>
      <div className="tiny" data-testid="decision-summary">
        {sum.total} décisions · {sum.locked} verrouillée(s) · {sum.accepted} acceptée(s) · {sum.rejected} rejetée(s) · {sum.lowConfidence} à faible confiance
      </div>
      <div className="notice tiny" role="note">
        Le contenu des images n’est pas analysé par une IA : les correspondances viennent des noms de fichiers, étiquettes, dossiers, de vos descriptions et, si activé, du texte lu par l’OCR local. {sum.metadataOnly > 0 ? `${sum.metadataOnly} plan(s) reposent seulement sur les noms.` : ''}
      </div>
      <div className="row" role="tablist" aria-label="Filtrer les décisions" style={{ gap: 4 }}>
        {(
          [
            ['review', `À vérifier (${g.decisions.filter(toReview).length})`],
            ['all', `Toutes (${g.decisions.length})`],
            ['music', `Musique (${g.decisions.filter((d) => d.kind === 'musique').length})`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={`btn ghost${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)} data-testid={`decision-filter-${k}`}>
            {l}
          </button>
        ))}
      </div>
      {list.length === 0 && <div className="tiny">Rien à vérifier dans ce filtre.</div>}
      {list.slice(0, 200).map((d) => (
        <div key={d.id} className="decision-row">
          <button
            className="btn ghost tiny"
            onClick={() => {
              setPlayhead(d.anchor.start);
              if (d.clipIds[0]) store.setEditor({ selection: [d.clipIds[0]] });
            }}
            title="Aller à ce plan"
          >
            {sec(d.anchor.start)} s
          </button>
          <DecisionCard d={d} reasons={why.get(d.id)} />
        </div>
      ))}
    </div>
  );
}

/** Decision of the selected clip (in the clip inspector). */
export function ClipDecision({ clipId }: { clipId: string }) {
  const seq = useEditor((e) => currentSequence(e));
  const d = decisionForClip(seq, clipId);
  if (!d) return null;
  return (
    <div data-testid="clip-decision">
      <div className="section-title">Décision de montage</div>
      <DecisionCard d={d} compact />
    </div>
  );
}

/** What is known about a picture: user description (editable), OCR text, detected panels over the page. */
export function MediaInsight({ m }: { m: MediaAsset }) {
  const [draft, setDraft] = useState(m.description ?? '');
  useEffect(() => setDraft(m.description ?? ''), [m.id, m.description]);
  if (m.kind !== 'image') return null;
  const v = m.probe.video;
  const save = () => {
    const text = draft.trim();
    if (text === (m.description ?? '')) return;
    edit('Description de l’image', (_s, _m, p) => {
      const a = p.media[m.id];
      if (a) a.description = text || undefined;
    });
  };
  return (
    <div data-testid="media-insight">
      <div className="section-title">Ce que montre l’image</div>
      <label className="field">
        <span className="tiny">Description (écrite par vous ; utilisée pour la correspondance à la prochaine génération)</span>
        <textarea className="input" rows={2} value={draft} data-testid="media-description" onChange={(e) => setDraft(e.target.value)} onBlur={save} placeholder="Ex. : Thanos porte le Gant de l’Infini, gros plan" />
      </label>
      {m.ocr ? (
        <div className="tiny" data-testid="media-ocr">
          Texte lu (OCR {m.ocr.engine}, confiance {Math.round(m.ocr.confidence * 100)} %) : {m.ocr.text ? `« ${m.ocr.text.slice(0, 200)}${m.ocr.text.length > 200 ? '…' : ''} »` : 'aucun texte lisible'}
        </div>
      ) : (
        <div className="tiny muted">Texte de l’image non lu (OCR local désactivé ou indisponible : Réglages → OCR local).</div>
      )}
      {v && (m.panels?.length || m.ocr?.zones.length) ? (
        <div className="page-preview" style={{ aspectRatio: `${v.width} / ${v.height}` }} data-testid="page-preview">
          <img src={`pmedia://local/${encodeURIComponent(m.path)}`} alt={`Page ${m.name}`} />
          {m.panels?.map((p, i) => (
            <span key={`p${i}`} className="panel-box" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}>
              <b>{i + 1}</b>
            </span>
          ))}
          {m.ocr?.zones.map((z, i) => (
            <span key={`z${i}`} className="text-box" style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }} />
          ))}
        </div>
      ) : null}
      {m.panels?.length ? (
        <div className="tiny">
          {m.panels.length} case(s) détectée(s), ordre de lecture {m.comic?.readingOrder === 'rtl' ? 'de droite à gauche (manga)' : 'de gauche à droite'}
          {m.panelConfidence !== undefined ? ` · découpage ${m.panelConfidence >= 0.7 ? 'net' : m.panelConfidence >= 0.5 ? 'plausible' : 'incertain'} (${Math.round(m.panelConfidence * 100)} %)` : ''}
        </div>
      ) : null}
    </div>
  );
}

