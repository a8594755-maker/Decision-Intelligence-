/**
 * pythonToolExecutor.js — Calls ML API /execute-tool for LLM code generation + sandbox.
 *
 * Pure function: stepInput → { ok, artifacts, logs, error? }
 */

const ML_API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_ML_API_URL
  ? import.meta.env.VITE_ML_API_URL
  : 'http://localhost:8000';
const FETCH_TIMEOUT_MS = 180_000; // 3 minutes per ML API call
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000; // 1s → 4s → 16s exponential backoff

/**
 * Check if an HTTP error is retryable (server errors + network issues).
 * Client errors (4xx) are NOT retried — they indicate bad input.
 */
function _isRetryable(status) {
  return status >= 500 || status === 429; // 5xx server errors + rate limiting
}

/**
 * Sleep with exponential backoff: base * 4^attempt (1s, 4s, 16s).
 */
function _backoffDelay(attempt) {
  return RETRY_BASE_MS * Math.pow(4, attempt);
}

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint }
 * @param {object} stepInput.inputData - { sheets, priorArtifacts }
 * @param {object} stepInput.llmConfig - { provider, model, temperature, max_tokens }
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executePythonTool(stepInput) {
  const { step, inputData, llmConfig } = stepInput;
  const logs = [];

  logs.push(`[PythonExecutor] Calling /execute-tool for step: ${step.name}`);

  // Limit prior artifact data size to avoid massive payloads
  // Keep first 1000 rows per artifact for code execution accuracy
  const priorArtifacts = _limitArtifactRows(inputData.priorArtifacts || {}, 1000);

  // Merge step.input_args into the request so flags like analysis_mode / dataset
  // propagate to the Python API regardless of how the step was generated
  // (deep-analysis fast-path, LLM decomposition, or manual).
  const extraArgs = step.input_args || {};

  const requestBody = JSON.stringify({
    tool_hint: step.tool_hint,
    input_data: inputData.sheets ? { sheets: inputData.sheets } : inputData,
    llm_config: {
      provider: llmConfig.provider || 'anthropic',
      model: llmConfig.model || 'claude-sonnet-4-6',
      temperature: llmConfig.temperature ?? 0.1,
      max_tokens: llmConfig.max_tokens ?? 16384,
    },
    prior_artifacts: priorArtifacts,
    ...extraArgs,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const resp = await fetch(`${ML_API_BASE}/execute-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: requestBody,
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');

        // Retry on server errors / rate limiting, but not on client errors
        if (_isRetryable(resp.status) && attempt < MAX_RETRIES) {
          const delay = _backoffDelay(attempt);
          logs.push(`[PythonExecutor] HTTP ${resp.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        logs.push(`[PythonExecutor] HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
        return { ok: false, artifacts: [], logs, error: `ML API returned ${resp.status}: ${errorText.slice(0, 200)}` };
      }

      const result = await resp.json();
      logs.push(`[PythonExecutor] Result: ok=${result.ok}, artifacts=${result.artifacts?.length || 0}, ${result.execution_ms}ms, model=${result.llm_model || '?'}${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);

      if (!result.ok) {
        logs.push(`[PythonExecutor] Error: ${(result.error || '').slice(0, 200)}`);
        return { ok: false, artifacts: [], logs, error: result.error || 'execute-tool returned ok=false' };
      }

      // Attach execution metadata (code, model, timing) to artifacts for UI transparency
      const artifacts = result.artifacts || [];
      if (result.code) {
        const meta = {
          code: result.code,
          stdout: result.stdout || '',
          execution_ms: result.execution_ms,
          llm_model: result.llm_model,
          engine: 'Python (pandas/numpy/scipy)',
        };
        for (const art of artifacts) {
          art._executionMeta = meta;
        }
      }

      return { ok: true, artifacts, logs };
    } catch (err) {
      if (err.name === 'AbortError') {
        logs.push(`[PythonExecutor] Request timed out after ${FETCH_TIMEOUT_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        // Timeouts are retryable — ML API may be under heavy load
        if (attempt < MAX_RETRIES) {
          const delay = _backoffDelay(attempt);
          logs.push(`[PythonExecutor] Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return { ok: false, artifacts: [], logs, error: `ML API request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${MAX_RETRIES + 1} attempts)` };
      }

      // Network errors (ECONNREFUSED, DNS failure, etc.) — retryable
      if (attempt < MAX_RETRIES) {
        const delay = _backoffDelay(attempt);
        logs.push(`[PythonExecutor] Network error: ${err.message} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      logs.push(`[PythonExecutor] Network error: ${err.message} (all ${MAX_RETRIES + 1} attempts exhausted)`);
      return { ok: false, artifacts: [], logs, error: `ML API unreachable after ${MAX_RETRIES + 1} attempts: ${err.message}` };
    }
  }

  // Should not reach here, but safety net
  return { ok: false, artifacts: [], logs, error: 'Unexpected: retry loop exhausted without returning' };
}

/**
 * Limit rows in prior artifact data to prevent massive payloads.
 * The LLM prompt only uses samples, and for execution, a reasonable
 * subset is usually sufficient.
 */
function _limitArtifactRows(priorArtifacts, maxRows) {
  if (!priorArtifacts || typeof priorArtifacts !== 'object') return priorArtifacts;

  const limited = {};
  for (const [stepName, artifacts] of Object.entries(priorArtifacts)) {
    if (!Array.isArray(artifacts)) {
      limited[stepName] = artifacts;
      continue;
    }
    limited[stepName] = artifacts.map(art => {
      if (!art || typeof art !== 'object') return art;
      const data = art.data;
      if (Array.isArray(data) && data.length > maxRows) {
        return { ...art, data: data.slice(0, maxRows), _truncated: true, _originalRows: data.length };
      }
      return art;
    });
  }
  return limited;
}
