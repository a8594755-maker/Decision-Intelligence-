/**
 * Trust Metrics Service
 *
 * Computes and tracks trust & autonomy metrics for each Digital Worker.
 * These metrics determine:
 *   - Whether to increase/decrease autonomy level (A1→A2→A3→A4)
 *   - Which task types can be auto-approved
 *   - Overall worker reliability for manager dashboards
 *
 * Metrics:
 *   - first_pass_acceptance_rate: % tasks approved without revision
 *   - manager_edit_distance: avg normalized edit distance on revisions
 *   - revision_rate: % tasks needing at least one revision
 *   - policy_violation_rate: % steps flagging policy violations
 *   - style_compliance_score: how well outputs match style profile
 *   - auto_approved_rate: % tasks passing auto-approval thresholds
 *   - escalation_rate: % tasks escalated from auto to human review
 *   - avg_review_score: average AI review score (0-100)
 *   - artifact_completeness_rate: % tasks with all expected artifacts
 */
import { supabase } from '../../supabaseClient.js';
import { TASK_STATES } from '../taskStateMachine.js';

const TABLE = 'trust_metrics';
const TASKS_TABLE = 'ai_employee_tasks';
const REVIEWS_TABLE = 'ai_employee_reviews';
const MEMORY_TABLE = 'ai_employee_task_memory';
const AI_REVIEWS_TABLE = 'ai_review_results';

// ─── Autonomy Level Thresholds ───────────────────────────────

const AUTONOMY_THRESHOLDS = {
  A2: { first_pass_rate: 0.50, min_tasks: 10 },
  A3: { first_pass_rate: 0.70, min_tasks: 30, max_revision_rate: 0.20 },
  A4: { first_pass_rate: 0.85, min_tasks: 100, max_revision_rate: 0.10, max_policy_violations: 0.02 },
};

// ─── Compute Metrics ─────────────────────────────────────────

/**
 * Compute trust metrics for a given period.
 *
 * @param {string} employeeId
 * @param {Date} periodStart
 * @param {Date} periodEnd
 * @returns {TrustMetrics}
 */
export async function computeMetrics(employeeId, periodStart, periodEnd) {
  const startStr = periodStart.toISOString();
  const endStr = periodEnd.toISOString();

  // Fetch all data in parallel
  const [tasks, reviews, memories, aiReviews] = await Promise.all([
    fetchTasks(employeeId, startStr, endStr),
    fetchReviews(employeeId, startStr, endStr),
    fetchMemories(employeeId, startStr, endStr),
    fetchAiReviews(employeeId, startStr, endStr),
  ]);

  const completedTasks = tasks.filter(t => t.status === TASK_STATES.DONE);
  const failedTasks = tasks.filter(t => t.status === TASK_STATES.FAILED);

  // Core metrics
  const firstPassAcceptanceRate = computeFirstPassRate(reviews, completedTasks);
  const revisionRate = computeRevisionRate(reviews, completedTasks);
  const avgReviewScore = computeAvgReviewScore(aiReviews);
  const artifactCompletenessRate = computeArtifactCompleteness(memories);

  // Autonomy metrics
  const autoApprovedRate = computeAutoApprovedRate(reviews, completedTasks);
  const escalationRate = computeEscalationRate(reviews);

  // Compute policy violation rate from AI review results
  const policyViolationRate = computePolicyViolationRate(aiReviews);

  // Compute manager edit distance from revisions
  const managerEditDistance = computeManagerEditDistance(reviews, memories);

  // Compute style compliance score from AI review results
  const styleComplianceScore = computeStyleComplianceScore(aiReviews, memories);

  // Determine autonomy level
  const autonomyLevel = determineAutonomyLevel({
    firstPassAcceptanceRate,
    revisionRate,
    tasksCompleted: completedTasks.length,
    policyViolationRate,
  });

  const metrics = {
    employee_id: employeeId,
    period_start: periodStart.toISOString().split('T')[0],
    period_end: periodEnd.toISOString().split('T')[0],
    first_pass_acceptance_rate: firstPassAcceptanceRate,
    manager_edit_distance: managerEditDistance,
    revision_rate: revisionRate,
    policy_violation_rate: policyViolationRate,
    autonomy_level: autonomyLevel,
    auto_approved_rate: autoApprovedRate,
    escalation_rate: escalationRate,
    avg_review_score: avgReviewScore,
    style_compliance_score: styleComplianceScore,
    artifact_completeness_rate: artifactCompletenessRate,
    tasks_completed: completedTasks.length,
    tasks_failed: failedTasks.length,
    total_steps_executed: aiReviews.length,
    metrics_by_doc_type: computeByDocType(memories, reviews),
  };

  return metrics;
}

