/**
 * P-CORE V2 in the interface:
 * - PCoreDirection (production report): the director's reactions of this version — accept, lock,
 *   change the expression, the duration or the intensity, disable, restore, add one at the playhead.
 * - PCoreV2Controls (P-CORE Studio): engine, presets, and the Identity / Animation / Narrative /
 *   Presence / Expressions / Performance tabs. Every control writes real engine settings.
 */
import { useEffect, useState } from 'react';
import { LAYERS, PRESETS, type LayerId, type PCoreV2Settings, type PresetId, presetSettings, resolveV2 } from '../../pcore/v2/config';
import { EXPRESSIONS, EXPRESSION_LIST, type ExpressionId } from '../../pcore/v2/expressions';
import type { PlacementSettings } from '../../pcore/placement';
import { addPCoreCue, disableAutoPCoreCues, resetPCoreCue, setPCoreCue, setPlayhead, updateSettings } from '../actions';
import { api } from '../api';
import { currentSequence, useEditor, useStore } from '../store';

const STATE_CLS: Record<string, string> = { proposée: 'proposed', acceptée: 'accepted', verrouillée: 'locked', désactivée: 'rejected' };

export function PCoreDirection() {
  const seq = useEditor((e) => currentSequence(e));
  const pc = seq.production?.pcore;
  const [add, setAdd] = useState<ExpressionId>('revelation');
  const [all, setAll] = useState(false);
  if (!pc) return null;
  const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
  const base = new Set(['dormant', 'silence']);
  const list = pc.cues.filter((c) => all || !base.has(c.expression));
  return (
    <div data-testid="pcore-direction">
      <div className="section-title">Direction de P-CORE ({PRESETS[pc.preset as PresetId]?.label ?? pc.preset})</div>
      <div className="tiny">
        {pc.cues.length} réaction(s) {pc.usedText ? 'choisies d’après la voix et le texte' : 'choisies d’après la voix seule (pas de texte aligné)'} · vos modifications sont conservées à la régénération.
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', margin: '4px 0' }}>
        <select className="input" aria-label="Expression à ajouter" value={add} onChange={(e) => setAdd(e.target.value as ExpressionId)} style={{ maxWidth: 170 }}>
          {EXPRESSION_LIST.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <button className="btn ghost" data-testid="pcore-cue-add" onClick={() => void addPCoreCue(add, EXPRESSIONS[add].duration.default)}>
          + à la tête de lecture
        </button>
        <button className="btn ghost" onClick={() => void disableAutoPCoreCues()} title="Garde l’éveil, les silences et la stabilisation finale">
          Désactiver les réactions automatiques
        </button>
        <label className="row tiny" style={{ gap: 4 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> afficher veille et silences
        </label>
      </div>
      {list.map((c) => (
        <div key={c.id} className={`decision ${STATE_CLS[c.state]}`} data-testid="pcore-cue" data-state={c.state} data-expression={c.expression}>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn ghost tiny" onClick={() => setPlayhead(Math.round(c.start * fps))}>
              {c.start.toFixed(1)} s
            </button>
            <span className={`pill ${STATE_CLS[c.state]}`}>{c.state}</span>
            <select className="input" aria-label="Expression" value={c.expression} data-testid="pcore-cue-expression" onChange={(e) => void setPCoreCue(c.id, { expression: e.target.value as ExpressionId })} style={{ flex: 1 }}>
              {EXPRESSION_LIST.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          <div className="tiny muted">{c.reasons.slice(0, 3).join(' · ')}</div>
          <div className="row decision-actions" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="tiny">
              durée{' '}
              <input className="input" type="number" aria-label="Durée (s)" step={0.1} min={EXPRESSIONS[c.expression].duration.min} max={EXPRESSIONS[c.expression].duration.max} defaultValue={c.duration} style={{ width: 58, height: 22 }} onBlur={(e) => Number(e.target.value) !== c.duration && void setPCoreCue(c.id, { duration: Math.max(EXPRESSIONS[c.expression].duration.min, Math.min(EXPRESSIONS[c.expression].duration.max, Number(e.target.value))) })} />
            </label>
            <label className="tiny">
              intensité{' '}
              <input className="input" type="number" aria-label="Intensité" step={0.05} min={0.2} max={1.5} defaultValue={c.intensity} style={{ width: 58, height: 22 }} onBlur={(e) => Number(e.target.value) !== c.intensity && void setPCoreCue(c.id, { intensity: Math.max(0.2, Math.min(1.5, Number(e.target.value))) })} />
            </label>
            {c.state === 'proposée' && <button className="btn ghost" data-testid="pcore-cue-accept" onClick={() => void setPCoreCue(c.id, { state: 'acceptée' }, 'Accepter la réaction P-CORE')}>✓ Accepter</button>}
            {c.state !== 'verrouillée' ? (
              <button className="btn ghost" data-testid="pcore-cue-lock" onClick={() => void setPCoreCue(c.id, { state: 'verrouillée' }, 'Verrouiller la réaction P-CORE')}>🔒 Verrouiller</button>
            ) : (
              <button className="btn ghost" onClick={() => void setPCoreCue(c.id, { state: 'acceptée' }, 'Déverrouiller la réaction P-CORE')}>Déverrouiller</button>
            )}
            {c.state !== 'désactivée' ? (
              <button className="btn ghost danger" data-testid="pcore-cue-disable" onClick={() => void setPCoreCue(c.id, { state: 'désactivée' }, 'Désactiver la réaction P-CORE')}>Désactiver</button>
            ) : (
              <button className="btn ghost" onClick={() => void setPCoreCue(c.id, { state: 'acceptée' }, 'Réactiver la réaction P-CORE')}>Réactiver</button>
            )}
            {(pc.edits.some((x) => x.id === c.id) || pc.added.some((x) => x.id === c.id)) && (
              <button className="btn ghost" data-testid="pcore-cue-reset" onClick={() => void resetPCoreCue(c.id)} title="Revenir à la proposition automatique">
                Rétablir
              </button>
            )}
          </div>
        </div>
      ))}
      {pc.log.length > 0 && (
        <details className="tiny">
          <summary>Pourquoi certaines réactions n’ont pas été jouées ({pc.log.length})</summary>
          {pc.log.slice(0, 40).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </details>
      )}
    </div>
  );
}

function Num({ label, value, min, max, step, onChange, testid }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; testid?: string }) {
  return (
    <label className="field" style={{ minWidth: 150 }}>
      <span>
        {label} <b>{Number(value.toFixed(2))}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testid} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

type Tab = 'identity' | 'animation' | 'narrative' | 'presence' | 'expressions' | 'performance';

export function PCoreV2Controls({ onPreviewExpression }: { onPreviewExpression: (id: ExpressionId) => void }) {
  const st = useStore((s) => s.settings)!;
  const engine = st.pcore?.engine ?? 'v2';
  const v2 = resolveV2(st.pcore?.v2);
  const pl: Partial<PlacementSettings> = st.pcore?.placement ?? {};
  const [tab, setTab] = useState<Tab>('identity');
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.pcore.stats>>>(null);
  useEffect(() => {
    if (tab === 'performance') void api.pcore.stats().then(setStats);
  }, [tab]);
  const save = (next: PCoreV2Settings) => void updateSettings({ pcore: { ...st.pcore, v2: next } });
  const patch = <K extends 'identity' | 'animation' | 'narrative'>(k: K, p: Partial<PCoreV2Settings[K]>) => save({ ...v2, [k]: { ...v2[k], ...p } });
  const setLayer = (id: LayerId, p: Partial<PCoreV2Settings['identity']['layers'][LayerId]>) => save({ ...v2, identity: { ...v2.identity, layers: { ...v2.identity.layers, [id]: { ...v2.identity.layers[id], ...p } } } });
  const setPl = (p: Partial<PlacementSettings>) => void updateSettings({ pcore: { ...st.pcore, placement: { ...st.pcore?.placement, ...p } } });
  const zones = pl.protectedZones ?? [];
  return (
    <div data-testid="pcore-v2">
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="section-title" style={{ margin: 0 }}>P-CORE V2</div>
        <select className="input" style={{ width: 200 }} aria-label="Moteur" data-testid="pcore-engine" value={engine} onChange={(e) => void updateSettings({ pcore: { ...st.pcore, engine: e.target.value as 'v1' | 'v2' } })}>
          <option value="v2">Moteur V2 (entité en couches)</option>
          <option value="v1">Moteur V1.1 (projets existants)</option>
        </select>
        <span className="tiny">Les clips déjà rendus gardent le moteur avec lequel ils ont été créés.</span>
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', margin: '6px 0' }} role="radiogroup" aria-label="Préréglages">
        {(Object.keys(PRESETS) as PresetId[]).map((id) => (
          <button key={id} role="radio" aria-checked={v2.preset === id} className={`btn ghost${v2.preset === id ? ' active' : ''}`} title={PRESETS[id].description} data-testid={`pcore-preset-${id}`} onClick={() => save(presetSettings(id))}>
            {PRESETS[id].label}
          </button>
        ))}
      </div>
      <div className="tiny">{PRESETS[v2.preset].description}</div>
      <div className="row" role="tablist" style={{ gap: 4, margin: '6px 0' }}>
        {(
          [
            ['identity', 'Identité'],
            ['animation', 'Animation'],
            ['narrative', 'Narration'],
            ['presence', 'Présence'],
            ['expressions', 'Expressions'],
            ['performance', 'Performance'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`btn ghost${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} data-testid={`pcore-tab-${k}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'identity' && (
        <div>
          {LAYERS.map((l) => (
            <div key={l.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <label className="row" style={{ gap: 6, width: 170 }}>
                <input type="checkbox" checked={v2.identity.layers[l.id].enabled} disabled={l.id === 'core'} data-testid={`pcore-layer-${l.id}`} onChange={(e) => setLayer(l.id, { enabled: e.target.checked })} /> {l.label}
              </label>
              <input type="range" min={0} max={2} step={0.05} aria-label={`Intensité ${l.label}`} value={v2.identity.layers[l.id].intensity} onChange={(e) => setLayer(l.id, { intensity: Number(e.target.value) })} />
              <span className="tiny" style={{ flex: 1 }}>{l.role}</span>
            </div>
          ))}
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Num label="Profondeur du logo" value={v2.identity.depth} min={0.06} max={0.24} step={0.01} onChange={(v) => patch('identity', { depth: v })} />
            <Num label="Métal (satiné → miroir)" value={v2.identity.metal} min={0} max={1} step={0.05} onChange={(v) => patch('identity', { metal: v })} />
            <Num label="Arêtes lumineuses" value={v2.identity.edge} min={0} max={1} step={0.05} onChange={(v) => patch('identity', { edge: v })} />
            <Num label="Anneaux orbitaux" value={v2.identity.rings} min={2} max={6} step={1} onChange={(v) => patch('identity', { rings: v })} />
            <Num label="Détail de la structure" value={v2.identity.innerDetail} min={1} max={3} step={1} onChange={(v) => patch('identity', { innerDetail: v })} />
          </div>
          <div className="tiny">La silhouette et la face du logo viennent de l’illustration officielle : seules la matière, la profondeur et la lumière changent.</div>
        </div>
      )}
      {tab === 'animation' && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Num label="Vitesse" value={v2.animation.speed} min={0.5} max={1.6} step={0.05} onChange={(v) => patch('animation', { speed: v })} />
          <Num label="Rotation" value={v2.animation.rotation} min={0} max={1.5} step={0.05} onChange={(v) => patch('animation', { rotation: v })} />
          <Num label="Intensité" value={v2.animation.intensity} min={0.4} max={1.4} step={0.05} onChange={(v) => patch('animation', { intensity: v })} />
          <Num label="Inertie (s)" value={v2.animation.inertia} min={0.15} max={1.2} step={0.05} onChange={(v) => patch('animation', { inertia: v })} testid="pcore-inertia" />
          <Num label="Particules" value={v2.animation.particles} min={0.3} max={1.5} step={0.05} onChange={(v) => patch('animation', { particles: v })} />
          <Num label="Transitions (s)" value={v2.animation.transition} min={0.2} max={1.5} step={0.05} onChange={(v) => patch('animation', { transition: v })} />
          <Num label="Micro-mouvements" value={v2.animation.micro} min={0} max={1} step={0.05} onChange={(v) => patch('animation', { micro: v })} />
        </div>
      )}
      {tab === 'narrative' && (
        <div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Num label="Sensibilité" value={v2.narrative.sensitivity} min={0.3} max={1.6} step={0.05} onChange={(v) => patch('narrative', { sensitivity: v })} />
            <Num label="Force des réactions" value={v2.narrative.reaction} min={0.4} max={1.4} step={0.05} onChange={(v) => patch('narrative', { reaction: v })} />
            <Num label="Écart entre moments forts (s)" value={v2.narrative.spectacularGap} min={3} max={30} step={1} onChange={(v) => patch('narrative', { spectacularGap: v })} />
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={v2.narrative.useText} onChange={(e) => patch('narrative', { useText: e.target.checked })} /> Lire le script ou la transcription (en contexte)
            </label>
          </div>
          <div className="tiny">
            Le directeur lit chaque phrase dans son contexte (position, phrase précédente, connecteurs, forme). Sans texte, il dirige d’après la voix : pauses, montées d’énergie, rythme. Le volume
            n’est jamais pris pour une émotion. L’aperçu ci-contre montre ses choix sur la fenêtre (bande du graphe).
          </div>
        </div>
      )}
      {tab === 'presence' && (
        <div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={pl.avoidCaptions !== false} onChange={(e) => setPl({ avoidCaptions: e.target.checked })} /> S’écarter des titres et des noms à l’écran
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={pl.cinematic !== false} onChange={(e) => setPl({ cinematic: e.target.checked })} /> Mode cinématique : revenir au premier plan sur les révélations fortes
          </label>
          <div className="section-title">Zones protégées (jamais couvertes par P-CORE)</div>
          {zones.map((z, i) => (
            <div key={i} className="row tiny" style={{ gap: 6 }}>
              x {Math.round(z.x * 100)} % · y {Math.round(z.y * 100)} % · {Math.round(z.w * 100)} × {Math.round(z.h * 100)} %
              <button className="btn ghost" onClick={() => setPl({ protectedZones: zones.filter((_, k) => k !== i) })}>✕</button>
            </div>
          ))}
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {(
              [
                ['Centre', { x: 0.25, y: 0.15, w: 0.5, h: 0.6 }],
                ['Tiers gauche', { x: 0, y: 0, w: 0.33, h: 1 }],
                ['Tiers droit', { x: 0.67, y: 0, w: 0.33, h: 1 }],
                ['Bandeau du haut', { x: 0, y: 0, w: 1, h: 0.2 }],
              ] as const
            ).map(([l, z]) => (
              <button key={l} className="btn ghost" data-testid={`pcore-zone-${l}`} onClick={() => setPl({ protectedZones: [...zones, { ...z }] })}>
                + {l}
              </button>
            ))}
          </div>
          <div className="tiny">
            Pris en compte réellement : sous-titres (bande du bas), titres et noms à l’écran, cases détectées, zones de texte lues par l’OCR, zones protégées, position fixe (onglet Placement). Les visages ne
            sont pas détectés (aucun modèle de vision) : protégez la zone à la main si besoin.
          </div>
        </div>
      )}
      {tab === 'expressions' && (
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
          {EXPRESSION_LIST.map((x) => (
            <div key={x.id} className="decision" data-testid="pcore-expression">
              <div className="row" style={{ gap: 6 }}>
                <b style={{ flex: 1 }}>{x.label}</b>
                {x.spectacular && <span className="pill">moment fort</span>}
                <button className="btn ghost" data-testid={`pcore-expr-preview-${x.id}`} onClick={() => onPreviewExpression(x.id)}>
                  Aperçu
                </button>
              </div>
              <div className="tiny">{x.description}</div>
              <div className="tiny muted">
                Quand : {x.when} · durée {x.duration.default} s ({x.duration.min}–{x.duration.max}) · {x.variants} variante(s) · coût relatif {x.cost}
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === 'performance' && (
        <div data-testid="pcore-performance">
          {!stats ? (
            <div className="tiny">Aucun rendu P-CORE encore mesuré dans cette session : calculez un aperçu ou exportez.</div>
          ) : (
            <dl className="kv">
              <dt>Dernier rendu</dt>
              <dd>
                moteur {stats.engine.toUpperCase()} · {stats.quality} · {stats.width}×{stats.height} (rendu interne {stats.renderWidth}×{stats.renderHeight})
              </dd>
              <dt>Vitesse</dt>
              <dd>
                {stats.frames} images en {stats.seconds} s → {stats.fps} images/s
              </dd>
              <dt>Processeur</dt>
              <dd>
                fenêtre de rendu {stats.rendererCpu ?? '—'} % · processus GPU {stats.gpuProcessCpu ?? '—'} % (d’un cœur)
              </dd>
              <dt>Mémoire</dt>
              <dd>
                fenêtre de rendu {stats.rendererMemMB ?? '—'} Mo · processus GPU {stats.gpuProcessMemMB ?? '—'} Mo
              </dd>
              <dt>Carte graphique</dt>
              <dd>{stats.software ? 'rendu logiciel (aucune carte graphique utilisée)' : stats.gpu}</dd>
              <dt>Mémoire vidéo</dt>
              <dd>non mesurable (Chromium ne l’expose pas)</dd>
            </dl>
          )}
          <button className="btn ghost" onClick={() => void api.pcore.stats().then(setStats)}>
            Actualiser
          </button>
        </div>
      )}
    </div>
  );
}
