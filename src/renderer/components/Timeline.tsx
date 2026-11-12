import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type Clip,
  type MediaAsset,
  type Sequence,
  type Track,
  addTrack,
  clipEnd,
  framesToTimecode,
  moveClips,
  rateToNumber,
  rollEdit,
  sequenceDuration,
  setTrackProps,
  slideClip,
  slipClip,
  snapPoints,
  splitAt,
  trimClip,
  linkedGroup,
  removeMarker,
} from '../../core';
import { addToTimeline, clearPreview, edit, previewEdit, setPlayhead, splitAtPlayhead } from '../actions';
import { pause } from '../playback';
import { type Tool, currentProject, currentSequence, store, useEditor } from '../store';
import { MEDIA_MIME } from './MediaLibrary';
import { PEAKS_PER_SECOND } from '../peaks';

const VH = 64;
const AH = 56;
const RULER = 28;
const SNAP_PX = 10;

const TOOLS: { id: Tool; label: string; key: string; tip: string }[] = [
  { id: 'select', label: '↖', key: 'V', tip: 'Selection — move clips, trim edges' },
  { id: 'razor', label: '✂', key: 'C', tip: 'Razor — click a clip to cut it' },
  { id: 'ripple', label: '⇤', key: 'B', tip: 'Ripple edit — trim and shift following clips' },
  { id: 'roll', label: '⇹', key: 'N', tip: 'Rolling edit — move a cut between two clips' },
  { id: 'slip', label: '⇆', key: 'Y', tip: 'Slip — change the source in/out of a clip' },
  { id: 'slide', label: '⇋', key: 'U', tip: 'Slide — move a clip between its neighbours' },
];

function displayTracks(seq: Sequence): Track[] {
  const v = seq.tracks.filter((t) => t.kind === 'video').reverse();
  const a = seq.tracks.filter((t) => t.kind === 'audio');
  return [...v, ...a];
}

function kindIndex(seq: Sequence, track: Track): number {
  return seq.tracks.filter((t) => t.kind === track.kind).indexOf(track);
}

interface Drag {
  mode: 'move' | 'trim-in' | 'trim-out' | 'roll' | 'slip' | 'slide';
  clipId: string;
  otherId?: string;
  startX: number;
  ripple: boolean;
  originKindIndex: number;
  kind: 'video' | 'audio';
  moved: boolean;
  delta: number;
  trackDelta: { video: number; audio: number };
}

