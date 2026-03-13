/**
 * scenarioChatBridge.js
 *
 * Orchestrates the full scenario-from-chat pipeline:
 *   1. Parse user text → structured overrides (scenarioIntentParser)
 *   2. Create scenario record (diScenariosService)
 *   3. Execute scenario plan (scenarioEngine)
 *   4. Build decision_bundle from comparison (decisionTaskService + evidenceAssembler)
 *   5. Return chat messages ready for appendMessagesToCurrentConversation
 *
 * This bridge is the single entry point for "text → scenario → structured reply".
 */

import { parseScenarioFromText, validateScenarioOverrides, looksLikeScenario } from './scenarioIntentParser';
import { createScenario } from './diScenariosService';
import { executeScenarioPlan } from './scenarioEngine';
import { buildScenarioDecisionBundle } from './decisionTaskService';
import { assembleScenarioEvidence } from './evidenceAssembler';

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatOverridesForChat(overrides) {
  const parts = [];
  if (overrides.demand_multiplier != null) {
    const pct = Math.round((overrides.demand_multiplier - 1) * 100);
    parts.push(`demand ${pct >= 0 ? '+' : ''}${pct}%`);
  }
  if (overrides.lead_time_delta_days != null) {
    parts.push(`lead time +${overrides.lead_time_delta_days}d`);
  }
  if (overrides.service_target != null) {
    parts.push(`SL target ${(overrides.service_target * 100).toFixed(0)}%`);
  }
  if (overrides.budget_cap != null) {
    parts.push(`budget $${overrides.budget_cap.toLocaleString()}`);
  }
  if (overrides.risk_mode === 'on') parts.push('risk-aware');
  if (overrides.expedite_mode === 'on') parts.push('expedite');
  if (overrides.chaos_intensity) parts.push(`chaos=${overrides.chaos_intensity}`);
  if (overrides.simulation_scenario) parts.push(`scenario=${overrides.simulation_scenario}`);
  if (overrides.stockout_penalty_multiplier != null) {
    parts.push(`stockout penalty ${overrides.stockout_penalty_multiplier}×`);
  }
  if (overrides.holding_cost_multiplier != null) {
    parts.push(`holding cost ${overrides.holding_cost_multiplier}×`);
  }
  if (overrides.safety_stock_alpha != null) {
    parts.push(`safety stock α=${overrides.safety_stock_alpha}`);
  }
  if (overrides.lead_time_buffer_days != null) {
    parts.push(`LT buffer −${overrides.lead_time_buffer_days}d`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no overrides detected';
}

function ts() {
  return new Date().toISOString();
}

// ── Main bridge ─────────────────────────────────────────────────────────────

/**
 * Run a scenario from a natural-language chat message.
 *
 * @param {object} params
 * @param {string} params.messageText       - User's raw message
 * @param {string} params.userId            - Current user ID
 * @param {number} params.baseRunId         - Baseline plan run ID
 * @param {Function} [params.onProgress]    - Optional progress callback({ step, message })
 * @returns {object} { messages, scenarioRunId, comparison, bundle, overrides, parseResult }
 *   - messages: Array of chat message objects ready to append
 *   - scenarioRunId: The new scenario run ID (or null on failure)
 *   - comparison: The scenario_comparison payload
 *   - bundle: The decision_bundle payload
 *   - overrides: The sanitized overrides used
 *   - parseResult: The raw parse result from scenarioIntentParser
 */
export async function runScenarioFromChat({
  messageText,
  userId,
  baseRunId,
  onProgress,
}) {
  const messages = [];

  // 1. Parse scenario text
  const parseResult = await parseScenarioFromText(messageText);

  if (parseResult.confidence < 0.5 || Object.keys(parseResult.overrides).length === 0) {
    messages.push({
      role: 'ai',
      content: 'I detected a scenario intent but couldn\'t extract specific parameters. Try something like "What if demand increases by 20%?" or "假設延遲兩週".',
      timestamp: ts(),
    });
    return { messages, scenarioRunId: null, comparison: null, bundle: null, overrides: {}, parseResult };
  }

  // 2. Validate & sanitize overrides
  const { sanitized, errors } = validateScenarioOverrides(parseResult.overrides);

  const overridesSummary = formatOverridesForChat(sanitized);
  messages.push({
    role: 'ai',
    content: `Running scenario: **${overridesSummary}** (base run #${baseRunId})…`,
    timestamp: ts(),
  });

  if (errors.length > 0) {
    messages.push({
      role: 'ai',
      content: `⚠ Some values were adjusted: ${errors.join('; ')}`,
      timestamp: ts(),
    });
  }

  // 3. Create scenario record
  let scenario;
  try {
    const { scenario: created, cached } = await createScenario({
      user_id: userId,
      base_run_id: Number(baseRunId),
      overrides: sanitized,
      name: messageText.slice(0, 100),
    });

    if (!created) {
      // Table not migrated — fall back to in-memory execution
      scenario = {
        id: `local_${Date.now()}`,
        base_run_id: Number(baseRunId),
        overrides: sanitized,
        engine_flags: {},
      };
    } else if (cached && created.scenario_run_id) {
      // Cache hit — skip re-execution, build bundle from existing comparison
      messages.push({
        role: 'ai',
        content: `Scenario already computed (run #${created.scenario_run_id}). Loading cached results…`,
        timestamp: ts(),
      });
      // We still need to build the bundle from the cached comparison
      // For now, return a lightweight result — the caller can load artifacts
      return {
        messages,
        scenarioRunId: created.scenario_run_id,
        comparison: null,
        bundle: null,
        overrides: sanitized,
        parseResult,
        cached: true,
      };
    } else {
      scenario = created;
    }
  } catch (err) {
    console.warn('[scenarioChatBridge] createScenario failed, using local fallback:', err?.message);
    scenario = {
      id: `local_${Date.now()}`,
      base_run_id: Number(baseRunId),
      overrides: sanitized,
      engine_flags: {},
    };
  }

  // 4. Execute scenario plan
  let scenarioRunId = null;
  let comparisonPayload = null;

  try {
    onProgress?.({ step: 'execute', message: 'Executing scenario plan…' });

    const result = await executeScenarioPlan({
      userId,
      scenario,
      onProgress,
    });

    scenarioRunId = result.scenarioRunId;
    comparisonPayload = result.comparisonPayload;
  } catch (execErr) {
    messages.push({
      role: 'ai',
      content: `Scenario execution failed: ${execErr.message}`,
      timestamp: ts(),
    });
    messages.push({
      role: 'ai',
      type: 'plan_error_card',
      payload: {
        run_id: null,
        message: execErr.message,
        blocking_questions: [],
        constraint_violations: [],
      },
      timestamp: ts(),
    });
    return { messages, scenarioRunId: null, comparison: null, bundle: null, overrides: sanitized, parseResult };
  }

  // 5. Build evidence refs from comparison
  const evidenceRefs = assembleScenarioEvidence({ comparison: comparisonPayload });

  // 6. Build decision_bundle
  const bundle = buildScenarioDecisionBundle({
    comparison: comparisonPayload,
    evidence: evidenceRefs,
    nextActions: [
      { action_id: 'run_what_if', label: 'Try Another Scenario', priority: 1 },
      { action_id: 'compare_plans', label: 'Compare Plans', priority: 2 },
      { action_id: 'request_approval', label: 'Submit for Approval', priority: 3 },
    ],
  });

  // 7. Build chat messages
  messages.push({
    role: 'ai',
    content: `Scenario completed (run #${scenarioRunId}).`,
    timestamp: ts(),
  });

  // Emit scenario comparison card if comparison data is available
  if (comparisonPayload) {
    messages.push({
      role: 'ai',
      type: 'scenario_comparison_card',
      payload: comparisonPayload,
      timestamp: ts(),
    });
  }

  // Emit decision bundle card
  messages.push({
    role: 'ai',
    type: 'decision_bundle_card',
    payload: bundle,
    timestamp: ts(),
  });

  return {
    messages,
    scenarioRunId,
    comparison: comparisonPayload,
    bundle,
    overrides: sanitized,
    parseResult,
  };
}

/**
 * Quick check: can we run a scenario from this message?
 * Returns true if the message looks like a scenario AND we have a baseline.
 */
export function canRunScenarioFromChat(messageText, baseRunId) {
  if (!messageText || !baseRunId) return false;
  return looksLikeScenario(messageText);
}

export default {
  runScenarioFromChat,
  canRunScenarioFromChat,
};
