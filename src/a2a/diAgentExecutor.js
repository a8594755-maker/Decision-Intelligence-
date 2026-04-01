// @product: a2a-server
//
// diAgentExecutor.js
// A2A AgentExecutor implementation that bridges A2A protocol to DI orchestrator.
// Parses user intent, creates orchestrator plans, polls for results, streams artifacts.

import { findToolsByQuery } from '../services/ai-infra/builtinToolCatalog.js';
import * as orchestrator from '../services/aiEmployee/orchestrator.js';
import { diRunsService } from '../services/planning/diRunsService';
import { toA2AState, isTerminalState, buildStatusEvent } from './taskStateMapper.js';
import { buildArtifactEvent } from './artifactMapper.js';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ITERATIONS = 150; // 5 minutes max

/**
 * DiAgentExecutor implements the A2A AgentExecutor interface.
 * Each instance is bound to a specific worker template.
 */
export class DiAgentExecutor {
  /**
   * @param {string} templateId - Worker template ID
   * @param {{ employeeId?: string, userId?: string }} [defaults]
   */
  constructor(templateId, defaults = {}) {
    this.templateId = templateId;
    this.employeeId = defaults.employeeId || null;
    this.userId = defaults.userId || 'a2a-agent';
    // Map A2A taskId → orchestrator taskId
    this._taskMap = new Map();
  }

  /**
   * Execute a task from an A2A message.
   * Implements the AgentExecutor.execute interface.
   *
   * @param {import('@a2a-js/sdk/server').RequestContext} requestContext
   * @param {import('@a2a-js/sdk/server').ExecutionEventBus} eventBus
   */
  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;
    const taskId = requestContext.task?.id || requestContext.taskId || crypto.randomUUID();
    const contextId = requestContext.contextId || crypto.randomUUID();

    // Extract text from user message parts
    const text = this._extractText(userMessage);
    if (!text) {
      eventBus.publish(buildStatusEvent(taskId, contextId, 'failed', 'No text content in message.', true));
      return;
    }

    // Check if this is a follow-up to an existing task (multi-turn)
    const existingOrcTaskId = this._taskMap.get(taskId);
    if (existingOrcTaskId) {
      await this._handleFollowUp(existingOrcTaskId, text, taskId, contextId, eventBus);
      return;
    }