export function Timeline() {
  const tool = useEditor((e) => e.tool);
  const zoom = useEditor((e) => e.zoom);
  const snapping = useEditor((e) => e.snapping);
  const seq = useEditor((e) => currentSequence(e));
  const duration = sequenceDuration(seq);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(1000);
  const [scrollLeft, setScrollLeft] = useState(0);
  const fps = rateToNumber(seq.settings.frameRate);
  const contentW = Math.max(viewW, (duration + fps * 20) * zoom);
  const tracks = displayTracks(seq);
  const firstAudio = tracks.findIndex((t) => t.kind === 'audio');

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view during playback.
  useEffect(
    () =>
      store.subscribe(() => {
        const e = store.state.editor;
        const el = scrollRef.current;
        if (!e || !el || !e.playing) return;
        const x = e.playhead * e.zoom;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }),
    [],
  );

  const frameAt = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - r.left + el.scrollLeft) / store.state.editor!.zoom));
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const el = scrollRef.current!;
    const f = frameAt(e.clientX);
    const z0 = store.state.editor!.zoom;
    const z = Math.max(0.05, Math.min(64, z0 * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    store.setEditor({ zoom: z });
    requestAnimationFrame(() => (el.scrollLeft = Math.max(0, f * z - (e.clientX - el.getBoundingClientRect().left))));
  };

  const zoomToFit = () => {
    const d = Math.max(duration, fps * 10);
    store.setEditor({ zoom: Math.max(0.05, (viewW - 40) / d) });
  };

  return (
    <div className={`panel glass timeline tool-${tool}`} data-testid="timeline">
      <div className="tl-toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={`btn icon ${tool === t.id ? 'active' : 'ghost'}`} title={`${t.tip} (${t.key})`} data-testid={`tool-${t.id}`} onClick={() => store.setEditor({ tool: t.id })}>
            {t.label}
          </button>
        ))}
        <div className="sep" />
        <button className="btn ghost" title="Split at playhead (S / Ctrl+K)" onClick={splitAtPlayhead} data-testid="split">
          Split
        </button>
        <button className={`btn ${snapping ? 'active' : 'ghost'}`} title="Snapping" onClick={() => store.setEditor((x) => ({ snapping: !x.snapping }))}>
          Snap
        </button>
        <div className="sep" />
        <button className="btn ghost" onClick={() => edit('Add video track', (s) => addTrack(s, 'video'))}>
          + Video track
        </button>
        <button className="btn ghost" onClick={() => edit('Add audio track', (s) => addTrack(s, 'audio'))}>
          + Audio track
        </button>
        <div className="spacer" />
        <span className="tiny mono">{framesToTimecode(duration, seq.settings.frameRate)}</span>
        <div className="sep" />
        <button className="btn ghost" onClick={zoomToFit} title="Zoom to fit">
          Fit
        </button>
        <input
          type="range"
          min={-3}
          max={4.15}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => store.setEditor({ zoom: Math.exp(Number(e.target.value)) })}
          style={{ width: 120, accentColor: 'var(--accent)' }}
          aria-label="Zoom"
        />
      </div>
      <div className="tl-main">
        <div className="tl-heads" ref={headsRef}>
          <div className="tl-ruler-spacer" />
          {tracks.map((t, i) => (
            <div key={t.id}>
              {i === firstAudio && i > 0 && <div className="tl-divider" />}
              <TrackHead track={t} />
            </div>
          ))}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onWheel={onWheel}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScrollLeft(el.scrollLeft);
            if (headsRef.current) headsRef.current.scrollTop = el.scrollTop;
          }}
        >
          <div className="tl-content" style={{ width: contentW }}>
            <Ruler width={viewW} scrollLeft={scrollLeft} zoom={zoom} seq={seq} frameAt={frameAt} />
            {tracks.map((t, i) => (
              <div key={t.id}>
                {i === firstAudio && i > 0 && <div className="tl-divider" />}
                <TrackRow track={t} seq={seq} zoom={zoom} frameAt={frameAt} />
              </div>
            ))}
            <Playhead />
            <SnapLine />
            {seq.markers.map((m) => (
              <div
                key={m.id}
                className="marker"
                title={`${m.name} — ${framesToTimecode(m.frame, seq.settings.frameRate)} (double-click to remove)`}
                style={{ left: m.frame * zoom, background: m.color }}
                onClick={() => setPlayhead(m.frame)}
                onDoubleClick={() => edit('Remove marker', (s) => removeMarker(s, m.id))}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackHead({ track }: { track: Track }) {
  const h = track.kind === 'video' ? VH : AH;
  const toggle = (prop: 'locked' | 'disabled') => edit(`${prop === 'locked' ? 'Lock' : track.kind === 'video' ? 'Hide' : 'Mute'} ${track.name}`, (s) => setTrackProps(s, track.id, { [prop]: !track[prop] }));
  return (
    <div className="tl-head" style={{ height: h }} data-testid={`head-${track.name}`}>
      <span className="tname">{track.name}</span>
      <button className={`tbtn ${track.locked ? 'on' : ''}`} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => toggle('locked')}>
        {track.locked ? '🔒' : '🔓'}
      </button>
      <button className={`tbtn ${track.disabled ? 'on' : ''}`} title={track.kind === 'video' ? 'Toggle track output' : 'Mute track'} onClick={() => toggle('disabled')}>
        {track.kind === 'video' ? (track.disabled ? '◌' : '◉') : track.disabled ? 'M' : '♪'}
      </button>
    </div>
  );
}

function Ruler({ width, scrollLeft, zoom, seq, frameAt }: { width: number; scrollLeft: number; zoom: number; seq: Sequence; frameAt: (x: number) => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rate = seq.settings.frameRate;
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = RULER * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${RULER}px`;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, RULER);
    const styles = getComputedStyle(document.documentElement);
    g.strokeStyle = styles.getPropertyValue('--text-3');
    g.fillStyle = styles.getPropertyValue('--text-2');
    g.font = '10px ' + styles.getPropertyValue('--mono');
    const fps = rateToNumber(rate);
    const candidates = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps * 2), Math.round(fps * 5), Math.round(fps * 10), Math.round(fps * 30), Math.round(fps * 60), Math.round(fps * 300), Math.round(fps * 600)];
    const step = candidates.find((s) => s * zoom >= 90) ?? candidates.at(-1)!;
    const minor = step / 5 >= 1 ? step / 5 : step;
    const f0 = Math.floor(scrollLeft / zoom / minor) * minor;
    const f1 = (scrollLeft + width) / zoom;
    g.beginPath();
    for (let f = f0; f <= f1; f += minor) {
      const x = Math.round(f * zoom - scrollLeft) + 0.5;
      const major = Math.round(f) % step === 0;
      g.moveTo(x, major ? 12 : 20);
      g.lineTo(x, RULER);
      if (major) g.fillText(framesToTimecode(Math.round(f), rate), x + 3, 10);
    }
    g.stroke();
  }, [width, scrollLeft, zoom, rate]);
  return (
    <div
      className="tl-ruler"
      data-testid="ruler"
      onPointerDown={(e) => {
        pause();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setPlayhead(frameAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) setPlayhead(frameAt(e.clientX));
      }}
    >
      <canvas ref={ref} style={{ left: scrollLeft }} />
    </div>
  );
}

function Playhead() {
  const x = useEditor((e) => e.playhead * e.zoom);
  return <div className="playhead" style={{ left: x }} data-testid="playhead" />;
}

function SnapLine() {
  const x = useEditor((e) => (e.snapAt === null ? null : e.snapAt * e.zoom));
  return x === null ? null : <div className="snap-line" style={{ left: x }} />;
}

function TrackRow({ track, seq, zoom, frameAt }: { track: Track; seq: Sequence; zoom: number; frameAt: (x: number) => number }) {
  const h = track.kind === 'video' ? VH : AH;
  const [dropping, setDropping] = useState(false);
  const idx = kindIndex(seq, track);
  return (
    <div
      className={`tl-track ${track.locked ? 'locked' : ''} ${dropping ? 'dropping' : ''}`}
      style={{ height: h }}
      data-track={track.name}
      data-kind={track.kind}
      data-index={idx}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) store.setEditor({ selection: [] });
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MEDIA_MIME) && !track.locked) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const id = e.dataTransfer.getData(MEDIA_MIME);
        if (!id) return;
        e.preventDefault();
        const audioCount = seq.tracks.filter((t) => t.kind === 'audio').length;
        if (track.kind === 'video') addToTimeline(id, frameAt(e.clientX), idx, Math.min(idx, audioCount - 1));
        else addToTimeline(id, frameAt(e.clientX), 0, idx);
      }}
    >
      {track.clips.map((c) => (
        <ClipView key={c.id} clip={c} track={track} zoom={zoom} frameAt={frameAt} />
      ))}
    </div>
  );
}

const ClipView = memo(function ClipView({ clip, track, zoom, frameAt }: { clip: Clip; track: Track; zoom: number; frameAt: (x: number) => number }) {
  const media = useEditor((e) => currentProject(e).media[clip.mediaId]);
  const selected = useEditor((e) => e.selection.includes(clip.id));
  const thumb = useEditor((e) => e.thumbs[clip.mediaId]);
  const peaks = useEditor((e) => e.peaks[clip.mediaId]);
  const status = useEditor((e) => e.mediaStatus[clip.mediaId]);
  const drag = useRef<Drag | null>(null);
  const offline = status === 'missing' || status === 'changed';
  const w = Math.max(2, clip.duration * zoom);
  const kindClass = track.kind === 'audio' ? 'audio' : media?.kind === 'image' ? 'image' : 'video';

  const begin = (e: React.PointerEvent, mode: Drag['mode']) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const ed = store.state.editor!;
    const seq = ed.history.present.sequences[ed.history.present.activeSequenceId]!;
    const tool = ed.tool;
    if (tool === 'razor') {
      const f = frameAt(e.clientX);
      edit('Razor', (s) => splitAt(s, f, [clip.id]));
      return;
    }
    // selection
    const group = linkedGroup(seq, clip.id).map((c) => c.id);
    if (e.shiftKey) {
      const has = ed.selection.includes(clip.id);
      store.setEditor({ selection: has ? ed.selection.filter((id) => !group.includes(id)) : [...new Set([...ed.selection, ...group])] });
    } else if (!ed.selection.includes(clip.id)) {
      store.setEditor({ selection: group });
    }
    if (track.locked) return;
    let m = mode;
    let otherId: string | undefined;
    if (mode === 'move' && tool === 'slip') m = 'slip';
    if (mode === 'move' && tool === 'slide') m = 'slide';
    if ((mode === 'trim-in' || mode === 'trim-out') && tool === 'roll') {
      const i = track.clips.findIndex((c) => c.id === clip.id);
      const other = mode === 'trim-out' ? track.clips[i + 1] : track.clips[i - 1];
      const adjacent = other && (mode === 'trim-out' ? other.start === clipEnd(clip) : clipEnd(other) === clip.start);
      if (adjacent) {
        m = 'roll';
        otherId = other.id;
      }
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      mode: m,
      clipId: m === 'roll' && mode === 'trim-in' ? otherId! : clip.id,
      otherId: m === 'roll' && mode === 'trim-in' ? clip.id : otherId,
      startX: e.clientX,
      ripple: tool === 'ripple',
      originKindIndex: kindIndex(seq, seq.tracks.find((t) => t.id === track.id)!),
      kind: track.kind,
      moved: false,
      delta: 0,
      trackDelta: { video: 0, audio: 0 },
    };
  };

  const op = (d: Drag) => (s: Sequence, media: Record<string, MediaAsset>) => {
    switch (d.mode) {
      case 'move':
        return moveClips(s, store.state.editor!.selection.includes(d.clipId) ? store.state.editor!.selection : [d.clipId], d.delta, d.trackDelta);
      case 'trim-in':
        return trimClip(s, media, d.clipId, 'in', d.delta, d.ripple);
      case 'trim-out':
        return trimClip(s, media, d.clipId, 'out', d.delta, d.ripple);
      case 'roll':
        return rollEdit(s, media, d.clipId, d.otherId!, d.delta);
      case 'slip':
        return slipClip(s, media, d.clipId, -d.delta);
      case 'slide':
        return slideClip(s, media, d.clipId, d.delta);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const ed = store.state.editor!;
    let delta = Math.round((e.clientX - d.startX) / ed.zoom);
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
    d.moved = true;
    const base = ed.history.present.sequences[ed.history.present.activeSequenceId]!;
    let snapAt: number | null = null;
    if (ed.snapping && d.mode !== 'slip') {
      const moving = new Set(d.mode === 'move' ? ed.selection.flatMap((id) => linkedGroup(base, id).map((c) => c.id)) : [d.clipId]);
      const pts = snapPoints(base, moving, ed.playhead);
      const orig = base.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId)!;
      const edges = d.mode === 'trim-in' ? [orig.start] : d.mode === 'trim-out' || d.mode === 'roll' ? [clipEnd(orig)] : [orig.start, clipEnd(orig)];
      const thr = SNAP_PX / ed.zoom;
      let best = thr + 1;
      for (const edge of edges)
        for (const p of pts) {
          const dist = Math.abs(edge + delta - p);
          if (dist < best) {
            best = dist;
            snapAt = p;
            delta = p - edge;
          }
        }
      if (best > thr) snapAt = null;
    }
    d.delta = delta;
    if (d.mode === 'move') {
      const row = (document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[]).find((el) => el.classList.contains('tl-track'));
      if (row && row.dataset.kind === d.kind) d.trackDelta = { video: 0, audio: 0, [d.kind]: Number(row.dataset.index) - d.originKindIndex };
    }
    store.setEditor({ snapAt });
    previewEdit(op(d));
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    clearPreview();
    if (!d || !d.moved) return;
    const labels = { move: 'Move', 'trim-in': d.ripple ? 'Ripple trim' : 'Trim', 'trim-out': d.ripple ? 'Ripple trim' : 'Trim', roll: 'Roll edit', slip: 'Slip', slide: 'Slide' };
    edit(labels[d.mode], op(d));
  };

  return (
    <div
      className={`clip ${kindClass} ${selected ? 'selected' : ''} ${clip.enabled ? '' : 'disabled'} ${offline ? 'offline' : ''}`}
      style={{ left: clip.start * zoom, width: w }}
      data-testid="clip"
      data-clip={clip.id}
      data-kind={track.kind}
      data-start={clip.start}
      data-duration={clip.duration}
      onPointerDown={(e) => begin(e, 'move')}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {track.kind === 'video' && thumb && <div className="strip" style={{ backgroundImage: `url("pmedia://local/${encodeURIComponent(thumb)}")` }} />}
      {track.kind === 'audio' && peaks && <Wave peaks={peaks} clip={clip} width={w} height={AH - 22} fps={0} />}
      <div className="label">
        {offline ? '⚠ ' : ''}
        {clip.name}
      </div>
      {clip.linkId && <span className="link">🔗</span>}
      {w > 18 && (
        <>
          <div className="edge in" data-testid="edge-in" onPointerDown={(e) => begin(e, 'trim-in')} onPointerMove={onMove} onPointerUp={onUp} />
          <div className="edge out" data-testid="edge-out" onPointerDown={(e) => begin(e, 'trim-out')} onPointerMove={onMove} onPointerUp={onUp} />
        </>
      )}
    </div>
  );
});

function Wave({ peaks, clip, width, height }: { peaks: Uint8Array; clip: Clip; width: number; height: number; fps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rate = useEditor((e) => currentSequence(e).settings.frameRate);
  useEffect(() => {
    const c = ref.current!;
    const cw = Math.min(8000, Math.max(1, Math.round(width)));
    c.width = cw;
    c.height = height;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, cw, height);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    const durSec = (clip.duration * rate.den) / rate.num;
    const p0 = clip.sourceIn * PEAKS_PER_SECOND;
    const per = (durSec * PEAKS_PER_SECOND) / cw;
    const gain = Math.pow(10, clip.gainDb / 20);
    const mid = height / 2;
    for (let x = 0; x < cw; x++) {
      let m = 0;
      const a = Math.floor(p0 + x * per);
      const b = Math.max(a + 1, Math.floor(p0 + (x + 1) * per));
      for (let i = a; i < b && i < peaks.length; i++) m = Math.max(m, peaks[i]!);
      const amp = Math.min(1, (m / 255) * gain) * mid;
      g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
    }
  }, [peaks, clip.sourceIn, clip.duration, clip.gainDb, width, height, rate]);
  return <canvas ref={ref} />;
}
