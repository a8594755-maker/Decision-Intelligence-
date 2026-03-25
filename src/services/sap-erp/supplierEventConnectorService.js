/**
 * supplierEventConnectorService.js
 *
 * Real-time Supplier Event Connector — the "last mile" of the Sense layer.
 *
 * Receives supplier events from external systems (ERP, TMS, manual entry),
 * validates them, computes risk score deltas, and triggers the downstream
 * alert + closed-loop pipeline.
 *
 * Design:
 *   - All business logic lives in pure, deterministic functions (easy to test)
 *   - Async orchestrator wraps pure functions + downstream integration
 *   - Graceful degradation on all optional downstream calls
 *   - No auto-replan — produces recommendation cards for user approval
 */

import { safeValidateSupplierEvent } from '../../contracts/supplierEventContractV1';
import { evaluateRiskReplanRecommendation } from '../risk/riskClosedLoopService';

// ── Configuration ────────────────────────────────────────────────────────────

export const EVENT_CONNECTOR_CONFIG = {
  // Base risk score delta per event type
  risk_delta_weights: {
    delivery_delay:  { risk_score_delta: 15, p90_delay_days: 1.0, overdue_ratio: 0.1 },
    quality_alert:   { risk_score_delta: 20 },
    capacity_change: { risk_score_delta: 10 },
    force_majeure:   { risk_score_delta: 40, p90_delay_days: 1.0 },
    shipment_status: { risk_score_delta: 8, p90_delay_days: 0.5 },
    price_change:    { risk_score_delta: 5 },
  },

  severity_multiplier: {
    low:      0.5,
    medium:   1.0,
    high:     1.5,
    critical: 2.0,
  },

  // Dedup: ignore events with same event_id within this window
  dedup_window_ms: 60 * 60 * 1000, // 1 hour

  // Max events in a single batch
  max_batch_size: 100,

  // Minimum risk score delta to trigger alert re-evaluation
  min_delta_for_alert_trigger: 5,

  // Minimum risk score delta to trigger replan evaluation
  min_delta_for_replan_trigger: 15,
};

// ── Dedup State ──────────────────────────────────────────────────────────────

const _seenEvents = new Map(); // event_id → received_at_ms

function isDuplicate(eventId, windowMs) {
  const now = Date.now();
  const lastSeen = _seenEvents.get(eventId);
  if (lastSeen && (now - lastSeen) < windowMs) return true;
  _seenEvents.set(eventId, now);
  // Cleanup old entries
  for (const [key, ts] of _seenEvents) {
    if (now - ts > windowMs * 2) _seenEvents.delete(key);
  }
  return false;
}

// ── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Validate and normalize a raw supplier event.
 *
 * @param {Object} rawEvent
 * @returns {{ valid: boolean, event: Object|null, error: string|null }}
 */
export function normalizeSupplierEvent(rawEvent) {
  const result = safeValidateSupplierEvent(rawEvent);
  if (!result.success) {
    return { valid: false, event: null, error: result.error };
  }

  const event = { ...result.data };

  // Normalize material_code to uppercase
  if (event.material_code) {
    event.material_code = String(event.material_code).toUpperCase().trim();
  }

  // Normalize plant_id to uppercase
  if (event.plant_id) {
    event.plant_id = String(event.plant_id).toUpperCase().trim();
  }

  // Normalize supplier_id
  event.supplier_id = String(event.supplier_id).trim();

  return { valid: true, event, error: null };
}

/**
 * Compute risk score delta from a validated supplier event.
 * Pure function: same input always produces same output.
 *
 * @param {Object} event  - Normalized supplier event
 * @param {Object} config - EVENT_CONNECTOR_CONFIG
 * @returns {{
 *   material_code: string|null,
 *   plant_id: string|null,
 *   supplier_id: string,
 *   risk_score_delta: number,
 *   metrics_delta: { p90_delay_days: number|null, overdue_ratio: number|null },
 *   evidence_refs: string[],
 * }}
 */
