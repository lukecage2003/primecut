import { describe, expect, it } from 'vitest';
import { createProject, framesToSeconds, motionAt, validateProject, wrapLines, captionsToAss } from '../../src/core';
import {
  DEFAULT_PREFERENCES,
  EntityIndex,
  adaptPreferences,
  alignByPauses,
  alignToTranscript,
  buildBeats,
  buildSequence,
  indexLibrary,
  measureStyle,
  parseScript,
  runQc,
  speechFromSilences,
  splitSentences,
  syllables,
  autoFix,
} from '../../src/production';
import { fakeMedia } from './helpers';

const SCRIPT = `# Le retour du Bouffon Vert

En 1964, Spider-Man affronte pour la première fois le Bouffon Vert. Personne ne connaît alors son identité.
[VISUEL: couverture Amazing Spider-Man 14] Le numéro 14 marque un tournant pour M. Parker.

## La révélation

Des années plus tard, Norman Osborn est démasqué! C'est un choc pour les lecteurs de Marvel.
[NOTE: vérifier la date] [PAUSE] Et Venom arrive ensuite… mais c'est une autre histoire.`;

describe('script parsing (FR)', () => {
  it('splits French sentences, keeps abbreviations, extracts directives and sections', () => {
    expect(splitSentences('M. Parker arrive. Il voit S.H.I.E.L.D. Puis il part! Fin…')).toEqual(['M. Parker arrive.', 'Il voit S.H.I.E.L.D.', 'Puis il part!', 'Fin…']);
    const p = parseScript(SCRIPT);
    expect(p.sections.map((s) => s.title)).toEqual(['Le retour du Bouffon Vert', 'La révélation']);
    expect(p.sentences.map((s) => s.text)).toEqual([
      'En 1964, Spider-Man affronte pour la première fois le Bouffon Vert.',
      'Personne ne connaît alors son identité.',
      'Le numéro 14 marque un tournant pour M. Parker.',
      'Des années plus tard, Norman Osborn est démasqué!',
      "C'est un choc pour les lecteurs de Marvel.",
      'Et Venom arrive ensuite… mais c\'est une autre histoire.',
    ]);
    expect(p.sentences[2]!.hints).toEqual(['couverture Amazing Spider-Man 14']);
    expect(p.sentences[4]!.breakAfter).toBe(true);
    expect(p.notes).toEqual(['vérifier la date']);
    expect(p.sentences[3]!.section).toBe(1);
    expect(syllables('Spider-Man affronte')).toBeGreaterThan(3);
  });
});

describe('entities', () => {
  it('finds characters by FR/EN aliases, issues and unknown names', () => {
    const idx = new EntityIndex();
    const m = idx.find('Spider-Man affronte le Bouffon Vert dans le numéro 14 face à Kraven.');
    expect(m.filter((e) => e.entityId).map((e) => e.entityId)).toEqual(['spider-man', 'green-goblin']);
    expect(m.find((e) => e.kind === 'issue')?.name).toBe('#14');
    expect(m.find((e) => e.kind === 'unknown')?.name).toBe('Kraven');
    expect(idx.find("l'Araignée et la Veuve Noire").map((e) => e.entityId)).toEqual(['spider-man', 'black-widow']);
  });
});

