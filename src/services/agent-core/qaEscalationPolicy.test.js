import { describe, expect, it } from 'vitest';
import { resolveQaEscalationMode } from './qaEscalationPolicy.js';

describe('resolveQaEscalationMode', () => {
  it('escalates to full optimizer for hard methodology blockers even with a strong score', () => {
    const result = resolveQaEscalationMode({
      qa: {
        score: 8.6,
        blockers: ['The brief uses normalized growth with base period 2016, but the base period has only 1 month(s) of coverage.'],
        hard_blockers: ['The brief uses normalized growth with base period 2016, but the base period has only 1 month(s) of coverage.'],
        soft_blockers: [],
      },
      toolCalls: [{ result: { success: true, rows: [{ revenue: 1 }] } }],
      lowScoreThreshold: 6.5,
      lowScoreAction: 'narrative_repair',
      softBlockerAction: 'narrative_repair',
    });

    expect(result.mode).toBe('full_optimizer');
    expect(result.reasons).toContain('hard_blockers');
  });

  it('downgrades dimension-only blockers with successful evidence to narrative repair', () => {
    const result = resolveQaEscalationMode({
      qa: {
        score: 5.2,
        blockers: ['missing required dimensions: revenue, cost'],
        hard_blockers: ['missing required dimensions: revenue, cost'],
        soft_blockers: [],
      },
      toolCalls: [{ result: { success: true, rows: [{ revenue: 1 }] } }],
      lowScoreThreshold: 6.5,
      lowScoreAction: 'narrative_repair',
      softBlockerAction: 'narrative_repair',
    });

    expect(result.mode).toBe('narrative_repair');
    expect(result.reasons).toContain('dimension_coverage_with_evidence');
  });

  it('uses the configured low-score action when no blockers exist', () => {
    const result = resolveQaEscalationMode({
      qa: {
        score: 7.4,
        blockers: [],
      },
      lowScoreThreshold: 8.0,
      lowScoreAction: 'full_optimizer',
      softBlockerAction: 'none',
    });

    expect(result.mode).toBe('full_optimizer');
    expect(result.reasons).toContain('low_score');
  });
});