export function computeRiskDelta(event, config = EVENT_CONNECTOR_CONFIG) {
  const weights = config.risk_delta_weights[event.event_type];
  if (!weights) {
    return {
      material_code: event.material_code || null,
      plant_id: event.plant_id || null,
      supplier_id: event.supplier_id,
      risk_score_delta: 0,
      metrics_delta: { p90_delay_days: null, overdue_ratio: null },
      evidence_refs: [`event_type=${event.event_type}`, 'unknown_event_type'],
    };
  }

  const severityMult = config.severity_multiplier[event.severity] ?? 1.0;
  const details = event.details || {};
  const evidenceRefs = [`event_type=${event.event_type}`, `severity=${event.severity}`, `event_id=${event.event_id}`];

  let baseDelta = weights.risk_score_delta;
  let p90DeltaDays = null;
  let overdueDelta = null;

  switch (event.event_type) {
    case 'delivery_delay': {
      const delayDays = Number(details.delay_days) || 0;
      // Scale by delay magnitude, cap at 3× base
      baseDelta *= Math.min(delayDays / 7, 3);
      p90DeltaDays = delayDays;
      overdueDelta = weights.overdue_ratio || 0;
      evidenceRefs.push(`delay_days=${delayDays}`);
      break;
    }

    case 'quality_alert': {
      const defectPct = Number(details.defect_rate_pct) || 0;
      baseDelta *= defectPct / 10;
      evidenceRefs.push(`defect_rate_pct=${defectPct}`);
      break;
    }

    case 'capacity_change': {
      const prevCap = Number(details.previous_capacity_pct) || 100;
      const newCap = Number(details.new_capacity_pct) || 100;
      const reduction = Math.max(0, (prevCap - newCap) / 100);
      baseDelta *= reduction > 0 ? reduction : 0;
      evidenceRefs.push(`capacity_reduction=${Math.round(reduction * 100)}%`);
      break;
    }

    case 'force_majeure': {
      // Flat high impact — always severe
      const estDays = Number(details.estimated_duration_days) || 14;
      p90DeltaDays = estDays;
      evidenceRefs.push(`est_duration_days=${estDays}`, `category=${details.event_category || 'unknown'}`);
      break;
    }

    case 'shipment_status': {
      const status = details.status;
      // Only increase risk for negative statuses
      if (!['delayed', 'customs_hold', 'lost'].includes(status)) {
        baseDelta = 0;
      }
      if (status === 'lost') baseDelta *= 3;
      evidenceRefs.push(`shipment_status=${status}`);
      break;
    }

    case 'price_change': {
      const oldPrice = Number(details.old_unit_price) || 0;
      const newPrice = Number(details.new_unit_price) || 0;
      const pctChange = oldPrice > 0 ? Math.abs(newPrice - oldPrice) / oldPrice : 0;
      baseDelta *= pctChange / 0.1; // 10% change = 1× base
      evidenceRefs.push(`price_change_pct=${Math.round(pctChange * 100)}%`);
      break;
    }
  }

  const riskScoreDelta = Math.round(baseDelta * severityMult * 10) / 10;

  return {
    material_code: event.material_code || null,
    plant_id: event.plant_id || null,
    supplier_id: event.supplier_id,
    risk_score_delta: riskScoreDelta,
    metrics_delta: {
      p90_delay_days: p90DeltaDays,
      overdue_ratio: overdueDelta,
    },
    evidence_refs: evidenceRefs,
  };
}

/**
 * Apply a risk delta to an existing risk scores array.
 * Returns a new array (does not mutate input).
 *
 * @param {Array}  riskScores - Current risk_scores (Workflow B format)
 * @param {Object} riskDelta  - Output of computeRiskDelta
 * @returns {Array} Updated risk scores
 */
