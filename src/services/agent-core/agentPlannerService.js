/**
 * agentPlannerService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 of the 4-phase agent pipeline: PLANNER
 *
 * Given a user message + context, produces a TurnPlanV1 that tells the
 * executor (phase 2) exactly what to do: which tools to load, what
 * dimensions to cover, and how to evaluate success.
 *
 * This replaces the old approach of dumping 63 tools + 15KB of rules
 * into a single system prompt and hoping the LLM figures it out.
 *
 * Flow:
 *   1. Try LLM-powered planning (gpt-5.4 with strict structured output)
 *   2. Fallback to deterministic planning (regex + heuristics)
 *   3. Return TurnPlanV1
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { runDiPrompt, DI_PROMPT_IDS } from '../planning/diModelRouterService.js';
import { classifyQueryIntent } from '../ai-infra/queryIntentClassifier.js';
import { VALID_GROUP_NAMES } from './toolGroupRegistry.js';

// ── TurnPlanV1 Schema ────────────────────────────────────────────────────────

/**
 * @typedef {Object} TurnPlanV1
 * @property {string} task_type - 'lookup' | 'analysis' | 'comparison' | 'planning' | 'simulation' | 'meta'
 * @property {string[]} success_criteria - e.g. ["revenue by category", "YoY growth"]
 * @property {string[]} required_dimensions - e.g. ["revenue", "cagr", "categories"]
 * @property {string[]} required_outputs - 'chart' | 'table' | 'recommendation' | 'caveat'
 * @property {string[]} allowed_tool_sets - e.g. ['analysis_core'] — 1-2 groups from toolGroupRegistry
 * @property {string} preferred_dataset_scope - 'user_upload' | 'demo' | 'auto'
 * @property {string} answer_language - 'en' | 'zh'
 * @property {string} review_level - 'skip' | 'deterministic' | 'full'
 * @property {number} confidence - 0.0-1.0 planner confidence
 * @property {boolean} _deterministic - true if plan was generated without LLM
 */

const VALID_TASK_TYPES = new Set([
  'lookup', 'analysis', 'comparison', 'planning', 'simulation', 'meta',
]);
const VALID_REVIEW_LEVELS = new Set(['skip', 'deterministic', 'full']);
const VALID_OUTPUTS = new Set(['chart', 'table', 'recommendation', 'caveat', 'comparison']);
const VALID_DATASET_SCOPES = new Set(['user_upload', 'demo', 'auto']);

// ── Language Detection ──────────────────────────────────────────────────────

const ZH_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function detectLanguage(text) {
  return ZH_PATTERN.test(String(text || '')) ? 'zh' : 'en';
}

// ── Deterministic Planner (Fallback) ────────────────────────────────────────

const PLANNING_KEYWORDS = /\b(plan|forecast|replenishment|optimize|solver|inventory|safety.?stock|reorder|EOQ|service.?level|budget|預測|規劃|補貨|庫存|安全庫存)\b/i;
const SIMULATION_KEYWORDS = /\b(simul|digital.?twin|stress.?test|what.?if|scenario|模擬|情境|壓力測試)\b/i;
const COMPARISON_KEYWORDS = /\b(compar|vs|versus|differ|delta|against|比較|差異|對比)\b/i;
const NEGOTIATION_KEYWORDS = /\b(negotiat|supplier.?option|談判|議價|供應商方案)\b/i;
const COST_KEYWORDS = /\b(cost|revenue|margin|profit|成本|營收|利潤|毛利)\b/i;
const ANALYSIS_KEYWORDS = /\b(analy|trend|rank|diagnos|pattern|distribution|chart|plot|graph|visuali|分析|趨勢|排行|診斷|圖表|視覺化)\b/i;
const META_KEYWORDS = /^(hi|hello|hey|你好|嗨|哈囉|what can you|help|how do|介紹|功能|說明)/i;

/**
 * Build a TurnPlanV1 from deterministic heuristics.
 * Used as fallback when LLM planner is unavailable or fails.
 */
