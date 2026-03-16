/**
 * decisionPipelineService.js — Decision Pipeline Phase Model (v2)
 *
 * Maps task steps into the 5-phase decision pipeline:
 *   1. ingest     — normalize input, validate data, resolve context
 *   2. analyze    — run analysis engines (forecast, risk, scenario)
 *   3. draft_plan — generate planning artifacts (decision_brief, evidence_pack, writeback_payload)
 *   4. review_gate — manager review & approval
 *   5. publish    — export / writeback / notify
 *
 * This is a LOGICAL overlay on top of the existing step-based execution model.
 * The orchestrator continues to execute steps individually; this service provides
 * phase tracking, progress reporting, and phase-aware gating.
 *
 * @module services/aiEmployee/decisionPipelineService
 */

import {
  validateDecisionWorkOrder,
  fromLegacyWorkOrder,
} from '../../contracts/decisionWorkOrderContract.js';

// ── Pipeline Phases ─────────────────────────────────────────────────────────

export const PIPELINE_PHASES = Object.freeze({
  INGEST:      'ingest',
  ANALYZE:     'analyze',
  DRAFT_PLAN:  'draft_plan',
  REVIEW_GATE: 'review_gate',
  PUBLISH:     'publish',
});

export const PHASE_ORDER = [
  PIPELINE_PHASES.INGEST,
  PIPELINE_PHASES.ANALYZE,
  PIPELINE_PHASES.DRAFT_PLAN,
  PIPELINE_PHASES.REVIEW_GATE,
  PIPELINE_PHASES.PUBLISH,
];

// ── Step → Phase Mapping ────────────────────────────────────────────────────

/**
 * Keywords/patterns that map step names or tool IDs to pipeline phases.
 * Order matters — first match wins.
 */
const PHASE_PATTERNS = [
  // Ingest phase
  { phase: PIPELINE_PHASES.INGEST, patterns: [
    'ingest', 'import', 'load_data', 'normalize', 'clean_data', 'data_quality',
    'map_columns', 'validate_input', 'intake', 'parse',
  ]},
  // Analyze phase
  { phase: PIPELINE_PHASES.ANALYZE, patterns: [
    'forecast', 'analyze', 'risk_assess', 'scenario', 'evaluate', 'compute',
    'calculate', 'run_model', 'detect_anomaly', 'simulate', 'backtest',
    'causal_graph', 'sku_analysis', 'supplier_kpi',
  ]},
  // Draft plan phase
  { phase: PIPELINE_PHASES.DRAFT_PLAN, patterns: [
    'plan', 'optimize', 'solver', 'replenish', 'allocate', 'replan',
    'draft', 'recommend', 'synthesize', 'generate_report', 'summary',
    'build_brief', 'evidence_pack', 'writeback_payload',
  ]},
  // Review gate phase
  { phase: PIPELINE_PHASES.REVIEW_GATE, patterns: [
    'review', 'approve', 'checkpoint', 'gate', 'sign_off',
  ]},
  // Publish phase
  { phase: PIPELINE_PHASES.PUBLISH, patterns: [
    'publish', 'export', 'writeback', 'send', 'notify', 'share',
    'upload', 'sync', 'excel_build', 'opencloud',
  ]},
];

/**
 * Determine which pipeline phase a step belongs to.
 *
 * @param {Object} stepDef - Step definition { name, tool_hint, tool_type, builtin_tool_id, pipeline_phase }
 * @returns {string} Pipeline phase
 */
export function classifyStepPhase(stepDef) {
  // Explicit override
  if (stepDef.pipeline_phase && PHASE_ORDER.includes(stepDef.pipeline_phase)) {
    return stepDef.pipeline_phase;
  }

  // Match by step name, tool_hint, or builtin_tool_id
  const candidates = [
    stepDef.name,
    stepDef.tool_hint,
    stepDef.builtin_tool_id,
    stepDef.step_name,
  ].filter(Boolean).map(s => s.toLowerCase());

  for (const { phase, patterns } of PHASE_PATTERNS) {
    for (const candidate of candidates) {
      if (patterns.some(p => candidate.includes(p))) {
        return phase;
      }
    }
  }

  // Default: analyze (most steps are analysis)
  return PIPELINE_PHASES.ANALYZE;
}

/**
 * Annotate a plan's steps with pipeline phase information.
 * Does NOT mutate the input — returns a new array.
 *
 * @param {Object[]} steps - Array of step definitions
 * @returns {Object[]} Steps with _pipeline_phase added
 */
export function annotateStepsWithPhases(steps) {
  return steps.map((step, idx) => ({
    ...step,
    _pipeline_phase: classifyStepPhase(step),
    _pipeline_index: idx,
  }));
}

/**
 * Get the current pipeline phase based on completed steps.
 *
 * @param {Object[]} steps - Steps with status and _pipeline_phase
 * @returns {{ currentPhase: string, phaseProgress: Object, completedPhases: string[], nextPhase: string|null }}
 */
export function getPipelineProgress(steps) {
  const phaseProgress = {};

  for (const phase of PHASE_ORDER) {
    const phaseSteps = steps.filter(s => classifyStepPhase(s) === phase);
    const completed = phaseSteps.filter(s => s.status === 'succeeded' || s.status === 'skipped');
    phaseProgress[phase] = {
      total: phaseSteps.length,
      completed: completed.length,
      done: phaseSteps.length > 0 && completed.length === phaseSteps.length,
    };
  }

  const completedPhases = PHASE_ORDER.filter(p => phaseProgress[p].done && phaseProgress[p].total > 0);

  // Current phase = first phase with incomplete steps, or last phase if all done
  let currentPhase = PIPELINE_PHASES.PUBLISH;
  for (const phase of PHASE_ORDER) {
    if (phaseProgress[phase].total > 0 && !phaseProgress[phase].done) {
      currentPhase = phase;
      break;
    }
  }

  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  const nextPhase = currentIdx < PHASE_ORDER.length - 1 ? PHASE_ORDER[currentIdx + 1] : null;

  return { currentPhase, phaseProgress, completedPhases, nextPhase };
}

/**
 * Check if the task is ready to enter review_gate phase.
 * True when all ingest + analyze + draft_plan steps are completed.
 *
 * @param {Object[]} steps
 * @returns {boolean}
 */
export function isReadyForReview(steps) {
  const prereqPhases = [PIPELINE_PHASES.INGEST, PIPELINE_PHASES.ANALYZE, PIPELINE_PHASES.DRAFT_PLAN];

  for (const phase of prereqPhases) {
    const phaseSteps = steps.filter(s => classifyStepPhase(s) === phase);
    if (phaseSteps.length > 0 && phaseSteps.some(s => s.status !== 'succeeded' && s.status !== 'skipped')) {
      return false;
    }
  }

  return true;
}

/**
 * Validate and convert a legacy work order to a Decision Work Order.
 * Thin wrapper for taskIntakeService integration.
 *
 * @param {Object} legacyWO - WorkOrder from taskIntakeService.normalizeIntake()
 * @param {Object} [overrides] - Additional DWO fields
 * @returns {{ dwo: Object, validation: { valid: boolean, errors: string[] } }}
 */
export function convertToDWO(legacyWO, overrides = {}) {
  const dwo = fromLegacyWorkOrder(legacyWO, overrides);
  const validation = validateDecisionWorkOrder(dwo);
  return { dwo, validation };
}
