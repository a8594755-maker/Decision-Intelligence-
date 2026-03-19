/**
 * Negotiation Draft Generator — LLM-powered email drafts in 3 tones
 *
 * Generates procurement negotiation email drafts using the DI model router.
 * Each draft is evidence-first: only numbers from the provided context are used.
 *
 * Tones:
 *   1. hardball   — 強硬施壓: data-driven pressure
 *   2. persuasion — 數據說服: evidence-backed proposal
 *   3. win_win    — 雙贏妥協: collaborative solution
 *
 * Evidence-first validation: all numbers in LLM output are checked against
 * the provided context. Fabricated numbers trigger a rule-based fallback.
 */

import { runDiPrompt, DI_PROMPT_IDS } from '../../diModelRouterService';

// ---------------------------------------------------------------------------
// Tone definitions
// ---------------------------------------------------------------------------

export const DRAFT_TONES = Object.freeze({
  HARDBALL: 'hardball',
  PERSUASION: 'persuasion',
  WIN_WIN: 'win_win',
});

export const TONE_LABELS = Object.freeze({
  hardball: { en: 'Hardball', zh: '強硬施壓' },
  persuasion: { en: 'Data-Persuasion', zh: '數據說服' },
  win_win: { en: 'Win-Win', zh: '雙贏妥協' },
});

export const TONE_LIST = [DRAFT_TONES.HARDBALL, DRAFT_TONES.PERSUASION, DRAFT_TONES.WIN_WIN];

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a procurement negotiation expert. Generate an email draft for the buyer.
RULES (strictly enforced):
1. Only use numbers from the provided context. NEVER fabricate data.
2. Keep the email professional and concise (under 300 words).
3. Reference specific data points (on_time_rate, risk_score, cost, etc.) where relevant.
4. Output must be a JSON object with: { subject: string, body: string }`;

const TONE_INSTRUCTIONS = {
  hardball: `Tone: HARDBALL (強硬施壓)
Write a firm, data-driven pressure email. Emphasize:
- Performance gaps and their impact on our operations
- Specific deadlines and consequences if terms are not met
- Our alternatives (BATNA) if they don't comply
- Clear bottom line with no ambiguity`,

  persuasion: `Tone: DATA-PERSUASION (數據說服)
Write an evidence-backed proposal email. Emphasize:
- Objective data showing why the requested terms are fair
- Industry benchmarks and trend analysis
- Mutual benefits of accepting the proposal
- Logical progression from data to conclusion`,

  win_win: `Tone: WIN-WIN (雙贏妥協)
