// @product: ai-employee
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabaseClient', () => ({ supabase: null }));

import {
  DEFAULT_THRESHOLDS,
  MAX_REVISION_ROUNDS,
  reviewStepOutput,
  getReviewHistory,
  buildRevisionLog,
  shouldReview,
} from './aiReviewerService';

// ── Constants ────────────────────────────────────────────────────────────────

describe('DEFAULT_THRESHOLDS', () => {
  it('has expected thresholds', () => {
    expect(DEFAULT_THRESHOLDS.dynamic_tool).toBe(75);
    expect(DEFAULT_THRESHOLDS.plan).toBe(65);
    expect(DEFAULT_THRESHOLDS.forecast).toBe(60);
    expect(DEFAULT_THRESHOLDS.report).toBe(70);
    expect(DEFAULT_THRESHOLDS.export).toBe(50);
  });
});

describe('MAX_REVISION_ROUNDS', () => {
  it('is 3', () => {
    expect(MAX_REVISION_ROUNDS).toBe(3);
  });
});

// ── reviewStepOutput ─────────────────────────────────────────────────────────

describe('reviewStepOutput', () => {
  it('passes a good output', async () => {
    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'forecast',
      workflowType: 'forecast',
      output: {
        summary: 'Forecast completed with MAPE 8.2%',
        artifact_refs: ['ref-1', 'ref-2'],
        result: { mape: 8.2 },
      },
    });

    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.passed).toBe(true);
    expect(result.threshold).toBe(60);
    expect(result.revision_round).toBe(1);
    expect(result.categories.correctness).toBe(100);
    expect(result.reviewer_model).toBe('deterministic-v1');
  });

  it('fails a null output', async () => {
    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'plan',
      workflowType: 'plan',
      output: null,
    });

    expect(result.score).toBeLessThan(65);
    expect(result.passed).toBe(false);
    expect(result.categories.correctness).toBe(0);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('fails an errored output', async () => {
    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'dynamic_tool',
      workflowType: 'dynamic_tool',
      output: { error: 'TypeError: x is not defined', status: 'failed' },
    });

    expect(result.passed).toBe(false);
    expect(result.categories.correctness).toBe(20);
    expect(result.suggestions.some(s => s.includes('errored'))).toBe(true);
  });

  it('penalizes missing artifacts', async () => {
    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'forecast',
      workflowType: 'forecast',
      output: { summary: 'Done', result: { ok: true } },
    });

    expect(result.categories.completeness).toBeLessThan(100);
    expect(result.suggestions.some(s => s.includes('artifact'))).toBe(true);
  });

  it('uses correct threshold per workflow type', async () => {
    const goodOutput = {
      summary: 'OK',
      result: { ok: true },
      artifact_refs: ['ref-1'],
    };

    const forecastResult = await reviewStepOutput({
      taskId: 't', stepName: 's', workflowType: 'forecast', output: goodOutput,
    });
    expect(forecastResult.threshold).toBe(60);

    const dynamicResult = await reviewStepOutput({
      taskId: 't', stepName: 's', workflowType: 'dynamic_tool', output: goodOutput,
    });
    expect(dynamicResult.threshold).toBe(75);
  });

  it('increments revision_round based on priorReviews', async () => {
    const priorReviews = [
      { revision_round: 1, score: 40, passed: false },
    ];

    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'plan',
      workflowType: 'plan',
      output: { summary: 'Improved plan', artifact_refs: ['ref-1'] },
      priorReviews,
    });

    expect(result.revision_round).toBe(2);
  });

  it('checks relevance against expectedOutput', async () => {
    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'analysis',
      workflowType: 'dynamic_tool',
      output: {
        summary: 'Analyzed supplier delivery times',
        result: { avg_lead_time: 14 },
        artifact_refs: ['ref-1'],
      },
      expectedOutput: 'supplier delivery lead time analysis prediction',
    });

    expect(result.categories.relevance).toBeGreaterThan(0);
  });

  it('low relevance when output mismatches expected', async () => {
    const result = await reviewStepOutput({
      taskId: 'task-1',
      stepName: 'analysis',
      workflowType: 'dynamic_tool',
      output: {
        summary: 'Weather forecast for next week',
        result: { temp: 22 },
        artifact_refs: ['ref-1'],
      },
      expectedOutput: 'supplier lead time prediction model for procurement',
    });

    expect(result.categories.relevance).toBeLessThan(80);
  });
});

// ── getReviewHistory ─────────────────────────────────────────────────────────

describe('getReviewHistory', () => {
  it('returns empty array when no supabase', async () => {
    const history = await getReviewHistory('task-1', 'forecast');
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(0);
  });
});

// ── buildRevisionLog ─────────────────────────────────────────────────────────

describe('buildRevisionLog', () => {
  it('builds log from review history', () => {
    const reviews = [
      { revision_round: 1, score: 45, threshold: 70, passed: false, feedback: 'Low quality', suggestions: ['Fix X'], reviewer_model: 'gpt-5.4', created_at: '2026-03-21T10:00:00Z' },
      { revision_round: 2, score: 82, threshold: 70, passed: true, feedback: 'Good', suggestions: [], reviewer_model: 'claude-opus-4-6', created_at: '2026-03-21T10:05:00Z' },
    ];

    const log = buildRevisionLog(reviews, 'dynamic_tool');

    expect(log.step_name).toBe('dynamic_tool');
    expect(log.total_rounds).toBe(2);
    expect(log.final_score).toBe(82);
    expect(log.passed).toBe(true);
    expect(log.rounds[0].score).toBe(45);
    expect(log.rounds[1].score).toBe(82);
  });

  it('handles empty reviews', () => {
    const log = buildRevisionLog([], 'forecast');
    expect(log.total_rounds).toBe(0);
    expect(log.final_score).toBeNull();
    expect(log.passed).toBe(false);
  });
});

// ── shouldReview ─────────────────────────────────────────────────────────────

describe('shouldReview', () => {
  it('returns true for most workflow types', () => {
    expect(shouldReview('forecast')).toBe(true);
    expect(shouldReview('plan')).toBe(true);
    expect(shouldReview('risk')).toBe(true);
    expect(shouldReview('dynamic_tool')).toBe(true);
    expect(shouldReview('report')).toBe(true);
  });

  it('returns false for export and synthesize', () => {
    expect(shouldReview('export')).toBe(false);
    expect(shouldReview('synthesize')).toBe(false);
  });
});
