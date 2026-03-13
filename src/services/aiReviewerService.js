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
import { callLLMJson } from './aiEmployeeLLMService';

const SUPABASE_URL = String(import.meta?.env?.VITE_SUPABASE_URL || '').replace(/\/+$/, '');

function _hasAuth() {
  try {
    if (!SUPABASE_URL || typeof localStorage === 'undefined') return false;
    const match = SUPABASE_URL.match(/\/\/([^.]+)\./);
    if (!match) return false;
    const raw = localStorage.getItem(`sb-${match[1]}-auth-token`);
    return Boolean(raw && JSON.parse(raw)?.access_token);
  } catch { return false; }
}

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

// ── LLM Review ───────────────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are a quality reviewer for an AI supply chain assistant. Score the output of a task step on four categories (0-100 each): correctness, completeness, formatting, relevance.

Rules:
1. Be strict but fair. Score based on actual output quality.
2. If output is missing or errored, correctness should be very low.
3. Provide actionable suggestions for improvement.
4. If there were prior review rounds, check if the suggestions were addressed.

Respond with ONLY a JSON object:
{
  "score": 0-100,
  "categories": {
    "correctness": 0-100,
    "completeness": 0-100,
    "formatting": 0-100,
    "relevance": 0-100
  },
  "feedback": "brief overall assessment",
  "suggestions": ["actionable suggestion 1", "suggestion 2"]
}`;

async function _tryLLMReview({ taskId, stepName, workflowType, output, expectedOutput, priorReviews }) {
  if (!_hasAuth()) return null;
  try {
    const outputSummary = _summarizeOutput(output);
    const priorContext = priorReviews.length > 0
      ? `\nPrior review rounds: ${priorReviews.map(r => `Round ${r.revision_round}: score=${r.score}, feedback="${r.feedback}"`).join('; ')}`
      : '';

    const prompt = `Review this step output:
- Step: "${stepName}" (type: ${workflowType})
- Expected: ${expectedOutput ? JSON.stringify(expectedOutput).slice(0, 500) : 'Not specified'}
- Output summary: ${outputSummary}${priorContext}`;

    const { data, model } = await callLLMJson({
      taskType: 'review',
      prompt,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      maxTokens: 2048,
      trackingMeta: { taskId, employeeId: null, agentRole: 'reviewer', stepName },
    });

    if (!data || typeof data.score !== 'number') return null;

    console.info(`[aiReviewerService] LLM review via ${model}: score=${data.score}`);
    return {
      score: Math.max(0, Math.min(100, Math.round(data.score))),
      categories: {
        correctness:  Math.max(0, Math.min(100, data.categories?.correctness ?? 50)),
        completeness: Math.max(0, Math.min(100, data.categories?.completeness ?? 50)),
        formatting:   Math.max(0, Math.min(100, data.categories?.formatting ?? 50)),
        relevance:    Math.max(0, Math.min(100, data.categories?.relevance ?? 50)),
      },
      feedback: data.feedback || '',
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
      reviewer_model: model,
    };
  } catch (err) {
    console.warn('[aiReviewerService] LLM review failed, falling back to heuristic:', err?.message);
    return null;
  }
}

function _summarizeOutput(output) {
  if (!output) return 'No output produced.';
  if (output.error) return `Error: ${output.error}`;
  const parts = [];
  if (output.summary) parts.push(`Summary: ${String(output.summary).slice(0, 300)}`);
  if (output.result) parts.push(`Result: ${String(output.result).slice(0, 300)}`);
  const artifactCount = output.artifact_refs?.length || output.artifacts?.length || 0;
  if (artifactCount > 0) parts.push(`Artifacts: ${artifactCount} generated`);
  return parts.length > 0 ? parts.join('. ') : JSON.stringify(output).slice(0, 500);
}

// ── Review logic ─────────────────────────────────────────────────────────────

/**
 * Score a step output for quality.
 *
 * Strategy: LLM-first, heuristic-fallback.
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

  // ── Try LLM review first ────────────────────────────────────────────────
  const llmReview = await _tryLLMReview({ taskId, stepName, workflowType, output, expectedOutput, priorReviews });
  if (llmReview) {
    const passed = llmReview.score >= threshold;
    const result = {
      score: llmReview.score,
      passed,
      threshold,
      feedback: llmReview.feedback || (passed
        ? `Quality check passed (${llmReview.score}/${threshold}).`
        : `Quality below threshold (${llmReview.score}/${threshold}).`),
      categories: llmReview.categories,
      suggestions: llmReview.suggestions,
      revision_round: revisionRound,
      reviewer_model: llmReview.reviewer_model,
    };

    // Persist
    await trySupabase(async () => {
      await supabase.from('ai_review_results').insert({
        task_id: taskId, step_name: stepName, revision_round: revisionRound,
        score: result.score, passed, threshold, feedback: result.feedback,
        categories: result.categories, suggestions: result.suggestions,
        reviewer_model: result.reviewer_model, reviewer_tier: 'tier_a',
      });
    });

    return result;
  }

  // ── Fallback: Deterministic quality checks ──────────────────────────────
  const categories = {
    correctness:  100,
    completeness: 100,
    formatting:   100,
    relevance:    100,
  };
  const suggestions = [];

  if (!output) {
    categories.correctness = 0;
    suggestions.push('Step produced no output. Ensure the run function returns a result.');
  } else if (output.error || output.status === 'failed') {
    categories.correctness = 20;
    suggestions.push(`Step errored: ${output.error || 'unknown'}. Fix the underlying issue.`);
  }

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

  if (output && typeof output === 'object') {
    categories.formatting = 90;
    if (output.result && typeof output.result === 'string' && output.result.length > 5000) {
      categories.formatting -= 20;
      suggestions.push('Output text is very long. Consider summarizing key findings.');
    }
  }

  if (expectedOutput && output) {
    const outputStr = JSON.stringify(output).toLowerCase();
    const expectedStr = typeof expectedOutput === 'string'
      ? expectedOutput.toLowerCase()
      : JSON.stringify(expectedOutput).toLowerCase();

    const keywords = expectedStr.split(/\s+/).filter(w => w.length > 3);
    const matched = keywords.filter(kw => outputStr.includes(kw));
    const ratio = keywords.length > 0 ? matched.length / keywords.length : 1;
    categories.relevance = Math.round(ratio * 100);

    if (ratio < 0.5) {
      suggestions.push('Output does not appear to address the expected requirements. Review the task description.');
    }
  }

  for (const key of Object.keys(categories)) {
    categories[key] = Math.max(0, Math.min(100, categories[key]));
  }

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
    reviewer_model: 'deterministic-v1',
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
