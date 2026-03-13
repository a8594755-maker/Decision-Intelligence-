/**
 * chatIntentService.js
 *
 * Core brain for the SmartOps 2.0 Autonomous Chat.
 * Parses user intent via LLM, extracts entities, and routes to action handlers.
 */

import { runDiPrompt, DI_PROMPT_IDS } from './diModelRouterService';
import { recordIntent } from './sessionContextService';

// ── Constants ────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.7;

const VALID_INTENTS = new Set([
  'RUN_PLAN', 'RUN_FORECAST', 'RUN_WORKFLOW_A', 'RUN_WORKFLOW_B',
  'QUERY_DATA', 'COMPARE_PLANS', 'CHANGE_PARAM', 'WHAT_IF',
  'APPROVE', 'REJECT', 'GENERAL_CHAT', 'RUN_DIGITAL_TWIN',
  'ACCEPT_NEGOTIATION_OPTION', 'ASSIGN_TASK',
]);

const EXECUTION_INTENTS = new Set([
  'RUN_PLAN', 'RUN_FORECAST', 'RUN_WORKFLOW_A', 'RUN_WORKFLOW_B',
  'CHANGE_PARAM', 'WHAT_IF', 'RUN_DIGITAL_TWIN',
  'ACCEPT_NEGOTIATION_OPTION', 'ASSIGN_TASK',
]);

// ── Local Fast-Path Intent Detection ─────────────────────────────────────────
// Skip expensive LLM call for messages that are clearly general chat.

const ACTION_KEYWORDS = /\b(run|execute|plan|forecast|optimize|approval|approve|reject|compare|what.?if|scenario|simulate|digital.?twin|change|set|update|budget|service.?level|horizon|risk|workflow|assign|task|create|generate|build|make|produce|分析|執行|預測|比較|審批|核准|否決|模擬|情境|任務|生成|建立|製作|指派)\b/i;

/**
 * Returns true if the message likely needs LLM-powered intent parsing.
 * Short greetings / general chat skip the expensive round-trip.
 */
const needsLlmParsing = (message) => {
  const trimmed = String(message || '').trim();
  // Very short messages (< 6 words) without action keywords → general chat
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 5 && !ACTION_KEYWORDS.test(trimmed)) return false;
  // Longer messages with action keywords → need LLM
  return ACTION_KEYWORDS.test(trimmed) || wordCount > 20;
};

// ── Intent Parsing ───────────────────────────────────────────────────────────

/**
 * Parse user message into a structured intent.
 *
 * @param {Object} params
 * @param {string} params.userMessage
 * @param {Object|null} params.sessionContext
 * @param {Object|null} params.domainContext
 * @returns {Promise<Object>} parsed intent: { intent, confidence, entities, requires_dataset, suggested_response }
 */
export async function parseIntent({ userMessage, sessionContext, domainContext }) {
  // Fast path: skip LLM for obvious general chat
  if (!needsLlmParsing(userMessage)) {
    console.info('[chatIntentService] Fast-path: skipping LLM intent parsing for general chat');
    return fallbackIntent(userMessage);
  }

  try {
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.INTENT_PARSER,
      input: { userMessage, sessionContext, domainContext },
      temperature: 0.1,
      maxOutputTokens: 1024,
    });

    const parsed = result?.parsed;
    if (!parsed || !VALID_INTENTS.has(parsed.intent)) {
      return fallbackIntent(userMessage);
    }

    // Normalize confidence bounds
    parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

    // Ensure entities object exists
    if (!parsed.entities || typeof parsed.entities !== 'object') {
      parsed.entities = {};
    }

    return parsed;
  } catch (error) {
    console.warn('[chatIntentService] Intent parsing failed, falling back to GENERAL_CHAT:', error?.message);
    return fallbackIntent(userMessage);
  }
}

/**
 * Fallback intent when LLM call fails or returns invalid data.
 */
function fallbackIntent(userMessage) {
  return {
    intent: 'GENERAL_CHAT',
    confidence: 0.3,
    entities: { freeform_query: userMessage },
    requires_dataset: false,
    suggested_response: '',
  };
}

// ── Action Routing ───────────────────────────────────────────────────────────

