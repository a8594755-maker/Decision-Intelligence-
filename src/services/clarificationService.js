/**
 * clarificationService.js — Intake Clarification Workflow
 *
 * When the taskIntakeService flags a work order as needs_clarification,
 * this service manages the clarification lifecycle:
 *   1. Generate clarification questions based on what's missing
 *   2. Store pending clarifications
 *   3. Accept user responses
 *   4. Re-submit clarified work order to intake pipeline
 *
 * @module services/clarificationService
 */

import { processIntake } from './taskIntakeService.js';
import { supabase } from './supabaseClient';

// ── Clarification Status ─────────────────────────────────────────────────────

export const CLARIFICATION_STATUS = Object.freeze({
  PENDING:   'pending',
  ANSWERED:  'answered',
  RESOLVED:  'resolved',
  EXPIRED:   'expired',
  CANCELLED: 'cancelled',
});

// ── Clarification Question Types ─────────────────────────────────────────────

export const QUESTION_TYPES = Object.freeze({
  FREE_TEXT:     'free_text',
  SINGLE_SELECT: 'single_select',
  MULTI_SELECT:  'multi_select',
  CONFIRM:       'confirm',
  DATE_RANGE:    'date_range',
});

// ── In-Memory Store (with DB fallback) ───────────────────────────────────────

const _pendingClarifications = new Map(); // workOrderId → ClarificationRequest

// ── Question Generation ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ClarificationQuestion
 * @property {string} id
 * @property {string} question - Human-readable question text
 * @property {string} type - QUESTION_TYPES value
 * @property {string[]} [options] - For select types
 * @property {string} [default_value]
 * @property {boolean} required
 * @property {string} field - Which work order field this resolves
 */

/**
 * Generate clarification questions for a work order.
 * Analyzes what information is missing or ambiguous.
 *
 * @param {Object} workOrder - Work order flagged as needs_clarification
 * @returns {ClarificationQuestion[]}
 */
export function generateQuestions(workOrder) {
  const questions = [];
  const reason = workOrder.clarification_reason || '';
  const source = workOrder.source || '';
  const description = workOrder.description || '';

  // Check for missing scope/intent
  if (description.length < 20 || reason.includes('intent')) {
    questions.push({
      id: 'q_intent',
      question: 'What would you like the worker to do? Please describe the task in detail.',
      question_zh: '請描述您希望 Worker 執行的任務內容',
      type: QUESTION_TYPES.FREE_TEXT,
      required: true,
      field: 'description',
    });
  }

  // Check for missing material/entity scope
  if (!workOrder.context?.material_code && !workOrder.context?.entity_refs) {
    questions.push({
      id: 'q_scope',
      question: 'Which materials or entities should this task cover? (e.g., specific material codes, all materials, a plant)',
      question_zh: '此任務涵蓋哪些物料或實體？',
      type: QUESTION_TYPES.FREE_TEXT,
      required: false,
      field: 'entity_scope',
    });
  }

  // Check for missing time range
  if (!workOrder.context?.date_range && !workOrder.context?.period) {
    questions.push({
      id: 'q_timerange',
      question: 'What time period should this analysis cover?',
      question_zh: '分析應涵蓋哪個時間範圍？',
      type: QUESTION_TYPES.SINGLE_SELECT,
      options: ['Last 30 days', 'Last quarter', 'Last 6 months', 'Last year', 'Custom range'],
      required: false,
      field: 'time_range',
    });
  }

  // Check for missing priority confirmation (for email/transcript)
  if (['email', 'meeting_transcript'].includes(source) && !workOrder.context?.priority_confirmed) {
    questions.push({
      id: 'q_priority',
      question: `Detected priority: ${workOrder.priority}. Is this correct?`,
      question_zh: `偵測到的優先順序：${workOrder.priority}。是否正確？`,
      type: QUESTION_TYPES.SINGLE_SELECT,
      options: ['critical', 'urgent', 'high', 'medium', 'low'],
      default_value: workOrder.priority,
      required: false,
      field: 'priority',
    });
  }

  // Email-specific: missing subject
  if (source === 'email' && reason.includes('subject')) {
    questions.push({
      id: 'q_subject',
      question: 'What is the subject/topic of this email task?',
      question_zh: '此電子郵件任務的主題是什麼？',
      type: QUESTION_TYPES.FREE_TEXT,
      required: true,
      field: 'title',
    });
  }

  // Check for workflow type hint
  if (!workOrder.context?.suggested_workflow) {
    questions.push({
      id: 'q_workflow',
      question: 'What type of analysis do you need?',
      question_zh: '您需要什麼類型的分析？',
      type: QUESTION_TYPES.SINGLE_SELECT,
      options: [
        'Full Report (forecast + plan + risk)',
        'Forecast Only',
        'Risk-Aware Plan',
        'Data Quality Check',
        'Custom / Let AI decide',
      ],
      required: false,
      field: 'workflow_type',
    });
  }

  return questions;
}

