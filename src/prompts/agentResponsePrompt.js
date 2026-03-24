const TASK_TYPES = new Set([
  'comparison',
  'trend',
  'ranking',
  'lookup',
  'diagnostic',
  'recommendation',
  'mixed',
]);

const OUTPUT_TYPES = new Set([
  'chart',
  'table',
  'comparison',
  'recommendation',
  'caveat',
]);

const QA_DIMENSION_KEYS = Object.freeze([
  'correctness',
  'completeness',
  'evidence_alignment',
  'visualization_fit',
  'caveat_quality',
  'clarity',
  'methodology_transparency',
  'actionability',
  'information_density',
]);

const clampText = (text, maxChars = 8000) => String(text || '').slice(0, maxChars);

const STRING_ARRAY_SCHEMA = Object.freeze({
  type: 'array',
  items: { type: 'string' },
});

const QA_DIMENSION_SCORES_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.fromEntries(QA_DIMENSION_KEYS.map((key) => [key, { type: 'number' }])),
  required: [...QA_DIMENSION_KEYS],
});

function buildAnalysisDepthRules(answerContract) {
  const depth = Array.isArray(answerContract?.analysis_depth) ? answerContract.analysis_depth : [];
  if (depth.length === 0) return '';
  const rules = [];
  if (depth.includes('methodology_disclosure')) {
    rules.push('- METHODOLOGY DISCLOSURE: Every numeric threshold or recommendation must state the formula, model, or assumption behind it (e.g., "ROP = d×L + z×σ, z=1.65 for 95% service level" or "ABC classification using Pareto 80/20 rule"). If no formal model was used, say "based on historical mean over [period]".');
  }
  if (depth.includes('relative_metrics')) {
    rules.push('- RELATIVE METRICS: For every absolute metric (e.g., revenue = R$5000), also provide relative context (e.g., "3.2% of total revenue", "0.8x category average", "turnover = 12.5 days"). Use evidence data to compute ratios.');
  }
  if (depth.includes('sensitivity_range')) {
    rules.push('- SENSITIVITY ANALYSIS: When recommending a threshold or parameter, include a table titled "Sensitivity Analysis" in the tables array with columns ["Scenario", "Parameter Value", "Expected Outcome", "Risk/Tradeoff"] and at least 3 rows (conservative / moderate / aggressive). Compute outcome values from data when possible; label estimates clearly.');
  }
  if (depth.includes('actionable_parameters')) {
    rules.push('- ACTIONABLE PARAMETERS: Every recommendation must include at least one specific numeric parameter the user can act on. "Use conservative replenishment" is NOT acceptable; "Set safety stock to 45 units (z=1.65, 95% service level)" IS acceptable.');
  }
  if (depth.includes('trend_context')) {
    rules.push('- TREND CONTEXT: Before recommending based on historical averages, state whether the metric is growing, declining, or stable over the available time window. If the trend is non-stationary (>10% change across periods), adjust the recommendation accordingly.');
  }
  return rules.length > 0 ? '\n## Analysis Depth Requirements\n' + rules.join('\n') : '';
}

function requestIncludesQuantileHistogram(answerContract, userMessage) {
  const requiredDimensions = Array.isArray(answerContract?.required_dimensions)
    ? answerContract.required_dimensions.map((item) => String(item || '').toLowerCase())
    : [];
  return (
    requiredDimensions.some((item) => /quantiles?|percentiles?/.test(item))
    && /\bhistogram\b|直方圖/i.test(String(userMessage || ''))
  );
}

/**
 * Format cell values: convert Unix ms timestamps (2000-2040 range) to ISO date strings.
 */
function formatCellValue(value) {
  if (typeof value === 'number' && value > 9.46e11 && value < 2.21e12) {
    return new Date(value).toISOString().slice(0, 10);
  }
  return value;
}

function formatSampleRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const formatted = {};
    for (const [key, val] of Object.entries(row)) {
      formatted[key] = formatCellValue(val);
    }
    return formatted;
  });
}

