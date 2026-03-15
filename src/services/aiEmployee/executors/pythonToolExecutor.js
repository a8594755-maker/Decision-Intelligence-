/**
 * pythonToolExecutor.js — Calls ML API /execute-tool for LLM code generation + sandbox.
 *
 * Pure function: stepInput → { ok, artifacts, logs, error? }
 */

const ML_API_BASE = 'http://localhost:8000';
const FETCH_TIMEOUT_MS = 180_000; // 3 minutes per ML API call

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

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(`${ML_API_BASE}/execute-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        tool_hint: step.tool_hint,
        input_data: inputData.sheets ? { sheets: inputData.sheets } : inputData,
        llm_config: {
          provider: llmConfig.provider || 'anthropic',
          model: llmConfig.model || 'claude-sonnet-4-6',
          temperature: llmConfig.temperature ?? 0.1,
          max_tokens: llmConfig.max_tokens ?? 16384,
        },
        prior_artifacts: priorArtifacts,
      }),
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      logs.push(`[PythonExecutor] HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
      return { ok: false, artifacts: [], logs, error: `ML API returned ${resp.status}: ${errorText.slice(0, 200)}` };
    }

    const result = await resp.json();
    logs.push(`[PythonExecutor] Result: ok=${result.ok}, artifacts=${result.artifacts?.length || 0}, ${result.execution_ms}ms, model=${result.llm_model || '?'}`);

    if (!result.ok) {
      logs.push(`[PythonExecutor] Error: ${(result.error || '').slice(0, 200)}`);
      return { ok: false, artifacts: [], logs, error: result.error || 'execute-tool returned ok=false' };
    }

    return {
      ok: true,
      artifacts: result.artifacts || [],
      logs,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      logs.push(`[PythonExecutor] Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      return { ok: false, artifacts: [], logs, error: `ML API request timed out after ${FETCH_TIMEOUT_MS / 1000}s` };
    }
    logs.push(`[PythonExecutor] Network error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: `ML API unreachable: ${err.message}` };
  }
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
