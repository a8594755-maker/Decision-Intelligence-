/**
 * evidenceSynthesisService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Evidence-First Synthesis: generates a business brief from VERIFIED evidence.
 *
 * Unlike the standard synthesis path (which receives raw tool call transcripts),
 * this service receives pre-computed, scope-verified data from EvidenceRegistry.
 * The LLM never needs to do math — all numbers are pre-calculated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { DI_PROMPT_IDS, runDiPrompt } from '../planning/diModelRouterService.js';

/**
 * Clamp text to maxChars.
 */
function clamp(text, maxChars = 5000) {
  return String(text || '').slice(0, maxChars);
}

/**
 * Build the evidence synthesis prompt.
 * This is intentionally a separate prompt from the standard synthesis —
 * it assumes all numbers are verified and focuses the LLM on narrative quality.
 */
function buildEvidenceSynthesisInput({
  userMessage,
  answerContract,
  evidenceBrief,
  agentSummary,
}) {
  // Build a focused evidence block for the prompt
  const evidenceBlock = JSON.stringify(evidenceBrief, null, 2);

  return {
    userMessage,
    answerContract,
    // We pass the evidence brief as the "toolCalls" field since the synthesis
    // prompt already processes this field. The key difference is that our data
    // is pre-verified and includes derived values.
    toolCalls: formatEvidenceAsToolSummary(evidenceBrief),
    finalAnswerText: buildEvidenceNarrativeHint({ evidenceBrief, agentSummary, answerContract }),
    mode: 'analysis',
    repairInstructions: buildEvidenceRepairInstructions(evidenceBrief),
  };
}

/**
 * Format evidence entries to look like summarized tool calls,
 * so the existing synthesis prompt can process them.
 */
function formatEvidenceAsToolSummary(evidenceBrief) {
  const entries = evidenceBrief?.evidence_entries || [];
  return entries.map(entry => ({
    id: entry.id,
    name: entry.tool,
    success: true,
    error: null,
    args: {},
    rowCount: entry.row_count,
    sampleRows: (entry.sample_rows || []).slice(0, 15),
    analysisPayloads: entry.metrics ? [{
      title: `Evidence ${entry.id}`,
      summary: entry.summary || '',
      highlights: entry.highlights || [],
      metrics: entry.metrics,
      chartTypes: [],
      tableTitles: [],
      referenceLineLabels: [],
      referenceLineValues: [],
      tableData: [],
    }] : [],
    artifactTypes: [],
    // Extra evidence metadata
    _evidenceScope: entry.scope_description,
    _evidenceType: entry.type,
  }));
}

/**
 * Build a narrative hint from verified evidence for the synthesizer.
 * This replaces the raw agent finalAnswerText with a structured, verified summary.
 */
function buildEvidenceNarrativeHint({ evidenceBrief, agentSummary, answerContract }) {
  const lines = [];

  lines.push('=== VERIFIED EVIDENCE SUMMARY ===');
  lines.push('All numbers below are deterministically verified. Use them directly.');
  lines.push('');

  // Scope summary
  if (evidenceBrief.scope_summary) {
    lines.push(`Scope: ${evidenceBrief.scope_summary}`);
    lines.push('');
  }

  // Pre-computed derived values
  const derived = evidenceBrief.derived_values || {};
  if (Object.keys(derived).length > 0) {
    lines.push('Pre-computed metrics (DO NOT recalculate — use these exact values):');
    for (const [key, val] of Object.entries(derived)) {
      const col = key.split('.').pop();
      const scope = val.scope?.filters?.length > 0
        ? ` [scope: ${val.scope.filters.map(f => `${f.column}=${f.value}`).join(', ')}]`
        : '';
      lines.push(`  ${col}: sum=${val.formatted.sum}, avg=${val.formatted.avg}, median=${val.formatted.median}, count=${val.count}${scope}`);
    }
    lines.push('');
  }

  // Warnings
  if (evidenceBrief.warnings?.length > 0) {
    lines.push('⚠️ Data warnings:');
    for (const w of evidenceBrief.warnings) {
      lines.push(`  - ${w.message}`);
    }
    lines.push('');
  }

  // Agent's own summary (for context, but numbers should come from derived values)
  if (agentSummary) {
    lines.push('Agent evidence notes (for context only — use pre-computed numbers above):');
    lines.push(clamp(agentSummary, 2000));
  }

  return lines.join('\n');
}

/**
 * Build repair instructions based on evidence warnings.
 */
function buildEvidenceRepairInstructions(evidenceBrief) {
  const instructions = [];

  for (const w of (evidenceBrief.warnings || [])) {
    if (w.type === 'scope_mismatch') {
      instructions.push(
        `SCOPE WARNING: "${w.metric}" has data from multiple query scopes. ` +
        `You MUST explicitly state which scope each number refers to. ` +
        `Do NOT mix numbers from different scopes in the same sentence.`
      );
    }
  }

  // Always add a general evidence-first instruction
  instructions.push(
    'Use ONLY the pre-computed values from the evidence summary. ' +
    'Do NOT calculate averages, percentages, or growth rates yourself — they are already computed.'
  );

  return instructions;
}

/**
 * Synthesize a brief from verified evidence.
 *
 * @param {{ userMessage: string, answerContract: object, evidenceBrief: object, agentSummary: string }} params
 * @returns {Promise<object>} The synthesized brief
 */
export async function synthesizeFromEvidence({
  userMessage,
  answerContract,
  evidenceBrief,
  agentSummary = '',
}) {
  const input = buildEvidenceSynthesisInput({
    userMessage,
    answerContract,
    evidenceBrief,
    agentSummary,
  });

  const result = await runDiPrompt({
    promptId: DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS,
    input,
    temperature: 0.15,
    maxOutputTokens: 4096,
  });

  return result?.parsed || null;
}

export default { synthesizeFromEvidence };