const summarizeToolCalls = (toolCalls = [], maxRowsPerQuery = 4) => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return 'No tool calls recorded.';

  return toolCalls.map((toolCall, index) => {
    const success = typeof toolCall?.success === 'boolean'
      ? toolCall.success
      : toolCall?.result?.success;
    const args = toolCall?.args;
    const sql = args?.sql;
    const rowCount = Number.isFinite(toolCall?.rowCount)
      ? toolCall.rowCount
      : toolCall?.result?.result?.rowCount;
    const sampleRows = Array.isArray(toolCall?.sampleRows)
      ? toolCall.sampleRows
      : toolCall?.result?.result?.rows;
    const analysisCards = toolCall?.analysisPayloads
      || toolCall?.result?._analysisCards
      || toolCall?.result?.result?._analysisCards
      || [];
    const error = toolCall?.error || toolCall?.result?.error;
    const base = [
      `${index + 1}. ${toolCall?.name || 'unknown_tool'}`,
      `status=${success ? 'success' : 'failure'}`,
    ];

    if (sql) {
      base.push(`sql=${clampText(sql, 300)}`);
    } else if (args && Object.keys(args).length > 0) {
      base.push(`args=${clampText(JSON.stringify(args), 280)}`);
    }

    if (toolCall?.name === 'generate_chart') {
      base.push('source=deterministic_recipe (computed from raw dataset at query time, not pre-cached)');
    }

    if (success) {
      if (Number.isFinite(rowCount)) {
        base.push(`rows=${rowCount}`);
        if (rowCount === 0) {
          base.push('⚠ ZERO ROWS — no evidence from this query. Do NOT cite numbers from it.');
        }
      }
      if (Array.isArray(sampleRows) && sampleRows.length > 0) {
        base.push(`sample_rows=${clampText(JSON.stringify(formatSampleRows(sampleRows.slice(0, maxRowsPerQuery))), 500)}`);
      }
      if (Array.isArray(analysisCards) && analysisCards.length > 0) {
        base.push(`analysis_cards=${analysisCards.map((card) => card?.title || card?.analysisType).filter(Boolean).join(', ')}`);
        // Inject artifact metrics so reviewers can verify cited numbers
        for (const card of analysisCards) {
          if (card?.metrics && typeof card.metrics === 'object') {
            const metricsStr = Object.entries(card.metrics)
              .slice(0, 12)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            if (metricsStr) base.push(`artifact_metrics={${metricsStr}}`);
          }
          const refs = card?.charts?.[0]?.referenceLines;
          if (Array.isArray(refs) && refs.length > 0) {
            const refStr = refs.slice(0, 8).map((r) => `${r.label || ''}=${r.value}`).join(', ');
            base.push(`artifact_reference_lines={${refStr}}`);
          }
        }
      }
    } else if (error) {
      base.push(`error=${clampText(error, 300)}`);
    }

    return base.join(' | ');
  }).join('\n');
};

export function buildAgentAnswerContractPrompt({ userMessage, mode = 'default', domainEnrichment = '' }) {
  return `You are the Answer Contract Parser for a business-analysis chat system.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Task
Infer what the final answer must cover, independent of tool execution details.

## Inputs
- Mode: ${mode}
- User message: "${clampText(userMessage, 2500)}"
${domainEnrichment ? `\n${domainEnrichment}\n` : ''}

## Output JSON schema
{
  "task_type": "comparison | trend | ranking | lookup | diagnostic | recommendation | mixed",
  "required_dimensions": ["string"],
  "required_outputs": ["chart | table | comparison | recommendation | caveat"],
  "suggested_deep_dives": ["string"],
  "audience_language": "short language code or language name",
  "brevity": "short | analysis",
  "analysis_depth": ["methodology_disclosure | relative_metrics | trend_context | sensitivity_range | actionable_parameters"]
}

## Rules
- comparison: compare two or more groups/entities/segments across one or more metrics.
- trend: change over time or sequence.
- ranking: top/bottom/sorted categories.
- lookup: direct fact lookup or small data retrieval.
- diagnostic: root cause / why / anomaly / issue investigation.
- recommendation: asks what to do / best action / suggestion.
- mixed: multiple equally-important goals or ambiguous request.
- required_dimensions: include each metric / lens / dimension the answer must explicitly cover. Use 2-4 word labels (e.g. "庫存水位", "revenue trend"), NOT full sentences.
- required_outputs: include only what is clearly expected from the user request.
- audience_language should match the user's language, e.g. "zh", "en", "Chinese", "English".
- brevity: use "analysis" for comparison, diagnostic, trend, or multi-dimension requests that need detailed breakdowns; use "short" for simple lookups, single-fact questions, or narrow queries.
- suggested_deep_dives: 2-3 analysis angles that would deepen the answer beyond surface-level descriptive statistics. Each should combine two dimensions or introduce a causal/temporal lens. Format: "dimension_a × dimension_b (purpose)". These are suggestions for the agent, not requirements — the agent should attempt at least one if data supports it. Use empty array for simple lookups.
- analysis_depth: an array of depth flags from ["methodology_disclosure", "relative_metrics", "trend_context", "sensitivity_range", "actionable_parameters"]. Auto-select:
  - recommendation or diagnostic → always include "methodology_disclosure", "actionable_parameters", "sensitivity_range".
  - comparison or trend → always include "relative_metrics", "trend_context".
  - brevity "analysis" → always include "relative_metrics".
  - lookup or ranking with brevity "short" → empty array.`;
}