describe('alignment', () => {
  const sentences = parseScript('Un deux trois quatre. Cinq six sept. Huit neuf dix onze douze treize.').sentences;
  it('anchors sentence boundaries on pauses (model-free)', () => {
    // speech: 0.5–2.5, pause, 3.1–4.4, pause, 5.0–8.0
    const speech = speechFromSilences([{ start: 0, end: 0.5 }, { start: 2.5, end: 3.1 }, { start: 4.4, end: 5.0 }, { start: 8.0, end: 9 }], 9);
    const a = alignByPauses(sentences, speech);
    expect(a.confidence).toBe(1);
    expect(a.sentences.map((s) => [s.start, s.end])).toEqual([
      [0.5, 2.5],
      [3.1, 4.4],
      [5.0, 8.0],
    ]);
    expect(a.sentences[0]!.words).toHaveLength(4);
    expect(a.sentences[0]!.words[0]!.start).toBeCloseTo(0.5, 6);
  });
  it('ignores intra-sentence pauses and interpolates without pauses', () => {
    const speech = speechFromSilences([{ start: 1.0, end: 1.25 }, { start: 2.5, end: 3.1 }, { start: 4.4, end: 5.0 }], 8);
    const a = alignByPauses(sentences, speech);
    expect(a.sentences[1]!.start).toBeCloseTo(3.1, 6);
    expect(a.sentences[2]!.start).toBeCloseTo(5.0, 6);
    const b = alignByPauses(sentences, [{ start: 0, end: 10 }]);
    expect(b.confidence).toBe(0);
    expect(b.sentences[0]!.end).toBeGreaterThan(1.5);
    expect(b.sentences[0]!.end).toBeLessThan(4);
  });
  it('aligns to a word transcript despite recognition errors', () => {
    const words = 'un deux troa quatre cinq six sept huit neuf dix onze douze treize'.split(' ').map((w, i) => ({ text: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const a = alignToTranscript(sentences, words);
    expect(a.method).toBe('transcript');
    expect(a.sentences.map((s) => [s.start, s.end])).toEqual([
      [0, 1.9],
      [2, 3.4],
      [3.5, 6.4],
    ]);
    expect(a.sentences[0]!.words[2]!.estimated).toBe(true); // "trois" ≠ "troa"
  });
});

function library() {
  const mk = (name: string, w = 1600, h = 2400) => {
    const m = fakeMedia({ name, kind: 'image', audio: false, durationSec: 0 });
    m.probe.video!.width = w;
    m.probe.video!.height = h;
    m.path = `/lib/${name}`;
    return m;
  };
  return [mk('spider-man_vs_green-goblin.jpg'), mk('amazing-spider-man-14-cover.jpg'), mk('norman-osborn-unmasked.png', 1920, 1080), mk('venom.jpg'), mk('random-city.jpg', 1920, 1080)];
}

function produce(prefs = DEFAULT_PREFERENCES) {
  const script = parseScript(SCRIPT);
  const narration = fakeMedia({ name: 'voice.wav', kind: 'audio', video: false, durationSec: 30 });
  // 6 sentences spread over 30s with pauses
  const silences = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ start: i * 4.6, end: i * 4.6 + 0.6 }));
  const alignment = alignByPauses(script.sentences, speechFromSilences(silences, 30));
  const lib = library();
  const project = createProject('P');
  const r = buildSequence({ name: 'Auto v1', settings: project.sequences[project.activeSequenceId]!.settings, script, alignment, narration, narrationLufs: -20, library: lib, prefs });
  const media = Object.fromEntries([...lib, ...r.generated, narration].map((m) => [m.id, m]));
  return { ...r, media, lib, narration, alignment };
}

