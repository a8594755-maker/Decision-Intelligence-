/**
 * claudeSdkAdapter.js — Bridge between Claude Agent SDK and the DI orchestrator.
 *
 * Exposes all 60+ builtin tools as SDK custom tools via createSdkMcpServer(),
 * enforces gate pipeline via PreToolUse hooks, and captures artifacts via PostToolUse hooks.
 *
 * Usage:
 *   Set DI_AGENT_RUNTIME=claude-sdk (or VITE_DI_AGENT_RUNTIME=claude-sdk) to activate.
 *   Requires ANTHROPIC_API_KEY env var.
 *   Optional: VITE_CLAUDE_SDK_MODEL (default 'claude-sonnet-4-6')
 *   Optional: VITE_CLAUDE_SDK_MAX_BUDGET (default 5.00 USD)
 *   Optional: VITE_CLAUDE_SDK_MAX_TURNS (default 50)
 */

// NOTE: @anthropic-ai/claude-agent-sdk is Node-only — lazy-import to avoid
// "process is not defined" in the browser bundle.
let _sdkModule = null;
async function _loadSdk() {
  if (!_sdkModule) {
    _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  }
  return _sdkModule;
}

import { z } from 'zod';

import { BUILTIN_TOOLS, isPythonApiTool } from '../ai-infra/builtinToolCatalog.js';
import { buildZodSchema } from '../../mcp/zodSchemaBuilder.js';
import { getToolAnnotations } from '../../mcp/toolAnnotations.js';
import { getExecutor } from './executors/executorRegistry.js';
import { runGatePipeline, buildStepContext } from './gates/stepPipeline.js';
import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';
import { appendWorklog } from './persistence/worklogRepo.js';
import { eventBus, EVENT_NAMES } from '../governance/eventBus.js';
import { taskTransition, TASK_EVENTS, isTaskTerminal } from './taskStateMachine.js';
import { stepTransition, STEP_EVENTS, isStepTerminal } from './stepStateMachine.js';
import { employeeTransition, EMPLOYEE_EVENTS } from './employeeStateMachine.js';
import { getTaskStatus } from './orchestrator.js';
import { createCheckpoint } from './checkpointService.js';

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_BUDGET = 5.00;
const DEFAULT_MAX_TURNS = 50;

function _getConfig() {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : {};
  const proc = typeof process !== 'undefined' ? process.env : {};
  return {
    enabled: (env?.VITE_DI_AGENT_RUNTIME || proc.DI_AGENT_RUNTIME) === 'claude-sdk',
    model: env?.VITE_CLAUDE_SDK_MODEL || proc.CLAUDE_SDK_MODEL || DEFAULT_MODEL,
    maxBudget: parseFloat(env?.VITE_CLAUDE_SDK_MAX_BUDGET || proc.CLAUDE_SDK_MAX_BUDGET) || DEFAULT_MAX_BUDGET,
    maxTurns: parseInt(env?.VITE_CLAUDE_SDK_MAX_TURNS || proc.CLAUDE_SDK_MAX_TURNS, 10) || DEFAULT_MAX_TURNS,
  };
}

export function isClaudeSdkEnabled() {
  return _getConfig().enabled;
}

// ── Abort Registry ───────────────────────────────────────────────────────────

const _abortControllers = new Map();

export function registerClaudeSdkAbort(taskId) {
  const controller = new AbortController();
  _abortControllers.set(taskId, controller);
  return controller;
}

export function abortClaudeSdkLoop(taskId) {
  const controller = _abortControllers.get(taskId);
  if (controller) {
    controller.abort();
    _abortControllers.delete(taskId);
    return true;
  }
  return false;
}

// ── Tool Bridge Factory ──────────────────────────────────────────────────────

