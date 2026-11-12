/**
 * Timeline construction: turns a plan (beats, shots) into a real Sequence that the editor, the
 * preview and the exporter use like any hand-made edit. Everything stays editable afterwards.
 */
import {
  type Caption,
  type Clip,
  type MediaAsset,
  type MotionKind,
  type ProductionShotMeta,
  type Sequence,
  type SequenceSettings,
  createSequence,
  newId,
  secondsToFrames,
  framesToSeconds,
  wrapLines,
  DEFAULT_TRANSFORM,
  normalizeSequence,
} from '../core';
import type { AlignmentResult } from './align';
import { EntityIndex } from './entities';
import { type Beat, buildBeats, chooseMedia, indexLibrary, pickMotion, reserveHinted } from './planner';
import type { ProductionPreferences } from './preferences';
import type { ParsedScript } from './script';

export interface BuildInput {
  name: string;
  settings: SequenceSettings;
  script: ParsedScript;
  alignment: AlignmentResult;
  narration: MediaAsset;
  narrationLufs?: number | null;
  music?: MediaAsset | null;
  musicLufs?: number | null;
  library: MediaAsset[];
  prefs: ProductionPreferences;
  entityIndex?: EntityIndex;
}

export interface BuildResult {
  sequence: Sequence;
  beats: Beat[];
  shots: ProductionShotMeta[];
}

function clip(mediaId: string, name: string, start: number, duration: number, sourceIn = 0, motion: MotionKind = 'none', amount = 0): Clip {
  return {
    id: newId(),
    mediaId,
    name,
    start,
    duration,
    sourceIn,
    speed: 1,
    enabled: true,
    gainDb: 0,
    transform: { ...DEFAULT_TRANSFORM },
    fadeIn: 0,
    fadeOut: 0,
    motion: { kind: motion, amount: motion === 'none' ? 0 : amount },
  };
}

const clampDb = (v: number) => Math.max(-12, Math.min(12, v));