describe('timeline construction', () => {
  it('builds a complete, valid, explainable edit', () => {
    const { sequence, shots, beats, media, lib } = produce();
    const p = createProject('P');
    p.media = media;
    p.sequences = { [sequence.id]: sequence };
    p.activeSequenceId = sequence.id;
    expect(validateProject(p)).toEqual([]);
    const v1 = sequence.tracks[0]!;
    // picture covers 0 → narration end + 1s without gaps
    expect(v1.clips[0]!.start).toBe(0);
    for (let i = 0; i + 1 < v1.clips.length; i++) expect(v1.clips[i]!.start + v1.clips[i]!.duration).toBe(v1.clips[i + 1]!.start);
    expect(framesToSeconds(v1.clips.at(-1)!.start + v1.clips.at(-1)!.duration, { num: 30, den: 1 })).toBeCloseTo(31, 1);
    // relevant images are chosen for named characters / hints
    const firstShot = shots[0]!;
    expect(media[firstShot.mediaId!]!.name).toBe('spider-man_vs_green-goblin.jpg');
    expect(firstShot.reasons.join(' ')).toMatch(/Spider-Man/);
    const hintShot = shots.find((s) => s.text.includes('numéro 14'))!;
    expect(media[hintShot.mediaId!]!.name).toBe('amazing-spider-man-14-cover.jpg');
    const osborn = shots.find((s) => s.text.includes('Osborn'))!;
    expect(media[osborn.mediaId!]!.name).toBe('norman-osborn-unmasked.png');
    // narration normalised (-20 LUFS → -16 target), motion on stills, section dissolve, captions
    expect(sequence.tracks[2]!.clips[0]!.gainDb).toBe(4);
    expect(v1.clips.filter((c) => media[c.mediaId]!.kind === 'image').every((c) => c.motion.kind !== 'none')).toBe(true);
    expect(v1.transitions.length).toBeGreaterThanOrEqual(1);
    expect(sequence.captions.filter((c) => c.style === 'title').map((c) => c.text)).toEqual(['Le retour du Bouffon Vert', 'La révélation']);
    expect(sequence.captions.some((c) => c.style === 'lower-third' && c.text.startsWith('Spider-Man\nMarvel'))).toBe(true);
    const subs = sequence.captions.filter((c) => c.style === 'subtitle');
    expect(subs.length).toBeGreaterThanOrEqual(6);
    expect(subs.every((c) => c.text.split('\n').length <= 2 && c.text.split('\n').every((l) => l.length <= 42))).toBe(true);
    expect(beats.length).toBeGreaterThanOrEqual(4);
    void lib;
  });

  it('never leaves the screen empty: shots without media become contextual compositions', () => {
    const script = parseScript(SCRIPT);
    const narration = fakeMedia({ name: 'voice.wav', kind: 'audio', video: false, durationSec: 20 });
    const alignment = alignByPauses(script.sentences, [{ start: 0, end: 20 }]);
    const p = createProject('P');
    const r = buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script, alignment, narration, library: [], prefs: DEFAULT_PREFERENCES });
    const v1 = r.sequence.tracks[0]!;
    expect(v1.clips.length).toBeGreaterThan(0);
    expect(v1.clips[0]!.start).toBe(0);
    for (let i = 0; i + 1 < v1.clips.length; i++) expect(v1.clips[i]!.start + v1.clips[i]!.duration).toBe(v1.clips[i + 1]!.start);
    expect(r.shots.every((s) => s.quality === 'generated')).toBe(true);
    expect(r.sequence.captions.some((c) => c.style === 'placeholder')).toBe(false);
    const kinds = r.generated.filter((g) => g.generator).map((g) => g.generator!.kind);
    expect(kinds).toContain('character-card'); // Spider-Man / Bouffon Vert introduced
    for (let i = 0; i + 1 < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i + 1]); // no identical consecutive compositions
    const g0 = r.generated[0]!.generator!;
    expect(g0.audio).toEqual({ mediaId: narration.id, offsetSec: 0 }); // reacts to the real narration at its position
    expect(r.generated.every((g) => g.rights?.usage === 'owned')).toBe(true);
    const media = Object.fromEntries([narration, ...r.generated].map((m) => [m.id, m]));
    const qc = runQc(r.sequence, media, DEFAULT_PREFERENCES, { narrationEnd: 630 });
    expect(qc.issues.filter((i) => i.code === 'gap' || i.code === 'missing-visual')).toEqual([]);
  });

  it('with procedural visuals disabled, missing shots get placeholders and QC flags them', () => {
    const script = parseScript(SCRIPT);
    const narration = fakeMedia({ name: 'voice.wav', kind: 'audio', video: false, durationSec: 20 });
    const alignment = alignByPauses(script.sentences, [{ start: 0, end: 20 }]);
    const p = createProject('P');
    const r = buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script, alignment, narration, library: [], prefs: { ...DEFAULT_PREFERENCES, proceduralVisuals: false } });
    expect(r.sequence.captions.some((c) => c.style === 'placeholder' && c.text.startsWith('VISUEL MANQUANT'))).toBe(true);
    const qc = runQc(r.sequence, { [narration.id]: narration }, DEFAULT_PREFERENCES, { alignmentConfidence: 0 });
    expect(qc.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['gap', 'missing-visual', 'alignment']));
    expect(qc.score).toBeLessThan(70);
  });

  it('never auto-places media whose rights are not cleared', () => {
    const lib = library();
    for (const m of lib) m.rights = { usage: 'view-only', source: 'web', checkedAt: '' };
    const libIdx = indexLibrary(lib);
    expect(libIdx).toHaveLength(5);
    const script = parseScript('Spider-Man arrive.');
    const narration = fakeMedia({ name: 'v.wav', kind: 'audio', video: false, durationSec: 3 });
    const p = createProject('P');
    const r = buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script, alignment: alignByPauses(script.sentences, [{ start: 0, end: 3 }]), narration, library: lib, prefs: DEFAULT_PREFERENCES });
    // rights-restricted images are never placed: the shot becomes a procedural composition instead
    expect(r.sequence.tracks[0]!.clips.every((c) => !lib.some((m) => m.id === c.mediaId))).toBe(true);
    expect(r.shots[0]!.quality).toBe('generated');
    expect(r.shots[0]!.reasons).toContain('aucun média aux droits utilisables');
  });

  it('a same-named work from another year or issue is never used for a cited comic', () => {
    const img = (name: string) => fakeMedia({ name, kind: 'image', video: true, durationSec: 0 });
    const sw15 = img('Secret Wars 2015 #1.jpg');
    const sw84 = img('Secret Wars #1 (1984).jpg');
    const script = parseScript('Le Beyonder enlève les héros.\n\n[SOURCE: Marvel Super-Heroes Secret Wars #1 (1984) — Jim Shooter]');
    const narration = fakeMedia({ name: 'v.wav', kind: 'audio', video: false, durationSec: 4 });
    const p = createProject('P');
    const build = (library: typeof sw15[]) => buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script, alignment: alignByPauses(script.sentences, [{ start: 0, end: 4 }]), narration, library, prefs: DEFAULT_PREFERENCES });
    const both = build([sw15, sw84]);
    expect(both.sequence.tracks[0]!.clips.map((c) => c.mediaId)).toContain(sw84.id);
    expect(both.sequence.tracks[0]!.clips.map((c) => c.mediaId)).not.toContain(sw15.id);
    expect(both.shots[0]!.reasons.join(' ')).toMatch(/même numéro : Secret Wars #1 \(1984\).*non authentifié/);
    // only the 2015 picture: it is not shown as if it were the 1984 comic
    const wrong = build([sw15]);
    expect(wrong.sequence.tracks[0]!.clips.map((c) => c.mediaId)).not.toContain(sw15.id);
  });

  it('QC auto-fix closes gaps and merges repeats', () => {
    const { sequence, media } = produce();
    const v1 = sequence.tracks[0]!;
    v1.transitions = [];
    v1.clips[1]!.mediaId = v1.clips[0]!.mediaId;
    v1.clips[2]!.start += 10;
    v1.clips[2]!.duration -= 10;
    const n = v1.clips.length;
    const fixes = autoFix(sequence, media, 930);
    expect(fixes.length).toBeGreaterThanOrEqual(2);
    expect(v1.clips.length).toBe(n - 1);
    const qc = runQc(sequence, media, DEFAULT_PREFERENCES, { narrationEnd: 930 });
    expect(qc.issues.filter((i) => i.code === 'gap' || i.code === 'repeat')).toEqual([]);
  });
});

