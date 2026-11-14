import { produce as immer } from 'immer';
import { describe, expect, it } from 'vitest';
import {
  History,
  type MediaAsset,
  type Project,
  type Sequence,
  chooseCandidate,
  confidenceFrom,
  createProject,
  decisionId,
  graphFromShots,
  migrateProject,
  reconcileGraph,
  rejectDecision,
  setDecisionState,
  summariseGraph,
  validateProject,
} from '../../src/core';
import { DEFAULT_PREFERENCES, alignByPauses, buildSequence, chooseMedia, indexLibrary, parseScript, speechFromSilences, buildBeats } from '../../src/production';
import { reviewQc } from '../../src/production/qc';
import { fakeMedia } from './helpers';

const SCRIPT = `# Le retour du Bouffon Vert

En 1964, Spider-Man affronte pour la première fois le Bouffon Vert. Personne ne connaît alors son identité.
[VISUEL: couverture Amazing Spider-Man 14] Le numéro 14 marque un tournant pour M. Parker.

## La révélation

Des années plus tard, Norman Osborn est démasqué! C'est un choc pour les lecteurs de Marvel.
Et Venom arrive ensuite… mais c'est une autre histoire.`;

const img = (name: string, extra: Partial<MediaAsset> = {}) => {
  const m = fakeMedia({ name, kind: 'image', audio: false, durationSec: 0 });
  m.path = `/lib/${name}`;
  return Object.assign(m, extra);
};

function library() {
  return [img('spider-man_vs_green-goblin.jpg'), img('amazing-spider-man-14-cover.jpg'), img('norman-osborn-unmasked.png'), img('venom.jpg'), img('random-city.jpg'), img('osborn-portrait.jpg')];
}

function build(script = SCRIPT, lib = library(), previous?: Sequence['production'], prefs = DEFAULT_PREFERENCES) {
  const parsed = parseScript(script);
  const narration = fakeMedia({ name: 'voice.wav', kind: 'audio', video: false, durationSec: 30 });
  const silences = [0, 1, 2, 3, 4, 5].map((i) => ({ start: i * 5, end: i * 5 + 0.6 }));
  const alignment = alignByPauses(parsed.sentences, speechFromSilences(silences, 30));
  const project = createProject('P');
  const r = buildSequence({ name: 'Auto', settings: project.sequences[project.activeSequenceId]!.settings, script: parsed, alignment, narration, library: lib, prefs, previous: previous?.edg });
  r.sequence.production = { generatedAt: '', version: 1, alignment: { method: 'pauses', confidence: 1 }, preferencesVersion: 1, qcScore: 100, qcIssues: [], shots: r.shots, style: {}, narrationMediaId: narration.id, edg: r.edg };
  const media: Record<string, MediaAsset> = Object.fromEntries([...lib, ...r.generated, narration].map((m) => [m.id, m]));
  project.media = media;
  project.sequences = { [r.sequence.id]: r.sequence };
  project.activeSequenceId = r.sequence.id;
  return { ...r, media, lib, project };
}

