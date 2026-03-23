import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService.js';
import { getModelConfig } from './modelConfigService.js';
import { detectDomain, buildJudgeDomainCriteria } from './analysisDomainEnrichment.js';

function uniqueStrings(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = String(item || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function summarizeSqlEvidence(candidate) {
  const toolCalls = candidate?.result?.toolCalls || [];
  return toolCalls
    .filter((tc) => tc?.name === 'query_sap_data' && tc?.result?.success && tc?.result?.rows?.length > 0)
    .slice(0, 3) // cap at 3 queries to avoid bloating the judge prompt
    .map((tc) => ({
      sql: String(tc?.args?.sql || '').slice(0, 200),
      rowCount: tc.result.rows.length,
      columns: Object.keys(tc.result.rows[0] || {}),
      sampleRows: tc.result.rows.slice(0, 3),
    }));
}

function summarizeCandidate(candidate) {
  return {
    candidate_id: candidate?.candidateId,
    label: candidate?.label,
    provider: candidate?.provider,
    model: candidate?.model,
    transport: candidate?.transport || null,
    status: candidate?.status || 'completed',
    failed_reason: candidate?.failedReason || null,
    brief: candidate?.presentation?.brief || null,
    qa: candidate?.presentation?.qa || null,
    trace: {
      failed_attempts: candidate?.presentation?.trace?.failed_attempts?.length || 0,
      successful_queries: candidate?.presentation?.trace?.successful_queries?.length || 0,
    },
    artifacts: (candidate?.result?.toolCalls || []).map((toolCall) => toolCall?.name).filter(Boolean),
    sql_evidence_summary: summarizeSqlEvidence(candidate),
  };
}

function buildFallbackDecision(primaryCandidate, secondaryCandidate) {
  const primaryCompleted = primaryCandidate?.status === 'completed';
  const secondaryCompleted = secondaryCandidate?.status === 'completed';

  if (primaryCompleted && !secondaryCompleted) {
    return {
      winnerCandidateId: 'primary',
      summary: `${primaryCandidate?.label || 'Primary candidate'} was selected because the challenger did not complete successfully.`,
      rationale: [secondaryCandidate?.failedReason || 'Challenger failed before producing a valid answer.'],
      loserIssues: uniqueStrings([secondaryCandidate?.failedReason]).slice(0, 4),
      confidence: 0.68,
      reviewer: {
        provider: 'deterministic_fallback',
        model: 'single_survivor_selection',
        transport: 'deterministic',
      },
      degraded: true,
    };
  }

  if (secondaryCompleted && !primaryCompleted) {
    return {
      winnerCandidateId: 'secondary',
      summary: `${secondaryCandidate?.label || 'Challenger candidate'} was selected because the primary run did not complete successfully.`,
      rationale: [primaryCandidate?.failedReason || 'Primary failed before producing a valid answer.'],
      loserIssues: uniqueStrings([primaryCandidate?.failedReason]).slice(0, 4),
      confidence: 0.68,
      reviewer: {
        provider: 'deterministic_fallback',
        model: 'single_survivor_selection',
        transport: 'deterministic',
      },
      degraded: true,
    };
  }

  const primaryScore = Number(primaryCandidate?.presentation?.qa?.score || 0);
  const secondaryScore = Number(secondaryCandidate?.presentation?.qa?.score || 0);
  const winner = secondaryScore > primaryScore ? 'secondary' : 'primary';
  const winningCandidate = winner === 'secondary' ? secondaryCandidate : primaryCandidate;
  const losingCandidate = winner === 'secondary' ? primaryCandidate : secondaryCandidate;

  return {
    winnerCandidateId: winner,
    summary: `${winningCandidate?.label || 'Winner'} was selected as the stronger available answer because it achieved the stronger QA score and lower apparent answer risk.`,
    rationale: [
      `${winningCandidate?.label || 'Winner'} QA score: ${Number(winningCandidate?.presentation?.qa?.score || 0).toFixed(1)}`,
      `${losingCandidate?.label || 'Alternative'} QA score: ${Number(losingCandidate?.presentation?.qa?.score || 0).toFixed(1)}`,
    ],
    loserIssues: uniqueStrings(losingCandidate?.presentation?.qa?.issues || []).slice(0, 4),
    confidence: 0.6,
    reviewer: {
      provider: 'deterministic_fallback',
      model: 'qa_score_comparison',
      transport: 'deterministic',
    },
    degraded: false,
  };
}

function candidateNeedsGuardedSummary(candidate) {
  const qa = candidate?.presentation?.qa;
  if (!qa) return true;
  const passThreshold = Number(qa.pass_threshold || 8);
  const score = Number(qa.score || 0);

  if (qa.status === 'warning') return true;
  if (qa.status === 'pass') return false;
  return score < passThreshold;
}

function buildGuardedSummary(candidate) {
  return `${candidate?.label || 'Winner'} was selected as the stronger available answer, but it still carries unresolved QA risk.`;
}

function applyWinnerGuardrails(decision, winnerCandidate) {
  if (!decision || !winnerCandidate || !candidateNeedsGuardedSummary(winnerCandidate)) return decision;

  return {
    ...decision,
    summary: buildGuardedSummary(winnerCandidate),
    rationale: uniqueStrings([
      ...(Array.isArray(decision.rationale) ? decision.rationale : []),
      `${winnerCandidate?.label || 'Winner'} still has QA warnings, so this is the best available answer rather than a fully clean pass.`,
    ]),
  };
}

export async function judgeAgentCandidates({
  userMessage,
  answerContract,
  primaryCandidate,
  secondaryCandidate,
  modelMode,
}) {
  const degraded = primaryCandidate?.status !== 'completed' || secondaryCandidate?.status !== 'completed';

  try {
    const domain = detectDomain(userMessage);
    const domainCriteria = domain.domainKey ? buildJudgeDomainCriteria(domain.domainKey) : '';

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE,
      input: {
        userMessage,
        answerContract,
        primaryCandidate: summarizeCandidate(primaryCandidate),
        secondaryCandidate: summarizeCandidate(secondaryCandidate),
        domainCriteria,
      },
      temperature: 0.1,
      maxOutputTokens: 1200,
      providerOverride: getModelConfig('judge', modelMode).provider,
      modelOverride: getModelConfig('judge', modelMode).model,
    });

    const winnerCandidate = result?.parsed?.winner_candidate_id === 'secondary' ? secondaryCandidate : primaryCandidate;

    return applyWinnerGuardrails({
      winnerCandidateId: result?.parsed?.winner_candidate_id === 'secondary' ? 'secondary' : 'primary',
      summary: String(result?.parsed?.summary || '').trim(),
      rationale: uniqueStrings(result?.parsed?.rationale || []),
      loserIssues: uniqueStrings(result?.parsed?.loser_issues || []),
      confidence: Number(result?.parsed?.confidence || 0),
      reviewer: {
        provider: result?.provider || getModelConfig('judge', modelMode).provider,
        model: result?.model || getModelConfig('judge', modelMode).model,
        transport: result?.transport || null,
      },
      degraded,
    }, winnerCandidate);
  } catch (error) {
    console.warn('[agentCandidateJudge] Judge fallback:', error?.message);
    const fallbackDecision = buildFallbackDecision(primaryCandidate, secondaryCandidate);
    const winnerCandidate = fallbackDecision.winnerCandidateId === 'secondary' ? secondaryCandidate : primaryCandidate;
    return applyWinnerGuardrails(fallbackDecision, winnerCandidate);
  }
}

export default {
  judgeAgentCandidates,
};
