// @product: ai-employee
//
// selfHealingService.js
// ─────────────────────────────────────────────────────────────────────────────
// Analyzes step failures and chooses an intelligent healing strategy instead
// of blindly retrying the same operation.
//
// Strategies:
//   escalate_model   — switch LLM provider/tier (e.g. API down, rate limit)
//   revise_prompt    — add error context to prompt so LLM tries a different approach
//   simplify_task    — reduce scope (timeout, output too large)
//   skip_with_fallback — produce partial result + warning (last resort)
// ─────────────────────────────────────────────────────────────────────────────

import { listModels } from '../ai-infra/modelRoutingService';

// ── Error classification patterns ────────────────────────────────────────────

const ERROR_PATTERNS = [
  // Permission / configuration errors → non-recoverable, don't waste retries
  { re: /permission denied|lacks .+ for workflow|PermissionDenied/i,     category: 'permission_denied' },

  // Data dependency errors → non-recoverable, missing required input
  { re: /datasetProfileRow is required|dataset_profile_id is required/i, category: 'data_dependency_missing' },
  { re: /\w+ is required/i,                                             category: 'data_dependency_missing' },

  // Provider / API unavailability → switch provider
  { re: /unavailable|503|502|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i, category: 'llm_unavailable' },
  { re: /engine.+overloaded|currently overloaded|provider.+overloaded|service.+overloaded|server.+busy/i, category: 'provider_overloaded' },
  { re: /429|rate.?limit|too many requests|quota|throttl/i,              category: 'rate_limited' },
  { re: /api.?key|auth|unauthorized|401|403|forbidden/i,                 category: 'api_key_missing' },
  { re: /Unsupported provider/i,                                         category: 'provider_unsupported' },

  // Code generation / execution errors → revise prompt
  { re: /code generation|syntax|SyntaxError|ReferenceError|TypeError/i,  category: 'code_generation_failed' },
  { re: /KeyError|IndexError|NameError|AttributeError.*DataFrame/i,     category: 'code_generation_failed' },
  { re: /function run|undefined is not|cannot read prop/i,               category: 'code_generation_failed' },

  // Gate 1: Planner / LLM failures (before general patterns to avoid mis-classification)
  { re: /no (?:executor|tool|handler) found|unknown tool|tool.+not.+(?:found|registered|exist)/i, category: 'tool_not_found' },
  { re: /context.?(?:window|length|overflow)|token.?limit|max.?tokens|too many tokens/i,           category: 'context_overflow' },

  // Gate 2: Orchestrator / dependency failures
  { re: /artifact.+(?:null|undefined|missing)|dependency.+(?:missing|broken|failed)|prior.?step.+(?:failed|null)/i, category: 'dependency_chain_broken' },

  // Gate 4: Infrastructure failures (must come before general timeout)
  { re: /sse.+(?:disconnect|closed|lost)|EventSource|stream.+(?:ended|closed|aborted)/i,          category: 'sse_disconnected' },
  { re: /edge.?function.+(?:timeout|timed)|supabase.+(?:timeout|504)|504 gateway/i,               category: 'edge_function_timeout' },

  // Resource limits → simplify
  { re: /timed?\s*out|timeout|execution timed/i,                        category: 'timeout' },
  { re: /output too large|too many bytes|payload too large/i,            category: 'output_too_large' },

  // Sandbox errors
  { re: /sandbox|worker error|Worker/i,                                  category: 'sandbox_error' },
];

// ── Strategy selection ──────────────────────────────────────────────────────

/**
 * Classify the error message into a category.
 * @param {string} errorMessage
 * @returns {string} error category
 */
export function classifyError(errorMessage) {
  if (!errorMessage) return 'unknown';
  for (const { re, category } of ERROR_PATTERNS) {
    if (re.test(errorMessage)) return category;
  }
  return 'unknown';
}