function buildDeterministicPlan(userMessage, { hasUserData = false, conversationHistory = [] } = {}) {
  const msg = String(userMessage || '').trim();
  const lang = detectLanguage(msg);
  const wordCount = msg.split(/\s+/).length;

  // Meta: greetings, capability questions
  if (wordCount <= 5 && META_KEYWORDS.test(msg)) {
    return makePlan({
      task_type: 'meta',
      success_criteria: ['answer user greeting or capability question'],
      required_dimensions: [],
      required_outputs: [],
      allowed_tool_sets: [],
      answer_language: lang,
      review_level: 'skip',
      preferred_dataset_scope: 'auto',
      confidence: 0.95,
      _deterministic: true,
    });
  }

  // Determine task type and tool sets
  let task_type = 'analysis'; // default
  let allowed_tool_sets = ['analysis_core'];
  let review_level = 'deterministic';

  if (PLANNING_KEYWORDS.test(msg)) {
    task_type = 'planning';
    allowed_tool_sets = ['planning_core'];
    review_level = 'full';
  } else if (SIMULATION_KEYWORDS.test(msg)) {
    task_type = 'simulation';
    allowed_tool_sets = ['simulation'];
    review_level = 'deterministic';
  } else if (NEGOTIATION_KEYWORDS.test(msg)) {
    task_type = 'planning';
    allowed_tool_sets = ['negotiation'];
    review_level = 'full';
  } else if (COMPARISON_KEYWORDS.test(msg)) {
    task_type = 'comparison';
    allowed_tool_sets = ['analysis_core'];
    review_level = 'deterministic';
  } else if (COST_KEYWORDS.test(msg) && !ANALYSIS_KEYWORDS.test(msg)) {
    task_type = 'analysis';
    allowed_tool_sets = ['cost_revenue'];
    review_level = 'deterministic';
  }

  // Infer required outputs
  const required_outputs = [];
  if (/\b(chart|plot|graph|visuali|圖表|圖|視覺化|可視化|折線|柱狀|散點)\b/i.test(msg)) required_outputs.push('chart');
  if (/\b(table|tabular|matrix|breakdown|表格|明細)\b/i.test(msg)) required_outputs.push('table');
  if (/\b(recommend|suggest|建議|下一步)\b/i.test(msg)) required_outputs.push('recommendation');

  return makePlan({
    task_type,
    success_criteria: [msg.slice(0, 200)],
    required_dimensions: [],
    required_outputs,
    allowed_tool_sets,
    answer_language: lang,
    review_level,
    preferred_dataset_scope: hasUserData ? 'user_upload' : 'auto',
    confidence: 0.6,
    _deterministic: true,
  });
}

// ── LLM Planner ─────────────────────────────────────────────────────────────

const PLANNER_PROMPT_ID = 'TURN_PLANNER';

/**
 * Build the LLM prompt for the planner.
 */
