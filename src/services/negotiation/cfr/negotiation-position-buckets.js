/**
 * Negotiation Position Bucketing — Map live platform signals to 5 strength levels.
 *
 * Input:  risk_score from riskAdjustmentsService.js (0–200 range)
 * Output: Position bucket 0–4 (VERY_WEAK → VERY_STRONG)
 *
 * Bucketing:  bucket = min(4, floor((200 - risk_score) / 40))
 *   risk 0-39   → VERY_STRONG(4)  — buyer has maximum leverage
 *   risk 40-79  → STRONG(3)       — favorable position
 *   risk 80-119 → NEUTRAL(2)      — balanced negotiation
 *   risk 120-159→ WEAK(1)         — supplier has advantage
 *   risk 160+   → VERY_WEAK(0)    — buyer has minimal leverage
 */

import {
  POSITION_BUCKETS,
  POSITION_BUCKET_NAMES,
  NUM_POSITION_BUCKETS,
} from './negotiation-types.js';

// ---------------------------------------------------------------------------
// Core bucketing
// ---------------------------------------------------------------------------

/**
 * Convert a risk_score (0–200) to a position strength bucket (0–4).
 *
 * Higher risk_score = weaker buyer position (more supply risk).
 * Inverted mapping: low risk → high strength.
 *
 * @param {number} riskScore - Risk score from riskAdjustmentsService (0–200)
 * @returns {number} Position bucket (0=VERY_WEAK, 4=VERY_STRONG)
 */
export function riskScoreToBucket(riskScore) {
  if (riskScore === null || riskScore === undefined) return POSITION_BUCKETS.NEUTRAL;
  const score = Number(riskScore);
  if (!Number.isFinite(score)) return POSITION_BUCKETS.NEUTRAL;

  const clamped = Math.max(0, Math.min(200, score));
  return Math.max(0, Math.floor((199 - clamped) / 40));
}

/**
 * Get the human-readable name for a position bucket.
 *
 * @param {number} bucket - 0–4
 * @returns {string} e.g., 'STRONG'
 */
export function bucketName(bucket) {
  return POSITION_BUCKET_NAMES[bucket] || 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Extended bucketing (future: multi-signal)
// ---------------------------------------------------------------------------

/**
 * Compute position bucket from multiple signals (extensible).
 *
 * Currently uses risk_score only. Future dimensions:
 * - urgency (days until stockout)
 * - BATNA quality (alternative supplier availability)
 * - budget flexibility (% budget remaining)
 *
 * @param {Object} signals
 * @param {number} signals.risk_score - from riskAdjustmentsService (0–200)
 * @param {number} [signals.urgency_days] - days until stockout (future)
 * @param {number} [signals.batna_score] - alternative supplier score (future)
 * @param {number} [signals.budget_remaining_pct] - % budget remaining (future)
 * @returns {{ bucket: number, name: string, signals_used: string[] }}
 */
export function computePositionBucket(signals = {}) {
  const signalsUsed = [];

  // Primary signal: risk_score
  let bucket = POSITION_BUCKETS.NEUTRAL;
  if (Number.isFinite(Number(signals.risk_score))) {
    bucket = riskScoreToBucket(signals.risk_score);
    signalsUsed.push('risk_score');
  }

  return {
    bucket,
    name: bucketName(bucket),
    signals_used: signalsUsed,
  };
}

export default {
  riskScoreToBucket,
  bucketName,
  computePositionBucket,
};
