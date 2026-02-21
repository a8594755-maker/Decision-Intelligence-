/**
 * poDelayProbability.js
 *
 * Time-aware PO delay probability model (Module E core).
 *
 * Design principles:
 *   1. Pure functions — no side effects, testable, deterministic
 *   2. Input = supplier historical stats + single PO due-date context
 *   3. Output = p_late in [0, 1] with computation path explanation
 *
 * Model stages:
 *   Stage 1 — Sufficient history (sample_size >= MIN_SAMPLE):
 *     p_base = 1 - on_time_rate
 *     urgency_factor = f(days_until_due) → closer to due → higher prob
 *     overdue_factor = g(overdue_ratio)
 *     p_late = clamp(p_base * urgency + excess_delay + overdue_contrib, 0.01, 0.99)
 *
 *   Stage 2 — Insufficient history (fallback):
 *     p_late = FALLBACK_P_LATE (default 0.30)
 *
 *   Stage 3 — PO already overdue (days_until_due < 0):
 *     p_late = max(p_base + overdue_contrib, OVERDUE_FLOOR)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const DELAY_PROB_CONFIG = {
  MIN_SAMPLE_SIZE: 3,
  FALLBACK_P_LATE: 0.30,
  // Urgency decay: urgency_factor = exp(URGENCY_K / max(days_until_due, 1))
  URGENCY_K: 8.0,
  OVERDUE_FLOOR: 0.75,
  P_LATE_MIN: 0.01,
  P_LATE_MAX: 0.99,
  HIGH_RISK_P_LATE_THRESHOLD: 0.50,
  CRITICAL_RISK_P_LATE_THRESHOLD: 0.75,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const clamp = (val, min, max) => Math.min(max, Math.max(min, val));
const toNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Days until the PO is due. Positive = not yet due; negative = overdue.
 */