describe('preference adaptation (not model training)', () => {
  it('moves preferences toward the user edits and versions them', () => {
    const { sequence } = produce();
    const gen = measureStyle(sequence);
    const edited = { ...gen, meanShotSec: gen.meanShotSec * 1.5, motionCounts: { 'zoom-in': 8, none: 2 } };
    const { prefs, changes } = adaptPreferences(DEFAULT_PREFERENCES, gen, edited);
    expect(prefs.version).toBe(2);
    expect(prefs.shotTarget).toBeGreaterThan(DEFAULT_PREFERENCES.shotTarget);
    expect(prefs.shotTarget).toBeLessThan(DEFAULT_PREFERENCES.shotTarget * 1.5);
    const w = prefs.motionWeights;
    expect(w['zoom-in'] / (w['zoom-in'] + w['pan-left'])).toBeGreaterThan(3 / 4);
    expect(changes.length).toBeGreaterThan(0);
    const same = adaptPreferences(DEFAULT_PREFERENCES, gen, gen);
    expect(same.changes).toEqual([]);
    expect(same.prefs.version).toBe(1);
  });
});

describe('motion & captions helpers', () => {
  it('motion eases from start to end', () => {
    expect(motionAt({ kind: 'zoom-in', amount: 0.2 }, 0).zoom).toBe(1);
    expect(motionAt({ kind: 'zoom-in', amount: 0.2 }, 1).zoom).toBeCloseTo(1.2, 9);
    expect(motionAt({ kind: 'pan-left', amount: 0.1 }, 0.5).panX).toBeCloseTo(0, 9);
    expect(wrapLines('un deux trois quatre cinq six sept huit neuf dix onze douze', 30)).toEqual(['un deux trois quatre cinq six', 'sept huit neuf dix onze douze']);
    expect(wrapLines('x '.repeat(80), 20, 2)).toBeNull();
  });
  it('generates ASS with styles and escaped text', () => {
    const p = createProject('P');
    const s = p.sequences[p.activeSequenceId]!;
    s.captions = [{ id: '1', start: 30, end: 60, text: 'Ligne {un}\nLigne deux', style: 'subtitle' }];
    const ass = captionsToAss(s);
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('Dialogue: 1,0:00:01.00,0:00:02.00,subtitle,,0,0,0,,Ligne (un)\\NLigne deux');
  });
});