// ── Clarification Lifecycle ──────────────────────────────────────────────────

/**
 * Create a clarification request for a work order.
 *
 * @param {Object} workOrder
 * @returns {Promise<{id: string, questions: ClarificationQuestion[], workOrder: Object}>}
 */
export async function createClarification(workOrder) {
  const questions = generateQuestions(workOrder);
  const id = `clar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const clarification = {
    id,
    work_order_id: workOrder.id,
    work_order: workOrder,
    questions,
    answers: {},
    status: CLARIFICATION_STATUS.PENDING,
    created_at: new Date().toISOString(),
    resolved_at: null,
  };

  // Store in memory
  _pendingClarifications.set(id, clarification);

  // Try DB persistence
  try {
    await supabase.from('clarification_requests').insert({
      id,
      work_order_id: workOrder.id,
      work_order: workOrder,
      questions,
      answers: {},
      status: CLARIFICATION_STATUS.PENDING,
      created_at: clarification.created_at,
    });
  } catch {
    // Best-effort DB persistence
  }

  return clarification;
}

/**
 * Submit answers to clarification questions.
 *
 * @param {string} clarificationId
 * @param {Object} answers - { questionId: answer }
 * @returns {Promise<{ok: boolean, clarification?: Object, error?: string}>}
 */
export async function submitAnswers(clarificationId, answers) {
  const clar = _pendingClarifications.get(clarificationId) || await _loadFromDB(clarificationId);
  if (!clar) {
    return { ok: false, error: 'Clarification not found' };
  }

  if (clar.status !== CLARIFICATION_STATUS.PENDING) {
    return { ok: false, error: `Clarification is ${clar.status}, cannot submit answers` };
  }

  // Validate required questions are answered
  const unanswered = clar.questions
    .filter(q => q.required && !answers[q.id])
    .map(q => q.id);

  if (unanswered.length > 0) {
    return { ok: false, error: `Required questions unanswered: ${unanswered.join(', ')}` };
  }

  // Update clarification
  clar.answers = { ...(clar.answers || {}), ...answers };
  clar.status = CLARIFICATION_STATUS.ANSWERED;
  _pendingClarifications.set(clarificationId, clar);

  // Update DB
  try {
    await supabase.from('clarification_requests').update({
      answers: clar.answers,
      status: CLARIFICATION_STATUS.ANSWERED,
    }).eq('id', clarificationId);
  } catch { /* best-effort */ }

  return { ok: true, clarification: clar };
}

/**
 * Resolve a clarification by re-submitting the enriched work order to intake.
 *
 * @param {string} clarificationId
 * @returns {Promise<{ok: boolean, workOrder?: Object, status?: string, error?: string}>}
 */
export async function resolveClarification(clarificationId) {
  const clar = _pendingClarifications.get(clarificationId) || await _loadFromDB(clarificationId);
  if (!clar) {
    return { ok: false, error: 'Clarification not found' };
  }

  if (clar.status !== CLARIFICATION_STATUS.ANSWERED) {
    return { ok: false, error: 'Clarification has not been answered yet' };
  }

  // Apply answers to work order
  const enrichedWorkOrder = applyAnswers(clar.work_order, clar.questions, clar.answers);

  // Re-submit to intake pipeline
  try {
    const result = await processIntake({
      source: enrichedWorkOrder.source,
      message: enrichedWorkOrder.description,
      employeeId: enrichedWorkOrder.employee_id,
      userId: enrichedWorkOrder.user_id,
      metadata: {
        ...enrichedWorkOrder.context,
        title: enrichedWorkOrder.title,
        priority: enrichedWorkOrder.priority,
        clarification_id: clarificationId,
        clarified: true,
      },
    });

    // Mark resolved and remove from in-memory map
    clar.status = CLARIFICATION_STATUS.RESOLVED;
    clar.resolved_at = new Date().toISOString();
    _pendingClarifications.delete(clarificationId);

    try {
      await supabase.from('clarification_requests').update({
        status: CLARIFICATION_STATUS.RESOLVED,
        resolved_at: clar.resolved_at,
      }).eq('id', clarificationId);
    } catch { /* best-effort */ }

    return { ok: true, workOrder: result.workOrder, status: result.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Cancel a pending clarification.
 */
export async function cancelClarification(clarificationId) {
  const clar = _pendingClarifications.get(clarificationId);
  if (clar) {
    clar.status = CLARIFICATION_STATUS.CANCELLED;
    _pendingClarifications.delete(clarificationId);
  }
  try {
    await supabase.from('clarification_requests').update({
      status: CLARIFICATION_STATUS.CANCELLED,
    }).eq('id', clarificationId);
  } catch { /* best-effort */ }
  return true;
}

/**
 * List pending clarifications for a user.
 */
export async function listPendingClarifications(userId) {
  // Try DB first
  try {
    const { data, error } = await supabase
      .from('clarification_requests')
      .select('*')
      .eq('status', CLARIFICATION_STATUS.PENDING)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (!error && data?.length) {
      return data;
    }
  } catch { /* fall through */ }

  // In-memory fallback
  return Array.from(_pendingClarifications.values())
    .filter(c => c.status === CLARIFICATION_STATUS.PENDING && c.work_order?.user_id === userId);
}

// ── Answer Application ───────────────────────────────────────────────────────

/**
 * Apply clarification answers to a work order.
 */
function applyAnswers(workOrder, questions, answers) {
  const wo = { ...workOrder, context: { ...workOrder.context } };

  for (const q of questions) {
    const answer = answers[q.id];
    if (answer == null) continue;

    switch (q.field) {
      case 'description':
        wo.description = answer;
        break;
      case 'title':
        wo.title = answer;
        break;
      case 'priority':
        wo.priority = answer;
        break;
      case 'entity_scope':
        wo.context.entity_scope = answer;
        break;
      case 'time_range':
        wo.context.time_range = answer;
        break;
      case 'workflow_type': {
        const workflowMap = {
          'Full Report (forecast + plan + risk)': 'full_report',
          'Forecast Only': 'forecast_then_plan',
          'Risk-Aware Plan': 'risk_aware_plan',
          'Data Quality Check': 'data_quality',
          'Custom / Let AI decide': null,
        };
        wo.context.suggested_workflow = workflowMap[answer] || answer;
        break;
      }
      default:
        wo.context[q.field] = answer;
    }
  }

  // Clear clarification flag
  wo.needs_clarification = false;
  wo.clarification_reason = null;

  return wo;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

async function _loadFromDB(clarificationId) {
  try {
    const { data, error } = await supabase
      .from('clarification_requests')
      .select('*')
      .eq('id', clarificationId)
      .single();
    if (error || !data) return null;
    _pendingClarifications.set(clarificationId, data);
    return data;
  } catch {
    return null;
  }
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

export function _resetForTesting() {
  _pendingClarifications.clear();
}
