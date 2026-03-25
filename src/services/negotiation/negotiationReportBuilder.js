/**
 * Negotiation Report Builder - Step 9 Agentic Negotiation Loop v0
 *
 * Calls the LLM (DeepSeek) with structured output to generate a negotiation
 * narrative. The LLM receives ONLY pre-computed numbers from the evaluation
 * and evidence refs; it MUST NOT invent new numbers.
 *
 * Evidence-first validation:
 *   After receiving LLM output, any numeric value in the text is checked
 *   against the set of numbers present in the evidence context. If the LLM
 *   fabricates a number not in evidence, that output is rejected and a
 *   rule-based fallback is used.
 */

import { runDiPrompt, DI_PROMPT_IDS } from '../planning/diModelRouterService';

// ---------------------------------------------------------------------------
// Evidence number extraction
// ---------------------------------------------------------------------------

/**
 * Extract all finite numbers mentioned in the evidence data.
 * Returns a Set<string> of number strings (rounded to 6 dp) for lookup.
 */
function extractEvidenceNumbers(rankedOptions) {
  const nums = new Set();

  const pushNum = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) {
      // Store rounded forms to handle floating-point comparisons
      nums.add(String(Math.round(n * 1e6) / 1e6));
      nums.add(String(Math.round(n * 1e4) / 1e4));
      nums.add(String(Math.round(n * 100) / 100));
      nums.add(String(Math.round(n)));
    }
  };

  (Array.isArray(rankedOptions) ? rankedOptions : []).forEach((opt) => {
    const kpis = opt?.kpis || {};
    [kpis.base, kpis.scenario, kpis.delta].forEach((group) => {
      if (!group || typeof group !== 'object') return;
      Object.values(group).forEach((v) => pushNum(v));
    });

    const cs = opt?.constraints_summary || {};
    [cs.base_violations, cs.scenario_violations, cs.violations_delta].forEach(
      pushNum
    );
    pushNum(opt?.rank_score);
  });

  return nums;
}

/**
 * Scan LLM text for numeric values (integers, decimals, percentages) and
 * return any that are NOT present in the evidence set.
 *
 * A number is "allowed" if:
 *   - It matches an evidence number (after normalization), OR
 *   - It is a very small ordinal (1-6, used for option ranking), OR
 *   - It is a percentage derived from an evidence decimal (e.g. 95.00 from 0.95)
 */
function detectFabricatedNumbers(text, evidenceNums) {
  if (!text || typeof text !== 'string') return [];

  // Match numbers that look like data values (not pure ordinals 1-6)
  const numRegex = /\b(\d+(?:\.\d+)?)\b/g;
  const fabricated = [];
  let match;

  while ((match = numRegex.exec(text)) !== null) {
    const raw = match[1];
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;

    // Allow small ordinals (option numbering)
    if (Number.isInteger(n) && n >= 0 && n <= 6) continue;

    // Allow percentage version of evidence decimal (multiply by 100)
    const asDecimal = n / 100;
    const pctKey = String(Math.round(asDecimal * 1e6) / 1e6);

    const directKey = String(Math.round(n * 1e6) / 1e6);
    const roundedKey = String(Math.round(n * 100) / 100);

    if (
      evidenceNums.has(directKey) ||
      evidenceNums.has(roundedKey) ||
      evidenceNums.has(pctKey)
    ) {
      continue;
    }

    fabricated.push(raw);
  }

  return fabricated;
}

// ---------------------------------------------------------------------------
// Rule-based fallback report
// ---------------------------------------------------------------------------

function buildRuleBasedReport(rankedOptions, baseRunId) {
  const top = Array.isArray(rankedOptions) ? rankedOptions[0] : null;
  const feasibleCount = (Array.isArray(rankedOptions) ? rankedOptions : []).filter(
    (o) => o.status === 'succeeded' && o.kpis?.scenario?.feasible !== false
  ).length;

  const summary = top
    ? `Negotiation analysis for run ${baseRunId} found ${
        rankedOptions.length
      } candidate options, of which ${feasibleCount} yielded a feasible plan. ` +
      `Top recommendation: ${top.option_id}.`
    : `No feasible negotiation options found for run ${baseRunId}.`;

  const reasons = [];
  if (top) {
    reasons.push(
      `Option ${top.option_id} ranked highest based on: ${top.kpis?.scenario?.feasible ? 'feasibility achieved' : 'infeasibility reduced'}.`
    );
    if (top.kpis?.delta?.service_level_proxy !== null) {
      reasons.push(
        `Service level delta (computed): ${top.kpis.delta.service_level_proxy >= 0 ? '+' : ''}${
          top.kpis.delta.service_level_proxy
        }.`
      );
    }
    if (top.kpis?.delta?.estimated_total_cost !== null) {
      reasons.push(
        `Cost delta (computed): ${top.kpis.delta.estimated_total_cost >= 0 ? '+' : ''}${
          top.kpis.delta.estimated_total_cost
        }.`
      );
    }
  }

  return {
    summary,
    recommended_option_id: top?.option_id || null,
    bullet_reasons: reasons,
    generated_by: 'rule_based_fallback',
    evidence_validated: true
  };
}