export function applyRiskDeltaToScores(riskScores, riskDelta) {
  if (!riskDelta || riskDelta.risk_score_delta === 0) return [...(riskScores || [])];

  const scores = (riskScores || []).map((s) => ({ ...s }));
  const matCode = riskDelta.material_code;
  const plantId = riskDelta.plant_id;

  // Find matching entry
  const idx = scores.findIndex((s) => {
    const codeMatch = matCode
      ? (s.material_code === matCode || s.sku === matCode)
      : true;
    const plantMatch = plantId
      ? (s.plant_id === plantId)
      : true;
    return codeMatch && plantMatch;
  });

  if (idx >= 0) {
    const existing = scores[idx];
    scores[idx] = {
      ...existing,
      risk_score: (Number(existing.risk_score ?? existing.riskScore ?? 0)) + riskDelta.risk_score_delta,
      metrics: {
        ...(existing.metrics || {}),
        ...(riskDelta.metrics_delta.p90_delay_days != null
          ? { p90_delay_days: (Number(existing.metrics?.p90_delay_days ?? 0)) + riskDelta.metrics_delta.p90_delay_days }
          : {}),
        ...(riskDelta.metrics_delta.overdue_ratio != null
          ? { overdue_ratio: Math.min(1, (Number(existing.metrics?.overdue_ratio ?? 0)) + riskDelta.metrics_delta.overdue_ratio) }
          : {}),
      },
      evidence_refs: [
        ...(existing.evidence_refs || []),
        ...riskDelta.evidence_refs,
      ],
    };
  } else if (matCode) {
    // Create new entry for unknown SKU
    scores.push({
      entity_type: 'supplier_material',
      entity_id: `${riskDelta.supplier_id}_${matCode}`,
      material_code: matCode,
      plant_id: plantId,
      supplier: riskDelta.supplier_id,
      risk_score: riskDelta.risk_score_delta,
      metrics: {
        p90_delay_days: riskDelta.metrics_delta.p90_delay_days ?? 0,
        overdue_ratio: riskDelta.metrics_delta.overdue_ratio ?? 0,
        on_time_rate: 0.8,
        avg_delay_days: 0,
      },
      drivers: [],
      evidence_refs: riskDelta.evidence_refs,
    });
  }

  return scores;
}

/**
 * Build a chat message for a supplier event notification.
 *
 * @param {Object} params
 * @param {Object} params.event                - Normalized event
 * @param {Object} params.riskDelta            - Computed risk delta
 * @param {Object} [params.replanRecommendation] - From riskClosedLoopService (or null)
 * @returns {Object} Chat message suitable for injection into conversation
 */
export function buildSupplierEventChatMessage({ event, riskDelta, replanRecommendation = null }) {
  return {
    role: 'system',
    type: 'supplier_event_card',
    payload: {
      event: {
        event_id: event.event_id,
        event_type: event.event_type,
        supplier_id: event.supplier_id,
        supplier_name: event.supplier_name || null,
        material_code: event.material_code || null,
        plant_id: event.plant_id || null,
        severity: event.severity,
        occurred_at: event.occurred_at,
        source_system: event.source_system,
        description: event.description || '',
      },
      risk_delta: riskDelta,
      replan_recommendation: replanRecommendation,
    },
    timestamp: new Date().toISOString(),
    is_proactive: true,
  };
}

// ── Async Orchestrator ───────────────────────────────────────────────────────

/**
 * Process a single supplier event end-to-end.
 *
 * @param {Object} params
 * @param {Object}   params.event           - Raw supplier event payload
 * @param {string}   params.userId
 * @param {string}   [params.conversationId]
 * @param {Object}   [params.alertMonitor]  - { evaluateNow } from createAlertMonitor
 * @param {Function} [params.loadRiskState] - async (userId) => { riskScores[], stockoutData[] }
 * @param {Object}   [params.config]        - Override EVENT_CONNECTOR_CONFIG
 * @returns {Promise<{
 *   accepted: boolean,
 *   event: Object|null,
 *   risk_delta: Object|null,
 *   alerts_triggered: boolean,
 *   replan_triggered: boolean,
 *   replan_recommendation: Object|null,
 *   error: string|null,
 * }>}
 */
