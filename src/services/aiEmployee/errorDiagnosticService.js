// @product: ai-employee
//
// errorDiagnosticService.js
// ─────────────────────────────────────────────────────────────────────────────
// LLM-driven error diagnosis for failed steps.
//
// When a step fails after max retries, this service calls the LLM to:
//   1. Analyze the error message + step context + retry history
//   2. Identify the root cause (not just regex classification)
//   3. Generate actionable suggestions for the user
//
// Falls back to template-based diagnosis if LLM is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

import { classifyError } from '../selfHealingService';

// ── LLM call (lazy import to avoid circular deps) ──────────────────────────

let _invokeAiProxy = null;
async function getInvokeAiProxy() {
  if (!_invokeAiProxy) {
    const mod = await import('../aiProxyService.js');
    _invokeAiProxy = mod.invokeAiProxy;
  }
  return _invokeAiProxy;
}

// ── Template-based fallback suggestions ────────────────────────────────────

const TEMPLATE_SUGGESTIONS = {
  permission_denied: [
    { action: 'update_permissions', detail: 'Grant the required permissions to this worker in the Policy Rules page.' },
  ],
  data_dependency_missing: [
    { action: 'upload_data', detail: 'Upload the required dataset (e.g., demand, inventory, or supplier data).' },
    { action: 'set_default', detail: 'Configure default values in Settings to allow planning with partial data.' },
  ],
  llm_unavailable: [
    { action: 'wait_retry', detail: 'The AI provider is temporarily unavailable. Try again in a few minutes.' },
    { action: 'switch_provider', detail: 'Switch to a different AI model in Settings > Model Configuration.' },
  ],
  rate_limited: [
    { action: 'wait_retry', detail: 'API rate limit hit. Wait 1-2 minutes and retry.' },
  ],
  api_key_missing: [
    { action: 'configure_key', detail: 'Set up the API key in Supabase secrets or .env.local.' },
  ],
  code_generation_failed: [
    { action: 'simplify_request', detail: 'Try a simpler, more specific request so the AI can generate better code.' },
    { action: 'provide_example', detail: 'Include an example of the expected output format in your prompt.' },
  ],
  timeout: [
    { action: 'reduce_data', detail: 'Upload a smaller dataset or filter to fewer SKUs/plants.' },
    { action: 'simplify_request', detail: 'Break the task into smaller steps (e.g., forecast first, then plan).' },
  ],
  output_too_large: [
    { action: 'reduce_scope', detail: 'Limit the analysis to key materials or a shorter time range.' },
  ],
  sandbox_error: [
    { action: 'retry', detail: 'A sandbox execution error occurred. Retry — it may be transient.' },
  ],
  tool_not_found: [
    { action: 'simplify_request', detail: 'The AI planner referenced a tool that does not exist. Try rephrasing your request with simpler, more specific instructions.' },
    { action: 'retry', detail: 'Retry the task — the planner may choose a valid tool on the next attempt.' },
  ],
  context_overflow: [
    { action: 'reduce_data', detail: 'The input data is too large for the AI context window. Upload a smaller dataset or filter to fewer SKUs/plants.' },
    { action: 'simplify_request', detail: 'Break the task into smaller steps (e.g., forecast first, then plan) to reduce context size.' },
  ],
  dependency_chain_broken: [
    { action: 'retry', detail: 'A prior step produced missing or invalid output. Retry the entire task to regenerate the dependency chain.' },
    { action: 'upload_data', detail: 'If the missing data is a dataset, upload it manually and re-run.' },
  ],
  sse_disconnected: [
    { action: 'retry', detail: 'The real-time connection was lost. Refresh the page and retry — the backend task may have completed.' },
  ],
  edge_function_timeout: [
    { action: 'reduce_data', detail: 'The Supabase Edge Function timed out. Reduce the dataset size or split into smaller batches.' },
    { action: 'wait_retry', detail: 'The server may be under heavy load. Wait a minute and retry.' },
  ],
  unknown: [
    { action: 'retry', detail: 'An unexpected error occurred. Try again or rephrase your request.' },
    { action: 'contact_support', detail: 'If the error persists, check the error details and contact support.' },
  ],
};

// ── Diagnosis prompt ───────────────────────────────────────────────────────

const DIAGNOSIS_SYSTEM_PROMPT = `You are a supply chain AI system diagnostician. A task step failed after retrying. Analyze the error and produce a diagnosis.

Output ONLY valid JSON with this structure:
{
  "root_cause": "One sentence explaining WHY this failed, in plain language the user can understand",
  "category": "one of: data_missing, code_error, api_error, permission_error, resource_limit, configuration_error, unknown",
  "severity": "one of: recoverable, needs_user_action, critical",
  "suggestions": [
    { "action": "action_keyword", "detail": "Specific actionable instruction for the user" }
  ],
  "confidence": 0.0-1.0
}

Rules:
- Be specific about WHAT data/field/config is missing, not generic
- Suggestions must be actionable (upload X, change Y, wait Z)
- If error mentions a column name, tell user which column is needed
- If error is about API/network, suggest waiting or switching provider
- Maximum 3 suggestions, ordered by likelihood of fixing the issue
- confidence: 0.9+ if error is clear, 0.5-0.8 if ambiguous, <0.5 if guessing`;

