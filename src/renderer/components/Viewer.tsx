import { useEffect, useRef, useState } from 'react';
import { CAPTION_METRICS, captionBase, framesToTimecode, sequenceDuration } from '../../core';
import { setPlayhead } from '../actions';
import { pause, togglePlay } from '../playback';
import { PreviewEngine } from '../preview';
import { currentProject, currentSequence, store, useEditor } from '../store';

export function Viewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const seqW = useEditor((e) => currentSequence(e).settings.width);
  const seqH = useEditor((e) => currentSequence(e).settings.height);
  const rate = useEditor((e) => currentSequence(e).settings.frameRate);
  const playhead = useEditor((e) => e.playhead);
  const playing = useEditor((e) => e.playing);
  const duration = useEditor((e) => sequenceDuration(currentSequence(e)));
  const empty = duration === 0;

  // Fit the canvas to the available box keeping the sequence aspect ratio.
  useEffect(() => {
    const box = boxRef.current!;
    const ro = new ResizeObserver(() => {
      const r = box.getBoundingClientRect();
      const s = Math.min((r.width - 24) / seqW, (r.height - 24) / seqH);
      setSize({ w: Math.max(1, Math.floor(seqW * s)), h: Math.max(1, Math.floor(seqH * s)) });
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [seqW, seqH]);

  // Imperative render loop: re-render the preview whenever editor state changes.
  useEffect(() => {
    const engine = new PreviewEngine(stageRef.current!, (m) => {
      const e = store.state.editor!;
      return PreviewEngine.srcFor(m, e.proxies, e.mediaStatus[m.id]);
    });
    engineRef.current = engine;
    let last: unknown[] = [];
    const render = () => {
      const e = store.state.editor;
      if (!e) return;
      const key = [currentProject(e), e.playhead, e.playing, e.proxies, e.mediaStatus];
      if (key.every((k, i) => k === last[i])) return;
      last = key;
      engine.render(currentProject(e), currentSequence(e), e.playhead, e.playing, e.peaks);
    };
    const off = store.subscribe(render);
    render();
    return () => {
      off();
      engine.destroy();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setScale(size.w / seqW);
    const e = store.state.editor;
    if (e) engineRef.current?.render(currentProject(e), currentSequence(e), e.playhead, e.playing, e.peaks);
  }, [size, seqW]);

  return (
    <div className="panel glass viewer">
      <div className="panel-head">
        <h3>Programme</h3>
        <div className="spacer" />
        <span className="tiny mono">
          {seqW}×{seqH} · {(rate.num / rate.den).toFixed(3).replace(/\.?0+$/, '')} fps
        </span>
      </div>
      <div className="viewer-stage" ref={boxRef}>
        <div className="viewer-canvas" ref={stageRef} style={{ width: size.w, height: size.h }} data-testid="viewer-canvas">
          {empty && <div className="viewer-empty">Ajoutez des médias à la timeline pour les voir ici</div>}
          <CaptionLayer height={size.h} />
        </div>
      </div>
      <div className="transport">
        <span className="timecode" data-testid="timecode">
          {framesToTimecode(playhead, rate)}
        </span>
        <div className="spacer" />
        <button className="btn ghost icon" title="Aller au début (Début)" onClick={() => (pause(), setPlayhead(0))}>
          ⏮
        </button>
        <button className="btn ghost icon" title="Image précédente (←)" onClick={() => (pause(), setPlayhead(playhead - 1))}>
          ◀
        </button>
        <button className="btn primary icon" title="Lecture / Pause (Espace)" onClick={togglePlay} data-testid="play" disabled={empty} style={{ width: 40 }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="btn ghost icon" title="Image suivante (→)" onClick={() => (pause(), setPlayhead(playhead + 1))}>
          ▶
        </button>
        <button className="btn ghost icon" title="Aller à la fin (Fin)" onClick={() => (pause(), setPlayhead(duration))}>
          ⏭
        </button>
        <div className="spacer" />
        <span className="timecode tiny" style={{ color: 'var(--text-3)', fontSize: 12 }}>
          {framesToTimecode(duration, rate)}
        </span>
      </div>
    </div>
  );
}

/** Draws the active captions with the same relative metrics as the exported ASS styles. */
function CaptionLayer({ height }: { height: number }) {
  const seqSize = useEditor((e) => currentSequence(e).settings);
  const currentW = (height * seqSize.width) / seqSize.height;
  // select a primitive key (stable snapshot), then resolve the captions
  const key = useEditor((e) =>
    currentSequence(e)
      .captions.filter((c) => c.start <= e.playhead && e.playhead < c.end)
      .map((c) => c.id)
      .join(','),
  );
  const all = useEditor((e) => currentSequence(e).captions);
  const ids = new Set(key.split(','));
  const caps = all.filter((c) => ids.has(c.id));
  return (
    <div className="caption-layer" data-testid="caption-layer">
      {caps.map((c) => {
        const m = CAPTION_METRICS[c.style];
        const [first, ...rest] = c.text.split('\n');
        // same reference size as the export (portrait formats scale on the width)
        const sw = currentW;
        const base = height > sw ? Math.min(height, sw * 1.2) : height;
        const style: React.CSSProperties = { fontSize: m.size * base };
        if (c.style === 'subtitle') style.bottom = m.marginV * base;
        if (c.style === 'lower-third') style.bottom = m.marginV * base;
        return (
          <div key={c.id} className={`cap ${c.style}`} style={style} data-style={c.style}>
            {c.style === 'lower-third' ? (
              <>
                {first}
                {rest.length > 0 && <span className="sub">{rest.join(' ')}</span>}
              </>
            ) : (
              c.text
            )}
          </div>
        );
      })}
    </div>
  );
}
