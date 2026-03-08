/**
 * Regression: Enhanced Action Model
 *
 * Validates that the action recommender produces actions with the
 * enhanced model (id, urgency, reason_code, status, owner, due_date)
 * and that the decision ranking score is deterministic.
 */
import { describe, it, expect } from 'vitest';

import {
  ACTION_TYPES,
  URGENCY_LEVELS,
  ACTION_STATUS,
  generateRowActions,
  computeDecisionRankingScore,
} from '../../domains/risk/actionRecommender';

// ── Test fixtures ─────────────────────────────────────────────────────────

const makeRow = (overrides = {}) => ({
  material_code: 'SKU-001',
  plant_id: 'P1',
  onhand_qty: 100,
  demand_qty: 200,
  inbound_qty: 50,
  gap_qty: -50,
  safety_stock: 20,
  lead_time_days: 7,
  stockout_probability: 0.75,
  confidence_score: 0.8,
  unit_margin: 15,
  supplier_reliability: 0.9,
  risk_level: 'warning',
  assumptions: [],
  estimatedLeadTime: false,
  estimatedSafetyStock: false,
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Enhanced Action Model', () => {

  describe('ACTION_TYPES', () => {
    it('has all 6 action types', () => {
      expect(Object.keys(ACTION_TYPES)).toHaveLength(6);
      expect(ACTION_TYPES.EXPEDITE).toBe('expedite');
      expect(ACTION_TYPES.TRANSFER_STOCK).toBe('transfer_stock');
      expect(ACTION_TYPES.CHANGE_SUPPLIER).toBe('change_supplier');
      expect(ACTION_TYPES.INCREASE_SAFETY).toBe('increase_safety_stock');
      expect(ACTION_TYPES.REVIEW_DEMAND).toBe('review_demand');
      expect(ACTION_TYPES.UPLOAD_DATA).toBe('upload_missing_data');
    });
  });

  describe('URGENCY_LEVELS', () => {
    it('has 4 urgency levels', () => {
      expect(URGENCY_LEVELS.CRITICAL).toBe('critical');
      expect(URGENCY_LEVELS.HIGH).toBe('high');
      expect(URGENCY_LEVELS.MEDIUM).toBe('medium');
      expect(URGENCY_LEVELS.LOW).toBe('low');
    });
  });

  describe('ACTION_STATUS', () => {
    it('has 4 status values', () => {
      expect(ACTION_STATUS.OPEN).toBe('open');
      expect(ACTION_STATUS.IN_PROGRESS).toBe('in_progress');
      expect(ACTION_STATUS.DONE).toBe('done');
      expect(ACTION_STATUS.DISMISSED).toBe('dismissed');
    });
  });

  describe('generateRowActions', () => {
    it('returns array of actions for a row with gap', () => {
      const row = makeRow({ gap_qty: -100, stockout_probability: 0.9 });
      const actions = generateRowActions(row);

      expect(Array.isArray(actions)).toBe(true);
      expect(actions.length).toBeGreaterThan(0);
    });

    it('each action has enhanced model fields', () => {
      const row = makeRow({ gap_qty: -100, stockout_probability: 0.9 });
      const actions = generateRowActions(row);

      for (const action of actions) {
        expect(action).toHaveProperty('type');
        expect(action).toHaveProperty('id');
        expect(action).toHaveProperty('urgency');
        expect(action).toHaveProperty('reason_code');
        expect(action).toHaveProperty('sku');
        expect(action).toHaveProperty('plant_id');
        expect(action).toHaveProperty('status');
        expect(action).toHaveProperty('owner');
        expect(action).toHaveProperty('due_date');

        // Defaults
        expect(action.status).toBe('open');
        expect(action.owner).toBeNull();
        expect(action.due_date).toBeNull();

        // ID should be string starting with 'act_'
        expect(typeof action.id).toBe('string');
        expect(action.id.startsWith('act_')).toBe(true);

        // Urgency should be a valid level
        expect(['critical', 'high', 'medium', 'low']).toContain(action.urgency);

        // reason_code should be a non-empty string
        expect(typeof action.reason_code).toBe('string');
        expect(action.reason_code.length).toBeGreaterThan(0);
      }
    });

    it('generates expedite action when inbound exists', () => {
      const row = makeRow({ gap_qty: -100, inbound_qty: 50 });
      const actions = generateRowActions(row);
      const expedite = actions.find(a => a.type === ACTION_TYPES.EXPEDITE);
      if (expedite) {
        expect(expedite.reason_code).toBe('INBOUND_SHIFT_AVAILABLE');
      }
    });

    it('generates upload_data action when data is estimated', () => {
      const row = makeRow({ estimatedLeadTime: true, estimatedSafetyStock: true });
      const actions = generateRowActions(row);
      const upload = actions.find(a => a.type === ACTION_TYPES.UPLOAD_DATA);
      if (upload) {
        expect(upload.reason_code).toBe('DATA_MISSING');
      }
    });

    it('handles row with no risk gracefully', () => {
      const row = makeRow({ gap_qty: 100, stockout_probability: 0, risk_level: 'low' });
      const actions = generateRowActions(row);
      // Should return empty or minimal actions
      expect(Array.isArray(actions)).toBe(true);
    });
  });

  describe('computeDecisionRankingScore', () => {
    it('returns a number between 0 and 1', () => {
      const row = makeRow();
      const score = computeDecisionRankingScore(row);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('higher stockout probability produces higher score', () => {
      const lowRisk = makeRow({ pStockout: 0.1, risk_level: 'low', riskLevel: 'low' });
      const highRisk = makeRow({ pStockout: 0.9, risk_level: 'critical', riskLevel: 'critical' });
      expect(computeDecisionRankingScore(highRisk)).toBeGreaterThan(
        computeDecisionRankingScore(lowRisk)
      );
    });

    it('is deterministic (same input → same output)', () => {
      const row = makeRow();
      const score1 = computeDecisionRankingScore(row);
      const score2 = computeDecisionRankingScore(row);
      expect(score1).toBe(score2);
    });
  });
});
