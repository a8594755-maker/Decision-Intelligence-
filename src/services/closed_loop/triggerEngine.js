/**
 * Trigger Engine v0
 *
 * Configurable rule engine that evaluates whether a closed-loop planning re-run
 * should be triggered, based on forecast changes, calibration quality, and risk signals.
 * Includes cooldown/deduplication management to prevent rerun spam.
 *
 * All evaluation functions are deterministic given the same inputs.
 */

import { CLOSED_LOOP_CONFIG, TRIGGER_TYPES } from './closedLoopConfig.js';
import { aggregateUncertaintyWidth, aggregateP50 } from './forecastToPlanParams.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Derive ISO week string from a Date: "YYYY-Www"
 */
function isoWeek(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  // Thursday in current week decides the year
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Build a dedupe key from context fields.
 */
function buildDedupeKey(datasetId, triggerType, timeBucket, forecastRunId) {
  return `${datasetId}|${triggerType}|${timeBucket}|${forecastRunId}`;
}

// ─── Cooldown Manager ─────────────────────────────────────────────────────────

/**
 * createCooldownManager
 *
 * In-memory cooldown/deduplication manager. Prevents the same trigger from
 * firing more than once within a configurable time window per dataset.
 *
 * @param {Object} configOverrides - Overrides for default_cooldown_ms
 * @returns {{ check, record, reset, dump }}
 */
export function createCooldownManager(configOverrides = {}) {
  const config = { ...CLOSED_LOOP_CONFIG, ...configOverrides };
  const entries = new Map(); // dedupeKey → { recorded_at, expires_at }

  /**
   * Prune expired entries lazily.
   */
  function prune() {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now >= entry.expires_at) {
        entries.delete(key);
      }
    }
  }

  return {
    /**
     * Check if a cooldown is active for the given key.
     * @param {string} dedupeKey
     * @returns {{ active: boolean, expires_at: string|null }}
     */
    check(dedupeKey) {
      prune();
      const entry = entries.get(dedupeKey);
      if (entry && Date.now() < entry.expires_at) {
        return {
          active: true,
          expires_at: new Date(entry.expires_at).toISOString()
        };
      }
      return { active: false, expires_at: null };
    },

    /**
     * Record a cooldown entry for the given key.
     * @param {string} dedupeKey
     * @param {number} cooldownMs - Override for this specific entry
     */
    record(dedupeKey, cooldownMs) {
      const ms = Math.min(
        toNumber(cooldownMs, config.default_cooldown_ms),
        config.max_cooldown_ms
      );
      const now = Date.now();
      entries.set(dedupeKey, {
        recorded_at: now,
        expires_at: now + ms
      });
    },

    /**
     * Reset cooldown for a specific key, or all keys if no key provided.
     * @param {string} [dedupeKey]
     */
    reset(dedupeKey) {
      if (dedupeKey) {
        entries.delete(dedupeKey);
      } else {
        entries.clear();
      }
    },

    /**
     * Dump all active entries for debugging.
     * @returns {Object} key → { recorded_at, expires_at } (ISO strings)
     */
    dump() {
      prune();
      const result = {};
      for (const [key, entry] of entries) {
        result[key] = {
          recorded_at: new Date(entry.recorded_at).toISOString(),
          expires_at: new Date(entry.expires_at).toISOString()
        };
      }
      return result;
    }
  };
}

// ─── Default singleton cooldown manager ───────────────────────────────────────

let _defaultManager = null;

/**
 * Get or create the default (singleton) cooldown manager.
 * Use createCooldownManager() for isolated testing.
 */
export function getDefaultCooldownManager() {
  if (!_defaultManager) {
    _defaultManager = createCooldownManager();
  }
  return _defaultManager;
}

/** Reset the default cooldown manager (for testing). */
export function resetDefaultCooldownManager() {
  if (_defaultManager) _defaultManager.reset();
  _defaultManager = null;
}

// ─── Trigger Evaluation ───────────────────────────────────────────────────────

/**
 * evaluateTriggers
 *
 * Evaluates all trigger rules and returns a structured decision.
 *
 * @param {Object} context
 * @param {string|number} context.dataset_id        - Dataset identifier
 * @param {string|number} context.forecast_run_id   - Current forecast run ID
 * @param {Object}  context.currentForecast          - { series: [...], metrics: {...} }
 * @param {Object}  context.previousForecast         - Previous forecast bundle (nullable)
 * @param {Object}  context.calibrationMeta          - { calibration_passed, coverage_10_90 } (nullable)
 * @param {Object}  context.riskBundle               - { riskScores: [...] } (nullable)
 * @param {Object}  context.configOverrides          - Overrides for CLOSED_LOOP_CONFIG
 * @param {Object}  context.cooldownManager          - Optional cooldown manager instance
 *
 * @returns {TriggerDecision}
 */
