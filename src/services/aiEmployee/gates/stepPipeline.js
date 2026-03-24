/**
 * stepPipeline.js — Composable gate pipeline for step execution.
 *
 * Replaces the monolithic _executeStep in orchestrator.js with an ordered
 * pipeline of independent, testable gates.  Each gate receives a mutable
 * StepContext and returns a GateResult.
 *
 * Gate contract:
 *   async function gate(ctx: StepContext): GateResult
 *
 * GateResult shapes:
 *   { pass: true }                                     — gate passed, continue
 *   { pass: false, action: 'blocked', ... }            — step needs user input
 *   { pass: false, action: 'skipped', ... }            — step skipped (budget, permission, etc.)
 *   { pass: false, action: 'review_hold', ... }        — step held for review
 *   { pass: false, action: 'needs_approval', ... }     — step needs publish approval
 */

import { datasetGate } from './datasetGate.js';
import { budgetGate } from './budgetGate.js';
import { capabilityPolicyGate } from './capabilityPolicyGate.js';
import { toolPermissionGate } from './toolPermissionGate.js';
import { governanceRulesGate } from './governanceRulesGate.js';
import { publishApprovalGate } from './approvalGate.js';
import { priorArtifactsResolver, styleContextResolver, memoryRecallResolver, datasetProfileResolver, lazyContextResolver } from './contextResolvers.js';

// ── Gate categories ──────────────────────────────────────────────────────────
// "hard" gates block/skip/hold the step — failures are significant.
// "soft" gates enrich context — failures are non-blocking (best-effort).

/**
 * The default ordered pipeline.
 * Hard gates run first (any can halt execution).
 * Soft resolvers run after (enrich context, never block).
 */
export const DEFAULT_GATE_PIPELINE = [
  // ── Hard gates (order matters) ──
  { name: 'dataset',           fn: datasetGate,          hard: true },
  { name: 'budget',            fn: budgetGate,            hard: false }, // best-effort
  { name: 'capability_policy', fn: capabilityPolicyGate,  hard: false }, // best-effort
  { name: 'tool_permission',   fn: toolPermissionGate,    hard: false }, // best-effort
  { name: 'governance_rules',  fn: governanceRulesGate,   hard: false }, // best-effort
  { name: 'publish_approval',  fn: publishApprovalGate,   hard: false }, // best-effort

  // ── Context resolvers (always best-effort) ──
  { name: 'prior_artifacts',   fn: priorArtifactsResolver, hard: false },
  { name: 'style_context',     fn: styleContextResolver,   hard: false },
  { name: 'memory_recall',     fn: memoryRecallResolver,   hard: false },
  { name: 'dataset_profile',   fn: datasetProfileResolver, hard: false },
  { name: 'lazy_context',      fn: lazyContextResolver,    hard: false },
];

/**
 * Run the gate pipeline against a StepContext.
 *
 * @param {StepContext} ctx - mutable context enriched by each gate
 * @param {Array} [pipeline] - override the default pipeline (for testing)
 * @returns {{ passed: boolean, result?: GateResult, gateName?: string, degraded: string[] }}
 */
export async function runGatePipeline(ctx, pipeline = DEFAULT_GATE_PIPELINE) {
  const degraded = []; // track which best-effort gates failed

  for (const gate of pipeline) {
    try {
      const result = await gate.fn(ctx);
      if (!result.pass) {
        // Gate blocked execution — return immediately
        return { passed: false, result, gateName: gate.name, degraded };
      }
    } catch (err) {
      if (gate.hard) {
        // Hard gate failure = block execution
        console.error(`[StepPipeline] Hard gate "${gate.name}" threw:`, err.message);
        return {
          passed: false,
          result: { pass: false, action: 'skipped', error: `Gate "${gate.name}" failed: ${err.message}` },
          gateName: gate.name,
          degraded,
        };
      }
      // Soft gate failure = log and continue (best-effort)
      console.warn(`[StepPipeline] Soft gate "${gate.name}" failed (non-blocking):`, err.message);
      degraded.push(gate.name);
    }
  }

  return { passed: true, degraded };
}

/**
 * @typedef {object} StepContext
 * @property {object} task          - Task row from DB (mutable: version may increment)
 * @property {object} step          - Step row from DB
 * @property {object} stepDef       - Step definition from plan_snapshot
 * @property {object} planSnapshot  - Full plan snapshot
 * @property {object} inputData     - Mutable — enriched by context resolvers
 * @property {object|null} styleContext    - Set by styleContextResolver
 * @property {object|null} outputProfile  - Set by styleContextResolver
 * @property {string|null} memoryContext  - Set by memoryRecallResolver
 * @property {object} priorArtifacts      - Set by priorArtifactsResolver
 * @property {Array} priorStepResults     - Set by priorArtifactsResolver
 */

/**
 * Build the initial StepContext from task + step data.
 */
export function buildStepContext(task, step) {
  const planSnapshot = task.plan_snapshot || {};
  const planSteps = planSnapshot.steps || [];
  const stepDef = planSteps[step.step_index] || {};

  return {
    task,
    step,
    stepDef,
    planSnapshot,
    inputData: { ...(task.input_context?.inputData || {}) },
    styleContext: null,
    outputProfile: null,
    memoryContext: null,
    priorArtifacts: {},
    priorStepResults: [],
  };
}