    // New task: parse intent and create plan
    await this._handleNewTask(text, taskId, contextId, eventBus);
  }

  /**
   * Cancel a running task.
   *
   * @param {string} taskId - A2A task ID
   * @param {import('@a2a-js/sdk/server').ExecutionEventBus} eventBus
   */
  async cancelTask(taskId, eventBus) {
    const contextId = crypto.randomUUID();
    const orcTaskId = this._taskMap.get(taskId);
    if (orcTaskId) {
      await orchestrator.cancelTask(orcTaskId, this.userId);
      this._taskMap.delete(taskId);
    }
    eventBus.publish(buildStatusEvent(taskId, contextId, 'canceled', 'Task canceled.', true));
  }

  // ── Internal methods ──────────────────────────────────────────────────

  async _handleNewTask(text, taskId, contextId, eventBus) {
    // Publish working status
    eventBus.publish(buildStatusEvent(taskId, contextId, 'working', 'Analyzing request...'));

    // Find matching tools from the catalog
    const matchedTools = findToolsByQuery(text, { maxResults: 5 });
    if (matchedTools.length === 0) {
      eventBus.publish(buildStatusEvent(
        taskId, contextId, 'failed',
        `Could not identify any matching tools for: "${text.slice(0, 200)}". Available capabilities depend on the worker template.`,
        true,
      ));
      return;
    }

    // Build plan steps from matched tools
    const steps = matchedTools.map((tool, idx) => ({
      step_index: idx,
      title: tool.name,
      tool_type: 'builtin_tool',
      builtin_tool_id: tool.id,
      input_context: {},
    }));

    const plan = {
      title: `A2A Task: ${text.slice(0, 100)}`,
      description: text,
      steps,
      source_type: 'a2a_protocol',
    };

    try {
      // Submit plan to orchestrator
      const { taskId: orcTaskId } = await orchestrator.submitPlan(plan, this.employeeId, this.userId);
      this._taskMap.set(taskId, orcTaskId);

      // Check initial status
      const status = await orchestrator.getTaskStatus(orcTaskId, { lite: true });
      const a2aState = toA2AState(status.task.status);

      if (a2aState === 'input-required') {
        eventBus.publish(buildStatusEvent(
          taskId, contextId, 'input-required',
          `Plan requires approval. ${status.stepsTotal} step(s): ${matchedTools.map(t => t.name).join(', ')}. Reply "approve" to proceed.`,
        ));
        return;
      }

      // If auto-approved, poll for completion
      await this._pollUntilDone(orcTaskId, taskId, contextId, eventBus);
    } catch (err) {
      eventBus.publish(buildStatusEvent(
        taskId, contextId, 'failed', `Plan submission failed: ${err.message}`, true,
      ));
    }
  }

  async _handleFollowUp(orcTaskId, text, taskId, contextId, eventBus) {
    const lower = text.toLowerCase().trim();

    try {
      const status = await orchestrator.getTaskStatus(orcTaskId, { lite: true });
      const currentState = status.task.status;

      // Handle approval
      if (['approve', 'yes', 'ok', 'proceed', 'go'].includes(lower) && currentState === 'waiting_approval') {
        eventBus.publish(buildStatusEvent(taskId, contextId, 'working', 'Plan approved. Executing...'));
        await orchestrator.approvePlan(orcTaskId, this.userId);
        await this._pollUntilDone(orcTaskId, taskId, contextId, eventBus);
        return;
      }

      // Handle review approval
      if (['approve', 'yes', 'lgtm'].includes(lower) && currentState === 'review_hold') {
        eventBus.publish(buildStatusEvent(taskId, contextId, 'working', 'Review approved. Continuing...'));
        await orchestrator.approveReview(orcTaskId, this.userId);
        await this._pollUntilDone(orcTaskId, taskId, contextId, eventBus);
        return;
      }

      // Handle providing input for blocked steps
      if (currentState === 'needs_clarification' || currentState === 'blocked') {
        eventBus.publish(buildStatusEvent(taskId, contextId, 'working', 'Input received. Continuing...'));
        await orchestrator.provideStepInput(orcTaskId, { userResponse: text }, this.userId);
        await this._pollUntilDone(orcTaskId, taskId, contextId, eventBus);
        return;
      }

      // Handle cancel
      if (['cancel', 'stop', 'abort'].includes(lower)) {
        await this.cancelTask(taskId, eventBus);
        return;
      }

      // If task is already terminal, report status
      if (isTerminalState(toA2AState(currentState))) {
        eventBus.publish(buildStatusEvent(
          taskId, contextId, toA2AState(currentState),
          `Task already in terminal state: ${currentState}`,
          true,
        ));
        return;
      }

      eventBus.publish(buildStatusEvent(
        taskId, contextId, 'input-required',
        `Task is in state "${currentState}". Reply "approve" to approve, "cancel" to cancel.`,
      ));
    } catch (err) {
      eventBus.publish(buildStatusEvent(
        taskId, contextId, 'failed', `Follow-up handling failed: ${err.message}`, true,
      ));
    }
  }

  async _pollUntilDone(orcTaskId, taskId, contextId, eventBus) {
    const emittedArtifacts = new Set();
    let iteration = 0;

    while (iteration < MAX_POLL_ITERATIONS) {
      iteration++;

      const status = await orchestrator.getTaskStatus(orcTaskId, { lite: true });
      const a2aState = toA2AState(status.task.status);

      // Emit any new artifacts
      try {
        const runId = status.task.latest_run_id;
        if (runId) {
          const artifacts = await diRunsService.getArtifactsForRun(runId);
          for (const artifact of artifacts) {
            const key = `${artifact.id || artifact.artifact_type}`;
            if (!emittedArtifacts.has(key)) {
              emittedArtifacts.add(key);
              eventBus.publish(buildArtifactEvent(taskId, contextId, artifact, runId));
            }
          }
        }
      } catch {
        // Artifact fetch errors are non-fatal
      }

      // Check for terminal or input-required state
      if (isTerminalState(a2aState)) {
        const summary = a2aState === 'completed'
          ? `Completed. ${status.stepsCompleted}/${status.stepsTotal} steps done.`
          : `Task ${a2aState}: ${status.task.error_message || ''}`;
        eventBus.publish(buildStatusEvent(taskId, contextId, a2aState, summary, true));
        return;
      }

      if (a2aState === 'input-required') {
        eventBus.publish(buildStatusEvent(
          taskId, contextId, 'input-required',
          `Task requires input (state: ${status.task.status}). ${status.stepsCompleted}/${status.stepsTotal} steps done.`,
        ));
        return;
      }

      // Progress update every 5 iterations
      if (iteration % 5 === 0) {
        eventBus.publish(buildStatusEvent(
          taskId, contextId, 'working',
          `In progress: ${status.stepsCompleted}/${status.stepsTotal} steps completed.`,
        ));
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Timed out
    eventBus.publish(buildStatusEvent(
      taskId, contextId, 'failed',
      'Task execution timed out after 5 minutes.',
      true,
    ));
  }

  _extractText(message) {
    if (!message?.parts) return '';
    return message.parts
      .filter(p => p.kind === 'text')
      .map(p => p.text)
      .join(' ')
      .trim();
  }
}
