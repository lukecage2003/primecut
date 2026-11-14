/**
 * Timeline construction: turns a plan (beats, shots) into a real Sequence that the editor, the
 * preview and the exporter use like any hand-made edit. Everything stays editable afterwards.
 */
import {
  DEFAULT_DUCK,
  type SfxKind,
  addTrack,
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
  subtitleChars,
  DEFAULT_TRANSFORM,
  normalizeSequence,
  windowFor,
  pageTour,
  PANEL_TRUST,
  type GeneratorSpec,
  type VisualKind,
  VISUAL_KINDS,
  specHash,
  COMIC_FORMAT_LABEL,
  type EditDecision,
  type EditDecisionGraph,
  type DecisionCandidate,
  carryOver,
  createGraph,
  decisionId,
  textHash,
} from '../core';
import type { MusicSegment } from './musicPlan';
import type { SectionNarrative } from './narrative';
import { decideVisual } from './visuals';
import { semanticEvents } from '../pcore/expression';
import { type PlacementSettings, planPlacement } from '../pcore/placement';
import { scriptEntities } from './entities';
import { SEED_KNOWLEDGE } from './knowledge';
import { beatPacing, speechRates } from './pacing';
import type { AlignmentResult } from './align';
import { EntityIndex } from './entities';
import { type Beat, type ShotChoice, buildBeats, chooseMedia, indexLibrary, pickMotion, reserveHinted, scoreItem } from './planner';
import { type StoryPlan, planStoryOrder, spanAt, storyModeApplies } from './storyOrder';
import type { ProductionPreferences } from './preferences';
import type { ParsedScript } from './script';

export interface BuildInput {
  name: string;
  settings: SequenceSettings;
  script: ParsedScript;
  alignment: AlignmentResult;
  narration: MediaAsset;
  narrationLufs?: number | null;
  /** Where the edit ends in the narration (s): an off-script tail (outtake) is left out. */
  narrationEndSec?: number;
  music?: MediaAsset | null;
  musicLufs?: number | null;
  library: MediaAsset[];
  prefs: ProductionPreferences;
  entityIndex?: EntityIndex;
  /** P-CORE placement settings (sizes, corner, margins). */
  pcorePlacement?: Partial<PlacementSettings>;
  /** Decision graph of the version being regenerated: locks, validations and rejections are kept. */
  previous?: EditDecisionGraph;
  /** Music per section from the music library (replaces `music` when given). */
  musicSegments?: { media: MediaAsset; lufs: number | null; segment: MusicSegment }[];
  /** Narrative reading of the script (sections), recorded with the version. */
  narrative?: SectionNarrative[];
  /** P-CORE V2 direction (director cues + settings). Absent = P-CORE V1.1 behaviour. */
  pcoreV2?: { cues: import('../pcore/v2/director').PCoreCue[]; settings: import('../pcore/v2/config').PCoreV2Settings };
}

