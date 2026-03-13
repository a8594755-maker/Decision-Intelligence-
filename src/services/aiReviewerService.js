// @product: ai-employee
//
// aiReviewerService.js
// ─────────────────────────────────────────────────────────────────────────────
// AI quality reviewer that scores step outputs 0-100 across four categories:
//   correctness, completeness, formatting, relevance.
//
// Key design: uses a DIFFERENT model from the one that generated the output
// (cross-model review) to avoid self-evaluation bias. The review routing
// policy maps to Tier A.
//
// Integration: called by agentLoopService after step execution succeeds but
// BEFORE marking the step as SUCCEEDED. If score < threshold, the step is
// sent back for revision with structured suggestions.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

// ── Thresholds ───────────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS = {
  dynamic_tool:    75,
  registered_tool: 60,
  report:          70,
  plan:            65,
  forecast:        60,
  risk:            60,
  export:          50,
  synthesize:      50,
};

export const MAX_REVISION_ROUNDS = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[aiReviewerService] Supabase call failed:', err?.message || err);
    return null;
  }
}

// ── Review logic ─────────────────────────────────────────────────────────────

/**
 * Score a step output for quality.
 *
 * In a production environment this would call a Tier A LLM via
 * resolveModel('review'). For now we implement a deterministic
 * heuristic reviewer that examines output structure and completeness.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.stepName
 * @param {string} opts.workflowType
 * @param {object} opts.output       – Step result (summary, artifacts, etc.)
 * @param {object} [opts.expectedOutput] – What the user asked for
 * @param {Array}  [opts.priorReviews]   – Previous review rounds
 * @returns {Promise<AIReviewResult>}
 */
export async function reviewStepOutput({
  taskId,
  stepName,
  workflowType,
  output,
  expectedOutput = null,
  priorReviews = [],
}) {
  const threshold = DEFAULT_THRESHOLDS[workflowType] ?? 60;
  const revisionRound = priorReviews.length + 1;

  // ── Deterministic quality checks ─────────────────────────────────────────
  const categories = {
    correctness:  100,
    completeness: 100,
    formatting:   100,
    relevance:    100,
  };
  const suggestions = [];

  // 1. Correctness: output must exist and not be an error
  if (!output) {
    categories.correctness = 0;
    suggestions.push('Step produced no output. Ensure the run function returns a result.');
  } else if (output.error || output.status === 'failed') {
    categories.correctness = 20;
    suggestions.push(`Step errored: ${output.error || 'unknown'}. Fix the underlying issue.`);
  }

  // 2. Completeness: check for expected fields
  if (output) {
    const hasArtifacts = output.artifact_refs?.length > 0 || output.artifacts?.length > 0;
    const hasSummary = Boolean(output.summary || output.result);

    if (!hasArtifacts && workflowType !== 'export' && workflowType !== 'synthesize') {
      categories.completeness -= 30;
      suggestions.push('No artifacts generated. Ensure the step produces downloadable outputs.');
    }
    if (!hasSummary) {
      categories.completeness -= 20;
      suggestions.push('No summary or result text. Add a human-readable summary of the output.');
    }
  }

  // 3. Formatting: check output structure
  if (output && typeof output === 'object') {
    // Well-structured
    categories.formatting = 90;
    if (output.result && typeof output.result === 'string' && output.result.length > 5000) {
      categories.formatting -= 20;
      suggestions.push('Output text is very long. Consider summarizing key findings.');
    }
  }

  // 4. Relevance: if expected output provided, rough check
  if (expectedOutput && output) {
    const outputStr = JSON.stringify(output).toLowerCase();
    const expectedStr = typeof expectedOutput === 'string'
      ? expectedOutput.toLowerCase()
      : JSON.stringify(expectedOutput).toLowerCase();

    // Check keyword overlap (simple heuristic)
    const keywords = expectedStr.split(/\s+/).filter(w => w.length > 3);
    const matched = keywords.filter(kw => outputStr.includes(kw));
    const ratio = keywords.length > 0 ? matched.length / keywords.length : 1;
    categories.relevance = Math.round(ratio * 100);

    if (ratio < 0.5) {
      suggestions.push('Output does not appear to address the expected requirements. Review the task description.');
    }
  }

  // Clamp all categories to 0-100
  for (const key of Object.keys(categories)) {
    categories[key] = Math.max(0, Math.min(100, categories[key]));
  }

  // ── Composite score ─────────────────────────────────────────────────────
  const weights = { correctness: 0.4, completeness: 0.3, formatting: 0.1, relevance: 0.2 };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += categories[key] * weight;
  }
  score = Math.round(score);

  const passed = score >= threshold;
  const feedback = passed
    ? `Quality check passed (${score}/${threshold}).`
    : `Quality below threshold (${score}/${threshold}). ${suggestions.length} suggestion(s) for improvement.`;

  const result = {
    score,
    passed,
    threshold,
    feedback,
    categories,
    suggestions,
    revision_round: revisionRound,
    reviewer_model: 'deterministic-v1', // Will be replaced by LLM in production
  };

  // ── Persist review result ───────────────────────────────────────────────
  await trySupabase(async () => {
    await supabase.from('ai_review_results').insert({
      task_id: taskId,
      step_name: stepName,
      revision_round: revisionRound,
      score,
      passed,
      threshold,
      feedback,
      categories,
      suggestions,
      reviewer_model: result.reviewer_model,
    });
  });

  return result;
}

/**
 * Get all review results for a task+step.
 */
export async function getReviewHistory(taskId, stepName = null) {
  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_review_results')
      .select('*')
      .eq('task_id', taskId)
      .order('revision_round');
    if (stepName) q = q.eq('step_name', stepName);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  });

  return sbResult || [];
}

/**
 * Build a revision_log artifact from review history.
 */
export function buildRevisionLog(reviews, stepName) {
  const rounds = reviews.map(r => ({
    round: r.revision_round,
    score: r.score,
    threshold: r.threshold,
    passed: r.passed,
    feedback: r.feedback,
    suggestions: r.suggestions || [],
    reviewer_model: r.reviewer_model,
    timestamp: r.created_at,
  }));

  return {
    step_name: stepName,
    total_rounds: rounds.length,
    rounds,
    final_score: rounds.length > 0 ? rounds[rounds.length - 1].score : null,
    passed: rounds.length > 0 ? rounds[rounds.length - 1].passed : false,
  };
}

/**
 * Check if a step should skip AI review.
 * Some workflow types are too simple to warrant review.
 */
export function shouldReview(workflowType) {
  const skipTypes = new Set(['export', 'synthesize']);
  return !skipTypes.has(workflowType);
}
