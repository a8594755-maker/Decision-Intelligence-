/**
 * alertMonitorService.js
 *
 * Proactive alert monitoring loop for the SmartOps 2.0 Chat.
 * Periodically evaluates risk scores and supply chain state,
 * then pushes alerts into the active conversation.
 *
 * Two trigger modes:
 *   1. Polling: setInterval at configurable cadence (default 5 min)
 *   2. Event-driven: evaluateNow() called after workflow-B or data upload
 */

import { generateAlerts } from './proactiveAlertService';

// ── Configuration ────────────────────────────────────────────────────────────

export const ALERT_MONITOR_CONFIG = {
  polling_interval_ms: 5 * 60 * 1000,    // 5 minutes default
  min_interval_ms: 60 * 1000,            // floor: 1 minute
  max_alerts_per_push: 5,                // don't flood the chat
  dedup_window_ms: 30 * 60 * 1000,       // 30 min dedup per alert pattern
};

// ── Alert Monitor Factory ────────────────────────────────────────────────────

/**
 * Create an alert monitor instance.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {Function} params.onAlertsBatch - (alertPayload: { alerts[], summary }) => void
 * @param {Function} params.loadRiskState - async (userId) => { riskScores[], stockoutData[] }
 * @param {Object} [params.config] - override ALERT_MONITOR_CONFIG
 * @returns {Object} { start, stop, evaluateNow, isRunning }
 */
export function createAlertMonitor({ userId, onAlertsBatch, loadRiskState, config = {} }) {
  const cfg = { ...ALERT_MONITOR_CONFIG, ...config };
  const pollingMs = Math.max(cfg.polling_interval_ms, cfg.min_interval_ms);

  let intervalId = null;
  let running = false;
  const seenAlerts = new Map(); // alertKey → lastEmittedAt

  /**
   * Run one evaluation cycle.
   */
  async function evaluate() {
    try {
      if (!loadRiskState) return;

      const { riskScores = [], stockoutData = [] } = await loadRiskState(userId);
      if (riskScores.length === 0 && stockoutData.length === 0) return;

      const result = generateAlerts({ riskScores, stockoutData });
      if (!result?.alerts?.length) return;

      // Dedup: filter out alerts already emitted within the window
      const now = Date.now();
      const freshAlerts = result.alerts.filter((alert) => {
        const key = buildAlertKey(alert);
        const lastEmitted = seenAlerts.get(key);
        if (lastEmitted && (now - lastEmitted) < cfg.dedup_window_ms) {
          return false;
        }
        return true;
      });

      if (freshAlerts.length === 0) return;

      // Truncate to max per push
      const batch = freshAlerts.slice(0, cfg.max_alerts_per_push);

      // Mark as seen
      batch.forEach((alert) => {
        seenAlerts.set(buildAlertKey(alert), now);
      });

      // Clean up old entries from dedup map
      cleanupSeenAlerts(now, cfg.dedup_window_ms);

      // Notify
      onAlertsBatch({
        alerts: batch,
        summary: {
          ...result.summary,
          total_alerts: batch.length,
        },
      });
    } catch (error) {
      console.warn('[alertMonitor] Evaluation failed:', error?.message);
    }
  }

  /**
   * Start the polling loop.
   */
  function start() {
    if (running) return;
    running = true;
    // Initial evaluation
    evaluate();
    intervalId = setInterval(evaluate, pollingMs);
  }

  /**
   * Stop the polling loop.
   */
  function stop() {
    running = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  /**
   * Run one evaluation immediately (event-driven trigger).
   */
  async function evaluateNow() {
    await evaluate();
  }

  /**
   * Check if the monitor is currently running.
   */
  function isRunning() {
    return running;
  }

  /**
   * Clear the dedup cache (useful for testing or reset).
   */
  function clearDedup() {
    seenAlerts.clear();
  }

  function cleanupSeenAlerts(now, windowMs) {
    for (const [key, timestamp] of seenAlerts) {
      if (now - timestamp > windowMs * 2) {
        seenAlerts.delete(key);
      }
    }
  }

  return { start, stop, evaluateNow, isRunning, clearDedup };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a dedup key for an alert based on type + material + plant.
 */
function buildAlertKey(alert) {
  return `${alert.alert_type || ''}|${alert.material_code || ''}|${alert.plant_id || ''}`;
}

/**
 * Build a chat message object for a batch of proactive alerts.
 *
 * @param {Object} alertPayload - { alerts[], summary }
 * @returns {Object} message suitable for injection into conversation
 */
export function buildAlertChatMessage(alertPayload) {
  return {
    role: 'system',
    type: 'proactive_alert_card',
    payload: alertPayload,
    timestamp: new Date().toISOString(),
    is_proactive: true,
  };
}

/**
 * Check if proactive alert monitoring is enabled.
 * @returns {boolean}
 */
export function isAlertMonitorEnabled() {
  try {
    return import.meta.env.VITE_DI_PROACTIVE_ALERTS === 'true';
  } catch {
    return false;
  }
}

export default {
  createAlertMonitor,
  buildAlertChatMessage,
  isAlertMonitorEnabled,
  ALERT_MONITOR_CONFIG,
};
