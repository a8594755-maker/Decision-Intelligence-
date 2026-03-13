// @product: ai-employee
//
// proactiveTaskGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// Bridges proactive alerts → AI Employee tasks.
//
// Takes alerts from `proactiveAlertService.generateAlerts()` and converts
// them into tasks that an AI Employee can autonomously execute.
//
// Dedup: skips creating a task if one already exists for the same alert_id.
// ─────────────────────────────────────────────────────────────────────────────

import * as aiEmployeeService from './aiEmployeeService';

// ── Alert → Task mapping ─────────────────────────────────────────────────────

/**
 * Maps alert_type to task configuration.
 */
export const ALERT_TASK_MAP = {
  stockout_risk: {
    template_id: 'risk_aware_plan',
    workflow_type: null,     // template takes precedence
    priority: 'urgent',
    titlePrefix: '[Auto] Stockout mitigation',
  },
  supplier_delay: {
    template_id: null,
    workflow_type: 'risk',
    priority: 'high',
    titlePrefix: '[Auto] Supplier delay risk analysis',
  },
  dual_source_rec: {
    template_id: null,
    workflow_type: 'plan',
    priority: 'medium',
    titlePrefix: '[Auto] Dual-source evaluation',
  },
  expedite_rec: {
    template_id: 'forecast_then_plan',
    workflow_type: null,
    priority: 'high',
    titlePrefix: '[Auto] Expedite planning',
  },
};

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Convert a single alert into a task template object (not persisted yet).
 *
 * @param {object} alert - From generateAlerts()
 * @param {string} employeeId
 * @returns {object|null} Task creation params, or null if unmapped alert type
 */
export function alertToTask(alert, employeeId) {
  const mapping = ALERT_TASK_MAP[alert.alert_type];
  if (!mapping) return null;

  const title = `${mapping.titlePrefix}: ${alert.material_code || alert.title || 'Unknown'}`;
  const description = alert.message || alert.title || '';

  const input_context = {
    workflow_type: mapping.workflow_type || undefined,
    alert_id: alert.alert_id,
    alert_type: alert.alert_type,
    material_code: alert.material_code || null,
    plant_id: alert.plant_id || null,
    supplier: alert.supplier || null,
    severity: alert.severity || 'medium',
    impact_score: alert.impact_score || 0,
  };

  return {
    employeeId,
    title,
    description,
    priority: mapping.priority,
    template_id: mapping.template_id || null,
    input_context,
    source_type: 'scheduled',
  };
}

/**
 * Evaluate alerts and create tasks for an AI Employee.
 *
 * Skips alerts that already have a pending/in_progress task (dedup by alert_id).
 *
 * @param {string} employeeId
 * @param {string} userId
 * @param {object[]} alerts - From generateAlerts()
 * @returns {Promise<{ created: object[], skipped: number, errors: number }>}
 */
export async function evaluateAndCreateTasks(employeeId, userId, alerts) {
  if (!alerts || alerts.length === 0) {
    return { created: [], skipped: 0, errors: 0 };
  }

  // ── Load existing tasks for dedup ──────────────────────────────────────
  let existingAlertIds = new Set();
  try {
    const tasks = await aiEmployeeService.listTasks(employeeId);
    for (const task of tasks) {
      const alertId = task.input_context?.alert_id;
      if (alertId && task.status !== 'done') {
        existingAlertIds.add(alertId);
      }
    }
  } catch { /* dedup is best-effort */ }

  // ── Process alerts ─────────────────────────────────────────────────────
  const created = [];
  let skipped = 0;
  let errors = 0;

  for (const alert of alerts) {
    // Dedup
    if (existingAlertIds.has(alert.alert_id)) {
      skipped++;
      continue;
    }

    const taskParams = alertToTask(alert, employeeId);
    if (!taskParams) {
      skipped++;
      continue;
    }

    try {
      const task = await aiEmployeeService.createTask(employeeId, {
        title: taskParams.title,
        description: taskParams.description,
        priority: taskParams.priority,
        input_context: taskParams.input_context,
        source_type: taskParams.source_type,
        assigned_by_user_id: userId,
      });
      created.push(task);
    } catch (err) {
      console.warn('[proactiveTaskGenerator] Failed to create task for alert:', alert.alert_id, err?.message);
      errors++;
    }
  }

  return { created, skipped, errors };
}

// ── Default export ───────────────────────────────────────────────────────────

export default { ALERT_TASK_MAP, alertToTask, evaluateAndCreateTasks };
