// @product: ai-employee
//
// dynamicToolExecutor.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates and executes AI-authored code for `dynamic_tool` workflow steps.
//
// Flow:
//   1. Tier A model generates a self-contained JS function
//   2. sandboxRunner executes in a restricted Web Worker
//   3. Output is captured as artifacts via artifactStore
//   4. execution_log records code, I/O hashes, timing, errors
//
// For `registered_tool` steps, loads code from toolRegistryService and
// runs in the same sandbox (skipping generation).
// ─────────────────────────────────────────────────────────────────────────────

import { runInSandbox } from './sandboxRunner';
import { getToolById, incrementUsage, hashCode } from './toolRegistryService';
import { callLLM } from './aiEmployeeLLMService';

// ── Constants ────────────────────────────────────────────────────────────────

const SANDBOX_TIMEOUT_MS = 30_000;
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

// ── Code generation prompt builder ───────────────────────────────────────────

/**
 * Build a prompt for the LLM to generate tool code.
 * In production this would call resolveModel('dynamic_tool_generation').
 * For now, returns a prompt string for documentation/future use.
 */
export function buildGenerationPrompt({ toolHint, priorArtifacts, datasetProfile, revisionInstructions }) {
  const parts = [
    'You are a data science tool builder.',
    'Generate a self-contained JavaScript function named `run` that accepts an `input` object and returns `{ result, artifacts, metadata }`.',
    '',
    '## Task',
    toolHint || 'Build a general-purpose data analysis tool.',
    '',
  ];

  if (datasetProfile) {
    parts.push('## Available Data');
    parts.push(`Dataset columns: ${JSON.stringify(datasetProfile.columns || datasetProfile.column_names || [])}`);
    if (datasetProfile.sample_rows) {
      parts.push(`Sample rows: ${JSON.stringify(datasetProfile.sample_rows.slice(0, 3))}`);
    }
    parts.push('');
  }

  if (priorArtifacts && Object.keys(priorArtifacts).length > 0) {
    parts.push('## Prior Step Outputs');
    for (const [step, refs] of Object.entries(priorArtifacts)) {
      parts.push(`Step "${step}": ${JSON.stringify(refs).slice(0, 500)}`);
    }
    parts.push('');
  }

  if (revisionInstructions?.length) {
    parts.push('## REVISION INSTRUCTIONS (from prior review)');
    revisionInstructions.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
    parts.push('');
  }

  parts.push('## Constraints');
  parts.push('- Only use Math, Date, JSON, Array, Map, Set, Object built-ins.');
  parts.push('- No fetch, DOM, localStorage, or external imports.');
  parts.push('- Return { result: <main output>, artifacts: [{ type, label, data }], metadata: { description } }.');
  parts.push('- Handle edge cases (empty input, missing fields) gracefully.');

  return parts.join('\n');
}

// ── LLM Code Generation ──────────────────────────────────────────────────────

/**
 * Call LLM to generate tool code. Returns null if LLM is unavailable.
 */
async function _generateCodeViaLLM({ toolHint, priorArtifacts, datasetProfile, revisionInstructions, trackingMeta }) {
  if (!_hasAuth()) return null;

  try {
    const prompt = buildGenerationPrompt({ toolHint, priorArtifacts, datasetProfile, revisionInstructions });

    const { text, model } = await callLLM({
      taskType: 'dynamic_tool_generation',
      prompt,
      systemPrompt: 'You are a code generator. Respond with ONLY valid JavaScript code. Do not include markdown fences or explanation. The code must define an exported function: export function run(input) { ... }',
      maxTokens: 8192,
      trackingMeta: trackingMeta || {},
    });

    if (!text) return null;

    // Strip markdown fences if present
    let code = text;
    const fenceMatch = code.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
    if (fenceMatch) code = fenceMatch[1].trim();

    // Basic validation: must contain 'function run' or 'export function run'
    if (!code.includes('function run')) {
      console.warn('[dynamicToolExecutor] LLM generated code without run() function');
      return null;
    }

    console.info(`[dynamicToolExecutor] Code generated via ${model} (${code.length} chars)`);
    return { code, model };
  } catch (err) {
    console.warn('[dynamicToolExecutor] LLM code generation failed:', err?.message);
    return null;
  }
}

/**
 * Generate code via LLM and execute in sandbox (full pipeline).
 *
 * @param {object} opts
 * @param {string} opts.toolHint – Description of what to build
 * @param {object} [opts.inputData] – Data to pass to run()
 * @param {object} [opts.priorArtifacts] – From previous steps
 * @param {object} [opts.datasetProfile] – Dataset metadata
 * @param {string[]} [opts.revisionInstructions] – Reviewer feedback
 * @param {object} [opts.trackingMeta] – For cost tracking
 * @returns {Promise<DynamicToolResult>}
 */
