import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService.js';
import { getModelConfig } from './modelConfigService.js';
import { detectDomain, buildJudgeDomainCriteria } from './analysisDomainEnrichment.js';
import { computeQueryComplexity } from './agentExecutionStrategyService.js';
import { logEvent } from './auditService.js';
import { supabase } from './supabaseClient.js';

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
  const toolCalls = candidate?.result?.toolCalls || [];

  // Extract key numbers from all successful SQL results for cross-checking
  const keyNumbers = [];
  for (const tc of toolCalls) {
    if (tc?.name === 'query_sap_data' && tc?.result?.success && tc?.result?.rows?.length > 0) {
      const rows = tc.result.rows;
      const numericKeys = Object.keys(rows[0] || {}).filter(k => typeof rows[0][k] === 'number');
      for (const key of numericKeys.slice(0, 3)) {
        const values = rows.map(r => r[key]).filter(v => v != null);
        if (values.length > 0) {
          keyNumbers.push({
            column: key,
            min: Math.min(...values),
            max: Math.max(...values),
            sum: values.reduce((a, b) => a + b, 0),
            count: values.length,
          });
        }
      }
    }
  }

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
    artifacts: toolCalls.map((toolCall) => toolCall?.name).filter(Boolean),
    sql_evidence_summary: summarizeSqlEvidence(candidate),
    key_numbers: keyNumbers.slice(0, 10),
    tool_errors: toolCalls
      .filter(tc => !tc?.result?.success && tc?.result?.error)
      .map(tc => ({ tool: tc.name, error: String(tc.result.error).slice(0, 150) }))
      .slice(0, 5),
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

  // Detect if both candidates are below QA pass threshold
  const passThreshold = Number(winningCandidate?.presentation?.qa?.pass_threshold || secondaryCandidate?.presentation?.qa?.pass_threshold || 8);
  const bothBelowThreshold = primaryScore < passThreshold && secondaryScore < passThreshold;

  return {
    winnerCandidateId: winner,
    summary: bothBelowThreshold
      ? `${winningCandidate?.label || 'Winner'} was selected as the best available answer, but both candidates scored below the QA threshold (${passThreshold}). Results should be treated with caution.`
      : `${winningCandidate?.label || 'Winner'} was selected as the stronger available answer because it achieved the stronger QA score and lower apparent answer risk.`,
    rationale: [
      `${winningCandidate?.label || 'Winner'} QA score: ${Number(winningCandidate?.presentation?.qa?.score || 0).toFixed(1)}`,
      `${losingCandidate?.label || 'Alternative'} QA score: ${Number(losingCandidate?.presentation?.qa?.score || 0).toFixed(1)}`,
      ...(bothBelowThreshold ? [`Both candidates scored below pass threshold (${passThreshold}). Quality is not guaranteed.`] : []),
    ],
    loserIssues: uniqueStrings(losingCandidate?.presentation?.qa?.issues || []).slice(0, 4),
    confidence: bothBelowThreshold ? 0.3 : 0.6,
    reviewer: {
      provider: 'deterministic_fallback',
      model: 'qa_score_comparison',
      transport: 'deterministic',
    },
    degraded: bothBelowThreshold,
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

function logJudgeDecision(decision, { userMessage, answerContract, primaryCandidate, secondaryCandidate }) {
  try {
    const userId = supabase?.auth?.getSession?.()?.then?.((r) => r?.data?.session?.user?.id).catch(() => null) || null;
    const complexityScore = computeQueryComplexity(userMessage, answerContract);
    const primaryQa = Number(primaryCandidate?.presentation?.qa?.score || 0);
    const secondaryQa = Number(secondaryCandidate?.presentation?.qa?.score || 0);
    const winnerId = decision?.winnerCandidateId;
    const challengerWon = winnerId === 'secondary';
    const qaDelta = secondaryQa - primaryQa;

    // Fire-and-forget: never block the main flow
    Promise.resolve(userId).then((uid) => {
      logEvent(uid, {
        eventType: 'agent_judge_decision',
        entityType: 'dual_agent',
        payload: {
          complexity_score: complexityScore,
          primary_qa_score: primaryQa,
          secondary_qa_score: secondaryQa,
          qa_delta: qaDelta,
          winner: winnerId,
          challenger_won: challengerWon,
          judge_confidence: decision?.confidence || 0,
          judge_provider: decision?.reviewer?.provider || 'unknown',
          judge_model: decision?.reviewer?.model || 'unknown',
          degraded: decision?.degraded || false,
          task_type: answerContract?.task_type || 'unknown',
          dimension_count: answerContract?.required_dimensions?.length || 0,
          output_count: answerContract?.required_outputs?.length || 0,
          primary_provider: primaryCandidate?.provider || 'unknown',
          secondary_provider: secondaryCandidate?.provider || 'unknown',
        },
      });
    }).catch(() => {});

    // Also log to console for local debugging
    console.info(`[judge-telemetry] complexity=${complexityScore} winner=${winnerId} qa=${primaryQa.toFixed(1)}/${secondaryQa.toFixed(1)} delta=${qaDelta >= 0 ? '+' : ''}${qaDelta.toFixed(1)} confidence=${(decision?.confidence || 0).toFixed(2)}`);
  } catch {
    // Never fail from telemetry
  }
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

    const decision = applyWinnerGuardrails({
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

    logJudgeDecision(decision, { userMessage, answerContract, primaryCandidate, secondaryCandidate });
    return decision;
  } catch (error) {
    console.warn('[agentCandidateJudge] Judge fallback:', error?.message);
    const fallbackDecision = buildFallbackDecision(primaryCandidate, secondaryCandidate);
    const winnerCandidate = fallbackDecision.winnerCandidateId === 'secondary' ? secondaryCandidate : primaryCandidate;
    const guardedDecision = applyWinnerGuardrails(fallbackDecision, winnerCandidate);
    logJudgeDecision(guardedDecision, { userMessage, answerContract, primaryCandidate, secondaryCandidate });
    return guardedDecision;
  }
}

/**
 * Judge whether the optimizer (B) improved on the original (A).
 * Returns approve/reject instead of winner selection.
 */
export async function judgeOptimizedCandidate({
  userMessage,
  answerContract,
  originalCandidate,
  optimizedCandidate,
  modelMode,
}) {
  const originalQa = Number(originalCandidate?.presentation?.qa?.score || 0);
  const optimizedQa = Number(optimizedCandidate?.presentation?.qa?.score || 0);

  // Format gate: if optimizer brief has malformed headline/summary, skip it
  const optBrief = optimizedCandidate?.presentation?.brief;
  const headlineInvalid = optBrief?.headline && /^#{1,4}\s/.test(optBrief.headline);
  const summaryOverlong = (optBrief?.summary?.length || 0) > 3000;
  const summaryRawDump = optBrief?.summary && /^##\s/m.test(optBrief.summary);
  if (headlineInvalid || summaryOverlong || summaryRawDump) {
    console.warn('[judgeOptimized] Optimizer brief format invalid, falling back to primary');
    const decision = {
      approved: false,
      winnerCandidateId: 'primary',
      reason: 'Optimizer brief has malformed format (markdown headers in headline or raw narrative dump in summary).',
      originalQaScore: originalQa,
      optimizedQaScore: optimizedQa,
      qaDelta: optimizedQa - originalQa,
      reviewer: { provider: 'deterministic', model: 'format_gate', transport: 'deterministic' },
    };
    logJudgeDecision(decision, { userMessage, answerContract, primaryCandidate: originalCandidate, secondaryCandidate: optimizedCandidate });
    return decision;
  }

  // Fast path: if optimizer scored higher by meaningful margin, approve
  if (optimizedQa >= originalQa + 0.5 && optimizedQa >= 6.0) {
    const decision = {
      approved: true,
      winnerCandidateId: 'secondary',
      reason: `Optimizer improved QA score from ${originalQa.toFixed(1)} to ${optimizedQa.toFixed(1)}.`,
      originalQaScore: originalQa,
      optimizedQaScore: optimizedQa,
      qaDelta: optimizedQa - originalQa,
      reviewer: { provider: 'deterministic', model: 'qa_delta_comparison', transport: 'deterministic' },
    };
    logJudgeDecision(decision, { userMessage, answerContract, primaryCandidate: originalCandidate, secondaryCandidate: optimizedCandidate });
    return decision;
  }

  // Fast path: if optimizer scored lower, reject
  if (optimizedQa < originalQa) {
    const decision = {
      approved: false,
      winnerCandidateId: 'primary',
      reason: `Optimizer did not improve: ${originalQa.toFixed(1)} → ${optimizedQa.toFixed(1)}.`,
      originalQaScore: originalQa,
      optimizedQaScore: optimizedQa,
      qaDelta: optimizedQa - originalQa,
      reviewer: { provider: 'deterministic', model: 'qa_delta_comparison', transport: 'deterministic' },
    };
    logJudgeDecision(decision, { userMessage, answerContract, primaryCandidate: originalCandidate, secondaryCandidate: optimizedCandidate });
    return decision;
  }

  // Close scores: use LLM judge for nuanced comparison
  try {
    const result = await judgeAgentCandidates({
      userMessage,
      answerContract,
      primaryCandidate: originalCandidate,
      secondaryCandidate: optimizedCandidate,
      modelMode,
    });

    return {
      approved: result.winnerCandidateId === 'secondary',
      winnerCandidateId: result.winnerCandidateId,
      reason: result.summary,
      originalQaScore: originalQa,
      optimizedQaScore: optimizedQa,
      qaDelta: optimizedQa - originalQa,
      reviewer: result.reviewer,
    };
  } catch (error) {
    console.warn('[judgeOptimized] Fallback to deterministic:', error?.message);
    // Tie-breaker: prefer optimizer if it at least matched original
    const approved = optimizedQa >= originalQa;
    return {
      approved,
      winnerCandidateId: approved ? 'secondary' : 'primary',
      reason: `Fallback: optimizer ${approved ? 'matched' : 'did not match'} original (${originalQa.toFixed(1)} → ${optimizedQa.toFixed(1)}).`,
      originalQaScore: originalQa,
      optimizedQaScore: optimizedQa,
      qaDelta: optimizedQa - originalQa,
      reviewer: { provider: 'deterministic_fallback', model: 'qa_score_comparison', transport: 'deterministic' },
    };
  }
}

export default {
  judgeAgentCandidates,
  judgeOptimizedCandidate,
};
