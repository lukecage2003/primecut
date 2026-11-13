import { useState } from 'react';
import { type Clip, DEFAULT_DUCK, DEFAULT_TRANSFORM, type Sequence, findClip, framesToTimecode, maxTransitionDuration, setClipFades, setClipProps, setTransitionDuration, unlinkClips } from '../../core';
import { clearPreview, deleteSelectedTransition, edit, learnFromEdits, previewEdit, setPlayhead, updateVisual } from '../actions';
import { VISUAL_KINDS } from '../../core';
import { compareVersions, versionMetrics } from '../../production/compare';
import { store } from '../store';
import { currentProject, currentSequence, useEditor } from '../store';

function Slider({ label, value, min, max, step, fmt, onPreview, onCommit, testid }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string;
  onPreview: (v: number) => void; onCommit: (v: number) => void; testid?: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const v = draft ?? value;
  return (
    <div className="insp-row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        data-testid={testid}
        onChange={(e) => {
          const n = Number(e.target.value);
          setDraft(n);
          onPreview(n);
        }}
        onPointerUp={() => {
          if (draft !== null) onCommit(draft);
          setDraft(null);
        }}
        onKeyUp={() => {
          if (draft !== null) onCommit(draft);
          setDraft(null);
        }}
        onDoubleClick={() => onCommit(min <= 0 && max >= 0 && label !== 'Échelle' && label !== 'Opacité' ? 0 : 1)}
      />
      <span className="val">{fmt(v)}</span>
    </div>
  );
}

