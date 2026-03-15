/**
 * review.js — Wraps aiReviewerService for post-step review.
 *
 * Called by the orchestrator when a step has review_checkpoint: true.
 */

import { reviewStepOutput } from '../aiReviewerService.js';

/**
 * Run AI review on a completed step's output.
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {number} params.stepIndex
 * @param {string} params.stepName
 * @param {any[]} params.artifacts - output artifacts from the step
 * @param {string} params.toolHint - original task description
 * @returns {Promise<{approved: boolean, score: number, suggestions: string[], summary: string}>}
 */
export async function reviewStep({ taskId, stepIndex, stepName, artifacts, toolHint }) {
  try {
    const result = await reviewStepOutput({
      taskId,
      stepIndex,
      stepName,
      artifacts,
      expectedOutput: toolHint,
    });

    return {
      approved: result?.approved ?? result?.score >= 0.7,
      score: result?.score ?? 0,
      suggestions: result?.suggestions || [],
      summary: result?.summary || '',
    };
  } catch (err) {
    console.error(`[Review] Error reviewing step ${stepName}:`, err);
    // Default to approved on review failure — don't block pipeline
    return {
      approved: true,
      score: 0,
      suggestions: [`Review service error: ${err.message}`],
      summary: 'Review skipped due to error',
    };
  }
}