export async function processSupplierEvent({
  event,
  userId,
  _conversationId,
  alertMonitor,
  loadRiskState,
  config = {},
}) {
  const cfg = { ...EVENT_CONNECTOR_CONFIG, ...config };

  // 1. Validate + normalize
  const normalized = normalizeSupplierEvent(event);
  if (!normalized.valid) {
    return {
      accepted: false,
      event: null,
      risk_delta: null,
      alerts_triggered: false,
      replan_triggered: false,
      replan_recommendation: null,
      error: normalized.error,
    };
  }

  // 2. Dedup check
  if (isDuplicate(normalized.event.event_id, cfg.dedup_window_ms)) {
    return {
      accepted: false,
      event: normalized.event,
      risk_delta: null,
      alerts_triggered: false,
      replan_triggered: false,
      replan_recommendation: null,
      error: `Duplicate event_id=${normalized.event.event_id} within dedup window`,
    };
  }

  // 3. Compute risk delta
  const riskDelta = computeRiskDelta(normalized.event, cfg);

  // 4. Persist to Supabase (best-effort, graceful degradation)
  try {
    const { supabase: sb } = await import('../infra/supabaseClient.js');
    if (sb) {
      await sb.from('supplier_events').insert({
        event_id: normalized.event.event_id,
        event_type: normalized.event.event_type,
        supplier_id: normalized.event.supplier_id,
        supplier_name: normalized.event.supplier_name || null,
        material_code: normalized.event.material_code || null,
        plant_id: normalized.event.plant_id || null,
        severity: normalized.event.severity,
        occurred_at: normalized.event.occurred_at,
        source_system: normalized.event.source_system,
        description: normalized.event.description || '',
        details_json: normalized.event.details || {},
        metadata_json: normalized.event.metadata || {},
        risk_score_delta: riskDelta.risk_score_delta,
        received_at: new Date().toISOString(),
        user_id: userId,
      });
    }
  } catch (e) {
    console.warn('[supplierEventConnector] Persist failed:', e?.message);
  }

  // 5. Trigger alert monitor re-evaluation
  let alertsTriggered = false;
  if (Math.abs(riskDelta.risk_score_delta) >= cfg.min_delta_for_alert_trigger && alertMonitor?.evaluateNow) {
    try {
      await alertMonitor.evaluateNow();
      alertsTriggered = true;
    } catch (e) {
      console.warn('[supplierEventConnector] Alert evaluation failed:', e?.message);
    }
  }

  // 6. Evaluate replan recommendation
  let replanRecommendation = null;
  let replanTriggered = false;
  if (Math.abs(riskDelta.risk_score_delta) >= cfg.min_delta_for_replan_trigger && loadRiskState) {
    try {
      const { riskScores = [] } = await loadRiskState(userId);
      const updatedScores = applyRiskDeltaToScores(riskScores, riskDelta);
      const replanResult = evaluateRiskReplanRecommendation({
        userId,
        datasetProfileId: null,
        riskRunId: `event_${normalized.event.event_id}`,
        riskScores: updatedScores,
      });
      if (replanResult.shouldReplan) {
        replanRecommendation = replanResult.recommendationCard;
        replanTriggered = true;
      }
    } catch (e) {
      console.warn('[supplierEventConnector] Replan evaluation failed:', e?.message);
    }
  }

  return {
    accepted: true,
    event: normalized.event,
    risk_delta: riskDelta,
    alerts_triggered: alertsTriggered,
    replan_triggered: replanTriggered,
    replan_recommendation: replanRecommendation,
    error: null,
  };
}