/**
 * Compute and save metrics for a period. Upserts on (employee_id, period_start, period_end).
 */
export async function computeAndSave(employeeId, periodStart, periodEnd) {
  const metrics = await computeMetrics(employeeId, periodStart, periodEnd);

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(metrics, { onConflict: 'employee_id,period_start,period_end' })
    .select()
    .single();

  if (error) throw new Error(`computeAndSave failed: ${error.message}`);
  return data;
}

/**
 * Get the latest trust metrics for an employee.
 */
export async function getLatestMetrics(employeeId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestMetrics failed: ${error.message}`);
  return data;
}

/**
 * Record a single review outcome for incremental trust tracking.
 * Called after each manager review decision.
 */
export async function recordReviewOutcome(employeeId, { taskId: _taskId, decision, hasFeedback: _hasFeedback, hasRevision }) {
  try {
    // Update the latest trust metrics incrementally
    const latest = await getLatestMetrics(employeeId);
    if (!latest) return; // No metrics yet — will be computed on next full evaluation

    const updates = {};
    if (decision === 'approve' && !hasRevision) {
      // First-pass approval — positive signal
      updates.first_pass_count = (latest.first_pass_count || 0) + 1;
    }
    if (hasRevision) {
      updates.revision_count = (latest.revision_count || 0) + 1;
    }
    updates.total_reviews = (latest.total_reviews || 0) + 1;
    updates.updated_at = new Date().toISOString();

    await supabase
      .from(TABLE)
      .update(updates)
      .eq('id', latest.id);
  } catch (err) {
    console.warn('[TrustMetrics] recordReviewOutcome failed:', err.message);
  }
}

/**
 * Get metrics history for trend analysis.
 */
export async function getMetricsHistory(employeeId, { limit = 12 } = {}) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .order('period_end', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getMetricsHistory failed: ${error.message}`);
  return data || [];
}

// ─── Metric Computation Functions ────────────────────────────

