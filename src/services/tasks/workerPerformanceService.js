/**
 * workerPerformanceService.js — Product-Grade Performance Dashboard
 *
 * Extends the raw trust metrics from trustMetricsService into a product-grade
 * performance view suitable for manager dashboards and autonomy decisions.
 *
 * Adds:
 *   - Autonomy level by task type (per workflow_type breakdown)
 *   - Replay completeness (from taskTimelineService)
 *   - Policy violation breakdown
 *   - Trend analysis (period-over-period comparison)
 *   - Composite worker health score
 *
 * Consumes:
 *   - trustMetricsService  (raw metrics + autonomy levels)
 *   - taskTimelineService  (replay completeness)
 *   - queries.js           (KPIs, tasks, worklogs)
 */

import { supabase } from '../infra/supabaseClient';
import {
  computeMetrics,
  getLatestMetrics,
  getMetricsHistory,
  getAutonomyRecommendation,
} from '../aiEmployee/styleLearning/trustMetricsService.js';
import {
  buildTaskTimeline,
  computeReplayCompleteness,
} from './taskTimelineService.js';

// ── Autonomy Level Labels ───────────────────────────────────────────────────

export const AUTONOMY_LABELS = {
  A0: { label: 'Manual',     color: 'gray',   description: 'All actions require approval' },
  A1: { label: 'Assisted',   color: 'red',    description: 'AI suggests, human decides' },
  A2: { label: 'Supervised', color: 'yellow', description: 'AI acts, human reviews after' },
  A3: { label: 'Autonomous', color: 'green',  description: 'AI acts independently for routine tasks' },
  A4: { label: 'Trusted',    color: 'blue',   description: 'Full autonomy with audit trail' },
};

// ── Performance Dashboard ───────────────────────────────────────────────────

/**
 * Build a complete performance dashboard for a worker.
 *
 * @param {string} employeeId
 * @param {Object} [options]
 * @param {number} [options.historyPeriods=6]  - Number of historical periods
 * @param {number} [options.recentTaskLimit=10] - Tasks to check replay completeness
 * @returns {Promise<Object>} Dashboard data
 */
export async function buildPerformanceDashboard(employeeId, { historyPeriods = 6, recentTaskLimit = 10 } = {}) {
  const [latestMetrics, history, autonomyRec, byTaskType, replayScore] = await Promise.allSettled([
    getLatestMetrics(employeeId),
    getMetricsHistory(employeeId, { limit: historyPeriods }),
    getAutonomyRecommendation(employeeId),
    computeAutonomyByTaskType(employeeId),
    computeAvgReplayCompleteness(employeeId, recentTaskLimit),
  ]);

  const metrics = latestMetrics.status === 'fulfilled' ? latestMetrics.value : null;
  const historyData = history.status === 'fulfilled' ? history.value : [];
  const autonomy = autonomyRec.status === 'fulfilled' ? autonomyRec.value : { level: 'A1', reason: 'No data' };
  const taskTypeBreakdown = byTaskType.status === 'fulfilled' ? byTaskType.value : {};
  const replay = replayScore.status === 'fulfilled' ? replayScore.value : { avg_score: 0, task_count: 0 };

  // Compute health score
  const healthScore = computeHealthScore(metrics, replay.avg_score);

  // Compute trends
  const trends = computeTrends(historyData);

  return {
    employee_id: employeeId,

    // Current state
    autonomy_level: autonomy.level,
    autonomy_label: AUTONOMY_LABELS[autonomy.level] || AUTONOMY_LABELS.A1,
    autonomy_reason: autonomy.reason,
    health_score: healthScore,

    // Core metrics
    metrics: metrics ? {
      first_pass_acceptance_rate: metrics.first_pass_acceptance_rate,
      manager_edit_distance: metrics.manager_edit_distance,
      revision_rate: metrics.revision_rate,
      policy_violation_rate: metrics.policy_violation_rate,
      avg_review_score: metrics.avg_review_score,
      style_compliance_score: metrics.style_compliance_score,
      auto_approved_rate: metrics.auto_approved_rate,
      escalation_rate: metrics.escalation_rate,
      artifact_completeness_rate: metrics.artifact_completeness_rate,
      tasks_completed: metrics.tasks_completed,
      tasks_failed: metrics.tasks_failed,
      total_steps_executed: metrics.total_steps_executed,
    } : null,

    // Autonomy by task type
    autonomy_by_task_type: taskTypeBreakdown,

    // Replay completeness
    replay_completeness: replay,

    // Trends
    trends,

    // History for charts
    history: historyData.map(h => ({
      period_start: h.period_start,
      period_end: h.period_end,
      autonomy_level: h.autonomy_level,
      first_pass_rate: h.first_pass_acceptance_rate,
      revision_rate: h.revision_rate,
      avg_review_score: h.avg_review_score,
      tasks_completed: h.tasks_completed,
    })),

    computed_at: new Date().toISOString(),
  };
}

