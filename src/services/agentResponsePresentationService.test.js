import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunDiPrompt = vi.fn();

vi.mock('./diModelRouterService.js', () => ({
  DI_PROMPT_IDS: {
    AGENT_ANSWER_CONTRACT: 'prompt_7_agent_answer_contract',
    AGENT_BRIEF_SYNTHESIS: 'prompt_8_agent_brief_synthesis',
    AGENT_BRIEF_REVIEW: 'prompt_9_agent_brief_review',
    AGENT_QA_SELF_REVIEW: 'prompt_10_agent_qa_self_review',
    AGENT_QA_CROSS_REVIEW: 'prompt_11_agent_qa_cross_review',
    AGENT_QA_REPAIR_SYNTHESIS: 'prompt_12_agent_qa_repair_synthesis',
  },
  runDiPrompt: (...args) => mockRunDiPrompt(...args),
}));

const {
  buildAgentPresentationPayload,
  buildDeterministicAnswerContract,
  buildDeterministicAgentBrief,
  computeDeterministicQa,
  reviewAgentBriefDeterministically,
} = await import('./agentResponsePresentationService.js');

function buildComparisonToolCall() {
  return {
    id: 'sql-1',
    name: 'query_sap_data',
    args: { sql: 'SELECT segment, revenue, return_rate FROM segment_metrics' },
    result: {
      success: true,
      result: {
        rowCount: 2,
        rows: [
          { segment: 'high', revenue: 11755265.82, return_rate: 0.46, delivery_days: 8.1 },
          { segment: 'low', revenue: 3646959.59, return_rate: 0.76, delivery_days: 9.3 },
        ],
      },
    },
  };
}

function buildChartToolCall(chartType = 'histogram') {
  return {
    id: 'chart-1',
    name: 'run_python_analysis',
    result: {
      success: true,
      result: {
        analysisType: 'seller_revenue_distribution',
        title: 'Seller Revenue Distribution',
        metrics: {
          'Median Revenue': '1,250.66',
          'Top 10 Share': '13.1%',
        },
        charts: [{ type: chartType, title: 'Distribution' }],
        highlights: ['Median seller revenue: 1,250.66'],
      },
      artifactTypes: ['analysis_result'],
    },
  };
}

function buildQaReview({ score = 8.6, blockers = [], issues = [], repairInstructions = [] } = {}) {
  return {
    score,
    blockers,
    issues,
    repair_instructions: repairInstructions,
    dimension_scores: {
      correctness: score,
      completeness: score,
      evidence_alignment: score,
      visualization_fit: score,
      caveat_quality: score,
      clarity: score,
    },
  };
}

