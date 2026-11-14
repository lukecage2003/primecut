/**
 * Automatic quality control of a (generated or edited) sequence, with safe automatic fixes.
 * The score is a transparent sum of penalties so versions can be compared.
 */
import { type MediaAsset, type ProductionMeta, type Sequence, subtitleChars, clipEnd, framesToSeconds, sequenceDuration, summariseGraph } from '../core';
import type { EditStyle, ProductionPreferences } from './preferences';

export type QcIssue = ProductionMeta['qcIssues'][number];

export interface QcResult {
  score: number;
  issues: QcIssue[];
}

const PENALTY = { error: 15, warning: 4, info: 0 } as const;

export function runQc(seq: Sequence, media: Record<string, MediaAsset>, prefs: ProductionPreferences, ctx: { alignmentConfidence?: number; narrationEnd?: number; offScript?: { start: number; end: number; text: string }[] } = {}): QcResult {
  const issues: QcIssue[] = [];
  const r = seq.settings.frameRate;
  const sec = (f: number) => framesToSeconds(f, r);
  const v1 = seq.tracks.find((t) => t.kind === 'video')!;
  const end = ctx.narrationEnd ?? sequenceDuration(seq);
  // coverage
  let t = 0;
  for (const c of v1.clips) {
    if (c.start > t) issues.push({ severity: 'error', code: 'gap', message: `Trou noir ${sec(t).toFixed(2)}–${sec(c.start).toFixed(2)} s`, frame: t });
    t = Math.max(t, clipEnd(c));
  }
  if (t < end) issues.push({ severity: 'error', code: 'gap', message: `Aucune image après ${sec(t).toFixed(2)} s`, frame: t });
  // shot lengths & repetition
  v1.clips.forEach((c, i) => {
    const d = sec(c.duration);
    if (d < prefs.shotMin * 0.5) issues.push({ severity: 'warning', code: 'shot-short', message: `Plan ${i + 1} très court (${d.toFixed(2)} s)`, frame: c.start });
    if (d > prefs.shotMax * 1.6) issues.push({ severity: 'warning', code: 'shot-long', message: `Plan ${i + 1} long (${d.toFixed(1)} s)`, frame: c.start });
    const prev = v1.clips[i - 1];
    if (prev && prev.mediaId === c.mediaId && clipEnd(prev) === c.start) issues.push({ severity: 'warning', code: 'repeat', message: `Même image deux fois de suite au plan ${i + 1}`, frame: c.start });
  });
  // rights
  const used = new Set(seq.tracks.flatMap((tr) => tr.clips.map((c) => c.mediaId)));
  for (const id of used) {
    const m = media[id];
    if (!m) continue;
    const u = m.rights?.usage;
    if (u && ['permission-required', 'view-only', 'unknown'].includes(u)) issues.push({ severity: 'error', code: 'rights', message: `${m.name} : droits d’utilisation non vérifiés (${u}) — ne pas publier` });
    if (u === 'reusable' && !m.rights?.attribution) issues.push({ severity: 'warning', code: 'attribution', message: `${m.name} : réutilisable mais attribution manquante` });
  }
  // placeholders and weak matches
  const placeholders = seq.captions.filter((c) => c.style === 'placeholder').length;
  for (const o of ctx.offScript ?? []) issues.push({ severity: 'warning', code: 'off-script', message: `Paroles absentes du script ${o.start.toFixed(1)}–${o.end.toFixed(1)} s (prise ratée ou improvisation ?) : “${o.text.slice(0, 80)}${o.text.length > 80 ? '…' : ''}”`, frame: Math.round((o.start * r.num) / r.den) });
  if (placeholders) issues.push({ severity: 'error', code: 'missing-visual', message: `${placeholders} plan(s) sans image — ajoutez des médias ou régénérez` });
  const weak = seq.production?.shots.filter((s) => s.quality === 'weak').length ?? 0;
  if (weak) issues.push({ severity: 'info', code: 'weak-match', message: `${weak} plan(s) à correspondance faible (lien de section ou mots-clés seulement) — à vérifier` });
  // captions
  for (const c of seq.captions) {
    const lines = c.text.split('\n');
    if (c.style === 'subtitle' && (lines.length > 2 || lines.some((l) => l.length > subtitleChars(seq.settings.width, seq.settings.height) + 4))) issues.push({ severity: 'warning', code: 'caption-overflow', message: `Sous-titre trop long à ${sec(c.start).toFixed(1)} s`, frame: c.start });
    if (c.style === 'subtitle' && c.end - c.start < Math.round(0.7 * (r.num / r.den))) issues.push({ severity: 'info', code: 'caption-fast', message: `Sous-titre affiché < 0,7 s à ${sec(c.start).toFixed(1)} s`, frame: c.start });
  }
  if (ctx.alignmentConfidence !== undefined && ctx.alignmentConfidence < 0.5)
    issues.push({ severity: 'warning', code: 'alignment', message: `Synchro texte/voix approximative (confiance ${(ctx.alignmentConfidence * 100).toFixed(0)}%) — activez la transcription locale pour une synchro mot à mot` });
  const score = Math.max(0, 100 - issues.reduce((a, i) => a + PENALTY[i.severity], 0));
  return { score, issues };
}