function buildPlannerPrompt(userMessage, { sessionSummary = '', datasetSummary = '' } = {}) {
  return `You are a task planner for a Decision-Intelligence analysis system.
Given a user message, produce a structured plan that tells the executor which tools to use and what to cover.

## Available Tool Groups
- analysis_core: SQL queries, Python analysis, chart generation, workbook export
- planning_core: demand forecast, replenishment plan, risk analysis, scenario planning
- negotiation: supplier negotiation
- simulation: digital twin simulation, stress testing
- cost_revenue: cost analysis, cost forecast, revenue forecast
- data_prep: EDA, data cleaning, dataset joins
- advanced_analytics: regression, anomaly detection, feature importance, ML forecast, backtesting
- inventory: inventory projection, SKU analysis, BOM explosion, stockout causal graph

## Context
${sessionSummary ? `Session: ${sessionSummary}` : 'No prior session context.'}
${datasetSummary ? `Dataset: ${datasetSummary}` : 'No dataset loaded.'}

## Rules
- Select 1-2 tool groups max. Prefer fewer tools.
- For data exploration/analysis/visualization questions, use analysis_core.
- For planning/forecast/optimization, use planning_core.
- task_type must be one of: lookup, analysis, comparison, planning, simulation, meta
- review_level: use 'skip' for meta/greetings, 'deterministic' for simple lookups, 'full' for complex analysis
- success_criteria: 1-3 specific things the answer must cover
- required_dimensions: specific metrics/dimensions the answer must address (e.g. "revenue", "cagr", "categories")
- required_outputs: what format the answer needs (chart, table, recommendation)
- preferred_dataset_scope: 'user_upload' if user has uploaded data, 'demo' for demo data, 'auto' to decide automatically
- answer_language: 'en' or 'zh' based on user's message language

## User Message
"${String(userMessage || '').slice(0, 2000)}"

Return a single JSON object matching this schema exactly:
{
  "task_type": "analysis",
  "success_criteria": ["string"],
  "required_dimensions": ["string"],
  "required_outputs": ["chart"],
  "allowed_tool_sets": ["analysis_core"],
  "preferred_dataset_scope": "auto",
  "answer_language": "en",
  "review_level": "deterministic"
}`;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Generate a TurnPlanV1 for the given user message.
 *
 * @param {Object} params
 * @param {string} params.userMessage
 * @param {Object|null} params.sessionContext
 * @param {Object|null} params.datasetProfile - dataset profile row
 * @param {Array} params.conversationHistory
 * @param {boolean} params.useLlmPlanner - whether to attempt LLM planning (default: true)
 * @returns {Promise<TurnPlanV1>}
 */
export async function generateTurnPlan({
  userMessage,
  sessionContext = null,
  datasetProfile = null,
  conversationHistory = [],
  useLlmPlanner = true,
} = {}) {
  const hasUserData = Boolean(datasetProfile?.profile_json);

  // Fast path: meta queries skip LLM entirely
  const queryTier = classifyQueryIntent(userMessage, conversationHistory);
  if (queryTier.tier === 'meta') {
    return buildDeterministicPlan(userMessage, { hasUserData, conversationHistory });
  }

  // Try LLM planner
  if (useLlmPlanner) {
    try {
      const sessionSummary = sessionContext?.recent_intents
        ? sessionContext.recent_intents.slice(-3).map(ri => ri.intent).join(' → ')
        : '';
      const datasetSummary = datasetProfile?.profile_json?.global?.fingerprint || '';

      const result = await runDiPrompt({
        promptId: DI_PROMPT_IDS.INTENT_PARSER, // reuse existing prompt ID for now
        input: {
          userMessage: buildPlannerPrompt(userMessage, { sessionSummary, datasetSummary }),
        },
        temperature: 0.1,
        maxOutputTokens: 1024,
      });

      const parsed = result?.parsed;
      if (parsed && validateTurnPlan(parsed)) {
        return makePlan({
          ...parsed,
          answer_language: parsed.answer_language || detectLanguage(userMessage),
          preferred_dataset_scope: hasUserData ? 'user_upload' : (parsed.preferred_dataset_scope || 'auto'),
          confidence: 0.85,
          _deterministic: false,
        });
      }
      console.warn('[agentPlanner] LLM returned invalid plan, falling back to deterministic');
    } catch (err) {
      console.warn('[agentPlanner] LLM planner failed, falling back to deterministic:', err?.message);
    }
  }

  // Deterministic fallback
  return buildDeterministicPlan(userMessage, { hasUserData, conversationHistory });
}

// ── Validation & Normalization ──────────────────────────────────────────────

/**
 * Validate a TurnPlanV1 object has all required fields with valid values.
 */
export function validateTurnPlan(plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (!VALID_TASK_TYPES.has(plan.task_type)) return false;
  if (!Array.isArray(plan.success_criteria) || plan.success_criteria.length === 0) return false;
  if (!Array.isArray(plan.allowed_tool_sets)) return false;
  // allowed_tool_sets can be empty for meta queries
  for (const group of plan.allowed_tool_sets) {
    if (!VALID_GROUP_NAMES.includes(group)) return false;
  }
  return true;
}

/**
 * Normalize and freeze a plan object.
 */
function makePlan(raw) {
  return Object.freeze({
    task_type: VALID_TASK_TYPES.has(raw.task_type) ? raw.task_type : 'analysis',
    success_criteria: Array.isArray(raw.success_criteria) ? raw.success_criteria.filter(Boolean) : [],
    required_dimensions: Array.isArray(raw.required_dimensions) ? raw.required_dimensions.filter(Boolean) : [],
    required_outputs: Array.isArray(raw.required_outputs)
      ? raw.required_outputs.filter(o => VALID_OUTPUTS.has(o))
      : [],
    allowed_tool_sets: Array.isArray(raw.allowed_tool_sets)
      ? raw.allowed_tool_sets.filter(g => VALID_GROUP_NAMES.includes(g))
      : ['analysis_core'],
    preferred_dataset_scope: VALID_DATASET_SCOPES.has(raw.preferred_dataset_scope)
      ? raw.preferred_dataset_scope
      : 'auto',
    answer_language: raw.answer_language === 'zh' ? 'zh' : 'en',
    review_level: VALID_REVIEW_LEVELS.has(raw.review_level) ? raw.review_level : 'deterministic',
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.5)),
    _deterministic: Boolean(raw._deterministic),
  });
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  generateTurnPlan,
  validateTurnPlan,
};