Write a collaborative, solution-oriented email. Emphasize:
- Acknowledging the supplier's constraints
- Proposing creative trade-offs (volume for price, payment terms, etc.)
- Long-term relationship value
- Flexible options that benefit both parties`,
};

/**
 * Build the LLM prompt for a specific tone.
 */
function buildDraftPrompt(context, tone) {
  return {
    task: 'negotiation_email_draft',
    tone,
    tone_instruction: TONE_INSTRUCTIONS[tone],
    context: {
      sku: context.sku || 'N/A',
      supplier_name: context.supplier_name || 'Supplier',
      current_price: context.current_price,
      target_price: context.target_price,
      cfr_action: context.cfr_action || 'counter',
      expected_value: context.expected_value,
      risk_score: context.risk_score,
      on_time_rate: context.on_time_rate,
      defect_rate: context.defect_rate,
      position_strength: context.position_strength || 'NEUTRAL',
      constraint_violations: context.constraint_violations || [],
      trigger: context.trigger || 'kpi_shortfall',
      service_level: context.service_level,
      stockout_units: context.stockout_units,
    },
    output_schema: {
      subject: 'string (email subject line)',
      body: 'string (email body, professional format)',
    },
  };
}

// ---------------------------------------------------------------------------
// Number validation (reuse pattern from negotiationReportBuilder)
// ---------------------------------------------------------------------------

function extractContextNumbers(context) {
  const nums = new Set();
  const push = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) {
      nums.add(String(Math.round(n * 1e6) / 1e6));
      nums.add(String(Math.round(n * 1e4) / 1e4));
      nums.add(String(Math.round(n * 100) / 100));
      nums.add(String(Math.round(n)));
    }
  };

  Object.values(context || {}).forEach((v) => {
    if (typeof v === 'number') push(v);
    if (Array.isArray(v)) v.forEach((item) => {
      if (typeof item === 'object' && item) Object.values(item).forEach(push);
    });
  });

  return nums;
}

function detectFabricated(text, evidenceNums) {
  if (!text) return [];
  const fabricated = [];
  const regex = /\b(\d+(?:\.\d+)?)\b/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && n >= 0 && n <= 10) continue; // small ordinals

    const key = String(Math.round(n * 1e6) / 1e6);
    const pctKey = String(Math.round((n / 100) * 1e6) / 1e6);
    if (!evidenceNums.has(key) && !evidenceNums.has(pctKey)) {
      fabricated.push(m[1]);
    }
  }
  return fabricated;
}

// ---------------------------------------------------------------------------
// Rule-based fallback drafts
// ---------------------------------------------------------------------------

function buildFallbackDraft(context, tone) {
  const supplier = context.supplier_name || 'Supplier';
  const sku = context.sku || 'the referenced SKU';

  const subjects = {
    hardball: `Urgent: Performance Review Required for ${sku}`,
    persuasion: `Proposal: Optimized Terms for ${sku} — Data-Backed Analysis`,
    win_win: `Partnership Opportunity: Collaborative Terms for ${sku}`,
  };

  const bodies = {
    hardball:
      `Dear ${supplier} Team,\n\n` +
      `We are writing regarding the current terms for ${sku}. ` +
      `Based on our analysis, the current arrangement requires immediate review. ` +
      (context.on_time_rate != null ? `Your on-time delivery rate of ${(context.on_time_rate * 100).toFixed(1)}% is below our threshold. ` : '') +
      (context.risk_score != null ? `Our risk assessment score stands at ${context.risk_score}. ` : '') +
      `We require revised terms by end of this week.\n\n` +
      `Best regards,\nProcurement Team`,

    persuasion:
      `Dear ${supplier} Team,\n\n` +
      `We have completed a data-driven analysis of our supply relationship for ${sku}. ` +
      (context.service_level != null ? `Our service level proxy currently stands at ${(context.service_level * 100).toFixed(1)}%. ` : '') +
      (context.on_time_rate != null ? `Your delivery performance shows an on-time rate of ${(context.on_time_rate * 100).toFixed(1)}%. ` : '') +
      `Based on this analysis, we propose adjusted terms that reflect the data. ` +
      `We believe this adjustment benefits both parties.\n\n` +
      `Best regards,\nProcurement Team`,

    win_win:
      `Dear ${supplier} Team,\n\n` +
      `We value our ongoing partnership and would like to explore mutually beneficial terms for ${sku}. ` +
      `We understand market conditions may present challenges on your end. ` +
      (context.on_time_rate != null ? `We note your ${(context.on_time_rate * 100).toFixed(1)}% on-time rate and appreciate the effort. ` : '') +
      `We'd like to discuss flexible options that work for both sides — ` +
      `perhaps volume commitments in exchange for improved pricing, or adjusted payment terms.\n\n` +
      `Looking forward to a productive conversation.\n\n` +
      `Best regards,\nProcurement Team`,
  };

  return {
    subject: subjects[tone] || subjects.persuasion,
    body: bodies[tone] || bodies.persuasion,
    generated_by: 'rule_based_fallback',
    evidence_validated: true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a single email draft for a specific tone.
 *
 * @param {Object} context - negotiation context data
 * @param {string} tone    - 'hardball' | 'persuasion' | 'win_win'
 * @returns {Promise<{ subject: string, body: string, tone: string, generated_by: string, evidence_validated: boolean }>}
 */
export async function generateDraft(context, tone) {
  const evidenceNums = extractContextNumbers(context);

  try {
    const prompt = buildDraftPrompt(context, tone);
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.REPORT_SUMMARY,
      input: {
        stage: 'negotiation_email_draft',
        system_note: SYSTEM_PROMPT,
        ...prompt,
      },
      temperature: 0.3,
      maxOutputTokens: 800,
    });

    const parsed = result?.parsed;
    if (parsed && typeof parsed.subject === 'string' && typeof parsed.body === 'string') {
      const allText = `${parsed.subject} ${parsed.body}`;
      const fabricated = detectFabricated(allText, evidenceNums);

      if (fabricated.length === 0) {
        return {
          subject: parsed.subject.trim(),
          body: parsed.body.trim(),
          tone,
          generated_by: 'llm',
          llm_provider: result?.provider,
          llm_model: result?.model,
          evidence_validated: true,
        };
      }

      console.warn(`[negotiation-draft] Fabricated numbers in ${tone} draft:`, fabricated.slice(0, 5));
    }
  } catch (err) {
    console.warn(`[negotiation-draft] LLM failed for ${tone}:`, err?.message);
  }

  // Fallback
  return { ...buildFallbackDraft(context, tone), tone };
}

