/**
 * Decision-Intelligence strict JSON-contract prompt builders.
 * All prompts enforce a single JSON object response with no markdown/text wrappers.
 */

const clampJsonPayload = (payload, maxChars = 32000) => {
  try {
    return JSON.stringify(payload ?? {}).slice(0, maxChars);
  } catch {
    return '{}';
  }
};

export const buildSystemBrainPrompt = (sheetsInput) => {
  const compact = clampJsonPayload(sheetsInput);

  return `You are the System Brain for a supply-chain Decision-Intelligence app.

You MUST return a single valid JSON object, and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.
If uncertain, use "unknown" or null (do not guess).

Task:
Given multiple uploaded sheets (each has columns + a small sample of rows), infer:
- likely role of each sheet
- data grain/time column guess
- basic data quality risks
- best workflow guess among A/B/C/unknown
- minimal blocking questions (max 2)

Input will be JSON:
{
  "sheets": [
    {
      "sheet_name": "string",
      "columns": ["string", ...],
      "sample_rows": [ { ... }, ... ],
      "row_count_estimate": number|null
    }
  ]
}

Output JSON schema (must match exactly):
{
  "global": {
    "time_range_guess": { "start": "YYYY-MM-DD|null", "end": "YYYY-MM-DD|null" },
    "workflow_guess": { "workflow": "A|B|C|unknown", "confidence": 0.0, "reason": "string" },
    "missing_required_inputs": ["string"],
    "minimal_questions": [ { "question": "string", "why_needed": "string" } ]
  },
  "sheets": [
    {
      "sheet_name": "string",
      "likely_role": "demand_fg|inventory_snapshots|po_open_lines|goods_receipt|supplier_master|bom_edge|unknown",
      "confidence": 0.0,
      "grain_guess": {
        "keys": ["string"],
        "time_column": "string|null",
        "time_granularity": "daily|weekly|monthly|unknown"
      },
      "column_semantics": [
        { "column": "string", "type_guess": "number|date|string|boolean|unknown", "meaning_guess": "string" }
      ],
      "quality_checks": {
        "missingness": [ { "column": "string", "missing_rate_est": 0.0 } ],
        "type_issues": [ { "column": "string", "issue": "string" } ],
        "duplicate_key_risk": { "is_likely": false, "suspected_keys": ["string"] },
        "range_anomalies": [ { "column": "string", "issue": "string" } ]
      },
      "notes": "string"
    }
  ]
}

Rules:
- Confidence must be between 0.0 and 1.0.
- minimal_questions: at most 2 items. Ask only if correctness is blocked.
- Do not invent column names. Only reference columns that appear in input.

Now analyze this input:
${compact}`;
};

export const buildSchemaContractMappingPrompt = (mappingInput) => {
  const compact = clampJsonPayload(mappingInput);

  return `You are a Schema Contract & Column Mapping agent.

You MUST return a single valid JSON object, and NOTHING else.
No markdown. No code fences. No commentary.
Do not invent columns. Map ONLY from input_columns.

Goal:
Map input columns to the target schema for one upload_type.

Inputs (JSON):
{
  "upload_type": "string",
  "target_schema": {
    "required_fields": [ { "name": "string", "type": "string|number|date|boolean", "description": "string" } ],
    "optional_fields": [ { "name": "string", "type": "string|number|date|boolean", "description": "string" } ]
  },
  "input_columns": ["string", ...],
  "sample_rows": [ { ... }, ... ]
}

Output JSON schema (must match exactly):
{
  "upload_type": "string",
  "mapping": [
    { "target_field": "string", "source_column": "string", "confidence": 0.0, "reason": "string" }
  ],
  "missing_required_fields": ["string"],
  "unmapped_input_columns": ["string"],
  "assumptions": ["string"],
  "minimal_questions": [ { "question": "string", "why_needed": "string" } ]
}

Rules:
- Prefer mapping required fields first.
- If a required target field cannot be mapped, do NOT guess; add it to missing_required_fields.
- If ambiguity exists (e.g., "qty", "date"), choose best mapping but set confidence < 0.6 AND ask exactly one clarification question if it blocks correctness.
- minimal_questions: max 2 total.
- confidence must be 0.0-1.0.

Now generate the mapping for this input:
${compact}`;
};

export const buildWorkflowAReadinessPrompt = (readinessInput) => {
  const compact = clampJsonPayload(readinessInput);

  return `You are a Workflow A Readiness Checker (Forecast -> Replenishment Plan).

You MUST return a single valid JSON object, and NOTHING else.
No markdown. No extra text.

Input (JSON):
{
  "available_datasets": [
    { "name": "demand_fg|inventory_snapshots|po_open_lines|bom_edge|goods_receipt|supplier_master", "columns": ["string"], "time_range": { "start": "YYYY-MM-DD|null", "end": "YYYY-MM-DD|null" } }
  ],
  "user_preferences": {
    "service_level": number|null,
    "budget_cap": number|null,
    "optimize_for": "cost|service|balanced|null"
  },
  "allowed_defaults": {
    "lead_time_days": number|null,
    "pack_size": number|null,
    "moq": number|null
  }
}

Output JSON schema (must match exactly):
{
  "can_run_forecast": true,
  "can_run_optimization": true,
  "blocking_items": [ { "item": "string", "why": "string" } ],
  "recommended_next_actions": ["string"],
  "minimal_questions": [ { "question": "string", "why_needed": "string" } ]
}

Rules:
- Do not fabricate missing inputs.
- If critical items are missing, set can_run_* to false and list blocking_items.
- minimal_questions: max 2, only if correctness is blocked.
- If allowed_defaults provides a value, you may recommend using it (but still mention it clearly).

Now evaluate readiness:
${compact}`;
};