async function _buildSdkTools(task, steps) {
  const completedSteps = new Set();
  const artifactMap = new Map(); // stepName → artifacts

  const sdkTools = [];

  for (const catalogEntry of BUILTIN_TOOLS) {
    const zodSchema = buildZodSchema(catalogEntry.input_schema);
    const annotations = getToolAnnotations({ ...catalogEntry, isPython: isPythonApiTool(catalogEntry.id) });

    const sdk = await _loadSdk();
    const sdkTool = sdk.tool(
      catalogEntry.id,
      `${catalogEntry.description} Category: ${catalogEntry.category}. ${catalogEntry.depends_on.length ? `Requires: ${catalogEntry.depends_on.join(', ')}.` : ''} Produces: ${catalogEntry.output_artifacts.join(', ')}.`,
      zodSchema,
      async (args) => {
        try {
          const executor = getExecutor(isPythonApiTool(catalogEntry.id) ? 'python_tool' : 'builtin_tool');
          const stepInput = {
            step: {
              name: catalogEntry.name,
              tool_hint: catalogEntry.description,
              builtin_tool_id: catalogEntry.id,
              tool_type: isPythonApiTool(catalogEntry.id) ? 'python_tool' : 'builtin_tool',
              input_args: args,
            },
            inputData: {
              ...args,
              priorArtifacts: Object.fromEntries(artifactMap),
              title: task.title,
              description: task.description,
            },
            llmConfig: task.input_context?.llmConfig || {},
            taskId: task.id,
          };

          const result = await executor(stepInput);

          // Track completed tools and artifacts
          completedSteps.add(catalogEntry.id);
          if (result.ok && result.artifacts?.length) {
            artifactMap.set(catalogEntry.id, result.artifacts);
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                tool: catalogEntry.id,
                status: result.ok ? 'success' : 'error',
                ...(result.error ? { error: result.error } : {}),
                artifacts: (result.artifacts || []).map(a => ({
                  type: a.type || a.artifact_type,
                  label: a.label || a.name,
                  ...(a.summary ? { summary: a.summary } : {}),
                })),
                metadata: { output_artifacts: catalogEntry.output_artifacts },
              }, null, 2),
            }],
            isError: !result.ok,
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      },
      { annotations },
    );

    sdkTools.push(sdkTool);
  }

  // Meta-tool: get task status
  const sdk = await _loadSdk();
  sdkTools.push(sdk.tool(
    'get_task_status',
    'Get current task execution status, step progress, and completion state.',
    z.object({}),
    async () => {
      const status = await getTaskStatus(task.id, { lite: true });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: status.task.status,
            stepsCompleted: status.stepsCompleted,
            stepsTotal: status.stepsTotal,
            isComplete: status.isComplete,
            completedTools: Array.from(completedSteps),
            steps: status.steps.map(s => ({
              index: s.step_index, name: s.step_name, status: s.status,
            })),
          }, null, 2),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  ));

  return { sdkTools, completedSteps, artifactMap };
}

// ── Gate Enforcement Hook ────────────────────────────────────────────────────

function _makePreToolUseHook(task, steps, completedSteps) {
  return async (input) => {
    const toolName = input.tool_name;

    // Skip gate check for meta-tools and non-DI tools
    if (toolName === 'get_task_status' || !BUILTIN_TOOLS.find(t => t.id === toolName)) {
      return {};
    }

    const catalogEntry = BUILTIN_TOOLS.find(t => t.id === toolName);

    // Check dependencies: deny if depends_on tools haven't completed
    for (const dep of catalogEntry.depends_on) {
      if (!completedSteps.has(dep)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Dependency not met: '${dep}' must complete before '${toolName}'.`,
          },
        };
      }
    }

    // Find matching step in plan
    const step = steps.find(s => s.builtin_tool_id === toolName || s.step_name === catalogEntry.name);
    if (step) {
      const ctx = buildStepContext(task, step);
      const gateResult = await runGatePipeline(ctx);
      if (!gateResult.passed) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Gate blocked: ${gateResult.result?.error || gateResult.gateName}`,
          },
        };
      }
    }

    return {};
  };
}

// ── Artifact Capture Hook ────────────────────────────────────────────────────

function _makePostToolUseHook(task, steps) {
  return async (input) => {
    const toolName = input.tool_name;

    // Skip non-DI tools
    if (toolName === 'get_task_status' || !BUILTIN_TOOLS.find(t => t.id === toolName)) {
      return {};
    }

    // Find matching step
    const step = steps.find(s => s.builtin_tool_id === toolName);
    if (!step) return {};

    // Parse tool output
    let toolOutput;
    try {
      const text = input.tool_result?.content?.[0]?.text;
      toolOutput = text ? JSON.parse(text) : {};
    } catch {
      toolOutput = {};
    }

    const isError = input.tool_result?.isError || toolOutput.status === 'error';

    if (!isError) {
      // Mark step succeeded
      try {
        const succeededStatus = stepTransition('running', STEP_EVENTS.SUCCEED);
        await stepRepo.updateStep(step.id, {
          status: succeededStatus,
          completed_at: new Date().toISOString(),
          output_summary: toolOutput.artifacts?.map(a => a.type).join(', ') || 'completed',
        });

        eventBus.emit(EVENT_NAMES.AGENT_STEP_COMPLETED, {
          taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
        });

        await appendWorklog(task.employee_id, task.id, null, 'step_progress', {
          event: 'step_completed', step_name: step.step_name,
          tool: toolName, artifacts: toolOutput.artifacts?.length || 0,
        }).catch(() => {});

        // Create checkpoint (best-effort)
        await createCheckpoint(task.id, step.step_index).catch(() => {});
      } catch (err) {
        console.warn(`[ClaudeSDK] PostToolUse step update failed: ${err.message}`);
      }
    } else {
      // Mark step failed
      try {
        const failedStatus = stepTransition('running', STEP_EVENTS.FAIL);
        await stepRepo.updateStep(step.id, {
          status: failedStatus,
          error_message: toolOutput.error || 'Tool execution failed',
        });
      } catch (err) {
        console.warn(`[ClaudeSDK] PostToolUse failure update failed: ${err.message}`);
      }
    }

    return {};
  };
}

// ── System Prompt Builder ────────────────────────────────────────────────────