/**
 * Route a parsed intent to the appropriate handler.
 *
 * @param {Object} parsedIntent - from parseIntent()
 * @param {Object} sessionContext - current session context
 * @param {Object} handlers - map of handler functions:
 *   {
 *     executePlanFlow: ({ constraintsOverride, objectiveOverride, planningHorizonDays, riskMode }) => Promise,
 *     executeForecastFlow: ({ datasetProfileId }) => Promise,
 *     executeWorkflowAFlow: ({ datasetProfileId, riskMode }) => Promise,
 *     executeWorkflowBFlow: ({ datasetProfileId }) => Promise,
 *     handleParameterChange: (parsedIntent, sessionContext) => Promise,
 *     comparePlans: (sessionContext) => Promise,
 *     runWhatIf: (scenarioOverrides) => Promise,
 *     handleApproval: (action) => Promise,
 *     streamChat: (message) => Promise,
 *     appendMessage: (message) => void,
 *     onNoDataset: () => void,
 *   }
 * @param {Object} options
 * @param {string} options.userId
 * @param {string} options.conversationId
 * @param {number|null} options.datasetProfileId - current active dataset
 * @returns {Promise<{ handled: boolean, intent: string }>}
 */
export async function routeIntent(parsedIntent, sessionContext, handlers, options = {}) {
  const { intent, confidence, entities } = parsedIntent;
  const { userId, conversationId, datasetProfileId } = options;

  // Below confidence threshold → fall through to general chat
  if (confidence < CONFIDENCE_THRESHOLD && intent !== 'GENERAL_CHAT') {
    return { handled: false, intent };
  }

  // Record intent in session history
  if (userId && conversationId) {
    recordIntent(userId, conversationId, intent, entities);
  }

  // Show suggested response as confirmation
  if (parsedIntent.suggested_response && handlers.appendMessage) {
    handlers.appendMessage({
      role: 'ai',
      content: parsedIntent.suggested_response,
      timestamp: new Date().toISOString(),
      meta: { intent, confidence },
    });
  }

  // Check dataset requirement
  if (parsedIntent.requires_dataset && !datasetProfileId) {
    if (handlers.onNoDataset) {
      handlers.onNoDataset();
    } else if (handlers.appendMessage) {
      handlers.appendMessage({
        role: 'ai',
        content: 'Please upload a dataset first before running this action. You can drag and drop a CSV/XLSX file into the chat.',
        timestamp: new Date().toISOString(),
      });
    }
    return { handled: true, intent };
  }

  const actionParams = buildActionParams(parsedIntent, sessionContext);

  switch (intent) {
    case 'RUN_PLAN':
      if (handlers.executePlanFlow) {
        await handlers.executePlanFlow({
          datasetProfileId: entities.dataset_profile_id || datasetProfileId,
          constraintsOverride: actionParams.constraints,
          objectiveOverride: actionParams.objective,
          planningHorizonDays: entities.planning_horizon_days,
          riskMode: entities.risk_mode,
        });
      }
      return { handled: true, intent };

    case 'RUN_FORECAST':
      if (handlers.executeForecastFlow) {
        await handlers.executeForecastFlow({
          datasetProfileId: entities.dataset_profile_id || datasetProfileId,
        });
      }
      return { handled: true, intent };

    case 'RUN_WORKFLOW_A':
      if (handlers.executeWorkflowAFlow) {
        await handlers.executeWorkflowAFlow({
          datasetProfileId: entities.dataset_profile_id || datasetProfileId,
          riskMode: entities.risk_mode,
        });
      }
      return { handled: true, intent };

    case 'RUN_WORKFLOW_B':
      if (handlers.executeWorkflowBFlow) {
        await handlers.executeWorkflowBFlow({
          datasetProfileId: entities.dataset_profile_id || datasetProfileId,
        });
      }
      return { handled: true, intent };

    case 'CHANGE_PARAM':
      if (handlers.handleParameterChange) {
        await handlers.handleParameterChange(parsedIntent, sessionContext);
      }
      return { handled: true, intent };

    case 'COMPARE_PLANS':
      if (handlers.comparePlans) {
        await handlers.comparePlans(sessionContext);
      }
      return { handled: true, intent };

    case 'WHAT_IF':
      if (handlers.runWhatIf) {
        await handlers.runWhatIf(buildScenarioOverrides(entities));
      }
      return { handled: true, intent };

    case 'RUN_DIGITAL_TWIN':
      if (handlers.executeDigitalTwinFlow) {
        await handlers.executeDigitalTwinFlow({
          scenario: entities.simulation_scenario || 'normal',
          chaosIntensity: entities.chaos_intensity || null,
        });
      }
      return { handled: true, intent };

    case 'ACCEPT_NEGOTIATION_OPTION':
      if (handlers.applyNegotiationOption) {
        await handlers.applyNegotiationOption({
          optionId: entities.negotiation_option_id,
          optionTitle: entities.negotiation_option_title,
        });
      }
      return { handled: true, intent };

    case 'ASSIGN_TASK':
      if (handlers.assignTask) {
        await handlers.assignTask({
          userMessage: entities.freeform_query || '',
          employeeId: entities.employee_id || null,
        });
      }
      return { handled: true, intent };

    case 'APPROVE':
    case 'REJECT':
      if (handlers.handleApproval) {
        await handlers.handleApproval(entities.approval_action || (intent === 'APPROVE' ? 'approve_all' : 'reject_all'));
      }
      return { handled: true, intent };

    case 'QUERY_DATA':
      // Fall through to general chat with enriched context
      return { handled: false, intent };

    case 'GENERAL_CHAT':
    default:
      return { handled: false, intent };
  }
}