describe('honest matching (metadata is not visual understanding)', () => {
  it('never places a picture with no relation to the passage unless asked', () => {
    const lib = [img('random-city.jpg'), img('sunset.jpg')];
    const off = build('Thanos rassemble les Pierres d’Infinité.', lib, undefined, { ...DEFAULT_PREFERENCES, proceduralVisuals: false });
    expect(off.sequence.tracks[0]!.clips.length).toBe(0);
    expect(off.shots.every((s) => s.quality === 'missing')).toBe(true);
    expect(off.sequence.captions.some((c) => c.style === 'placeholder')).toBe(true);
    const on = build('Thanos rassemble les Pierres d’Infinité.', lib, undefined, { ...DEFAULT_PREFERENCES, proceduralVisuals: false, fillUnrelated: true });
    expect(on.sequence.tracks[0]!.clips.length).toBeGreaterThan(0);
    expect(on.shots[0]!.quality).toBe('weak');
    expect(on.shots[0]!.confidence).toBeLessThan(0.2);
  });

  it('keyword overlap alone is a weak match; evidence names its source; file names cap confidence', () => {
    const parsed = parseScript('La ville dort sous la pluie.');
    const lib = indexLibrary([img('ville-pluie.jpg')]);
    const beats = buildBeats(parsed, [{ index: 0, start: 0, end: 3, words: [] } as never], DEFAULT_PREFERENCES);
    const c = chooseMedia(beats[0]!, lib, [], new Map(), DEFAULT_PREFERENCES, new Set());
    expect(c.quality).toBe('weak');
    expect(c.evidence.map((e) => e.basis)).toEqual(['mots-clés']);
    const named = indexLibrary([img('spider-man.jpg')]);
    const b2 = buildBeats(parseScript('Spider-Man arrive.'), [{ index: 0, start: 0, end: 3, words: [] } as never], DEFAULT_PREFERENCES);
    const c2 = chooseMedia(b2[0]!, named, [], new Map(), DEFAULT_PREFERENCES, new Set());
    expect(c2.quality).toBe('strong');
    expect(c2.evidence[0]!.basis).toBe('nom');
    expect(c2.reasons.join(' ')).toMatch(/nom du fichier/);
    expect(c2.confidence).toBeLessThanOrEqual(0.75);
    // the same entity found in a description written by the user counts as content
    const described = indexLibrary([img('IMG_0042.jpg', { description: 'Spider-Man sur un toit, de nuit' })]);
    const c3 = chooseMedia(b2[0]!, described, [], new Map(), DEFAULT_PREFERENCES, new Set());
    expect(c3.evidence[0]!.basis).toBe('description');
    expect(c3.reasons[0]).toMatch(/d’après votre description/);
    expect(confidenceFrom(20, c3.evidence)).toBeGreaterThan(0.75);
  });

  it('a user exclusion is respected and a forced choice wins', () => {
    const lib = indexLibrary([img('spider-man-a.jpg'), img('spider-man-b.jpg')]);
    const b = buildBeats(parseScript('Spider-Man arrive.'), [{ index: 0, start: 0, end: 3, words: [] } as never], DEFAULT_PREFERENCES)[0]!;
    const first = chooseMedia(b, lib, [], new Map(), DEFAULT_PREFERENCES, new Set());
    const other = lib.find((i) => i.asset.id !== first.item!.asset.id)!.asset.id;
    expect(chooseMedia(b, lib, [], new Map(), DEFAULT_PREFERENCES, new Set(), undefined, undefined, { exclude: new Set([first.item!.asset.id]) }).item!.asset.id).toBe(other);
    const forced = chooseMedia(b, lib, [], new Map(), DEFAULT_PREFERENCES, new Set(), undefined, undefined, { forced: other });
    expect(forced.item!.asset.id).toBe(other);
    expect(forced.confidence).toBe(1);
    expect(first.candidates.length).toBe(2);
  });
});

