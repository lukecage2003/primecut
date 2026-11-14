import { describe, expect, it } from 'vitest';
import { createProject, type MediaAsset } from '../../src/core';
import { analyzeVoice } from '../../src/pcore/audio';
import { animateV2, maxStep } from '../../src/pcore/v2/animation';
import { PRESETS, type PresetId, presetSettings, resolveV2, LAYERS } from '../../src/pcore/v2/config';
import { directPCore, type PCoreCue } from '../../src/pcore/v2/director';
import { EXPRESSION_LIST, EXPRESSIONS, envelope } from '../../src/pcore/v2/expressions';
import { readNarration } from '../../src/pcore/v2/narrative';
import { planPlacement, DEFAULT_PLACEMENT } from '../../src/pcore/placement';
import { DEFAULT_PREFERENCES, alignByPauses, buildSequence, parseScript } from '../../src/production';
import { fakeMedia } from './helpers';

const RATE = 16000;
/** Synthetic voice for logic tests only (segments of [seconds, amplitude]); real-voice checks are in docs/PCORE_V2.md. */
function voice(segs: [number, number][], rate = RATE): Float32Array {
  const total = segs.reduce((a, s) => a + s[0], 0);
  const x = new Float32Array(Math.round(total * rate));
  let i = 0;
  for (const [d, amp] of segs) {
    const n = Math.round(d * rate);
    for (let k = 0; k < n; k++, i++) {
      const t = i / rate;
      const syll = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      x[i] = amp * syll * (Math.sin(2 * Math.PI * 180 * t) + 0.4 * Math.sin(2 * Math.PI * 900 * t) + 0.15 * Math.sin(2 * Math.PI * 1500 * t));
    }
  }
  return x;
}

const SENTENCES = [
  { index: 0, start: 1.5, end: 4, text: 'Et si tout ce que vous saviez sur ce héros était faux ?', section: 0 },
  { index: 1, start: 4.5, end: 8, text: 'En 1962, Stan Lee et Steve Ditko créent un adolescent ordinaire.', section: 1 },
  { index: 2, start: 8.5, end: 12, text: 'Peter Parker est un étudiant timide qui vit dans le Queens.', section: 1 },
  { index: 3, start: 12.5, end: 16, text: 'Pour comprendre son succès, il faut regarder le contexte de l’époque, car les héros étaient alors des adultes.', section: 1 },
  { index: 4, start: 16.5, end: 19, text: 'Pourtant, ce n’est pas sa force qui le rend célèbre.', section: 2 },
  { index: 5, start: 19.5, end: 22, text: 'Mais ce n’est pas tout.', section: 2 },
  { index: 6, start: 22.5, end: 26, text: 'En réalité, son identité secrète est la clé de toute l’histoire.', section: 2 },
  { index: 7, start: 26.5, end: 30, text: 'Au final, c’est cette humanité qui a tout changé. Abonnez-vous pour la suite.', section: 3 },
];
const narration = () => analyzeVoice(voice([[1.5, 0], [2.5, 0.3], [0.5, 0], [3.5, 0.3], [0.5, 0], [3.5, 0.3], [0.5, 0], [3.5, 0.3], [0.5, 0], [2.5, 0.4], [0.5, 0], [2.5, 0.6], [0.5, 0], [3.5, 0.6], [0.5, 0], [3.5, 0.3], [1, 0]], 4000), 4000, { fps: 10 });