/**
 * Choose the best healing strategy based on error category, retry count, and available context.
 *
 * @param {string} errorMessage – The error from the failed step
 * @param {object} step – The step object (has retry_count, _revision_log, workflow_type, etc.)
 * @param {number} retryCount – Current retry count (1-based, already incremented)
 * @returns {object} healingResult
 */
export function chooseHealingStrategy(errorMessage, step, retryCount) {
  const category = classifyError(errorMessage);
  const hasRevisionSuggestions = step._revision_log?.length > 0 &&
    step._revision_log[step._revision_log.length - 1]?.suggestions?.length > 0;

  // Non-recoverable errors → immediately block, don't waste retries
  if (category === 'permission_denied') {
    return {
      errorCategory: category,
      healingStrategy: 'block_immediately',
      modifications: {},
      reasoning: `Permission denied — cannot be fixed by retrying. Employee needs permission update.`,
    };
  }

  if (category === 'data_dependency_missing') {
    return {
      errorCategory: category,
      healingStrategy: 'block_immediately',
      modifications: {},
      reasoning: `Missing required data dependency — retrying won't help. The task needs a dataset profile or required input that was not provided.`,
    };
  }

  // Gate 1: Tool not found / hallucinated → non-recoverable
  if (category === 'tool_not_found') {
    return {
      errorCategory: category,
      healingStrategy: 'block_immediately',
      modifications: {},
      reasoning: `Tool not found — the planner referenced a non-existent tool. Replanning required.`,
    };
  }

  // Gate 1: Context overflow → simplify
  if (category === 'context_overflow') {
    return {
      errorCategory: category,
      healingStrategy: 'simplify_task',
      modifications: {
        simplifiedHint: 'Reduce input data size. Use dataset profile summary instead of raw rows. Limit context to key fields only.',
      },
      reasoning: `Context window exceeded — reducing input data to fit within token limits.`,
    };
  }

  // Gate 2: Dependency chain broken → non-recoverable
  if (category === 'dependency_chain_broken') {
    return {
      errorCategory: category,
      healingStrategy: 'block_immediately',
      modifications: {},
      reasoning: `A prior step's artifact is missing or malformed — this step cannot proceed without its dependency.`,
    };
  }

  // Gate 4: SSE disconnected → escalate (retry with reconnect)
  if (category === 'sse_disconnected') {
    return {
      errorCategory: category,
      healingStrategy: 'escalate_model',
      modifications: {},
      reasoning: `SSE connection lost — backend may still be running. Retrying with fresh connection.`,
    };
  }

  // Gate 4: Edge function timeout → simplify
  if (category === 'edge_function_timeout') {
    return {
      errorCategory: category,
      healingStrategy: 'simplify_task',
      modifications: {
        simplifiedHint: 'Break into smaller sub-tasks. Reduce data payload sent to edge function. Consider chunked processing.',
      },
      reasoning: `Supabase Edge Function timed out — reducing payload size.`,
    };
  }

  // Last retry → skip with fallback (don't waste it on same strategy)
  if (retryCount >= 2) {
    return {
      errorCategory: category,
      healingStrategy: 'skip_with_fallback',
      modifications: {},
      reasoning: `Retry ${retryCount}/3 — last attempt, using fallback to produce partial result`,
    };
  }

  // Unsupported provider → switch to a different provider immediately
  if (category === 'provider_unsupported') {
    return {
      errorCategory: category,
      healingStrategy: 'escalate_model',
      modifications: {},
      reasoning: `${category} — provider not available in this mode, switching provider`,
    };
  }

  // Provider/API issues → switch provider
  if (category === 'llm_unavailable' || category === 'provider_overloaded' || category === 'rate_limited' || category === 'api_key_missing') {
    return {
      errorCategory: category,
      healingStrategy: 'escalate_model',
      modifications: {},
      reasoning: `${category} — switching to a different LLM provider`,
    };
  }

  // Code generation failures → revise prompt with error context
  if (category === 'code_generation_failed' || category === 'sandbox_error') {
    const promptSuffix = hasRevisionSuggestions
      ? step._revision_log[step._revision_log.length - 1].suggestions.join('; ')
      : `The previous code failed with: ${errorMessage}. Try a simpler, more robust approach.`;

    return {
      errorCategory: category,
      healingStrategy: 'revise_prompt',
      modifications: { promptSuffix },
      reasoning: `${category} — revising prompt with error context`,
    };
  }

  // Timeout / output too large → simplify
  if (category === 'timeout' || category === 'output_too_large') {
    const simplifiedHint = step.tool_hint
      ? `${step.tool_hint} [SIMPLIFIED: Process less data, use sampling, limit output to key metrics only]`
      : 'Produce a concise summary with key metrics only. Limit processing to first 100 rows if needed.';

    return {
      errorCategory: category,
      healingStrategy: 'simplify_task',
      modifications: { simplifiedHint },
      reasoning: `${category} — simplifying task scope to fit within limits`,
    };
  }

  // Unknown errors: first retry → revise prompt, second → escalate
  // Note: retryCount is already incremented before this call, so first failure = 1
  if (retryCount <= 1) {
    return {
      errorCategory: category,
      healingStrategy: 'revise_prompt',
      modifications: {
        promptSuffix: `Previous attempt failed with error: ${errorMessage}. Please try a different, more robust approach.`,
      },
      reasoning: `Unknown error — revising prompt on first retry`,
    };
  }

  return {
    errorCategory: category,
    healingStrategy: 'escalate_model',
    modifications: {},
    reasoning: `Unknown error — escalating model on retry ${retryCount}`,
  };
}

