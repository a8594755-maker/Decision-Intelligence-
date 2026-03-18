/**
 * ralphLoopAdapter.js — Bridge between ralph-loop-agent and the DI orchestrator.
 *
 * Wraps the orchestrator's tick() function as a ralph-loop-agent iteration,
 * providing autonomous retry, verification, cost control, and context management.
 *
 * Usage:
 *   Set VITE_RALPH_LOOP_ENABLED=true to activate.
 *   Optional: VITE_RALPH_MAX_ITERATIONS (default 30)
 *   Optional: VITE_RALPH_MAX_COST (default 5.00 USD)
 *   Optional: VITE_RALPH_LLM_MODEL (default 'anthropic/claude-sonnet-4.5')
 */

import { RalphLoopAgent, iterationCountIs, costIs } from 'ralph-loop-agent';
import { tool } from 'ai';
import { z } from 'zod';

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_MAX_COST = 5.00;
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

function _getConfig() {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : {};
  return {
    enabled: env?.VITE_RALPH_LOOP_ENABLED === 'true',
    maxIterations: parseInt(env?.VITE_RALPH_MAX_ITERATIONS, 10) || DEFAULT_MAX_ITERATIONS,
    maxCost: parseFloat(env?.VITE_RALPH_MAX_COST) || DEFAULT_MAX_COST,
    model: env?.VITE_RALPH_LLM_MODEL || DEFAULT_MODEL,
  };
}

// ── Abort Registry (per-task AbortControllers) ────────────────────────────────

const _abortControllers = new Map();

/**
 * Register an AbortController for a task so it can be cancelled later.
 * @returns {AbortController}
 */
export function registerRalphAbort(taskId) {
  const controller = new AbortController();
  _abortControllers.set(taskId, controller);
  return controller;
}

/**
 * Abort a running Ralph Loop for a specific task.
 * @returns {boolean} true if a loop was found and aborted
 */
export function abortRalphLoop(taskId) {
  const controller = _abortControllers.get(taskId);
  if (controller) {
    controller.abort();
    _abortControllers.delete(taskId);
    return true;
  }
  return false;
}

/**
 * Abort ALL running Ralph Loops.
 * @returns {number} number of loops aborted
 */
export function abortAllRalphLoops() {
  let count = 0;
  for (const [id, controller] of _abortControllers) {
    controller.abort();
    _abortControllers.delete(id);
    count++;
  }
  return count;
}