describe('P-CORE V2 narrative reading (context, not keyword triggers)', () => {
  it('categorises sentences from position, form, connectors and neighbours', () => {
    const r = readNarration(SENTENCES);
    expect(r.map((x) => x.category)).toEqual(['introduction', 'contexte', 'presentation', 'explication', 'opposition', 'escalade', 'revelation', 'conclusion']);
    expect(r[6]!.salience).toBeGreaterThan(r[3]!.salience);
    expect(r[1]!.sectionStart).toBe(true);
    expect(r.every((x) => x.confidence > 0 && x.confidence < 1 && x.reasons.length)).toBe(true);
  });
  it('a marker is weighed by its context: inside a question or in the teaser it counts less', () => {
    const asked = readNarration([{ index: 0, start: 0, end: 2, text: 'Intro.', section: 0 }, { index: 1, start: 3, end: 5, text: 'Quel est son secret ?', section: 0 }, { index: 2, start: 6, end: 8, text: 'Fin.', section: 0 }]);
    const stated = readNarration([{ index: 0, start: 0, end: 2, text: 'Intro.', section: 0 }, { index: 1, start: 3, end: 5, text: 'En réalité, son secret est terrible.', section: 0 }, { index: 2, start: 6, end: 8, text: 'Fin.', section: 0 }]);
    expect(asked[1]!.category).toBe('question');
    expect(stated[1]!.category).toBe('revelation');
    expect(stated[1]!.salience).toBeGreaterThan(asked[1]!.salience);
    // "mais" inside a sentence is not an opposition; at its start it is
    expect(readNarration([{ index: 0, start: 0, end: 1, text: 'Il court mais il tombe.' }])[0]!.category).not.toBe('opposition');
  });
});

describe('P-CORE V2 evolution director', () => {
  const v2 = presetSettings('classic');
  it('with text: sleeps, wakes, follows the structure and stabilises at the end', () => {
    const d = directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: v2 });
    const ex = d.cues.map((c) => c.expression);
    expect(d.usedText).toBe(true);
    expect(ex[0]).toBe('dormant');
    expect(ex).toContain('awakening');
    expect(ex).toContain('revelation');
    expect(ex.at(-1)).toBe('final-stabilization');
    const rev = d.cues.find((c) => c.expression === 'revelation')!;
    expect(rev.start).toBeGreaterThan(21);
    expect(rev.reasons.join(' ')).toMatch(/Révélation/);
    // stable ids: the same narration gives the same plan
    expect(directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: v2 }).cues.map((c) => c.id)).toEqual(d.cues.map((c) => c.id));
  });
  it('memory: spectacular moments are spaced; repeated expressions vary', () => {
    const d = directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: v2 });
    const spec = d.cues.filter((c) => EXPRESSIONS[c.expression].spectacular).sort((a, b) => a.start - b.start);
    for (let i = 1; i < spec.length; i++) {
      const prev = spec[i - 1]!;
      const paired = prev.expression === 'fragmentation' && spec[i]!.expression === 'reconstruction';
      if (!paired && spec[i]!.expression !== 'revelation') expect(spec[i]!.start - (prev.start + prev.duration)).toBeGreaterThanOrEqual(v2.narrative.spectacularGap - 0.01);
    }
    // the escalation (salient) and the reveal 3 s later cannot both be spectacular at full size
    expect(d.log.some((l) => /mémoire|moment spectaculaire/.test(l)) || d.cues.some((c) => c.reasons.some((r) => r.startsWith('mémoire')))).toBe(true);
    const focus = d.cues.filter((c) => c.expression === 'orbital-motion');
    if (focus.length > 1) expect(new Set(focus.map((c) => c.variant)).size).toBeGreaterThan(1);
  });
  it('without any text it still directs from the voice (pauses, energy, opening, ending)', () => {
    const d = directPCore({ voice: narration(), fps: 10, settings: v2 });
    expect(d.usedText).toBe(false);
    const ex = d.cues.map((c) => c.expression);
    expect(ex).toContain('awakening');
    expect(ex).toContain('final-stabilization');
    expect(d.cues.every((c) => c.reasons.length > 0)).toBe(true);
    expect(d.cues.some((c) => c.reasons.join(' ').match(/révélation/i))).toBe(false); // no invented narrative reading
  });
  it('sensitivity changes how much it reacts; the user’s locks and disables are kept', () => {
    const calm = directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: resolveV2({ preset: 'minimal' }) });
    const reactive = directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: resolveV2({ preset: 'revelation' }) });
    const n = (x: typeof calm) => x.cues.filter((c) => !['dormant', 'awakening', 'final-stabilization', 'silence'].includes(c.expression)).length;
    expect(n(reactive)).toBeGreaterThan(n(calm));
    const base = directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: v2 });
    const rev = base.cues.find((c) => c.expression === 'revelation')!;
    const awake = base.cues.find((c) => c.expression === 'awakening')!;
    const edited = directPCore({ voice: narration(), fps: 10, sentences: SENTENCES, settings: v2, edits: [{ id: rev.id, expression: 'energy-expansion', duration: 2, state: 'verrouillée' }, { id: awake.id, state: 'désactivée' }] });
    expect(edited.cues.find((c) => c.id === rev.id)).toMatchObject({ expression: 'energy-expansion', duration: 2, state: 'verrouillée', source: 'utilisateur' });
    expect(edited.cues.find((c) => c.id === awake.id)!.state).toBe('désactivée');
  });
});

