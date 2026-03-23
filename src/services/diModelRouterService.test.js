import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvokeAiProxy = vi.fn();
const mockValidateAgentQaReview = vi.fn(() => true);
const mockValidateAgentCandidateJudge = vi.fn(() => true);
const mockValidateAnswerContract = vi.fn(() => true);

vi.mock('../prompts/diJsonContracts', () => ({
  buildBlockingQuestionPrompt: () => 'blocking',
  buildDecisionIntelligenceReportPrompt: () => 'report',
  buildSchemaContractMappingPrompt: () => 'schema',
  buildSystemBrainPrompt: () => 'profiler',
  buildWorkflowAReadinessPrompt: () => 'workflow',
}));

vi.mock('../prompts/agentResponsePrompt', () => ({
  buildAgentAnswerContractPrompt: () => 'answer contract',
  buildAnswerContractResponseSchema: () => ({ type: 'object', properties: { task_type: { type: 'string' } } }),
  buildAgentCandidateJudgePrompt: () => 'candidate judge',
  buildAgentCandidateJudgeResponseSchema: () => ({ type: 'object', properties: { winner_candidate_id: { type: 'string' } } }),
  buildAgentBriefReviewPrompt: () => 'brief review',
  buildAgentBriefReviewResponseSchema: () => ({ type: 'object', properties: { pass: { type: 'boolean' } } }),
  buildAgentBriefSynthesisPrompt: () => 'brief synth',
  buildAgentBriefResponseSchema: () => ({ type: 'object', properties: { headline: { type: 'string' } } }),
  buildAgentQaSelfReviewPrompt: () => 'self review',
  buildAgentQaCrossReviewPrompt: () => 'cross review',
  buildAgentQaReviewResponseSchema: () => ({ type: 'object', properties: { score: { type: 'number' } } }),
  buildAgentQaRepairSynthesisPrompt: () => 'repair synth',
  validateAgentBrief: () => true,
  validateAgentCandidateJudge: (...args) => mockValidateAgentCandidateJudge(...args),
  validateAgentBriefReview: () => true,
  validateAgentQaReview: (...args) => mockValidateAgentQaReview(...args),
  validateAnswerContract: (...args) => mockValidateAnswerContract(...args),
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
    mockValidateAgentQaReview.mockReset();
    mockValidateAgentQaReview.mockReturnValue(true);
    mockValidateAgentCandidateJudge.mockReset();
    mockValidateAgentCandidateJudge.mockReturnValue(true);
    mockValidateAnswerContract.mockReset();
    mockValidateAnswerContract.mockReturnValue(true);
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

  it('normalizes the legacy gemini-3-pro alias to gemini-3.1-pro-preview', async () => {
    mockInvokeAiProxy.mockResolvedValue({
      text: JSON.stringify({
        global: {},
        sheets: [],
      }),
      model: 'gemini-3.1-pro-preview',
      transport: 'native',
    });

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.DATA_PROFILER,
      input: { sample: true },
      providerOverride: 'gemini',
      modelOverride: 'gemini-3-pro',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledWith(
      'di_prompt',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.1-pro-preview',
      }),
      expect.any(Object),
    );
    expect(result.model).toBe('gemini-3.1-pro-preview');
    expect(result.transport).toBe('native');
  });

  it('retries strict JSON judge prompts after schema validation failure and succeeds on the second attempt', async () => {
    mockValidateAgentQaReview
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        text: JSON.stringify({ nope: true }),
        model: 'gemini-3.1-pro-preview',
      })
      .mockResolvedValueOnce({
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
        model: 'gemini-3.1-pro-preview',
      });

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW,
      input: { userMessage: 'review this answer' },
      providerOverride: 'gemini',
      modelOverride: 'gemini-3.1-pro-preview',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(2);
    const secondPrompt = mockInvokeAiProxy.mock.calls[1][1].prompt;
    expect(secondPrompt).toMatch(/CRITICAL RETRY INSTRUCTIONS/i);
    expect(result.parsed.score).toBe(8.4);
  });

  it('falls back to anthropic when gemini judge recovery attempts keep failing schema validation', async () => {
    mockValidateAgentCandidateJudge
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockInvokeAiProxy
      .mockResolvedValueOnce({ text: JSON.stringify({ bad: true }), model: 'gemini-3.1-pro-preview' })
      .mockResolvedValueOnce({ text: JSON.stringify({ bad: true }), model: 'gemini-3.1-pro-preview' })
      .mockResolvedValueOnce({ text: JSON.stringify({ bad: true }), model: 'gemini-2.5-flash' })
      .mockResolvedValueOnce({ text: JSON.stringify({ bad: true }), model: 'gemini-2.5-flash-lite' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          winner_candidate_id: 'secondary',
          summary: 'Secondary is the stronger available answer.',
          rationale: ['It carries less answer risk.'],
          loser_issues: ['Primary omitted key evidence.'],
          confidence: 0.74,
        }),
        model: 'claude-sonnet-4-6',
      });

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE,
      input: { userMessage: 'choose the better answer' },
      providerOverride: 'gemini',
      modelOverride: 'gemini-3.1-pro-preview',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(5);
    expect(mockInvokeAiProxy.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }));
    expect(result.provider).toBe('anthropic');
    expect(result.parsed.winner_candidate_id).toBe('secondary');
  });

  it('retries non-judge strict Gemini prompts with response schema after contract validation failure', async () => {
    mockValidateAnswerContract
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        text: JSON.stringify({ task_type: 'recommendation' }),
        model: 'gemini-3.1-pro-preview',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          task_type: 'recommendation',
          required_dimensions: ['replenishment'],
          required_outputs: ['recommendation', 'caveat'],
          audience_language: 'zh',
          brevity: 'analysis',
          analysis_depth: ['methodology_disclosure'],
        }),
        model: 'gemini-3.1-pro-preview',
      });

    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_ANSWER_CONTRACT,
      input: { userMessage: '幫我做補貨建議' },
      providerOverride: 'gemini',
      modelOverride: 'gemini-3.1-pro-preview',
    });

    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(2);
    expect(mockInvokeAiProxy.mock.calls[0][1]).toEqual(expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      responseMimeType: 'application/json',
      responseSchema: expect.any(Object),
    }));
    expect(mockInvokeAiProxy.mock.calls[1][1].prompt).toMatch(/CRITICAL RETRY INSTRUCTIONS/i);
    expect(result.parsed.required_outputs).toEqual(['recommendation', 'caveat']);
  });
});
