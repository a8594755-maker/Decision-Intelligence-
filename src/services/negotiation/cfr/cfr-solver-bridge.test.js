import { describe, it, expect } from 'vitest';
import {
  deriveSolverParamsFromStrategy,
  applyCfrAdjustments,
  buildAdjustmentArtifact,
  BRIDGE_CONFIG,
} from './cfr-solver-bridge.js';

// ---------------------------------------------------------------------------
// deriveSolverParamsFromStrategy
// ---------------------------------------------------------------------------

describe('deriveSolverParamsFromStrategy', () => {
  it('returns no adjustment for cooperative supplier', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.4, reject: 0.3, counter: 0.3 },
      supplierTypePriors: { AGGRESSIVE: 0.20, COOPERATIVE: 0.60, DESPERATE: 0.20 },
      positionBucket: 2,
    });

    expect(result.safety_stock_alpha_multiplier).toBe(1.0);
    expect(result.stockout_penalty_multiplier).toBe(1.0);
    expect(result.dual_source_flag).toBe(false);
    expect(result.supplier_assessment).toBe('cooperative');
  });

  it('reduces alpha when supplier is desperate', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.6, reject: 0.1, counter: 0.3 },
      supplierTypePriors: { AGGRESSIVE: 0.10, COOPERATIVE: 0.40, DESPERATE: 0.50 },
      positionBucket: 2,
    });

    expect(result.safety_stock_alpha_multiplier).toBe(BRIDGE_CONFIG.DESPERATE_ALPHA_MULTIPLIER);
    expect(result.stockout_penalty_multiplier).toBe(1.0);
    expect(result.dual_source_flag).toBe(false);
    expect(result.supplier_assessment).toBe('desperate');
    expect(result.confidence).toBeCloseTo(0.50, 2);
    expect(result.adjustment_reason).toContain('supplier_desperate');
  });

  it('amplifies desperate savings when buyer has strong position', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.5, reject: 0.2, counter: 0.3 },
      supplierTypePriors: { AGGRESSIVE: 0.10, COOPERATIVE: 0.30, DESPERATE: 0.60 },
      positionBucket: 4, // VERY_STRONG
    });

    // Extra reduction for strong position: 0.70 - 0.05 * (4-3+1) = 0.60
    expect(result.safety_stock_alpha_multiplier).toBe(0.60);
    expect(result.adjustment_reason).toContain('strong_position');
  });

  it('raises alpha and flags dual-source when supplier is aggressive', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.1, reject: 0.5, counter: 0.4 },
      supplierTypePriors: { AGGRESSIVE: 0.60, COOPERATIVE: 0.30, DESPERATE: 0.10 },
      positionBucket: 2,
    });

    expect(result.safety_stock_alpha_multiplier).toBe(BRIDGE_CONFIG.AGGRESSIVE_ALPHA_MULTIPLIER);
    expect(result.stockout_penalty_multiplier).toBe(BRIDGE_CONFIG.AGGRESSIVE_PENALTY_MULTIPLIER);
    expect(result.dual_source_flag).toBe(true);
    expect(result.supplier_assessment).toBe('aggressive');
    expect(result.adjustment_reason).toContain('supplier_aggressive');
  });

  it('amplifies aggressive defense when buyer has weak position', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.1, reject: 0.6, counter: 0.3 },
      supplierTypePriors: { AGGRESSIVE: 0.55, COOPERATIVE: 0.30, DESPERATE: 0.15 },
      positionBucket: 0, // VERY_WEAK
    });

    // Extra increase for weak position: 1.30 + 0.05 * (1-0+1) = 1.40
    expect(result.safety_stock_alpha_multiplier).toBe(1.40);
    expect(result.adjustment_reason).toContain('weak_position');
  });

  it('clamps alpha multiplier to min 0.50 for desperate', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: {},
      supplierTypePriors: { AGGRESSIVE: 0.0, COOPERATIVE: 0.0, DESPERATE: 1.0 },
      positionBucket: 4, // VERY_STRONG → extra reduction
    });

    expect(result.safety_stock_alpha_multiplier).toBeGreaterThanOrEqual(0.50);
  });

  it('clamps alpha multiplier to max 1.60 for aggressive', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: {},
      supplierTypePriors: { AGGRESSIVE: 1.0, COOPERATIVE: 0.0, DESPERATE: 0.0 },
      positionBucket: 0, // VERY_WEAK → extra increase
    });

    expect(result.safety_stock_alpha_multiplier).toBeLessThanOrEqual(1.60);
  });

  it('handles missing/empty inputs gracefully', () => {
    const result = deriveSolverParamsFromStrategy();

    expect(result.safety_stock_alpha_multiplier).toBe(1.0);
    expect(result.stockout_penalty_multiplier).toBe(1.0);
    expect(result.dual_source_flag).toBe(false);
    expect(result.supplier_assessment).toBe('mixed');
  });

  it('boosts confidence when high accept prob confirms desperate assessment', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.8, reject: 0.1, counter: 0.1 },
      supplierTypePriors: { AGGRESSIVE: 0.10, COOPERATIVE: 0.40, DESPERATE: 0.50 },
      positionBucket: 2,
    });

    expect(result.confidence).toBeCloseTo(0.60, 2);
  });

  it('does not adjust when priors are balanced (mixed)', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: { accept: 0.33, reject: 0.33, counter: 0.34 },
      supplierTypePriors: { AGGRESSIVE: 0.34, COOPERATIVE: 0.33, DESPERATE: 0.33 },
      positionBucket: 2,
    });

    expect(result.safety_stock_alpha_multiplier).toBe(1.0);
    expect(result.supplier_assessment).toBe('mixed');
  });

  it('prefers desperate over aggressive when both above threshold but desperate higher', () => {
    const result = deriveSolverParamsFromStrategy({
      cfrActionProbs: {},
      supplierTypePriors: { AGGRESSIVE: 0.42, COOPERATIVE: 0.08, DESPERATE: 0.50 },
      positionBucket: 2,
    });

    expect(result.supplier_assessment).toBe('desperate');
    expect(result.safety_stock_alpha_multiplier).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// applyCfrAdjustments
// ---------------------------------------------------------------------------

describe('applyCfrAdjustments', () => {
  it('applies multipliers to base parameters', () => {
    const result = applyCfrAdjustments(
      { safety_stock_alpha: 0.5, stockout_penalty_base: 10.0 },
      { safety_stock_alpha_multiplier: 0.70, stockout_penalty_multiplier: 1.0 }
    );

    expect(result.safety_stock_alpha).toBeCloseTo(0.35, 4);
    expect(result.stockout_penalty_base).toBe(10.0);
    expect(result.cfr_adjusted).toBe(true);
  });

  it('sets cfr_adjusted = false when no change', () => {
    const result = applyCfrAdjustments(
      { safety_stock_alpha: 0.5, stockout_penalty_base: 10.0 },
      { safety_stock_alpha_multiplier: 1.0, stockout_penalty_multiplier: 1.0 }
    );

    expect(result.cfr_adjusted).toBe(false);
  });

  it('propagates dual_source_flag', () => {
    const result = applyCfrAdjustments(
      { safety_stock_alpha: 0.5 },
      { safety_stock_alpha_multiplier: 1.3, dual_source_flag: true }
    );

    expect(result.dual_source_flag).toBe(true);
    expect(result.cfr_adjusted).toBe(true);
  });

  it('uses defaults for missing base params', () => {
    const result = applyCfrAdjustments({}, { safety_stock_alpha_multiplier: 0.7 });

    expect(result.safety_stock_alpha).toBeCloseTo(0.35, 4);
    expect(result.stockout_penalty_base).toBe(10.0);
  });
});

// ---------------------------------------------------------------------------
// buildAdjustmentArtifact
// ---------------------------------------------------------------------------

describe('buildAdjustmentArtifact', () => {
  it('builds a complete artifact payload', () => {
    const artifact = buildAdjustmentArtifact({
      adjustment: {
        safety_stock_alpha_multiplier: 0.70,
        stockout_penalty_multiplier: 1.0,
        supplier_assessment: 'desperate',
        confidence: 0.55,
        adjustment_reason: 'supplier_desperate (P=0.55)',
      },
      baseParams: { safety_stock_alpha: 0.5, stockout_penalty_base: 10.0 },
      adjustedParams: { safety_stock_alpha: 0.35, stockout_penalty_base: 10.0, dual_source_flag: false },
      cfrEnrichment: { scenario_id: 'sc_low_ontime', buyer_bucket: 3, source: 'exact' },
      planRunId: 42,
    });

    expect(artifact.version).toBe('v0');
    expect(artifact.generated_at).toBeTruthy();
    expect(artifact.plan_run_id).toBe(42);
    expect(artifact.scenario_id).toBe('sc_low_ontime');
    expect(artifact.buyer_bucket).toBe(3);
    expect(artifact.supplier_assessment).toBe('desperate');
    expect(artifact.base_params.safety_stock_alpha).toBe(0.5);
    expect(artifact.adjusted_params.safety_stock_alpha).toBe(0.35);
    expect(artifact.multipliers.safety_stock_alpha_multiplier).toBe(0.70);
  });

  it('handles missing cfrEnrichment gracefully', () => {
    const artifact = buildAdjustmentArtifact({
      adjustment: { supplier_assessment: 'mixed', confidence: 0.33 },
      baseParams: {},
      adjustedParams: {},
    });

    expect(artifact.scenario_id).toBeNull();
    expect(artifact.buyer_bucket).toBeNull();
    expect(artifact.cfr_source).toBeNull();
  });
});
