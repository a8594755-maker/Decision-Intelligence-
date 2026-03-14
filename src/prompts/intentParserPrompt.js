/**
 * intentParserPrompt.js
 *
 * Builds the LLM prompt for intent classification + entity extraction.
 * Follows the same strict-JSON contract pattern as diJsonContracts.js.
 */

import { buildSessionSummary } from '../services/sessionContextService';

const clampText = (text, maxChars = 8000) => String(text || '').slice(0, maxChars);

/**
 * Build the intent parser prompt.
 *
 * @param {Object} params
 * @param {string} params.userMessage - the user's raw message
 * @param {Object|null} params.sessionContext - current SessionContext
 * @param {Object|null} params.domainContext - supply chain domain context (suppliers, risk items, etc.)
 * @returns {string} prompt text
 */
export function buildIntentParserPrompt({ userMessage, sessionContext, domainContext }) {
  const sessionSummary = buildSessionSummary(sessionContext);
  const domainSummary = buildDomainSummary(domainContext);

  return `You are the Intent Parser for a supply-chain Decision-Intelligence chat system.

You MUST return a single valid JSON object, and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Task
Given the user's message, classify the intent and extract structured entities (parameters).
Use the session context and domain context to resolve ambiguities.

## Session Context
${clampText(sessionSummary, 4000)}

## Domain Context
${clampText(domainSummary, 4000)}

## Intent Taxonomy

| Intent | When to use | Example user messages |
|--------|------------|----------------------|
| RUN_PLAN | User wants to run/generate a replenishment plan | "Run a plan", "Generate replenishment plan for next week", "Optimize my inventory" |
| RUN_FORECAST | User wants to run a demand forecast | "Run forecast", "Predict demand for next month" |
| RUN_WORKFLOW_A | User wants to run the full planning pipeline (profile→forecast→optimize→verify) | "Run workflow A", "Execute the full planning pipeline" |
| RUN_WORKFLOW_B | User wants to run risk scoring | "Run risk analysis", "Score supplier risk", "Run workflow B" |
| QUERY_DATA | User asks a question about existing data, metrics, or results | "What's the current inventory?", "Show me the last plan KPIs" |
| COMPARE_PLANS | User wants to compare current plan with previous or baseline | "Compare with last plan", "What changed?", "Show me the difference" |
| CHANGE_PARAM | User wants to change a parameter and re-run | "Change budget to 500K", "Set service level to 97%", "Increase lead time by 2 days" |
| WHAT_IF | User wants to run a what-if scenario | "What if demand increases 20%?", "What if lead time doubles?" |
| APPROVE | User wants to approve pending plans/POs | "Approve", "Approve all", "OK go ahead" |
| REJECT | User wants to reject pending plans/POs | "Reject", "Cancel", "Don't approve" |
| RUN_DIGITAL_TWIN | User wants to run a digital twin / supply chain simulation | "Run digital twin", "Simulate supply chain", "Run simulation with disaster scenario", "Digital twin analysis" |
| ACCEPT_NEGOTIATION_OPTION | User wants to apply a negotiation option from the active negotiation panel | "Apply option 2", "Try budget increase", "Use opt_001", "Go with the recommended option", "Try option 3", "Accept the first option" |
| ASSIGN_TASK | User wants the AI Employee to execute a complex multi-step task (report generation, data analysis, custom workflow) | "Generate monthly report", "Analyze risks and prepare summary", "Run analysis on uploaded data", "Prepare MBR deck", "做月報", "分析這份資料" |
| GENERAL_CHAT | General question, greeting, or anything that doesn't fit above | "Hello", "What can you do?", "Explain supply chain optimization" |

## Entity Extraction Rules
- budget_cap: Extract numeric value in the user's currency. "500K" = 500000, "1.2M" = 1200000.
- service_level_target: Extract as decimal (0-1). "97%" = 0.97, "99.5%" = 0.995.
- planning_horizon_days: Convert time expressions. "next week" = 7, "next month" = 30, "2 weeks" = 14.
- risk_mode: "with risk" / "risk-aware" / "include risk" = "on". "without risk" / "standard" = "off".
- lead_time_delta_days: Relative change. "increase by 2 days" = 2, "reduce by 3 days" = -3.
- demand_multiplier: "increase 20%" = 1.2, "decrease 10%" = 0.9, "double" = 2.0.
- safety_stock_override: Absolute value if specified.
- supplier_names, material_codes, plant_ids: Extract any mentioned entity names/codes.
- compare_with: "previous" for last plan, "baseline" for original, "risk_aware" for risk-adjusted.
- approval_action: "approve_all" for batch approve, "reject_all" for batch reject, "review" for individual review.
- simulation_scenario: For RUN_DIGITAL_TWIN. "normal" | "volatile" | "disaster" | "seasonal". Map "disaster"/"crisis"/"extreme" → "disaster", "volatile"/"unstable" → "volatile", "seasonal"/"holiday" → "seasonal", default "normal".
- chaos_intensity: For RUN_DIGITAL_TWIN. "calm" | "low" | "medium" | "high" | "extreme". Extract if user specifies disruption level.
- negotiation_option_id: For ACCEPT_NEGOTIATION_OPTION. Extract the option ID. "option 2" = "opt_002", "opt_001" = "opt_001", "option 1" = "opt_001". Map ordinal numbers to "opt_00N" format.
- negotiation_option_title: For ACCEPT_NEGOTIATION_OPTION. Extract descriptive title if user references by name. "budget increase" or "try recommended" or "expedite option".
- freeform_query: For QUERY_DATA or GENERAL_CHAT, capture the core question.

## Confidence Guidelines
- 0.9-1.0: Clear, unambiguous intent with explicit keywords (e.g., "Run a plan with budget 500K")
- 0.7-0.9: Likely intent but with some ambiguity (e.g., "Optimize inventory" → likely RUN_PLAN)
- 0.5-0.7: Ambiguous, could be multiple intents (e.g., "Check the plan" → QUERY_DATA or COMPARE_PLANS)
- Below 0.5: Very unclear, default to GENERAL_CHAT

## Output JSON Schema (must match exactly)
{
  "intent": "RUN_PLAN | RUN_FORECAST | RUN_WORKFLOW_A | RUN_WORKFLOW_B | QUERY_DATA | COMPARE_PLANS | CHANGE_PARAM | WHAT_IF | APPROVE | REJECT | GENERAL_CHAT | RUN_DIGITAL_TWIN | ACCEPT_NEGOTIATION_OPTION | ASSIGN_TASK",
  "confidence": 0.0,
  "entities": {
    "budget_cap": null,
    "service_level_target": null,
    "planning_horizon_days": null,
    "risk_mode": null,
    "supplier_names": [],
    "material_codes": [],
    "plant_ids": [],
    "lead_time_delta_days": null,
    "demand_multiplier": null,
    "safety_stock_override": null,
    "dataset_profile_id": null,
    "compare_with": null,
    "approval_action": null,
    "freeform_query": null,
    "simulation_scenario": null,
    "chaos_intensity": null,
    "negotiation_option_id": null,
    "negotiation_option_title": null
  },
  "requires_dataset": true,
  "suggested_response": "Brief confirmation of what will be executed"
}

## Rules
- confidence must be between 0.0 and 1.0.
- entities fields should be null if not mentioned by user. Do not guess.
- requires_dataset: true for intents that need dataset context (RUN_PLAN, RUN_FORECAST, RUN_WORKFLOW_A, RUN_WORKFLOW_B, CHANGE_PARAM, WHAT_IF, ACCEPT_NEGOTIATION_OPTION). false for QUERY_DATA, COMPARE_PLANS, APPROVE, REJECT, GENERAL_CHAT, RUN_DIGITAL_TWIN (uses synthetic data).
- suggested_response: A brief, user-friendly message confirming the interpreted action (e.g., "I'll run a plan with budget cap $500,000 and service level target 97%.").
- If user says something like "re-run" or "run again", map to the LAST intent in session context with same parameters, or RUN_PLAN if no history.
- If user says "change X and re-run", intent = CHANGE_PARAM (the re-run is implicit).

Now parse this user message:
"${clampText(userMessage, 2000)}"`;
}