export function buildAgentBriefSynthesisPrompt({
  userMessage,
  answerContract,
  toolCalls = [],
  finalAnswerText = '',
  mode = 'default',
  repairInstructions = [],
  domainEnrichment = '',
}) {
  const quantileHistogramRequested = requestIncludesQuantileHistogram(answerContract, userMessage);
  return `You are the Presentation Synthesizer for a business-analysis chat agent.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Goal
Convert the agent's raw output + tool evidence into a concise, professional brief card.
The brief must answer the user's request directly and avoid raw execution/debug transcript.

## Inputs
- Mode: ${mode}
- User message: "${clampText(userMessage, 2500)}"
- Answer contract: ${clampText(JSON.stringify(answerContract || {}), 1600)}
- Raw final narrative: "${clampText(finalAnswerText, 4000)}"
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 5000)}

## Repair instructions
${repairInstructions.length > 0 ? repairInstructions.map((item) => `- ${item}`).join('\n') : '- none'}

## Output JSON schema
{
  "headline": "string",
  "executive_summary": "string (one-sentence executive conclusion for senior stakeholders — optional but strongly recommended)",
  "summary": "string (supports markdown: **bold**, \`code\`, bullet lists, inline formulas. Keep professional tone. This is the main narrative.)",
  "metric_pills": [{ "label": "string", "value": "string", "source": "string (optional — e.g. 'SQL query #2, 1247 rows')" }],
  "data_lineage": [{ "metric": "string", "sql_ref": "string (e.g. 'query #2')", "row_count": "number", "confidence": "high|medium|low" }],
  "tables": [{
    "title": "string",
    "columns": ["string"],
    "rows": [["string or number"]]
  }],
  "charts": [{
    "type": "bar | grouped_bar | stacked_bar | line | scatter | pie | horizontal_bar",
    "title": "string",
    "xKey": "string (column name for X axis)",
    "yKey": "string (column name for Y axis)",
    "series": ["string (column names for multi-series, used with grouped_bar/stacked_bar)"],
    "data": [{ "xKeyName": "value", "seriesName": "number" }],
    "xAxisLabel": "string (optional)",
    "yAxisLabel": "string (optional)"
  }],
  "key_findings": ["string"],
  "implications": ["string"],
  "caveats": ["string"],
  "next_steps": ["string"],
  "methodology_note": "string (optional — formula/model/assumption disclosure, preserved from raw narrative)"
}
${domainEnrichment ? `\n${domainEnrichment}\n` : ''}
## Rules
- For brevity="short": keep the brief compact and executive-facing (under 160 words).
- For brevity="analysis": the summary field should be 300-500 words. Go beyond describing numbers — explain WHY the patterns exist, WHAT they imply for the business, and WHAT specific actions to take. Treat the summary as a mini consulting memo, not a dashboard tooltip.
- SUMMARY FORMAT: The summary field supports markdown. Use **bold** for emphasis on key numbers, \`code\` for formulas or parameter names, and bullet lists for multi-point summaries. Do NOT use markdown headers (#) — keep it flowing prose or short bullets.
- EXECUTIVE SUMMARY: When possible, include executive_summary — a single sentence capturing the headline conclusion and key number(s). This is the first thing a senior stakeholder sees.
- DATA LINEAGE: For each key metric pill, try to include a matching entry in data_lineage with the SQL query reference and row count, so the frontend can show provenance tooltips.
- METHODOLOGY PRESERVATION: When the raw narrative contains formulas, model names, or parameter definitions (e.g., "SS = z × σ × √(L/T)", "z=1.65 for 95% service level", "ROP = d̄ × L + SS"), you MUST preserve them in the key_findings, summary, or methodology_note field. Never compress a formula into just the output number. The methodology disclosure is mandatory, not optional decoration.
- Do not include SQL, debug logs, failure transcript, or tool-by-tool narration in headline/summary/findings.
- If charts or analysis cards already exist, do not repeat every KPI already visible there. Add interpretation instead.
- If the user asked for multiple dimensions, cover all of them in the brief.
- METRIC PILLS QUALITY: Each metric pill must contain a NUMERIC KPI value that aids decision-making.
  Do NOT use pills for: time periods, trend directions (up/down), categorical labels, metadata, or seasonal periods.
  Good: "Revenue Growth: +2,349%" / "Peak Month Orders: 7,289" / "Avg Order Value: R$119.98"
  Bad: "Time Period: Sep 2016 - Oct 2018" / "Trend Direction: Upward" / "Seasonal Period: 12 months"
- CAVEATS DECISION TREE:
  1. Any tool call FAILED? → MUST add caveat about alternative methodology used.
  2. Using proxy metric (e.g., SQL moving average instead of statsmodels decomposition)? → MUST add caveat.
  3. Data has known limitations (time range, coverage, sampling)? → MUST add caveat.
  4. Recipe-generated chart from full dataset tables? → Do NOT add caveat questioning its reliability.
  Never produce an empty caveats array when conditions 1-3 apply.
  Self-contradictory caveats (questioning data you yourself generated) MUST be avoided — they erode user trust.
- DATA QUALITY DISCLOSURE: If the agent's reasoning mentions data quality warnings (non-stationary trend, small sample, outliers, seasonal patterns, proxy metrics, or business context caveats like marketplace model or pre-aggregated data), these MUST appear in the "caveats" array. Never suppress a data quality warning in the final brief. Each warning should be a concise, actionable caveat sentence.
- Only mention a SQL, worker, connection, or tool failure if the tool evidence explicitly includes a failed call.
- A successful 0-row SQL lookup is not a tool failure, but it provides ZERO evidence. Do NOT cite any numbers, statistics, or counts from a 0-row query. If all SQL queries returned 0 rows, add a caveat explaining no SQL data was available.
- If no tool call succeeded, do not fabricate metric pills, evidence tables, or dataset-specific findings. Use empty arrays for unsupported sections. You may offer generic advice only if it is clearly labeled as general guidance rather than a result from this dataset.
- If existing chart or analysis artifacts already cover the answer contract, do not ask for retries or more SQL just to restate the same metrics.
- Use the successful artifact evidence as the source of truth whenever it already satisfies the request.
- ${quantileHistogramRequested
    ? 'Because the user requested histogram quantiles, the summary or key findings must explicitly mention P25, P50, P75, and P90 (or P95 if P90 is unavailable) when those values exist in the evidence.'
    : 'If quantiles are requested and supported by the evidence, summarize the key cut points directly instead of only saying they were marked.'}
- Tables must be structured JSON tables, not markdown or pseudo-table text.
- Charts: when tool evidence contains numeric comparison data (e.g. strategy A vs B, category breakdowns), generate inline chart specs in the "charts" array. Use "grouped_bar" for side-by-side comparisons, "scatter" for two-variable relationships, "bar" for single-metric rankings. Each chart needs type, title, xKey, yKey, and a data array of objects. Keep data to ≤25 rows per chart. If a generate_chart artifact already covers the visualization, do not duplicate it in charts.
- CHART yKey RULE (MANDATORY): yKey must be a SINGLE column name string. For multi-series charts (grouped_bar, stacked_bar, line with multiple series), put the extra column names in the "series" array — NOT in yKey. Example: yKey: "orders", series: ["orders", "revenue"]. NEVER use comma-separated values in yKey like "orders,revenue".
- FIELD DEDUPLICATION (MANDATORY):
  • headline: ONE sentence, the single most important conclusion. No numbers unless they ARE the conclusion.
  • executive_summary: ONE sentence with 1-2 key numbers. Must NOT repeat the headline.
  • summary: Narrative interpretation of WHY the numbers matter. Reference metric pills by name ("as shown in the Gini metric above") instead of restating values.
  • metric_pills: The ONLY place for raw KPI values. Summary and findings must NOT restate pill values verbatim.
  • key_findings: Insights that go BEYOND what metric pills show — patterns, comparisons, anomalies, causality. Each finding must contain information not present in any pill label+value pair.
  • If a number already appears in metric_pills, other sections may reference it contextually ("the high Gini coefficient suggests...") but must NOT restate the exact value.
- METRIC PILL LIMITS: Maximum 4 pills for brevity="short", maximum 6 for brevity="analysis". Pick the most decision-relevant metrics. Move supporting metrics to evidence tables.
- FIELD PRIORITY: Always complete ALL required fields (headline, summary, key_findings, implications, caveats, next_steps) before generating optional fields (tables, charts, metric_pills). If output space is limited, use fewer table rows and chart data points rather than omitting required fields.
- Use empty arrays when a section is not needed.
${buildAnalysisDepthRules(answerContract)}`;
}