// ── Model escalation helpers ─────────────────────────────────────────────────

/**
 * Get a different provider/model from the one that failed.
 * Tries same tier first (different provider), then escalates tier.
 *
 * @param {string} failedProvider – The provider that failed
 * @param {string} failedModel – The model that failed
 * @param {string} taskType – For policy lookup
 * @returns {Promise<{ provider: string, model_name: string } | null>}
 */
export async function getAlternativeModel(failedProvider, failedModel, _taskType) {
  // 1. Try different provider in same tier
  try {
    const allModels = await listModels({});
    const failedEntry = allModels.find(m => m.model_name === failedModel || m.provider === failedProvider);
    const failedTier = failedEntry?.capability_tier || 'tier_a';

    // Same tier, different provider
    const sameTier = allModels.filter(m =>
      m.capability_tier === failedTier && m.provider !== failedProvider
    );
    if (sameTier.length > 0) {
      return { provider: sameTier[0].provider, model_name: sameTier[0].model_name };
    }

    // Escalate to higher tier
    const tierOrder = ['tier_a', 'tier_b', 'tier_c'];
    const currentIdx = tierOrder.indexOf(failedTier);
    for (let i = 0; i < tierOrder.length; i++) {
      if (i === currentIdx) continue;
      const candidates = allModels.filter(m =>
        m.capability_tier === tierOrder[i] && m.provider !== failedProvider
      );
      if (candidates.length > 0) {
        return { provider: candidates[0].provider, model_name: candidates[0].model_name };
      }
    }

    // Any model that's not the failed one
    const any = allModels.filter(m => m.model_name !== failedModel);
    if (any.length > 0) {
      return { provider: any[0].provider, model_name: any[0].model_name };
    }
  } catch (err) {
    console.warn('[selfHealingService] getAlternativeModel failed:', err?.message);
  }

  return null;
}

/**
 * Main entry point: analyze a step failure and return a healing plan.
 *
 * @param {Error|string} error – The error object or message
 * @param {object} step – The step that failed
 * @param {number} retryCount – Current retry count (already incremented)
 * @returns {{ errorCategory: string, healingStrategy: string, modifications: object, reasoning: string }}
 */
export function analyzeStepFailure(error, step, retryCount) {
  const errorMessage = typeof error === 'string' ? error : error?.message || String(error);
  return chooseHealingStrategy(errorMessage, step, retryCount);
}