describe('edit decision graph', () => {
  it('records one decision per shot, with stable ids, candidates, evidence and dependencies', () => {
    const a = build();
    const b = build();
    expect(a.edg.decisions.length).toBe(a.shots.length);
    expect(a.edg.decisions.map((d) => d.id)).toEqual(b.edg.decisions.map((d) => d.id)); // same input → same graph ids
    expect(new Set(a.edg.decisions.map((d) => d.id)).size).toBe(a.edg.decisions.length);
    const osborn = a.edg.decisions.find((d) => d.anchor.text.includes('Osborn'))!;
    expect(a.media[osborn.chosen.mediaId!]!.name).toBe('norman-osborn-unmasked.png');
    expect(osborn.candidates.length).toBeGreaterThan(1);
    expect(osborn.deps.some((x) => x.startsWith('phrase:'))).toBe(true);
    expect(osborn.clipIds).toHaveLength(1);
    expect(a.shots.every((s) => s.decisionId)).toBe(true);
    expect(decisionId('visuel', 'Un  texte, Été!', 0)).toBe(decisionId('visuel', 'un texte ete', 0));
  });

  it('accept / lock / reject / replace act on the timeline and are undoable with it', () => {
    const { project } = build();
    const h = new History(project as Project);
    const seq = () => h.present.sequences[h.present.activeSequenceId]!;
    const d0 = seq().production!.edg!.decisions.find((d) => d.chosen.mediaId && !d.chosen.generated)!;
    const clipMedia = () => seq().tracks[0]!.clips.find((c) => c.id === d0.clipIds[0])!.mediaId;
    const before = clipMedia();
    h.commit('accept', (p) => void setDecisionState(p.sequences[p.activeSequenceId] as Sequence, d0.id, 'acceptée'));
    expect(seq().production!.edg!.decisions.find((d) => d.id === d0.id)!.state).toBe('acceptée');
    h.commit('reject', (p) => void rejectDecision(p.sequences[p.activeSequenceId] as Sequence, p.media as Record<string, MediaAsset>, d0.id));
    const after = seq().production!.edg!.decisions.find((d) => d.id === d0.id)!;
    expect(after.rejected).toContain(before);
    expect(clipMedia()).not.toBe(before); // next candidate placed at once
    expect(after.state).toBe('proposée');
    h.undo();
    expect(clipMedia()).toBe(before);
    expect(seq().production!.edg!.decisions.find((d) => d.id === d0.id)!.state).toBe('acceptée');
    h.redo();
    expect(clipMedia()).not.toBe(before);
    const venom = Object.values(h.present.media).find((m) => m.name === 'venom.jpg')!;
    h.commit('replace', (p) => void chooseCandidate(p.sequences[p.activeSequenceId] as Sequence, p.media as Record<string, MediaAsset>, d0.id, venom.id));
    expect(clipMedia()).toBe(venom.id);
    const locked = seq().production!.edg!.decisions.find((d) => d.id === d0.id)!;
    expect([locked.state, locked.author, locked.confidence]).toEqual(['verrouillée', 'utilisateur', 1]);
    expect(validateProject(h.present)).toEqual([]);
  });

  it('a manual replacement or deletion in the timeline is reconciled into the graph', () => {
    const { sequence, media } = build();
    const s = immer(sequence, (d) => {
      const v1 = d.tracks[0]!;
      const target = d.production!.edg!.decisions.find((x) => x.chosen.mediaId && !x.chosen.generated)!;
      const c = v1.clips.find((x) => x.id === target.clipIds[0])!;
      c.mediaId = Object.values(media).find((m) => m.name === 'random-city.jpg')!.id;
      expect(reconcileGraph(d as Sequence, media)).toEqual([target.id]);
      const t2 = d.production!.edg!.decisions.find((x) => x.id !== target.id && x.clipIds.length)!;
      v1.clips = v1.clips.filter((x) => !t2.clipIds.includes(x.id));
      expect(reconcileGraph(d as Sequence, media)).toEqual([t2.id]);
    });
    const ds = s.production!.edg!.decisions;
    expect(ds.filter((d) => d.state === 'verrouillée' && d.author === 'utilisateur')).toHaveLength(1);
    expect(ds.filter((d) => d.state === 'rejetée')).toHaveLength(1);
    expect(reconcileGraph(s as Sequence, media)).toEqual([]); // idempotent
  });

  it('regeneration keeps locks and rejections; editing one sentence only changes its own shots', () => {
    const v1 = build();
    // lock the Osborn shot on another picture, reject Venom's picture
    const seq = immer(v1.sequence, (d) => {
      const osborn = d.production!.edg!.decisions.find((x) => x.anchor.text.includes('Osborn'))!;
      chooseCandidate(d as Sequence, v1.media, osborn.id, v1.lib.find((m) => m.name === 'osborn-portrait.jpg')!.id);
    });
    const v2 = build(SCRIPT, v1.lib, seq.production);
    const osborn2 = v2.edg.decisions.find((d) => d.anchor.text.includes('Osborn'))!;
    expect(v2.media[osborn2.chosen.mediaId!]!.name).toBe('osborn-portrait.jpg');
    expect(osborn2.state).toBe('verrouillée');
    expect(osborn2.history.some((h) => h.action === 'conservée')).toBe(true);
    // a changed sentence: the other decisions keep the same ids and choices
    const edited = SCRIPT.replace('Et Venom arrive ensuite', 'Puis Venom débarque');
    const v3 = build(edited, v1.lib, v2.sequence.production);
    const byId = new Map(v2.edg.decisions.map((d) => [d.id, d.chosen.mediaId && v2.media[d.chosen.mediaId]?.name]));
    const changed = v3.edg.decisions.filter((d) => byId.get(d.id) !== (d.chosen.mediaId && v3.media[d.chosen.mediaId]?.name));
    expect(changed.every((d) => d.anchor.text.includes('Venom'))).toBe(true);
    expect(v3.edg.decisions.filter((d) => !byId.has(d.id)).every((d) => d.anchor.text.includes('Venom'))).toBe(true);
  });

  it('migrates a v3 project: generated versions get a graph rebuilt from their record', () => {
    const { project, sequence } = build();
    const raw = JSON.parse(JSON.stringify({ ...project, schemaVersion: 3 }));
    for (const s of Object.values(raw.sequences) as { production?: { edg?: unknown } }[]) delete s.production!.edg;
    const m = migrateProject(raw);
    expect(m.schemaVersion).toBe(4);
    const g = m.sequences[sequence.id]!.production!.edg!;
    expect(g.decisions.length).toBe(sequence.production!.shots.length);
    expect(g.decisions.every((d) => d.state === 'proposée' && d.history[0]!.detail?.includes('migration'))).toBe(true);
    expect(g.decisions.filter((d) => d.clipIds.length).length).toBeGreaterThan(0);
    expect(validateProject(m)).toEqual([]);
    expect(graphFromShots({ ...sequence, production: undefined })).toBeUndefined();
  });

  it('editorial review lists low confidence, metadata-only, rejected and cut lettering', () => {
    const lib = [img('spider-man.jpg', { ocr: { engine: 'test', text: 'BOOM', confidence: 0.9, zones: [{ x: 0.0, y: 0.45, w: 0.06, h: 0.1 }], at: '' } }), img('ville.jpg')];
    const r = build('Spider-Man saute. La ville dort.', lib, undefined, { ...DEFAULT_PREFERENCES, proceduralVisuals: true });
    const codes = reviewQc(r.sequence, r.media, { reviewThreshold: 0.45 }).map((i) => i.code);
    expect(codes).toContain('review-metadata-only');
    expect(codes).toContain('review-framing'); // the zoom crops the lettering on the left edge
    const sum = summariseGraph(r.sequence.production!.edg);
    expect(sum.metadataOnly).toBeGreaterThan(0);
  });
});
