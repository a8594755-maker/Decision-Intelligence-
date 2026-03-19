/**
 * kpiMonitorService.js — KPI Monitor Daemon
 *
 * Periodically evaluates kpi_watch_rules against data and writes
 * breaches to event_queue for automatic task creation.
 *
 * Design:
 *   - JS-based (runs in same process as frontend dev server or standalone)
 *   - Polls kpi_watch_rules every N seconds
 *   - For each due rule: evaluate metric → check threshold → write breach + event
 *   - Cooldown enforcement prevents alert storms
 *   - All metric evaluation is via pure functions from metricEvaluators.js
 *
 * @module services/kpiMonitor/kpiMonitorService
 */

import { supabase } from '../supabaseClient.js';
import { getEvaluator, checkThreshold } from './metricEvaluators.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute
const KPI_EVENT_PREFIX = 'kpi_breach';

// ── Monitor state ────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;
let _stats = { polls: 0, breaches: 0, errors: 0, lastPollAt: null };

// ── Data provider (injectable for testing) ───────────────────────────────────

let _dataProvider = null;

/**
 * Set the data provider function.
 * Signature: async (metricType, entityFilter) => rows[]
 *
 * @param {Function} fn
 */
export function setDataProvider(fn) {
  _dataProvider = fn;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the KPI monitor daemon.
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs] - Poll interval
 * @param {Function} [opts.dataProvider] - Data source function
 */
export function startMonitor(opts = {}) {
  if (_running) return;
  if (opts.dataProvider) _dataProvider = opts.dataProvider;
  const interval = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS;
  _running = true;
  _timer = setInterval(() => pollOnce().catch(console.error), interval);
  // Run immediately
  pollOnce().catch(console.error);
}

/**
 * Stop the KPI monitor daemon.
 */
export function stopMonitor() {
  _running = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Get monitor status.
 */
export function getMonitorStatus() {
  return { running: _running, ..._stats };
}

/**
 * Single poll cycle — exported for testing.
 */
export async function pollOnce() {
  _stats.lastPollAt = new Date().toISOString();
  _stats.polls++;

  const rules = await fetchDueRules();
  if (rules.length === 0) return;

  for (const rule of rules) {
    try {
      await evaluateRule(rule);
    } catch (err) {
      _stats.errors++;
      console.warn(`[KpiMonitor] Rule ${rule.id} (${rule.name}) failed:`, err.message);
    }
  }
}

/**
 * Evaluate a single rule — exported for testing and ad-hoc checks.
 *
 * @param {Object} rule - kpi_watch_rules row
 * @param {Object[]} [dataOverride] - override data rows (for testing)
 * @returns {{ breached: boolean, value: number|null, reason: string, breach_id?: string }}
 */
export async function evaluateRule(rule, dataOverride = null) {
  const evaluator = getEvaluator(rule.metric_type);
  if (!evaluator) {
    return { breached: false, value: null, reason: `Unknown metric type: ${rule.metric_type}` };
  }

  // Get data
  const rows = dataOverride || (
    _dataProvider ? await _dataProvider(rule.metric_type, rule.entity_filter) : []
  );

  // Evaluate metric
  const result = evaluator(rows, rule.entity_filter || {});
  if (result.value === null) {
    return { breached: false, value: null, reason: 'No data available for evaluation' };
  }

  // Check threshold
  const threshold = checkThreshold(
    result.value, rule.threshold_type, rule.threshold_value, rule.threshold_upper
  );

  // Update last_checked_at
  await updateRuleCheckedAt(rule.id);

  if (!threshold.breached) {
    return { breached: false, value: result.value, reason: threshold.reason };
  }

  // Check cooldown
  if (await isInCooldown(rule)) {
    return { breached: true, value: result.value, reason: `Breach detected but in cooldown: ${threshold.reason}` };
  }

  // Record breach
  const breachId = await recordBreach(rule, result.value, threshold.reason);

  // Write to event_queue
  const eventId = await writeBreachEvent(rule, result, threshold.reason);

  // Update last_breached_at
  await updateRuleBreachedAt(rule.id);

  _stats.breaches++;

  // Link event to breach
  if (breachId && eventId) {
    await linkBreachToEvent(breachId, eventId);
  }

  return { breached: true, value: result.value, reason: threshold.reason, breach_id: breachId };
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function fetchDueRules() {
  const { data, error } = await supabase
    .from('kpi_watch_rules')
    .select('*')
    .eq('enabled', true)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch KPI rules: ${error.message}`);

  const now = Date.now();
  return (data || []).filter(rule => {
    if (!rule.last_checked_at) return true;
    const elapsed = now - new Date(rule.last_checked_at).getTime();
    return elapsed >= (rule.check_interval_minutes || 60) * 60_000;
  });
}

async function isInCooldown(rule) {
  if (!rule.last_breached_at || !rule.cooldown_minutes) return false;
  const elapsed = Date.now() - new Date(rule.last_breached_at).getTime();
  return elapsed < rule.cooldown_minutes * 60_000;
}

async function updateRuleCheckedAt(ruleId) {
  await supabase
    .from('kpi_watch_rules')
    .update({ last_checked_at: new Date().toISOString() })
    .eq('id', ruleId);
}

async function updateRuleBreachedAt(ruleId) {
  await supabase
    .from('kpi_watch_rules')
    .update({ last_breached_at: new Date().toISOString() })
    .eq('id', ruleId);
}

async function recordBreach(rule, metricValue, _reason) {
  const { data, error } = await supabase
    .from('kpi_breach_log')
    .insert({
      rule_id: rule.id,
      metric_type: rule.metric_type,
      metric_value: metricValue,
      threshold_value: rule.threshold_value,
      threshold_type: rule.threshold_type,
      severity: rule.severity,
      entity_filter: rule.entity_filter || {},
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[KpiMonitor] Failed to log breach:', error.message);
    return null;
  }
  return data.id;
}

async function writeBreachEvent(rule, metricResult, reason) {
  const { data, error } = await supabase
    .from('event_queue')
    .insert({
      event_type: `${KPI_EVENT_PREFIX}.${rule.metric_type}`,
      source_system: 'kpi_monitor',
      payload: {
        rule_id: rule.id,
        rule_name: rule.name,
        metric_type: rule.metric_type,
        metric_value: metricResult.value,
        metric_detail: metricResult.detail,
        threshold_type: rule.threshold_type,
        threshold_value: rule.threshold_value,
        severity: rule.severity,
        entity_filter: rule.entity_filter,
        reason,
      },
      status: 'pending',
      worker_id: rule.worker_id,
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[KpiMonitor] Failed to write breach event:', error.message);
    return null;
  }
  return data.id;
}

async function linkBreachToEvent(breachId, eventId) {
  await supabase
    .from('kpi_breach_log')
    .update({ event_id: eventId })
    .eq('id', breachId);
}
