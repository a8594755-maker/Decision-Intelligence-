import { describe, expect, it } from 'vitest';

import { getToolDefinitions } from './chatToolAdapter.js';
import {
  ANALYSIS_AGENT_TOOL_IDS,
  getAgentToolConfig,
  getAgentToolStreamingMode,
  getUnmetCoreDimensions,
  getUnmetStructuredOutputs,
  shouldStopAfterStructuredCoverage,
} from './chatAgentLoop.js';

function getToolNames(opts) {
  return getToolDefinitions({ ...opts, includeRegistered: false }).map((tool) => tool.function.name);
}

describe('chatAgentLoop tool exposure', () => {
  it('includes run_python_analysis in analysis mode and keeps the tool set narrow', () => {
    const names = getToolNames(getAgentToolConfig('analysis'));

    expect(names).toContain('run_python_analysis');
    expect(names).toContain('query_sap_data');
    expect(names).not.toContain('run_forecast');
    expect(ANALYSIS_AGENT_TOOL_IDS).toContain('run_python_analysis');
  });

  it('keeps Python analysis tools out of the default agent tool set', () => {
    const names = getToolNames({ ...getAgentToolConfig('default') });

    expect(names).not.toContain('run_python_analysis');
    expect(names).toContain('query_sap_data');
  });
});

describe('chatAgentLoop streaming mode routing', () => {
  it('routes OpenAI, Anthropic, and Gemini providers to streaming tool modes', () => {
    expect(getAgentToolStreamingMode('openai')).toBe('openai_chat_tools_stream');
    expect(getAgentToolStreamingMode('anthropic')).toBe('anthropic_chat_tools_stream');
    expect(getAgentToolStreamingMode('gemini')).toBe('gemini_chat_tools_stream');
    expect(getAgentToolStreamingMode('deepseek')).toBe('deepseek_chat_tools_stream');
  });
});

describe('chatAgentLoop analysis recovery helpers', () => {
  it('detects unmet quantile dimensions when SQL fails and only histogram evidence exists', () => {
    const unmet = getUnmetCoreDimensions({
      required_dimensions: ['revenue', 'quantiles', 'sellers'],
    }, [
      {
        name: 'generate_chart',
        result: {
          success: true,
          result: {
            metrics: { 'Median Revenue': '821' },
            charts: [{ type: 'bar', title: 'Distribution' }],
          },
        },
      },
      {
        name: 'query_sap_data',
        result: {
          success: false,
          error: 'Failed to fetch',
        },
      },
    ]);

    expect(unmet).toContain('quantiles');
    expect(unmet).not.toContain('revenue');
  });

  it('stops after structured chart evidence already covers histogram quantiles', () => {
    const answerContract = {
      required_dimensions: ['revenue', 'quantiles', 'sellers'],
      required_outputs: ['chart', 'table'],
    };
    const toolCalls = [
      {
        name: 'generate_chart',
        result: {
          success: true,
          result: {
            analysisType: 'seller_revenue_distribution',
            title: 'Seller Revenue Distribution',
            metrics: {
              'Median Revenue': '821.48',
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
            tables: [{
              title: 'Seller Revenue Percentiles',
              columns: ['Percentile', 'Revenue', 'Histogram Bin'],
              rows: [
                ['P10', '79.51', 'R$32-100'],
                ['P25', '208.85', 'R$100-316'],
                ['P50', '821.48', 'R$316-1K'],
                ['P75', '3,280.83', 'R$3K-10K'],
                ['P90', '9,525.32', 'R$3K-10K'],
                ['P95', '16,260.66', 'R$10K-32K'],
                ['P99', '55,108.72', 'R$32K-100K'],
              ],
            }],
          },
        },
      },
    ];

    expect(getUnmetCoreDimensions(answerContract, toolCalls, 'Please use a histogram to analyze seller revenue distribution and mark quantiles.')).toEqual([]);
    expect(getUnmetStructuredOutputs(answerContract, toolCalls, 'Please use a histogram to analyze seller revenue distribution and mark quantiles.')).toEqual([]);
    expect(shouldStopAfterStructuredCoverage(answerContract, toolCalls, 'Please use a histogram to analyze seller revenue distribution and mark quantiles.')).toBe(true);
  });

  it('treats successful 0-row SQL lookups as no added evidence, not coverage', () => {
    const answerContract = {
      required_dimensions: ['revenue', 'quantiles', 'sellers'],
      required_outputs: ['chart', 'table'],
    };
    const toolCalls = [
      {
        name: 'generate_chart',
        result: {
          success: true,
          result: {
            analysisType: 'seller_revenue_distribution',
            title: 'Seller Revenue Distribution',
            metrics: { 'Median Revenue': '821.48' },
            charts: [{ type: 'bar', title: 'Distribution' }],
          },
        },
      },
      {
        name: 'query_sap_data',
        result: {
          success: true,
          result: {
            rowCount: 0,
            rows: [],
          },
        },
      },
    ];

    expect(getUnmetCoreDimensions(answerContract, toolCalls, 'Please use a histogram to analyze seller revenue distribution and mark quantiles.')).toContain('quantiles');
    expect(getUnmetStructuredOutputs(answerContract, toolCalls, 'Please use a histogram to analyze seller revenue distribution and mark quantiles.')).toContain('table');
    expect(shouldStopAfterStructuredCoverage(answerContract, toolCalls, 'Please use a histogram to analyze seller revenue distribution and mark quantiles.')).toBe(false);
  });
});