export function buildAgentBriefReviewPrompt({
  userMessage,
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
}) {
  return `You are the Quality Reviewer for a business-analysis brief card.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Task
Judge whether the brief is production-ready relative to the user's request and evidence.

## Inputs
- User message: "${clampText(userMessage, 2500)}"
- Answer contract: ${clampText(JSON.stringify(answerContract || {}), 1600)}
- Brief: ${clampText(JSON.stringify(brief || {}), 5000)}
- Raw final narrative: "${clampText(finalAnswerText, 3000)}"
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 4000)}

## Output JSON schema
{
  "pass": true,
  "issues": ["string"],
  "missing_dimensions": ["string"],
  "contradictory_claims": ["string"],
  "repair_instructions": ["string"]
}

## Review checklist
- Does the brief cover every required dimension from the contract?
- Are the charts/tables aligned to the user request?
- Did debug logs, failed attempts, SQL transcript, or pseudo-table text leak into the brief?
- Does the brief include caveats when evidence is partial, proxy-based, or blocked?
- Are any claims contradictory to the evidence summary?
- Does the brief cite specific numbers from queries that returned 0 rows (marked ⚠ ZERO ROWS)? If yes, flag as a contradictory_claim.

## Rules
- If the brief is good enough for display, return pass=true.
- If not, keep repair instructions concrete and minimal.`;
}

function buildQaReviewSchemaText() {
  return `{
  "score": 0.0,
  "blockers": ["string"],
  "issues": ["string"],
  "repair_instructions": ["string"],
  "dimension_scores": {
    "correctness": 0.0,
    "completeness": 0.0,
    "evidence_alignment": 0.0,
    "visualization_fit": 0.0,
    "caveat_quality": 0.0,
    "clarity": 0.0,
    "methodology_transparency": 0.0,
    "actionability": 0.0,
    "information_density": 0.0
  }
}`;
}

