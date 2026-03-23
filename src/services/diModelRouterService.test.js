import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvokeAiProxy = vi.fn();

vi.mock('../prompts/diJsonContracts', () => ({
  buildBlockingQuestionPrompt: () => 'blocking',
  buildDecisionIntelligenceReportPrompt: () => 'report',
  buildSchemaContractMappingPrompt: () => 'schema',
  buildSystemBrainPrompt: () => 'profiler',
  buildWorkflowAReadinessPrompt: () => 'workflow',
}));

vi.mock('../prompts/agentResponsePrompt', () => ({
  buildAgentAnswerContractPrompt: () => 'answer contract',
  buildAgentCandidateJudgePrompt: () => 'candidate judge',
  buildAgentBriefReviewPrompt: () => 'brief review',
  buildAgentBriefSynthesisPrompt: () => 'brief synth',
  buildAgentQaSelfReviewPrompt: () => 'self review',
  buildAgentQaCrossReviewPrompt: () => 'cross review',
  buildAgentQaRepairSynthesisPrompt: () => 'repair synth',
  validateAgentBrief: () => true,
  validateAgentCandidateJudge: () => true,
  validateAgentBriefReview: () => true,
  validateAgentQaReview: () => true,
  validateAnswerContract: () => true,
}));

vi.mock('../prompts/intentParserPrompt', () => ({
  buildIntentParserPrompt: () => 'intent parser',
  validateIntentContract: () => true,
}));

vi.mock('./aiProxyService', () => ({
  invokeAiProxy: (...args) => mockInvokeAiProxy(...args),
}));

const { DI_PROMPT_IDS, runDiPrompt } = await import('./diModelRouterService.js');

describe('diModelRouterService reviewer routing', () => {
  beforeEach(() => {
    mockInvokeAiProxy.mockReset();
  });

  it('uses provider/model overrides for cross-model review prompts and records the resolved route', async () => {
    mockInvokeAiProxy.mockResolvedValue({
      text: JSON.stringify({
        score: 8.4,
        blockers: [],
        issues: [],
        repair_instructions: [],
        dimension_scores: {
          correctness: 8.4,
          completeness: 8.4,
          evidence_alignment: 8.4,
          visualization_fit: 8.4,
          caveat_quality: 8.4,
          clarity: 8.4,
        },
      }),
      model: 'claude-review-live',
    });

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW,
      input: { userMessage: 'review this answer' },
      providerOverride: 'anthropic',
      modelOverride: 'claude-review-configured',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledWith(
      'di_prompt',
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-review-configured',
      }),
      expect.any(Object),
    );
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-review-live');
    expect(result.parsed.score).toBe(8.4);
  });

  it('routes candidate judge prompts through the reviewer provider override', async () => {
    mockInvokeAiProxy.mockResolvedValue({
      text: JSON.stringify({
        winner_candidate_id: 'secondary',
        summary: 'Secondary candidate is better grounded.',
        rationale: ['It aligns better with the required evidence.'],
        loser_issues: ['Primary answer omitted a caveat.'],
        confidence: 0.84,
      }),
      model: 'claude-judge-live',
    });

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE,
      input: { userMessage: 'choose the better answer' },
      providerOverride: 'anthropic',
      modelOverride: 'claude-judge-configured',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledWith(
      'di_prompt',
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-judge-configured',
      }),
      expect.any(Object),
    );
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-judge-live');
    expect(result.parsed.winner_candidate_id).toBe('secondary');
  });
});
