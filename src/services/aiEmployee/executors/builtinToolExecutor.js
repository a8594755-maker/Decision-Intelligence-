/**
 * builtinToolExecutor.js — Executes built-in DI engines from the catalog.
 *
 * Pure function: stepInput → { ok, artifacts, logs, error? }
 * No state mutation, no DB calls, no event emission.
 */

import { BUILTIN_TOOLS, isPythonApiTool } from '../../builtinToolCatalog.js';

function toImportPath(modulePath) {
  const normalized = modulePath.replace(/^\.\//, '');
  return `../../${normalized}${normalized.endsWith('.js') ? '' : '.js'}`;
}

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint, builtin_tool_id, tool_type }
 * @param {object} stepInput.inputData - { sheets, priorArtifacts, datasetProfileRow, userId }
 * @param {object} stepInput.llmConfig - { provider, model, temperature, max_tokens }
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executeBuiltinTool(stepInput) {
  const { step, inputData } = stepInput;
  const logs = [];
  const toolId = step.builtin_tool_id;

  if (!toolId) {
    return { ok: false, artifacts: [], logs, error: 'No builtin_tool_id specified in step' };
  }

  const catalogEntry = BUILTIN_TOOLS.find(t => t.id === toolId);
  if (!catalogEntry) {
    return { ok: false, artifacts: [], logs, error: `Tool '${toolId}' not found in catalog` };
  }

  // ── Python API tools → call specific ML API endpoint ──
  if (isPythonApiTool(toolId)) {
    const methodParts = (catalogEntry.method || '').match(/^(POST|GET|PUT|DELETE)\s+(.+)$/i);
    if (!methodParts) {
      return { ok: false, artifacts: [], logs, error: `Invalid __python_api__ method format: '${catalogEntry.method}'` };
    }
    const [, httpMethod, apiPath] = methodParts;
    const ML_API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_ML_API_URL
      ? import.meta.env.VITE_ML_API_URL : 'http://localhost:8000';

    logs.push(`[BuiltinExecutor] Calling Python API: ${httpMethod} ${ML_API_BASE}${apiPath} (tool: ${toolId})`);

    try {
      const args = {
        userId: inputData.userId,
        datasetProfileRow: inputData.datasetProfileRow,
        settings: inputData.settings || {},
        ...(inputData.priorArtifacts ? { priorArtifacts: inputData.priorArtifacts } : {}),
        ...(inputData.sheets ? { sheets: inputData.sheets } : {}),
        ...(step.input_args || {}),
        // SSE context for real-time code display during execution
        task_id: stepInput.taskId || null,
        step_name: step.name || null,
        step_index: stepInput.stepIndex ?? null,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180_000);
      const resp = await fetch(`${ML_API_BASE}${apiPath}`, {
        method: httpMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'Unknown');
        logs.push(`[BuiltinExecutor] Python API ${resp.status}: ${errText.slice(0, 200)}`);
        return { ok: false, artifacts: [], logs, error: `Python API ${resp.status}: ${errText.slice(0, 200)}` };
      }

      const result = await resp.json();
      const artifacts = result?.artifacts || result?.artifact_refs || [];
      // Attach Python code to artifacts for UI transparency
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
      logs.push(`[BuiltinExecutor] Python API completed. Artifacts: ${artifacts.length}`);
      return {
        ok: true, artifacts, logs,
        code: result.code || null,
        code_language: 'python',
        stdout: result.stdout || null,
        stderr: result.stderr || null,
        execution_ms: result.execution_ms,
        llm_model: result.llm_model,
        llm_provider: result.llm_provider,
      };
    } catch (err) {
      logs.push(`[BuiltinExecutor] Python API error: ${err.message}`);
      return { ok: false, artifacts: [], logs, error: `Python API error: ${err.message}` };
    }
  }

  logs.push(`[BuiltinExecutor] Loading module: ${catalogEntry.module}`);

  try {
    // Dynamic import of the tool's module
    const mod = await import(/* @vite-ignore */ toImportPath(catalogEntry.module));
    const fn = mod[catalogEntry.method];

    if (typeof fn !== 'function') {
      return {
        ok: false, artifacts: [], logs,
        error: `Method '${catalogEntry.method}' not found in module '${catalogEntry.module}'`,
      };
    }

    logs.push(`[BuiltinExecutor] Calling ${catalogEntry.method}()`);

    // Build args from inputData — pass through what the method expects
    const args = {
      userId: inputData.userId,
      datasetProfileRow: inputData.datasetProfileRow,
      settings: inputData.settings || {},
      ...(inputData.priorArtifacts ? { priorArtifacts: inputData.priorArtifacts } : {}),
      ...(inputData.sheets ? { sheets: inputData.sheets } : {}),
      ...(step.input_args || {}),
    };

    // Wrap analysis functions with methodology capture (SQL queries + data sources)
    const isAnalysisTool = catalogEntry.output_artifacts?.includes('analysis_result');
    let wrappedFn = fn;
    if (isAnalysisTool && mod.withMethodology) {
      wrappedFn = mod.withMethodology(fn);
    }

    const result = await wrappedFn(args);

    // If the tool explicitly returned success: false, propagate as failure
    if (result && result.success === false) {
      const errMsg = result.error || result.hint || 'Tool returned success: false';
      logs.push(`[BuiltinExecutor] Tool returned success=false: ${errMsg}`);
      return { ok: false, artifacts: [], logs, error: errMsg };
    }

    // Normalize result — DI engines return various shapes
    let artifacts = result?.artifacts || result?.artifact_refs || [];

    // If no explicit artifacts but result has data, wrap it as a typed artifact
    if (artifacts.length === 0 && result && typeof result === 'object') {
      // Detect report shape (from reportGeneratorService.generateReport)
      if (result.blob && result.format && result.filename) {
        artifacts = [{
          artifact_type: result.format === 'html' ? 'report_html' : 'report_file',
          label: result.filename,
          data: { html: result.blob, filename: result.filename, format: result.format },
          artifact_ref: result.artifact_ref || null,
        }];
      } else {
        // Detect analysis_result shape
        const isAnalysisResult = result.analysisType && result.metrics;
        artifacts = [{
          artifact_type: isAnalysisResult ? 'analysis_result' : 'table',
          label: result.title || catalogEntry.name || toolId,
          data: result,
        }];
      }
    }
    logs.push(`[BuiltinExecutor] Completed. Artifacts: ${artifacts.length}`);

    return { ok: true, artifacts, logs };
  } catch (err) {
    logs.push(`[BuiltinExecutor] Error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: err.message };
  }
}