function buildDomainSummary(domainContext) {
  if (!domainContext) return 'No domain context available.';

  const parts = [];

  if (domainContext.suppliers?.length) {
    const topSuppliers = domainContext.suppliers.slice(0, 10).map((s) => s.name || s.supplier_name || s.id).join(', ');
    parts.push(`Suppliers (top 10): ${topSuppliers}`);
  }

  if (domainContext.materials?.length) {
    const topMaterials = domainContext.materials.slice(0, 10).map((m) => m.material_code || m.sku || m.id).join(', ');
    parts.push(`Materials (top 10): ${topMaterials}`);
  }

  if (domainContext.riskItems?.length) {
    const topRisk = domainContext.riskItems.slice(0, 5).map((r) =>
      `${r.material_code || '?'}@${r.plant_id || '?'} (risk=${r.risk_score ?? '?'})`
    ).join(', ');
    parts.push(`Top Risk Items: ${topRisk}`);
  }

  if (domainContext.deliveryStats) {
    const ds = domainContext.deliveryStats;
    parts.push(`Delivery Stats: on_time_rate=${ds.on_time_rate ?? '?'}, avg_delay=${ds.avg_delay_days ?? '?'}d`);
  }

  return parts.length > 0 ? parts.join('\n') : 'No domain context loaded.';
}

/**
 * Validate the parsed intent contract.
 * @param {Object} parsed
 * @returns {boolean}
 */
export function validateIntentContract(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (typeof parsed.intent !== 'string') return false;
  if (typeof parsed.confidence !== 'number') return false;
  if (!parsed.entities || typeof parsed.entities !== 'object') return false;
  if (typeof parsed.requires_dataset !== 'boolean') return false;
  if (typeof parsed.suggested_response !== 'string') return false;

  const validIntents = [
    'RUN_PLAN', 'RUN_FORECAST', 'RUN_WORKFLOW_A', 'RUN_WORKFLOW_B',
    'QUERY_DATA', 'COMPARE_PLANS', 'CHANGE_PARAM', 'WHAT_IF',
    'APPROVE', 'REJECT', 'GENERAL_CHAT', 'RUN_DIGITAL_TWIN',
    'ACCEPT_NEGOTIATION_OPTION', 'ASSIGN_TASK',
  ];
  if (!validIntents.includes(parsed.intent)) return false;

  return true;
}

export default { buildIntentParserPrompt, validateIntentContract };