/** Safe automatic fixes: close picture gaps by extending the previous still, merge same-image repeats. */
export function autoFix(seq: Sequence, media: Record<string, MediaAsset>, endFrame: number): string[] {
  const fixes: string[] = [];
  const v1 = seq.tracks.find((t) => t.kind === 'video')!;
  for (let i = 0; i < v1.clips.length; i++) {
    const c = v1.clips[i]!;
    const next = v1.clips[i + 1];
    const until = next ? next.start : endFrame;
    const isStill = media[c.mediaId]?.kind === 'image';
    if (clipEnd(c) < until && isStill) {
      fixes.push(`extended shot ${i + 1} to close a ${until - clipEnd(c)}-frame gap`);
      c.duration = until - c.start;
    }
    if (next && next.mediaId === c.mediaId && clipEnd(c) === next.start && isStill) {
      c.duration += next.duration;
      v1.transitions = v1.transitions.filter((t) => t.leftClipId !== c.id && t.rightClipId !== next.id);
      for (const t of v1.transitions) if (t.leftClipId === next.id) t.leftClipId = c.id;
      v1.clips.splice(i + 1, 1);
      fixes.push(`merged repeated image at shot ${i + 2}`);
      i--;
    }
  }
  if (v1.clips[0] && v1.clips[0].start > 0 && media[v1.clips[0].mediaId]?.kind === 'image') {
    v1.clips[0].duration += v1.clips[0].start;
    v1.clips[0].start = 0;
    fixes.push('extended first shot to the start');
  }
  return fixes;
}

/** Measures the observable style of a sequence (used for preference learning). */
export function measureStyle(seq: Sequence): EditStyle {
  const r = seq.settings.frameRate;
  const v1 = seq.tracks.find((t) => t.kind === 'video')!;
  const vids = seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips);
  const motionCounts: EditStyle['motionCounts'] = {};
  for (const c of vids) motionCounts[c.motion?.kind ?? 'none'] = (motionCounts[c.motion?.kind ?? 'none'] ?? 0) + 1;
  let cuts = 0;
  for (let i = 0; i + 1 < v1.clips.length; i++) if (clipEnd(v1.clips[i]!) === v1.clips[i + 1]!.start) cuts++;
  const narr = seq.production ? seq.tracks.find((t) => t.kind === 'audio')?.clips[0] : undefined;
  const music = seq.tracks.filter((t) => t.kind === 'audio')[1]?.clips[0];
  return {
    shots: vids.length,
    meanShotSec: vids.length ? framesToSeconds(vids.reduce((a, c) => a + c.duration, 0), r) / vids.length : 0,
    motionCounts,
    dissolves: v1.transitions.length,
    cuts,
    musicRelativeDb: music && narr ? music.gainDb - narr.gainDb : null,
    sfxClips: seq.production ? seq.tracks.filter((t) => t.kind === 'audio').slice(2).reduce((n, t) => n + t.clips.length, 0) : null,
    duckDepthDb: music ? (seq.tracks.filter((t) => t.kind === 'audio')[1]?.duck?.depthDb ?? 0) : null,
    subtitles: seq.captions.some((c) => c.style === 'subtitle'),
  };
}

/** Share of rect `z` hidden outside window `w` (0 = fully visible, 1 = fully hidden). */
export function hiddenShare(z: { x: number; y: number; w: number; h: number }, w: { x: number; y: number; w: number; h: number }): number {
  const ix = Math.max(0, Math.min(z.x + z.w, w.x + w.w) - Math.max(z.x, w.x));
  const iy = Math.max(0, Math.min(z.y + z.h, w.y + w.h) - Math.max(z.y, w.y));
  const area = z.w * z.h;
  return area > 0 ? 1 - (ix * iy) / area : 0;
}

/**
 * Editorial review of a generated version, from its decision graph: what a person should check.
 * Matches based only on metadata, low-confidence proposals, rejected decisions without a
 * replacement, lettering cut by the framing (when text zones are known), uncertain panel
 * detection, music without a declared licence. Codes start with `review-`.
 */
