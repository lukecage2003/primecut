import { describe, expect, it } from 'vitest';
import { cer, cohenKappa, iou, kendallTau, matchBoxes, ndcgAtK, recallAtK, scoreJudgements, scorePanels, spearman, type JudgementsFile } from '../../src/bench/metrics';

describe('benchmark metrics (against human annotations)', () => {
  const A = { x: 0, y: 0, w: 0.5, h: 0.5 };
  const B = { x: 0.25, y: 0, w: 0.5, h: 0.5 };
  it('geometry and matching', () => {
    expect(iou(A, A)).toBe(1);
    expect(iou(A, B)).toBeCloseTo(1 / 3, 5);
    expect(iou(A, { x: 0.6, y: 0.6, w: 0.1, h: 0.1 })).toBe(0);
    expect(matchBoxes([A, B], [B], 0.5)).toEqual([[1, 0, 1]]);
  });
  it('ranking, order and text', () => {
    expect(kendallTau([0, 1, 2, 3])).toBe(1);
    expect(kendallTau([3, 2, 1, 0])).toBe(-1);
    expect(cer('THANOS ARIVE', 'Thanos arrive')).toBeCloseTo(1 / 13, 5);
    expect(recallAtK(['a', 'b', 'c'], ['c', 'z'], 2)).toBe(0);
    expect(recallAtK(['a', 'b', 'c'], ['c', 'z'], 3)).toBe(0.5);
    expect(ndcgAtK(['x', 'a'], ['a'], 10)).toBeCloseTo(1 / Math.log2(3), 5);
    expect(Number.isNaN(recallAtK(['a'], []))).toBe(true);
    expect(cohenKappa(['a', 'b', 'a', 'b'], ['a', 'b', 'a', 'b'])).toBe(1);
    expect(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b'])).toBe(0);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 5);
  });
  it('panel and shot scores report what they rest on', () => {
    const s = scorePanels([{ truth: [A, { x: 0.5, y: 0, w: 0.5, h: 0.5 }], predicted: [A] }]);
    expect(s).toMatchObject({ pages: 1, truthPanels: 2, predictedPanels: 1, precision: 1, recall: 0.5, pagesMeetingCriterion: 0 });
    const j: JudgementsFile = {
      format: 'primestone-bench/judgements@1', annotator: 'x', project: 'p', sequence: 's',
      shots: [
        { decisionId: '1', start: 0, end: 1, text: '', media: 'a', confidence: 0.7, metadataOnly: true, rating: 5 },
        { decisionId: '2', start: 1, end: 2, text: '', media: 'b', confidence: 0.2, metadataOnly: true, rating: 2, misleading: true },
        { decisionId: '3', start: 2, end: 3, text: '', media: null, confidence: null, metadataOnly: true },
      ],
    };
    const r = scoreJudgements(j);
    expect(r).toMatchObject({ shots: 3, rated: 2, meanRating: 3.5, relevantShare: 0.5, misleading: 1 });
    expect(r.byConfidence.find((b) => b.band === '≥ 0,6')).toEqual({ band: '≥ 0,6', n: 1, mean: 5 });
  });
});