export function evaluateTriggers({
  dataset_id,
  forecast_run_id,
  currentForecast = {},
  previousForecast = null,
  calibrationMeta = null,
  riskBundle = null,
  configOverrides = {},
  cooldownManager = null
} = {}) {
  const config = { ...CLOSED_LOOP_CONFIG, ...configOverrides };
  const evaluatedAt = new Date().toISOString();
  const timeBucket = isoWeek(new Date());

  const reasons = [];
  const currentSeries = Array.isArray(currentForecast?.series) ? currentForecast.series : [];

  // ── T-COVER: Coverage outside acceptable band ──────────────────────────────
  const coverage = toNumber(calibrationMeta?.coverage_10_90, NaN);
  if (Number.isFinite(coverage)) {
    if (coverage < config.coverage_lower_band) {
      reasons.push({
        trigger_type: TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND,
        severity: 'high',
        detail: `coverage_10_90=${coverage.toFixed(4)} < lower_band=${config.coverage_lower_band}`,
        evidence: { coverage_10_90: coverage, threshold: config.coverage_lower_band, direction: 'below' }
      });
    } else if (coverage > config.coverage_upper_band) {
      reasons.push({
        trigger_type: TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND,
        severity: 'medium',
        detail: `coverage_10_90=${coverage.toFixed(4)} > upper_band=${config.coverage_upper_band}`,
        evidence: { coverage_10_90: coverage, threshold: config.coverage_upper_band, direction: 'above' }
      });
    }
  }

  // ── T-UNCERT: Uncertainty width change ─────────────────────────────────────
  const prevSeries = previousForecast?.series;
  if (Array.isArray(prevSeries) && prevSeries.length > 0 && currentSeries.length > 0) {
    const currentWidth = aggregateUncertaintyWidth(currentSeries);
    const previousWidth = aggregateUncertaintyWidth(prevSeries);

    if (previousWidth > 0) {
      const deltaPct = (currentWidth - previousWidth) / previousWidth;
      if (Math.abs(deltaPct) > config.uncertainty_width_change_pct) {
        reasons.push({
          trigger_type: TRIGGER_TYPES.UNCERTAINTY_WIDENS,
          severity: Math.abs(deltaPct) > 2 * config.uncertainty_width_change_pct ? 'high' : 'medium',
          detail: `Uncertainty width changed ${(deltaPct * 100).toFixed(1)}% (threshold: ` +
                  `${(config.uncertainty_width_change_pct * 100).toFixed(1)}%)`,
          evidence: {
            delta_pct: Number(deltaPct.toFixed(6)),
            threshold: config.uncertainty_width_change_pct,
            current_width: Number(currentWidth.toFixed(6)),
            previous_width: Number(previousWidth.toFixed(6))
          }
        });
      }
    }
  }

  // ── T-P50: Forecast level shift ────────────────────────────────────────────
  if (Array.isArray(prevSeries) && prevSeries.length > 0 && currentSeries.length > 0) {
    const currentP50 = aggregateP50(currentSeries);
    const previousP50 = aggregateP50(prevSeries);

    if (previousP50 > 0) {
      const shiftPct = (currentP50 - previousP50) / previousP50;
      if (Math.abs(shiftPct) > config.p50_shift_pct) {
        reasons.push({
          trigger_type: TRIGGER_TYPES.P50_SHIFT,
          severity: Math.abs(shiftPct) > 2 * config.p50_shift_pct ? 'high' : 'medium',
          detail: `P50 forecast shifted ${(shiftPct * 100).toFixed(1)}% (threshold: ` +
                  `${(config.p50_shift_pct * 100).toFixed(1)}%)`,
          evidence: {
            shift_pct: Number(shiftPct.toFixed(6)),
            threshold: config.p50_shift_pct,
            current_p50: Number(currentP50.toFixed(6)),
            previous_p50: Number(previousP50.toFixed(6))
          }
        });
      }
    }
  }

  // ── T-RISK: Risk severity crosses threshold ────────────────────────────────
  const riskScores = riskBundle?.riskScores || riskBundle?.risk_scores || [];
  if (Array.isArray(riskScores)) {
    const aboveThreshold = riskScores.filter(
      (e) => toNumber(e.risk_score, 0) > config.risk_severity_trigger
    );
    if (aboveThreshold.length > 0) {
      const maxScore = Math.max(...aboveThreshold.map((e) => toNumber(e.risk_score, 0)));
      reasons.push({
        trigger_type: TRIGGER_TYPES.RISK_SEVERITY_CROSSED,
        severity: maxScore > 2 * config.risk_severity_trigger ? 'high' : 'medium',
        detail: `${aboveThreshold.length} entity(ies) with risk_score > ${config.risk_severity_trigger} ` +
                `(max: ${maxScore.toFixed(2)})`,
        evidence: {
          entities_above_threshold: aboveThreshold.length,
          max_risk_score: maxScore,
          threshold: config.risk_severity_trigger
        }
      });
    }
  }

  // ── Cooldown / dedupe check ─────────────────────────────────────────────────
  // Build a composite dedupe key using all trigger types that fired
  const firedTypes = [...new Set(reasons.map((r) => r.trigger_type))].sort();
  const compositeType = firedTypes.length > 0 ? firedTypes.join('+') : 'none';
  const dedupeKey = buildDedupeKey(dataset_id, compositeType, timeBucket, forecast_run_id);

  let cooldownActive = false;
  let suppressedByCooldown = false;

  const manager = cooldownManager || getDefaultCooldownManager();
  if (reasons.length > 0) {
    const cooldownCheck = manager.check(dedupeKey);
    if (cooldownCheck.active) {
      cooldownActive = true;
      suppressedByCooldown = true;
    }
  }

  return {
    should_trigger: reasons.length > 0 && !suppressedByCooldown,
    reasons,
    dedupe_key: dedupeKey,
    cooldown_active: cooldownActive,
    suppressed_by_cooldown: suppressedByCooldown,
    evaluated_at: evaluatedAt
  };
}