function buildQaReviewPrompt({
  reviewerLabel,
  userMessage,
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
  deterministicQa = null,
  artifactSummary = '',
}) {
  const quantileHistogramRequested = requestIncludesQuantileHistogram(answerContract, userMessage);
  return `You are the ${reviewerLabel} for a business-analysis answer.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Goal
Score the answer with correctness first. Treat all prior model output as fallible.

## Inputs
- User message: "${clampText(userMessage, 2500)}"
- Answer contract: ${clampText(JSON.stringify(answerContract || {}), 1800)}
- Brief: ${clampText(JSON.stringify(brief || {}), 3500)}
- Raw final narrative: "${clampText(finalAnswerText, 2500)}"
- Deterministic QA: ${clampText(JSON.stringify(deterministicQa || {}), 3000)}
- Artifact summary:
${clampText(artifactSummary || 'No artifacts summarized.', 2500)}
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 3000)}

## Output JSON schema
${buildQaReviewSchemaText()}

## Review rules
IMPORTANT: Numeric accuracy, chart data completeness, and evidence traceability are checked by the deterministic QA layer (see Deterministic QA input above). Do NOT re-check numbers or data — focus on narrative quality only.

NUMBER FORMAT NOTE: Briefs often use K/M/B suffixes for readability (e.g. "543.67K" = "543,670" ≈ "543,666"). These are formatting shortcuts, NOT conflicting values. Do NOT flag formatted versions of the same number as contradictions or correctness errors.

Your role is to evaluate:
1. **Narrative coherence**: Does the story flow logically? Are conclusions supported by the analysis structure?
2. **Language quality**: Is the writing clear, professional, and appropriately concise? No jargon leakage, no debug artifacts?
3. **Interpretive depth**: Does the brief interpret the data (explain WHY, not just WHAT)? Are implications actionable?
4. **Section differentiation**: Does each section (headline, summary, key_findings, implications) provide unique value, or do they repeat each other?
5. **Caveat appropriateness**: Are caveats relevant and proportional, or do they undermine valid evidence?

- Scores are 0.0 to 10.0 for each dimension.
- For dimensions already covered by deterministic QA (correctness, evidence_alignment, visualization_fit), defer to the deterministic scores unless you see a clear narrative-level issue.
- methodology_transparency: are formulas, models, or assumptions behind numeric thresholds disclosed? Score 10 if the answer is a simple lookup or does not cite thresholds; deduct if recommendation/diagnostic answers cite numbers without stating the methodology.
- actionability: are recommendations specific enough to act on (e.g., "set safety stock to 45 units")? Score 10 if the task is not a recommendation; deduct if recommendations are vague ("use conservative approach") without specific parameters.
- information_density: does each section add NEW information not present in other sections? Score 10 if every section provides unique value and no metric is repeated verbatim across sections. Score 7 for minor repetition (1-2 values restated). Score 4 if multiple sections restate the same numbers/conclusions. Score 1 if headline, summary, findings, and pills all contain the same information. Deduct 2 points for each metric value that appears verbatim in 3+ separate sections.
- ${quantileHistogramRequested
    ? 'For histogram-plus-quantiles requests, the answer should explicitly summarize the core cut points P25, P50, P75, and P90/P95 when the artifact evidence contains them.'
    : 'If the artifact already contains quantiles, prefer an explicit short quantile summary over vague phrasing like "quantiles are marked".'}
- Keep repair instructions concrete and implementation-oriented.
- CONCISENESS: Keep each blocker and issue description to 1-2 sentences.
- MANDATORY: You MUST score ALL 9 dimensions in dimension_scores. Score 5.0 (neutral) for any dimension you cannot assess. Missing dimensions will cause a schema validation failure.
- Do not rewrite the answer. Only judge it.`;
}

export function buildAgentQaSelfReviewPrompt(input) {
  return buildQaReviewPrompt({
    reviewerLabel: 'Self QA Reviewer',
    ...input,
  });
}

export function buildAgentQaCrossReviewPrompt(input) {
  return buildQaReviewPrompt({
    reviewerLabel: 'Independent Cross-Model QA Reviewer',
    ...input,
  });
}