export function daysUntilDue(promisedDate, nowDate) {
  if (!promisedDate) return null;
  const due = new Date(promisedDate);
  const now = new Date(nowDate || new Date());
  if (isNaN(due.getTime()) || isNaN(now.getTime())) return null;
  return Math.round((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Urgency factor: exponential amplifier based on days remaining.
 * Formula: exp(URGENCY_K / max(days, 1))
 * Only computed when days > 0; overdue POs use the overdue floor instead.
 */
export function computeUrgencyFactor(daysUntilDue, config = DELAY_PROB_CONFIG) {
  if (daysUntilDue == null || daysUntilDue <= 0) return 1.0;
  return Math.exp(config.URGENCY_K / Math.max(daysUntilDue, 1));
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Compute delay probability for a single PO.
 *
 * @param {Object} params
 * @param {Object} params.supplierStats - from buildSupplierStats()
 *   { on_time_rate, lead_time_p50_days, lead_time_p90_days, sample_size, metrics }
 * @param {Object|null} params.riskEntity - from computeRiskScores()
 *   { risk_score, metrics: { p90_delay_days, overdue_ratio, ... } }
 * @param {string|Date} params.promisedDate
 * @param {string|Date} params.nowDate
 * @param {Object} params.config - overrides for DELAY_PROB_CONFIG
 *
 * @returns {Object} { p_late, p_late_p90, model_used, urgency_factor,
 *   days_until_due, evidence_refs[], is_overdue, risk_tier, sample_size }
 */
export function computePODelayProbability({
  supplierStats = {},
  riskEntity = null,
  promisedDate = null,
  nowDate = null,
  config: configOverrides = {},
} = {}) {
  const config = { ...DELAY_PROB_CONFIG, ...configOverrides };

  const now = nowDate || new Date();
  const days = daysUntilDue(promisedDate, now);
  const isOverdue = days !== null && days < 0;

  const sampleSize = toNum(supplierStats.sample_size, 0);
  const onTimeRate = toNum(supplierStats.on_time_rate, null);
  const hasSufficientHistory = sampleSize >= config.MIN_SAMPLE_SIZE
    && onTimeRate !== null
    && !supplierStats.metrics?.fallback_used;

  // ── Stage 2: fallback prior ───────────────────────────────────────────────
  if (!hasSufficientHistory) {
    return {
      p_late: config.FALLBACK_P_LATE,
      p_late_p90: Math.min(config.FALLBACK_P_LATE * 1.5, 0.95),
      model_used: 'fallback_prior',
      urgency_factor: null,
      days_until_due: days,
      is_overdue: isOverdue,
      risk_tier: config.FALLBACK_P_LATE >= config.HIGH_RISK_P_LATE_THRESHOLD ? 'high' : 'medium',
      evidence_refs: [
        `fallback_reason=${supplierStats.metrics?.fallback_reason || 'insufficient_sample'}`,
        `sample_size=${sampleSize}`,
      ],
      sample_size: sampleSize,
    };
  }

  // ── Stage 3: PO already overdue ───────────────────────────────────────────
  if (isOverdue) {
    const p_base = 1 - onTimeRate;
    const overdueRatio = toNum(riskEntity?.metrics?.overdue_ratio, 0);
    const p_late = clamp(
      Math.max(p_base + overdueRatio * 0.3, config.OVERDUE_FLOOR),
      config.P_LATE_MIN,
      config.P_LATE_MAX,
    );

    return {
      p_late,
      p_late_p90: clamp(p_late + 0.1, 0, config.P_LATE_MAX),
      model_used: 'overdue_floor',
      urgency_factor: null,
      days_until_due: days,
      is_overdue: true,
      risk_tier: p_late >= config.CRITICAL_RISK_P_LATE_THRESHOLD ? 'critical' : 'high',
      evidence_refs: [
        `days_past_due=${Math.abs(days)}`,
        `p_base=${p_base.toFixed(4)}`,
        `overdue_ratio=${overdueRatio.toFixed(4)}`,
        `overdue_floor=${config.OVERDUE_FLOOR}`,
      ],
      sample_size: sampleSize,
    };
  }

  // ── Stage 1: time-aware model ─────────────────────────────────────────────
  const p_base = 1 - onTimeRate;
  const urgencyFactor = computeUrgencyFactor(days, config);
  const p90DelayDays = toNum(riskEntity?.metrics?.p90_delay_days, 0);
  const overdueRatio = toNum(riskEntity?.metrics?.overdue_ratio, 0);
  const riskScore = toNum(riskEntity?.risk_score, 0);

  // excess_delay_signal: p90 delay relative to lead time variance
  const leadTimeP50 = toNum(supplierStats.lead_time_p50_days, 0);
  const leadTimeP90 = toNum(supplierStats.lead_time_p90_days, leadTimeP50 * 1.3);
  const leadTimeVariance = Math.max(leadTimeP90 - leadTimeP50, 1);
  const excessDelaySignal = p90DelayDays > 0
    ? clamp(p90DelayDays / leadTimeVariance, 0, 1.5)
    : 0;

  // Overdue ratio linear penalty
  const overdueContrib = overdueRatio > 0
    ? clamp(overdueRatio * 0.4, 0, 0.3)
    : 0;

  // Main p_late: urgency-amplified base + excess delay + overdue contribution
  const p_late_raw = p_base * urgencyFactor + excessDelaySignal * 0.15 + overdueContrib;
  const p_late = clamp(p_late_raw, config.P_LATE_MIN, config.P_LATE_MAX);

  // p_late_p90: pessimistic scenario with risk_score contribution
  const riskNorm = riskScore > 0 ? clamp(riskScore / 100, 0, 1) : 0;
  const p_late_p90 = clamp(p_late + riskNorm * 0.15, config.P_LATE_MIN, config.P_LATE_MAX);

  let riskTier;
  if (p_late >= config.CRITICAL_RISK_P_LATE_THRESHOLD) {
    riskTier = 'critical';
  } else if (p_late >= config.HIGH_RISK_P_LATE_THRESHOLD) {
    riskTier = 'high';
  } else if (p_late >= 0.25) {
    riskTier = 'medium';
  } else {
    riskTier = 'low';
  }

  return {
    p_late,
    p_late_p90,
    model_used: 'time_aware_v1',
    urgency_factor: urgencyFactor,
    days_until_due: days,
    is_overdue: false,
    risk_tier: riskTier,
    evidence_refs: [
      `p_base=${p_base.toFixed(4)}`,
      `urgency_factor=${urgencyFactor.toFixed(4)}`,
      `days_until_due=${days}`,
      `excess_delay_signal=${excessDelaySignal.toFixed(4)}`,
      `overdue_contrib=${overdueContrib.toFixed(4)}`,
      `on_time_rate=${onTimeRate.toFixed(4)}`,
      `sample_size=${sampleSize}`,
    ],
    sample_size: sampleSize,
  };
}

// ── Batch computation ─────────────────────────────────────────────────────────

/**
 * Batch-compute delay probabilities for a set of PO open lines.
 *
 * @param {Object} params
 * @param {Array} params.poOpenLines - PO open lines (need: promised_date, supplier_id, material_code, plant_id)
 * @param {Array} params.supplierStats - from buildSupplierStats()
 * @param {Array} params.riskScores - from computeRiskScores()
 * @param {string|Date} params.nowDate
 * @param {Object} params.config
 *
 * @returns {Object} { po_delay_signals[], high_risk_pos[], critical_risk_pos[], summary }
 */
export function batchComputePODelayProbabilities({
  poOpenLines = [],
  supplierStats = [],
  riskScores = [],
  nowDate = null,
  config = {},
} = {}) {
  const effectiveConfig = { ...DELAY_PROB_CONFIG, ...config };

  // Build supplier stats lookup
  const supplierStatsMap = new Map();
  supplierStats.forEach((s) => {
    const key1 = `${s.supplier_id}|${s.plant_id || ''}`;
    const key2 = String(s.supplier_id || '');
    if (!supplierStatsMap.has(key1)) supplierStatsMap.set(key1, s);
    if (!supplierStatsMap.has(key2)) supplierStatsMap.set(key2, s);
  });

  // Build risk entity lookup (prioritize supplier_material > material > supplier)
  const riskEntityMap = new Map();
  const riskPriority = { supplier_material: 3, material: 2, supplier: 1 };

  riskScores.forEach((entity) => {
    const matCode = String(entity.material_code || '').trim();
    const plantId = String(entity.plant_id || '').trim();
    const supplier = String(entity.supplier || '').trim();
    const priority = riskPriority[entity.entity_type] || 0;

    const keys = [
      `mat:${matCode}|plant:${plantId}`,
      `mat:${matCode}`,
      `sup:${supplier}|mat:${matCode}`,
    ];

    keys.forEach((key) => {
      const existing = riskEntityMap.get(key);
      if (!existing || (riskPriority[existing.entity_type] || 0) < priority) {
        riskEntityMap.set(key, entity);
      }
    });
  });

  const findRiskEntity = (materialCode, plantId) => {
    const mat = String(materialCode || '').trim();
    const plant = String(plantId || '').trim();
    return (
      riskEntityMap.get(`mat:${mat}|plant:${plant}`) ||
      riskEntityMap.get(`mat:${mat}`) ||
      null
    );
  };

  const findSupplierStats = (supplierId, plantId) => {
    const sup = String(supplierId || '').trim();
    const plant = String(plantId || '').trim();
    return (
      supplierStatsMap.get(`${sup}|${plant}`) ||
      supplierStatsMap.get(sup) ||
      {
        supplier_id: sup,
        plant_id: plant,
        sample_size: 0,
        on_time_rate: 0.7,
        lead_time_p50_days: 14,
        lead_time_p90_days: 18,
        metrics: { fallback_used: true, fallback_reason: 'no_stats_found' },
      }
    );
  };

  // Compute per PO
  const poDelaySignals = poOpenLines.map((po) => {
    const stats = findSupplierStats(po.supplier_id || po.supplier, po.plant_id);
    const riskEntity = findRiskEntity(po.material_code, po.plant_id);

    const result = computePODelayProbability({
      supplierStats: stats,
      riskEntity,
      promisedDate: po.promised_date,
      nowDate,
      config: effectiveConfig,
    });

    return {
      po_id: po.po_id || po.id || null,
      po_line_id: po.po_line_id || null,
      supplier_id: po.supplier_id || po.supplier || null,
      material_code: po.material_code || null,
      plant_id: po.plant_id || null,
      open_qty: po.open_qty || 0,
      promised_date: po.promised_date || null,
      ...result,
    };
  });

  // Sort by p_late descending
  poDelaySignals.sort((a, b) => (b.p_late || 0) - (a.p_late || 0));

  const highRiskPos = poDelaySignals.filter(
    (s) => s.p_late >= effectiveConfig.HIGH_RISK_P_LATE_THRESHOLD,
  );
  const criticalRiskPos = poDelaySignals.filter(
    (s) => s.p_late >= effectiveConfig.CRITICAL_RISK_P_LATE_THRESHOLD,
  );

  return {
    po_delay_signals: poDelaySignals,
    high_risk_pos: highRiskPos,
    critical_risk_pos: criticalRiskPos,
    summary: {
      total_pos: poDelaySignals.length,
      high_risk_count: highRiskPos.length,
      critical_risk_count: criticalRiskPos.length,
      overdue_count: poDelaySignals.filter((s) => s.is_overdue).length,
      avg_p_late: poDelaySignals.length > 0
        ? poDelaySignals.reduce((sum, s) => sum + (s.p_late || 0), 0) / poDelaySignals.length
        : 0,
      fallback_count: poDelaySignals.filter((s) => s.model_used === 'fallback_prior').length,
      model_version: 'time_aware_v1',
    },
  };
}
