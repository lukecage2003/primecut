import { useState } from 'react';
import { type ExportSettings, framesToTimecode, sequenceDuration } from '../../core';
import { api } from '../api';
import { edit, startExport } from '../actions';
import { currentSequence, store, useEditor, useStore } from '../store';

const QUALITY: { id: string; label: string; detail: string; s: Partial<ExportSettings> }[] = [
  { id: 'quality', label: 'Quality', detail: 'CRF 18 · slow · default', s: { crf: 18, preset: 'slow' } },
  { id: 'deep', label: 'Deep Quality', detail: 'CRF 14 · slow · larger files', s: { crf: 14, preset: 'slow' } },
  { id: 'balanced', label: 'Balanced', detail: 'CRF 20 · medium · faster', s: { crf: 20, preset: 'medium' } },
];

export function ExportDialog() {
  const project = useEditor((e) => e.history.present);
  const seq = useEditor((e) => currentSequence(e));
  const profile = useStore((s) => s.settings?.performanceProfile);
  const s = project.exportSettings;
  const [output, setOutput] = useState<string>('');
  const duration = sequenceDuration(seq);
  const q = QUALITY.find((x) => x.s.crf === s.crf && x.s.preset === s.preset)?.id ?? 'custom';
  const setS = (patch: Partial<ExportSettings>) => edit('Export settings', (_seq, _m, p) => Object.assign(p.exportSettings, patch));
  const close = () => store.set({ overlay: null });

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal glass" style={{ width: 580 }} data-testid="export-dialog">
        <h2>Export</h2>
        <dl className="kv">
          <dt>Sequence</dt>
          <dd>{seq.name}</dd>
          <dt>Format</dt>
          <dd>{seq.settings.width}×{seq.settings.height} · {(seq.settings.frameRate.num / seq.settings.frameRate.den).toFixed(3)} fps · {seq.settings.sampleRate} Hz</dd>
          <dt>Duration</dt>
          <dd>{framesToTimecode(duration, seq.settings.frameRate)} ({duration} frames)</dd>
        </dl>
        <label className="field">
          <span>Output file</span>
          <div className="row">
            <input className="input" style={{ flex: 1 }} value={output} readOnly placeholder="Choose where to save…" data-testid="export-path" />
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
              Browse…
            </button>
          </div>
        </label>
        <div className="field">
          <span>Quality</span>
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
            <span>Video codec</span>
            <select className="input" value={s.videoCodec} onChange={(e) => setS({ videoCodec: e.target.value as 'h264' | 'hevc' })}>
              <option value="h264">H.264 / AVC</option>
              <option value="hevc">H.265 / HEVC</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Encoder</span>
            <select className="input" value={s.hardware} onChange={(e) => setS({ hardware: e.target.value as 'auto' | 'cpu' })}>
              <option value="cpu">CPU (best quality)</option>
              <option value="auto">Hardware if verified</option>
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
          <div className="tiny">Hardware encoding is used only with the Balanced performance profile (Settings). Current profile keeps the CPU encoder.</div>
        )}
        <div className="tiny">The file is rendered to a temporary name, then verified (streams, resolution, exact frame count) before it is published.</div>
        <div className="actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!output || duration === 0}
            data-testid="export-start"
            onClick={async () => {
              await startExport(output);
            }}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
