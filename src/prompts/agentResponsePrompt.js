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
]);

const clampText = (text, maxChars = 8000) => String(text || '').slice(0, maxChars);

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

    if (success) {
      if (Number.isFinite(rowCount)) {
        base.push(`rows=${rowCount}`);
      }
      if (Array.isArray(sampleRows) && sampleRows.length > 0) {
        base.push(`sample_rows=${clampText(JSON.stringify(sampleRows.slice(0, maxRowsPerQuery)), 500)}`);
      }
      if (Array.isArray(analysisCards) && analysisCards.length > 0) {
        base.push(`analysis_cards=${analysisCards.map((card) => card?.title || card?.analysisType).filter(Boolean).join(', ')}`);
      }
    } else if (error) {
      base.push(`error=${clampText(error, 300)}`);
    }

    return base.join(' | ');
  }).join('\n');
};

export function buildAgentAnswerContractPrompt({ userMessage, mode = 'default' }) {
  return `You are the Answer Contract Parser for a business-analysis chat system.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Task
Infer what the final answer must cover, independent of tool execution details.

## Inputs
- Mode: ${mode}
- User message: "${clampText(userMessage, 2500)}"

## Output JSON schema
{
  "task_type": "comparison | trend | ranking | lookup | diagnostic | recommendation | mixed",
  "required_dimensions": ["string"],
  "required_outputs": ["chart | table | comparison | recommendation | caveat"],
  "audience_language": "short language code or language name",
  "brevity": "short"
}

## Rules
- comparison: compare two or more groups/entities/segments across one or more metrics.
- trend: change over time or sequence.
- ranking: top/bottom/sorted categories.
- lookup: direct fact lookup or small data retrieval.
- diagnostic: root cause / why / anomaly / issue investigation.
- recommendation: asks what to do / best action / suggestion.
- mixed: multiple equally-important goals or ambiguous request.
- required_dimensions: include each metric / lens / dimension the answer must explicitly cover. Keep them short.
- required_outputs: include only what is clearly expected from the user request.
- audience_language should match the user's language, e.g. "zh", "en", "Chinese", "English".
- brevity must always be "short".`;
}

export function buildAgentBriefSynthesisPrompt({
  userMessage,
  answerContract,
  toolCalls = [],
  finalAnswerText = '',
  mode = 'default',
  repairInstructions = [],
}) {
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
  "summary": "string",
  "metric_pills": [{ "label": "string", "value": "string" }],
  "tables": [{
    "title": "string",
    "columns": ["string"],
    "rows": [["string or number"]]
  }],
  "key_findings": ["string"],
  "implications": ["string"],
  "caveats": ["string"],
  "next_steps": ["string"]
}

## Rules
- Keep the brief compact and executive-facing.
- Do not include SQL, debug logs, failure transcript, or tool-by-tool narration in headline/summary/findings.
- If charts or analysis cards already exist, do not repeat every KPI already visible there. Add interpretation instead.
- If the user asked for multiple dimensions, cover all of them in the brief.
- If the evidence is partial or proxy-based, add a caveat.
- Tables must be structured JSON tables, not markdown or pseudo-table text.
- Use empty arrays when a section is not needed.`;
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
    "clarity": 0.0
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
  return `You are the ${reviewerLabel} for a business-analysis answer.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Goal
Score the answer with correctness first. Treat all prior model output as fallible.

## Inputs
- User message: "${clampText(userMessage, 2500)}"
- Answer contract: ${clampText(JSON.stringify(answerContract || {}), 1800)}
- Brief: ${clampText(JSON.stringify(brief || {}), 5000)}
- Raw final narrative: "${clampText(finalAnswerText, 3000)}"
- Deterministic QA: ${clampText(JSON.stringify(deterministicQa || {}), 3500)}
- Artifact summary:
${clampText(artifactSummary || 'No artifacts summarized.', 3500)}
- Tool evidence:
${clampText(summarizeToolCalls(toolCalls), 4500)}

## Output JSON schema
${buildQaReviewSchemaText()}

## Review rules
- Prioritize correctness over writing quality.
- Add a blocker when the answer should not pass as-is.
- Add blockers for: contradictory numbers without explanation, missing core requested dimensions, unsupported conclusion, chart mismatch, missing caveat for proxy/failed/partial evidence, or debug transcript leakage.
- Scores are 0.0 to 10.0 for each dimension.
- Keep repair instructions concrete and implementation-oriented.
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
  "summary": "string",
  "metric_pills": [{ "label": "string", "value": "string" }],
  "tables": [{
    "title": "string",
    "columns": ["string"],
    "rows": [["string or number"]]
  }],
  "key_findings": ["string"],
  "implications": ["string"],
  "caveats": ["string"],
  "next_steps": ["string"]
}

## Repair rules
- Fix missing dimensions, contradictions, caveats, evidence-table problems, chart-fit framing, and duplicate text.
- Do not invent or alter known numeric facts.
- Do not remove legitimate caveats or hide failed steps.
- Do not output SQL, pseudo-tables, or debug transcript.
- You may rewrite headline/summary/findings/tables/caveats/next_steps.
  - If evidence is insufficient, say so clearly in caveats instead of pretending certainty.`;
}

export function buildAgentCandidateJudgePrompt({
  userMessage,
  answerContract,
  primaryCandidate,
  secondaryCandidate,
}) {
  return `You are the Final Candidate Judge for a business-analysis agent system.

You MUST return one valid JSON object and NOTHING else.
No markdown. No code fences. No commentary. No extra keys.

## Goal
Choose the better candidate answer for end-user display.
Prioritize correctness, completeness, evidence alignment, and risk handling over writing style.

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
- If one candidate failed or timed out, prefer the surviving candidate unless the surviving answer is clearly unusable.
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
    && parsed.brevity === 'short'
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
  return (
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
    && isValidQaDimensionScores(parsed.dimension_scores)
  );
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

export default {
  buildAgentAnswerContractPrompt,
  buildAgentBriefSynthesisPrompt,
  buildAgentBriefReviewPrompt,
  buildAgentQaSelfReviewPrompt,
  buildAgentQaCrossReviewPrompt,
  buildAgentQaRepairSynthesisPrompt,
  buildAgentCandidateJudgePrompt,
  validateAnswerContract,
  validateAgentBrief,
  validateAgentBriefReview,
  validateAgentQaReview,
  validateAgentCandidateJudge,
};
