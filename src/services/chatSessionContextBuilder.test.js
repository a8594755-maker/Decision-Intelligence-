import { describe, it, expect } from 'vitest';
import {
  buildChatSessionContext,
  buildContextSummaryForPrompt,
  suggestNextActions,
} from './chatSessionContextBuilder';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EMPTY_SESSION = null;

const BASE_SESSION = {
  dataset: { profile_id: 42, profile_summary: 'test dataset', contract_confirmed: true },
  forecast: { run_id: 100, key_metrics: { mape: 12.5, mae: 3.2, horizon_periods: 6, granularity: 'weekly' }, model_used: 'ets' },
  plan: { run_id: 200, created_at: '2026-01-01T00:00:00Z', kpis: { estimated_total_cost: 50000, estimated_service_level: 0.95, estimated_stockout_units: 10, estimated_holding_units: 300 }, constraints: { budget_cap: 60000 }, objective: 'minimize_cost', solver_status: 'optimal', risk_mode: null },
  previous_plan: { run_id: 150, kpis: { estimated_total_cost: 55000, estimated_service_level: 0.92 }, constraints: {}, objective: null },
  overrides: { budget_cap: null, service_level_target: null },
  intent_history: [
    { intent: 'RUN_PLAN', timestamp: '2026-01-01T00:01:00Z', params: {} },
    { intent: 'WHAT_IF', timestamp: '2026-01-01T00:05:00Z', params: {} },
  ],
  pending_approvals: [],
  active_alerts: { alert_ids: ['a1', 'a2'], dismissed_ids: ['a1'] },
  supplier_events: { event_count: 3, last_event_at: '2026-01-01', last_risk_delta: 0.15 },
  negotiation: { round: 0 },
};

// ── buildChatSessionContext ──────────────────────────────────────────────────

describe('buildChatSessionContext', () => {
  it('returns a valid context with no inputs', () => {
    const ctx = buildChatSessionContext();
    expect(ctx).toBeDefined();
    expect(ctx.route).toBe('/');
    expect(ctx.view).toBe('unknown'); // no pathname passed
    expect(ctx.built_at).toBeTruthy();
    expect(ctx.dataset).toBeNull();
    expect(ctx.baseline).toBeNull();
  });

  it('resolves known routes to views', () => {
    expect(buildChatSessionContext({ pathname: '/risk' }).view).toBe('risk_center');
    expect(buildChatSessionContext({ pathname: '/digital-twin' }).view).toBe('digital_twin');
    expect(buildChatSessionContext({ pathname: '/chat' }).view).toBe('decision_support');
    expect(buildChatSessionContext({ pathname: '/unknown-page' }).view).toBe('unknown');
  });

  it('populates dataset, forecast, baseline from session context', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    expect(ctx.dataset.profile_id).toBe(42);
    expect(ctx.dataset.contract_confirmed).toBe(true);
    expect(ctx.forecast.run_id).toBe(100);
    expect(ctx.forecast.key_metrics.mape).toBe(12.5);
    expect(ctx.baseline.run_id).toBe(200);
    expect(ctx.baseline.solver_status).toBe('optimal');
    expect(ctx.previous_plan.run_id).toBe(150);
  });

  it('resolves workflow stage correctly', () => {
    // No session → no_session
    expect(buildChatSessionContext().workflow.stage).toBe('no_session');

    // No dataset → awaiting_dataset
    expect(buildChatSessionContext({ sessionCtx: { dataset: {} } }).workflow.stage).toBe('awaiting_dataset');

    // Plan complete
    expect(buildChatSessionContext({ sessionCtx: BASE_SESSION }).workflow.stage).toBe('plan_complete');

    // Infeasible
    const infeasible = { ...BASE_SESSION, plan: { ...BASE_SESSION.plan, solver_status: 'infeasible' } };
    expect(buildChatSessionContext({ sessionCtx: infeasible }).workflow.stage).toBe('plan_infeasible');
  });

  it('extracts selection from canvas state', () => {
    const ctx = buildChatSessionContext({
      canvasState: { selectedSku: 'SKU-001', selectedPlant: 'P1' },
    });
    expect(ctx.selection).toEqual({ sku: 'SKU-001', plant_id: 'P1' });
  });

  it('returns null selection when canvas state is empty', () => {
    const ctx = buildChatSessionContext({ canvasState: {} });
    expect(ctx.selection).toBeNull();
  });

  it('populates risk fields', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    expect(ctx.risk.active_alerts).toBe(2);
    expect(ctx.risk.dismissed_alerts).toBe(1);
    expect(ctx.risk.supplier_event_count).toBe(3);
  });

  it('includes recent intents (max 5)', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    expect(ctx.recent_intents).toHaveLength(2);
    expect(ctx.recent_intents[0].intent).toBe('RUN_PLAN');
  });
});

// ── buildContextSummaryForPrompt ─────────────────────────────────────────────

describe('buildContextSummaryForPrompt', () => {
  it('returns fallback for null context', () => {
    expect(buildContextSummaryForPrompt(null)).toBe('No chat context available.');
  });

  it('includes view, dataset, forecast, baseline in summary', () => {
    const ctx = buildChatSessionContext({ pathname: '/chat', sessionCtx: BASE_SESSION });
    const summary = buildContextSummaryForPrompt(ctx);
    expect(summary).toContain('View: decision_support');
    expect(summary).toContain('Dataset: profile_id=42');
    expect(summary).toContain('Forecast: run_id=100');
    expect(summary).toContain('Baseline Plan: run_id=200');
    expect(summary).toContain('Previous Plan: run_id=150');
  });

  it('includes workflow stage', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    const summary = buildContextSummaryForPrompt(ctx);
    expect(summary).toContain('stage=plan_complete');
  });
});

// ── suggestNextActions ───────────────────────────────────────────────────────

describe('suggestNextActions', () => {
  it('returns empty for null context', () => {
    expect(suggestNextActions(null)).toEqual([]);
  });

  it('suggests upload for awaiting_dataset', () => {
    const ctx = buildChatSessionContext();
    const actions = suggestNextActions(ctx);
    // no_session stage won't match awaiting_dataset, but test with explicit
    const awaitingCtx = buildChatSessionContext({ sessionCtx: { dataset: {} } });
    const awaitingActions = suggestNextActions(awaitingCtx);
    expect(awaitingActions.some(a => a.action_id === 'upload_dataset')).toBe(true);
  });

  it('suggests what-if and compare for plan_complete', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    const actions = suggestNextActions(ctx);
    expect(actions.some(a => a.action_id === 'run_what_if')).toBe(true);
    expect(actions.some(a => a.action_id === 'compare_plans')).toBe(true);
  });

  it('suggests negotiation for infeasible plan', () => {
    const infeasible = { ...BASE_SESSION, plan: { ...BASE_SESSION.plan, solver_status: 'infeasible' } };
    const ctx = buildChatSessionContext({ sessionCtx: infeasible });
    const actions = suggestNextActions(ctx);
    expect(actions.some(a => a.action_id === 'start_negotiation')).toBe(true);
  });

  it('suggests risk assessment when supplier events exist', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    const actions = suggestNextActions(ctx);
    expect(actions.some(a => a.action_id === 'assess_risk_delta')).toBe(true);
  });

  it('actions are sorted by priority', () => {
    const ctx = buildChatSessionContext({ sessionCtx: BASE_SESSION });
    const actions = suggestNextActions(ctx);
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].priority).toBeGreaterThanOrEqual(actions[i - 1].priority);
    }
  });
});
