import { describe, it, expect } from 'vitest';
import { scoreCase, scoreRun, DEFAULT_THRESHOLD, REASON_PENALTY } from './scoring.ts';
import type { FrozenCase, Gate1Decision } from './types.ts';

describe('scoring', () => {
  const createCase = (label: Gate1Decision, labelSource: 'oracle' | 'teacher' = 'oracle'): FrozenCase => {
    const now = new Date().toISOString();
    return {
      id: `case-${Math.random()}`,
      input: {
        profile: {
          id: 'p1',
          version: 1,
          sourceKind: 'bot_code',
          sourceFingerprint: 'fp',
          direction: 'long',
          coreIdea: 'test',
          requiredMarketFeatures: [],
          confidence: 0.8,
          unknowns: [],
          profile: {
            direction: 'long',
            coreIdea: 'test',
            summary: 's',
            requiredMarketFeatures: [],
            entryConditions: [],
            exitConditions: [],
            timeframes: ['1h'],
            indicators: [],
            parameters: [],
            watchLifecycleSummary: null,
            positionManagementSummary: null,
            riskManagementSummary: null,
            runnerOwnedAuthorities: [],
            confidence: 0.8,
            unknowns: [],
            evidence: [],
          },
          sourceArtifactRef: {} as never,
          contractVersion: 'v1',
          createdAt: now,
          updatedAt: now,
        } as never,
        baselineMetrics: {
          netPnlUsd: 0,
          netPnlPct: 0,
          totalTrades: 10,
          winRate: 0.5,
          profitFactor: 1.5,
          maxDrawdownPct: 5,
          expectancyUsd: 0,
          sharpe: 1,
          topTradeContributionPct: 10,
        },
        entryAffecting: [],
        hasEntrySignalEvidence: true,
      },
      label,
      labelSource,
      createdAt: now,
    };
  };

  describe('scoreCase', () => {
    it('schema miss → score 0, schemaValid false', () => {
      const raw = {};
      const c = createCase('improve');
      const result = scoreCase(raw, c, 100);

      expect(result).toEqual({
        id: c.id,
        schemaValid: false,
        decisionMatch: false,
        reasonOk: false,
        labelSource: 'oracle',
        score: 0,
        latencyMs: 100,
      });
    });

    it('exact decision match with good reason → score 1', () => {
      const raw = { decision: 'improve', reason: 'good reason' };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 150);

      expect(result).toEqual({
        id: c.id,
        schemaValid: true,
        decisionMatch: true,
        reasonOk: true,
        labelSource: 'oracle',
        score: 1,
        latencyMs: 150,
      });
    });

    it('wrong decision → score 0', () => {
      const raw = { decision: 'allow_exploratory_sweep', reason: 'good reason' };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 120);

      expect(result.decisionMatch).toBe(false);
      expect(result.score).toBe(0);
      expect(result.schemaValid).toBe(true);
    });

    it('stop_insufficient_evidence with "should sweep" → reasonOk false, score 1-REASON_PENALTY', () => {
      const raw = {
        decision: 'stop_insufficient_evidence',
        reason: 'should sweep the parameters',
      };
      const c = createCase('stop_insufficient_evidence');
      const result = scoreCase(raw, c, 200);

      expect(result.schemaValid).toBe(true);
      expect(result.decisionMatch).toBe(true);
      expect(result.reasonOk).toBe(false);
      expect(result.score).toBe(1 - REASON_PENALTY);
    });

    it('stop_not_worth with "worth improving" → reasonOk false', () => {
      const raw = {
        decision: 'stop_not_worth',
        reason: 'worth improving on this metric',
      };
      const c = createCase('stop_not_worth');
      const result = scoreCase(raw, c, 180);

      expect(result.reasonOk).toBe(false);
      expect(result.score).toBe(1 - REASON_PENALTY);
    });

    it('stop decision without sweep keywords → reasonOk true', () => {
      const raw = {
        decision: 'stop_insufficient_evidence',
        reason: 'good analysis shows no potential',
      };
      const c = createCase('stop_insufficient_evidence');
      const result = scoreCase(raw, c, 150);

      expect(result.reasonOk).toBe(true);
      expect(result.score).toBe(1);
    });

    it('non-stop decision with any reason → reasonOk true', () => {
      const raw = {
        decision: 'improve',
        reason: 'should sweep the parameters',
      };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 140);

      expect(result.reasonOk).toBe(true);
      expect(result.score).toBe(1);
    });

    it('empty reason → reasonOk false', () => {
      const raw = {
        decision: 'improve',
        reason: '',
      };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 100);

      expect(result.reasonOk).toBe(false);
      expect(result.score).toBe(1 - REASON_PENALTY);
    });

    it('whitespace-only reason → reasonOk false', () => {
      const raw = {
        decision: 'improve',
        reason: '   ',
      };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 100);

      expect(result.reasonOk).toBe(false);
      expect(result.score).toBe(1 - REASON_PENALTY);
    });

    it('missing decision in output → schema miss', () => {
      const raw = { reason: 'some reason' };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 100);

      expect(result.schemaValid).toBe(false);
      expect(result.score).toBe(0);
    });

    it('missing reason in output → schema miss', () => {
      const raw = { decision: 'improve' };
      const c = createCase('improve');
      const result = scoreCase(raw, c, 100);

      expect(result.schemaValid).toBe(false);
      expect(result.score).toBe(0);
    });

    it('preserves labelSource', () => {
      const raw = { decision: 'improve', reason: 'good' };
      const c = createCase('improve', 'teacher');
      const result = scoreCase(raw, c, 100);

      expect(result.labelSource).toBe('teacher');
    });
  });

  describe('scoreRun', () => {
    it('empty cases → all rates 0, verdict FAIL', () => {
      const result = scoreRun([]);

      expect(result.schemaValidRate).toBe(0);
      expect(result.accuracy).toBe(0);
      expect(result.oracleAccuracy).toBe(0);
      expect(result.teacherAccuracy).toBe(0);
      expect(result.reasonOkRate).toBe(0);
      expect(result.meanScore).toBe(0);
      expect(result.passRate).toBe(0);
      expect(result.verdict).toBe('FAIL');
      expect(result.threshold).toBe(DEFAULT_THRESHOLD);
      expect(result.cases).toEqual([]);
    });

    it('2 oracle cases (1 right) + 1 teacher case (right) → oracleAccuracy 0.5, teacherAccuracy 1', () => {
      const c1 = createCase('improve', 'oracle');
      const c2 = createCase('improve', 'oracle');
      const c3 = createCase('allow_exploratory_sweep', 'teacher');

      const s1 = scoreCase(
        { decision: 'improve', reason: 'good' },
        c1,
        100
      );
      const s2 = scoreCase(
        { decision: 'stop_not_worth', reason: 'wrong' },
        c2,
        100
      );
      const s3 = scoreCase(
        { decision: 'allow_exploratory_sweep', reason: 'good' },
        c3,
        100
      );

      const result = scoreRun([s1, s2, s3]);

      expect(result.oracleAccuracy).toBe(0.5);
      expect(result.teacherAccuracy).toBe(1);
      expect(result.accuracy).toBeCloseTo((2 / 3));
    });

    it('meanScore below threshold → verdict FAIL', () => {
      const c = createCase('improve', 'oracle');
      const s = scoreCase({}, c, 100); // schema miss, score 0

      const result = scoreRun([s], { threshold: 0.5 });

      expect(result.meanScore).toBe(0);
      expect(result.passRate).toBe(0);
      expect(result.verdict).toBe('FAIL');
    });

    it('meanScore >= threshold → verdict PASS, passRate 1', () => {
      const c = createCase('improve', 'oracle');
      const s = scoreCase({ decision: 'improve', reason: 'good' }, c, 100); // score 1

      const result = scoreRun([s], { threshold: 0.5 });

      expect(result.meanScore).toBe(1);
      expect(result.passRate).toBe(1);
      expect(result.verdict).toBe('PASS');
    });

    it('custom threshold applied', () => {
      const c1 = createCase('improve', 'oracle');
      const c2 = createCase('improve', 'oracle');

      const s1 = scoreCase({ decision: 'improve', reason: 'good' }, c1, 100); // score 1
      const s2 = scoreCase({ decision: 'improve', reason: 'ok' }, c2, 100); // score 1

      const result = scoreRun([s1, s2], { threshold: 0.95 });

      expect(result.threshold).toBe(0.95);
      expect(result.meanScore).toBe(1);
      expect(result.passRate).toBe(1);
      expect(result.verdict).toBe('PASS');
    });

    it('schemaValidRate calculated correctly', () => {
      const c1 = createCase('improve', 'oracle');
      const c2 = createCase('improve', 'oracle');

      const s1 = scoreCase({ decision: 'improve', reason: 'good' }, c1, 100);
      const s2 = scoreCase({}, c2, 100); // schema invalid

      const result = scoreRun([s1, s2]);

      expect(result.schemaValidRate).toBe(0.5);
    });

    it('reasonOkRate calculated correctly', () => {
      const c1 = createCase('improve', 'oracle');
      const c2 = createCase('improve', 'oracle');
      const c3 = createCase('improve', 'oracle');

      const s1 = scoreCase({ decision: 'improve', reason: 'good' }, c1, 100); // reasonOk true
      const s2 = scoreCase({ decision: 'improve', reason: '' }, c2, 100); // reasonOk false
      const s3 = scoreCase({ decision: 'improve', reason: 'ok' }, c3, 100); // reasonOk true

      const result = scoreRun([s1, s2, s3]);

      expect(result.reasonOkRate).toBeCloseTo(2 / 3);
    });

    it('no oracle cases → oracleAccuracy 0', () => {
      const c = createCase('improve', 'teacher');
      const s = scoreCase({ decision: 'improve', reason: 'good' }, c, 100);

      const result = scoreRun([s]);

      expect(result.oracleAccuracy).toBe(0);
    });

    it('no teacher cases → teacherAccuracy 0', () => {
      const c = createCase('improve', 'oracle');
      const s = scoreCase({ decision: 'improve', reason: 'good' }, c, 100);

      const result = scoreRun([s]);

      expect(result.teacherAccuracy).toBe(0);
    });

    it('cases array preserved in result', () => {
      const c = createCase('improve', 'oracle');
      const s = scoreCase({ decision: 'improve', reason: 'good' }, c, 100);

      const result = scoreRun([s]);

      expect(result.cases).toEqual([s]);
    });
  });
});