export async function generateCodeAndExecute({
  toolHint,
  inputData = {},
  priorArtifacts = {},
  datasetProfile = null,
  revisionInstructions = [],
  trackingMeta = {},
}) {
  // Step 1: Generate code via LLM
  const generated = await _generateCodeViaLLM({
    toolHint, priorArtifacts, datasetProfile, revisionInstructions, trackingMeta,
  });

  if (!generated) {
    return {
      code: null,
      output: null,
      artifact_refs: [],
      execution_log: { status: 'error', error: 'LLM code generation unavailable or failed' },
      error: 'LLM code generation unavailable',
      duration_ms: 0,
    };
  }

  // Step 2: Execute the generated code
  const result = await generateAndExecuteTool({
    code: generated.code,
    toolHint,
    inputData,
    priorArtifacts,
    revisionInstructions,
  });

  result.execution_log.generator_model = generated.model;
  return result;
}

// ── Dynamic tool execution ───────────────────────────────────────────────────

/**
 * Execute a dynamic tool with pre-generated code.
 *
 * @param {object} opts
 * @param {string} opts.code – Generated JS code (must define `function run(input)`)
 * @param {string} opts.toolHint – What the tool should do
 * @param {object} [opts.inputData] – Data to pass to run()
 * @param {object} [opts.priorArtifacts] – Chained from previous steps
 * @param {string[]} [opts.revisionInstructions] – Feedback from AI reviewer
 * @returns {Promise<DynamicToolResult>}
 */
export async function generateAndExecuteTool({
  code,
  toolHint = '',
  inputData = {},
  priorArtifacts = {},
  revisionInstructions = [],
}) {
  const startMs = Date.now();

  const executionLog = {
    tool_hint: toolHint,
    code_hash: await hashCode(code),
    code_length: code.length,
    revision_instructions: revisionInstructions,
    input_keys: Object.keys(inputData),
    started_at: new Date().toISOString(),
    sandbox_timeout_ms: SANDBOX_TIMEOUT_MS,
  };

  // Build sandbox input
  const sandboxInput = {
    ...inputData,
    _prior_artifacts: priorArtifacts,
  };

  // Execute in sandbox
  const sandboxResult = await runInSandbox(code, sandboxInput, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  executionLog.duration_ms = sandboxResult.durationMs;
  executionLog.stdout = sandboxResult.stdout || '';
  executionLog.stderr = sandboxResult.stderr || '';
  executionLog.timed_out = sandboxResult.timedOut || false;

  // Process result
  if (sandboxResult.result === null && sandboxResult.stderr) {
    executionLog.status = 'error';
    executionLog.error = sandboxResult.stderr;

    return {
      code,
      output: null,
      artifact_refs: [],
      execution_log: executionLog,
      error: sandboxResult.stderr,
      duration_ms: Date.now() - startMs,
    };
  }

  // Extract structured output
  const rawResult = sandboxResult.result || {};
  const artifacts = rawResult.artifacts || [];
  const metadata = rawResult.metadata || {};

  // Build artifact refs (in production these would go through artifactStore)
  const artifactRefs = artifacts.map((a, i) => ({
    type: a.type || 'dynamic_tool_output',
    label: a.label || `dynamic_output_${i}`,
    inline: true,
    data: a.data,
  }));

  executionLog.status = 'success';
  executionLog.output_keys = Object.keys(rawResult);
  executionLog.artifacts_count = artifactRefs.length;
  executionLog.output_hash = await hashCode(JSON.stringify(rawResult.result ?? ''));

  return {
    code,
    output: {
      result: rawResult.result,
      metadata,
      summary: metadata.description || `Dynamic tool completed: ${toolHint}`,
      artifact_refs: artifactRefs,
    },
    artifact_refs: artifactRefs,
    execution_log: executionLog,
    duration_ms: Date.now() - startMs,
  };
}

// ── Registered tool execution ────────────────────────────────────────────────

/**
 * Execute a previously approved tool from the registry.
 *
 * @param {string} toolId
 * @param {object} inputContext
 * @returns {Promise<DynamicToolResult>}
 */
export async function executeRegisteredTool(toolId, inputContext = {}) {
  const tool = await getToolById(toolId);
  if (!tool) {
    return {
      code: null,
      output: null,
      artifact_refs: [],
      execution_log: { status: 'error', error: `Tool ${toolId} not found` },
      error: `Tool ${toolId} not found in registry`,
      duration_ms: 0,
    };
  }

  if (tool.status !== 'active') {
    return {
      code: tool.code,
      output: null,
      artifact_refs: [],
      execution_log: { status: 'error', error: `Tool ${toolId} is ${tool.status}` },
      error: `Tool ${toolId} is ${tool.status}, not active`,
      duration_ms: 0,
    };
  }

  // Execute the registered code in sandbox
  const result = await generateAndExecuteTool({
    code: tool.code,
    toolHint: tool.description || tool.name,
    inputData: inputContext,
  });

  // Track usage
  try { await incrementUsage(toolId); } catch { /* best-effort */ }

  // Annotate execution log
  result.execution_log.tool_id = toolId;
  result.execution_log.tool_name = tool.name;
  result.execution_log.tool_category = tool.category;

  return result;
}