// ── Autonomy by Task Type ───────────────────────────────────────────────────

/**
 * Compute per-workflow-type autonomy readiness.
 *
 * For each workflow type (forecast, plan, risk, etc.), computes the
 * first-pass acceptance rate and recommends an autonomy level.
 *
 * @param {string} employeeId
 * @returns {Promise<Object>} Map of workflow_type → { tasks, first_pass_rate, level }
 */
async function computeAutonomyByTaskType(employeeId) {
  try {
    // Fetch memories with workflow types
    const { data: memories } = await supabase
      .from('ai_employee_task_memory')
      .select('task_id, workflow_type, success, manager_decision')
      .eq('employee_id', employeeId);

    if (!memories || memories.length === 0) return {};

    // Fetch reviews for these tasks
    const taskIds = memories.map(m => m.task_id).filter(Boolean);
    const { data: reviews } = await supabase
      .from('ai_employee_reviews')
      .select('task_id, decision')
      .in('task_id', taskIds);

    const reviewMap = {};
    for (const r of (reviews || [])) {
      if (!reviewMap[r.task_id]) reviewMap[r.task_id] = [];
      reviewMap[r.task_id].push(r);
    }

    // Group by workflow type
    const byType = {};
    for (const mem of memories) {
      const wf = mem.workflow_type || 'unknown';
      if (!byType[wf]) byType[wf] = { tasks: 0, first_pass: 0, revised: 0, failed: 0 };

      byType[wf].tasks++;
      if (!mem.success) {
        byType[wf].failed++;
        continue;
      }

      const taskReviews = reviewMap[mem.task_id] || [];
      const hasRevision = taskReviews.some(r => r.decision === 'needs_revision');
      if (hasRevision) {
        byType[wf].revised++;
      } else {
        byType[wf].first_pass++;
      }
    }

    // Compute per-type autonomy
    const result = {};
    for (const [wf, stats] of Object.entries(byType)) {
      const completedTasks = stats.tasks - stats.failed;
      const firstPassRate = completedTasks > 0 ? stats.first_pass / completedTasks : 0;

      let level = 'A1';
      if (firstPassRate >= 0.85 && completedTasks >= 20) level = 'A4';
      else if (firstPassRate >= 0.70 && completedTasks >= 10) level = 'A3';
      else if (firstPassRate >= 0.50 && completedTasks >= 5) level = 'A2';

      result[wf] = {
        tasks: stats.tasks,
        completed: completedTasks,
        first_pass: stats.first_pass,
        revised: stats.revised,
        failed: stats.failed,
        first_pass_rate: Math.round(firstPassRate * 1000) / 1000,
        recommended_level: level,
        level_label: AUTONOMY_LABELS[level]?.label || 'Assisted',
      };
    }

    return result;
  } catch (err) {
    console.warn('[WorkerPerformance] computeAutonomyByTaskType failed:', err?.message);
    return {};
  }
}

// ── Replay Completeness ─────────────────────────────────────────────────────

/**
 * Compute average replay completeness across recent tasks.
 *
 * @param {string} employeeId
 * @param {number} limit
 * @returns {Promise<{ avg_score, task_count, details }>}
 */
async function computeAvgReplayCompleteness(employeeId, limit = 10) {
  try {
    const { data: tasks } = await supabase
      .from('ai_employee_tasks')
      .select('id')
      .eq('employee_id', employeeId)
      .in('status', ['done', 'failed'])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!tasks || tasks.length === 0) {
      return { avg_score: 0, task_count: 0, details: [] };
    }

    const details = [];
    let totalScore = 0;

    for (const task of tasks) {
      try {
        const timeline = await buildTaskTimeline(task.id);
        const completeness = computeReplayCompleteness(timeline);
        details.push({
          task_id: task.id,
          score: completeness.score,
          missing: completeness.missing,
          event_count: timeline.length,
        });
        totalScore += completeness.score;
      } catch {
        details.push({ task_id: task.id, score: 0, missing: ['failed_to_build'], event_count: 0 });
      }
    }

    return {
      avg_score: details.length > 0 ? Math.round(totalScore / details.length) : 0,
      task_count: details.length,
      details,
    };
  } catch (err) {
    console.warn('[WorkerPerformance] computeAvgReplayCompleteness failed:', err?.message);
    return { avg_score: 0, task_count: 0, details: [] };
  }
}