// ── Parameter Building ───────────────────────────────────────────────────────

/**
 * Build action parameters by merging intent entities with session context overrides.
 *
 * @param {Object} parsedIntent
 * @param {Object} sessionContext
 * @returns {Object} { constraints, objective }
 */
export function buildActionParams(parsedIntent, sessionContext) {
  const entities = parsedIntent?.entities || {};
  const ctx = sessionContext || {};
  const currentConstraints = ctx.plan?.constraints || {};
  const currentObjective = ctx.plan?.objective || {};

  // Build constraints override
  const constraints = {};
  if (entities.budget_cap != null) {
    constraints.budget_cap = entities.budget_cap;
  } else if (ctx.overrides?.budget_cap != null) {
    constraints.budget_cap = ctx.overrides.budget_cap;
  }

  // Build objective override
  const objective = {};
  if (entities.service_level_target != null) {
    objective.service_level_target = entities.service_level_target;
  } else if (ctx.overrides?.service_level_target != null) {
    objective.service_level_target = ctx.overrides.service_level_target;
  }

  // Merge with current plan constraints/objective if they exist
  return {
    constraints: Object.keys(constraints).length > 0
      ? { ...currentConstraints, ...constraints }
      : null,
    objective: Object.keys(objective).length > 0
      ? { ...(typeof currentObjective === 'string' ? { optimize_for: currentObjective } : currentObjective), ...objective }
      : null,
  };
}

/**
 * Build scenario overrides for WHAT_IF intent.
 *
 * @param {Object} entities - extracted entities
 * @returns {Object} scenarioOverrides for runPlanFromDatasetProfile
 */
function buildScenarioOverrides(entities) {
  const overrides = {};

  if (entities.demand_multiplier != null) {
    overrides.demand_multiplier = entities.demand_multiplier;
  }
  if (entities.lead_time_delta_days != null) {
    overrides.lead_time_delta_days = entities.lead_time_delta_days;
  }
  if (entities.safety_stock_override != null) {
    overrides.safety_stock_override = entities.safety_stock_override;
  }
  if (entities.budget_cap != null) {
    overrides.budget_cap = entities.budget_cap;
  }

  return overrides;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Check if an intent is an execution intent (requires pipeline execution).
 * @param {string} intent
 * @returns {boolean}
 */
export function isExecutionType(intent) {
  return EXECUTION_INTENTS.has(intent);
}

export { CONFIDENCE_THRESHOLD };

export default {
  parseIntent,
  routeIntent,
  buildActionParams,
  isExecutionType,
  CONFIDENCE_THRESHOLD,
};
