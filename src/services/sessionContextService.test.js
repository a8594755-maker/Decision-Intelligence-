import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSessionContext,
  getSessionContext,
  updateSessionContext,
  updateDatasetContext,
  updateForecastContext,
  updatePlanContext,
  rotatePlanContext,
  applyParameterOverride,
  recordIntent,
  addPendingApproval,
  resolvePendingApproval,
  getEffectiveConstraints,
  canCompareWithPrevious,
  buildSessionSummary,
  updateNegotiationContext,
  recordNegotiationOptionApplied,
  clearNegotiationContext,
  dismissAlert,
  clearSessionContext,
} from './sessionContextService';

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = value; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

describe('sessionContextService', () => {
  const userId = 'user-123';
  const convId = 'conv-456';

  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe('createSessionContext', () => {
    it('creates a valid empty context', () => {
      const ctx = createSessionContext(convId);
      expect(ctx.version).toBe('v1');
      expect(ctx.conversation_id).toBe(convId);
      expect(ctx.dataset.profile_id).toBeNull();
      expect(ctx.forecast.run_id).toBeNull();
      expect(ctx.plan.run_id).toBeNull();
      expect(ctx.previous_plan.run_id).toBeNull();
      expect(ctx.intent_history).toEqual([]);
      expect(ctx.pending_approvals).toEqual([]);
    });
  });

  describe('getSessionContext', () => {
    it('returns new context when nothing stored', () => {
      const ctx = getSessionContext(userId, convId);
      expect(ctx.version).toBe('v1');
      expect(ctx.conversation_id).toBe(convId);
    });

    it('loads stored context from localStorage', () => {
      const stored = createSessionContext(convId);
      stored.dataset.profile_id = 42;
      localStorageMock.setItem(`di_session_ctx_${userId}_${convId}`, JSON.stringify(stored));

      const ctx = getSessionContext(userId, convId);
      expect(ctx.dataset.profile_id).toBe(42);
    });
  });

  describe('updateSessionContext', () => {
    it('applies patch function and persists', () => {
      const ctx = updateSessionContext(userId, convId, (c) => ({
        ...c,
        dataset: { ...c.dataset, profile_id: 99 },
      }));
      expect(ctx.dataset.profile_id).toBe(99);
      expect(localStorageMock.setItem).toHaveBeenCalled();
    });
  });

  describe('updateDatasetContext', () => {
    it('updates dataset fields', () => {
      const ctx = updateDatasetContext(userId, convId, { profile_id: 10, profile_summary: 'Test dataset' });
      expect(ctx.dataset.profile_id).toBe(10);
      expect(ctx.dataset.profile_summary).toBe('Test dataset');
    });
  });

  describe('updateForecastContext', () => {
    it('extracts forecast result fields', () => {
      const ctx = updateForecastContext(userId, convId, {
        run: { id: 55 },
        evaluation: { mape: 0.08, mae: 12.5, selected_model_global: 'prophet' },
      });
      expect(ctx.forecast.run_id).toBe(55);
      expect(ctx.forecast.key_metrics.mape).toBe(0.08);
      expect(ctx.forecast.model_used).toBe('prophet');
    });

    it('handles null forecastResult gracefully', () => {
      const ctx = updateForecastContext(userId, convId, null);
      expect(ctx.forecast.run_id).toBeNull();
    });
  });

  describe('updatePlanContext', () => {
    it('extracts plan result fields', () => {
      const ctx = updatePlanContext(userId, convId, {
        run: { id: 77 },
        solver_result: {
          status: 'optimal',
          kpis: {
            estimated_total_cost: 50000,
            estimated_service_level: 0.97,
            estimated_stockout_units: 5,
            estimated_holding_units: 120,
          },
        },
        risk_mode: 'on',
      });
      expect(ctx.plan.run_id).toBe(77);
      expect(ctx.plan.solver_status).toBe('optimal');
      expect(ctx.plan.kpis.estimated_total_cost).toBe(50000);
      expect(ctx.plan.risk_mode).toBe('on');
    });
  });

  describe('rotatePlanContext', () => {
    it('moves current plan to previous_plan', () => {
      // Set up current plan
      updatePlanContext(userId, convId, {
        run: { id: 10 },
        solver_result: { status: 'optimal', kpis: { estimated_total_cost: 30000 } },
      });

      const ctx = rotatePlanContext(userId, convId);
      expect(ctx.previous_plan.run_id).toBe(10);
      expect(ctx.previous_plan.kpis.estimated_total_cost).toBe(30000);
    });
  });

  describe('applyParameterOverride', () => {
    it('applies a simple override', () => {
      const ctx = applyParameterOverride(userId, convId, 'budget_cap', 500000);
      expect(ctx.overrides.budget_cap).toBe(500000);
    });

    it('applies nested override', () => {
      const ctx = applyParameterOverride(userId, convId, 'risk_settings.risk_mode', 'on');
      expect(ctx.overrides.risk_settings.risk_mode).toBe('on');
    });
  });

  describe('recordIntent', () => {
    it('appends to intent history', () => {
      recordIntent(userId, convId, 'RUN_PLAN', { budget_cap: 500000 });
      const ctx = recordIntent(userId, convId, 'CHANGE_PARAM', { service_level_target: 0.97 });

      expect(ctx.intent_history).toHaveLength(2);
      expect(ctx.intent_history[0].intent).toBe('RUN_PLAN');
      expect(ctx.intent_history[1].intent).toBe('CHANGE_PARAM');
    });

    it('caps history at 50 entries', () => {
      for (let i = 0; i < 60; i++) {
        recordIntent(userId, convId, 'RUN_PLAN', { i });
      }
      const ctx = getSessionContext(userId, convId);
      expect(ctx.intent_history.length).toBeLessThanOrEqual(50);
    });
  });

  describe('pending approvals', () => {
    it('adds and resolves approvals', () => {
      addPendingApproval(userId, convId, { approval_id: 'a1', run_id: 1, status: 'PENDING' });
      addPendingApproval(userId, convId, { approval_id: 'a2', run_id: 2, status: 'PENDING' });

      const ctx = resolvePendingApproval(userId, convId, 'a1', 'APPROVED');
      const a1 = ctx.pending_approvals.find((a) => a.approval_id === 'a1');
      const a2 = ctx.pending_approvals.find((a) => a.approval_id === 'a2');

      expect(a1.status).toBe('APPROVED');
      expect(a1.decided_at).toBeDefined();
      expect(a2.status).toBe('PENDING');
    });
  });

  describe('getEffectiveConstraints', () => {
    it('merges plan constraints with overrides', () => {
      updatePlanContext(userId, convId, {
        run: { id: 1 },
        solver_result: { kpis: {} },
        _submitted_constraints: { budget_cap: 100000 },
      });
      applyParameterOverride(userId, convId, 'budget_cap', 200000);

      const ctx = getSessionContext(userId, convId);
      const constraints = getEffectiveConstraints(ctx);
      expect(constraints.budget_cap).toBe(200000);
    });
  });

  describe('canCompareWithPrevious', () => {
    it('returns false when no previous plan', () => {
      const ctx = createSessionContext(convId);
      expect(canCompareWithPrevious(ctx)).toBe(false);
    });

    it('returns true when both current and previous exist', () => {
      updatePlanContext(userId, convId, { run: { id: 1 }, solver_result: { kpis: {} } });
      rotatePlanContext(userId, convId);
      updatePlanContext(userId, convId, { run: { id: 2 }, solver_result: { kpis: {} } });

      const ctx = getSessionContext(userId, convId);
      expect(canCompareWithPrevious(ctx)).toBe(true);
    });
  });

  describe('buildSessionSummary', () => {
    it('returns empty state message for empty context', () => {
      const summary = buildSessionSummary(createSessionContext(convId));
      expect(summary).toContain('Empty session');
    });

    it('includes dataset, forecast, plan info when populated', () => {
      updateDatasetContext(userId, convId, { profile_id: 42, profile_summary: 'Test' });
      updateForecastContext(userId, convId, { run: { id: 5 }, evaluation: { mape: 0.1 } });
      updatePlanContext(userId, convId, {
        run: { id: 10 },
        solver_result: { status: 'optimal', kpis: { estimated_total_cost: 50000, estimated_service_level: 0.97 } },
      });

      const ctx = getSessionContext(userId, convId);
      const summary = buildSessionSummary(ctx);
      expect(summary).toContain('profile_id=42');
      expect(summary).toContain('run_id=5');
      expect(summary).toContain('run_id=10');
      expect(summary).toContain('optimal');
    });
  });

  describe('dismissAlert', () => {
    it('adds alert ID to dismissed list', () => {
      const ctx = dismissAlert(userId, convId, 'alert_123');
      expect(ctx.active_alerts.dismissed_ids).toContain('alert_123');
    });

    it('deduplicates dismissed IDs', () => {
      dismissAlert(userId, convId, 'alert_123');
      const ctx = dismissAlert(userId, convId, 'alert_123');
      expect(ctx.active_alerts.dismissed_ids.filter((id) => id === 'alert_123')).toHaveLength(1);
    });
  });

  describe('clearSessionContext', () => {
    it('removes from localStorage', () => {
      updateDatasetContext(userId, convId, { profile_id: 42 });
      clearSessionContext(userId, convId);
      expect(localStorageMock.removeItem).toHaveBeenCalled();
    });
  });

  describe('negotiation context', () => {
    it('createSessionContext includes negotiation with round 0', () => {
      const ctx = createSessionContext(convId);
      expect(ctx.negotiation).toBeDefined();
      expect(ctx.negotiation.round).toBe(0);
      expect(ctx.negotiation.trigger).toBeNull();
      expect(ctx.negotiation.history).toEqual([]);
    });

    it('updateNegotiationContext sets round and trigger', () => {
      const ctx = updateNegotiationContext(userId, convId, {
        triggered: true,
        trigger: 'infeasible',
        negotiation_options: { options: [{ option_id: 'opt_001' }] },
        negotiation_evaluation: { ranked_options: [] },
        negotiation_report: { summary: 'test' },
      }, 42);
      expect(ctx.negotiation.round).toBe(1);
      expect(ctx.negotiation.trigger).toBe('infeasible');
      expect(ctx.negotiation.active_plan_run_id).toBe(42);
      expect(ctx.negotiation.options).toEqual({ options: [{ option_id: 'opt_001' }] });
      expect(ctx.negotiation.applied_option_id).toBeNull();
    });

    it('updateNegotiationContext increments round on repeated calls', () => {
      updateNegotiationContext(userId, convId, {
        trigger: 'infeasible',
        negotiation_options: { options: [] },
        negotiation_evaluation: null,
        negotiation_report: null,
      }, 42);
      const ctx = updateNegotiationContext(userId, convId, {
        trigger: 'kpi_shortfall',
        negotiation_options: { options: [] },
        negotiation_evaluation: null,
        negotiation_report: null,
      }, 43);
      expect(ctx.negotiation.round).toBe(2);
      expect(ctx.negotiation.trigger).toBe('kpi_shortfall');
      expect(ctx.negotiation.active_plan_run_id).toBe(43);
    });

    it('recordNegotiationOptionApplied appends to history', () => {
      updateNegotiationContext(userId, convId, {
        trigger: 'infeasible',
        negotiation_options: { options: [] },
        negotiation_evaluation: null,
        negotiation_report: null,
      }, 42);
      const ctx = recordNegotiationOptionApplied(userId, convId, 'opt_001', 43, { estimated_total_cost: 1000 });
      expect(ctx.negotiation.applied_option_id).toBe('opt_001');
      expect(ctx.negotiation.history).toHaveLength(1);
      expect(ctx.negotiation.history[0].option_id).toBe('opt_001');
      expect(ctx.negotiation.history[0].plan_run_id).toBe(43);
      expect(ctx.negotiation.history[0].kpis.estimated_total_cost).toBe(1000);
      expect(ctx.negotiation.history[0].applied_at).toBeDefined();
    });

    it('clearNegotiationContext resets negotiation state', () => {
      updateNegotiationContext(userId, convId, {
        trigger: 'kpi_shortfall',
        negotiation_options: { options: [] },
        negotiation_evaluation: null,
        negotiation_report: null,
      }, 42);
      const ctx = clearNegotiationContext(userId, convId);
      expect(ctx.negotiation.round).toBe(0);
      expect(ctx.negotiation.trigger).toBeNull();
      expect(ctx.negotiation.active_plan_run_id).toBeNull();
      expect(ctx.negotiation.history).toEqual([]);
    });

    it('buildSessionSummary includes negotiation info when active', () => {
      updateNegotiationContext(userId, convId, {
        trigger: 'infeasible',
        negotiation_options: { options: [] },
        negotiation_evaluation: null,
        negotiation_report: null,
      }, 42);
      const ctx = getSessionContext(userId, convId);
      const summary = buildSessionSummary(ctx);
      expect(summary).toContain('Active Negotiation');
      expect(summary).toContain('infeasible');
    });

    it('buildSessionSummary omits negotiation info when round is 0', () => {
      const ctx = createSessionContext(convId);
      const summary = buildSessionSummary(ctx);
      expect(summary).not.toContain('Active Negotiation');
    });
  });
});
