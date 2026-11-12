import { useState } from 'react';
import { type Clip, DEFAULT_TRANSFORM, type Sequence, findClip, framesToTimecode, setClipProps, unlinkClips } from '../../core';
import { clearPreview, edit, previewEdit } from '../actions';
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
  const tc = (f: number) => framesToTimecode(f, rate);

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
        {!primary && (
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
