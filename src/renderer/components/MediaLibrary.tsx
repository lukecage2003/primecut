import { useState } from 'react';
import type { MediaAsset } from '../../core';
import { api } from '../api';
import { addToTimeline, importDialog, importPaths, relink, removeMedia } from '../actions';
import { store, useEditor } from '../store';

export const MEDIA_MIME = 'application/x-primestone-media';

function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function MediaLibrary() {
  const media = useEditor((e) => e.history.present.media);
  const thumbs = useEditor((e) => e.thumbs);
  const status = useEditor((e) => e.mediaStatus);
  const proxies = useEditor((e) => e.proxies);
  const selected = useEditor((e) => e.selectedMedia);
  const [over, setOver] = useState(false);
  const [query, setQuery] = useState('');
  const list = Object.values(media)
    .filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.importedAt.localeCompare(b.importedAt));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map((f) => api.media.pathForFile(f)).filter(Boolean);
    void importPaths(paths);
  };

  return (
    <div
      className="panel glass"
      data-testid="media-library"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="panel-head">
        <h3>Media</h3>
        <div className="spacer" />
        <button className="btn primary" onClick={() => void importDialog()} data-testid="import-media">
          Import
        </button>
      </div>
      <div style={{ padding: '8px 12px 0' }}>
        <input className="input" style={{ width: '100%' }} placeholder="Search media…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="panel-body">
        {list.length === 0 && (
          <div className={`dropzone ${over ? 'over' : ''}`}>
            Drop video, audio or images here
            <br />
            <span className="tiny">Files are referenced, never modified or copied.</span>
          </div>
        )}
        <div className="media-grid">
          {list.map((m) => (
            <MediaItem key={m.id} m={m} thumb={thumbs[m.id]} status={status[m.id]} proxied={!!proxies[m.id]} selected={selected === m.id} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MediaItem({ m, thumb, status, proxied, selected }: { m: MediaAsset; thumb?: string; status?: string; proxied: boolean; selected: boolean }) {
  const offline = status === 'missing' || status === 'changed';
  const v = m.probe.video;
  return (
    <div
      className={`media-item ${selected ? 'selected' : ''}`}
      data-testid="media-item"
      data-name={m.name}
      draggable={!offline}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_MIME, m.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => store.setEditor({ selectedMedia: m.id })}
      onDoubleClick={() => !offline && addToTimeline(m.id)}
      title={`${m.path}\n${v ? `${v.width}×${v.height} ${v.codec} ${(v.frameRate.num / v.frameRate.den).toFixed(3)} fps${v.isVFR ? ' (VFR)' : ''}` : ''}${m.probe.audio ? `\n${m.probe.audio.codec} ${m.probe.audio.sampleRate} Hz ${m.probe.audio.channels} ch` : ''}`}
    >
      <div className="media-thumb" style={thumb ? { backgroundImage: `url("pmedia://local/${encodeURIComponent(thumb)}")` } : undefined}>
        {!thumb && (m.kind === 'audio' ? '♪' : '▣')}
        {m.kind !== 'image' && <span className="badge">{fmtDur(m.probe.durationSec)}</span>}
        {offline && <span className="badge warn left">OFFLINE</span>}
        {!offline && v?.isVFR && <span className="badge info left">VFR</span>}
        {!offline && proxied && <span className="badge left" style={{ left: v?.isVFR ? 40 : 5 }}>PROXY</span>}
      </div>
      <div className="media-meta">
        <div className="name">{m.name}</div>
        <div className="row tiny" style={{ gap: 2 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.kind === 'image' ? 'Still' : v ? `${v.width}×${v.height}` : 'Audio'}</span>
          <div className="spacer" />
          {offline ? (
            <button className="btn ghost" style={{ height: 20, padding: '0 6px', fontSize: 11 }} onClick={(e) => (e.stopPropagation(), void relink(m))}>
              Locate…
            </button>
          ) : (
            <button
              className="btn ghost"
              style={{ height: 20, padding: '0 6px', fontSize: 11 }}
              title="Add at playhead (or double-click)"
              data-testid="add-to-timeline"
              onClick={(e) => (e.stopPropagation(), addToTimeline(m.id))}
            >
              +
            </button>
          )}
          <button className="btn ghost" style={{ height: 20, padding: '0 6px', fontSize: 11 }} title="Remove from project" onClick={(e) => (e.stopPropagation(), removeMedia(m.id))}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