describe('pacing', () => {
  it('cuts faster on intense passages and lets explanations breathe', async () => {
    const { beatPacing, parseScript } = await import('../../src/production');
    const sc = parseScript('La bataille éclate ! Thor tombe. Loki trahit tout le monde !\n\nPour comprendre cette idée, il faut expliquer le principe de la continuité Marvel et son origine dans les années soixante.');
    const rates = { bySentence: new Map<number, number>(), median: 5 };
    const beat = (idx: number[]) => ({ index: 0, section: 0, sentenceIndexes: idx, start: 0, end: 5, text: idx.map((i) => sc.sentences[i]!.text).join(' '), entities: [], hints: [], keywords: [], sources: [], onScreen: [] });
    const intense = beatPacing(beat([0, 1, 2]), sc.sentences, rates);
    const calm = beatPacing(beat([3]), sc.sentences, rates);
    expect(intense.label).toBe('intense');
    expect(calm.label).toBe('calm');
    expect(intense.shotFactor).toBeLessThan(calm.shotFactor);
    // a narrator speeding up raises intensity
    const fast = beatPacing(beat([3]), sc.sentences, { bySentence: new Map([[3, 7.5]]), median: 5 });
    expect(fast.intensity).toBeGreaterThan(calm.intensity);
  });
});

describe('script-specific entities', () => {
  it('learns repeated names and cited series the knowledge base does not know', async () => {
    const { parseScript, scriptEntities, EntityIndex, SEED_KNOWLEDGE } = await import('../../src/production');
    const sc = parseScript('Il existe une entité nommée Despair. Plus tard, Despair rencontre Rao près de Krypton. Rao accepte.\n\n[SOURCE: The Sandman: Endless Nights (2003)]\n\nSuperman survit.');
    const ents = scriptEntities(sc);
    const names = ents.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Despair', 'Rao', 'The Sandman']));
    expect(names).not.toContain('Superman'); // already in the curated base
    expect(names).not.toContain('Krypton'); // mentioned once, not cited
    const idx = new EntityIndex([...SEED_KNOWLEDGE, ...ents]);
    expect(idx.find('Despair revient').some((m) => m.entityId === 'script:despair')).toBe(true);
    expect(ents.every((e) => e.status === 'uncertain')).toBe(true);
  });
});
