import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeTool } from './chatToolAdapter.js';

describe('chatToolAdapter python analysis context', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends uploaded sheets and dataset profile metadata to run_python_analysis', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        artifacts: [{
          type: 'analysis_result',
          label: 'Seller Analysis',
          data: {
            analysisType: 'seller',
            title: 'Seller Performance',
            metrics: {},
          },
        }],
        code: 'print("ok")',
        execution_ms: 120,
        llm_model: 'test-model',
      }),
    });

    const result = await executeTool('run_python_analysis', { tool_hint: 'Analyze seller performance' }, {
      datasetInputData: {
        sheets: {
          Sheet1: [{ seller_id: 's1', revenue: 100 }],
        },
        totalRows: 1,
      },
      datasetProfileId: 42,
      datasetProfileRow: {
        id: 42,
        user_file_id: 'file-1',
        profile_json: {
          sheets: [{ name: 'Sheet1', rowCount: 1, columnCount: 2 }],
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.result.title).toBe('Seller Performance');
    expect(result.result._executionMeta.code).toBe('print("ok")');

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.analysis_mode).toBe(true);
    expect(body.input_data.sheets.Sheet1).toEqual([{ seller_id: 's1', revenue: 100 }]);
    expect(body.dataset).toBeUndefined();
    expect(body.dataset_profile.id).toBe(42);
    expect(body.dataset_profile.sheets).toHaveLength(1);
  });

  it('defaults to Olist dataset when no uploaded sheets are available', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        artifacts: [{
          type: 'analysis_result',
          label: 'Revenue Analysis',
          data: {
            analysisType: 'revenue',
            title: 'Revenue Overview',
            metrics: {},
          },
        }],
      }),
    });

    await executeTool('run_python_analysis', { tool_hint: 'Analyze revenue concentration' }, {});

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.dataset).toBe('olist');
    expect(body.input_data).toEqual({});
  });
});