describe('P-CORE V2 animation engine', () => {
  const v2 = presetSettings('classic');
  const v = analyzeVoice(voice([[1, 0], [3, 0.3], [1.5, 0], [3, 0.6], [1.5, 0]]), RATE, { fps: 30 });
  const cues: PCoreCue[] = [
    { id: 'a', expression: 'revelation', start: 2, duration: 3, intensity: 1, variant: 0, reasons: [], source: 'auto', state: 'proposée' },
    { id: 'b', expression: 'fragmentation', start: 5.5, duration: 1.3, intensity: 1, variant: 0, reasons: [], source: 'auto', state: 'proposée' },
    { id: 'c', expression: 'reconstruction', start: 6.8, duration: 1.6, intensity: 1, variant: 0, reasons: [], source: 'auto', state: 'proposée' },
  ];
  it('is deterministic, smooth (springs: no jump) and composes overlapping expressions', () => {
    const a = animateV2(v, 30, cues, v2);
    expect(animateV2(v, 30, cues, v2)).toEqual(a);
    const m = maxStep(a);
    expect(m.coreGlow).toBeLessThan(0.08);
    expect(m.scale).toBeLessThan(0.02);
    expect(m.fragment).toBeLessThan(0.12);
    expect(m.rotY).toBeLessThan(0.25);
    // the reveal (variant 0) completes one full turn with inertia
    const at = (s: number) => a[Math.round(s * 30)]!;
    expect(at(5.6).rotY).toBeGreaterThan(Math.PI * 1.7);
    expect(at(6.4).fragment).toBeGreaterThan(0.6);
    expect(at(8.6).fragment).toBe(0); // rebuilt exactly
    // every turn ends facing front: the artwork is never left mirrored
    const half: PCoreCue = { id: 'h', expression: 'cinematic-transition', start: 1, duration: 1.8, intensity: 1, variant: 1, reasons: [], source: 'auto', state: 'proposée' };
    const end = animateV2(v, 30, [half], v2).at(-1)!.rotY;
    expect(Math.abs(Math.atan2(Math.sin(end), Math.cos(end)))).toBeLessThan(0.2);
    expect(at(3.3).mix.some((x) => x.id === 'revelation')).toBe(true);
  });
  it('voice reactions are measurable: louder speech → more glow, silence → calmer', () => {
    const a = animateV2(v, 30, [], v2);
    const mean = (s: number, e: number) => a.slice(s * 30, e * 30).reduce((x, f) => x + f.pose.coreGlow, 0) / ((e - s) * 30);
    expect(mean(6, 8.5)).toBeGreaterThan(mean(4.2, 5.4));
    expect(a[Math.round(0.5 * 30)]!.expr).toBe('dormant');
  });
  it('layers are independent: a disabled layer gets intensity 0, focus dims the periphery only', () => {
    const off = structuredClone(v2);
    off.identity.layers.energy.enabled = false;
    const a = animateV2(v, 30, [{ ...cues[0]!, expression: 'deep-focus' }], off);
    expect(a.every((f) => f.layers.energy === 0)).toBe(true);
    const mid = a[Math.round(3.5 * 30)]!;
    expect(mid.layers.core).toBe(off.identity.layers.core.intensity);
    expect(mid.layers.orbital).toBeLessThan(off.identity.layers.orbital.intensity);
  });
});