function buildDiagnosisPrompt({ step, errorMessage, retryHistory, taskContext }) {
  const parts = [`## Failed Step\nName: ${step.step_name || 'unknown'}\nType: ${step.tool_type || step.workflow_type || 'unknown'}`];

  if (step.tool_hint) parts.push(`Tool Hint: ${step.tool_hint}`);

  parts.push(`\n## Error Message\n${(errorMessage || 'No error message').slice(0, 1500)}`);

  if (retryHistory && retryHistory.length > 0) {
    parts.push(`\n## Retry History (${retryHistory.length} attempts)\n${retryHistory.map((r, i) => `Attempt ${i + 1}: ${r}`).join('\n')}`);
  }

  if (taskContext) {
    const ctx = typeof taskContext === 'string' ? taskContext : JSON.stringify(taskContext).slice(0, 800);
    parts.push(`\n## Task Context\n${ctx}`);
  }

  return parts.join('\n');
}

// ── Main diagnosis function ────────────────────────────────────────────────

/**
 * Diagnose a step failure using LLM analysis.
 * Falls back to template-based diagnosis if LLM is unavailable.
 *
 * @param {object} params
 * @param {object} params.step - The failed step record
 * @param {string} params.errorMessage - The error message
 * @param {string[]} [params.retryHistory] - Previous retry error/instruction messages
 * @param {object} [params.taskContext] - Task input_context for additional context
 * @returns {Promise<ErrorDiagnosis>}
 */
export async function diagnoseStepFailure({ step, errorMessage, retryHistory, taskContext }) {
  const category = classifyError(errorMessage);
  const startMs = Date.now();

  // Try LLM diagnosis
  try {
    const invokeAiProxy = await getInvokeAiProxy();
    const prompt = buildDiagnosisPrompt({ step, errorMessage, retryHistory, taskContext });

    const result = await invokeAiProxy('di_prompt', {
      prompt,
      system: DIAGNOSIS_SYSTEM_PROMPT,
      provider: 'deepseek',
      temperature: 0.2,
      max_tokens: 512,
    }, { timeoutMs: 15_000 });

    const text = result?.text || '';
    const parsed = _parseJson(text);

    if (parsed && parsed.root_cause) {
      return {
        root_cause: String(parsed.root_cause).slice(0, 500),
        category: parsed.category || category,
        severity: parsed.severity || 'needs_user_action',
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        source: 'llm',
        diagnosis_ms: Date.now() - startMs,
        step_name: step.step_name,
        retry_count: retryHistory?.length || 0,
        error_snippet: (errorMessage || '').slice(0, 300),
      };
    }
  } catch (err) {
    console.warn('[errorDiagnosticService] LLM diagnosis failed, using template fallback:', err?.message);
  }

  // Template fallback
  return buildTemplateDiagnosis({ step, errorMessage, category, retryHistory, startMs });
}

// ── Template fallback ──────────────────────────────────────────────────────

function buildTemplateDiagnosis({ step, errorMessage, category, retryHistory, startMs }) {
  const suggestions = TEMPLATE_SUGGESTIONS[category] || TEMPLATE_SUGGESTIONS.unknown;

  const rootCauseMap = {
    permission_denied: `Step "${step.step_name}" was blocked due to insufficient permissions.`,
    data_dependency_missing: `Step "${step.step_name}" requires data that was not provided or is incomplete.`,
    llm_unavailable: `The AI service was unreachable during step "${step.step_name}".`,
    rate_limited: `The AI service rate limit was exceeded during step "${step.step_name}".`,
    api_key_missing: `API authentication failed for step "${step.step_name}".`,
    code_generation_failed: `The AI-generated code for step "${step.step_name}" had errors that could not be auto-fixed.`,
    timeout: `Step "${step.step_name}" exceeded the time limit — the data may be too large.`,
    output_too_large: `Step "${step.step_name}" produced output exceeding size limits.`,
    sandbox_error: `Step "${step.step_name}" encountered a sandbox execution error.`,
    tool_not_found: `Step "${step.step_name}" references a tool that does not exist in the system catalog.`,
    context_overflow: `Step "${step.step_name}" exceeded the AI model's context window — the input data is too large.`,
    dependency_chain_broken: `Step "${step.step_name}" depends on output from a prior step that is missing or malformed.`,
    sse_disconnected: `The real-time connection was lost during step "${step.step_name}". The backend may still be running.`,
    edge_function_timeout: `The Supabase Edge Function timed out during step "${step.step_name}" — the payload may be too large.`,
    unknown: `Step "${step.step_name}" failed with an unexpected error.`,
  };

  return {
    root_cause: rootCauseMap[category] || rootCauseMap.unknown,
    category,
    severity: ['permission_denied', 'api_key_missing', 'tool_not_found', 'dependency_chain_broken'].includes(category)
      ? 'critical'
      : ['sse_disconnected', 'timeout', 'edge_function_timeout'].includes(category)
        ? 'recoverable'
        : 'needs_user_action',
    suggestions,
    confidence: 0.5,
    source: 'template',
    diagnosis_ms: Date.now() - startMs,
    step_name: step.step_name,
    retry_count: retryHistory?.length || 0,
    error_snippet: (errorMessage || '').slice(0, 300),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _parseJson(text) {
  if (!text) return null;
  // Try direct parse
  try { return JSON.parse(text); } catch { /* continue */ }
  // Extract JSON from markdown fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch { /* continue */ }
  // Extract first {...}
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) try { return JSON.parse(braced[0]); } catch { /* continue */ }
  return null;
}
