import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunDiPrompt = vi.fn();

vi.mock('../planning/diModelRouterService.js', () => ({
  DI_PROMPT_IDS: {
    AGENT_CANDIDATE_JUDGE: 'prompt_13_agent_candidate_judge',
  },
  runDiPrompt: (...args) => mockRunDiPrompt(...args),
}));

vi.mock('../ai-infra/modelConfigService.js', () => ({
  getModelConfig: () => ({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }),
}));

vi.mock('../data-prep/analysisDomainEnrichment.js', () => ({
  detectDomain: () => ({ domainKey: null }),
  buildJudgeDomainCriteria: () => '',
}));

vi.mock('./agentExecutionStrategyService.js', () => ({
  computeQueryComplexity: () => 5,
}));

vi.mock('../governance/auditService.js', () => ({
  logEvent: () => {},
}));

vi.mock('../infra/supabaseClient.js', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } },
}));

const { judgeAgentCandidates } = await import('./agentCandidateJudgeService.js');

function buildCandidate({ id, label, score }) {
  return {
    candidateId: id,
    label,
    provider: 'openai',
    model: id === 'secondary' ? 'claude-opus-4-6' : 'gpt-5.4',
    status: 'completed',
    failedReason: null,
    result: {
      toolCalls: [{ name: 'query_sap_data' }, { name: 'generate_chart' }],
    },
    presentation: {
      brief: {
        headline: `${label} headline`,
        summary: `${label} summary`,
        key_findings: [],
      },
      qa: {
        score,
        issues: id === 'secondary' ? [] : ['Missing caveat'],
      },
      trace: {
        failed_attempts: [],
        successful_queries: [{ tool: 'query_sap_data' }],
      },
    },
  };
}

describe('agentCandidateJudgeService', () => {
  beforeEach(() => {
    mockRunDiPrompt.mockReset();
  });

  it('returns the model-selected winner when judge prompt succeeds', async () => {
    mockRunDiPrompt.mockResolvedValue({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      parsed: {
        winner_candidate_id: 'secondary',
        summary: 'Secondary is better grounded.',
        rationale: ['It covers the missing caveat and has fewer QA issues.'],
        loser_issues: ['Primary omitted the caveat.'],
        confidence: 0.88,
      },
    });

    const decision = await judgeAgentCandidates({
      userMessage: 'Compare the two answers and pick the stronger one.',
      answerContract: { task_type: 'comparison', required_dimensions: ['revenue'] },
      primaryCandidate: buildCandidate({ id: 'primary', label: 'Primary Agent', score: 8.1 }),
      secondaryCandidate: buildCandidate({ id: 'secondary', label: 'Challenger Agent', score: 8.7 }),
    });

    expect(decision.winnerCandidateId).toBe('secondary');
    expect(decision.summary).toBe('Secondary is better grounded.');
    expect(decision.reviewer.provider).toBe('gemini');
    expect(decision.reviewer.model).toBe('gemini-3.1-pro-preview');
    expect(decision.degraded).toBe(false);
  });

  it('falls back to QA score comparison when the judge model is unavailable', async () => {
    mockRunDiPrompt.mockRejectedValue(new Error('reviewer unavailable'));

    const decision = await judgeAgentCandidates({
      userMessage: 'Pick the better answer.',
      answerContract: { task_type: 'comparison', required_dimensions: ['revenue'] },
      primaryCandidate: buildCandidate({ id: 'primary', label: 'Primary Agent', score: 7.9 }),
      secondaryCandidate: buildCandidate({ id: 'secondary', label: 'Challenger Agent', score: 8.6 }),
    });

    expect(decision.winnerCandidateId).toBe('secondary');
    expect(decision.reviewer.provider).toBe('deterministic_fallback');
    expect(decision.summary).toMatch(/stronger QA score/i);
    expect(decision.degraded).toBe(false);
  });

  it('guards judge summaries when the winning candidate still has QA warnings', async () => {
    mockRunDiPrompt.mockResolvedValue({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      parsed: {
        winner_candidate_id: 'secondary',
        summary: 'Secondary fully satisfies the request.',
        rationale: ['It is more complete.'],
        loser_issues: ['Primary omitted quantiles.'],
        confidence: 0.8,
      },
    });

    const decision = await judgeAgentCandidates({
      userMessage: 'Pick the better answer.',
      answerContract: { task_type: 'comparison', required_dimensions: ['revenue'] },
      primaryCandidate: buildCandidate({ id: 'primary', label: 'Primary Agent', score: 7.9 }),
      secondaryCandidate: buildCandidate({ id: 'secondary', label: 'Challenger Agent', score: 7.8 }),
    });

    expect(decision.winnerCandidateId).toBe('secondary');
    expect(decision.summary).toMatch(/stronger available answer/i);
    expect(decision.rationale.join(' ')).toMatch(/best available answer/i);
  });

  it('returns a degraded winner when only one candidate completes', async () => {
    mockRunDiPrompt.mockRejectedValue(new Error('reviewer unavailable'));

    const failedPrimary = {
      ...buildCandidate({ id: 'primary', label: 'Primary Agent', score: 0 }),
      status: 'failed',
      failedReason: 'Primary timed out before returning a brief.',
      presentation: {
        brief: null,
        qa: null,
        trace: {
          failed_attempts: [{ tool: 'agent_loop' }],
          successful_queries: [],
        },
      },
    };

    const decision = await judgeAgentCandidates({
      userMessage: 'Pick the better answer.',
      answerContract: { task_type: 'comparison', required_dimensions: ['revenue'] },
      primaryCandidate: failedPrimary,
      secondaryCandidate: buildCandidate({ id: 'secondary', label: 'Challenger Agent', score: 8.6 }),
    });

    expect(decision.winnerCandidateId).toBe('secondary');
    expect(decision.degraded).toBe(true);
    expect(decision.summary).toMatch(/did not complete successfully/i);
  });
});
