import { describe, expect, it } from 'vitest';
import { compareRefs, comicRefsIn, parseComicRef, parseMediaRef } from '../../src/production';

describe('comic references', () => {
  it('parses source entries', () => {
    expect(parseComicRef('Batman #676-681 (2008) - Grant Morrison, Tony Daniel et collaborateurs.')).toMatchObject({ series: 'batman', issues: [676, 677, 678, 679, 680, 681], year: 2008 });
    expect(parseComicRef('New Avengers (vol. 3) #30 (2015) — Jonathan Hickman')).toMatchObject({ series: 'new avengers', volume: 3, issues: [30], year: 2015 });
    expect(parseComicRef('Marvel Super-Heroes Secret Wars #10 (1985) — Jim Shooter')).toMatchObject({ series: 'secret wars', issues: [10], year: 1985 });
    expect(parseComicRef('Batman #1-11 (2011-2012) - Scott Snyder')).toMatchObject({ series: 'batman', year: 2011, yearEnd: 2012 });
    expect(parseComicRef('Secret Wars (2015) #1')).toMatchObject({ series: 'secret wars', issues: [1], year: 2015 });
    expect(parseComicRef('Une phrase sans référence.')).toBeNull();
  });
  it('parses media file names', () => {
    expect(parseMediaRef('Batman 676 (2008) cover.jpg')).toMatchObject({ series: 'batman', issues: [676], year: 2008 });
    expect(parseMediaRef('secret_wars_2015_01.png')).toMatchObject({ series: 'secret wars', issues: [1], year: 2015 });
    expect(parseMediaRef('New Avengers v3 #30.jpg')).toMatchObject({ series: 'new avengers', volume: 3, issues: [30] });
    expect(parseMediaRef('spider-man-bouffon-vert.png')).toBeNull();
  });
  it('finds references in narration', () => {
    const r = comicRefsIn('Dans Batman #676-681 (2008), Grant Morrison pousse l’idée. Dans X-Treme X-Men #9, en 2002, Jean Grey explique.');
    expect(r.map((x) => [x.series, x.issues[0], x.year])).toEqual([
      ['batman', 676, 2008],
      ['x treme x men', 9, 2002],
    ]);
  });
  it('never confuses works with the same name', () => {
    const sw84 = parseComicRef('Marvel Super-Heroes Secret Wars #1 (1984)')!;
    expect(compareRefs(sw84, parseMediaRef('Secret Wars 2015 #1.jpg')!).verdict).toBe('conflict');
    expect(compareRefs(sw84, parseMediaRef('Secret Wars #1 (1984).jpg')!).verdict).toBe('same-issue');
    const b = parseComicRef('Batman #676-681 (2008)')!;
    expect(compareRefs(b, parseMediaRef('Batman 35.jpg')!).verdict).toBe('conflict');
    expect(compareRefs(b, parseMediaRef('Batman 679.jpg')!).verdict).toBe('same-issue');
    expect(compareRefs(b, parseMediaRef('Batman and Robin 33.jpg')!).verdict).toBe('unrelated');
    expect(compareRefs(parseComicRef('New Avengers (vol. 3) #30 (2015)')!, parseMediaRef('New Avengers v1 #30.jpg')!).verdict).toBe('conflict');
  });
});