export function buildSequence(input: BuildInput): BuildResult {
  const { prefs, settings } = input;
  const rate = settings.frameRate;
  const F = (sec: number) => secondsToFrames(sec, rate);
  const index = input.entityIndex ?? new EntityIndex();
  const beats = buildBeats(input.script, input.alignment.sentences, prefs, index);
  const library = indexLibrary(input.library, index);
  const seq = createSequence(input.name, settings);
  const [v1, v2, a1, a2] = [seq.tracks[0]!, seq.tracks[1]!, seq.tracks[2]!, seq.tracks[3]!];
  void v2;
  const narrDur = input.narration.probe.durationSec;
  const endFrame = F(narrDur + 1);
  const shots: ProductionShotMeta[] = [];
  const reserved = reserveHinted(beats, library);
  const recent: string[] = [];
  const usage = new Map<string, number>();
  let prevMotion: MotionKind | null = null;
  const minF = Math.max(1, F(prefs.shotMin));
  const maxF = Math.max(minF, F(prefs.shotMax));

  beats.forEach((beat, bi) => {
    const bStart = bi === 0 ? 0 : F(beat.start);
    const bEnd = bi === beats.length - 1 ? endFrame : F(beats[bi + 1]!.start);
    const sectionEntities = new Set(beats.filter((b) => b.section === beat.section).flatMap((b) => b.entities.map((e) => e.entityId).filter((x): x is string => !!x)));
    let t = bStart;
    const pieces = Math.max(1, Math.ceil((bEnd - bStart) / maxF));
    const target = Math.ceil((bEnd - bStart) / pieces);
    let guard = 0;
    while (t < bEnd && guard++ < 50) {
      let len = Math.min(target, bEnd - t);
      if (bEnd - (t + len) < minF && bEnd - (t + len) > 0) len = bEnd - t; // avoid a tiny last shot
      const choice = chooseMedia(beat, library, recent, usage, prefs, sectionEntities, beats[bi + 1], reserved);
      if (!choice.item) {
        shots.push({ start: t, end: t + len, mediaId: null, beat: beat.index, quality: 'missing', reasons: choice.reasons, text: beat.text });
        t += len;
        continue;
      }
      const a = choice.item.asset;
      if (a.kind === 'video') {
        const maxLen = Math.max(1, F(a.probe.durationSec) - 1);
        if (len > maxLen) len = maxLen;
      }
      const v = a.probe.video;
      const portrait = !!v && v.height > v.width;
      const motion = a.kind === 'image' ? pickMotion(prefs, shots.length + 1, prevMotion, portrait) : 'none';
      prevMotion = motion;
      const c = clip(a.id, a.name, t, len, 0, motion, prefs.motionAmount);
      // stills whose aspect differs from the frame (portrait pages, covers) get a blurred fill
      if (a.kind === 'image' && v && Math.abs(v.width / v.height - settings.width / settings.height) > 0.05) c.fill = 'blur';
      v1.clips.push(c);
      shots.push({ start: t, end: t + len, mediaId: a.id, beat: beat.index, quality: choice.quality, reasons: choice.reasons, text: beat.text });
      recent.push(a.id);
      usage.set(a.id, (usage.get(a.id) ?? 0) + 1);
      t += len;
    }
  });

  // transitions: dissolves at section changes (+ optional share inside sections)
  for (let i = 0; i + 1 < v1.clips.length; i++) {
    const l = v1.clips[i]!;
    const r = v1.clips[i + 1]!;
    if (l.start + l.duration !== r.start) continue;
    const sl = shots.find((s) => s.start === l.start);
    const sr = shots.find((s) => s.start === r.start);
    const sectionChange = sl && sr && beats[sl.beat]!.section !== beats[sr.beat]!.section;
    const share = ((Math.sin((i + 7) * 78.233) * 43758.5453) % 1 + 1) % 1 < prefs.dissolveShare;
    const frames = sectionChange ? prefs.sectionDissolveFrames : share ? Math.max(4, Math.round(prefs.sectionDissolveFrames / 2)) : 0;
    if (frames >= 2) v1.transitions.push({ id: newId(), kind: 'cross-dissolve', leftClipId: l.id, rightClipId: r.id, duration: Math.min(frames, l.duration, r.duration) });
  }
  // fade in from black / out to black
  if (v1.clips[0]) v1.clips[0].fadeIn = Math.min(F(0.5), v1.clips[0].duration);
  const lastV = v1.clips.at(-1);
  if (lastV) lastV.fadeOut = Math.min(F(1), lastV.duration);

  // narration
  const narr = clip(input.narration.id, input.narration.name, 0, Math.min(endFrame, secondsToFrames(narrDur, rate, 'floor')));
  if (input.narrationLufs != null && Number.isFinite(input.narrationLufs)) narr.gainDb = clampDb(prefs.narrationLufs - input.narrationLufs);
  a1.clips.push(narr);

  // music bed, looped to cover the video
  if (input.music?.probe.audio) {
    const m = input.music;
    const loopLen = secondsToFrames(m.probe.durationSec, rate, 'floor');
    const level = prefs.narrationLufs + prefs.musicRelativeDb;
    const gain = input.musicLufs != null && Number.isFinite(input.musicLufs) ? clampDb(level - input.musicLufs) : prefs.musicRelativeDb;
    for (let t = 0; t < endFrame && loopLen > 0; t += loopLen) {
      const c = clip(m.id, m.name, t, Math.min(loopLen, endFrame - t));
      c.gainDb = gain;
      c.fadeIn = t === 0 ? Math.min(F(1), c.duration) : Math.min(F(0.3), c.duration);
      c.fadeOut = Math.min(t + loopLen >= endFrame ? F(2) : F(0.3), c.duration - c.fadeIn);
      a2.clips.push(c);
    }
  }

  // captions
  const captions: Caption[] = [];
  const add = (start: number, end: number, text: string, style: Caption['style']) => {
    if (end > start) captions.push({ id: newId(), start, end: Math.min(end, endFrame), text, style });
  };
  if (prefs.subtitles) {
    for (const s of input.alignment.sentences) {
      let chunk: typeof s.words = [];
      const flush = () => {
        if (!chunk.length) return;
        const text = chunk.map((w) => w.text).join(' ');
        const lines = wrapLines(text) ?? [text];
        add(F(chunk[0]!.start), F(chunk.at(-1)!.end + 0.15), lines.join('\n'), 'subtitle');
        chunk = [];
      };
      for (const w of s.words) {
        const next = [...chunk, w].map((x) => x.text).join(' ');
        if (chunk.length && !wrapLines(next)) flush();
        chunk.push(w);
        if (/[.!?;:]$/.test(w.text) && chunk.map((x) => x.text).join(' ').length > 30) flush();
      }
      flush();
    }
    // keep subtitles from overlapping
    captions.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < captions.length; i++) if (captions[i]!.end > captions[i + 1]!.start) captions[i]!.end = captions[i + 1]!.start;
  }
  if (prefs.sectionTitles) {
    for (const t of input.script.titles) {
      const first = beats.find((b) => b.section === t.section);
      if (!first) continue;
      const st = first.index === 0 ? F(0.3) : F(first.start);
      add(st, st + F(2.5), t.text, 'title');
    }
  }
  if (prefs.lowerThirds) {
    const seen = new Set<string>();
    for (const b of beats) {
      for (const e of b.entities) {
        if (!e.entityId || seen.has(e.entityId) || !(e.kind === 'character' || e.kind === 'team')) continue;
        seen.add(e.entityId);
        const entry = index.get(e.entityId);
        const pub = entry?.publisher ? index.get(entry.publisher)?.name : undefined;
        let st = F(b.start + 0.3);
        for (const c of captions) if ((c.style === 'title' || c.style === 'lower-third') && c.start < st + F(3) && c.end > st) st = c.end + F(0.2);
        if (st + F(3) > F(b.end) + F(1.5)) continue; // would drift too far from the mention
        add(st, st + F(3), pub ? `${e.name}\n${pub}` : e.name, 'lower-third');
        break; // at most one lower third per beat
      }
    }
  }
  for (const s of shots.filter((x) => x.quality === 'missing')) {
    const b = beats[s.beat]!;
    const need = [...b.hints, ...b.entities.map((e) => e.name), ...b.keywords.slice(0, 3)].slice(0, 4).join(', ');
    add(s.start, s.end, `VISUEL MANQUANT\n${need || 'illustration'}`, 'placeholder');
  }
  seq.captions = captions.sort((a, b) => a.start - b.start);
  normalizeSequence(seq, Object.fromEntries([...input.library, input.narration, ...(input.music ? [input.music] : [])].map((m) => [m.id, m])));
  void framesToSeconds;
  return { sequence: seq, beats, shots };
}
