/**
 * Objective comparison of edit versions. Every figure is computed the same way from the sequence and
 * its production record (no artistic judgement): duration, shots, diversity, rhythm, repetitions,
 * transitions, subtitles, QC findings, sync method and confidence, voice processing. The "better"
 * direction is given only where it is a technical fact (fewer black gaps, fewer repeats), never for
 * taste (shot length, number of shots).
 */
import { type MediaAsset, type Sequence, framesToSeconds, sequenceDuration } from '../core';

export interface VersionMetrics {
  id: string;
  name: string;
  durationSec: number;
  shots: number;
  distinctMedia: number;
  /** distinct pictures / shots (1 = never the same picture twice). */
  diversity: number;
  meanShotSec: number;
  medianShotSec: number;
  maxShotSec: number;
  specificShare: number;
  generatedShare: number;
  /** Share of shots whose match relies on file names, tags or folders only (content not analysed). */
  metadataOnlyShare: number;
  /** Decisions accepted, locked or chosen by the user. */
  validatedDecisions: number;
  repeatsBackToBack: number;
  transitions: number;
  subtitles: number;
  fastSubtitles: number;
  qcScore: number | null;
  qcErrors: number;
  qcWarnings: number;
  syncMethod: string;
  syncConfidence: number | null;
  narrationType: string | null;
  voiceSteps: number;
}

export function versionMetrics(seq: Sequence, media: Record<string, MediaAsset>): VersionMetrics {
  const r = seq.settings.frameRate;
  const v1 = seq.tracks.find((t) => t.kind === 'video');
  const clips = [...(v1?.clips ?? [])].sort((a, b) => a.start - b.start);
  const lens = clips.map((c) => framesToSeconds(c.duration, r)).sort((a, b) => a - b);
  const p = seq.production;
  let repeats = 0;
  for (let i = 1; i < clips.length; i++) if (clips[i]!.mediaId === clips[i - 1]!.mediaId && clips[i - 1]!.start + clips[i - 1]!.duration === clips[i]!.start) repeats++;
  const shots = p?.shots ?? [];
  const subs = seq.captions.filter((c) => c.style === 'subtitle');
  const round = (x: number, d = 2) => +x.toFixed(d);
  const pictures = new Set(clips.map((c) => c.mediaId).filter((id) => media[id]?.kind === 'image' || media[id]?.generator));
  return {
    id: seq.id,
    name: seq.name,
    durationSec: round(framesToSeconds(sequenceDuration(seq), r), 1),
    shots: clips.length,
    distinctMedia: pictures.size,
    diversity: clips.length ? round(pictures.size / clips.length) : 0,
    meanShotSec: lens.length ? round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
    medianShotSec: lens.length ? round(lens[Math.floor(lens.length / 2)]!) : 0,
    maxShotSec: lens.length ? round(lens.at(-1)!) : 0,
    specificShare: shots.length ? round(shots.filter((s) => s.quality === 'strong').length / shots.length) : 0,
    generatedShare: shots.length ? round(shots.filter((s) => s.quality === 'generated').length / shots.length) : 0,
    metadataOnlyShare: shots.length ? round(shots.filter((s) => s.metadataOnly).length / shots.length) : 0,
    validatedDecisions: p?.edg?.decisions.filter((d) => d.state === 'acceptée' || d.state === 'verrouillée').length ?? 0,
    repeatsBackToBack: repeats,
    transitions: seq.tracks.reduce((a, t) => a + (t.transitions?.length ?? 0), 0),
    subtitles: subs.length,
    fastSubtitles: subs.filter((c) => framesToSeconds(c.end - c.start, r) < 0.7).length,
    qcScore: p ? p.qcScore : null,
    qcErrors: p ? p.qcIssues.filter((i) => i.severity === 'error').length : 0,
    qcWarnings: p ? p.qcIssues.filter((i) => i.severity === 'warning').length : 0,
    syncMethod: p ? (p.alignment.method === 'transcript' ? 'mot à mot' : 'pauses') : 'manuel',
    syncConfidence: p ? round(p.alignment.confidence) : null,
    narrationType: p?.narrationFormat?.label ?? null,
    voiceSteps: p?.voice?.steps.length ?? 0,
  };
}

export interface MetricRow {
  key: keyof VersionMetrics;
  label: string;
  a: string;
  b: string;
  /** 'better' / 'worse' only when the direction is a technical fact; 'diff' otherwise. */
  verdict: 'same' | 'better' | 'worse' | 'diff';
}

const ROWS: { key: keyof VersionMetrics; label: string; better?: 'lower' | 'higher'; unit?: string }[] = [
  { key: 'durationSec', label: 'Durée', unit: ' s' },
  { key: 'shots', label: 'Plans' },
  { key: 'distinctMedia', label: 'Images différentes' },
  { key: 'diversity', label: 'Diversité (images / plans)', better: 'higher' },
  { key: 'meanShotSec', label: 'Durée moyenne d’un plan', unit: ' s' },
  { key: 'medianShotSec', label: 'Durée médiane d’un plan', unit: ' s' },
  { key: 'maxShotSec', label: 'Plan le plus long', unit: ' s' },
  { key: 'specificShare', label: 'Plans avec correspondance précise (nom, étiquette, description — contenu non analysé)' },
  { key: 'metadataOnlyShare', label: 'Plans choisis sur les seuls noms de fichiers' },
  { key: 'validatedDecisions', label: 'Décisions validées ou verrouillées par vous' },
  { key: 'generatedShare', label: 'Plans animés (sans image)' },
  { key: 'repeatsBackToBack', label: 'Même image deux fois de suite', better: 'lower' },
  { key: 'transitions', label: 'Transitions' },
  { key: 'subtitles', label: 'Sous-titres' },
  { key: 'fastSubtitles', label: 'Sous-titres trop rapides (< 0,7 s)', better: 'lower' },
  { key: 'qcErrors', label: 'Erreurs du contrôle qualité', better: 'lower' },
  { key: 'qcWarnings', label: 'Avertissements du contrôle', better: 'lower' },
  { key: 'qcScore', label: 'Score de contrôle technique', better: 'higher' },
  { key: 'syncMethod', label: 'Synchronisation' },
  { key: 'syncConfidence', label: 'Confiance de synchronisation', better: 'higher' },
  { key: 'narrationType', label: 'Type de narration' },
  { key: 'voiceSteps', label: 'Traitements de la voix' },
];

export function compareVersions(a: VersionMetrics, b: VersionMetrics): MetricRow[] {
  return ROWS.map((r) => {
    const va = a[r.key];
    const vb = b[r.key];
    const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' ? `${String(v).replace('.', ',')}${r.unit ?? ''}` : String(v));
    let verdict: MetricRow['verdict'] = va === vb ? 'same' : 'diff';
    if (verdict === 'diff' && r.better && typeof va === 'number' && typeof vb === 'number') verdict = (r.better === 'higher' ? vb > va : vb < va) ? 'better' : 'worse';
    return { key: r.key, label: r.label, a: fmt(va), b: fmt(vb), verdict };
  });
}
