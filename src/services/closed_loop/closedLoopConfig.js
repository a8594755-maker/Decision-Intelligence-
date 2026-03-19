/**
 * Closed-Loop Config v0
 *
 * Single source of truth for all thresholds, alphas, and constants used in the
 * forecast-to-planning closed-loop re-parameterization pipeline.
 *
 * Pattern: mirrors RISK_ADJ_CONFIG in riskAdjustmentsService.js
 */

// ─── Config constants ─────────────────────────────────────────────────────────

export const CLOSED_LOOP_CONFIG = {
  // ── Trigger thresholds ──────────────────────────────────────────────────────
  // T-COVER: Coverage band — fires when coverage_10_90 falls outside [lower, upper]
  coverage_lower_band: 0.70,
  coverage_upper_band: 0.95,

  // T-UNCERT: Uncertainty width — fires when relative change exceeds threshold
  uncertainty_width_change_pct: 0.20,  // 20% relative change in aggregate (p90-p10)

  // T-P50: Forecast level shift — fires when aggregate p50 shifts by more than this
  p50_shift_pct: 0.15,                // 15% relative shift in sum(p50)

  // T-RISK: Risk severity — fires when any risk_score crosses above this
  risk_severity_trigger: 60,

  // ── Parameterization alphas ─────────────────────────────────────────────────
  // Safety stock = avg(p50) + alpha * max(0, avg(p90) - avg(p50))
  safety_stock_alpha_calibrated: 0.5,        // calibration passed + coverage in band
  safety_stock_alpha_uncalibrated: 0.8,      // calibration failed or metadata absent
  safety_stock_alpha_wide_uncertainty: 1.0,  // coverage_10_90 > upper_band

  // Stockout penalty scaling when uncertainty widens
  stockout_penalty_base: 10.0,
  stockout_penalty_uncertainty_uplift: 0.3,  // fractional increase

  // Lead time buffer when supplier risk is high
  lead_time_buffer_high_risk_days: 3,

  // ── Cooldown / dedupe ───────────────────────────────────────────────────────
  default_cooldown_ms: 30 * 60 * 1000,      // 30 minutes
  max_cooldown_ms: 24 * 60 * 60 * 1000,     // 24 hours

  // ── Modes ───────────────────────────────────────────────────────────────────
  default_mode: 'manual_approve',  // 'dry_run' | 'auto_run' | 'manual_approve'

  // ── Risk replan trigger thresholds ──────────────────────────────────────────
  risk_high_count_trigger: 1,                // min N high-risk SKUs to trigger replan recommendation
  risk_safety_stock_alpha_low: 0.5,          // risk_score 40-60
  risk_safety_stock_alpha_medium: 0.8,       // risk_score 60-80
  risk_safety_stock_alpha_high: 1.2,         // risk_score > 80
  default_stockout_penalty_per_unit: 50.0    // USD per unit shortfall (for benefit estimation)
};

// ─── Status enum ──────────────────────────────────────────────────────────────

export const CLOSED_LOOP_STATUS = {
  NOT_ENABLED:       'NOT_ENABLED',
  NO_TRIGGER:        'NO_TRIGGER',
  COOLDOWN_SUPPRESSED: 'COOLDOWN_SUPPRESSED',
  TRIGGERED_DRY_RUN: 'TRIGGERED_DRY_RUN',
  RERUN_SUBMITTED:   'RERUN_SUBMITTED',
  RERUN_COMPLETED:   'RERUN_COMPLETED',
  ERROR:             'ERROR'
};

// ─── Trigger type identifiers ─────────────────────────────────────────────────

export const TRIGGER_TYPES = {
  COVERAGE_OUTSIDE_BAND:  'coverage_outside_band',
  UNCERTAINTY_WIDENS:     'uncertainty_widens',
  P50_SHIFT:              'p50_shift',
  RISK_SEVERITY_CROSSED:  'risk_severity_crossed',
  NEGOTIATION_RESOLVED:   'negotiation_resolved'
};