function _buildSystemPrompt(task, steps) {
  const stepDescriptions = steps.map((s, i) => {
    const deps = s.depends_on?.length ? ` (after: ${s.depends_on.join(', ')})` : '';
    return `  ${i + 1}. ${s.step_name} → tool: ${s.builtin_tool_id || s.tool_type}${deps}`;
  }).join('\n');

  return `You are a Digital Worker executing a supply chain planning task using the Decision-Intelligence engine.

Task: ${task.title}
${task.description ? `Description: ${task.description}` : ''}
Priority: ${task.priority || 'medium'}

Plan Steps (execute in order):
${stepDescriptions}

Instructions:
- Execute each step by calling the corresponding DI tool.
- Pass relevant outputs from earlier steps as context to later steps.
- After all steps complete, use get_task_status to verify completion.
- If a tool fails, report the error — do not retry unless the error suggests a fixable input issue.
- Produce a brief summary of results when all steps are done.`;
}

// ── Public API: Run Claude SDK Loop ──────────────────────────────────────────

/**
 * Run the Claude Agent SDK to autonomously drive a task to completion.
 * Drop-in replacement for the orchestrator's _runTickLoop().
 *
 * @param {string} taskId
 * @param {object} [opts]
 * @param {string} [opts.taskTitle]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ completionReason: string, turns: number, totalCostUsd: number }>}
 */
export async function runClaudeSdkLoop(taskId, opts = {}) {
  const config = _getConfig();
  const task = await taskRepo.getTask(taskId);
  const steps = await stepRepo.getSteps(taskId);

  // Build plan step definitions from DB steps merged with plan_snapshot
  const planSteps = steps.map(s => {
    const def = task.plan_snapshot?.steps?.find(ps => ps.step_index === s.step_index) || {};
    return { ...s, ...def };
  });

  // Build SDK tools from catalog
  const { sdkTools, completedSteps, artifactMap } = await _buildSdkTools(task, planSteps);
  const sdk = await _loadSdk();
  const mcpServer = sdk.createSdkMcpServer({
    name: 'decision-intelligence',
    version: '0.2.0',
    tools: sdkTools,
  });

  // Build hooks
  const preToolHook = _makePreToolUseHook(task, planSteps, completedSteps);
  const postToolHook = _makePostToolUseHook(task, planSteps);

  // Build system prompt
  const systemPrompt = _buildSystemPrompt(task, planSteps);

  // Set up abort
  const controller = opts.abortSignal ? null : registerClaudeSdkAbort(taskId);
  const abortSignal = opts.abortSignal || controller?.signal;

  console.log(`[ClaudeSDK] Starting autonomous loop for task ${taskId} (${planSteps.length} steps, model: ${config.model})`);

  let turns = 0;
  let totalCostUsd = 0;
  let completionReason = 'unknown';

  try {
    // Transition pending steps to indicate they're being managed by SDK
    for (const step of planSteps) {
      if (!isStepTerminal(step.status) && step.status === 'pending') {
        await stepRepo.updateStep(step.id, { status: 'running', started_at: new Date().toISOString() });
      }
    }

    const generator = sdk.query({
      prompt: `Execute task "${task.title}". Follow the plan steps in order. Start now.`,
      options: {
        model: config.model,
        systemPrompt,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudget,
        mcpServers: { di: mcpServer },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        tools: [], // No built-in file tools — only our DI tools
        hooks: {
          PreToolUse: [{ hooks: [preToolHook] }],
          PostToolUse: [{ hooks: [postToolHook] }],
        },
        abortSignal,
      },
    });

    for await (const message of generator) {
      if (message.type === 'result') {
        turns = message.num_turns || turns;
        totalCostUsd = message.total_cost_usd || totalCostUsd;
        completionReason = message.subtype === 'success' ? 'completed' : (message.subtype || 'error');

        if (message.subtype === 'error') {
          console.error(`[ClaudeSDK] Task ${taskId} ended with error:`, message.error);
        }
      }
    }

    // Complete task if all steps are done
    const finalStatus = await getTaskStatus(taskId, { lite: true });
    if (finalStatus.isComplete || finalStatus.stepsCompleted === finalStatus.stepsTotal) {
      if (!isTaskTerminal(finalStatus.task.status)) {
        const nextStatus = taskTransition(finalStatus.task.status, TASK_EVENTS.COMPLETE);
        await taskRepo.updateTaskStatus(taskId, nextStatus, finalStatus.task.version);
        await _resetEmployee(task.employee_id);
        eventBus.emit(EVENT_NAMES.TASK_COMPLETED, { taskId, turns, totalCostUsd });
      }
    }

    console.log(`[ClaudeSDK] Task ${taskId} finished — reason: ${completionReason}, turns: ${turns}, cost: $${totalCostUsd.toFixed(4)}`);

    return { completionReason, turns, totalCostUsd };
  } finally {
    _abortControllers.delete(taskId);
  }
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

async function _resetEmployee(employeeId) {
  try {
    const emp = await employeeRepo.getEmployee(employeeId);
    const nextState = employeeTransition(emp._logicalState, EMPLOYEE_EVENTS.TASK_DONE);
    await employeeRepo.updateEmployeeStatus(employeeId, nextState);
  } catch {
    // best effort
  }
}