export function buildAgentQaRepairSynthesisPrompt({
  userMessage,
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
  deterministicQa = null,
  qaScorecard = null,
  artifactSummary = '',
  mode = 'default',
}) {
  const quantileHistogramRequested = requestIncludesQuantileHistogram(answerContract, userMessage);
  return `You are the Repair Synthesizer for a business-analysis brief.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Goal
Repair the brief so it can pass QA without inventing evidence.

## Inputs
- Mode: ${mode}
- User message: "${clampText(userMessage, 2500)}"
- Answer contract: ${clampText(JSON.stringify(answerContract || {}), 1800)}
- Current brief: ${clampText(JSON.stringify(brief || {}), 5000)}
- Raw final narrative: "${clampText(finalAnswerText, 3000)}"
- Deterministic QA: ${clampText(JSON.stringify(deterministicQa || {}), 3500)}
- Current QA scorecard: ${clampText(JSON.stringify(qaScorecard || {}), 4500)}
- Artifact summary:
${clampText(artifactSummary || 'No artifacts summarized.', 3500)}
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 4500)}

## Output JSON schema
{
  "headline": "string",
  "executive_summary": "string (optional)",
  "summary": "string (supports markdown)",
  "metric_pills": [{ "label": "string", "value": "string", "source": "string (optional)" }],
  "data_lineage": [{ "metric": "string", "sql_ref": "string", "row_count": "number", "confidence": "high|medium|low" }],
  "tables": [{
    "title": "string",
    "columns": ["string"],
    "rows": [["string or number"]]
  }],
  "key_findings": ["string"],
  "implications": ["string"],
  "caveats": ["string"],
  "next_steps": ["string"],
  "methodology_note": "string (optional — formula/model/assumption disclosure)"
}

## Repair rules
- EVIDENCE AUTHORITY: When the brief narrative contradicts artifact metrics/tables, ALWAYS use the artifact value. Artifacts are computed from raw data and are the authoritative source; narrative text may contain rounding errors or stale numbers. When resolving contradictions, replace the narrative value with the exact artifact value.
- Fix missing dimensions, contradictions, caveats, evidence-table problems, chart-fit framing, and duplicate text.
- If the QA scorecard flags missing methodology disclosure, extract the methodology/formula from the raw narrative and insert it into key_findings or the methodology_note field. Do not drop formulas during repair.
- Do not invent or alter known numeric facts.
- Do not remove legitimate caveats or hide failed steps.
- Remove any hallucinated SQL, worker, connection, or tool failure claim when the tool evidence has no failed call.
- Never rewrite a successful 0-row SQL lookup as a failure; at most describe it as adding no new evidence.
- If no tool call succeeded, strip unsupported metric pills, evidence tables, and dataset-specific numeric claims. Keep the brief limited to caveats, generic guidance, and next steps.
- If existing chart or analysis artifacts already satisfy the request, do not ask for retries or more SQL.
- ${quantileHistogramRequested
    ? 'For histogram-plus-quantiles requests, repair the summary or key findings so they explicitly mention P25, P50, P75, and P90/P95 when those values are present in evidence.'
    : 'If quantiles are part of the request and present in evidence, mention the core cut points explicitly.'}
- REDUNDANCY REPAIR (high priority — this is a QA blocker):
  When repair instructions mention "verbatim restatement" or "information density":
  1. Identify which metric pill values appear in the summary or key_findings.
  2. For each repeated value in summary: replace exact restatement (e.g., "The Gini coefficient is 0.792") with interpretive phrasing (e.g., "The Gini coefficient indicates severe inequality, comparable to the most unequal national economies").
  3. For each repeated value in key_findings: replace with a DERIVED insight. Instead of "Gini coefficient of 0.792 reflects inequality", write "The bottom 50% of sellers collectively earn less than the top 10 sellers individually."
  4. After repair, NO metric pill value should appear verbatim in more than one other section.
- Do not output SQL, pseudo-tables, or debug transcript.
- You may rewrite headline/summary/findings/tables/caveats/next_steps.
  - If evidence is insufficient, say so clearly in caveats instead of pretending certainty.
${buildAnalysisDepthRules(answerContract)}`;
}

