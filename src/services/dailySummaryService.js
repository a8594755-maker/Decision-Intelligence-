// @product: ai-employee
//
// dailySummaryService.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates daily work summaries for AI Employees.
//
// Called by the scheduler edge function once per day (or manually).
// Writes the summary as a worklog entry with log_type = 'daily_summary'.
// ─────────────────────────────────────────────────────────────────────────────

import { listTasks, getKpis, appendWorklog, listWorklogs } from './aiEmployee/queries.js';
import { getEmployeeCostSummary } from './modelRoutingService';

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayDateStr(date = new Date()) {
  return date.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function isToday(isoString, referenceDate = new Date()) {
  if (!isoString) return false;
  return isoString.slice(0, 10) === todayDateStr(referenceDate);
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Generate a daily summary for an AI employee.
 *
 * Collects tasks completed/failed/in-progress today, cost data, and KPIs.
 * Writes the summary as a worklog entry and returns the summary object.
 *
 * @param {string} employeeId
 * @param {Date}   [date] - Reference date (default: today)
 * @returns {Promise<object>} The summary object
 */
export async function generateDailySummary(employeeId, date = new Date()) {
  const dateStr = todayDateStr(date);

  // ── Gather tasks ────────────────────────────────────────────────────────
  const allTasks = await listTasks(employeeId);
  const todayTasks = allTasks.filter((t) => isToday(t.updated_at, date) || isToday(t.created_at, date));

  const completed = todayTasks.filter((t) => t.status === 'done');
  const failed    = todayTasks.filter((t) => t.status === 'blocked');
  const inProgress = todayTasks.filter((t) => t.status === 'in_progress');
  const waitingReview = todayTasks.filter((t) => t.status === 'review_hold');

  // ── Cost data ───────────────────────────────────────────────────────────
  let costSummary = { total_cost: 0, total_calls: 0, by_tier: {} };
  try {
    costSummary = await getEmployeeCostSummary(employeeId, { days: 1 });
  } catch { /* cost is best-effort */ }

  // ── KPIs ────────────────────────────────────────────────────────────────
  let kpis = null;
  try {
    kpis = await getKpis(employeeId);
  } catch { /* kpis are best-effort */ }

  // ── Build highlights & issues ───────────────────────────────────────────
  const highlights = [];
  const issues = [];

  if (completed.length > 0) {
    highlights.push(`${completed.length} task(s) completed successfully.`);
  }
  if (waitingReview.length > 0) {
    highlights.push(`${waitingReview.length} task(s) awaiting review.`);
  }
  if (failed.length > 0) {
    issues.push(`${failed.length} task(s) blocked or failed.`);
  }
  if (costSummary.total_cost > 0.50) {
    issues.push(`Daily cost: $${costSummary.total_cost.toFixed(4)} — consider reviewing budget limits.`);
  }
  if (kpis && kpis.review_pass_rate_pct !== null && kpis.review_pass_rate_pct < 70) {
    issues.push(`Review pass rate is ${kpis.review_pass_rate_pct}% — below 70% threshold.`);
  }

  // ── Assemble summary ───────────────────────────────────────────────────
  const summary = {
    date: dateStr,
    employee_id: employeeId,
    tasks_completed: completed.length,
    tasks_failed: failed.length,
    tasks_in_progress: inProgress.length,
    tasks_waiting_review: waitingReview.length,
    total_tasks_today: todayTasks.length,
    total_cost: costSummary.total_cost,
    total_calls: costSummary.total_calls,
    cost_by_tier: costSummary.by_tier,
    highlights,
    issues,
    kpi_snapshot: kpis ? {
      on_time_rate: kpis.on_time_rate_pct,
      review_pass_rate: kpis.review_pass_rate_pct,
      tasks_completed_all_time: kpis.tasks_completed,
      tasks_open: kpis.tasks_open,
    } : null,
    generated_at: new Date().toISOString(),
  };

  // ── Persist as worklog ─────────────────────────────────────────────────
  try {
    await appendWorklog(
      employeeId,
      null,   // not tied to specific task
      null,   // not tied to specific run
      'daily_summary',
      summary
    );
  } catch (err) {
    console.warn('[dailySummaryService] Failed to write worklog:', err?.message);
  }

  return summary;
}

/**
 * Get the latest daily summary for an employee from worklogs.
 *
 * @param {string} employeeId
 * @returns {Promise<object|null>}
 */
export async function getLatestSummary(employeeId) {
  try {
    const worklogs = await listWorklogs(employeeId, { limit: 20 });
    const summaryLog = worklogs.find((w) => w.log_type === 'daily_summary');
    return summaryLog?.content || null;
  } catch {
    return null;
  }
}

// ── Default export ───────────────────────────────────────────────────────────

export default { generateDailySummary, getLatestSummary };
