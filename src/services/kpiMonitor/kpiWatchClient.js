/**
 * kpiWatchClient.js — Frontend client for KPI watch rules CRUD + breach history.
 *
 * @module services/kpiMonitor/kpiWatchClient
 */

import { supabase } from '../supabaseClient.js';

// ── Watch Rules CRUD ────────────────────────────────────────────────────────

/**
 * List all KPI watch rules, optionally filtered.
 * @param {Object} [opts]
 * @param {boolean} [opts.enabledOnly]
 * @param {string} [opts.metricType]
 * @returns {Promise<Object[]>}
 */
export async function listWatchRules({ enabledOnly = false, metricType = null } = {}) {
  let query = supabase
    .from('kpi_watch_rules')
    .select('*')
    .order('created_at', { ascending: false });

  if (enabledOnly) query = query.eq('enabled', true);
  if (metricType) query = query.eq('metric_type', metricType);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list watch rules: ${error.message}`);
  return data || [];
}

/**
 * Get a single watch rule by ID.
 */
export async function getWatchRule(ruleId) {
  const { data, error } = await supabase
    .from('kpi_watch_rules')
    .select('*')
    .eq('id', ruleId)
    .single();

  if (error) throw new Error(`Failed to get watch rule: ${error.message}`);
  return data;
}

/**
 * Create a new watch rule.
 * @param {Object} rule
 * @returns {Promise<Object>}
 */
export async function createWatchRule(rule) {
  const { data, error } = await supabase
    .from('kpi_watch_rules')
    .insert({
      name: rule.name,
      metric_type: rule.metric_type,
      entity_filter: rule.entity_filter || {},
      threshold_type: rule.threshold_type || 'below',
      threshold_value: rule.threshold_value,
      threshold_upper: rule.threshold_upper || null,
      severity: rule.severity || 'medium',
      worker_id: rule.worker_id || null,
      check_interval_minutes: rule.check_interval_minutes || 60,
      cooldown_minutes: rule.cooldown_minutes || 240,
      enabled: rule.enabled !== false,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create watch rule: ${error.message}`);
  return data;
}

/**
 * Update an existing watch rule.
 */
export async function updateWatchRule(ruleId, updates) {
  const { data, error } = await supabase
    .from('kpi_watch_rules')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', ruleId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update watch rule: ${error.message}`);
  return data;
}

/**
 * Delete a watch rule.
 */
export async function deleteWatchRule(ruleId) {
  const { error } = await supabase
    .from('kpi_watch_rules')
    .delete()
    .eq('id', ruleId);

  if (error) throw new Error(`Failed to delete watch rule: ${error.message}`);
}

/**
 * Toggle a watch rule's enabled state.
 */
export async function toggleWatchRule(ruleId, enabled) {
  return updateWatchRule(ruleId, { enabled });
}

// ── Breach History ──────────────────────────────────────────────────────────

/**
 * List breach history, optionally filtered.
 * @param {Object} [opts]
 * @param {string} [opts.ruleId]
 * @param {boolean} [opts.unresolvedOnly]
 * @param {number} [opts.limit]
 * @returns {Promise<Object[]>}
 */
export async function listBreaches({ ruleId = null, unresolvedOnly = false, limit = 50 } = {}) {
  let query = supabase
    .from('kpi_breach_log')
    .select('*, kpi_watch_rules(name, metric_type)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (ruleId) query = query.eq('rule_id', ruleId);
  if (unresolvedOnly) query = query.eq('resolved', false);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list breaches: ${error.message}`);
  return data || [];
}

/**
 * Mark a breach as resolved.
 */
export async function resolveBreach(breachId) {
  const { data, error } = await supabase
    .from('kpi_breach_log')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('id', breachId)
    .select()
    .single();

  if (error) throw new Error(`Failed to resolve breach: ${error.message}`);
  return data;
}

/**
 * Get breach statistics.
 * @returns {Promise<Object>}
 */
export async function getBreachStats() {
  const { data: all, error: e1 } = await supabase
    .from('kpi_breach_log')
    .select('severity, resolved', { count: 'exact' });

  if (e1) throw new Error(`Failed to get breach stats: ${e1.message}`);

  const rows = all || [];
  return {
    total: rows.length,
    unresolved: rows.filter(r => !r.resolved).length,
    by_severity: {
      critical: rows.filter(r => r.severity === 'critical').length,
      high: rows.filter(r => r.severity === 'high').length,
      medium: rows.filter(r => r.severity === 'medium').length,
      low: rows.filter(r => r.severity === 'low').length,
    },
  };
}

// ── Monitor status ──────────────────────────────────────────────────────────

/**
 * Get KPI monitor status from the service.
 */
export { getMonitorStatus } from './kpiMonitorService.js';