export function buildAgentCandidateJudgePrompt({
  userMessage,
  answerContract,
  primaryCandidate,
  secondaryCandidate,
  domainCriteria = '',
}) {
  return `You are the Final Candidate Judge for a business-analysis agent system.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Goal
Choose the better candidate answer for end-user display.
Prioritize correctness, completeness, evidence alignment, and risk handling over writing style.
${domainCriteria ? `\n${domainCriteria}\n` : ''}
## Inputs
- User message: "${clampText(userMessage, 2500)}"
- Answer contract: ${clampText(JSON.stringify(answerContract || {}), 1800)}
- Primary candidate: ${clampText(JSON.stringify(primaryCandidate || {}), 6000)}
- Secondary candidate: ${clampText(JSON.stringify(secondaryCandidate || {}), 6000)}

## Output JSON schema
{
  "winner_candidate_id": "primary or secondary",
  "summary": "string",
  "rationale": ["string"],
  "loser_issues": ["string"],
  "confidence": 0.0
}

## Rules
- Pick exactly one winner.
- Prefer the candidate with fewer contradictions, better caveats, and stronger evidence fit.
- If the optimizer's brief is substantively identical to the primary's brief (same numbers, same structure, similar phrasing), prefer the primary unless the optimizer fixed a specific blocker. "More words" does not mean "better answer". A concise primary that covers all dimensions should beat a verbose optimizer that restates the same points.
${domainCriteria ? '- When domain evaluation criteria are provided above, use them as the PRIMARY evaluation rubric. A candidate with correct formulas but poor writing beats a well-written candidate with incorrect formulas.\n' : ''}- If one candidate failed or timed out, prefer the surviving candidate unless the surviving answer is clearly unusable.
- If the winning candidate still has QA warnings or blockers, describe it as the stronger available answer, not as a fully satisfactory or complete solution.
- Use confidence from 0.0 to 1.0.
- Keep the summary concise and user-facing.
- Do not rewrite either answer. Judge only.`;
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function isValidQaDimensionScores(value) {
  return (
    isPlainObject(value)
    && QA_DIMENSION_KEYS.every((key) => typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 10)
  );
}

export function validateAnswerContract(parsed) {
  return (
    isPlainObject(parsed)
    && TASK_TYPES.has(parsed.task_type)
    && Array.isArray(parsed.required_dimensions)
    && parsed.required_dimensions.every((item) => typeof item === 'string')
    && Array.isArray(parsed.required_outputs)
    && parsed.required_outputs.every((item) => OUTPUT_TYPES.has(item))
    && typeof parsed.audience_language === 'string'
    && parsed.audience_language.trim().length > 0
    && (parsed.brevity === 'short' || parsed.brevity === 'analysis')
  );
}

export function validateAgentBrief(parsed) {
  const hasMetricPills = parsed?.metric_pills == null || (
    Array.isArray(parsed.metric_pills)
    && parsed.metric_pills.every((item) => isPlainObject(item) && typeof item.label === 'string' && typeof item.value === 'string')
  );

  const hasTables = parsed?.tables == null || (
    Array.isArray(parsed.tables)
    && parsed.tables.every((table) => (
      isPlainObject(table)
      && (table.title == null || typeof table.title === 'string')
      && Array.isArray(table.columns)
      && table.columns.every((column) => typeof column === 'string')
      && Array.isArray(table.rows)
      && table.rows.every((row) => Array.isArray(row))
    ))
  );

  const hasStringList = (field) => parsed?.[field] == null || (
    Array.isArray(parsed[field]) && parsed[field].every((item) => typeof item === 'string')
  );

  return (
    isPlainObject(parsed)
    && typeof parsed.headline === 'string'
    && typeof parsed.summary === 'string'
    && Array.isArray(parsed.key_findings)
    && parsed.key_findings.every((item) => typeof item === 'string')
    && hasMetricPills
    && hasTables
    && hasStringList('implications')
    && hasStringList('caveats')
    && hasStringList('next_steps')
  );
}

/**
 * Relaxed validation for repair synthesis — only requires headline + summary.
 * Missing fields (key_findings, implications, etc.) will be filled by normalizeBrief from fallback.
 */
export function validateAgentBriefRepair(parsed) {
  return (
    isPlainObject(parsed)
    && typeof parsed.headline === 'string'
    && parsed.headline.trim().length > 0
    && typeof parsed.summary === 'string'
    && parsed.summary.trim().length > 0
  );
}

export function validateAgentBriefReview(parsed) {
  return (
    isPlainObject(parsed)
    && typeof parsed.pass === 'boolean'
    && Array.isArray(parsed.issues)
    && parsed.issues.every((item) => typeof item === 'string')
    && Array.isArray(parsed.missing_dimensions)
    && parsed.missing_dimensions.every((item) => typeof item === 'string')
    && Array.isArray(parsed.contradictory_claims)
    && parsed.contradictory_claims.every((item) => typeof item === 'string')
    && Array.isArray(parsed.repair_instructions)
    && parsed.repair_instructions.every((item) => typeof item === 'string')
  );
}

export function validateAgentQaReview(parsed) {
  const coreValid = (
    isPlainObject(parsed)
    && typeof parsed.score === 'number'
    && parsed.score >= 0
    && parsed.score <= 10
    && Array.isArray(parsed.blockers)
    && parsed.blockers.every((item) => typeof item === 'string')
    && Array.isArray(parsed.issues)
    && parsed.issues.every((item) => typeof item === 'string')
    && Array.isArray(parsed.repair_instructions)
    && parsed.repair_instructions.every((item) => typeof item === 'string')
  );
  if (!coreValid) return false;

  // dimension_scores is optional — accept the review if core fields are valid
  // (LLM may truncate dimension_scores when maxOutputTokens is tight)
  if (parsed.dimension_scores != null) {
    if (isValidQaDimensionScores(parsed.dimension_scores)) {
      // Log valid dimension scores for debugging transparency
      const dims = parsed.dimension_scores;
      const summary = Object.entries(dims).map(([k, v]) => `${k}=${v}`).join(', ');
      console.info(`[validateAgentQaReview] dimension_scores: ${summary} (aggregate=${parsed.score})`);
    } else {
      console.warn('[validateAgentQaReview] dimension_scores present but malformed — accepting core fields');
      console.warn('[validateAgentQaReview] malformed dimension_scores:', JSON.stringify(parsed.dimension_scores));
    }
  }
  return true;
}

export function validateAgentCandidateJudge(parsed) {
  return (
    isPlainObject(parsed)
    && (parsed.winner_candidate_id === 'primary' || parsed.winner_candidate_id === 'secondary')
    && typeof parsed.summary === 'string'
    && Array.isArray(parsed.rationale)
    && parsed.rationale.every((item) => typeof item === 'string')
    && Array.isArray(parsed.loser_issues)
    && parsed.loser_issues.every((item) => typeof item === 'string')
    && typeof parsed.confidence === 'number'
    && parsed.confidence >= 0
    && parsed.confidence <= 1
  );
}

export function buildAnswerContractResponseSchema() {
  return {
    type: 'object',
    properties: {
      task_type: {
        type: 'string',
        enum: Array.from(TASK_TYPES),
      },
      required_dimensions: STRING_ARRAY_SCHEMA,
      required_outputs: {
        type: 'array',
        items: {
          type: 'string',
          enum: Array.from(OUTPUT_TYPES),
        },
      },
      audience_language: { type: 'string' },
      brevity: {
        type: 'string',
        enum: ['short', 'analysis'],
      },
      analysis_depth: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'methodology_disclosure',
            'relative_metrics',
            'trend_context',
            'sensitivity_range',
            'actionable_parameters',
          ],
        },
      },
    },
    required: [
      'task_type',
      'required_dimensions',
      'required_outputs',
      'audience_language',
      'brevity',
      'analysis_depth',
    ],
  };
}

