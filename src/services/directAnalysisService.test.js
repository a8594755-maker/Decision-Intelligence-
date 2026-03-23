import { describe, expect, it } from 'vitest';

import {
  buildDirectAnalysisAgentPrompt,
  resolveDirectAnalysisRequest,
} from './directAnalysisService.js';

describe('directAnalysisService', () => {
  it('routes analysis prompts to python analysis engine', () => {
    expect(resolveDirectAnalysisRequest('賣家績效', { hasUploadedData: false })).toEqual({
      type: 'python',
      toolId: 'run_python_analysis',
    });
    expect(resolveDirectAnalysisRequest('seller performance', { hasUploadedData: false })).toEqual({
      type: 'python',
      toolId: 'run_python_analysis',
    });
  });

  it('routes uploaded-dataset analysis prompts to python analysis', () => {
    expect(resolveDirectAnalysisRequest('賣家績效', { hasUploadedData: true })).toEqual({
      type: 'python',
      toolId: 'run_python_analysis',
    });
    expect(resolveDirectAnalysisRequest('gini correlation concentration analysis', { hasUploadedData: false })).toEqual({
      type: 'python',
      toolId: 'run_python_analysis',
    });
  });

  it('routes chart/visualization queries to analysis mode', () => {
    const cases = [
      '星期 × 小時的訂單量熱力圖',
      '顯示營收折線圖',
      '各品類的圓餅圖',
      'show me a heatmap of orders',
      'plot the revenue trend',
      'bar chart of category sales',
      'Top 10 品類營收排行',
    ];
    for (const q of cases) {
      const result = resolveDirectAnalysisRequest(q, { hasUploadedData: false });
      expect(result, `expected "${q}" to route to analysis`).toEqual({
        type: 'python',
        toolId: 'run_python_analysis',
      });
    }
  });

  it('does not hijack planning or forecasting requests', () => {
    expect(resolveDirectAnalysisRequest('run forecast for next month', { hasUploadedData: false })).toBeNull();
    expect(resolveDirectAnalysisRequest('幫我做補貨計畫', { hasUploadedData: false })).toBeNull();
  });

  it('builds a focused agent prompt for direct analysis', () => {
    const prompt = buildDirectAnalysisAgentPrompt('seller performance');
    expect(prompt).toContain('Tool Selection Rules');
    expect(prompt).toContain('seller performance');
  });
});
