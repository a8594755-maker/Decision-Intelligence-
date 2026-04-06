import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeChartRecipe } from './chartRecipeExecutor.js';

describe('chartRecipeExecutor', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts analysis cards from legacy nested result.artifacts backend responses', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          artifacts: [{
            type: 'analysis_result',
            label: 'Order Time Heatmap',
            data: {
              title: 'Order Volume: Weekday × Hour',
              analysisType: 'weekday_hour_heatmap',
              charts: [{ type: 'heatmap', data: [] }],
            },
          }],
        },
        execution_ms: 321,
      }),
    });

    const result = await executeChartRecipe({ recipe_id: 'weekday_hour_heatmap' });

    expect(result.success).toBe(true);
    expect(result.toolId).toBe('generate_chart');
    expect(result._analysisCards).toHaveLength(1);
    expect(result._analysisCards[0].title).toBe('Order Volume: Weekday × Hour');
    expect(result.result.analysisType).toBe('weekday_hour_heatmap');
    expect(result.result._executionMeta.execution_ms).toBe(321);
  });

  it('still supports canonical top-level artifacts backend responses', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        artifacts: [{
          type: 'analysis_result',
          label: 'Revenue Trend',
          data: {
            title: 'Monthly Revenue & Order Trend',
            analysisType: 'monthly_revenue_order_trend',
            charts: [{ type: 'line', data: [] }],
          },
        }],
        execution_ms: 123,
      }),
    });

    const result = await executeChartRecipe({ recipe_id: 'monthly_revenue_order_trend' });

    expect(result.success).toBe(true);
    expect(result._analysisCards).toHaveLength(1);
    expect(result.result.title).toBe('Monthly Revenue & Order Trend');
  });
});
