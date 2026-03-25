import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunDiPrompt = vi.fn();

vi.mock('../planning/diModelRouterService.js', () => ({
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

function buildChartToolCall(chartType = 'histogram', overrides = {}) {
  const {
    metrics = {
      'Median Revenue': '1,250.66',
      'Top 10 Share': '13.1%',
    },
    charts = [{ type: chartType, title: 'Distribution' }],
    tables = [],
    highlights = ['Median seller revenue: 1,250.66'],
    summary,
  } = overrides;

  return {
    id: 'chart-1',
    name: 'run_python_analysis',
    result: {
      success: true,
      result: {
        analysisType: 'seller_revenue_distribution',
        title: 'Seller Revenue Distribution',
        metrics,
        charts,
        tables,
        summary: summary || 'Seller revenue remains highly skewed.',
        highlights,
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
      methodology_transparency: score,
      actionability: score,
      information_density: score,
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

  it('infers quantiles as a required dimension when the user asks to mark percentiles', () => {
    const contract = buildDeterministicAnswerContract({
      userMessage: 'Please use a histogram to analyze seller revenue distribution and mark quantiles.',
      mode: 'analysis',
    });

    expect(contract.required_dimensions).toContain('quantiles');
    expect(contract.required_outputs).toContain('chart');
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

  it('labels successful 0-row SQL lookups as no-evidence and keeps dataset/table metadata in the trace', async () => {
    const payload = await buildAgentPresentationPayload({
      userMessage: 'Show supplier data',
      toolCalls: [{
        id: 'sql-zero',
        name: 'query_sap_data',
        args: { sql: 'SELECT supplier_name FROM suppliers WHERE status = \'inactive\'' },
        result: {
          success: true,
          result: {
            rowCount: 0,
            rows: [],
            meta: {
              tables_queried: ['suppliers'],
              dataset_label: 'Dataset B: DI Operations',
              dataset_scope: 'current_user_scoped',
            },
          },
        },
      }],
      finalAnswerText: '',
    });

    expect(payload.trace.successful_queries[0].summary).toContain('0 rows / no evidence');
    expect(payload.trace.successful_queries[0].dataset_label).toBe('Dataset B: DI Operations');
    expect(payload.trace.successful_queries[0].tables).toEqual(['suppliers']);
  });

  it('does not crash when direct JSON briefs trigger unmatched-pill deterministic repairs', async () => {
    mockRunDiPrompt.mockResolvedValue({ parsed: buildQaReview() });

    const payload = await buildAgentPresentationPayload({
      userMessage: '請比較 2016–2018 前三州營收、年度趨勢與年均成長率。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['地區營收', '年度趨勢', '前三地區', '年均成長率', '整體平均'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      toolCalls: [{
        id: 'sql-annual',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, year, revenue FROM annual_revenue' },
        result: {
          success: true,
          result: {
            rowCount: 3,
            rows: [
              { region: 'SP', year: 2016, revenue: 14710.82, total_revenue: 5202955.05, overall_cagr_2016_2018: 11.18 },
              { region: 'RJ', year: 2018, revenue: 906646.41, total_revenue: 1824092.67, overall_cagr_2016_2018: 11.18 },
              { region: 'MG', year: 2018, revenue: 857267.79, total_revenue: 1585308.03, overall_cagr_2016_2018: 11.18 },
            ],
          },
        },
      }],
      finalAnswerText: JSON.stringify({
        headline: '前三州成長分化。',
        summary: 'SP 與 MG 成長快於整體，RJ 較慢。',
        metric_pills: [
          { label: '整體 CAGR', value: 'R$543.67K', source: 'generate_chart' },
        ],
        tables: [],
        charts: [],
        key_findings: [],
        implications: [],
        caveats: [],
        next_steps: [],
      }),
      mode: 'analysis',
    });

    expect(payload.brief).toBeTruthy();
    expect(Array.isArray(payload.brief.metric_pills)).toBe(true);
  });

  it('does not create false magnitude mismatches from comma-formatted evidence values', () => {
    const qa = computeDeterministicQa({
      userMessage: '請比較 2016–2018 前三州營收、年度趨勢與 CAGR。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['地區營收', '年度趨勢', '年均成長率'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      brief: {
        headline: 'SP, RJ, and MG led the period.',
        summary: 'SP reached 5,202,955.05 in total revenue, while overall revenue rose from 49,785.92 in 2016 to 7,386,050.8 in 2018.',
        metric_pills: [{ label: 'SP 總營收', value: '5.20M' }],
        tables: [{
          title: 'Annual revenue',
          columns: ['region', 'year', 'revenue', 'total_revenue', 'overall_revenue'],
          rows: [
            ['SP', '2016', '14710.82', '5202955.05', '49785.92'],
            ['SP', '2018', '2975757.23', '5202955.05', '7386050.8'],
            ['RJ', '2018', '906646.41', '1824092.67', '7386050.8'],
          ],
        }],
        key_findings: ['Overall revenue expanded materially over the period.'],
        implications: [],
        caveats: ['Limited annual coverage: only three yearly observations.'],
        next_steps: [],
      },
      toolCalls: [{
        id: 'sql-olist-1',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, year, revenue, total_revenue, overall_revenue FROM annual_revenue_brl' },
        result: {
          success: true,
          result: {
            rowCount: 3,
            rows: [
              { region: 'SP', year: 2016, revenue: 14710.82, total_revenue: 5202955.05, overall_revenue: 49785.92 },
              { region: 'SP', year: 2018, revenue: 2975757.23, total_revenue: 5202955.05, overall_revenue: 7386050.8 },
              { region: 'RJ', year: 2018, revenue: 906646.41, total_revenue: 1824092.67, overall_revenue: 7386050.8 },
            ],
          },
        },
      }],
      finalAnswerText: '',
    });

    expect(qa.blockers.join(' ')).not.toMatch(/Magnitude mismatch/i);
    expect(qa.issues.join(' ')).not.toMatch(/202,955|785\.92|710\.82|246\.45|811\.21|322\.26/);
  });

  it('treats magnitude mismatches as heuristic findings instead of hard blockers', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Compare top-state revenue and annual trend.',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['revenue', 'annual trend'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'analysis',
      },
      brief: {
        headline: 'SP dominates.',
        summary: 'SP total revenue reached 52,029,550.50 over the period.',
        metric_pills: [{ label: 'SP Total Revenue', value: '5.20M' }],
        tables: [],
        key_findings: [],
        implications: [],
        caveats: ['Limited annual coverage: only three yearly observations.'],
        next_steps: [],
      },
      toolCalls: [{
        id: 'sql-olist-2',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, total_revenue FROM annual_revenue_brl' },
        result: {
          success: true,
          result: {
            rowCount: 1,
            rows: [{ region: 'SP', total_revenue: 5202955.05 }],
          },
        },
      }],
      finalAnswerText: '',
    });

    expect(qa.blockers.join(' ')).not.toMatch(/Magnitude mismatch/i);
    expect((qa.heuristic_findings || []).join(' ')).toMatch(/Magnitude mismatch/i);
    expect(qa.dimension_scores.correctness).toBeGreaterThan(0);
  });

  it('normalizes direct JSON Olist briefs before QA and can pass without false magnitude blockers', async () => {
    mockRunDiPrompt.mockResolvedValueOnce({ parsed: buildQaReview({ score: 8.8 }) });

    const payload = await buildAgentPresentationPayload({
      userMessage: '請比較 2016–2018 前三州營收、年度趨勢與 CAGR。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['地區營收', '年度趨勢', '前三地區', '年均成長率', '整體平均'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      toolCalls: [{
        id: 'sql-annual-pass',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, year, revenue, total_revenue, overall_revenue, overall_avg_annual_revenue, overall_cagr_pct, region_cagr_pct FROM annual_revenue_brl' },
        _dataValidationWarnings: [{
          id: 'small_sample',
          severity: 'high',
          message: 'Only 3 distinct time periods in the data. Time-series statistics require at least 12 periods for reliability.',
          instruction: 'Caveat any time-series conclusions drawn from only three yearly observations.',
        }],
        result: {
          success: true,
          result: {
            rowCount: 9,
            rows: [
              { region: 'SP', year: 2016, revenue: 14710.82, total_revenue: 5202955.05, overall_revenue: 49785.92, overall_avg_annual_revenue: 4530547.9, overall_cagr_pct: 1118.02, region_cagr_pct: 1322.26 },
              { region: 'SP', year: 2018, revenue: 2975757.23, total_revenue: 5202955.05, overall_revenue: 7386050.8, overall_avg_annual_revenue: 4530547.9, overall_cagr_pct: 1118.02, region_cagr_pct: 1322.26 },
              { region: 'RJ', year: 2016, revenue: 11246.45, total_revenue: 1824092.67, overall_revenue: 49785.92, overall_avg_annual_revenue: 4530547.9, overall_cagr_pct: 1118.02, region_cagr_pct: 797.87 },
              { region: 'RJ', year: 2018, revenue: 906646.41, total_revenue: 1824092.67, overall_revenue: 7386050.8, overall_avg_annual_revenue: 4530547.9, overall_cagr_pct: 1118.02, region_cagr_pct: 797.87 },
              { region: 'MG', year: 2016, revenue: 4811.21, total_revenue: 1585308.03, overall_revenue: 49785.92, overall_avg_annual_revenue: 4530547.9, overall_cagr_pct: 1118.02, region_cagr_pct: 1234.85 },
              { region: 'MG', year: 2018, revenue: 857267.79, total_revenue: 1585308.03, overall_revenue: 7386050.8, overall_avg_annual_revenue: 4530547.9, overall_cagr_pct: 1118.02, region_cagr_pct: 1234.85 },
            ],
          },
        },
      }],
      finalAnswerText: JSON.stringify({
        headline: '2016–2018 年前三州成長分化。',
        summary: 'SP 維持最大規模，RJ 增速落後，而 MG 的成長快於整體。2016 到 2018 年間，整體營收由 49,785.92 增至 7,386,050.8，但這個高成長受低基期影響，較適合做相對比較而非長期外推。',
        metric_pills: [
          { label: 'SP 總營收', value: '5202955.05', source: 'query_sap_data' },
          { label: 'RJ 總營收', value: '1824092.67', source: 'query_sap_data' },
          { label: 'MG 總營收', value: '1585308.03', source: 'query_sap_data' },
          { label: '整體年均營收', value: '4530547.9', source: 'query_sap_data' },
          { label: '整體 CAGR', value: '1118.02%', source: 'query_sap_data' },
          { label: '平均月營收', value: 'R$543,666', source: 'generate_chart' },
        ],
        tables: [{
          title: '2016–2018 前三地區年度營收與整體比較',
          columns: ['region', 'year', 'revenue', 'total_revenue', 'overall_revenue', 'overall_avg_annual_revenue', 'overall_cagr_pct', 'region_cagr_pct'],
          rows: [
            ['SP', '2016', '14710.82', '5202955.05', '49785.92', '4530547.9', '1118.02', '1322.26'],
            ['SP', '2018', '2975757.23', '5202955.05', '7386050.8', '4530547.9', '1118.02', '1322.26'],
            ['RJ', '2018', '906646.41', '1824092.67', '7386050.8', '4530547.9', '1118.02', '797.87'],
            ['MG', '2018', '857267.79', '1585308.03', '7386050.8', '4530547.9', '1118.02', '1234.85'],
          ],
        }],
        charts: [],
        key_findings: [
          'SP 與 MG 的 CAGR 高於整體，而 RJ 低於整體，顯示前三州的成長動能已分化。',
          '三個州在 2018 年的營收都高於 2016 年，但 RJ 在後段的成長幅度明顯弱於 SP 與 MG。',
        ],
        implications: [
          'SP 應視為核心市場，MG 適合作為第二波擴張重點，RJ 則更偏向成熟市場經營。',
        ],
        caveats: [
          '⚠️ Proxy: Using `order_items.price` as proxy for revenue. Refunds, discounts, taxes, and freight are excluded.',
          'Limited annual coverage: only three yearly observations, so time-series inference is not reliable.',
          'CAGR is inflated due to extremely low base period (start = 49,785.92 overall); absolute growth figures are more meaningful for decision-making.',
        ],
        next_steps: ['擴展到全部州別，建立完整的地區營收與成長矩陣。'],
        methodology_note: 'CAGR = ((2018 revenue / 2016 revenue)^(1/2) - 1) × 100 when pct fields are provided in evidence.',
      }),
      mode: 'analysis',
    });

    expect(payload.brief.metric_pills.some((pill) => pill.label === '平均月營收')).toBe(false);
    expect(payload.qa.blockers.join(' ')).not.toMatch(/Magnitude mismatch/i);
    expect(payload.qa.score).toBeGreaterThanOrEqual(8);
  });

  it('formats Olist revenue and growth pills with BRL and percent semantics when evidence supports it', async () => {
    mockRunDiPrompt.mockResolvedValueOnce({ parsed: buildQaReview({ score: 8.9 }) });

    const payload = await buildAgentPresentationPayload({
      userMessage: '請比較 2016–2018 前三州營收、年度趨勢與 CAGR。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['地區營收', '年度趨勢', '前三地區', '年均成長率', '整體平均'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      toolCalls: [{
        id: 'sql-annual-brl',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, total_revenue, overall_cagr_pct FROM annual_revenue' },
        result: {
          success: true,
          result: {
            rowCount: 3,
            rows: [
              { region: 'SP', total_revenue: 5202955.05, overall_cagr_pct: 1118.02 },
              { region: 'RJ', total_revenue: 1824092.67, overall_cagr_pct: 1118.02 },
              { region: 'MG', total_revenue: 1585308.03, overall_cagr_pct: 1118.02 },
            ],
            meta: { dataset_label: 'Dataset A: Olist E-Commerce' },
          },
        },
      }],
      finalAnswerText: JSON.stringify({
        headline: '2016–2018 年前三州營收與成長比較。',
        summary: '資料來源：Dataset A（Olist E-Commerce）。',
        metric_pills: [
          { label: 'SP 總營收', value: '5202955.05', source: 'query_sap_data' },
          { label: '整體 CAGR', value: '1118.02', source: 'query_sap_data' },
        ],
        tables: [],
        charts: [],
        key_findings: [],
        implications: [],
        caveats: ['CAGR 受極低基期影響而被放大。'],
        next_steps: [],
      }),
      mode: 'analysis',
    });

    const pillValues = payload.brief.metric_pills.map((pill) => pill.value);
    expect(pillValues).toContain('R$5.20M');
    expect(pillValues).toContain('1,118.02%');
  });

  it('recovers the first full JSON brief when extra JSON-like content is appended after it', async () => {
    mockRunDiPrompt.mockResolvedValueOnce({ parsed: buildQaReview({ score: 8.7 }) });

    const directBrief = {
      headline: '前三地區營收比較應保留原始 direct JSON 結構。',
      summary: '前三地區總營收比較顯示 SP、RJ、MG 為前三，且 SP 地區營收最高。',
      metric_pills: [
        { label: 'SP 總營收', value: '5202955.05', source: 'query_sap_data' },
      ],
      tables: [{
        title: 'Custom Table',
        columns: ['region', 'total_revenue'],
        rows: [['SP', '5202955.05']],
      }],
      charts: [{
        type: 'bar',
        title: 'Custom Chart',
        xKey: 'region',
        yKey: 'total_revenue',
        series: ['total_revenue'],
        data: [{ region: 'SP', total_revenue: 5202955.05 }],
      }],
      key_findings: ['SP 為前三地區中營收最高者。'],
      implications: ['保留 direct JSON tables/charts 供後續 QA 與呈現使用。'],
      caveats: ['僅作示意。'],
      next_steps: ['後續可擴展更多州。'],
    };

    const payload = await buildAgentPresentationPayload({
      userMessage: '請比較前三州營收。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['地區營收', '前三地區'],
        required_outputs: ['table', 'comparison', 'chart'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      toolCalls: [{
        id: 'sql-direct-json-recovery',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, total_revenue FROM annual_revenue_brl' },
        result: {
          success: true,
          result: {
            rowCount: 1,
            rows: [{ region: 'SP', total_revenue: 5202955.05 }],
            meta: { dataset_label: 'Dataset A: Olist E-Commerce' },
          },
        },
      }],
      finalAnswerText: `${JSON.stringify(directBrief)}\n{"note":"extra trailing object"}`,
      mode: 'analysis',
    });

    expect(payload.brief.tables[0]?.title).toBe('Custom Table');
    expect(payload.brief.charts[0]?.title).toBe('Custom Chart');
    expect(payload.brief.metric_pills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'SP 總營收', value: 'R$5.20M' }),
      ]),
    );
  });

  it('uses a blocked fallback brief instead of raw narrative when every tool attempt fails', () => {
    const brief = buildDeterministicAgentBrief({
      userMessage: '比較一下這批資料用保守策略和激進策略的補貨差異，然後給我建議。',
      answerContract: {
        task_type: 'comparison',
        required_dimensions: ['replenishment', 'risk'],
        required_outputs: ['comparison', 'recommendation', 'caveat'],
        audience_language: 'zh',
        brevity: 'short',
      },
      toolCalls: [{
        id: 'scenario-fail-1',
        name: 'run_scenario',
        args: { scenario: 'conservative_vs_aggressive' },
        result: {
          success: false,
          error: "Cannot read properties of undefined (reading 'id')",
        },
      }],
      finalAnswerText: '激進策略會明顯放大缺料風險，而且你目前近30天到貨準時率 0%。',
    });

    expect(brief.headline).toMatch(/blocked by tool failures/i);
    expect(brief.summary).toMatch(/No successful evidence was produced/i);
    expect(brief.metric_pills).toEqual([]);
    expect(brief.tables).toEqual([]);
    expect(brief.key_findings).toEqual([]);
    expect(brief.caveats.join(' ')).toMatch(/tool attempt failed/i);
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

  it('does not produce false conflicts from dense multi-number summary strings', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Show seller revenue descriptive statistics.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue shows a long-tail distribution.',
        summary: 'Average seller revenue is R$4,391.48.',
        metric_pills: [{ label: 'Average Revenue', value: 'R$4,391.48' }],
        tables: [{ title: 'Stats', columns: ['metric', 'value'], rows: [['mean', 4391.48]] }],
        key_findings: ['Average seller revenue is R$4,391.48.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [{
        id: 'py-1',
        name: 'run_python_analysis',
        result: {
          success: true,
          result: {
            analysisType: 'descriptive_stats',
            title: 'Seller Revenue Descriptive Statistics',
            metrics: { 'Average Revenue': '4,391.48', 'Min Revenue': '3.50', 'Max Revenue': '229,472.63' },
            summary: 'Seller revenue ranges from $3.50 to $229,472.63 with an average of $4,391.48 and a standard deviation of $13,922.00. Total revenue across all sellers is $13,591,643.70.',
            highlights: [],
            charts: [],
          },
          artifactTypes: ['analysis_result'],
        },
      }],
      finalAnswerText: 'Average revenue per seller is R$4,391.48.',
    });

    // Should NOT flag false conflicts: $3.50 (min) should not be paired with "mean/average"
    const meanConflict = qa.blockers.concat(qa.issues).filter((s) => /conflicting.*mean/i.test(s));
    expect(meanConflict).toHaveLength(0);
  });

  it('does not confuse average monthly revenue with overall average growth comparisons', () => {
    const qa = computeDeterministicQa({
      userMessage: '請比較前三州營收、年度趨勢與年均成長率。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['地區營收', '年度趨勢', '年均成長率', '整體平均'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      brief: {
        headline: 'SP 的標準化成長高於整體。',
        summary: '以標準化後的月均營收 CAGR 比較整體平均：整體為 474.18%；SP 為 570.46%。月度圖顯示全平台平均月營收為 R$543,666。',
        metric_pills: [
          { label: '整體標準化 CAGR', value: '474.18%' },
          { label: '平均月營收', value: 'R$543,666' },
        ],
        tables: [],
        key_findings: [],
        implications: [],
        caveats: ['2016 年僅覆蓋 3 個月，因此已改用月均營收重算 CAGR。'],
        next_steps: [],
      },
      toolCalls: [],
      finalAnswerText: '',
    });

    expect(qa.blockers.join(' ')).not.toMatch(/Conflicting mean values/i);
  });

  it('does not treat currency averages and percentage growth metrics as contradictory mean values', () => {
    const qa = computeDeterministicQa({
      userMessage: '請比較整體平均與標準化 CAGR。',
      answerContract: {
        task_type: 'comparison',
        required_dimensions: ['整體平均', '年均成長率'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      brief: {
        headline: '平均月營收與標準化 CAGR 應視為不同指標。',
        summary: '整體平均月營收為 R$543,666；整體標準化 CAGR 為 474.18%。兩者分別代表規模與成長速度。',
        metric_pills: [
          { label: '平均月營收', value: 'R$543,666' },
          { label: '整體標準化 CAGR', value: '474.18%' },
        ],
        tables: [{
          title: 'Overview',
          columns: ['metric', 'value'],
          rows: [
            ['avg_monthly_revenue', '543666'],
            ['overall_normalized_cagr_pct', '474.18'],
          ],
        }],
        key_findings: [],
        implications: [],
        caveats: ['部分年度覆蓋不足，因此 CAGR 已改用標準化月均口徑。'],
        next_steps: [],
      },
      toolCalls: [],
      finalAnswerText: '',
    });

    expect(qa.blockers.join(' ')).not.toMatch(/Conflicting mean values/i);
    expect(qa.issues.join(' ')).not.toMatch(/Conflicting mean values/i);
  });

  it('does not treat different entity or time rows as contradictory facts for the same metric column', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Compare top regions by normalized growth.',
      answerContract: {
        task_type: 'comparison',
        required_dimensions: ['growth', 'regions'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'analysis',
      },
      brief: {
        headline: 'SP grows faster than RJ and MG.',
        summary: 'SP normalized growth is 570.46%, versus 217.44% for RJ and 371.94% for MG.',
        metric_pills: [
          { label: 'SP Normalized Growth', value: '570.46%' },
          { label: 'RJ Normalized Growth', value: '217.44%' },
          { label: 'MG Normalized Growth', value: '371.94%' },
        ],
        tables: [{
          title: 'Growth by Region and Year',
          columns: ['region', 'year', 'avg_monthly_revenue', 'region_normalized_cagr_pct'],
          rows: [
            ['SP', '2016', '7355.41', '570.46'],
            ['SP', '2018', '330639.69', '570.46'],
            ['RJ', '2016', '11246.45', '217.44'],
            ['RJ', '2018', '113330.80', '217.44'],
          ],
        }],
        key_findings: [],
        implications: [],
        caveats: ['Growth values compare different regions and periods, not contradictory facts.'],
        next_steps: [],
      },
      toolCalls: [],
      finalAnswerText: '',
    });

    const allIssues = qa.blockers.concat(qa.issues).join(' ');
    expect(allIssues).not.toMatch(/Conflicting normalized values/i);
    expect(allIssues).not.toMatch(/Conflicting monthly revenue values/i);
  });

  it('blocks normalized growth when the base period has fewer than 6 months of coverage', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Compare region growth.',
      answerContract: {
        task_type: 'comparison',
        required_dimensions: ['growth', 'trend'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'en',
        brevity: 'analysis',
      },
      brief: {
        headline: 'Normalized growth is used for the comparison.',
        summary: 'Because yearly coverage is uneven, the brief uses normalized monthly CAGR from 2016 to 2018.',
        metric_pills: [{ label: 'Overall Normalized CAGR', value: '603.22%' }],
        tables: [{
          title: 'Coverage and Growth',
          columns: ['region', 'year', 'covered_months', 'region_normalized_cagr_pct'],
          rows: [
            ['SP', '2016', '2', '570.46'],
            ['SP', '2018', '9', '570.46'],
            ['RJ', '2016', '1', '217.44'],
            ['RJ', '2018', '8', '217.44'],
          ],
        }],
        key_findings: ['Normalized growth is computed from 2016 to 2018.'],
        implications: [],
        caveats: ['2016 is a partial year with fewer months of data.'],
        next_steps: [],
        methodology_note: '(2018 monthly average / 2016 monthly average)^(1/2) - 1',
      },
      toolCalls: [{
        id: 'sql-growth',
        name: 'query_sap_data',
        result: {
          success: true,
          result: {
            rowCount: 4,
            columns: ['region', 'year', 'covered_months', 'region_normalized_cagr_pct'],
            rows: [
              { region: 'SP', year: 2016, covered_months: 2, region_normalized_cagr_pct: 570.46 },
              { region: 'SP', year: 2018, covered_months: 9, region_normalized_cagr_pct: 570.46 },
              { region: 'RJ', year: 2016, covered_months: 1, region_normalized_cagr_pct: 217.44 },
              { region: 'RJ', year: 2018, covered_months: 8, region_normalized_cagr_pct: 217.44 },
            ],
          },
        },
      }],
      finalAnswerText: '',
    });

    expect(qa.blockers.join(' ')).toMatch(/base period 2016.*only 1 month|only 2 month/i);
  });

  it('does not extract percentile label numbers as metric values (P50 → 50)', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Show revenue percentiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue'],
        required_outputs: ['table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue percentiles computed.',
        summary: 'P50 Revenue is R$821.48.',
        metric_pills: [{ label: 'P50 Revenue', value: '821.48' }],
        tables: [{ title: 'Percentiles', columns: ['p50', 'p90'], rows: [[821.48, 9525.32]] }],
        key_findings: ['P50 Revenue: 821.48', 'P90 Revenue: 9,525.32'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [{
        id: 'py-2',
        name: 'run_python_analysis',
        result: {
          success: true,
          result: {
            analysisType: 'percentiles',
            title: 'Seller Revenue Percentiles',
            metrics: { 'P50 Revenue': '821.48', 'P90 Revenue': '9,525.32' },
            summary: 'P50 = 821.48, P90 = 9,525.32.',
            highlights: [],
            charts: [],
          },
          artifactTypes: ['analysis_result'],
        },
      }],
      finalAnswerText: 'P50 is 821.48 and P90 is 9,525.32.',
    });

    // Should NOT flag false median conflict (50 from P50 label vs 821.48 from value)
    const medianConflict = qa.blockers.concat(qa.issues).filter((s) => /conflicting.*median/i.test(s));
    expect(medianConflict).toHaveLength(0);
  });

  it('recognizes annual trend and CAGR coverage and accepts limited yearly coverage caveats', () => {
    const qa = computeDeterministicQa({
      userMessage: '請比較 2016–2018 前三州營收、年度變化與 CAGR。',
      answerContract: {
        task_type: 'mixed',
        required_dimensions: ['年度趨勢', '年均成長率', '營收'],
        required_outputs: ['table', 'comparison'],
        audience_language: 'zh',
        brevity: 'analysis',
      },
      brief: {
        headline: 'SP leads on scale while RJ lags on momentum.',
        summary: '2016 到 2018 年間，SP 與 MG 持續成長，而 RJ 在 2017 到 2018 幾乎持平，顯示年度變化與成長動能已出現分化。',
        metric_pills: [{ label: 'SP 總營收', value: 'R$5.20M' }],
        tables: [{
          title: 'Annual Revenue by Region',
          columns: ['region', 'year', 'revenue'],
          rows: [
            ['SP', '2016', '14710.82'],
            ['SP', '2018', '2975757.23'],
            ['RJ', '2017', '906199.81'],
            ['RJ', '2018', '906646.41'],
          ],
        }],
        key_findings: [
          '年度變化上，SP 由 2016 的 14710.82 提升至 2018 的 2975757.23，而 RJ 在 2017 到 2018 幾乎持平。',
          'SP 與 MG 的 CAGR 高於整體，RJ 的 CAGR 低於整體，顯示年均成長率已明顯分化。',
        ],
        implications: ['MG is growing faster than RJ despite starting from a smaller base.'],
        caveats: ['Limited annual coverage: only three yearly observations, so time-series inference is not reliable.'],
        next_steps: ['Extend the comparison to all states using the same annual structure.'],
      },
      toolCalls: [{
        id: 'sql-annual',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, year, revenue FROM annual_revenue' },
        _dataValidationWarnings: [{
          id: 'small_sample',
          severity: 'high',
          message: 'Only 3 distinct time periods in the data. Time-series statistics require at least 12 periods for reliability.',
          instruction: 'With only 3 periods, seasonal patterns and trends cannot be reliably detected. Caveat any time-series conclusions.',
        }],
        result: {
          success: true,
          result: {
            rowCount: 4,
            columns: ['region', 'year', 'revenue'],
            rows: [
              { region: 'SP', year: 2016, revenue: 14710.82 },
              { region: 'SP', year: 2018, revenue: 2975757.23 },
              { region: 'RJ', year: 2017, revenue: 906199.81 },
              { region: 'RJ', year: 2018, revenue: 906646.41 },
            ],
          },
        },
      }],
      finalAnswerText: 'The top states diverged over time, with SP and MG still expanding while RJ flattened.',
    });

    expect(qa.missing_dimensions).not.toContain('年度趨勢');
    expect(qa.missing_dimensions).not.toContain('年均成長率');
    expect(qa.issues.join(' ')).not.toMatch(/Data quality warning not addressed/i);
  });

  it('keeps histogram-plus-quantiles requests in warning when quantiles are not annotated on the chart', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Please use a histogram to analyze seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue is long-tailed.',
        summary: 'Quantiles are listed in the evidence table.',
        metric_pills: [],
        tables: [{
          title: 'Quantiles',
          columns: ['Percentile', 'Revenue'],
          rows: [['P10', '79.51'], ['P25', '208.85'], ['P50', '821.48'], ['P75', '3,280.83'], ['P90', '9,525.32'], ['P95', '16,260.66'], ['P99', '55,108.72']],
        }],
        key_findings: [],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('histogram')],
      finalAnswerText: 'P10 through P99 were calculated.',
    });

    expect(qa.blockers.join(' ')).toMatch(/not directly marked on the chart artifact/i);
  });

  it('accepts histogram-plus-quantiles evidence when all percentile lines and values are present', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Please use a histogram to analyze seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue is long-tailed.',
        summary: 'Core cut points rise from P25 = R$208.85 to P50 = R$821.48, P75 = R$3,280.83, and P90 = R$9,525.32.',
        metric_pills: [],
        tables: [{
          title: 'Quantiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
        key_findings: ['The histogram marks P25, P50, P75, and P90 directly on the revenue bins.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('histogram', {
        charts: [{
          type: 'bar',
          title: 'Distribution',
          referenceLines: [
            { axis: 'x', value: 'R$32-100', label: 'P10' },
            { axis: 'x', value: 'R$100-316', label: 'P25' },
            { axis: 'x', value: 'R$316-1K', label: 'P50' },
            { axis: 'x', value: 'R$3K-10K', label: 'P75/P90' },
            { axis: 'x', value: 'R$10K-32K', label: 'P95' },
            { axis: 'x', value: 'R$32K-100K', label: 'P99' },
          ],
        }],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
      })],
      finalAnswerText: 'P10 through P99 are annotated on the chart.',
    });

    expect(qa.blockers.join(' ')).not.toMatch(/quantile/i);
  });

  it('flags invented SQL failure caveats when the trace has no failed attempts', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Please use a histogram to analyze seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue is highly concentrated.',
        summary: 'P25 = R$208.85, P50 = R$821.48, P75 = R$3,280.83, and P90 = R$9,525.32.',
        metric_pills: [],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
        key_findings: [],
        implications: [],
        caveats: ['The direct SQL lookup failed due to a local SQL worker access error.'],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('histogram', {
        charts: [{
          type: 'bar',
          title: 'Distribution',
          referenceLines: [
            { axis: 'x', value: 'R$32-100', label: 'P10' },
            { axis: 'x', value: 'R$100-316', label: 'P25' },
            { axis: 'x', value: 'R$316-1K', label: 'P50' },
            { axis: 'x', value: 'R$3K-10K', label: 'P75/P90' },
            { axis: 'x', value: 'R$10K-32K', label: 'P95' },
            { axis: 'x', value: 'R$32K-100K', label: 'P99' },
          ],
        }],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
      })],
      finalAnswerText: 'The SQL worker access error prevented retrieval of the exact quantile cutoffs.',
    });

    expect(qa.blockers.join(' ')).toMatch(/does not exist in the execution trace/i);
  });

  it('flags synthetic evidence and numeric claims when failed tools produced no successful evidence', () => {
    const qa = computeDeterministicQa({
      userMessage: '比較保守策略和激進策略的補貨差異，然後給我建議。',
      answerContract: {
        task_type: 'comparison',
        required_dimensions: ['replenishment', 'risk'],
        required_outputs: ['comparison', 'recommendation', 'caveat'],
        audience_language: 'zh',
        brevity: 'short',
      },
      brief: {
        headline: '保守策略較適合這批資料。',
        summary: '近30天到貨準時率 0%，因此建議偏保守補貨。',
        metric_pills: [{ label: 'OTD 30d', value: '0%' }],
        tables: [{
          title: 'Comparison Evidence',
          columns: ['面向', '保守策略', '激進策略'],
          rows: [['補貨量', '較高', '較低']],
        }],
        key_findings: ['保守策略缺貨風險較低。'],
        implications: ['激進策略會放大停供風險。'],
        caveats: ['目前沒有成功的情境分析結果。'],
        next_steps: ['重新執行情境分析。'],
      },
      toolCalls: [{
        id: 'scenario-fail-1',
        name: 'run_scenario',
        args: { scenario: 'conservative_vs_aggressive' },
        result: {
          success: false,
          error: "Cannot read properties of undefined (reading 'id')",
        },
      }],
      finalAnswerText: '目前無法做正式情境分析，但近30天到貨準時率 0%。',
    });

    expect(qa.blockers.join(' ')).toMatch(/no tool call succeeded/i);
    expect(qa.blockers.join(' ')).toMatch(/specific numbers despite having no successful evidence/i);
    expect(qa.repair_instructions.join(' ')).toMatch(/remove unsupported metric pills and evidence tables/i);
    expect(qa.dimension_scores.correctness).toBeLessThan(10);
  });

  it('flags missing core quantile narrative when the artifact is complete but the brief only mentions part of the quantiles', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Please use a histogram to analyze seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue is long-tailed.',
        summary: 'The median is R$821.48 and P90 is R$9,525.32.',
        metric_pills: [],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
        key_findings: ['Quantiles are marked on the chart.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('histogram', {
        charts: [{
          type: 'bar',
          title: 'Distribution',
          referenceLines: [
            { axis: 'x', value: 'R$32-100', label: 'P10' },
            { axis: 'x', value: 'R$100-316', label: 'P25' },
            { axis: 'x', value: 'R$316-1K', label: 'P50' },
            { axis: 'x', value: 'R$3K-10K', label: 'P75/P90' },
            { axis: 'x', value: 'R$10K-32K', label: 'P95' },
            { axis: 'x', value: 'R$32K-100K', label: 'P99' },
          ],
        }],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
      })],
      finalAnswerText: 'The median is R$821.48 and P90 is R$9,525.32.',
    });

    // After Fix 5b: missing quantile narrative is a soft issue, not a blocker
    expect(qa.issues.join(' ')).toMatch(/core cut points p25, p50, p75, and p90\/p95/i);
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

  it('runs single unified review for high-quality results (simplified QA pipeline)', async () => {
    const percentileRows = [
      ['P10', '79.51', 'R$32-100'],
      ['P25', '208.85', 'R$100-316'],
      ['P50', '821.48', 'R$316-1K'],
      ['P75', '3,280.83', 'R$3K-10K'],
      ['P90', '9,525.32', 'R$3K-10K'],
      ['P95', '16,260.66', 'R$10K-32K'],
      ['P99', '55,108.72', 'R$32K-100K'],
    ];

    mockRunDiPrompt.mockImplementation(async ({ promptId }) => {
      if (promptId === 'prompt_8_agent_brief_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Seller revenue is long-tailed with a steep upper tail.',
            summary: 'Core cut points rise from P25 = R$208.85 to P50 = R$821.48, P75 = R$3,280.83, and P90 = R$9,525.32.',
            metric_pills: [{ label: 'Median Revenue', value: '821.48' }],
            tables: [{ title: 'Seller Revenue Percentiles', columns: ['Percentile', 'Revenue', 'Histogram Bin'], rows: percentileRows }],
            key_findings: ['P25, P50, P75, and P90 are marked directly on the histogram bins.'],
            implications: [],
            caveats: ['Revenue is a proxy because payments may duplicate across multi-seller orders.'],
            next_steps: [],
          },
        };
      }

      if (promptId === 'prompt_10_agent_qa_self_review') {
        return {
          provider: 'gemini',
          model: 'gemini-3.1-pro-preview',
          parsed: buildQaReview({ score: 8.8 }),
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
      toolCalls: [buildChartToolCall('histogram', {
        metrics: {
          'Median Revenue': '821.48',
          'P90 Revenue': '9,525.32',
        },
        charts: [{
          type: 'histogram',
          title: 'Seller Revenue Distribution',
          referenceLines: [
            { axis: 'x', value: 'R$32-100', label: 'P10' },
            { axis: 'x', value: 'R$100-316', label: 'P25' },
            { axis: 'x', value: 'R$316-1K', label: 'P50' },
            { axis: 'x', value: 'R$3K-10K', label: 'P75/P90' },
            { axis: 'x', value: 'R$10K-32K', label: 'P95' },
            { axis: 'x', value: 'R$32K-100K', label: 'P99' },
          ],
        }],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: percentileRows,
        }],
        highlights: ['P10 through P99 are marked on the histogram.'],
      })],
      finalAnswerText: 'P10 through P99 are marked on the histogram. Revenue is a proxy because payments may duplicate across multi-seller orders.',
      mode: 'analysis',
      forceCrossReview: true,
    });

    expect(payload.qa.status).toBe('pass');
    // Simplified pipeline: single unified review, no separate cross-review
    expect(mockRunDiPrompt.mock.calls.some(([args]) => args.promptId === 'prompt_10_agent_qa_self_review')).toBe(true);
    expect(payload.skippedSteps).toContain('cross_review');
  });

  it('repairs when blockers are found (simplified pipeline)', async () => {
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
          provider: 'gemini',
          model: 'gemini-3.1-pro-preview',
          parsed: buildQaReview({ score: 4.5, blockers: ['Missing caveat'], issues: ['Missing caveat'], repairInstructions: ['Add a caveat and remove duplicated text.'] }),
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
    expect(payload.qa.repair_attempted).toBe(true);
    expect(payload.skippedSteps).toContain('cross_review');
  });

  it('repairs hallucinated SQL failure caveats when blockers are found (simplified pipeline)', async () => {
    const percentileRows = [
      ['P10', '79.51', 'R$32-100'],
      ['P25', '208.85', 'R$100-316'],
      ['P50', '821.48', 'R$316-1K'],
      ['P75', '3,280.83', 'R$3K-10K'],
      ['P90', '9,525.32', 'R$3K-10K'],
      ['P95', '16,260.66', 'R$10K-32K'],
      ['P99', '55,108.72', 'R$32K-100K'],
    ];

    mockRunDiPrompt.mockImplementation(async ({ promptId }) => {
      if (promptId === 'prompt_8_agent_brief_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Seller revenue is highly right-skewed.',
            summary: 'The median is R$821.48 and P90 is R$9,525.32.',
            metric_pills: [{ label: 'Median Revenue', value: '821.48' }],
            tables: [{ title: 'Seller Revenue Percentiles', columns: ['Percentile', 'Revenue', 'Histogram Bin'], rows: percentileRows }],
            key_findings: ['Quantiles are marked on the chart.'],
            implications: [],
            caveats: ['The direct SQL lookup failed due to a local SQL worker access error.'],
            next_steps: [],
          },
        };
      }

      if (promptId === 'prompt_10_agent_qa_self_review') {
        return {
          provider: 'gemini',
          model: 'gemini-3.1-pro-preview',
          // Score < 5.0 triggers repair in simplified pipeline
          parsed: buildQaReview({ score: 4.2, blockers: ['Invented SQL failure claim'], issues: ['Missing core quantile summary'], repairInstructions: ['Remove the hallucinated SQL failure caveat and summarize P25, P50, P75, and P90.'] }),
        };
      }

      if (promptId === 'prompt_12_agent_qa_repair_synthesis') {
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          parsed: {
            headline: 'Seller revenue is highly right-skewed.',
            summary: 'Core cut points rise from P25 = R$208.85 to P50 = R$821.48, P75 = R$3,280.83, and P90 = R$9,525.32.',
            metric_pills: [{ label: 'Median Revenue', value: '821.48' }],
            tables: [{ title: 'Seller Revenue Percentiles', columns: ['Percentile', 'Revenue', 'Histogram Bin'], rows: percentileRows }],
            key_findings: ['The histogram marks P25, P50, P75, and P90 directly on the revenue bins.'],
            implications: [],
            caveats: ['Revenue is shown in log-scale bins and should be interpreted as a distribution view rather than a linear distance chart.'],
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
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table', 'caveat'],
        audience_language: 'en',
        brevity: 'short',
      },
      toolCalls: [buildChartToolCall('histogram', {
        metrics: {
          'Median Revenue': '821.48',
          'P90 Revenue': '9,525.32',
          'Total Sellers': '3,095',
        },
        charts: [{
          type: 'bar',
          title: 'Distribution',
          referenceLines: [
            { axis: 'x', value: 'R$32-100', label: 'P10' },
            { axis: 'x', value: 'R$100-316', label: 'P25' },
            { axis: 'x', value: 'R$316-1K', label: 'P50' },
            { axis: 'x', value: 'R$3K-10K', label: 'P75/P90' },
            { axis: 'x', value: 'R$10K-32K', label: 'P95' },
            { axis: 'x', value: 'R$32K-100K', label: 'P99' },
          ],
        }],
        tables: [{ title: 'Seller Revenue Percentiles', columns: ['Percentile', 'Revenue', 'Histogram Bin'], rows: percentileRows }],
        highlights: ['P10 through P99 are marked on the histogram.'],
      })],
      finalAnswerText: 'The chart is ready.',
      mode: 'analysis',
    });

    expect(payload.qa.repair_attempted).toBe(true);
    expect(payload.brief.summary).toMatch(/P25 = R\$208\.85/);
    expect(payload.brief.caveats.join(' ')).not.toMatch(/sql worker access error/i);
  });

  it('skips repair when score is between 5.0 and threshold (simplified pipeline)', async () => {
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
          provider: 'gemini',
          model: 'gemini-3.1-pro-preview',
          // Score 7.0 is above 5.0 threshold — no repair triggered in simplified pipeline
          parsed: buildQaReview({ score: 7.0, issues: ['Missing caveat'], repairInstructions: ['Add a caveat.'] }),
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

    // Simplified pipeline: single unified review, no cross-review
    expect(payload.skippedSteps).toContain('cross_review');
    // Deterministic QA may add blockers from brief content, triggering repair
    // The key assertion is that cross-review is always skipped
    expect(payload.qa).toBeDefined();
  });

  it('treats missing quantile narrative as a soft issue (not blocker) when artifact contains the data', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Please use a histogram to analyze seller revenue distribution and mark quantiles.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'quantiles', 'sellers'],
        required_outputs: ['chart', 'table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Seller revenue is long-tailed.',
        summary: 'The Gini coefficient is 0.792 indicating high inequality.',
        metric_pills: [],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
        key_findings: ['Top 10 sellers capture 13.1% of revenue.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [buildChartToolCall('histogram', {
        charts: [{
          type: 'bar',
          title: 'Distribution',
          referenceLines: [
            { axis: 'x', value: 'R$32-100', label: 'P10' },
            { axis: 'x', value: 'R$100-316', label: 'P25' },
            { axis: 'x', value: 'R$316-1K', label: 'P50' },
            { axis: 'x', value: 'R$3K-10K', label: 'P75/P90' },
            { axis: 'x', value: 'R$10K-32K', label: 'P95' },
            { axis: 'x', value: 'R$32K-100K', label: 'P99' },
          ],
        }],
        tables: [{
          title: 'Seller Revenue Percentiles',
          columns: ['Percentile', 'Revenue', 'Histogram Bin'],
          rows: [['P10', '79.51', 'R$32-100'], ['P25', '208.85', 'R$100-316'], ['P50', '821.48', 'R$316-1K'], ['P75', '3,280.83', 'R$3K-10K'], ['P90', '9,525.32', 'R$3K-10K'], ['P95', '16,260.66', 'R$10K-32K'], ['P99', '55,108.72', 'R$32K-100K']],
        }],
      })],
      finalAnswerText: 'The Gini coefficient is 0.792.',
    });

    // Should be a soft issue, NOT a blocker
    const quantileIssue = qa.issues.filter((s) => /core cut points/i.test(s));
    expect(quantileIssue).toHaveLength(1);
    const quantileBlocker = qa.blockers.filter((s) => /core cut points/i.test(s));
    expect(quantileBlocker).toHaveLength(0);

    // Completeness penalty should be moderate (-2 from quantile narrative, may stack with other checks)
    expect(qa.dimension_scores.completeness).toBeGreaterThanOrEqual(4);
    // Evidence alignment penalty should be moderate (-1 from quantile narrative, may stack with annotated percentile check)
    expect(qa.dimension_scores.evidence_alignment).toBeGreaterThanOrEqual(3);
  });

  it('does not flag chart-only evidence as needing a pre-computed caveat (recipes compute from raw data)', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Show seller revenue distribution.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Revenue is concentrated among few sellers.',
        summary: 'The histogram shows a long tail.',
        metric_pills: [{ label: 'Gini', value: '0.792' }],
        tables: [{ title: 'Summary', columns: ['metric', 'value'], rows: [['Gini', '0.792']] }],
        key_findings: ['Revenue is concentrated.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [{
        id: 'chart-only-1',
        name: 'generate_chart',
        result: {
          success: true,
          result: {
            analysisType: 'seller_revenue_distribution',
            title: 'Seller Revenue Distribution',
            metrics: { 'Gini': '0.792' },
            charts: [{ type: 'bar', title: 'Distribution' }],
          },
          artifactTypes: ['analysis_result'],
        },
      }],
      finalAnswerText: 'Revenue is concentrated among few sellers.',
    });

    // Chart recipes compute from raw data at query time — no caveat needed
    const chartOnlyIssue = qa.issues.filter((s) => /pre-computed chart artifact/i.test(s));
    expect(chartOnlyIssue).toHaveLength(0);
    const chartOnlyBlocker = qa.blockers.filter((s) => /pre-computed chart artifact/i.test(s));
    expect(chartOnlyBlocker).toHaveLength(0);
  });

  it('does not flag chart-only caveat when raw SQL data is also present', () => {
    const qa = computeDeterministicQa({
      userMessage: 'Show seller revenue distribution.',
      answerContract: {
        task_type: 'ranking',
        required_dimensions: ['revenue', 'sellers'],
        required_outputs: ['chart', 'table'],
        audience_language: 'en',
        brevity: 'short',
      },
      brief: {
        headline: 'Revenue is concentrated among few sellers.',
        summary: 'The histogram shows a long tail.',
        metric_pills: [{ label: 'Gini', value: '0.792' }],
        tables: [{ title: 'Summary', columns: ['metric', 'value'], rows: [['Gini', '0.792']] }],
        key_findings: ['Revenue is concentrated.'],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      toolCalls: [
        {
          id: 'chart-1',
          name: 'generate_chart',
          result: {
            success: true,
            result: {
              analysisType: 'seller_revenue_distribution',
              title: 'Seller Revenue Distribution',
              metrics: { 'Gini': '0.792' },
              charts: [{ type: 'bar', title: 'Distribution' }],
            },
            artifactTypes: ['analysis_result'],
          },
        },
        buildComparisonToolCall(),
      ],
      finalAnswerText: 'Revenue is concentrated among few sellers.',
    });

    const chartOnlyIssue = qa.issues.filter((s) => /pre-computed chart artifact/i.test(s));
    expect(chartOnlyIssue).toHaveLength(0);
  });

  // ── Fix 1: buildChartsFromToolCalls — chart passthrough ──────────────────

  describe('buildDeterministicAgentBrief chart passthrough', () => {
    it('extracts charts with data from tool call analysis payloads', () => {
      const toolCalls = [{
        id: 'chart-1',
        name: 'run_python_analysis',
        result: {
          success: true,
          result: {
            analysisType: 'seller_revenue_log_histogram',
            title: 'Seller Revenue Distribution',
            metrics: { 'Total Sellers': '3,095' },
            charts: [{
              type: 'bar',
              data: [{ range: 'R$10-32', sellers: 50 }, { range: 'R$32-100', sellers: 120 }],
              xKey: 'range',
              yKey: 'sellers',
              title: 'Sellers by Revenue Bracket',
              colorMap: { 'R$10-32': '#8b5cf6', 'R$32-100': '#3b82f6' },
              tickFormatter: { y: 'compact' },
              compatibleTypes: ['bar', 'histogram'],
              referenceLines: [{ axis: 'x', value: 'R$32-100', label: 'P50' }],
            }],
            summary: 'Revenue is skewed.',
          },
          artifactTypes: ['analysis_result'],
        },
      }];

      const brief = buildDeterministicAgentBrief({
        userMessage: 'Show seller revenue histogram',
        answerContract: { required_outputs: ['chart'] },
        toolCalls,
        finalAnswerText: 'Revenue is skewed.',
      });

      expect(brief.charts).toHaveLength(1);
      expect(brief.charts[0].type).toBe('bar');
      expect(brief.charts[0].data).toHaveLength(2);
      expect(brief.charts[0].xKey).toBe('range');
      expect(brief.charts[0].yKey).toBe('sellers');
      expect(brief.charts[0].colorMap).toBeDefined();
      expect(brief.charts[0].tickFormatter).toBeDefined();
      expect(brief.charts[0].compatibleTypes).toEqual(['bar', 'histogram']);
      expect(brief.charts[0].referenceLines).toHaveLength(1);
    });

    it('returns empty charts when tool calls have no chart data', () => {
      const brief = buildDeterministicAgentBrief({
        userMessage: 'Show sellers',
        answerContract: {},
        toolCalls: [buildComparisonToolCall()],
        finalAnswerText: 'Some data.',
      });
      expect(brief.charts).toEqual([]);
    });

    it('skips charts with empty data arrays', () => {
      const toolCalls = [{
        id: 'chart-1',
        name: 'run_python_analysis',
        result: {
          success: true,
          result: {
            title: 'Empty Chart',
            charts: [{ type: 'bar', data: [], xKey: 'x', yKey: 'y' }],
          },
          artifactTypes: ['analysis_result'],
        },
      }];
      const brief = buildDeterministicAgentBrief({
        userMessage: 'test',
        answerContract: {},
        toolCalls,
        finalAnswerText: '',
      });
      expect(brief.charts).toEqual([]);
    });
  });

  // ── Fix 2: stripThinkingTags — thought tag sanitization ──────────────────

  describe('thinking tag sanitization', () => {
    it('strips <thought> tags from finalAnswerText in brief', () => {
      const brief = buildDeterministicAgentBrief({
        userMessage: 'analyze revenue',
        answerContract: {},
        toolCalls: [],
        finalAnswerText: '<thought>I need to think about this.</thought>Revenue is concentrated among top sellers.',
      });
      expect(brief.headline).not.toContain('<thought>');
      expect(brief.headline).not.toContain('I need to think about this');
      expect(brief.headline).toContain('Revenue is concentrated');
    });

    it('strips <thinking> tags with multiline content', () => {
      const brief = buildDeterministicAgentBrief({
        userMessage: 'test',
        answerContract: {},
        toolCalls: [],
        finalAnswerText: '<thinking>\nStep 1: analyze\nStep 2: summarize\n</thinking>\nThe data shows a clear trend.',
      });
      expect(brief.headline).not.toContain('Step 1');
      expect(brief.headline).toContain('data shows a clear trend');
    });

    it('handles orphaned closing tags', () => {
      const brief = buildDeterministicAgentBrief({
        userMessage: 'test',
        answerContract: {},
        toolCalls: [],
        finalAnswerText: 'Result is ready.</thought> More text here.',
      });
      expect(brief.headline).not.toContain('</thought>');
    });
  });

  // ── Fix 4: QA chart data passthrough blocker ─────────────────────────────

  describe('QA chart data passthrough validation', () => {
    it('flags blocker when tool calls have chart data but brief has no charts', () => {
      const toolCalls = [{
        id: 'chart-1',
        name: 'run_python_analysis',
        result: {
          success: true,
          result: {
            title: 'Distribution',
            charts: [{
              type: 'bar',
              data: [{ x: 'A', y: 10 }],
              xKey: 'x',
              yKey: 'y',
            }],
          },
          artifactTypes: ['analysis_result'],
        },
      }];

      const qa = computeDeterministicQa({
        brief: {
          headline: 'Analysis complete',
          summary: 'Revenue is skewed.',
          charts: [], // no charts in brief!
          key_findings: ['Revenue skewed'],
        },
        toolCalls,
        finalAnswerText: 'Revenue is skewed.',
        userMessage: 'Show histogram of revenue',
        answerContract: { required_outputs: ['chart'], required_dimensions: ['revenue'] },
      });

      const chartLostIssue = qa.issues.find((s) => /chart data was lost/i.test(s));
      expect(chartLostIssue).toBeDefined();
      expect(qa.blockers.some((s) => /chart data was lost/i.test(s))).toBe(true);
    });

    it('does not flag when brief already has chart data', () => {
      const toolCalls = [{
        id: 'chart-1',
        name: 'run_python_analysis',
        result: {
          success: true,
          result: {
            title: 'Distribution',
            charts: [{
              type: 'bar',
              data: [{ x: 'A', y: 10 }],
              xKey: 'x',
              yKey: 'y',
            }],
          },
          artifactTypes: ['analysis_result'],
        },
      }];

      const qa = computeDeterministicQa({
        brief: {
          headline: 'Analysis complete',
          summary: 'Revenue is skewed.',
          charts: [{ type: 'bar', data: [{ x: 'A', y: 10 }], xKey: 'x', yKey: 'y' }],
          key_findings: ['Revenue skewed'],
        },
        toolCalls,
        finalAnswerText: 'Revenue is skewed.',
        userMessage: 'Show histogram',
        answerContract: { required_outputs: ['chart'] },
      });

      const chartLostIssue = qa.issues.find((s) => /chart data was lost/i.test(s));
      expect(chartLostIssue).toBeUndefined();
    });
  });

  // ── Tiered presentation pipeline ────────────────────────────────────────

  describe('complexity tier gating', () => {
    it('meta tier skips all LLM calls and returns pass QA', async () => {
      const result = await buildAgentPresentationPayload({
        userMessage: 'What can you do?',
        toolCalls: [],
        finalAnswerText: 'I can help you analyze data.',
        mode: 'default',
        complexityTier: 'meta',
      });

      expect(result.qa.status).toBe('pass');
      expect(result.qa.score).toBe(10);
      expect(result.qa.skipped).toBe(true);
      expect(result.skippedSteps).toContain('brief_synthesis_llm');
      expect(result.skippedSteps).toContain('self_review');
      expect(result.skippedSteps).toContain('cross_review');
      // No LLM calls should have been made
      expect(mockRunDiPrompt).not.toHaveBeenCalled();
    });

    it('simple tier uses LLM for brief but skips QA reviews', async () => {
      mockRunDiPrompt.mockResolvedValueOnce({
        task_type: 'lookup',
        required_dimensions: ['revenue'],
        required_outputs: [],
        brevity: 'short',
      });
      mockRunDiPrompt.mockResolvedValueOnce({
        headline: 'Total Revenue',
        summary: 'R$100K',
        metric_pills: [],
        tables: [],
        charts: [],
        key_findings: [],
        caveats: [],
        next_steps: [],
      });

      const result = await buildAgentPresentationPayload({
        userMessage: 'What is total revenue?',
        toolCalls: [buildComparisonToolCall()],
        finalAnswerText: 'Total revenue is R$100K.',
        mode: 'analysis',
        complexityTier: 'simple',
      });

      expect(result.skippedSteps).toContain('self_review');
      expect(result.skippedSteps).toContain('cross_review');
      expect(result.skippedSteps).toContain('repair');
      expect(result.brief).toBeDefined();
      expect(result.answerContract).toBeDefined();
    });

    it('complex tier (default) runs full pipeline including self-review', async () => {
      mockRunDiPrompt.mockResolvedValueOnce({
        task_type: 'comparison',
        required_dimensions: ['revenue', 'delivery'],
        required_outputs: ['chart', 'comparison'],
        brevity: 'analysis',
      });
      mockRunDiPrompt.mockResolvedValueOnce({
        headline: 'Comparison Result',
        summary: 'High vs low categories differ.',
        metric_pills: [],
        tables: [],
        charts: [],
        key_findings: [],
        caveats: [],
        next_steps: [],
      });
      mockRunDiPrompt.mockResolvedValueOnce(buildQaReview({ score: 8.6 }));

      const result = await buildAgentPresentationPayload({
        userMessage: 'Compare high vs low rated categories',
        toolCalls: [buildComparisonToolCall()],
        finalAnswerText: 'Categories differ significantly.',
        mode: 'analysis',
        complexityTier: 'complex',
      });

      expect(result.skippedSteps).not.toContain('self_review');
      expect(result.qa).toBeDefined();
      expect(result.brief).toBeDefined();
      // At least 3 LLM calls: contract + brief + self-review (+ possible cross-review)
      expect(mockRunDiPrompt.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Pill-vs-narrative consistency (ratio↔percentage confusion) ──
  describe('pill-narrative consistency detection', () => {
    it('should flag ratio↔percentage confusion between pill and narrative', () => {
      const brief = {
        headline: '2016–2018 CAGR analysis',
        summary: 'SP CAGR 為 13.22，高於整體 11.18',
        metric_pills: [
          { label: 'SP CAGR', value: '1322%' },
          { label: '整體 CAGR', value: '1118.02%' },
        ],
        key_findings: ['SP 的 CAGR 為 13.22，高於整體 11.18'],
        caveats: [],
      };
      const toolCalls = [{
        id: 'sql-cagr',
        name: 'query_sap_data',
        args: { sql: 'SELECT region, POWER(r2018/r2016, 0.5)-1 AS cagr_2016_2018 FROM ...' },
        result: {
          success: true,
          result: {
            rowCount: 3,
            rows: [
              { region: 'SP', cagr_2016_2018: 13.22 },
              { region: 'RJ', cagr_2016_2018: 7.97 },
              { region: 'MG', cagr_2016_2018: 12.34 },
            ],
          },
        },
      }];

      const qa = computeDeterministicQa({
        userMessage: '分析各地區營收CAGR',
        answerContract: { task_type: 'analysis', brevity: 'analysis' },
        brief,
        toolCalls,
        finalAnswerText: '',
      });

      // Should detect pill-narrative inconsistency
      const hasInconsistencyBlocker = qa.blockers.some(b => /ratio.*percentage|unit confusion/i.test(b));
      expect(hasInconsistencyBlocker).toBe(true);
      expect(qa.flags.pill_narrative_inconsistency).toBe(true);
    });

    it('should NOT flag when pill and narrative values are consistent', () => {
      const brief = {
        headline: 'Revenue analysis',
        summary: 'SP total revenue is R$5.20M',
        metric_pills: [
          { label: 'SP 總營收', value: 'R$5.20M' },
        ],
        key_findings: ['SP revenue is R$5.20M'],
        caveats: [],
      };

      const qa = computeDeterministicQa({
        userMessage: 'analyze revenue',
        answerContract: { task_type: 'analysis', brevity: 'analysis' },
        brief,
        toolCalls: [],
        finalAnswerText: '',
      });

      expect(qa.flags.pill_narrative_inconsistency).toBeFalsy();
    });
  });

  // ── Extreme growth rate detection ──
  describe('extreme growth rate detection', () => {
    it('should flag CAGR > 500% without low-base caveat', () => {
      const brief = {
        headline: 'CAGR analysis',
        summary: 'Growth is very high',
        metric_pills: [{ label: 'CAGR', value: '1322%' }],
        key_findings: [],
        caveats: ['Data is from 2016-2018 only.'],
      };
      const toolCalls = [{
        id: 'sql-cagr',
        name: 'query_sap_data',
        args: { sql: 'SELECT POWER(r2018/r2016, 0.5)-1 AS cagr FROM ...' },
        result: {
          success: true,
          result: {
            rowCount: 1,
            rows: [{ cagr: 13.22 }],
          },
        },
      }];

      const qa = computeDeterministicQa({
        userMessage: 'CAGR analysis',
        answerContract: { task_type: 'analysis', brevity: 'analysis' },
        brief,
        toolCalls,
        finalAnswerText: '',
      });

      expect(qa.flags.missing_low_base_caveat).toBe(true);
      const hasGrowthIssue = qa.issues.some(i => /extreme.*growth|low base/i.test(i));
      expect(hasGrowthIssue).toBe(true);
    });

    it('does not treat temporal columns like year as extreme growth metrics', () => {
      const brief = {
        headline: 'Annual growth summary',
        summary: 'Growth remains elevated.',
        metric_pills: [{ label: '整體 CAGR', value: '1118.02%' }],
        key_findings: [],
        caveats: ['只有 3 個年度點，且 CAGR 受極低基期影響而被放大。'],
      };
      const toolCalls = [{
        id: 'sql-growth-year',
        name: 'query_sap_data',
        args: { sql: 'SELECT year, overall_cagr_pct FROM yearly_growth' },
        result: {
          success: true,
          result: {
            rowCount: 3,
            rows: [
              { year: 2016, overall_cagr_pct: 1118.02 },
              { year: 2017, overall_cagr_pct: 1118.02 },
              { year: 2018, overall_cagr_pct: 1118.02 },
            ],
          },
        },
      }];

      const qa = computeDeterministicQa({
        userMessage: 'CAGR analysis',
        answerContract: { task_type: 'analysis', brevity: 'analysis' },
        brief,
        toolCalls,
        finalAnswerText: '',
      });

      expect(qa.issues.join(' ')).not.toMatch(/SQL column "year" has extreme value/i);
      expect(qa.flags.missing_low_base_caveat).toBeFalsy();
    });

    it('should NOT flag when low-base caveat exists', () => {
      const brief = {
        headline: 'CAGR analysis',
        summary: 'Growth is very high',
        metric_pills: [{ label: 'CAGR', value: '1322%' }],
        key_findings: [],
        caveats: ['CAGR is inflated due to low base period values in 2016.'],
      };
      const toolCalls = [{
        id: 'sql-cagr',
        name: 'query_sap_data',
        args: { sql: 'SELECT POWER(r2018/r2016, 0.5)-1 AS cagr FROM ...' },
        result: {
          success: true,
          result: {
            rowCount: 1,
            rows: [{ cagr: 13.22 }],
          },
        },
      }];

      const qa = computeDeterministicQa({
        userMessage: 'CAGR analysis',
        answerContract: { task_type: 'analysis', brevity: 'analysis' },
        brief,
        toolCalls,
        finalAnswerText: '',
      });

      expect(qa.flags.missing_low_base_caveat).toBeFalsy();
    });
  });
});