export interface BuildResult {
  sequence: Sequence;
  /** Procedural composition assets to render (path empty until the engine renders them). */
  generated: MediaAsset[];
  beats: Beat[];
  shots: ProductionShotMeta[];
  /** Edit decision graph of this version. */
  edg: EditDecisionGraph;
  /** Music placed per section (empty without music). */
  music: NonNullable<import('../core').ProductionMeta['music']>;
  /** Story mode: comic pages laid along the narration in reading order (null when not used). */
  story: StoryPlan | null;
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
  const index = input.entityIndex ?? new EntityIndex([...SEED_KNOWLEDGE, ...scriptEntities(input.script)]);
  const beats = buildBeats(input.script, input.alignment.sentences, prefs, index);
  const library = indexLibrary(input.library, index);
  const seq = createSequence(input.name, settings);
  const [v1, v2, a1, a2] = [seq.tracks[0]!, seq.tracks[1]!, seq.tracks[2]!, seq.tracks[3]!];
  void v2;
  const narrDur = Math.min(input.narration.probe.durationSec, input.narrationEndSec ?? Infinity);
  const endFrame = F(narrDur + 1);
  const shots: ProductionShotMeta[] = [];
  const generated: MediaAsset[] = [];
  let prevVisual: VisualKind | null = null;
  const speechIn = (a: number, b: number) =>
    input.alignment.sentences.reduce((acc, s) => acc + Math.max(0, Math.min(b, s.end) - Math.max(a, s.start)), 0);
  /** Pads (s) rendered before/after generated shots so transitions have handles. */
  const PAD = 1;
  const cardShownAt = new Map<string, number>();
  const makeVisual = (beat: Beat, t: number, len: number, why: string[], ord: { id: string; ordinal: number }, candidates: DecisionCandidate[] = [], criteria: string[] = []) => {
    const startSec = framesToSeconds(t, rate);
    const durSec = framesToSeconds(len, rate);
    const titleSection = prefs.sectionTitles && input.script.titles.some((ti) => ti.section === beat.section) && beats.find((b) => b.section === beat.section) === beat && startSec < beat.start + 3;
    // a name gets its card when it is introduced, then at most once every 3 minutes
    const recentCards = new Set([...cardShownAt].filter(([, at]) => startSec - at < 180).map(([n]) => n));
    const dec = decideVisual(beat, { index, previous: prevVisual, shotIndex: shots.length, speechSec: speechIn(startSec, startSec + durSec), durationSec: durSec, style: prefs.visualStyle, subtitles: prefs.subtitles, titleOnScreen: titleSection, recentCards, presenter: presenter || heroGaps });
    if (dec.spec.kind === 'character-card' && dec.spec.title) cardShownAt.set(dec.spec.title.toLowerCase(), startSec);
    prevVisual = dec.spec.kind;
    const spec: GeneratorSpec = { ...dec.spec, durationSec: durSec + 2 * PAD, audio: { mediaId: input.narration.id, offsetSec: Math.max(0, startSec - PAD) } };
    // with P-CORE, voice-reactive backgrounds drop their own hologram: P-CORE is the presence
    if ((prefs.pcore ?? 'off') !== 'off' && ['audio-hud', 'dramatic', 'cosmic', 'data-matrix'].includes(spec.kind)) spec.backdrop = true;
    const label = VISUAL_KINDS.find((k) => k.id === spec.kind)?.label ?? spec.kind;
    const asset: MediaAsset = {
      id: newId(),
      name: `${label}${spec.title ? ` · ${spec.title}` : ''}`,
      kind: 'video',
      path: '',
      fingerprint: { size: 0, mtimeMs: 0, partialHash: specHash(spec, settings.width, settings.height, `${rate.num}/${rate.den}`) },
      probe: { durationSec: spec.durationSec, container: 'mp4', video: { codec: 'h264', width: settings.width, height: settings.height, frameRate: rate, avgFrameRate: rate, isVFR: false, pixFmt: 'yuv420p', rotation: 0 } },
      importedAt: new Date().toISOString(),
      rights: { usage: 'owned', source: 'primestone-visuals', checkedAt: new Date().toISOString(), note: 'Procedural composition rendered locally' },
      generator: spec,
    };
    generated.push(asset);
    const c = clip(asset.id, asset.name, t, len, Math.min(PAD, startSec));
    v1.clips.push(c);
    const reasons = [...why, `animation : ${dec.reason}`];
    const chosen: DecisionCandidate = { mediaId: asset.id, label: asset.name, score: 0, confidence: 0, evidence: [{ basis: 'aucune', detail: why[0] ?? 'aucune image liée', weight: 0 }], generated: true };
    const decisionId = record(beat, ord, c.id, t, t + len, chosen, [chosen, ...candidates], [...criteria, 'aucune image liée à ce passage : composition animée à la place (jamais d’écran noir)']);
    shots.push({ start: t, end: t + len, mediaId: asset.id, beat: beat.index, quality: 'generated', reasons, text: beat.text, decisionId, confidence: 0 });
  };
  const carry = carryOver(input.previous, prefs.keepUnchanged ?? true);
  const decisions: EditDecision[] = [];
  const ordinals = new Map<string, number>();
  const nextId = (text: string) => {
    const n = ordinals.get(text) ?? 0;
    ordinals.set(text, n + 1);
    return { id: decisionId('visuel', text, n), ordinal: n };
  };
  const at = new Date().toISOString();
  const record = (beat: Beat, ord: { id: string; ordinal: number }, clipId: string | null, start: number, end: number, chosen: DecisionCandidate, candidates: DecisionCandidate[], criteria: string[]) => {
    const prev = carry.get(ord.id);
    const kept = !!prev && prev.forced !== undefined && (prev.forced === chosen.mediaId || (prev.generated && chosen.generated));
    decisions.push({
      id: ord.id,
      kind: 'visuel',
      anchor: { beat: beat.index, section: beat.section, ordinal: ord.ordinal, text: beat.text, textHash: textHash(beat.text), start, end },
      clipIds: clipId ? [clipId] : [],
      chosen,
      candidates: candidates.length ? candidates : [chosen],
      criteria,
      confidence: chosen.confidence,
      deps: [...beat.sentenceIndexes.map((i) => `phrase:${textHash(input.script.sentences[i]?.text ?? '')}`), `section:${beat.section}`, ...(chosen.mediaId && !chosen.generated ? [`media:${chosen.mediaId}`] : [])],
      state: kept ? prev!.state : 'proposée',
      author: kept ? prev!.author : 'auto',
      rejected: prev?.rejected ?? [],
      history: [...(prev?.history ?? []), { at, action: kept ? 'conservée' : 'créée', by: 'auto', detail: kept ? 'régénération : choix conservé' : prev ? 'régénération : nouvelle proposition' : undefined }],
    });
    return ord.id;
  };
  const reserved = reserveHinted(beats, library);
  const rates = speechRates(input.script.sentences, input.alignment.sentences);
  const recent: string[] = [];
  const usage = new Map<string, number>();
  let prevMotion: MotionKind | null = null;
  // presenter mode (faceless, no pictures, P-CORE V2): P-CORE leads; backgrounds change rarely
  const presenter = (prefs.presenter ?? true) && (prefs.pcore ?? 'off') !== 'off' && !!input.pcoreV2 && library.length === 0;
  // with pictures and the P-CORE badge, the moments without a picture belong to P-CORE (front, voice-reactive) over calm backgrounds
  const heroGaps = !presenter && (prefs.pcoreBadge ?? true) && (prefs.pcore ?? 'off') !== 'off' && !!input.pcoreV2;
  const minF = presenter ? F(7) : Math.max(1, F(prefs.shotMin));
  const maxF = presenter ? F(14) : Math.max(minF, F(prefs.shotMax));

