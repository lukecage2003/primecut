import { useState } from 'react';
import { type Clip, DEFAULT_TRANSFORM, type Sequence, findClip, framesToTimecode, maxTransitionDuration, setClipFades, setClipProps, setTransitionDuration, unlinkClips } from '../../core';
import { clearPreview, deleteSelectedTransition, edit, learnFromEdits, previewEdit, setPlayhead } from '../actions';
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
        onDoubleClick={() => onCommit(min <= 0 && max >= 0 && label !== 'Scale' && label !== 'Opacity' ? 0 : 1)}
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
        <h3>Inspector</h3>
      </div>
      <div className="panel-body">
        {trInfo && (
          <div className="insp" data-testid="transition-inspector">
            <div className="section-title">Transition · {trInfo.track.name}</div>
            <dl className="kv">
              <dt>Type</dt>
              <dd>Cross dissolve</dd>
              <dt>Duration</dt>
              <dd>{tc(trInfo.tr.duration)} ({trInfo.tr.duration} f)</dd>
              <dt>Max (handles)</dt>
              <dd>{trInfo.max} f</dd>
            </dl>
            <Slider
              label="Duration"
              value={trInfo.tr.duration}
              min={2}
              max={Math.max(2, trInfo.max)}
              step={1}
              fmt={(v) => `${(v / fps).toFixed(2)}s`}
              onPreview={(v) => previewEdit((s, m) => void setTransitionDuration(s, m, trInfo.tr.id, v))}
              onCommit={(v) => (clearPreview(), edit('Transition duration', (s, m) => setTransitionDuration(s, m, trInfo.tr.id, v)))}
            />
            <button className="btn danger" onClick={() => deleteSelectedTransition()}>
              Remove transition
            </button>
          </div>
        )}
        {!primary && !trInfo && seq.production && <ProductionReport />}
        {!primary && !trInfo && !seq.production && (
          <div className="insp">
            <div className="section-title">Sequence</div>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{seq.name}</dd>
              <dt>Frame size</dt>
              <dd>{seq.settings.width}×{seq.settings.height}</dd>
              <dt>Frame rate</dt>
              <dd>{(rate.num / rate.den).toFixed(3)} ({rate.num}/{rate.den})</dd>
              <dt>Audio</dt>
              <dd>{seq.settings.sampleRate} Hz stereo</dd>
              <dt>Clips</dt>
              <dd>{seq.tracks.reduce((n, t) => n + t.clips.length, 0)}</dd>
              <dt>Media</dt>
              <dd>{Object.keys(project.media).length}</dd>
            </dl>
            <div className="tiny">Select a clip to edit its properties.</div>
          </div>
        )}
        {primary && (
          <div className="insp">
            <div className="section-title">Clip</div>
            <dl className="kv">
              <dt>Name</dt>
              <dd title={primary.clip.name}>{primary.clip.name}</dd>
              <dt>Start</dt>
              <dd data-testid="insp-start">{tc(primary.clip.start)}</dd>
              <dt>Duration</dt>
              <dd data-testid="insp-duration">{tc(primary.clip.duration)}</dd>
              <dt>Source in</dt>
              <dd>{primary.clip.sourceIn.toFixed(3)} s</dd>
              <dt>Media</dt>
              <dd title={project.media[primary.clip.mediaId]?.path}>{project.media[primary.clip.mediaId]?.path ?? 'missing'}</dd>
            </dl>
            <div className="row">
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={primary.clip.enabled}
                  onChange={(e) => {
                    for (const c of clips) setProps(c.clip.id, { enabled: e.target.checked }, e.target.checked ? 'Enable clip' : 'Disable clip', true);
                  }}
                />
                Enabled
              </label>
              <div className="spacer" />
              {primary.clip.linkId && (
                <button className="btn ghost" onClick={() => edit('Unlink', (s) => unlinkClips(s, [primary.clip.id]))}>
                  Unlink A/V
                </button>
              )}
            </div>
            <div className="section-title">Fades</div>
            {(['fadeIn', 'fadeOut'] as const).map((k) => (
              <Slider
                key={k}
                label={k === 'fadeIn' ? 'Fade in' : 'Fade out'}
                testid={`insp-${k}`}
                value={primary.clip[k]}
                min={0}
                max={Math.min(primary.clip.duration, Math.round(fps * 5))}
                step={1}
                fmt={(v) => `${(v / fps).toFixed(2)}s`}
                onPreview={(v) => previewEdit((s) => setClipFades(s, primary.clip.id, { [k]: v }))}
                onCommit={(v) => (clearPreview(), edit(k === 'fadeIn' ? 'Fade in' : 'Fade out', (s) => setClipFades(s, primary.clip.id, { [k]: v })))}
              />
            ))}
            {video && (
              <>
                <div className="section-title">Transform</div>
                {(
                  [
                    ['Scale', 'scale', 0.1, 4, 0.01, (v: number) => `${Math.round(v * 100)}%`],
                    ['Position X', 'x', -seq.settings.width, seq.settings.width, 1, (v: number) => `${Math.round(v)}`],
                    ['Position Y', 'y', -seq.settings.height, seq.settings.height, 1, (v: number) => `${Math.round(v)}`],
                    ['Rotation', 'rotation', -180, 180, 0.5, (v: number) => `${v.toFixed(1)}°`],
                    ['Opacity', 'opacity', 0, 1, 0.01, (v: number) => `${Math.round(v * 100)}%`],
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
                  <label>Background</label>
                  <select className="input" value={video.clip.fill ?? 'none'} onChange={(e) => setProps(video.clip.id, { fill: e.target.value as 'none' | 'blur' }, 'Background fill', true)}>
                    <option value="none">Black</option>
                    <option value="blur">Blurred image</option>
                  </select>
                  <span />
                </div>
                <div className="insp-row">
                  <label>Motion</label>
                  <select className="input" data-testid="insp-motion" value={video.clip.motion?.kind ?? 'none'} onChange={(e) => setProps(video.clip.id, { motion: { kind: e.target.value as never, amount: e.target.value === 'none' ? 0 : video.clip.motion?.amount || 0.12 } }, 'Camera motion', true)}>
                    {['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'].map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <span />
                </div>
                <button className="btn ghost" onClick={() => setProps(video.clip.id, { transform: { ...DEFAULT_TRANSFORM } }, 'Reset transform', true)}>
                  Reset transform
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
                  onCommit={(v) => setProps(audio.clip.id, { gainDb: v }, 'Set gain', true)}
                />
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
      <div className="section-title">Generated · v{p.version}</div>
      <dl className="kv">
        <dt>QC score</dt>
        <dd data-testid="qc-score">{p.qcScore}/100</dd>
        <dt>Sync</dt>
        <dd>{p.alignment.method === 'transcript' ? 'word-level' : 'pauses'} · {Math.round(p.alignment.confidence * 100)}%</dd>
        <dt>Shots</dt>
        <dd>{p.shots.length} ({p.shots.filter((s) => s.quality === 'strong').length} specific)</dd>
      </dl>
      <div className="row">
        <button className="btn" onClick={() => store.set({ overlay: 'production' })}>Regenerate…</button>
        <button className="btn ghost" onClick={() => void learnFromEdits()} title="Adapt pacing, motion and transitions to how you edited this version">Learn from my edits</button>
      </div>
      {p.qcIssues.length > 0 && <div className="section-title">Quality control</div>}
      {p.qcIssues.map((i, k) => (
        <div key={k} className={`issue ${i.severity}`} onClick={() => i.frame !== undefined && setPlayhead(i.frame)}>
          {i.severity === 'error' ? '●' : i.severity === 'warning' ? '▲' : 'ℹ'} {i.message}
        </div>
      ))}
      <div className="section-title">Shots — why each image</div>
      {p.shots.map((s, k) => (
        <div key={k} className={`report-shot ${s.quality}`} onClick={() => setPlayhead(s.start)} title={s.text}>
          <b>{sec(s.start).toFixed(1)}s</b> · {s.mediaId ? media[s.mediaId]?.name : 'missing visual'}
          <div className="tiny">{s.reasons.join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}
