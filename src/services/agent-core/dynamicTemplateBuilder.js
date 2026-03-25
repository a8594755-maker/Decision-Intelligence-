// @product: ai-employee
//
// dynamicTemplateBuilder.js
// ─────────────────────────────────────────────────────────────────────────────
// Converts a TaskDecomposition into an agent loop template compatible with
// agentLoopTemplates.js / agentLoopService.js.
//
// Dynamic templates have IDs prefixed with `dynamic_` and are stored in
// the task's input_context._dynamic_template rather than the static registry.
// ─────────────────────────────────────────────────────────────────────────────

import { topologicalSort } from '../chat/chatTaskDecomposer';

// ── Constants ────────────────────────────────────────────────────────────────

const DYNAMIC_PREFIX = 'dynamic_';

// Steps that should be reviewed by the AI reviewer
const AI_REVIEW_TYPES = new Set(['dynamic_tool', 'forecast', 'plan', 'risk', 'report', 'builtin_tool', 'python_tool', 'python_report']);

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a one-off agent loop template from a TaskDecomposition.
 *
 * @param {TaskDecomposition} decomposition
 * @returns {Template} Compatible with agentLoopTemplates.js shape
 */
export function buildDynamicTemplate(decomposition) {
  if (!decomposition?.subtasks?.length) {
    throw new Error('Cannot build template: no subtasks in decomposition');
  }

  const templateId = `${DYNAMIC_PREFIX}${Date.now()}`;

  // Topologically sort subtasks
  const sorted = topologicalSort(decomposition.subtasks);

  // Build step definitions
  const steps = sorted.map((subtask, index) => ({
    name: subtask.name,
    workflow_type: subtask.workflow_type,
    requires_review: subtask.requires_review ?? false,
    ai_review: AI_REVIEW_TYPES.has(subtask.workflow_type),
    tool_hint: subtask.tool_hint || null,
    tool_id: subtask.tool_id || null,
    builtin_tool_id: subtask.builtin_tool_id || null,
    depends_on: subtask.depends_on || [],
    index,
    // Runtime state (initialized)
    status: 'pending',
    run_id: null,
    artifact_refs: [],
    retry_count: 0,
    error: null,
    started_at: null,
    finished_at: null,
    _revision_instructions: null,
    _revision_log: [],
  }));

  return {
    id: templateId,
    label: decomposition.original_instruction?.slice(0, 80) || 'Dynamic Task',
    description: decomposition.original_instruction || '',
    steps: steps.map(s => ({
      name: s.name,
      workflow_type: s.workflow_type,
      requires_review: s.requires_review,
      ai_review: s.ai_review,
      tool_hint: s.tool_hint,
      tool_id: s.tool_id,
      builtin_tool_id: s.builtin_tool_id || null,
    })),
    report_format: decomposition.report_format || null,
    estimated_cost: decomposition.estimated_cost || 0,
    created_at: new Date().toISOString(),
  };
}

/**
 * Initialize loop_state from a dynamic template (mirrors agentLoopTemplates.initLoopState).
 *
 * @param {Template} template
 * @returns {LoopState}
 */
export function initDynamicLoopState(template) {
  const steps = template.steps.map((stepDef, index) => ({
    name: stepDef.name,
    workflow_type: stepDef.workflow_type,
    requires_review: stepDef.requires_review ?? false,
    ai_review: stepDef.ai_review ?? false,
    tool_hint: stepDef.tool_hint || null,
    tool_id: stepDef.tool_id || null,
    builtin_tool_id: stepDef.builtin_tool_id || null,
    index,
    status: 'pending',
    run_id: null,
    artifact_refs: [],
    retry_count: 0,
    error: null,
    started_at: null,
    finished_at: null,
    _revision_instructions: null,
    _revision_log: [],
  }));

  return {
    template_id: template.id,
    steps,
    current_step_index: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
}

/**
 * Check if a template ID is dynamic.
 */
export function isDynamicTemplate(templateId) {
  return typeof templateId === 'string' && templateId.startsWith(DYNAMIC_PREFIX);
}

/**
 * Extract the dynamic template from a task's input_context.
 */
export function getDynamicTemplateFromTask(task) {
  return task?.input_context?._dynamic_template || null;
}
