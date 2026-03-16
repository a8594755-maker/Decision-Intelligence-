// @product: ai-employee
//
// workOrderDraftService.js — lightweight pre-decomposition work-order drafts
// ─────────────────────────────────────────────────────────────────────────────
// Produces a quick "work order draft" from a user message using keyword/catalog
// matching (no LLM). This gives the user a confirmation card before the
// expensive decomposeTask() call runs.
// ─────────────────────────────────────────────────────────────────────────────

import { findToolsByQuery } from '../builtinToolCatalog.js';

// ── Data-hint patterns ──────────────────────────────────────────────────────

const DATA_HINT_PATTERNS = [
  { key: 'attached',    rx: /attach|upload|csv|xlsx|xls|file|工作簿|附件|上傳/i },
  { key: 'folder_ref',  rx: /folder|drive|opencloud|雲端|資料夾/i },
  { key: 'time_range',  rx: /last\s+\d+\s+(month|week|day|quarter|year)|past\s+\d+|近\s*\d+\s*(個月|週|天|季)|去年|上個月/i },
  { key: 'system_ref',  rx: /erp|sap|oracle|netsuite|系統|資料庫/i },
];

// ── Workflow label map ──────────────────────────────────────────────────────

const WORKFLOW_LABELS = {
  forecast:          'Forecast',
  replenishment:     'Replenishment Plan',
  risk_plan:         'Risk-Aware Plan',
  full_report:       'Full Report',
  bom_analysis:      'BOM Analysis',
  scenario:          'Scenario Simulation',
  negotiation:       'Negotiation',
  cost_analysis:     'Cost Analysis',
  inventory:         'Inventory Projection',
  data_quality:      'Data Quality Check',
  macro_oracle:      'Macro Oracle',
  mbr_with_excel:    'MBR with Excel',
};

// ── Intent detection ────────────────────────────────────────────────────────

const TASK_INTENT_RX = /\b(run|execute|generate|create|build|analyze|forecast|plan|report|check|compare|simulate|evaluate|calculate|產生|執行|分析|預測|計畫|報告|檢查|比較|模擬|計算)\b/i;

/**
 * Returns true if the message looks like a task intent rather than a question
 * or casual chat.
 */
export function isTaskIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return TASK_INTENT_RX.test(message);
}

// ── Draft builder ───────────────────────────────────────────────────────────

/**
 * Build a lightweight work-order draft from the user's message.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {boolean} [opts.hasAttachment] - true if user attached a file
 * @returns {WorkOrderDraft}
 */
export function draftWorkOrder(userMessage, opts = {}) {
  const text = (userMessage || '').trim();

  // 1. Match tools via catalog keyword search
  const matchedTools = findToolsByQuery(text).slice(0, 5);

  // 2. Infer workflow type from top match
  const topTool = matchedTools[0];
  const workflow_type = topTool?.id?.replace(/^di_/, '') || 'full_report';
  const workflow_label = WORKFLOW_LABELS[workflow_type] || topTool?.name || 'Task';

  // 3. Detect data hints in the message
  const data_hints = [];
  for (const { key, rx } of DATA_HINT_PATTERNS) {
    if (rx.test(text)) data_hints.push(key);
  }
  if (opts.hasAttachment) data_hints.push('attached');

  // 4. Build clarifications — only blocker-level (missing data source)
  const clarifications = [];
  const hasDataSource = data_hints.length > 0;
  if (!hasDataSource) {
    clarifications.push({
      key: 'data_source',
      label: 'Where is the data?',
      type: 'choice',
      options: ['Attach a file', 'Connect a folder', 'Use last dataset', 'I\'ll describe it'],
      required: false, // not a hard blocker — worker can ask later
    });
  }

  // 5. Estimated steps (heuristic)
  const estimated_steps = Math.max(1, matchedTools.length);

  return {
    title: text.length > 60 ? text.slice(0, 57) + '...' : text,
    description: text,
    workflow_type,
    workflow_label,
    matched_tools: matchedTools.map((t) => ({ id: t.id, name: t.name, category: t.category })),
    data_hints,
    clarifications,
    ready: clarifications.length === 0,
    estimated_steps,
  };
}