/**
 * Process a batch of supplier events.
 * Deduplicates, processes sequentially, triggers downstream evaluation
 * only ONCE at the end.
 *
 * @param {Object} params
 * @param {Array}    params.events
 * @param {string}   params.userId
 * @param {string}   [params.conversationId]
 * @param {Object}   [params.alertMonitor]
 * @param {Function} [params.loadRiskState]
 * @param {Object}   [params.config]
 * @returns {Promise<{
 *   accepted_count: number,
 *   rejected_count: number,
 *   results: Array,
 *   aggregated_risk_delta: number,
 *   alerts_triggered: boolean,
 *   replan_triggered: boolean,
 *   replan_recommendation: Object|null,
 * }>}
 */
export async function processSupplierEventBatch({
  events,
  userId,
  _conversationId,
  alertMonitor,
  loadRiskState,
  config = {},
}) {
  const cfg = { ...EVENT_CONNECTOR_CONFIG, ...config };
  const batchEvents = (events || []).slice(0, cfg.max_batch_size);

  const results = [];
  let aggregatedDelta = 0;
  const allDeltas = [];

  // Process each event without triggering downstream
  for (const rawEvent of batchEvents) {
    const normalized = normalizeSupplierEvent(rawEvent);
    if (!normalized.valid) {
      results.push({ accepted: false, event_id: rawEvent?.event_id, error: normalized.error });
      continue;
    }

    if (isDuplicate(normalized.event.event_id, cfg.dedup_window_ms)) {
      results.push({ accepted: false, event_id: normalized.event.event_id, error: 'duplicate' });
      continue;
    }

    const delta = computeRiskDelta(normalized.event, cfg);
    aggregatedDelta += delta.risk_score_delta;
    allDeltas.push(delta);
    results.push({ accepted: true, event_id: normalized.event.event_id, risk_score_delta: delta.risk_score_delta });
  }

  // Trigger downstream once at the end
  let alertsTriggered = false;
  let replanTriggered = false;
  let replanRecommendation = null;

  if (Math.abs(aggregatedDelta) >= cfg.min_delta_for_alert_trigger && alertMonitor?.evaluateNow) {
    try {
      await alertMonitor.evaluateNow();
      alertsTriggered = true;
    } catch (e) {
      console.warn('[supplierEventConnector] Batch alert evaluation failed:', e?.message);
    }
  }

  if (Math.abs(aggregatedDelta) >= cfg.min_delta_for_replan_trigger && loadRiskState) {
    try {
      const { riskScores = [] } = await loadRiskState(userId);
      let updatedScores = riskScores;
      for (const delta of allDeltas) {
        updatedScores = applyRiskDeltaToScores(updatedScores, delta);
      }
      const replanResult = evaluateRiskReplanRecommendation({
        userId,
        datasetProfileId: null,
        riskRunId: `event_batch_${Date.now()}`,
        riskScores: updatedScores,
      });
      if (replanResult.shouldReplan) {
        replanRecommendation = replanResult.recommendationCard;
        replanTriggered = true;
      }
    } catch (e) {
      console.warn('[supplierEventConnector] Batch replan evaluation failed:', e?.message);
    }
  }

  return {
    accepted_count: results.filter((r) => r.accepted).length,
    rejected_count: results.filter((r) => !r.accepted).length,
    results,
    aggregated_risk_delta: Math.round(aggregatedDelta * 10) / 10,
    alerts_triggered: alertsTriggered,
    replan_triggered: replanTriggered,
    replan_recommendation: replanRecommendation,
  };
}

/**
 * Clear the internal dedup cache. Useful for testing.
 */
export function clearEventDedup() {
  _seenEvents.clear();
}

export default {
  EVENT_CONNECTOR_CONFIG,
  normalizeSupplierEvent,
  computeRiskDelta,
  applyRiskDeltaToScores,
  buildSupplierEventChatMessage,
  processSupplierEvent,
  processSupplierEventBatch,
  clearEventDedup,
};
