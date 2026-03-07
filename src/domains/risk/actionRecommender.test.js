import { describe, it, expect } from 'vitest';
import { generateRowActions, computeDecisionRankingScore, generateActionsBatch } from './actionRecommender';

const makeRow = (overrides = {}) => ({
  item: 'MAT-001', plantId: 'P100', riskLevel: 'critical',
  gapQty: 100, onHand: 20, safetyStock: 50,
  inboundCount: 1, inboundQty: 80, nextTimeBucket: '2026-W12',
  profitPerUnit: 50, profitAtRisk: 5000, profitAtRiskReason: 'REAL',
  confidence_score: 0.7, daysToStockout: 5, riskScore: 8000,
  assumptions: [
    { field: 'profitPerUnit', isDefault: false },
    { field: 'leadTimeDays', isDefault: true },
  ],
  ...overrides,
});

describe('generateRowActions', () => {
  it('returns expedite for critical row with inbound', () => {
    const actions = generateRowActions(makeRow());
    expect(actions[0].type).toBe('expedite');
  });

  it('returns upload_data when assumptions exist', () => {
    const actions = generateRowActions(makeRow());
    expect(actions.some(a => a.type === 'upload_missing_data')).toBe(true);
  });

  it('returns no expedite when no inbound', () => {
    const actions = generateRowActions(makeRow({ inboundCount: 0, riskLevel: 'low' }));
    expect(actions.some(a => a.type === 'expedite')).toBe(false);
  });

  it('sorts by priority descending', () => {
    const actions = generateRowActions(makeRow());
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i - 1].priority).toBeGreaterThanOrEqual(actions[i].priority);
    }
  });

  it('returns review_demand when no demand data', () => {
    const actions = generateRowActions(makeRow({ daysToStockout: Infinity }));
    expect(actions.some(a => a.type === 'review_demand')).toBe(true);
  });
});

describe('computeDecisionRankingScore', () => {
  it('returns number between 0 and 1', () => {
    const score = computeDecisionRankingScore(makeRow());
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('ranks critical higher than low risk', () => {
    const critical = computeDecisionRankingScore(makeRow({ riskLevel: 'critical', pStockout: 0.9, profitAtRisk: 5000 }));
    const low = computeDecisionRankingScore(makeRow({ riskLevel: 'low', pStockout: 0.05, gapQty: 0, profitAtRisk: 0 }));
    expect(critical).toBeGreaterThan(low);
  });
});

describe('generateActionsBatch', () => {
  it('enriches all rows with actions and ranking', () => {
    const { rows, summary } = generateActionsBatch([makeRow(), makeRow({ item: 'MAT-002' })]);
    expect(rows).toHaveLength(2);
    expect(rows[0].recommendedActions.length).toBeGreaterThan(0);
    expect(rows[0].decisionRankingScore).toBeGreaterThan(0);
    expect(summary.rowsWithActions).toBe(2);
  });

  it('handles empty input', () => {
    const { rows, summary } = generateActionsBatch([]);
    expect(rows).toHaveLength(0);
    expect(summary).toEqual({});
  });

  it('topAction is the highest priority action', () => {
    const { rows } = generateActionsBatch([makeRow()]);
    const row = rows[0];
    expect(row.topAction).toBeDefined();
    expect(row.topAction.type).toBe(row.recommendedActions[0].type);
  });
});
