import { describe, expect, it } from 'vitest';
import { captionsToSubtitleFile, createProject } from '../../src/core';

describe('subtitle files', () => {
  it('writes SRT and WebVTT with exact timestamps, subtitles only, in order', () => {
    const p = createProject('S', { width: 1920, height: 1080, frameRate: { num: 30000, den: 1001 } });
    const seq = p.sequences[p.activeSequenceId]!;
    seq.captions = [
      { id: 'b', start: 120, end: 180, text: 'Deuxième ligne', style: 'subtitle' },
      { id: 'a', start: 0, end: 90, text: 'Peter Parker est mordu\npar une araignée.', style: 'subtitle' },
      { id: 't', start: 0, end: 60, text: 'TITRE', style: 'title' },
    ];
    const srt = captionsToSubtitleFile(seq, 'srt');
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:03,003\nPeter Parker est mordu\npar une araignée.\n\n2\n00:00:04,004 --> 00:00:06,006\nDeuxième ligne\n');
    const vtt = captionsToSubtitleFile(seq, 'vtt');
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:03.003\n')).toBe(true);
    expect(vtt).not.toContain('TITRE');
  });
});