  // story mode: the pages of the comic book follow the narration in reading order
  const story = storyModeApplies(library, prefs.storyOrder ?? 'auto') ? planStoryOrder(beats, library, narrDur, { minPageSec: Math.max(2, prefs.shotMin + 0.5) }) : null;
  let storyAt = -1;
  const storyChoice = (beat: Beat, sec: number): { choice: ShotChoice; endSec: number; progress: number } | null => {
    if (!story) return null;
    const { span, progress, index } = spanAt(story, sec + 0.04, storyAt + 1);
    storyAt = Math.max(storyAt, index);
    const it = span.item;
    const pg = it.asset.page!;
    const { score, reasons, evidence } = scoreItem(beat, it);
    const ev = [...evidence, { basis: 'ordre' as const, detail: `page ${pg.n}/${pg.of} de « ${pg.book} »${span.anchored ? ` · ancrée : ${span.anchored}` : ''}`, weight: 0 }];
    const confidence = span.anchored ? 0.9 : Math.max(0.6, Math.min(0.85, 0.6 + 0.1 * score));
    return {
      endSec: span.end,
      progress,
      choice: { item: it, score, reasons: [`ordre de lecture : page ${pg.n}/${pg.of} de « ${pg.book} »`, ...(span.anchored ? [`ancrée : ${span.anchored}`] : []), ...reasons], quality: 'strong', evidence: ev, confidence, candidates: [{ mediaId: it.asset.id, label: it.asset.name, score: +score.toFixed(2), confidence, evidence: ev }], criteria: ['mode histoire : les pages suivent la narration dans l’ordre du livre'] },
    };
  };

