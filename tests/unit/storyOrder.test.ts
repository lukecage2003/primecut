import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/core';
import type { MediaAsset } from '../../src/core/model';
import { DEFAULT_PREFERENCES, alignByPauses, buildSequence, parseScript, speechFromSilences } from '../../src/production';
import { fakeMedia } from './helpers';

const SENT = [
  'Tout commence en Egypte ancienne, où un enfant est abandonné dans le désert.',
  'Recueilli par des pillards, il grandit dans la violence.',
  'Des années plus tard, il découvre ses pouvoirs.',
  'Il prend alors le nom qui fera trembler le monde.',
  'Les siècles passent et il observe l’humanité.',
  'Puis il rencontre enfin les X-Men.',
  'Le combat est terrible.',
  'Et tout se termine dans les ruines.',
];

function page(book: string, n: number, of: number, panels = 4, extra: Partial<MediaAsset> = {}): MediaAsset {
  const m = fakeMedia({ name: `${book} p${String(n).padStart(3, '0')}.png`, kind: 'image', audio: false });
  m.probe.video = { ...m.probe.video!, width: 1200, height: 1800 };
  m.page = { book, n, of };
  m.tags = [book, `page ${n}`];
  m.panels = Array.from({ length: panels }, (_, i) => ({ x: 0.05, y: 0.05 + i * (0.9 / panels), w: 0.9, h: 0.9 / panels - 0.02 }));
  return Object.assign(m, extra);
}

function build(script: string, library: MediaAsset[], prefs = {}) {
  const sc = parseScript(script);
  const dur = sc.sentences.length * 6;
  const narration = fakeMedia({ name: 'voice.wav', kind: 'audio', video: false, durationSec: dur });
  const silences = sc.sentences.map((_, i) => ({ start: i * 6 + 4.8, end: i * 6 + 6 }));
  const p = createProject('P');
  return buildSequence({ name: 'x', settings: p.sequences[p.activeSequenceId]!.settings, script: sc, alignment: alignByPauses(sc.sentences, speechFromSilences(silences, dur)), narration, library, prefs: { ...DEFAULT_PREFERENCES, pcore: 'off', ...prefs } });
}

const pagesOnV1 = (r: ReturnType<typeof build>, lib: MediaAsset[]) => r.sequence.tracks[0]!.clips.map((c) => lib.find((m) => m.id === c.mediaId)?.page?.n ?? null);

describe('story mode: comic pages follow the narration in reading order', () => {
  const book = Array.from({ length: 10 }, (_, i) => page('Apocalypse 1', i + 1, 10));

  it('shows every planned page, in book order', () => {
    const r = build(SENT.join(' '), book);
    const shown = new Set(pagesOnV1(r, book));
    for (const sp of r.story!.spans) expect(shown.has(sp.item.asset.page!.n)).toBe(true);
  });

  it('shows the pages in book order, never going back, with pictures on screen the whole time', () => {
    const r = build(SENT.join(' '), book);
    const order = pagesOnV1(r, book);
    expect(order.every((n) => n !== null)).toBe(true); // a page on screen for every shot
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);
    expect(order[0]).toBe(1);
    expect(order.at(-1)).toBeGreaterThanOrEqual(9);
    expect(r.story?.books).toEqual(['Apocalypse 1']);
    const d = r.edg.decisions.find((x) => x.kind === 'visuel');
    expect(d?.candidates[0]?.evidence.some((e) => e.basis === 'ordre')).toBe(true);
  });

  it('a page shown over two passages continues its panel reading instead of starting again', () => {
    const big = Array.from({ length: 3 }, (_, i) => page('Apocalypse 1', i + 1, 3, 8));
    const r = build(SENT.join(' '), big);
    const v1 = r.sequence.tracks[0]!.clips;
    for (let i = 1; i < v1.length; i++) {
      if (v1[i]!.mediaId !== v1[i - 1]!.mediaId) continue;
      const a = v1[i - 1]!.motion?.path, b = v1[i]!.motion?.path;
      if (a?.length && b?.length) expect(JSON.stringify(b[0])).not.toBe(JSON.stringify(a[0]));
    }
  });

  it('a page asked for in the script ("[VISUEL: page 8]") is on screen at that passage', () => {
    const s = [...SENT];
    s[2] = `[VISUEL: page 8] ${s[2]}`;
    const r = build(s.join(' '), book);
    const sc = parseScript(s.join(' '));
    const at = r.beats.find((b) => b.hints.some((h) => /page 8/.test(h)))!.start + 0.5;
    const fps = r.sequence.settings.frameRate.num / r.sequence.settings.frameRate.den;
    const clip = r.sequence.tracks[0]!.clips.find((c) => c.start <= at * fps && at * fps < c.start + c.duration)!;
    expect(book.find((m) => m.id === clip.mediaId)?.page?.n).toBe(8);
    expect(sc.sentences[2]!.hints[0]).toMatch(/page 8/);
    // still in order afterwards
    const order = pagesOnV1(r, book);
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);
  });

  it('too many pages for a short narration: pages are skipped, each shown page stays readable', () => {
    const long = Array.from({ length: 40 }, (_, i) => page('Apocalypse 1', i + 1, 40));
    const r = build(SENT.slice(0, 3).join(' '), long);
    expect(r.story!.skipped).toBeGreaterThan(0);
    for (const s of r.story!.spans) expect(s.end - s.start).toBeGreaterThanOrEqual(2.4);
  });

  it('a generic word read on a late page ("Marvel") never makes the reading jump to the end of the book', () => {
    const pages = Array.from({ length: 30 }, (_, i) => page('Black Panther 1', i + 1, 30, 4, i === 28 ? { ocr: { engine: 'Tesseract', text: 'EMAIL MHEROES@MARVEL.COM SEE YOU NEXT TIME', confidence: 0.9, zones: [], at: '' } } : {}));
    const s = [...SENT];
    s[1] = 'Marvel décide alors de tout changer.';
    const r = build(s.join(' '), pages);
    const order = pagesOnV1(r, pages);
    // the reading stays spread over the book: the first half of the video is not on page 29
    const firstHalf = order.slice(0, Math.floor(order.length / 2));
    expect(firstHalf.every((n) => (n ?? 0) < 25)).toBe(true);
    expect(r.story!.anchors).toHaveLength(0);
  });

  it('is off when pages are a minority of the pictures, and can be turned off', () => {
    const misc = Array.from({ length: 12 }, (_, i) => Object.assign(fakeMedia({ name: `apocalypse-art-${i}.jpg`, kind: 'image', audio: false })));
    expect(build(SENT.join(' '), [...book.slice(0, 4), ...misc]).story).toBeNull();
    expect(build(SENT.join(' '), book, { storyOrder: 'off' }).story).toBeNull();
  });
});