describe('agentResponsePresentationService', () => {
  beforeEach(() => {
    mockRunDiPrompt.mockReset();
  });

  it('infers comparison contracts and required dimensions from the user message', () => {
    const contract = buildDeterministicAnswerContract({
      userMessage: '分析高評分品類 vs 低評分品類在營收、配送天數、退貨率上的差異，用圖表呈現',
      mode: 'analysis',
    });

    expect(contract.task_type).toBe('comparison');
    expect(contract.required_dimensions).toEqual(['revenue', 'delivery days', 'return rate', 'rating', 'categories']);
    expect(contract.required_outputs).toContain('chart');
    expect(contract.required_outputs).toContain('comparison');
    expect(contract.audience_language).toBe('zh');
  });

  it('builds a deterministic brief from successful SQL evidence', () => {
    const brief = buildDeterministicAgentBrief({
      userMessage: 'Compare revenue and return rate by category',
      answerContract: {
        task_type: 'comparison',
        required_dimensions: ['revenue', 'return rate', 'categories'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'short',
      },
      toolCalls: [buildComparisonToolCall()],
      finalAnswerText: 'High-rated categories show stronger revenue and lower return risk.',
    });

    expect(brief.headline).toBe('High-rated categories show stronger revenue and lower return risk.');
    expect(brief.tables).toHaveLength(1);
    expect(brief.tables[0].columns).toEqual(['segment', 'revenue', 'return_rate', 'delivery_days']);
    expect(brief.key_findings.length).toBeGreaterThanOrEqual(1);
  });

  it('flags contradictory numbers and low-value evidence in deterministic QA', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Please show a histogram of seller revenue and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart', 'table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue is extremely concentrated.',
        summary: 'Median seller revenue is R$821.',
        metric_pills: [{ label: 'Median Revenue', value: 'R$821' }],
        tables: [{ title: 'Dump', columns: ['seller_revenue'], rows: [[12.22], [15.22]] }],
        key_findings: ['Median seller revenue: 821'],
        implications: [],
        caveats: ['Revenue may be overstated because multi-seller orders duplicate payments.'],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('histogram')],
      finalAnswerText: 'Median seller revenue: 1,250.66. This revenue proxy may be overstated due to duplicated payments.',
    });

    expect(qa.blockers.join(' ')).toMatch(/Conflicting median revenue/i);
    expect(qa.issues.join(' ')).toMatch(/single-column dump/i);
    expect(qa.dimension_scores.evidence_alignment).toBeLessThan(10);
  });

  it('flags chart mismatch and missing caveat in deterministic review', () => {
    const review = reviewAgentBriefDeterministically({
      userMessage: '請用直方圖分析 Olist 賣家營收分布，標示各分位數',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'zh',
        brevity: 'short',
      },
      brief: {
        headline: '賣家營收呈長尾分布。',
        summary: '分位數已整理如下。',
        metric_pills: [],
        tables: [],
        key_findings: ['Top 1% sellers exceed R$76k.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('bar')],
      finalAnswerText: 'Revenue is a proxy because payments may be duplicated across multi-seller orders.',
    });

    expect(review.pass).toBe(false);
    expect(review.issues.join(' ')).toMatch(/chart|caveat/i);
  });

  it('keeps clean answers on the fast path without cross-review', async () => {
    mockRunDiPrompt.mockImplementation(async ({ promptId }) => {
      if (promptId === 'prompt_8_agent_brief_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Seller revenue is long-tailed with a small head driving outsized revenue.',
            summary: 'The histogram and quantiles show that most sellers sit below the median while the top tail extends sharply.',
            metric_pills: [{ label: 'Median Revenue', value: '1,250.66' }],
            tables: [{ title: 'Quantiles', columns: ['p50', 'p90'], rows: [[1250.66, 14712.37]] }],
            key_findings: ['Top 1% sellers exceed R$76k.'],
            implications: [],
            caveats: ['Revenue is a proxy because payments may duplicate across multi-seller orders.'],
            next_steps: [],
          },
        };
      }

      if (promptId === 'prompt_10_agent_qa_self_review') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: buildQaReview({ score: 8.7 }),
        };
      }

      throw new Error(`Unexpected prompt id: ${promptId}`);
    });

    const payload = await buildAgentPresentationPayload({
      userMessage: 'Please use a histogram to analyze Olist seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'en',
        brevity: 'short',
      },
      toolCalls: [buildChartToolCall('histogram')],
      finalAnswerText: 'Median seller revenue: 1,250.66. Revenue is a proxy because payments may duplicate across multi-seller orders.',
      mode: 'default',
    });

    expect(mockRunDiPrompt).toHaveBeenCalledTimes(2);
    expect(payload.qa.status).toBe('pass');
    expect(payload.qa.repair_attempted).toBe(false);
    expect(payload.qa.reviewers).toHaveLength(1);
    expect(mockRunDiPrompt.mock.calls.some(([args]) => args.promptId === 'prompt_11_agent_qa_cross_review')).toBe(false);
  });

  it('forces cross-review for high-risk tasks when requested by orchestration', async () => {
    mockRunDiPrompt.mockImplementation(async ({ promptId }) => {
      if (promptId === 'prompt_8_agent_brief_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Seller revenue is long-tailed with a steep upper tail.',
            summary: 'Most sellers remain below the median while the upper tail stretches sharply.',
            metric_pills: [{ label: 'Median Revenue', value: '1,250.66' }],
            tables: [{ title: 'Quantiles', columns: ['p50', 'p90'], rows: [[1250.66, 14712.37]] }],
            key_findings: ['Top 1% sellers exceed R$76k.'],
            implications: [],
            caveats: ['Revenue is a proxy because payments may duplicate across multi-seller orders.'],
            next_steps: [],
          },
        };
      }

      if (promptId === 'prompt_10_agent_qa_self_review') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: buildQaReview({ score: 8.8 }),
        };
      }

      if (promptId === 'prompt_11_agent_qa_cross_review') {
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          parsed: buildQaReview({ score: 8.9 }),
        };
      }

      throw new Error(`Unexpected prompt id: ${promptId}`);
    });

    const payload = await buildAgentPresentationPayload({
      userMessage: 'Please compute seller revenue quantiles and explain the histogram.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'en',
        brevity: 'short',
      },
      toolCalls: [buildChartToolCall('histogram')],
      finalAnswerText: 'Median seller revenue: 1,250.66. Revenue is a proxy because payments may duplicate across multi-seller orders.',
      mode: 'analysis',
      forceCrossReview: true,
    });

    expect(payload.qa.status).toBe('pass');
    expect(mockRunDiPrompt.mock.calls.some(([args]) => args.promptId === 'prompt_11_agent_qa_cross_review')).toBe(true);
    expect(payload.qa.reviewers.some((reviewer) => reviewer.stage === 'cross_model')).toBe(true);
  });

  it('triggers cross-review and repairs once when blockers are found', async () => {
    mockRunDiPrompt.mockImplementation(async ({ promptId }) => {
      if (promptId === 'prompt_8_agent_brief_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Median seller revenue is R$821.',
            summary: 'Median seller revenue is R$821.',
            metric_pills: [{ label: 'Median Revenue', value: 'R$821' }],
            tables: [{ title: 'Dump', columns: ['seller_revenue'], rows: [[12.22], [15.22]] }],
            key_findings: ['Median seller revenue: 821'],
            implications: [],
            caveats: [],
            next_steps: [],
          },
        };
      }

      if (promptId === 'prompt_10_agent_qa_self_review') {
        const selfReviewCount = mockRunDiPrompt.mock.calls.filter(([call]) => call.promptId === 'prompt_10_agent_qa_self_review').length;
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: selfReviewCount === 1
            ? buildQaReview({ score: 7.1, blockers: ['Missing caveat'], issues: ['Missing caveat'], repairInstructions: ['Add a caveat and remove duplicated text.'] })
            : buildQaReview({ score: 8.5 }),
        };
      }

      if (promptId === 'prompt_11_agent_qa_cross_review') {
        const crossReviewCount = mockRunDiPrompt.mock.calls.filter(([call]) => call.promptId === 'prompt_11_agent_qa_cross_review').length;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          parsed: crossReviewCount === 1
            ? buildQaReview({ score: 6.9, blockers: ['Conflicting median revenue values'], issues: ['Conflicting median revenue values'], repairInstructions: ['Resolve conflicting median revenue values and add caveat.'] })
            : buildQaReview({ score: 8.4 }),
        };
      }

      if (promptId === 'prompt_12_agent_qa_repair_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Seller revenue is highly concentrated, with most sellers below the median and a steep upper tail.',
            summary: 'The histogram shows a long tail; the caveat below clarifies that payment-based revenue can overstate seller totals.',
            metric_pills: [{ label: 'Median Revenue', value: '1,250.66' }],
            tables: [{ title: 'Quantiles', columns: ['p50', 'p90'], rows: [[1250.66, 14712.37]] }],
            key_findings: ['Top 1% sellers exceed R$76k.'],
            implications: [],
            caveats: ['Revenue is a proxy because payments may duplicate across multi-seller orders.'],
            next_steps: [],
          },
        };
      }

      throw new Error(`Unexpected prompt id: ${promptId}`);
    });

    const payload = await buildAgentPresentationPayload({
      userMessage: 'Please use a histogram to analyze Olist seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'en',
        brevity: 'short',
      },
      toolCalls: [buildChartToolCall('histogram')],
      finalAnswerText: 'Median seller revenue: 1,250.66. Revenue is a proxy because payments may duplicate across multi-seller orders.',
      mode: 'default',
    });

    const repairCalls = mockRunDiPrompt.mock.calls.filter(([call]) => call.promptId === 'prompt_12_agent_qa_repair_synthesis');

    expect(repairCalls).toHaveLength(1);
    expect(payload.qa.status).toBe('pass');
    expect(payload.qa.repair_attempted).toBe(true);
    expect(payload.qa.reviewers.some((reviewer) => reviewer.stage === 'cross_model')).toBe(true);
  });

  it('degrades safely when cross-review is unavailable and still returns warning after one repair', async () => {
    mockRunDiPrompt.mockImplementation(async ({ promptId }) => {
      if (promptId === 'prompt_8_agent_brief_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Median seller revenue is R$821.',
            summary: 'Median seller revenue is R$821.',
            metric_pills: [{ label: 'Median Revenue', value: 'R$821' }],
            tables: [{ title: 'Dump', columns: ['seller_revenue'], rows: [[12.22], [15.22]] }],
            key_findings: ['Median seller revenue: 821'],
            implications: [],
            caveats: [],
            next_steps: [],
          },
        };
      }

      if (promptId === 'prompt_10_agent_qa_self_review') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: buildQaReview({ score: 7.0, blockers: ['Missing caveat'], issues: ['Missing caveat'], repairInstructions: ['Add a caveat.'] }),
        };
      }

      if (promptId === 'prompt_11_agent_qa_cross_review') {
        throw new Error('anthropic reviewer unavailable');
      }

      if (promptId === 'prompt_12_agent_qa_repair_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Median seller revenue is R$821.',
            summary: 'Median seller revenue remains R$821.',
            metric_pills: [{ label: 'Median Revenue', value: 'R$821' }],
            tables: [{ title: 'Dump', columns: ['seller_revenue'], rows: [[12.22], [15.22]] }],
            key_findings: ['Median seller revenue: 821'],
            implications: [],
            caveats: [],
            next_steps: [],
          },
        };
      }

      throw new Error(`Unexpected prompt id: ${promptId}`);
    });

    const payload = await buildAgentPresentationPayload({
      userMessage: 'Please use a histogram to analyze Olist seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'en',
        brevity: 'short',
      },
      toolCalls: [buildChartToolCall('histogram')],
      finalAnswerText: 'Median seller revenue: 1,250.66. Revenue is a proxy because payments may duplicate across multi-seller orders.',
      mode: 'default',
    });

    expect(payload.qa.status).toBe('warning');
    expect(payload.qa.repair_attempted).toBe(true);
    expect(payload.qa.reviewers.some((reviewer) => reviewer.stage === 'cross_model' && reviewer.issues.join(' ').includes('Reviewer unavailable'))).toBe(true);
  });
});