/**
 * Generate all 3 tone variants in parallel.
 *
 * @param {Object} context - negotiation context data
 * @returns {Promise<Object[]>} array of 3 drafts
 */
export async function generateAllDrafts(context) {
  const results = await Promise.allSettled(
    TONE_LIST.map((tone) => generateDraft(context, tone))
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // Should not happen since generateDraft has its own fallback, but just in case
    return { ...buildFallbackDraft(context, TONE_LIST[i]), tone: TONE_LIST[i] };
  });
}

/**
 * Build the context object for draft generation from orchestrator data.
 *
 * @param {Object} params
 * @param {Object} params.cfrEnrichment   - from Step 3.5
 * @param {Object} params.solverMeta      - solver_meta artifact
 * @param {Object} params.replayMetrics   - replay_metrics artifact
 * @param {Object} params.supplierKpis    - from supplierKpiService
 * @param {Object} params.userIntent      - { service_target, budget_cap }
 * @param {Object} params.datasetProfileRow
 * @param {string} params.trigger
 * @returns {Object} context for generateAllDrafts
 */
export function buildDraftContext({
  cfrEnrichment,
  solverMeta,
  replayMetrics,
  supplierKpis,
  userIntent,
  datasetProfileRow,
  trigger,
}) {
  const actionProbs = cfrEnrichment?.cfr_action_probs || {};
  const topAction = Object.entries(actionProbs)
    .sort(([, a], [, b]) => b - a)[0];

  return {
    sku: datasetProfileRow?.sku || datasetProfileRow?.material_code || null,
    supplier_name: datasetProfileRow?.supplier_name || supplierKpis?.supplier_name || null,
    current_price: solverMeta?.kpis?.estimated_total_cost ?? null,
    target_price: userIntent?.budget_cap ?? null,
    cfr_action: topAction?.[0] ?? null,
    expected_value: topAction?.[1] ?? null,
    risk_score: datasetProfileRow?.risk_score ?? null,
    on_time_rate: supplierKpis?.on_time_rate ?? null,
    defect_rate: supplierKpis?.defect_rate ?? null,
    position_strength: (() => {
      if (!cfrEnrichment) return null;
      const pl = ['VERY_WEAK', 'WEAK', 'NEUTRAL', 'STRONG', 'VERY_STRONG'];
      return pl[Math.max(0, Math.min(cfrEnrichment.buyer_bucket, pl.length - 1))] || 'NEUTRAL';
    })(),
    constraint_violations: solverMeta?.proof?.constraints_checked
      ?.filter((c) => c?.binding)
      ?.map((c) => c.name) || [],
    trigger,
    service_level: replayMetrics?.with_plan?.service_level_proxy ?? null,
    stockout_units: replayMetrics?.with_plan?.stockout_units ?? null,
  };
}

export default {
  generateDraft,
  generateAllDrafts,
  buildDraftContext,
  DRAFT_TONES,
  TONE_LABELS,
  TONE_LIST,
};