export function isRalphLoopEnabled() {
  return _getConfig().enabled;
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

/**
 * Build AI SDK tools that wrap the orchestrator's tick + query functions.
 * These are the "hands" ralph-loop-agent uses to drive the existing pipeline.
 */
function _buildTools(tickFn, getStatusFn) {
  return {
    executeTick: tool({
      description: 'Execute the next pending step in the task pipeline. Returns { done, stepResult }.',
      parameters: z.object({
        taskId: z.string().describe('The task ID to tick'),
      }),
      execute: async ({ taskId }) => {
        try {
          const result = await tickFn(taskId);
          return { ok: true, ...result };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    }),

    getTaskStatus: tool({
      description: 'Query current task status, step progress, and completion state.',
      parameters: z.object({
        taskId: z.string().describe('The task ID to query'),
      }),
      execute: async ({ taskId }) => {
        try {
          const status = await getStatusFn(taskId);
          return {
            ok: true,
            status: status.task.status,
            stepsCompleted: status.stepsCompleted,
            stepsTotal: status.stepsTotal,
            isComplete: status.isComplete,
            steps: status.steps.map(s => ({
              index: s.step_index,
              name: s.step_name,
              status: s.status,
              error: s.error_message || null,
            })),
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    }),

    markComplete: tool({
      description: 'Signal that the task is fully complete and the loop should stop.',
      parameters: z.object({
        reason: z.string().describe('Why the task is considered complete'),
      }),
      execute: async ({ reason }) => {
        return { complete: true, reason };
      },
    }),
  };
}

// ── Agent Factory ─────────────────────────────────────────────────────────────

/**
 * Create a RalphLoopAgent configured for the DI orchestrator.
 */
function _createAgent(tickFn, getStatusFn, taskTitle = 'task') {
  const config = _getConfig();
  const tools = _buildTools(tickFn, getStatusFn);

  return new RalphLoopAgent({
    id: `di-worker-${Date.now()}`,
    model: config.model,
    instructions: [
      'You are a Digital Worker agent executing a supply-chain planning task.',
      'Your job is to drive the task to completion by calling executeTick() repeatedly.',
      '',
      'Workflow:',
      '1. Call getTaskStatus to understand current state',
      '2. Call executeTick to advance the pipeline',
      '3. After each tick, check the result:',
      '   - If done=true and the task is complete → call markComplete',
      '   - If done=true and waiting_input=true → stop and explain what input is needed',
      '   - If a step failed → analyze the error and decide whether to continue (orchestrator handles retries)',
      '   - Otherwise → continue ticking',
      '4. When all steps succeed, call markComplete with a summary',
      '',
      `Task: "${taskTitle}"`,
    ].join('\n'),
    tools,
    stopWhen: [
      iterationCountIs(config.maxIterations),
      costIs(config.maxCost),
    ],
    verifyCompletion: async ({ result, iteration }) => {
      // Check if markComplete was called
      for (const step of result.steps || []) {
        for (const toolResult of step.toolResults || []) {
          if (toolResult.toolName === 'markComplete') {
            return { complete: true, reason: toolResult.result?.reason || 'Task complete' };
          }
        }
      }

      // Check if getTaskStatus shows complete
      for (const step of result.steps || []) {
        for (const toolResult of step.toolResults || []) {
          if (toolResult.toolName === 'getTaskStatus' && toolResult.result?.isComplete) {
            return { complete: true, reason: 'All steps completed' };
          }
        }
      }

      // Check if waiting for input (pause, don't keep iterating)
      for (const step of result.steps || []) {
        for (const toolResult of step.toolResults || []) {
          if (toolResult.toolName === 'executeTick' && toolResult.result?.waiting_input) {
            return { complete: true, reason: 'Waiting for user input' };
          }
        }
      }

      return { complete: false, reason: `Iteration ${iteration}: task still in progress — keep ticking` };
    },
    onIterationStart: ({ iteration }) => {
      console.log(`[RalphLoop] Iteration ${iteration} starting...`);
    },
    onIterationEnd: ({ iteration, duration }) => {
      console.log(`[RalphLoop] Iteration ${iteration} completed in ${duration}ms`);
    },
    contextManagement: {
      maxContextTokens: 100_000,
      enableSummarization: true,
      recentIterationsToKeep: 3,
    },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the ralph-loop-agent to autonomously drive a task to completion.
 * Drop-in replacement for the orchestrator's _runTickLoop().
 *
 * @param {string} taskId - Task to execute
 * @param {Function} tickFn - The orchestrator's tick(taskId) function
 * @param {Function} getStatusFn - The orchestrator's getTaskStatus(taskId) function
 * @param {object} [opts] - Optional overrides
 * @param {string} [opts.taskTitle] - Human-readable task title for agent instructions
 * @param {AbortSignal} [opts.abortSignal] - For cancellation
 * @returns {Promise<RalphLoopResult>}
 */
export async function runRalphLoop(taskId, tickFn, getStatusFn, opts = {}) {
  const agent = _createAgent(tickFn, getStatusFn, opts.taskTitle || taskId);

  // Auto-register abort controller if none provided
  const controller = opts.abortSignal ? null : registerRalphAbort(taskId);
  const abortSignal = opts.abortSignal || controller?.signal;

  console.log(`[RalphLoop] Starting autonomous loop for task ${taskId}`);

  try {
    const result = await agent.loop({
      prompt: `Execute task ${taskId}. Start by checking its status, then tick through all steps until the task is complete.`,
      abortSignal,
    });

    console.log(`[RalphLoop] Task ${taskId} finished — reason: ${result.completionReason}, iterations: ${result.iterations}`);

    return {
      completionReason: result.completionReason,
      iterations: result.iterations,
      reason: result.reason,
      totalUsage: result.totalUsage,
      text: result.text,
    };
  } finally {
    // Clean up abort controller
    _abortControllers.delete(taskId);
  }
}