export function buildAgentBriefResponseSchema() {
  return {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      summary: { type: 'string' },
      metric_pills: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label', 'value'],
        },
      },
      tables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            columns: STRING_ARRAY_SCHEMA,
            rows: {
              type: 'array',
              items: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          required: ['columns', 'rows'],
        },
      },
      charts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            xKey: { type: 'string' },
            yKey: { type: 'string' },
            series: STRING_ARRAY_SCHEMA,
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {},
              },
            },
            xAxisLabel: { type: 'string' },
            yAxisLabel: { type: 'string' },
          },
        },
      },
      key_findings: STRING_ARRAY_SCHEMA,
      implications: STRING_ARRAY_SCHEMA,
      caveats: STRING_ARRAY_SCHEMA,
      next_steps: STRING_ARRAY_SCHEMA,
      methodology_note: { type: 'string' },
    },
    required: [
      'headline',
      'summary',
      'metric_pills',
      'tables',
      'charts',
      'key_findings',
      'implications',
      'caveats',
      'next_steps',
    ],
  };
}

export function buildAgentBriefReviewResponseSchema() {
  return {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      issues: STRING_ARRAY_SCHEMA,
      missing_dimensions: STRING_ARRAY_SCHEMA,
      contradictory_claims: STRING_ARRAY_SCHEMA,
      repair_instructions: STRING_ARRAY_SCHEMA,
    },
    required: [
      'pass',
      'issues',
      'missing_dimensions',
      'contradictory_claims',
      'repair_instructions',
    ],
  };
}

export function buildAgentQaReviewResponseSchema() {
  return {
    type: 'object',
    properties: {
      score: { type: 'number' },
      blockers: STRING_ARRAY_SCHEMA,
      issues: STRING_ARRAY_SCHEMA,
      repair_instructions: STRING_ARRAY_SCHEMA,
      dimension_scores: QA_DIMENSION_SCORES_SCHEMA,
    },
    required: [
      'score',
      'blockers',
      'issues',
      'repair_instructions',
      'dimension_scores',
    ],
  };
}

export function buildAgentCandidateJudgeResponseSchema() {
  return {
    type: 'object',
    properties: {
      winner_candidate_id: {
        type: 'string',
        enum: ['primary', 'secondary'],
      },
      summary: { type: 'string' },
      rationale: STRING_ARRAY_SCHEMA,
      loser_issues: STRING_ARRAY_SCHEMA,
      confidence: { type: 'number' },
    },
    required: [
      'winner_candidate_id',
      'summary',
      'rationale',
      'loser_issues',
      'confidence',
    ],
  };
}

export default {
  buildAgentAnswerContractPrompt,
  buildAgentBriefSynthesisPrompt,
  buildAgentBriefReviewPrompt,
  buildAgentQaSelfReviewPrompt,
  buildAgentQaCrossReviewPrompt,
  buildAgentQaRepairSynthesisPrompt,
  buildAgentCandidateJudgePrompt,
  buildAnswerContractResponseSchema,
  buildAgentBriefResponseSchema,
  buildAgentBriefReviewResponseSchema,
  buildAgentQaReviewResponseSchema,
  buildAgentCandidateJudgeResponseSchema,
  validateAnswerContract,
  validateAgentBrief,
  validateAgentBriefReview,
  validateAgentQaReview,
  validateAgentCandidateJudge,
};