// ---------------------------------------------------------------------------
// LLM structured output prompt
// ---------------------------------------------------------------------------

const NEGOTIATION_REPORT_SYSTEM_PROMPT = `You are a supply chain planning assistant generating a negotiation report.
RULES (strictly enforced):
1. Do NOT invent any numbers. Only reference numbers from the provided evidence context.
2. Use evidence_refs to cite specific data points.
3. Output must be JSON matching the required schema.
4. Keep summary under 200 words.
5. Each bullet_reason must cite at least one evidence_ref.`;

function buildNegotiationReportPrompt(rankedOptions, baseRunId, intent) {
  const topOptions = (Array.isArray(rankedOptions) ? rankedOptions : []).slice(0, 6);

  return {
    task: 'negotiation_report',
    base_run_id: baseRunId,
    user_intent: intent || {},
    ranked_options: topOptions.map((opt) => ({
      option_id: opt.option_id,
      status: opt.status,
      rank_score: opt.rank_score,
      kpis_delta: opt.kpis?.delta || {},
      kpis_scenario: opt.kpis?.scenario || {},
      constraints_summary: opt.constraints_summary || {},
      evidence_refs: opt.evidence_refs || [],
      notes: opt.notes || []
    })),
    output_schema: {
      summary: 'string (max 200 words, no invented numbers)',
      recommended_option_id: 'string (e.g. opt_001) or null',
      bullet_reasons: ['string (each must reference an evidence_ref, no invented numbers)']
    }
  };
}

// ---------------------------------------------------------------------------
// Exported: buildNegotiationReport
// ---------------------------------------------------------------------------

/**
 * Build a negotiation report using LLM structured output with evidence-first
 * validation. Falls back to rule-based report if LLM output is invalid.
 *
 * @param {Object} params
 * @param {string|number} params.baseRunId       - plan child run ID
 * @param {Object[]}      params.rankedOptions   - from negotiation_evaluation
 * @param {Object}        params.intent          - { service_target, budget_cap }
 * @param {Object[]}      params.evidenceRefs    - optional additional evidence ref list
 * @returns {Object} negotiation_report payload
 */
export async function buildNegotiationReport({
  baseRunId,
  rankedOptions = [],
  intent = {},
  evidenceRefs = []
}) {
  const evidenceNums = extractEvidenceNumbers(rankedOptions);

  // Attempt LLM structured output
  let llmOutput = null;
  let llmProvider = null;
  let llmModel = null;
  let validationPassed = false;
  let fabricatedNumbers = [];

  try {
    const promptInput = buildNegotiationReportPrompt(
      rankedOptions,
      baseRunId,
      intent
    );

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.REPORT_SUMMARY,
      input: {
        stage: 'negotiation_report',
        system_note: NEGOTIATION_REPORT_SYSTEM_PROMPT,
        ...promptInput
      },
      temperature: 0.05,
      maxOutputTokens: 1000
    });

    llmProvider = result?.provider;
    llmModel = result?.model;

    const parsed = result?.parsed;

    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.summary === 'string' &&
      parsed.summary.trim().length > 0
    ) {
      // Evidence-first validation: scan for fabricated numbers
      const allText = [
        parsed.summary || '',
        ...(Array.isArray(parsed.bullet_reasons) ? parsed.bullet_reasons : [])
      ].join(' ');

      fabricatedNumbers = detectFabricatedNumbers(allText, evidenceNums);

      if (fabricatedNumbers.length === 0) {
        validationPassed = true;
        llmOutput = {
          summary: String(parsed.summary).trim(),
          recommended_option_id:
            typeof parsed.recommended_option_id === 'string'
              ? parsed.recommended_option_id.trim()
              : null,
          bullet_reasons: Array.isArray(parsed.bullet_reasons)
            ? parsed.bullet_reasons
                .map((r) => String(r || '').trim())
                .filter(Boolean)
            : []
        };
      } else {
        console.warn(
          '[negotiationReportBuilder] LLM fabricated numbers detected; using fallback.',
          { fabricatedNumbers: fabricatedNumbers.slice(0, 5) }
        );
      }
    }
  } catch (err) {
    console.warn(
      '[negotiationReportBuilder] LLM call failed; using rule-based fallback:',
      err?.message
    );
  }

  const reportBody = validationPassed && llmOutput
    ? {
        ...llmOutput,
        generated_by: 'llm',
        llm_provider: llmProvider,
        llm_model: llmModel,
        evidence_validated: true
      }
    : {
        ...buildRuleBasedReport(rankedOptions, baseRunId),
        fabricated_numbers_rejected: fabricatedNumbers.length > 0
          ? fabricatedNumbers.slice(0, 10)
          : undefined
      };

  return {
    version: 'v0',
    generated_at: new Date().toISOString(),
    base_run_id: baseRunId,
    evidence_refs: evidenceRefs,
    ...reportBody
  };
}

export default { buildNegotiationReport };