  beats.forEach((beat, bi) => {
    const bStart = bi === 0 ? 0 : F(beat.start);
    const bEnd = bi === beats.length - 1 ? endFrame : F(beats[bi + 1]!.start);
    const sectionEntities = new Set(beats.filter((b) => b.section === beat.section).flatMap((b) => b.entities.map((e) => e.entityId).filter((x): x is string => !!x)));
    let t = bStart;
    const pace = beatPacing(beat, input.script.sentences, rates);
    const paceF = Math.max(minF, Math.round(maxF * pace.shotFactor));
    const pieces = Math.max(1, Math.ceil((bEnd - bStart) / paceF));
    const target = Math.ceil((bEnd - bStart) / pieces);
    let guard = 0;
    while (t < bEnd && guard++ < 50) {
      let len = Math.min(target, bEnd - t);
      if (bEnd - (t + len) < minF && bEnd - (t + len) > 0) len = bEnd - t; // avoid a tiny last shot
      const ord = nextId(beat.text);
      const prev = carry.get(ord.id);
      if (prev?.generated && prefs.proceduralVisuals) {
        makeVisual(beat, t, len, ['composition conservée de la version précédente'], ord);
        t += len;
        continue;
      }
      // story mode (unless the creator locked another choice, or the script asks for a specific non-book picture)
      const hinted = [...reserved].some(([id, b]) => b === beat.index && !library.find((l) => l.asset.id === id)?.asset.page);
      const st = !prev?.forced && !prev?.generated && !hinted ? storyChoice(beat, framesToSeconds(t, rate)) : null;
      let panelFrom = 0;
      let choice: ShotChoice;
      if (st) {
        // the shot ends where the page ends (or at the end of the passage), never in a tiny remainder
        const pageEnd = F(st.endSec);
        len = Math.min(bEnd - t, Math.max(minF, pageEnd - t));
        if (bEnd - (t + len) < minF && bEnd - (t + len) > 0) len = bEnd - t;
        const pn = st.choice.item!.asset.panels?.length ?? 0;
        panelFrom = Math.min(Math.max(0, pn - 1), Math.floor(st.progress * pn));
        choice = st.choice;
      } else choice = chooseMedia(beat, library, recent, usage, prefs, sectionEntities, beats[bi + 1], reserved, { forced: prev?.forced, exclude: new Set(prev?.rejected ?? []), fillUnrelated: prefs.fillUnrelated });
      // a second shot inside a beat must not take the image the next beat is really about:
      // the previous shot of this beat holds a little longer instead
      const nextBeat = beats[bi + 1];
      const prevClip = v1.clips.at(-1);
      if (!st && t > bStart && !prev?.forced && choice.item && nextBeat && prevClip && prevClip.start + prevClip.duration === t && shots.at(-1)?.beat === beat.index && input.library.find((a) => a.id === prevClip.mediaId)?.kind === 'image') {
        const here = scoreItem(beat, choice.item).score;
        const there = scoreItem(nextBeat, choice.item).score;
        if (there > here && prevClip.duration + len <= Math.round(maxF * 2)) {
          prevClip.duration += len;
          shots.at(-1)!.end += len;
          const d = decisions.at(-1);
          if (d) d.anchor.end += len;
          ordinals.set(beat.text, ord.ordinal); // this rank was not used
          t += len;
          continue;
        }
      }
      const generic = choice.quality === 'weak' && choice.reasons.some((r) => r.startsWith('aucune correspondance'));
      if (prefs.proceduralVisuals && (!choice.item || generic)) {
        makeVisual(beat, t, len, [...(choice.item ? ['aucune illustration liée à ce passage'] : choice.reasons)], ord, choice.candidates, choice.criteria);
        t += len;
        continue;
      }
      if (!choice.item) {
        const chosen: DecisionCandidate = { mediaId: null, label: 'visuel manquant', score: 0, confidence: 0, evidence: choice.evidence };
        const id = record(beat, ord, null, t, t + len, chosen, [chosen], choice.criteria);
        shots.push({ start: t, end: t + len, mediaId: null, beat: beat.index, quality: 'missing', reasons: choice.reasons, text: beat.text, decisionId: id, confidence: 0 });
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
      const c = clip(a.id, a.name, t, len, 0, motion, prefs.motionAmount * (0.85 + 0.3 * pace.intensity));
      // comic pages with detected panels are read panel by panel when the shot allows it
      // (story mode: a page shown over several passages continues where its reading stopped)
      // a page whose panels are uncertain is never cut out (a wrong outline would split a picture in two):
      // it is shown whole, then travelled over in large full-width windows so the details read well
      const isPage = !!a.page || a.comic?.format === 'planche' || a.comic?.format === 'double-page';
      const trusted = !!a.panels && a.panels.length >= 2 && (a.panelConfidence ?? 1) >= PANEL_TRUST;
      const imgAspect = v ? v.width / v.height : 1;
      const route = trusted ? a.panels! : isPage && v && prefs.panelReading ? pageTour(imgAspect, settings.width / settings.height) : undefined;
      const from = route && st && route !== a.panels ? Math.min(route.length - 1, Math.floor(st.progress * route.length)) : panelFrom;
      let rest = route ? route.slice(Math.min(from, route.length - 1)) : undefined;
      const perStop = route && route !== a.panels ? Math.max(prefs.secondsPerPanel, 2.2) : prefs.secondsPerPanel;
      // a short shot skips the whole-page view (small on a landscape frame) and goes straight to readable windows
      if (route && route !== a.panels && rest && rest[0]?.h === 1 && rest[0].w === 1 && framesToSeconds(len, rate) < perStop * 3) rest = rest.slice(1);
      const nPanels = rest ? Math.min(rest.length, Math.floor(framesToSeconds(len, rate) / perStop)) : 0;
      if (prefs.panelReading && a.kind === 'image' && v && rest && rest.length >= 2 && nPanels >= 2) {
        c.motion = { kind: 'panels', amount: 0, path: rest.slice(0, nPanels).map((p) => windowFor(p, imgAspect, settings.width / settings.height)) };
        if (route !== a.panels) choice.reasons.push(a.panels ? `découpage des cases incertain (${Math.round((a.panelConfidence ?? 0) * 100)} %) : page montrée en entier puis parcourue, sans couper de case` : 'page parcourue en entier (cases non détectées), sans découpage');
      } else if (isPage && v && a.comic?.format !== 'couverture' && imgAspect < (settings.width / settings.height) * 0.9) {
        // too short for a panel-by-panel reading: a portrait page shown whole on a landscape frame is too small
        // to read, so the camera travels down the page at a readable size instead
        // full frame width: a window as wide as the page, from the top of the page to the bottom
        const box = settings.width / settings.height;
        const band = Math.min(1, (imgAspect / box) * 1.25);
        c.motion = { kind: 'panels', amount: 0, path: [{ x: 0, y: 0, w: 1, h: band }, { x: 0, y: 1 - band, w: 1, h: band }].map((p) => windowFor(p, imgAspect, box, 0)) };
        choice.reasons.push('plan court : la page défile de haut en bas sur toute la largeur de l’image');
      }
      // a cover is revealed with a slow push-in; a webtoon strip that cannot be read panel by panel scrolls down
      if (a.comic?.format === 'couverture' && c.motion.kind !== 'panels') c.motion = { kind: 'zoom-in', amount: Math.max(0.08, c.motion.amount) };
      if (a.comic?.format === 'webtoon' && c.motion.kind !== 'panels') c.motion = { kind: 'pan-down', amount: Math.max(0.2, c.motion.amount) };
      // stills whose aspect differs from the frame (portrait pages, covers) get a blurred fill
      if (a.kind === 'image' && v && c.motion.kind !== 'panels' && Math.abs(v.width / v.height - settings.width / settings.height) > 0.05) c.fill = 'blur';
      v1.clips.push(c);
      const metadataOnly = !choice.evidence.some((e) => e.basis === 'texte-ocr' || e.basis === 'description' || e.basis === 'utilisateur');
      const chosenC: DecisionCandidate = choice.candidates.find((x) => x.mediaId === a.id) ?? { mediaId: a.id, label: a.name, score: +choice.score.toFixed(2), confidence: choice.confidence, evidence: choice.evidence };
      const did = record(beat, ord, c.id, t, t + len, { ...chosenC, evidence: choice.evidence, confidence: choice.confidence }, choice.candidates, choice.criteria);
      shots.push({ decisionId: did, confidence: choice.confidence, metadataOnly, start: t, end: t + len, mediaId: a.id, beat: beat.index, quality: choice.quality, reasons: [...choice.reasons, ...(a.comic && a.comic.format !== 'illustration' ? [`format : ${COMIC_FORMAT_LABEL[a.comic.format]}${a.comic.manga ? ' manga, lecture de droite à gauche' : ''}${c.motion.kind === 'panels' ? ` · lue case par case (${c.motion.path?.length ?? 0} cases)` : ''}`] : []), ...(pace.label === 'neutral' ? [] : [`rythme : ${pace.label === 'calm' ? 'calme' : 'intense'}`])], text: beat.text });
      recent.push(choice.item.same);
      usage.set(choice.item.same, (usage.get(choice.item.same) ?? 0) + 1);
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

  // music: one bed per section group (music library) or the imposed track, looped to cover its span
  const duck = Math.min(0, prefs.duckDepthDb ?? 0);
  const level = prefs.narrationLufs + prefs.musicRelativeDb - duck;
  const gainFor = (lufs: number | null | undefined) => (lufs != null && Number.isFinite(lufs) ? Math.max(-40, Math.min(12, level - lufs)) : prefs.musicRelativeDb - duck);
  const placeBed = (m: MediaAsset, gain: number, from: number, to: number, fadeIn: number, fadeOut: number): string[] => {
    const loopLen = secondsToFrames(m.probe.durationSec, rate, 'floor');
    const ids: string[] = [];
    for (let t = from; t < to && loopLen > 0; t += loopLen) {
      const c = clip(m.id, m.name, t, Math.min(loopLen, to - t));
      c.gainDb = gain;
      c.fadeIn = t === from ? Math.min(fadeIn, c.duration) : Math.min(F(0.3), c.duration);
      c.fadeOut = Math.min(t + loopLen >= to ? fadeOut : F(0.3), c.duration - c.fadeIn);
      a2.clips.push(c);
      ids.push(c.id);
    }
    return ids;
  };
  const musicMeta: NonNullable<import('../core').ProductionMeta['music']> = [];
  if (input.musicSegments?.length) {
    if (duck < 0) a2.duck = { ...DEFAULT_DUCK, by: a1.id, depthDb: duck };
    const segs = input.musicSegments.filter((x) => x.media.probe.audio);
    segs.forEach((x, i) => {
      const from = i === 0 ? 0 : F(x.segment.start);
      const to = i === segs.length - 1 ? endFrame : F(segs[i + 1]!.segment.start);
      if (to - from < 2) return;
      const ids = placeBed(x.media, gainFor(x.lufs), from, to, i === 0 ? F(1) : F(1.2), i === segs.length - 1 ? F(2) : F(1.2));
      const seg = x.segment;
      const id = decisionId('musique', seg.anchor, 0);
      const prevM = carry.get(id);
      const evidence = [{ basis: (seg.locked ? 'utilisateur' : 'musique') as 'utilisateur' | 'musique', detail: seg.reasons.join(' · '), weight: 0 }];
      const chosen: DecisionCandidate = { mediaId: x.media.id, label: seg.title, score: seg.candidates[0]?.score ?? 0, confidence: seg.confidence, evidence, trackId: seg.trackId ?? undefined };
      decisions.push({
        id,
        kind: 'musique',
        anchor: { section: seg.sections[0], ordinal: 0, text: seg.key, textHash: textHash(seg.anchor), start: from, end: to },
        clipIds: ids,
        chosen,
        candidates: seg.candidates.map((c) => ({ mediaId: null, label: c.title, score: c.score, confidence: 0, evidence: [{ basis: 'musique', detail: c.reasons.join(' · '), weight: c.score }], trackId: c.trackId })),
        criteria: ['changement de piste seulement aux frontières de section', 'voix chantée évitée', 'licences NC/ND écartées'],
        confidence: seg.confidence,
        deps: seg.sections.map((n) => `section:${n}`).concat(seg.trackId ? [`piste:${seg.trackId}`] : []),
        state: seg.locked ? (prevM?.state ?? 'verrouillée') : 'proposée',
        author: seg.locked ? 'utilisateur' : 'auto',
        rejected: prevM?.rejected ?? [],
        history: [...(prevM?.history ?? []), { at, action: seg.locked ? 'conservée' : 'créée', by: 'auto' }],
      });
      musicMeta.push({ trackId: seg.trackId, mediaId: x.media.id, title: seg.title, start: framesToSeconds(from, rate), end: framesToSeconds(to, rate), sections: seg.sections, reasons: seg.reasons, confidence: seg.confidence, decisionId: id });
    });
    // at each switch (placed on a pause of the voice) the outgoing bed fades out and the next one fades in
  } else if (input.music?.probe.audio) {
    const m = input.music;
    if (duck < 0) a2.duck = { ...DEFAULT_DUCK, by: a1.id, depthDb: duck };
    const ids = placeBed(m, gainFor(input.musicLufs), 0, endFrame, F(1), F(2));
    const id = decisionId('musique', 'piste imposée', 0);
    const chosen: DecisionCandidate = { mediaId: m.id, label: m.name, score: 0, confidence: 1, evidence: [{ basis: 'utilisateur', detail: 'piste choisie dans le panneau de production', weight: 0 }] };
    decisions.push({ id, kind: 'musique', anchor: { ordinal: 0, text: 'toute la vidéo', textHash: textHash('piste imposée'), start: 0, end: endFrame }, clipIds: ids, chosen, candidates: [chosen], criteria: ['piste imposée par vous'], confidence: 1, deps: [`media:${m.id}`], state: 'acceptée', author: 'utilisateur', rejected: [], history: [{ at, action: 'créée', by: 'utilisateur' }] });
    musicMeta.push({ trackId: null, mediaId: m.id, title: m.name, start: 0, end: framesToSeconds(endFrame, rate), sections: [], reasons: ['piste choisie par vous'], confidence: 1, decisionId: id });
  }

  // captions
  const captions: Caption[] = [];
  const add = (start: number, end: number, text: string, style: Caption['style']) => {
    if (end > start) captions.push({ id: newId(), start, end: Math.min(end, endFrame), text, style });
  };
  if (prefs.subtitles) {
    // line length that really fits this frame (portrait formats hold fewer characters per line)
    const maxChars = subtitleChars(settings.width, settings.height);
    const wrap = (t: string) => wrapLines(t, maxChars);
    const subs: { start: number; end: number; words: string[] }[] = [];
    for (const s of input.alignment.sentences) {
      const chunks: (typeof s.words)[] = [];
      let chunk: typeof s.words = [];
      for (const w of s.words) {
        const next = [...chunk, w].map((x) => x.text).join(' ');
        if (chunk.length && !wrap(next)) (chunks.push(chunk), (chunk = []));
        chunk.push(w);
        if (/[.!?;:]$/.test(w.text) && chunk.map((x) => x.text).join(' ').length > 30) (chunks.push(chunk), (chunk = []));
      }
      if (chunk.length) chunks.push(chunk);
      // a very short chunk (one quick word) is merged into its neighbour when it still fits on two lines
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const dur = c.at(-1)!.end - c[0]!.start;
        if (dur >= 0.9 || chunks.length < 2) continue;
        const prev = chunks[i - 1];
        const nxt = chunks[i + 1];
        if (prev && wrap([...prev, ...c].map((x) => x.text).join(' '))) {
          prev.push(...c);
          chunks.splice(i--, 1);
        } else if (nxt && wrap([...c, ...nxt].map((x) => x.text).join(' '))) {
          nxt.unshift(...c);
          chunks.splice(i--, 1);
        }
      }
      for (const c of chunks) subs.push({ start: c[0]!.start, end: c.at(-1)!.end + 0.15, words: c.map((x) => x.text) });
    }
    // every subtitle stays readable: at least 0.9 s when the next one leaves room
    subs.forEach((x, i) => {
      const room = (subs[i + 1]?.start ?? Infinity) - 0.05;
      if (x.end - x.start < 0.9) x.end = Math.min(room, x.start + 0.9);
    });
    for (const x of subs) {
      const text = x.words.join(' ');
      add(F(x.start), F(x.end), (wrap(text) ?? [text]).join('\n'), 'subtitle');
    }
    // keep subtitles from overlapping
    captions.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < captions.length; i++) if (captions[i]!.end > captions[i + 1]!.start) captions[i]!.end = captions[i + 1]!.start;
  }
  // presenter mode: chapter titles are shown by the P-CORE data matrix, not as text over it
  const chapters = input.script.titles.map((t) => ({ time: beats.find((b) => b.section === t.section)?.start ?? 0, title: t.text }));
  if (prefs.sectionTitles && !presenter) {
    for (const t of input.script.titles) {
      const first = beats.find((b) => b.section === t.section);
      if (!first) continue;
      // a title that only repeats the words being said (and subtitled) would be the same text twice on screen
      const bare = t.text.replace(/[…."'«»]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const said = first.text.replace(/["'«»]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (prefs.subtitles && bare.length > 0 && said.startsWith(bare)) continue;
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
        // the picture under it already shows this name (character card): no second name on screen
        const shown = v1.clips.some((c) => {
          if (c.start >= st + F(3) || c.start + c.duration <= st) return false;
          const g = generated.find((x) => x.id === c.mediaId)?.generator;
          return !!g && (g.kind === 'character-card' || g.kind === 'typography') && !!g.title && g.title.toLowerCase().includes(e.name.toLowerCase());
        });
        if (shown) break;
        add(st, st + F(3), pub ? `${e.name}\n${pub}` : e.name, 'lower-third');
        break; // at most one lower third per beat
      }
    }
  }
  // on-screen texts requested by the script (unless a typography composition already shows them)
  for (const b of beats) {
    if (!b.onScreen.length) continue;
    const shown = generated.some((g) => g.generator?.kind === 'typography' && g.generator.title && b.onScreen.includes(g.generator.title));
    if (shown) continue;
    let st = F(b.start + 0.2);
    for (const c of captions) if ((c.style === 'title' || c.style === 'lower-third') && c.start < st + F(3) && c.end > st) st = c.end + F(0.2);
    add(st, st + F(3), b.onScreen[0]!, 'title');
  }
  for (const s of shots.filter((x) => x.quality === 'missing')) {
    const b = beats[s.beat]!;
    const need = [...b.hints, ...b.entities.map((e) => e.name), ...b.keywords.slice(0, 3)].slice(0, 4).join(', ');
    add(s.start, s.end, `VISUEL MANQUANT\n${need || 'illustration'}`, 'placeholder');
  }
  seq.captions = captions.sort((a, b) => a.start - b.start);

  // sound design: whoosh on section changes, soft impact under section titles (procedural, local)
  if (prefs.sfx) {
    const cuts: number[] = [];
    for (let i = 0; i + 1 < v1.clips.length; i++) {
      const sl = shots.find((x) => x.start === v1.clips[i]!.start);
      const sr = shots.find((x) => x.start === v1.clips[i + 1]!.start);
      if (sl && sr && beats[sl.beat]!.section !== beats[sr.beat]!.section) cuts.push(v1.clips[i + 1]!.start);
    }
    const sfxAssets = new Map<string, MediaAsset>();
    const sfxAsset = (kind: SfxKind, variant: number, dur: number): MediaAsset => {
      const key = `${kind}-${variant}`;
      let a = sfxAssets.get(key);
      if (!a) {
        a = {
          id: newId(),
          name: `SFX · ${kind} ${variant + 1}`,
          kind: 'audio',
          path: '',
          fingerprint: { size: 0, mtimeMs: 0, partialHash: `sfx-${key}-${dur}` },
          probe: { durationSec: dur, container: 'wav', audio: { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 } },
          importedAt: new Date().toISOString(),
          rights: { usage: 'owned', source: 'primestone-sfx', checkedAt: new Date().toISOString(), note: 'Sound effect synthesised locally' },
          sfx: { kind, seed: variant + 1, durationSec: dur },
        } as MediaAsset;
        sfxAssets.set(key, a);
        generated.push(a);
      }
      return a;
    };
    const events: { at: number; kind: SfxKind; dur: number; lead: number }[] = [];
    for (const c of cuts) events.push({ at: c, kind: 'whoosh', dur: 1.1, lead: 0.6 });
    for (const t of captions.filter((c) => c.style === 'title')) events.push({ at: t.start, kind: 'impact', dur: 1.6, lead: 0.02 });
    events.sort((a, b) => a.at - b.at);
    const a3Id = addTrack(seq, 'audio');
    const a3 = seq.tracks.find((t) => t.id === a3Id)!;
    a3.name = 'SFX';
    let lastEnd = -Infinity;
    events.forEach((e, i) => {
      const st = Math.max(0, e.at - F(e.lead));
      const len = Math.min(F(e.dur), endFrame - st);
      if (st < lastEnd || len < 2) return; // never stack effects
      const a = sfxAsset(e.kind, i % 3, e.dur);
      const c = clip(a.id, a.name, st, len);
      c.gainDb = prefs.sfxDb ?? -12;
      a3.clips.push(c);
      lastEnd = st + len;
    });
    if (!a3.clips.length) seq.tracks = seq.tracks.filter((t) => t.id !== a3Id);
  }
  normalizeSequence(seq, Object.fromEntries([...input.library, ...generated, input.narration, ...(input.music ? [input.music] : []), ...(input.musicSegments ?? []).map((x) => x.media)].map((m) => [m.id, m])));
  void framesToSeconds;
  // P-CORE: the creator's visual presence on V2, placed from what V1 shows
  if ((prefs.pcore ?? 'off') !== 'off') {
    const fps = rate.num / rate.den;
    const pv2 = input.pcoreV2;
    const liveCues = pv2?.cues.filter((c) => c.state !== 'désactivée') ?? [];
    // V2: placement follows the director's cues; V1.1: the semantic events of the script
    const events = pv2
      ? liveCues.filter((c) => c.expression === 'revelation' || c.expression === 'deep-focus').map((c) => ({ time: c.start, duration: c.duration, state: (c.expression === 'revelation' ? 'reveal' : 'focus') as 'reveal' | 'focus', source: 'semantic' as const, label: c.expression }))
      : semanticEvents(input.alignment.sentences.map((a) => ({ start: a.start, end: a.end, text: input.script.sentences[a.index]?.text ?? '', section: input.script.sentences[a.index]?.section })));
    const cinematic = liveCues.filter((c) => c.expression === 'revelation' && c.intensity >= 0.8).map((c) => ({ time: c.start, duration: c.duration, reason: 'révélation' }));
    const mediaMap = Object.fromEntries([...input.library, ...generated].map((m) => [m.id, m]));
    const planned = planPlacement(seq, mediaMap, endFrame, { ...input.pcorePlacement, overIllustrations: prefs.pcore === 'always', ...(presenter ? { heroScale: 0.56, heroY: 0.41, cinematic: false, growOnReveal: false } : {}), ...(!presenter && (prefs.pcoreBadge ?? true) ? { badge: true, corner: 'bottom-right' as const } : {}) }, events, { captions: seq.captions, cinematic });
    // a placement too short to be seen (< 0.8 s) is absorbed by its neighbour: P-CORE never blinks out
    const segs: typeof planned = [];
    for (const g of planned) {
      const last = segs.at(-1);
      if (g.mode === 'hidden') continue;
      if (g.end - g.start < Math.round(fps * 0.8) && last && last.end === g.start) last.end = g.end;
      else if (g.end - g.start >= Math.round(fps * 0.8)) segs.push({ ...g });
    }
    const vTracks = seq.tracks.filter((t) => t.kind === 'video');
    const v2 = vTracks[1]!;
    // V2: consecutive placements cross-dissolve on two alternating tracks (no dip to transparent between them)
    const O = pv2 ? Math.round(fps * 0.4) : 0;
    let v3: typeof v2 | null = null;
    if (pv2 && segs.length > 1) {
      const id = addTrack(seq, 'video');
      v3 = seq.tracks.find((t) => t.id === id)!;
    }
    if (v3) v3.name = 'V3 · P-CORE';
    const U = Math.min(settings.width, settings.height);
    const LABEL: Record<string, string> = { hero: 'central', side: 'côté', corner: 'coin', cinematic: 'cinématique', hidden: 'masqué' };
    segs.forEach((g, k) => {
      const joinPrev = O > 0 && k > 0 && segs[k - 1]!.end === g.start;
      const joinNext = O > 0 && k + 1 < segs.length && segs[k + 1]!.start === g.end;
      const start = joinPrev ? Math.max(0, g.start - Math.floor(O / 2)) : g.start;
      const end = joinNext ? Math.min(endFrame, g.end + Math.ceil(O / 2)) : g.end;
      const size = Math.max(128, Math.min(2160, Math.round((g.transform.scale * U) / 2) * 2));
      const offsetSec = framesToSeconds(start, rate);
      const durationSec = framesToSeconds(end - start, rate);
      const mode = g.mode as 'hero' | 'side' | 'corner' | 'cinematic';
      const asset: MediaAsset = {
        id: newId(),
        name: `P-CORE · ${LABEL[g.mode] ?? g.mode}`,
        kind: 'video',
        path: '',
        fingerprint: { size: 0, mtimeMs: 0, partialHash: `pcore-${g.mode}-${size}-${offsetSec.toFixed(3)}-${durationSec.toFixed(3)}` },
        probe: { durationSec, container: 'webm', video: { codec: 'vp9', width: size, height: size, frameRate: rate, avgFrameRate: rate, isVFR: false, pixFmt: 'yuva420p', rotation: 0 } },
        importedAt: new Date().toISOString(),
        rights: { usage: 'owned', source: 'primestone-pcore', checkedAt: new Date().toISOString(), note: 'P-CORE presence rendered locally from the official logo' },
        hasAlpha: true,
        pcore: {
          audioMediaId: input.narration.id,
          offsetSec,
          durationSec,
          size,
          composition: mode === 'hero' || mode === 'cinematic' ? 'core' : 'floating',
          seed: 7,
          mode,
          events: events.filter((e) => e.time + e.duration > offsetSec && e.time < offsetSec + durationSec),
          ...(pv2 ? { engine: 'v2' as const, cues: pv2.cues.filter((c) => c.start < offsetSec + durationSec + 1 && c.start + c.duration > offsetSec - 6), v2: pv2.settings, ...(presenter ? { chapters: chapters.filter((c) => c.time < offsetSec + durationSec && c.time + 5 > offsetSec) } : {}) } : {}),
        },
      };
      generated.push(asset);
      const c = clip(asset.id, asset.name, start, end - start);
      c.transform = { ...g.transform };
      c.fadeIn = Math.min(joinPrev ? O : F(0.25), c.duration);
      c.fadeOut = Math.min(joinNext ? O : F(0.25), c.duration - c.fadeIn);
      (v3 && k % 2 === 1 ? v3 : v2).clips.push(c);
    });
    if (v3 && !v3.clips.length) seq.tracks = seq.tracks.filter((t) => t.id !== v3!.id);
  }
  return { sequence: seq, beats, shots, generated, edg: createGraph(decisions), music: musicMeta, story };
}