function computeFirstPassRate(reviews, completedTasks) {
  if (!completedTasks.length) return 0;

  const taskIds = new Set(completedTasks.map(t => t.id));
  const reviewedTaskIds = new Set(reviews.filter(r => taskIds.has(r.task_id)).map(r => r.task_id));

  // Tasks approved on first review (no 'needs_revision' before 'approved')
  let firstPassCount = 0;
  for (const taskId of reviewedTaskIds) {
    const taskReviews = reviews
      .filter(r => r.task_id === taskId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (taskReviews.length > 0 && taskReviews[0].decision === 'approved') {
      firstPassCount++;
    }
  }

  // Tasks with no reviews at all also count (auto-completed)
  const noReviewTasks = completedTasks.filter(t => !reviewedTaskIds.has(t.id));
  firstPassCount += noReviewTasks.length;

  return completedTasks.length ? firstPassCount / completedTasks.length : 0;
}

function computeRevisionRate(reviews, completedTasks) {
  if (!completedTasks.length) return 0;

  const taskIds = new Set(completedTasks.map(t => t.id));
  const revisedTaskIds = new Set(
    reviews
      .filter(r => taskIds.has(r.task_id) && r.decision === 'needs_revision')
      .map(r => r.task_id)
  );

  return revisedTaskIds.size / completedTasks.length;
}

function computeAvgReviewScore(aiReviews) {
  if (!aiReviews.length) return 0;
  const scores = aiReviews.map(r => r.score).filter(s => typeof s === 'number');
  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function computeArtifactCompleteness(memories) {
  if (!memories.length) return 0;
  const withArtifacts = memories.filter(m => m.artifacts_generated > 0);
  return memories.length ? withArtifacts.length / memories.length : 0;
}

function computeAutoApprovedRate(reviews, completedTasks) {
  if (!completedTasks.length) return 0;
  const autoReviews = reviews.filter(r => r.reviewer_type === 'ai_reviewer' && r.decision === 'approved');
  const autoApprovedTaskIds = new Set(autoReviews.map(r => r.task_id));
  return autoApprovedTaskIds.size / completedTasks.length;
}

function computeEscalationRate(reviews) {
  if (!reviews.length) return 0;
  // Escalation = AI reviewer rejected/needs_revision, then human reviewed
  const aiRejected = reviews.filter(r => r.reviewer_type === 'ai_reviewer' && r.decision === 'needs_revision');
  const aiRejectedTaskIds = new Set(aiRejected.map(r => r.task_id));
  const escalated = reviews.filter(r => r.reviewer_type === 'human_manager' && aiRejectedTaskIds.has(r.task_id));
  return aiRejected.length ? escalated.length / aiRejected.length : 0;
}

/**
 * Compute policy violation rate from AI review results.
 * A policy violation is when an AI review flagged a violation (passed=false with low score).
 */
function computePolicyViolationRate(aiReviews) {
  if (!aiReviews.length) return 0;
  const violations = aiReviews.filter(r => r.passed === false && (r.score ?? 100) < 50);
  return violations.length / aiReviews.length;
}

/**
 * Compute normalized edit distance from manager revisions.
 * Uses the ratio of revision comments/feedback length vs original output length as a proxy.
 * Higher distance = more manager edits needed = lower trust.
 */
function computeManagerEditDistance(reviews, memories) {
  const revisionReviews = reviews.filter(r => r.decision === 'needs_revision');
  if (!revisionReviews.length) return 0;

  let totalDistance = 0;
  let count = 0;

  for (const review of revisionReviews) {
    const mem = memories.find(m => m.task_id === review.task_id);
    if (!mem) continue;

    // Use revision count as a proxy for edit distance (0-1 scale)
    // Each revision implies ~0.3 normalized distance
    const taskRevisions = reviews.filter(
      r => r.task_id === review.task_id && r.decision === 'needs_revision'
    ).length;
    totalDistance += Math.min(taskRevisions * 0.3, 1.0);
    count++;
  }

  return count > 0 ? totalDistance / count : 0;
}

/**
 * Compute style compliance score from AI review scores and memory outcomes.
 * Aggregates per-task style compliance into a 0-1 score.
 */
function computeStyleComplianceScore(aiReviews, memories) {
  if (!aiReviews.length && !memories.length) return 0;

  let totalScore = 0;
  let count = 0;

  // From AI reviews: use score as compliance indicator (0-100 → 0-1)
  for (const review of aiReviews) {
    if (typeof review.score === 'number') {
      totalScore += review.score / 100;
      count++;
    }
  }

  // From memories: successful tasks with artifacts contribute positively
  for (const mem of memories) {
    if (mem.success && mem.artifacts_generated > 0) {
      totalScore += 0.85; // baseline compliance for successful tasks
      count++;
    } else if (mem.success) {
      totalScore += 0.70;
      count++;
    }
  }

  return count > 0 ? Math.min(totalScore / count, 1.0) : 0;
}

function computeByDocType(memories, reviews) {
  const byType = {};
  for (const m of memories) {
    const wf = m.workflow_type || 'unknown';
    if (!byType[wf]) byType[wf] = { completed: 0, failed: 0, revised: 0 };
    if (m.success) byType[wf].completed++;
    else byType[wf].failed++;
  }
  for (const r of reviews) {
    if (r.decision === 'needs_revision') {
      // Try to map to workflow type via memory
      const mem = memories.find(m => m.task_id === r.task_id);
      const wf = mem?.workflow_type || 'unknown';
      if (byType[wf]) byType[wf].revised++;
    }
  }
  return byType;
}

// ─── Autonomy Level Determination ────────────────────────────

function determineAutonomyLevel({ firstPassAcceptanceRate, revisionRate, tasksCompleted, policyViolationRate }) {
  // Check from highest to lowest
  const a4 = AUTONOMY_THRESHOLDS.A4;
  if (
    firstPassAcceptanceRate >= a4.first_pass_rate &&
    tasksCompleted >= a4.min_tasks &&
    revisionRate <= a4.max_revision_rate &&
    policyViolationRate <= a4.max_policy_violations
  ) {
    return 'A4';
  }

  const a3 = AUTONOMY_THRESHOLDS.A3;
  if (
    firstPassAcceptanceRate >= a3.first_pass_rate &&
    tasksCompleted >= a3.min_tasks &&
    revisionRate <= a3.max_revision_rate
  ) {
    return 'A3';
  }

  const a2 = AUTONOMY_THRESHOLDS.A2;
  if (firstPassAcceptanceRate >= a2.first_pass_rate && tasksCompleted >= a2.min_tasks) {
    return 'A2';
  }

  return 'A1';
}

/**
 * Get the recommended autonomy level with explanation.
 */
export async function getAutonomyRecommendation(employeeId) {
  const latest = await getLatestMetrics(employeeId);
  if (!latest) return { level: 'A1', reason: 'No metrics available yet', metrics: null };

  const level = latest.autonomy_level;
  const reasons = [];

  if (latest.tasks_completed < AUTONOMY_THRESHOLDS.A2.min_tasks) {
    reasons.push(`Only ${latest.tasks_completed} tasks completed (need ${AUTONOMY_THRESHOLDS.A2.min_tasks} for A2)`);
  }
  if (latest.first_pass_acceptance_rate < AUTONOMY_THRESHOLDS.A2.first_pass_rate) {
    reasons.push(`First-pass acceptance rate ${(latest.first_pass_acceptance_rate * 100).toFixed(1)}% (need ${AUTONOMY_THRESHOLDS.A2.first_pass_rate * 100}% for A2)`);
  }
  if (latest.revision_rate > (AUTONOMY_THRESHOLDS.A3.max_revision_rate || 1)) {
    reasons.push(`Revision rate ${(latest.revision_rate * 100).toFixed(1)}% is high`);
  }

  return {
    level,
    reason: reasons.length ? reasons.join('; ') : `Performing at ${level} level`,
    metrics: latest,
  };
}

// ─── Data Fetch ──────────────────────────────────────────────

async function fetchTasks(employeeId, startStr, endStr) {
  const { data } = await supabase
    .from(TASKS_TABLE)
    .select('id, status, created_at')
    .eq('employee_id', employeeId)
    .gte('created_at', startStr)
    .lte('created_at', endStr);
  return data || [];
}

async function fetchReviews(employeeId, startStr, endStr) {
  // Scope to this employee's tasks to avoid cross-worker contamination
  const tasks = await fetchTasks(employeeId, startStr, endStr);
  const taskIds = tasks.map(t => t.id);
  if (!taskIds.length) return [];

  const { data } = await supabase
    .from(REVIEWS_TABLE)
    .select('task_id, reviewer_type, decision, created_at')
    .in('task_id', taskIds)
    .gte('created_at', startStr)
    .lte('created_at', endStr);
  return data || [];
}

async function fetchMemories(employeeId, startStr, endStr) {
  const { data } = await supabase
    .from(MEMORY_TABLE)
    .select('task_id, workflow_type, success, artifacts_generated, manager_decision')
    .eq('employee_id', employeeId)
    .gte('created_at', startStr)
    .lte('created_at', endStr);
  return data || [];
}

async function fetchAiReviews(employeeId, startStr, endStr) {
  // Scope to this employee's tasks to avoid cross-worker contamination
  const tasks = await fetchTasks(employeeId, startStr, endStr);
  const taskIds = tasks.map(t => t.id);
  if (!taskIds.length) return [];

  const { data } = await supabase
    .from(AI_REVIEWS_TABLE)
    .select('task_id, score, passed, created_at')
    .in('task_id', taskIds)
    .gte('created_at', startStr)
    .lte('created_at', endStr);
  return data || [];
}

export const _testExports = {
  determineAutonomyLevel,
  computeFirstPassRate,
  computeRevisionRate,
  computeAvgReviewScore,
  AUTONOMY_THRESHOLDS,
};
