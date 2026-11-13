/**
 * P-CORE Studio: preview, audio response, expression controls, placement, appearance, markers and
 * independent export with verified transparency. Settings are brand-wide (app settings); the
 * placement mode is a production preference (learnable, reversible).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addMarker, framesToSeconds } from '../../core';
import { DEFAULT_PCORE_SETTINGS, type PCoreSettings, markerEvents } from '../../pcore/expression';
import { DEFAULT_PLACEMENT, type PlacementSettings } from '../../pcore/placement';
import { PCORE_QUALITY, type PCoreQuality } from '../../pcore/quality';
import type { AlphaCheck, PCoreFormat } from '../../shared/api';
import { mediaUrl } from '../../shared/api';
import { api } from '../api';
import { edit, updateSettings } from '../actions';
import { currentProject, currentSequence, store, toast, useEditor, useStore } from '../store';

const STATE_COLORS: Record<string, string> = { idle: '#333', silence: '#555', listening: '#7a6a10', speaking: '#c9a400', emphasis: '#ffd400', intense: '#ff8a00', focus: '#3aa0ff', transition: '#b45cff', reveal: '#ffffff' };
const RES: Record<string, [number, number]> = { '1920×1080': [1920, 1080], '3840×2160': [3840, 2160], '1080×1920': [1080, 1920], '1080×1080': [1080, 1080] };

function Range({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="field" style={{ minWidth: 150 }}>
      <span>
        {label} <b>{fmt ? fmt(value) : value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function PCoreStudio() {
  const e = useEditor((x) => x)!;
  const appSettings = useStore((s) => s.settings)!;
  const project = currentProject(e);
  const seq = currentSequence(e);
  const fpsR = seq.settings.frameRate;
  const fps = fpsR.num / fpsR.den;
  const audios = Object.values(project.media).filter((m) => m.kind === 'audio' || (m.probe.audio && !m.probe.video));
  const [audioId, setAudioId] = useState<string>(seq.production?.narrationMediaId ?? audios[0]?.id ?? '');
  const [start, setStart] = useState(() => +framesToSeconds(e.playhead, fpsR).toFixed(2));
  const [dur, setDur] = useState(8);
  const [composition, setComposition] = useState<'core' | 'floating' | 'minimal'>('core');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [graph, setGraph] = useState<Awaited<ReturnType<typeof api.pcore.analyze>> | null>(null);
  const [format, setFormat] = useState<PCoreFormat>('mov-prores4444');
  const [res, setRes] = useState('1920×1080');
  const [withAudio, setWithAudio] = useState(false);
  const [lastExport, setLastExport] = useState<{ path: string; check: AlphaCheck; quality: PCoreQuality; renderSec: number; fps: number } | null>(null);
  const [exportQuality, setExportQuality] = useState<PCoreQuality>('final');
  const [mode, setMode] = useState<'off' | 'hero' | 'always'>('hero');
  const canvas = useRef<HTMLCanvasElement>(null);
  const s: PCoreSettings = { ...DEFAULT_PCORE_SETTINGS, ...(appSettings.pcore?.settings ?? {}) };
  const pl: PlacementSettings = { ...DEFAULT_PLACEMENT, ...(appSettings.pcore?.placement ?? {}) };
  const setS = (p: Partial<PCoreSettings>) => void updateSettings({ pcore: { ...appSettings.pcore, settings: { ...appSettings.pcore?.settings, ...p } } });
  const setPl = (p: Partial<PlacementSettings>) => void updateSettings({ pcore: { ...appSettings.pcore, placement: { ...appSettings.pcore?.placement, ...p } } });
  const audioPath = project.media[audioId]?.path ?? null;
  const events = useMemo(() => markerEvents(seq.markers, fps), [seq.markers, fps]);
  const req = { audioPath, offsetSec: start, durationSec: dur, fps: fpsR, composition, events };

  useEffect(() => api.pcore.onProgress(setProgress), []);
  useEffect(() => {
    void api.production.preferences().then((p) => setMode(p.current.pcore ?? 'hero'));
  }, []);
  // audio response graph (recomputed when the window or the reactions change)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.pcore.analyze(req).then((g) => alive && setGraph(g), (err) => toast(String(err), 'error'));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioId, start, dur, JSON.stringify(s), JSON.stringify(events)]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !graph) return;
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    g.clearRect(0, 0, W, H);
    const n = graph.states.length;
    const x = (i: number) => (i / Math.max(1, n - 1)) * W;
    graph.states.forEach((st, i) => {
      g.fillStyle = STATE_COLORS[st] ?? '#444';
      g.fillRect(x(i), H - 10, W / n + 1, 10);
    });
    const line = (vals: number[], color: string) => {
      g.strokeStyle = color;
      g.beginPath();
      vals.forEach((v, i) => (i ? g.lineTo(x(i), (H - 14) * (1 - v)) : g.moveTo(x(i), (H - 14) * (1 - v))));
      g.stroke();
    };
    if (graph.voice.length) {
      line(graph.voice.map((v) => v.low), '#7a5c00');
      line(graph.voice.map((v) => v.high), '#5c7a99');
      line(graph.voice.map((v) => v.env), '#ffd400');
    }
    line(graph.energy, '#ffffff');
  }, [graph]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setProgress(0);
    try {
      await fn();
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(ev) => ev.target === ev.currentTarget && store.set({ overlay: null })}>
      <div className="modal glass" style={{ width: 1040, maxHeight: '92vh', overflow: 'auto' }} data-testid="pcore-studio">
        <h2>Studio P-CORE</h2>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          {/* A. viewport */}
          <div style={{ width: 360 }}>
            <div className="section-title">Aperçu</div>
            <div style={{ width: 360, height: 360, borderRadius: 8, background: 'repeating-conic-gradient(#222 0% 25%, #2c2c2c 0% 50%) 50% / 24px 24px', display: 'grid', placeItems: 'center' }}>
              {preview ? <video key={preview} src={mediaUrl(preview)} autoPlay loop controls style={{ width: 360, height: 360 }} data-testid="pcore-preview" /> : <span className="muted">{busy ? `${busy} ${Math.round(progress * 100)}%` : 'Pas encore d’aperçu'}</span>}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={!!busy} data-testid="pcore-render-preview" onClick={() => run('Calcul de l’aperçu', async () => setPreview(await api.pcore.preview(e.file, { ...req, size: 540 })))}>
                Calculer l'aperçu
              </button>
              <select className="input" style={{ width: 120 }} value={composition} onChange={(ev) => setComposition(ev.target.value as never)}>
                <option value="core">Noyau</option>
                <option value="floating">Logo flottant</option>
                <option value="minimal">Minimal</option>
              </select>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <label className="field">
                <span>Narration</span>
                <select className="input" value={audioId} onChange={(ev) => setAudioId(ev.target.value)}>
                  <option value="">(silence)</option>
                  {audios.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ width: 80 }}>
                <span>Début (s)</span>
                <input className="input" type="number" step={0.5} value={start} onChange={(ev) => setStart(Math.max(0, Number(ev.target.value)))} />
              </label>
              <label className="field" style={{ width: 80 }}>
                <span>Durée (s)</span>
                <input className="input" type="number" step={1} min={1} max={60} value={dur} onChange={(ev) => setDur(Math.min(60, Math.max(1, Number(ev.target.value))))} />
              </label>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            {/* B. audio response */}
            <div className="section-title">Réponse audio</div>
            <canvas ref={canvas} width={620} height={120} style={{ width: '100%', height: 120, background: '#0b0b0b', borderRadius: 6 }} data-testid="pcore-graph" />
            <div className="tiny">
              Jaune : enveloppe de la voix · brun/bleu : graves/aigus · blanc : énergie de P-CORE · bande : état (
              {Object.entries(STATE_COLORS).map(([k, c]) => (
                <span key={k} style={{ color: c === '#333' ? '#888' : c, marginRight: 6 }}>
                  {k}
                </span>
              ))}
              )
            </div>
            {/* C. expression controls */}
            <div className="section-title">Expression</div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Range label="Intensité" value={s.intensity} min={0.3} max={1.5} step={0.05} onChange={(v) => setS({ intensity: v })} />
              <Range label="Transitions (ms)" value={s.transitionMs} min={100} max={1500} step={50} onChange={(v) => setS({ transitionMs: v })} />
              <Range label="Niveau de parole" value={s.speakingLevel} min={0.1} max={0.8} step={0.01} onChange={(v) => setS({ speakingLevel: v })} />
              <Range label="Seuil d'emphase" value={s.emphasisOnset} min={0.1} max={0.8} step={0.01} onChange={(v) => setS({ emphasisOnset: v })} />
              <Range label="Niveau intense" value={s.intenseLevel} min={0.4} max={1} step={0.01} onChange={(v) => setS({ intenseLevel: v })} />
              <Range label="Repos après (s)" value={s.idleAfter} min={0.3} max={5} step={0.1} onChange={(v) => setS({ idleAfter: v })} />
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={s.semantic} onChange={(ev) => setS({ semantic: ev.target.checked })} /> Réagir au script (questions, révélations, sections)
              </label>
            </div>
            {/* F. timeline markers */}
            <div className="section-title">Événements de timeline (marqueurs à la tête de lecture)</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {(['REVEAL', 'FOCUS', 'TRANSITION', 'EMPHASIS', 'INTENSE'] as const).map((k) => (
                <button key={k} className="btn ghost" onClick={() => edit(`P-CORE ${k}`, (sq) => void addMarker(sq, e.playhead, `P-CORE: ${k}`, '#ffd400'))}>
                  + {k}
                </button>
              ))}
              <span className="tiny">{events.length} marqueur(s) P-CORE dans cette séquence</span>
            </div>
            {/* D. placement */}
            <div className="section-title">Placement adaptatif (Script → Vidéo)</div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="field">
                <span>Présence</span>
                <select
                  className="input"
                  value={mode}
                  data-testid="pcore-mode"
                  onChange={async (ev) => {
                    const m = ev.target.value as typeof mode;
                    setMode(m);
                    const p = await api.production.preferences();
                    await api.production.setPreferences({ ...p.current, pcore: m }, `P-CORE presence: ${m}`);
                  }}
                >
                  <option value="off">Désactivé</option>
                  <option value="hero">Là où il n'y a pas d'illustration</option>
                  <option value="always">Toujours (discret sur les images)</option>
                </select>
              </label>
              <label className="field">
                <span>Coin sur les images</span>
                <select className="input" value={pl.corner} onChange={(ev) => setPl({ corner: ev.target.value as never })}>
                  {['top-right', 'top-left', 'bottom-right', 'bottom-left'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <Range label="Taille centrale" value={pl.heroScale} min={0.3} max={1} step={0.02} onChange={(v) => setPl({ heroScale: v })} />
              <Range label="Taille en coin" value={pl.cornerScale} min={0.1} max={0.45} step={0.01} onChange={(v) => setPl({ cornerScale: v })} />
              <Range label="Bande des sous-titres" value={pl.subtitleBand} min={0} max={0.35} step={0.01} onChange={(v) => setPl({ subtitleBand: v })} />
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={pl.growOnReveal} onChange={(ev) => setPl({ growOnReveal: ev.target.checked })} /> Agrandir lors des révélations
              </label>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" data-testid="pcore-fixed" checked={!!pl.manual?.enabled} onChange={(ev) => setPl({ manual: { x: 0.5, y: 0.45, size: 0.5, ...pl.manual, enabled: ev.target.checked } })} /> Position fixe (remplace le placement adaptatif dans toutes les productions)
              </label>
              {pl.manual?.enabled && (
                <>
                  <Range label="Horizontal" value={pl.manual.x} min={0} max={1} step={0.01} onChange={(v) => setPl({ manual: { ...pl.manual!, x: v } })} />
                  <Range label="Vertical" value={pl.manual.y} min={0} max={1} step={0.01} onChange={(v) => setPl({ manual: { ...pl.manual!, y: v } })} />
                  <Range label="Taille" value={pl.manual.size} min={0.05} max={1} step={0.01} onChange={(v) => setPl({ manual: { ...pl.manual!, size: v } })} />
                </>
              )}
            </div>
            <div className="tiny">Chaque clip P-CORE est placé sur V2 et reste modifiable : déplacez-le, redimensionnez-le, coupez-le ou supprimez-le comme un autre clip.</div>
            <label className="field" style={{ maxWidth: 260 }}>
              <span>Qualité de rendu dans les productions</span>
              <select className="input" data-testid="pcore-quality" value={appSettings.pcore?.quality ?? 'high'} onChange={(ev) => void updateSettings({ pcore: { ...appSettings.pcore, quality: ev.target.value as PCoreQuality } })}>
                {(Object.keys(PCORE_QUALITY) as PCoreQuality[]).map((q) => (
                  <option key={q} value={q}>
                    {PCORE_QUALITY[q].label} — {PCORE_QUALITY[q].renderScale}× rendu, {Math.round(PCORE_QUALITY[q].particles * 100)} % particules
                  </option>
                ))}
              </select>
            </label>
            {/* E. appearance */}
            <div className="section-title">Apparence</div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="row" style={{ gap: 6 }}>
                Principal <input type="color" value={s.colors.primary} onChange={(ev) => setS({ colors: { ...s.colors, primary: ev.target.value } })} />
              </label>
              <label className="row" style={{ gap: 6 }}>
                Or <input type="color" value={s.colors.gold} onChange={(ev) => setS({ colors: { ...s.colors, gold: ev.target.value } })} />
              </label>
              {(['rings', 'particles', 'lines'] as const).map((k) => (
                <label key={k} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={s[k]} onChange={(ev) => setS({ [k]: ev.target.checked } as Partial<PCoreSettings>)} /> {k}
                </label>
              ))}
            </div>
            {/* G. export */}
            <div className="section-title">Export (indépendant du montage)</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="input" style={{ width: 150 }} value={exportQuality} onChange={(ev) => setExportQuality(ev.target.value as PCoreQuality)} data-testid="pcore-export-quality">
                {(Object.keys(PCORE_QUALITY) as PCoreQuality[]).map((q) => (
                  <option key={q} value={q}>
                    {PCORE_QUALITY[q].label}
                  </option>
                ))}
              </select>
              <select className="input" style={{ width: 280 }} value={format} onChange={(ev) => setFormat(ev.target.value as PCoreFormat)} data-testid="pcore-format">
                <option value="mov-prores4444">ProRes 4444 .mov (alpha 10 bits)</option>
                <option value="mov-qtrle">QuickTime Animation .mov (alpha sans perte)</option>
                <option value="webm-vp9">WebM VP9 (alpha)</option>
                <option value="png-sequence">Séquence PNG (alpha)</option>
              </select>
              <select className="input" style={{ width: 120 }} value={res} onChange={(ev) => setRes(ev.target.value)}>
                {Object.keys(RES).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={withAudio} onChange={(ev) => setWithAudio(ev.target.checked)} disabled={format === 'png-sequence'} /> inclure la narration
              </label>
              <button
                className="btn"
                disabled={!!busy}
                data-testid="pcore-export"
                onClick={() =>
                  run('Export en cours', async () => {
                    const [w, h] = RES[res]!;
                    const r = await api.pcore.exportFile({ ...req, width: w, height: h, format, withAudio, quality: exportQuality });
                    if (r) {
                      setLastExport(r);
                      toast(`P-CORE exporté · alpha vérifié (${r.check.pixFmt}, ${r.check.frames} images)`, 'success');
                    }
                  })
                }
              >
                {busy === 'Export en cours' ? `Export ${Math.round(progress * 100)} %` : 'Exporter P-CORE…'}
              </button>
            </div>
            {lastExport && (
              <div className="tiny" data-testid="pcore-export-check">
                {lastExport.path} — {lastExport.check.width}×{lastExport.check.height}, {lastExport.check.frames} images, {lastExport.check.pixFmt}, alpha {lastExport.check.alphaMin}–{lastExport.check.alphaMax} ✓ · {PCORE_QUALITY[lastExport.quality].label} : rendu en {lastExport.renderSec.toFixed(1)} s ({lastExport.fps} images/s sur cet ordinateur)
              </div>
            )}
          </div>
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