// ── Health Score ─────────────────────────────────────────────────────────────

/**
 * Compute a composite worker health score (0-100).
 *
 * Weights:
 *   30% first-pass acceptance rate
 *   20% avg review score
 *   15% replay completeness
 *   15% style compliance
 *   10% low policy violations
 *   10% artifact completeness
 */
function computeHealthScore(metrics, replayAvg = 0) {
  if (!metrics) return 0;

  const firstPass = (metrics.first_pass_acceptance_rate || 0) * 100;
  const reviewScore = metrics.avg_review_score || 0;
  const replayScore = replayAvg || 0;
  const styleScore = (metrics.style_compliance_score || 0) * 100;
  const policyScore = Math.max(0, 100 - (metrics.policy_violation_rate || 0) * 500); // 20% violations → 0 score
  const artifactScore = (metrics.artifact_completeness_rate || 0) * 100;

  const score = Math.round(
    firstPass * 0.30 +
    reviewScore * 0.20 +
    replayScore * 0.15 +
    styleScore * 0.15 +
    policyScore * 0.10 +
    artifactScore * 0.10
  );

  return Math.min(100, Math.max(0, score));
}

// ── Trend Analysis ──────────────────────────────────────────────────────────

/**
 * Compute period-over-period trends from metrics history.
 *
 * @param {Object[]} history - Metrics history (newest first)
 * @returns {Object} Trends for each key metric
 */
function computeTrends(history) {
  if (history.length < 2) {
    return { direction: 'insufficient_data', metrics: {} };
  }

  const current = history[0];
  const previous = history[1];

  const metricKeys = [
    'first_pass_acceptance_rate',
    'revision_rate',
    'avg_review_score',
    'policy_violation_rate',
    'tasks_completed',
  ];

  const trends = {};
  let positiveCount = 0;
  let negativeCount = 0;

  for (const key of metricKeys) {
    const curr = current[key] ?? 0;
    const prev = previous[key] ?? 0;
    const delta = curr - prev;
    const pctChange = prev !== 0 ? (delta / prev) * 100 : (curr > 0 ? 100 : 0);

    // For revision_rate and policy_violation_rate, decrease is positive
    const isInverseMetric = key === 'revision_rate' || key === 'policy_violation_rate';
    const isPositive = isInverseMetric ? delta <= 0 : delta >= 0;

    if (isPositive && delta !== 0) positiveCount++;
    else if (!isPositive) negativeCount++;

    trends[key] = {
      current: curr,
      previous: prev,
      delta: Math.round(delta * 1000) / 1000,
      pct_change: Math.round(pctChange * 10) / 10,
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      is_positive: isPositive,
    };
  }

  return {
    direction: positiveCount > negativeCount ? 'improving' : positiveCount < negativeCount ? 'declining' : 'stable',
    metrics: trends,
  };
}

// ── Refresh Metrics ─────────────────────────────────────────────────────────

/**
 * Trigger a metrics refresh for a worker (computes current period).
 *
 * @param {string} employeeId
 * @param {number} [periodDays=30] - Period length in days
 * @returns {Promise<Object>} Updated metrics
 */
export async function refreshMetrics(employeeId, periodDays = 30) {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 86400000);

  return computeMetrics(employeeId, periodStart, periodEnd);
}

// ── Multi-Worker Summary ────────────────────────────────────────────────────

/**
 * Build a summary across all workers for a manager.
 *
 * @param {string} userId - Manager's user ID
 * @returns {Promise<Object[]>} Array of per-worker summaries
 */
export async function buildTeamSummary(userId) {
  try {
    const { data: employees } = await supabase
      .from('ai_employees')
      .select('id, name, role')
      .eq('manager_user_id', userId);

    if (!employees || employees.length === 0) return [];

    const summaries = [];
    for (const emp of employees) {
      const metrics = await getLatestMetrics(emp.id);
      const autonomy = await getAutonomyRecommendation(emp.id);

      summaries.push({
        employee_id: emp.id,
        name: emp.name,
        role: emp.role,
        autonomy_level: autonomy.level,
        autonomy_label: AUTONOMY_LABELS[autonomy.level]?.label || 'Assisted',
        health_score: computeHealthScore(metrics, 0),
        tasks_completed: metrics?.tasks_completed || 0,
        first_pass_rate: metrics?.first_pass_acceptance_rate || 0,
        revision_rate: metrics?.revision_rate || 0,
        avg_review_score: metrics?.avg_review_score || 0,
      });
    }

    return summaries;
  } catch (err) {
    console.warn('[WorkerPerformance] buildTeamSummary failed:', err?.message);
    return [];
  }
}