export function Inspector() {
  const selection = useEditor((e) => e.selection);
  const seq = useEditor((e) => currentSequence(e));
  const project = useEditor((e) => currentProject(e));
  const clips = selection.map((id) => findClip(seq, id)).filter(Boolean) as { clip: Clip; track: Sequence['tracks'][number] }[];
  const video = clips.find((c) => c.track.kind === 'video');
  const audio = clips.find((c) => c.track.kind === 'audio');
  const primary = video ?? audio;
  const rate = seq.settings.frameRate;
  const fps = rate.num / rate.den;
  const tc = (f: number) => framesToTimecode(f, rate);
  const selectedTransition = useEditor((e) => e.selectedTransition);
  const trInfo = (() => {
    if (!selectedTransition) return null;
    for (const t of seq.tracks) {
      const tr = t.transitions.find((x) => x.id === selectedTransition);
      if (!tr) continue;
      const i = t.clips.findIndex((c) => c.id === tr.leftClipId);
      const l = t.clips[i];
      const r = t.clips[i + 1];
      return { tr, track: t, max: l && r ? maxTransitionDuration(seq, project.media, l, r) : tr.duration };
    }
    return null;
  })();

  const setProps = (id: string, props: Partial<Clip>, label: string, commit: boolean) => {
    if (commit) {
      clearPreview();
      edit(label, (s) => setClipProps(s, id, props));
    } else previewEdit((s) => setClipProps(s, id, props));
  };

  return (
    <div className="panel glass" data-testid="inspector">
      <div className="panel-head">
        <h3>Inspecteur</h3>
      </div>
      <div className="panel-body">
        {trInfo && (
          <div className="insp" data-testid="transition-inspector">
            <div className="section-title">Transition · {trInfo.track.name}</div>
            <dl className="kv">
              <dt>Type</dt>
              <dd>Fondu enchaîné</dd>
              <dt>Durée</dt>
              <dd>{tc(trInfo.tr.duration)} ({trInfo.tr.duration} f)</dd>
              <dt>Max (marges)</dt>
              <dd>{trInfo.max} f</dd>
            </dl>
            <Slider
              label="Durée"
              value={trInfo.tr.duration}
              min={2}
              max={Math.max(2, trInfo.max)}
              step={1}
              fmt={(v) => `${(v / fps).toFixed(2)}s`}
              onPreview={(v) => previewEdit((s, m) => void setTransitionDuration(s, m, trInfo.tr.id, v))}
              onCommit={(v) => (clearPreview(), edit('Durée de transition', (s, m) => setTransitionDuration(s, m, trInfo.tr.id, v)))}
            />
            <button className="btn danger" onClick={() => deleteSelectedTransition()}>
              Supprimer la transition
            </button>
          </div>
        )}
        {!primary && !trInfo && seq.production && <ProductionReport />}
        {!primary && !trInfo && !seq.production && (
          <div className="insp">
            <div className="section-title">Séquence</div>
            <dl className="kv">
              <dt>Nom</dt>
              <dd>{seq.name}</dd>
              <dt>Taille d'image</dt>
              <dd>{seq.settings.width}×{seq.settings.height}</dd>
              <dt>Images/s</dt>
              <dd>{(rate.num / rate.den).toFixed(3)} ({rate.num}/{rate.den})</dd>
              <dt>Audio</dt>
              <dd>{seq.settings.sampleRate} Hz stereo</dd>
              <dt>Clips</dt>
              <dd>{seq.tracks.reduce((n, t) => n + t.clips.length, 0)}</dd>
              <dt>Médias</dt>
              <dd>{Object.keys(project.media).length}</dd>
            </dl>
            <div className="tiny">Sélectionnez un clip pour modifier ses propriétés.</div>
          </div>
        )}
        {primary && (
          <div className="insp">
            <div className="section-title">Clip</div>
            <dl className="kv">
              <dt>Nom</dt>
              <dd title={primary.clip.name}>{primary.clip.name}</dd>
              <dt>Début</dt>
              <dd data-testid="insp-start">{tc(primary.clip.start)}</dd>
              <dt>Durée</dt>
              <dd data-testid="insp-duration">{tc(primary.clip.duration)}</dd>
              <dt>Entrée source</dt>
              <dd>{primary.clip.sourceIn.toFixed(3)} s</dd>
              <dt>Médias</dt>
              <dd title={project.media[primary.clip.mediaId]?.path}>{project.media[primary.clip.mediaId]?.path ?? 'missing'}</dd>
            </dl>
            <div className="row">
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={primary.clip.enabled}
                  onChange={(e) => {
                    for (const c of clips) setProps(c.clip.id, { enabled: e.target.checked }, e.target.checked ? 'Activer le clip' : 'Désactiver le clip', true);
                  }}
                />
                Activé
              </label>
              <div className="spacer" />
              {primary.clip.linkId && (
                <button className="btn ghost" onClick={() => edit('Délier', (s) => unlinkClips(s, [primary.clip.id]))}>
                  Délier image/son
                </button>
              )}
            </div>
            <div className="section-title">Fondus</div>
            {(['fadeIn', 'fadeOut'] as const).map((k) => (
              <Slider
                key={k}
                label={k === 'fadeIn' ? 'Fondu d’entrée' : 'Fondu de sortie'}
                testid={`insp-${k}`}
                value={primary.clip[k]}
                min={0}
                max={Math.min(primary.clip.duration, Math.round(fps * 5))}
                step={1}
                fmt={(v) => `${(v / fps).toFixed(2)}s`}
                onPreview={(v) => previewEdit((s) => setClipFades(s, primary.clip.id, { [k]: v }))}
                onCommit={(v) => (clearPreview(), edit(k === 'fadeIn' ? 'Fondu d’entrée' : 'Fondu de sortie', (s) => setClipFades(s, primary.clip.id, { [k]: v })))}
              />
            ))}
            {video && project.media[video.clip.mediaId]?.generator && <VisualEditor mediaId={video.clip.mediaId} />}
            {video && (
              <>
                <div className="section-title">Transformation</div>
                {(
                  [
                    ['Échelle', 'scale', 0.1, 4, 0.01, (v: number) => `${Math.round(v * 100)}%`],
                    ['Position X', 'x', -seq.settings.width, seq.settings.width, 1, (v: number) => `${Math.round(v)}`],
                    ['Position Y', 'y', -seq.settings.height, seq.settings.height, 1, (v: number) => `${Math.round(v)}`],
                    ['Rotation', 'rotation', -180, 180, 0.5, (v: number) => `${v.toFixed(1)}°`],
                    ['Opacité', 'opacity', 0, 1, 0.01, (v: number) => `${Math.round(v * 100)}%`],
                  ] as const
                ).map(([label, key, min, max, step, fmt]) => (
                  <Slider
                    key={key}
                    label={label}
                    testid={`insp-${key}`}
                    value={video.clip.transform[key]}
                    min={min}
                    max={max}
                    step={step}
                    fmt={fmt}
                    onPreview={(v) => setProps(video.clip.id, { transform: { ...video.clip.transform, [key]: v } }, label, false)}
                    onCommit={(v) => setProps(video.clip.id, { transform: { ...video.clip.transform, [key]: v } }, `Set ${label.toLowerCase()}`, true)}
                  />
                ))}
                <div className="insp-row">
                  <label>Fond</label>
                  <select className="input" value={video.clip.fill ?? 'none'} onChange={(e) => setProps(video.clip.id, { fill: e.target.value as 'none' | 'blur' }, 'Remplissage du fond', true)}>
                    <option value="none">Noir</option>
                    <option value="blur">Image floutée</option>
                  </select>
                  <span />
                </div>
                <div className="insp-row">
                  <label>Mouvement</label>
                  <select className="input" data-testid="insp-motion" value={video.clip.motion?.kind ?? 'none'} onChange={(e) => setProps(video.clip.id, { motion: { kind: e.target.value as never, amount: e.target.value === 'none' ? 0 : video.clip.motion?.amount || 0.12 } }, 'Mouvement de caméra', true)}>
                    {['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <span />
                </div>
                <button className="btn ghost" onClick={() => setProps(video.clip.id, { transform: { ...DEFAULT_TRANSFORM } }, 'Réinitialiser', true)}>
                  Réinitialiser
                </button>
              </>
            )}
            {audio && (
              <>
                <div className="section-title">Audio</div>
                <Slider
                  label="Gain"
                  testid="insp-gain"
                  value={audio.clip.gainDb}
                  min={-60}
                  max={12}
                  step={0.5}
                  fmt={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
                  onPreview={(v) => setProps(audio.clip.id, { gainDb: v }, 'Gain', false)}
                  onCommit={(v) => setProps(audio.clip.id, { gainDb: v }, 'Régler le gain', true)}
                />
                <DuckControl seq={seq} trackId={audio.track.id} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductionReport() {
  const seq = useEditor((e) => currentSequence(e));
  const media = useEditor((e) => currentProject(e).media);
  const p = seq.production!;
  const rate = seq.settings.frameRate;
  const sec = (f: number) => (f * rate.den) / rate.num;
  return (
    <div className="insp" data-testid="production-report">
      <div className="section-title">Version générée · v{p.version}</div>
      <dl className="kv">
        <dt>Score qualité (technique)</dt>
        <dd data-testid="qc-score">{p.qcScore}/100</dd>
        <dt>Synchro</dt>
        <dd>{p.alignment.method === 'transcript' ? 'mot à mot' : 'pauses'} · {Math.round(p.alignment.confidence * 100)}%</dd>
        <dt>Plans</dt>
        <dd>{p.shots.length} ({p.shots.filter((s) => s.quality === 'strong').length} specific)</dd>
      </dl>
      <div className="row">
        <button className="btn" onClick={() => store.set({ overlay: 'production' })}>Régénérer…</button>
        <button className="btn ghost" onClick={() => void learnFromEdits()} title="Adapter rythme, mouvements et transitions à vos retouches de cette version">Apprendre de mes retouches</button>
      </div>
      <CompareVersions />
      {p.narrationFormat && (
        <div data-testid="narration-format">
          <div className="section-title">Type de narration</div>
          <dl className="kv">
            <dt>Type</dt>
            <dd>
              {p.narrationFormat.label}
              {p.narrationFormat.forced ? ' (choisi par vous)' : ` (détecté, ${Math.round(p.narrationFormat.confidence * 100)} %)`}
            </dd>
            <dt>Longueur</dt>
            <dd>{p.narrationFormat.length === 'short' ? 'Short' : p.narrationFormat.length === 'documentaire' ? 'Documentaire' : 'Vidéo standard'}</dd>
          </dl>
          {p.narrationFormat.evidence.slice(0, 3).map((e) => (
            <div key={e} className="tiny">
              ◦ {e}
            </div>
          ))}
          {p.narrationFormat.changes.map((c) => (
            <div key={c} className="tiny">
              ✓ {c}
            </div>
          ))}
        </div>
      )}
      {p.voice && <VoiceReport />}
      {p.qcIssues.length > 0 && <div className="section-title">Contrôle qualité</div>}
      {p.qcIssues.map((i, k) => (
        <div key={k} className={`issue ${i.severity}`} onClick={() => i.frame !== undefined && setPlayhead(i.frame)}>
          {i.severity === 'error' ? '●' : i.severity === 'warning' ? '▲' : 'ℹ'} {i.message}
        </div>
      ))}
      <div className="section-title">Plans — pourquoi chaque image</div>
      {p.shots.map((s, k) => (
        <div key={k} className={`report-shot ${s.quality}`} onClick={() => setPlayhead(s.start)} title={s.text}>
          <b>{sec(s.start).toFixed(1)}s</b> · {s.mediaId ? media[s.mediaId]?.name : 'missing visual'}
          <div className="tiny">{s.reasons.join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}

/** Measured comparison of this version with another one of the same project (no artistic score). */
function CompareVersions() {
  const seq = useEditor((e) => currentSequence(e));
  const project = useEditor((e) => currentProject(e));
  const others = Object.values(project.sequences).filter((s) => s.id !== seq.id);
  const [otherId, setOtherId] = useState('');
  if (!others.length) return null;
  const other = project.sequences[otherId];
  const rows = other ? compareVersions(versionMetrics(other, project.media), versionMetrics(seq, project.media)) : [];
  const color = { better: 'var(--ok, #6c6)', worse: 'var(--danger)', diff: 'inherit', same: 'var(--muted, #888)' } as const;
  return (
    <div data-testid="compare-versions">
      <div className="section-title">Comparer les versions</div>
      <select className="input" value={otherId} onChange={(e) => setOtherId(e.target.value)} data-testid="compare-select">
        <option value="">Comparer avec…</option>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {other && (
        <>
          <table className="tiny" style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }} data-testid="compare-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Mesure</th>
                <th style={{ textAlign: 'right' }}>{other.name}</th>
                <th style={{ textAlign: 'right' }}>{seq.name}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td style={{ textAlign: 'right' }}>{r.a}</td>
                  <td style={{ textAlign: 'right', color: color[r.verdict] }}>
                    {r.b}
                    {r.verdict === 'better' ? ' ▲' : r.verdict === 'worse' ? ' ▼' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tiny">Mesures calculées à l’identique sur les deux versions. ▲/▼ seulement quand le sens est un fait technique (moins de répétitions, moins d’erreurs) ; durée et nombre de plans restent un choix éditorial.</div>
        </>
      )}
    </div>
  );
}

/** Narration cleanup of this version: what was done and why, measured before/after, reversible. */
function VoiceReport() {
  const seq = useEditor((e) => currentSequence(e));
  const v = seq.production!.voice!;
  const usingClean = seq.tracks.some((t) => t.clips.some((c) => c.mediaId === v.mediaId));
  const swap = (from: string, to: string, label: string) =>
    edit(label, (s) => {
      for (const t of s.tracks) for (const c of t.clips) if (c.mediaId === from) c.mediaId = to;
      if (s.production) s.production.narrationMediaId = to;
    });
  const fmt = (x: number | null) => (x == null ? '—' : x.toFixed(1));
  return (
    <div data-testid="voice-report">
      <div className="section-title">Voix</div>
      <dl className="kv">
        <dt>Bruit de fond</dt>
        <dd>
          {fmt(v.before.noiseFloorDb)} → {fmt(v.after.noiseFloorDb)} dBFS
        </dd>
        <dt>Voix / bruit</dt>
        <dd>
          {fmt(v.before.snrDb)} → {fmt(v.after.snrDb)} dB
        </dd>
        <dt>Volume</dt>
        <dd>
          {fmt(v.before.lufs)} → {fmt(v.after.lufs)} LUFS
        </dd>
        {v.before.humHz && (
          <>
            <dt>Ronflement</dt>
            <dd>{v.before.humHz} Hz removed</dd>
          </>
        )}
      </dl>
      {v.steps.map((s) => (
        <div key={s.id} className="tiny" title={s.reason}>
          ✓ {s.reason}
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        {v.swappable === false ? (
          <span className="tiny">Les pauses ont été resserrées : pour revenir à l’enregistrement original, décochez l’option et régénérez.</span>
        ) : usingClean ? (
          <button className="btn ghost" data-testid="voice-use-original" onClick={() => swap(v.mediaId, v.originalId, 'Narration originale')}>
            Utiliser l'enregistrement original
          </button>
        ) : (
          <button className="btn ghost" data-testid="voice-use-clean" onClick={() => swap(v.originalId, v.mediaId, 'Narration nettoyée')}>
            Utiliser la voix nettoyée
          </button>
        )}
      </div>
    </div>
  );
}

function VisualEditor({ mediaId }: { mediaId: string }) {
  const g = useEditor((e) => currentProject(e).media[mediaId]?.generator);
  const [title, setTitle] = useState(g?.title ?? '');
  const [subtitle, setSubtitle] = useState(g?.subtitle ?? '');
  const [busy, setBusy] = useState(false);
  if (!g) return null;
  const apply = async (patch: Parameters<typeof updateVisual>[1]) => {
    setBusy(true);
    await updateVisual(mediaId, patch);
    setBusy(false);
  };
  return (
    <div className="insp" style={{ padding: 0 }} data-testid="visual-editor">
      <div className="section-title">Animation {busy ? '· calcul…' : ''}</div>
      <div className="insp-row">
        <label>Composition</label>
        <select className="input" value={g.kind} disabled={busy} onChange={(e) => void apply({ kind: e.target.value as never })} data-testid="visual-kind">
          {VISUAL_KINDS.map((k) => (
            <option key={k.id} value={k.id}>{k.label}</option>
          ))}
        </select>
        <span />
      </div>
      <div className="insp-row">
        <label>Style</label>
        <select className="input" value={g.style} disabled={busy} onChange={(e) => void apply({ style: e.target.value as never })}>
          <option value="gold">Or Primestone</option>
          <option value="hologram">Hologramme</option>
          <option value="crimson">Pourpre</option>
        </select>
        <span />
      </div>
      <div className="insp-row">
        <label>Titre</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== (g.title ?? '') && void apply({ title })} />
        <span />
      </div>
      <div className="insp-row">
        <label>Sous-titre</label>
        <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} onBlur={() => subtitle !== (g.subtitle ?? '') && void apply({ subtitle })} />
        <span />
      </div>
      <div className="insp-row">
        <label>Variante</label>
        <button className="btn ghost" disabled={busy} onClick={() => void apply({ seed: g.seed + 1 })}>Mélanger</button>
        <span />
      </div>
    </div>
  );
}

/** Automatic ducking of the selected clip's track under another audio track (usually the narration). */
function DuckControl({ seq, trackId }: { seq: Sequence; trackId: string }) {
  const track = seq.tracks.find((t) => t.id === trackId);
  const sources = seq.tracks.filter((t) => t.kind === 'audio' && t.id !== trackId);
  if (!track || !sources.length) return null;
  const duck = track.duck;
  const set = (d: typeof duck, label: string) =>
    edit(label, (s) => {
      const t = s.tracks.find((x) => x.id === trackId);
      if (t) t.duck = d ? { ...d } : undefined;
    });
  return (
    <div data-testid="insp-duck">
      <label className="row" style={{ gap: 6, marginTop: 6 }}>
        <input
          type="checkbox"
          checked={!!duck}
          onChange={(e) => set(e.target.checked ? { ...DEFAULT_DUCK, by: sources[0]!.id } : undefined, e.target.checked ? 'Activer l’atténuation' : 'Désactiver l’atténuation')}
        />
        Baisser cette piste sous
        <select className="input" style={{ width: 90 }} disabled={!duck} value={duck?.by ?? sources[0]!.id} onChange={(e) => duck && set({ ...duck, by: e.target.value }, 'Source d’atténuation')}>
          {sources.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {duck && (
        <Slider
          label="Profondeur d'atténuation"
          testid="insp-duck-depth"
          value={duck.depthDb}
          min={-24}
          max={0}
          step={0.5}
          fmt={(v) => `${v.toFixed(1)} dB`}
          onPreview={() => undefined}
          onCommit={(v) => set({ ...duck, depthDb: v }, 'Profondeur d’atténuation')}
        />
      )}
    </div>
  );
}