describe('P-CORE V2 library and presets', () => {
  it('has the 12 expressions, each complete', () => {
    expect(EXPRESSION_LIST.map((e) => e.id)).toEqual(['dormant', 'awakening', 'active', 'deep-focus', 'energy-expansion', 'orbital-motion', 'fragmentation', 'reconstruction', 'revelation', 'cinematic-transition', 'silence', 'final-stabilization']);
    for (const e of EXPRESSION_LIST) {
      expect(e.duration.min).toBeLessThanOrEqual(e.duration.default);
      expect(e.duration.max).toBeGreaterThanOrEqual(e.duration.default);
      expect(e.when.length).toBeGreaterThan(5);
      expect(Object.keys(e.pose(0.5, 1, 0)).length).toBeGreaterThan(2);
      expect(envelope(e, 0.5)).toBeGreaterThan(0);
    }
  });
  it('presets really change the engine (no two identical)', () => {
    const ids = Object.keys(PRESETS) as PresetId[];
    expect(ids).toEqual(['classic', 'cinematic', 'cosmic', 'minimal', 'revelation', 'hud']);
    const sig = ids.map((id) => JSON.stringify(PRESETS[id].settings));
    expect(new Set(sig).size).toBe(6);
    expect(PRESETS.hud.settings.identity.layers.hud.enabled).toBe(true);
    expect(PRESETS.classic.settings.identity.layers.hud.enabled).toBe(false);
    expect(PRESETS.minimal.settings.identity.layers.energy.enabled).toBe(false);
    expect(PRESETS.cinematic.settings.animation.inertia).toBeGreaterThan(PRESETS.revelation.settings.animation.inertia);
    expect(resolveV2({ preset: 'cosmic', animation: { speed: 0.5 } as never }).identity.rings).toBe(6);
    expect(LAYERS.map((l) => l.id)).toEqual(['core', 'inner', 'orbital', 'energy', 'atmosphere', 'hud']);
  });
});

