import { supabase } from '../infra/supabaseClient';

/**
 * Audit Service - Centralized audit event logging
 * M7.3 WP3: Audit Trail and Replay
 * 
 * Payload Schema (MVP):
 * {
 *   entity: { type: 'bom_run|forecast_run|what_if_run', id: 'uuid' },
 *   inputs: { demand_source, inbound_source, seed, trials, action },
 *   outputs: { kpis, row_counts, top_key },
 *   perf: { fetchMs, computeMs, saveMs },
 *   version: { engine, schema }
 * }
 */

const VERSION = {
  engine: '1.0.0',
  schema: '2026-02-07'
};

/**
 * Log an audit event
 * Called AFTER main flow succeeds; failures are caught and logged to console only
 * 
 * @param {string} userId - User ID
 * @param {Object} params - Event parameters
 * @param {string} params.eventType - inventory_prob_ran | risk_score_calculated | what_if_executed
 * @param {string} [params.correlationId] - UUID to chain related events
 * @param {string} [params.entityType] - bom_run | forecast_run | what_if_run
 * @param {string} [params.entityId] - Entity UUID
 * @param {string} [params.bomRunId] - BOM run UUID
 * @param {string} [params.key] - MATERIAL|PLANT format
 * @param {Object} params.payload - Event payload following MVP schema
 * @returns {Promise<{success: boolean, eventId: string|null}>}
 */
export async function logEvent(userId, {
  eventType,
  correlationId = null,
  entityType = null,
  entityId = null,
  bomRunId = null,
  key = null,
  payload = {}
}) {
  try {
    // Ensure payload has version info
    const enrichedPayload = {
      ...payload,
      version: payload.version || VERSION
    };

    const { data, error } = await supabase
      .from('audit_events')
      .insert({
        user_id: userId,
        event_type: eventType,
        correlation_id: correlationId,
        entity_type: entityType,
        entity_id: entityId,
        bom_run_id: bomRunId,
        key: key,
        payload: enrichedPayload,
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error) {
      console.warn('[Audit] Failed to log event:', error);
      return { success: false, eventId: null };
    }

    return { success: true, eventId: data.id };
  } catch (err) {
    // Audit failures must not break main flow
    console.warn('[Audit] Exception logging event:', err);
    return { success: false, eventId: null };
  }
}

/**
 * List audit events for a user with optional filters
 * 
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @param {string} [options.bomRunId] - Filter by BOM run
 * @param {string} [options.key] - Filter by key (MATERIAL|PLANT)
 * @param {string} [options.entityType] - Filter by entity type
 * @param {string} [options.eventType] - Filter by event type
 * @param {number} [options.limit=100] - Max results
 * @param {number} [options.offset=0] - Pagination offset
 * @returns {Promise<{success: boolean, events: Array, count: number}>}
 */
export async function listEvents(userId, {
  bomRunId = null,
  key = null,
  entityType = null,
  eventType = null,
  limit = 100,
  offset = 0
} = {}) {
  try {
    let query = supabase
      .from('audit_events')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (bomRunId) {
      query = query.eq('bom_run_id', bomRunId);
    }

    if (key) {
      query = query.eq('key', key);
    }

    if (entityType) {
      query = query.eq('entity_type', entityType);
    }

    if (eventType) {
      query = query.eq('event_type', eventType);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[Audit] Failed to list events:', error);
      return { success: false, events: [], count: 0 };
    }

    return { success: true, events: data || [], count: count || 0 };
  } catch (err) {
    console.error('[Audit] Exception listing events:', err);
    return { success: false, events: [], count: 0 };
  }
}

/**
 * Get a single audit event by ID
 * 
 * @param {string} userId - User ID
 * @param {string} eventId - Event UUID
 * @returns {Promise<{success: boolean, event: Object|null}>}
 */
export async function getEvent(userId, eventId) {
  try {
    const { data, error } = await supabase
      .from('audit_events')
      .select('*')
      .eq('id', eventId)
      .eq('user_id', userId) // RLS enforcement
      .single();

    if (error) {
      console.error('[Audit] Failed to get event:', error);
      return { success: false, event: null };
    }

    return { success: true, event: data };
  } catch (err) {
    console.error('[Audit] Exception getting event:', err);
    return { success: false, event: null };
  }
}

/**
 * Helper to build standard payload structure
 * 
 * @param {Object} params
 * @param {Object} params.entity - { type, id }
 * @param {Object} params.inputs - Input parameters
 * @param {Object} params.outputs - Output results/KPIs
 * @param {Object} params.perf - Performance metrics
 * @returns {Object} Standardized payload
 */
export function buildPayload({ entity, inputs, outputs, perf }) {
  return {
    entity,
    inputs,
    outputs,
    perf,
    version: VERSION
  };
}

// Event type constants
export const EVENT_TYPES = {
  INVENTORY_PROB_RAN: 'inventory_prob_ran',
  RISK_SCORE_CALCULATED: 'risk_score_calculated',
  WHAT_IF_EXECUTED: 'what_if_executed',
  COST_FORECAST_RAN: 'cost_forecast_ran',
  REVENUE_FORECAST_RAN: 'revenue_forecast_ran'
};

// Entity type constants
export const ENTITY_TYPES = {
  BOM_RUN: 'bom_run',
  FORECAST_RUN: 'forecast_run',
  WHAT_IF_RUN: 'what_if_run'
};