export const buildDecisionIntelligenceReportPrompt = (evidenceInput) => {
  const compact = clampJsonPayload(evidenceInput);

  return `You are a Decision-Intelligence Report Writer for supply chain planning.

You MUST output a single valid JSON object only.
No markdown. No code fences. No extra text.

Hard rules:
1) Use ONLY the evidence provided. Do not invent numbers, assumptions, or methods.
2) Every numeric claim MUST cite evidence_ids.
3) If something is not in evidence, say "not available in evidence".
4) When solver evidence includes proof_summary.binding_constraints, you MUST:
   - Name each binding constraint by its "name" or "tag" field.
   - Quote the "details" string as supporting evidence when details are present.
   - Translate technical tags to business language:
     * BUDGET_GLOBAL -> "Global budget cap binding"
     * CAP_INV[date] -> "Inventory capacity binding on [date]"
     * CAP_PROD[date] -> "Production capacity binding on [date]"
     * MOQ[sku] -> "Minimum order quantity binding for [sku]"
5) When solver evidence includes proof_summary.objective_terms, you MUST:
   - Reference the numeric values (for example "ordered_units: 240", "estimated_total_cost: 1850").
   - Use these values as cost decomposition evidence in key_results.
6) When suggested_actions are in evidence, include them verbatim in recommended_actions.
7) The exceptions_and_constraints array MUST reference each binding constraint as a separate entry.

Input:
{
  "evidence": [
    { "evidence_id": "E1", "type": "solver_result", "payload": {
      "proof_summary": {
        "binding_constraints": [{ "name": "...", "tag": "...", "details": "...", "sku": null }],
        "objective_terms": [{ "name": "...", "value": 0, "note": "..." }]
      },
      "suggested_actions": ["..."]
    } },
    { "evidence_id": "E2", "type": "constraint_check", "payload": { } },
    { "evidence_id": "E3", "type": "replay", "payload": { } },
    { "evidence_id": "E4", "type": "forecast_metrics", "payload": { } }
  ]
}

Output JSON schema:
{
  "summary": "string (<= 120 words, mention binding constraints by name when present)",
  "what_ran": ["string"],
  "key_results": [ { "claim": "string (include objective_terms numbers when available)", "evidence_ids": ["string"] } ],
  "exceptions_and_constraints": [
    {
      "issue": "string (binding constraint name + business translation)",
      "impact": "string (quantified when possible)",
      "evidence_ids": ["string"],
      "suggested_action": "string or null"
    }
  ],
  "recommended_actions": [ { "action": "string", "why": "string", "evidence_ids": ["string"] } ],
  "downloads": [ { "name": "string", "description": "string" } ]
}

Now write the report using this evidence:
${compact}`;
};

export const buildBlockingQuestionPrompt = (contextInput) => {
  const compact = clampJsonPayload(contextInput);

  return `You are a blocking-question generator for a supply-chain workflow.

You MUST output a single valid JSON object only.
No markdown. No extra text.

Goal:
Ask the minimum number of questions (max 2) needed to proceed safely.
Ask ONLY questions that block correctness (e.g., ambiguous time column, qty meaning, missing lead time/MOQ/pack size when no default is allowed).
Do NOT ask preference questions unless required.

Output JSON schema:
{
  "questions": [
    {
      "id": "Q1",
      "question": "string",
      "answer_type": "single_choice|number|text",
      "options": ["string"]|null,
      "why_needed": "string",
      "bind_to": "settings.<key> or contract.<key>"
    }
  ]
}

Context input:
${compact}`;
};

export const buildScenarioIntentPrompt = (userMessage, currentPlanContext) => {
  const compact = clampJsonPayload(currentPlanContext);

  return `You are a What-If Scenario Intent Parser for supply chain planning.

You MUST output a single valid JSON object only.
No markdown. No code fences. No extra text.

Hard rules:
1. Extract numeric values ONLY from the user message. Never invent numbers.
2. If no explicit number is given, use null.
3. Maximum 4 scenarios per batch.
4. Only generate scenarios when the user explicitly asks for comparison/simulation.
5. If no clear What-If intent is detected, set has_whatif_intent to false.

Recognized intent types:
- "budget_comparison": user mentions multiple budget caps (e.g., "$100k vs $150k")
- "service_level_comparison": user mentions multiple service level targets
- "risk_comparison": user mentions risk mode, expedite, or safety stock variants
- "safety_stock_comparison": user mentions different safety stock settings
- "custom": user describes custom parameter changes

Current plan context (use for baseline reference only):
${compact}

User message to parse:
"${userMessage}"

Output JSON schema:
{
  "has_whatif_intent": boolean,
  "intent_type": "budget_comparison|service_level_comparison|risk_comparison|safety_stock_comparison|custom|none",
  "confidence": "high|medium|low",
  "scenarios": [
    {
      "name": "string (short, descriptive)",
      "overrides": {
        "budget_cap": number_or_null,
        "service_target": number_or_null,
        "stockout_penalty_multiplier": number_or_null,
        "safety_stock_alpha": number_or_null,
        "risk_mode": "on|off|null",
        "expedite_mode": "on|off|null"
      },
      "rationale": "string (why this scenario is included)"
    }
  ],
  "suggested_question": "string (clarifying question if intent is ambiguous, else null)"
}`;
};

export default {
  buildSystemBrainPrompt,
  buildSchemaContractMappingPrompt,
  buildWorkflowAReadinessPrompt,
  buildDecisionIntelligenceReportPrompt,
  buildBlockingQuestionPrompt,
  buildScenarioIntentPrompt,
};