export function reviewQc(seq: Sequence, media: Record<string, MediaAsset>, prefs: Pick<ProductionPreferences, 'reviewThreshold'> & Partial<ProductionPreferences>): QcIssue[] {
  const issues: QcIssue[] = [];
  const g = seq.production?.edg;
  if (!g) return issues;
  const r = seq.settings.frameRate;
  const sec = (f: number) => framesToSeconds(f, r).toFixed(1);
  const threshold = prefs.reviewThreshold ?? 0.45;
  const sum = summariseGraph(g, threshold);
  if (sum.metadataOnly) issues.push({ severity: 'info', code: 'review-metadata-only', message: `${sum.metadataOnly} plan(s) choisi(s) d’après les noms de fichiers, étiquettes ou dossiers : le contenu des images n’est pas analysé. Vérifiez qu’elles montrent bien ce que dit la narration (ajoutez une description ou activez l’OCR local pour des correspondances fondées sur le contenu).` });
  const clips = new Map(seq.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (const d of g.decisions) {
    const at = d.anchor.start;
    if (d.state === 'rejetée') {
      issues.push({ severity: 'warning', code: 'review-rejected', message: `${d.kind === 'musique' ? 'Musique' : 'Plan'} à ${sec(at)} s rejeté sans remplaçant : choisissez un autre média`, frame: at });
      continue;
    }
    if (d.kind === 'visuel' && d.state === 'proposée' && d.chosen.mediaId && !d.chosen.generated && d.confidence < threshold)
      issues.push({ severity: 'warning', code: 'review-low-confidence', message: `Plan à ${sec(at)} s : correspondance faible (${Math.round(d.confidence * 100)} %) pour « ${d.anchor.text.slice(0, 60)}${d.anchor.text.length > 60 ? '…' : ''} » — acceptez, remplacez ou rejetez`, frame: at });
    if (d.kind === 'musique' && d.chosen.mediaId) {
      const m = media[d.chosen.mediaId];
      if (m && !m.rights?.license && d.author === 'auto') issues.push({ severity: 'info', code: 'review-music-licence', message: `Musique « ${d.chosen.label} » : licence non déclarée — vérifiez vos droits avant de publier`, frame: at });
    }
    if (d.kind !== 'visuel') continue;
    for (const id of d.clipIds) {
      const c = clips.get(id);
      const m = c && media[c.mediaId];
      if (!c || !m || m.kind !== 'image' || !m.probe.video) continue;
      if (m.panels && m.panelConfidence !== undefined && m.panelConfidence < 0.5 && c.motion.kind === 'panels')
        issues.push({ severity: 'info', code: 'review-panels', message: `Plan à ${sec(c.start)} s : découpage des cases incertain (${Math.round(m.panelConfidence * 100)} %) — vérifiez la lecture case par case`, frame: c.start });
      const zones = m.ocr?.zones ?? [];
      if (!zones.length) continue;
      const aspect = m.probe.video.width / m.probe.video.height;
      const box = seq.settings.width / seq.settings.height;
      // panel by panel: a zone half inside a window is cut (other panels' zones are legitimately out of view);
      // Ken Burns: any zone pushed out of the frame at the tightest moment is lost
      const panelPath = c.motion.kind === 'panels' && c.motion.path?.length ? c.motion.path : null;
      const windows = panelPath ?? [zoomWindow(c.motion.kind, c.motion.amount, aspect, box)];
      const cut = zones.filter((z) => windows.some((w) => {
        const h = hiddenShare(z, w);
        return panelPath ? h > 0.15 && h < 0.85 : h > 0.15;
      })).length;
      if (cut) issues.push({ severity: 'warning', code: 'review-framing', message: `Plan à ${sec(c.start)} s : le cadrage coupe ${cut} zone(s) de texte lues dans l’image (${m.name})`, frame: c.start });
    }
  }
  return issues;
}

/** Visible part of a still (normalised to the image) at the tightest moment of a Ken Burns move (stills are fitted inside the frame). */
function zoomWindow(kind: string, amount: number, imageAspect: number, boxAspect: number): { x: number; y: number; w: number; h: number } {
  const z = kind === 'none' ? 1 : 1 + Math.max(0, amount);
  const s0 = Math.min(boxAspect / imageAspect, 1);
  const w = Math.min(1, boxAspect / (imageAspect * s0 * z));
  const h = Math.min(1, 1 / (s0 * z));
  const dx = 1 - w;
  const dy = 1 - h;
  const x = kind === 'pan-left' ? 0 : kind === 'pan-right' ? dx : dx / 2;
  const y = kind === 'pan-up' ? 0 : kind === 'pan-down' ? dy : dy / 2;
  return { x, y, w, h };
}