describe('P-CORE V2 dynamic presence and timeline', () => {
  const img = (name: string) => {
    const m = fakeMedia({ name, kind: 'image', audio: false, durationSec: 0 });
    m.path = `/lib/${name}`;
    return m;
  };
  const SCRIPT = '# Partie un\n\nSpider-Man saute du toit.\n\n## Partie deux\n\nIl arrive en ville. En réalité, son identité secrète est menacée.';
  const build = (pcoreV2?: Parameters<typeof buildSequence>[0]['pcoreV2'], lib: MediaAsset[] = [], presenter = false, badge = false) => {
    const script = parseScript(SCRIPT);
    const narr = fakeMedia({ name: 'v.wav', kind: 'audio', video: false, durationSec: 12 });
    const p = createProject('P');
    return buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script, alignment: alignByPauses(script.sentences, [{ start: 0, end: 3 }, { start: 3.5, end: 7 }, { start: 7.5, end: 12 }]), narration: narr, library: lib, prefs: { ...DEFAULT_PREFERENCES, pcore: 'always', sfx: false, presenter, pcoreBadge: badge }, pcoreV2 });
  };
  const cues: PCoreCue[] = [{ id: 'r', expression: 'revelation', start: 8, duration: 3, intensity: 1.1, variant: 0, reasons: ['test'], source: 'auto', state: 'proposée' }];
  it('V2 clips carry the cues and settings; consecutive placements cross-dissolve on two tracks', () => {
    const r = build({ cues, settings: presetSettings('classic') }, [img('spider-man-toit.jpg')]);
    const pc = r.generated.filter((g) => g.pcore);
    expect(pc.length).toBeGreaterThan(1);
    expect(pc.every((g) => g.pcore!.engine === 'v2' && g.pcore!.v2 && Array.isArray(g.pcore!.cues))).toBe(true);
    const tracks = r.sequence.tracks.filter((t) => t.kind === 'video' && t.clips.some((c) => pc.some((g) => g.id === c.mediaId)));
    expect(tracks.length).toBe(2);
    const all = tracks.flatMap((t) => t.clips).sort((a, b) => a.start - b.start);
    for (let i = 1; i < all.length; i++) if (all[i]!.start < all[i - 1]!.start + all[i - 1]!.duration) expect(all[i]!.fadeIn).toBeGreaterThanOrEqual(10);
  });
  it('a strong reveal over a picture brings P-CORE back to the front (mode C)', () => {
    const early: PCoreCue[] = [{ ...cues[0]!, start: 4, duration: 2.5 }];
    const r = build({ cues: early, settings: presetSettings('classic') }, [img('spider-man-toit.jpg'), img('ville.jpg')]);
    const pcAssets = r.generated.filter((g) => g.pcore);
    expect(pcAssets.some((g) => g.pcore!.mode === 'corner')).toBe(true);
    expect(pcAssets.some((g) => g.pcore!.mode === 'cinematic')).toBe(true);
    expect(r.sequence.tracks.filter((t) => t.kind === 'video')).toHaveLength(3); // V1 + two P-CORE tracks, no empty extra track
  });
  it('a title on screen pushes the central P-CORE above it', () => {
    const r = build({ cues, settings: presetSettings('classic') });
    const pcAssets = r.generated.filter((g) => g.pcore);
    const title = r.sequence.captions.find((c) => c.style === 'title')!;
    const H = r.sequence.settings.height;
    const W = r.sequence.settings.width;
    const during = r.sequence.tracks.flatMap((t) => t.clips).filter((c) => pcAssets.some((g) => g.id === c.mediaId) && c.start <= title.start + 1 && c.start + c.duration > title.start + 1);
    expect(during.length).toBeGreaterThan(0);
    for (const c of during) {
      const size = c.transform.scale * Math.min(W, H);
      expect(H / 2 + c.transform.y + size / 2).toBeLessThan(H / 2 - 0.05 * H); // entirely above the centred title band
    }
  });
  it('presenter mode (no pictures): P-CORE stays central and continuous, chapters go to the data matrix', () => {
    const r = build({ cues, settings: presetSettings('hud') }, [], true);
    const pc = r.generated.filter((g) => g.pcore);
    expect(pc.every((g) => g.pcore!.mode === 'hero')).toBe(true);
    expect(pc.length).toBeLessThanOrEqual(2);
    expect(r.sequence.captions.some((c) => c.style === 'title')).toBe(false);
    expect(pc.flatMap((g) => g.pcore!.chapters ?? []).map((c) => c.title)).toEqual(expect.arrayContaining(['Partie un', 'Partie deux']));
    const bg = r.generated.filter((g) => g.generator);
    expect(bg.every((g) => !['character-card', 'timeline', 'typography'].includes(g.generator!.kind))).toBe(true);
  });
  it('badge mode (with pictures): small logo in the corner over pictures, P-CORE in front when nothing is shown', () => {
    const r = build({ cues, settings: presetSettings('classic') }, [img('spider-man-toit.jpg'), img('ville.jpg')], false, true);
    const ids = new Set(r.generated.filter((g) => g.pcore).map((g) => g.id));
    const media = new Map([...r.generated].map((g) => [g.id, g]));
    const pcClips = r.sequence.tracks.flatMap((t) => t.clips).filter((x) => ids.has(x.mediaId));
    expect(pcClips.length).toBeGreaterThan(0);
    const { width: W, height: H } = r.sequence.settings;
    const v1 = r.sequence.tracks[0]!.clips;
    let corners = 0;
    for (const c of pcClips) {
      const mid = c.start + c.duration / 2;
      const under = v1.find((x) => x.start <= mid && mid < x.start + x.duration);
      const picture = !!under && !media.get(under.mediaId)?.generator;
      if (picture) {
        corners++;
        expect(W / 2 + c.transform.x).toBeGreaterThan(W * 0.8);
        expect(H / 2 + c.transform.y).toBeLessThan(H * 0.8); // above the subtitle band
        expect(c.transform.scale).toBeLessThan(0.25);
      } else expect(c.transform.scale).toBeGreaterThan(0.3); // in front, animated by the voice
    }
    expect(corners).toBeGreaterThan(0);
  });
  it('protected zones and a locked position are honoured', () => {
    const r = build();
    const seq = r.sequence;
    const segs = planPlacement(seq, Object.fromEntries(r.generated.map((m) => [m.id, m])), 300, { ...DEFAULT_PLACEMENT, protectedZones: [{ x: 0.3, y: 0.1, w: 0.4, h: 0.7 }] });
    expect(segs.every((g) => g.mode !== 'hero')).toBe(true);
    const locked = planPlacement(seq, {}, 300, { ...DEFAULT_PLACEMENT, manual: { enabled: true, x: 0.8, y: 0.2, size: 0.3 } }, [], { cinematic: [{ time: 1, duration: 2, reason: 'test' }], captions: seq.captions });
    expect(locked).toHaveLength(1);
    expect(locked[0]!.reason).toMatch(/position fixe/);
  });
  it('without V2 settings the builder keeps the V1.1 behaviour (older projects unchanged)', () => {
    const r = build(undefined);
    const pc = r.generated.filter((g) => g.pcore);
    expect(pc.length).toBeGreaterThan(0);
    expect(pc.every((g) => g.pcore!.engine === undefined && g.pcore!.cues === undefined)).toBe(true);
    expect(r.sequence.tracks.filter((t) => t.kind === 'video')).toHaveLength(2);
  });
});

