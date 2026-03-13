/**
 * Tests: Negotiation Outcome Translator
 *
 * Verifies that resolved negotiation cases are correctly translated
 * into planning constraint patches for the closed-loop re-planning pipeline.
 */

import { describe, it, expect } from 'vitest';
import { deriveConstraintPatch } from './negotiationOutcomeTranslator.js';

// ── Walk-away resolution ────────────────────────────────────────────────────

describe('deriveConstraintPatch — walkaway', () => {
  it('should return no patches and should_replan=false for walkaway', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_walkaway',
      trigger: 'infeasible',
    });

    expect(result.should_replan).toBe(false);
    expect(result.replan_reason).toBe('walkaway');
    expect(result.explanations).toHaveLength(1);
    expect(result.explanations[0]).toContain('walk-away');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].rule_id).toBe('NEG-R0_walkaway');
  });
});

// ── Non-resolution status ───────────────────────────────────────────────────

describe('deriveConstraintPatch — non-resolution', () => {
  it('should return no patches for active status', () => {
    const result = deriveConstraintPatch({
      status: 'active',
      trigger: 'infeasible',
    });

    expect(result.should_replan).toBe(false);
    expect(result.replan_reason).toBe('not_resolved');
  });

  it('should handle null input gracefully', () => {
    const result = deriveConstraintPatch(null);
    expect(result.should_replan).toBe(false);
  });
});

// ── Agreement with opt_001 (budget increase) ────────────────────────────────

describe('deriveConstraintPatch — opt_001 (budget cap)', () => {
  it('should derive budget cap patch from agreed_terms', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_001',
      outcome: { budget_cap: 110000 },
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.constraints.budget_cap).toBe(110000);
    expect(result.explanations.length).toBeGreaterThanOrEqual(1);
    expect(result.rules[0].rule_id).toBe('NEG-R1_budget_adjustment');
  });

  it('should derive budget cap from option overrides fallback', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_001',
      outcome: {},
      option_overrides: { constraints: { budget_cap: 95000 } },
    });

    expect(result.patches.constraints.budget_cap).toBe(95000);
    expect(result.should_replan).toBe(true);
  });
});

// ── Agreement with opt_002 (MOQ relaxation) ─────────────────────────────────

describe('deriveConstraintPatch — opt_002 (MOQ relaxation)', () => {
  it('should enable soft_moq and set relaxation factor', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_002',
      outcome: { moq_relaxation_factor: 0.75 },
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.engine_flags.soft_moq).toBe(true);
    expect(result.patches.engine_flags.moq_relaxation_factor).toBe(0.75);
    expect(result.rules[0].rule_id).toBe('NEG-R2_moq_relaxation');
  });

  it('should use default factor 0.80 when not specified', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_002',
      outcome: {},
    });

    expect(result.patches.engine_flags.moq_relaxation_factor).toBe(0.80);
  });
});

// ── Agreement with opt_003 (pack rounding) ──────────────────────────────────

describe('deriveConstraintPatch — opt_003 (pack rounding)', () => {
  it('should enable pack size rounding', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_003',
      outcome: {},
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.engine_flags.allow_pack_rounding).toBe(true);
    expect(result.rules[0].rule_id).toBe('NEG-R3_pack_rounding');
  });
});

// ── Agreement with opt_004 (expedite mode) ──────────────────────────────────

describe('deriveConstraintPatch — opt_004 (expedite mode)', () => {
  it('should enable expedite mode with default reduction', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'kpi_shortfall',
      applied_option_id: 'opt_004',
      outcome: {},
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.engine_flags.expedite_mode).toBe(true);
    expect(result.patches.engine_flags.expedite_lead_time_reduction_periods).toBe(1);
  });

  it('should use custom lead time reduction from agreed terms', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'kpi_shortfall',
      applied_option_id: 'opt_004',
      outcome: { lead_time_reduction_periods: 2 },
    });

    expect(result.patches.engine_flags.expedite_lead_time_reduction_periods).toBe(2);
  });
});

// ── Agreement with opt_005 (safety stock) ───────────────────────────────────

describe('deriveConstraintPatch — opt_005 (safety stock)', () => {
  it('should set safety stock multiplier', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'kpi_shortfall',
      applied_option_id: 'opt_005',
      outcome: { safety_stock_multiplier: 1.5 },
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.plan.safety_stock_multiplier).toBe(1.5);
    expect(result.patches.engine_flags.safety_stock_multiplier).toBe(1.5);
  });
});

// ── Direct outcome terms ────────────────────────────────────────────────────

describe('deriveConstraintPatch — direct outcome terms', () => {
  it('should apply lead_time_days from outcome', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'kpi_shortfall',
      outcome: { lead_time_days: 14 },
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.engine_flags.negotiated_lead_time_days).toBe(14);
  });

  it('should apply unit_price from outcome', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      outcome: { unit_price: 42.50 },
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.objective.negotiated_unit_price).toBe(42.50);
  });

  it('should combine option patches with direct outcome terms', () => {
    const result = deriveConstraintPatch({
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_001',
      outcome: {
        budget_cap: 120000,
        lead_time_days: 10,
      },
    });

    expect(result.should_replan).toBe(true);
    expect(result.patches.constraints.budget_cap).toBe(120000);
    expect(result.patches.engine_flags.negotiated_lead_time_days).toBe(10);
    expect(result.explanations.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe('deriveConstraintPatch — determinism', () => {
  it('should produce identical output for identical inputs', () => {
    const input = {
      status: 'resolved_agreement',
      trigger: 'infeasible',
      applied_option_id: 'opt_002',
      outcome: { moq_relaxation_factor: 0.70 },
    };

    const r1 = deriveConstraintPatch(input);
    const r2 = deriveConstraintPatch(input);

    expect(r1.patches).toEqual(r2.patches);
    expect(r1.should_replan).toBe(r2.should_replan);
    expect(r1.rules).toEqual(r2.rules);
  });
});
