import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService.js';

const JUDGE_PROVIDER = import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER || 'gemini';
const JUDGE_MODEL = import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL
  || import.meta.env.VITE_DI_GEMINI_MODEL
  || import.meta.env.VITE_GEMINI_MODEL
  || 'gemini-3.1-pro-preview';

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

function summarizeCandidate(candidate) {
  return {
    candidate_id: candidate?.candidateId,
    label: candidate?.label,
    provider: candidate?.provider,
    model: candidate?.model,
    status: candidate?.status || 'completed',
    failed_reason: candidate?.failedReason || null,
    brief: candidate?.presentation?.brief || null,
    qa: candidate?.presentation?.qa || null,
    trace: {
      failed_attempts: candidate?.presentation?.trace?.failed_attempts?.length || 0,
      successful_queries: candidate?.presentation?.trace?.successful_queries?.length || 0,
    },
    artifacts: (candidate?.result?.toolCalls || []).map((toolCall) => toolCall?.name).filter(Boolean),
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
    summary: `${winningCandidate?.label || 'Winner'} was selected because it achieved the stronger QA score and lower apparent answer risk.`,
    rationale: [
      `${winningCandidate?.label || 'Winner'} QA score: ${Number(winningCandidate?.presentation?.qa?.score || 0).toFixed(1)}`,
      `${losingCandidate?.label || 'Alternative'} QA score: ${Number(losingCandidate?.presentation?.qa?.score || 0).toFixed(1)}`,
    ],
    loserIssues: uniqueStrings(losingCandidate?.presentation?.qa?.issues || []).slice(0, 4),
    confidence: 0.6,
    reviewer: {
      provider: 'deterministic_fallback',
      model: 'qa_score_comparison',
    },
    degraded: false,
  };
}

export async function judgeAgentCandidates({
  userMessage,
  answerContract,
  primaryCandidate,
  secondaryCandidate,
}) {
  const degraded = primaryCandidate?.status !== 'completed' || secondaryCandidate?.status !== 'completed';

  try {
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE,
      input: {
        userMessage,
        answerContract,
        primaryCandidate: summarizeCandidate(primaryCandidate),
        secondaryCandidate: summarizeCandidate(secondaryCandidate),
      },
      temperature: 0.1,
      maxOutputTokens: 1200,
      providerOverride: JUDGE_PROVIDER,
      modelOverride: JUDGE_MODEL,
    });

    return {
      winnerCandidateId: result?.parsed?.winner_candidate_id === 'secondary' ? 'secondary' : 'primary',
      summary: String(result?.parsed?.summary || '').trim(),
      rationale: uniqueStrings(result?.parsed?.rationale || []),
      loserIssues: uniqueStrings(result?.parsed?.loser_issues || []),
      confidence: Number(result?.parsed?.confidence || 0),
      reviewer: {
        provider: result?.provider || JUDGE_PROVIDER,
        model: result?.model || JUDGE_MODEL,
      },
      degraded,
    };
  } catch (error) {
    console.warn('[agentCandidateJudge] Judge fallback:', error?.message);
    return buildFallbackDecision(primaryCandidate, secondaryCandidate);
  }
}

export default {
  judgeAgentCandidates,
};