import { zeroPhase } from '../../src/pcore/v2/animation';
describe('P-CORE V2 voice reaction', () => {
  it('zero-phase smoothing has no delay: a pulse stays centred on its sound', () => {
    const a = Array.from({ length: 90 }, (_, i) => (i >= 40 && i < 50 ? 1 : 0));
    const z = zeroPhase(a, 30, 0.13);
    const peak = z.indexOf(Math.max(...z));
    expect(Math.abs(peak - 44.5)).toBeLessThanOrEqual(1);
    expect(Math.max(...z.slice(1).map((v, i) => Math.abs(v - z[i]!)))).toBeLessThan(0.12);
  });
  it('the glow follows the voice without lag and louder speech glows more', () => {
    const fps = 30;
    const voice = Array.from({ length: 300 }, (_, i) => {
      const speaking = Math.floor(i / 30) % 2 === 0;
      const env = speaking ? (Math.floor(i / 60) % 2 ? 0.9 : 0.4) : 0;
      return { rms: env, level: env, env, low: env, mid: env, high: env * 0.5, onset: i % 30 === 0 && speaking ? 0.5 : 0, speaking, silenceFor: speaking ? 0 : (i % 30) / fps, rate: 4 };
    });
    const frames = animateV2(voice as never, fps, [], presetSettings('classic'));
    const glow = frames.map((f) => f.glow);
    const env = voice.map((v) => v.env);
    const corr = (L: number) => {
      const a = env.slice(0, env.length - L), b = glow.slice(L);
      const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
      let c = 0, va = 0, vb = 0;
      for (let i = 0; i < a.length; i++) ((c += (a[i]! - ma) * (b[i]! - mb)), (va += (a[i]! - ma) ** 2), (vb += (b[i]! - mb) ** 2));
      return c / Math.sqrt(va * vb);
    };
    const lags = [0, 1, 2, 3, 4, 5, 6].map(corr);
    expect(lags.indexOf(Math.max(...lags))).toBeLessThanOrEqual(1); // ≤ 33 ms
    const loud = glow.slice(70, 85), soft = glow.slice(10, 25);
    expect(Math.max(...loud)).toBeGreaterThan(Math.max(...soft));
  });
});
