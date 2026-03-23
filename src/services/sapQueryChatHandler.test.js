import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvokeAiProxy = vi.fn();
const mockExecuteQuery = vi.fn();
const mockProbeTables = vi.fn();

vi.mock('./aiProxyService.js', () => ({
  invokeAiProxy: (...args) => mockInvokeAiProxy(...args),
}));

vi.mock('./sapDataQueryService.js', () => ({
  SAP_DATASET_INFO: {
    olist: {
      key: 'olist',
      label: 'Dataset A: Olist E-Commerce',
      scope: 'builtin_csv',
    },
    di_ops: {
      key: 'di_ops',
      label: 'Dataset B: DI Operations',
      scope: 'current_user_scoped',
    },
  },
  SAP_TABLE_REGISTRY: {
    orders: {
      source: 'csv',
      sapEquivalent: 'VBAK',
      description: 'orders',
      columns: ['order_id', 'order_status'],
    },
    inventory_snapshots: {
      source: 'supabase',
      sapEquivalent: 'MARD',
      description: 'inventory',
      columns: ['material_code', 'plant_id', 'onhand_qty'],
    },
  },
  executeQuery: (...args) => mockExecuteQuery(...args),
  probeTables: (...args) => mockProbeTables(...args),
}));

vi.mock('./chartSpecInference.js', () => ({
  inferChartSpec: vi.fn(() => ({ type: 'bar', xKey: 'status', yKey: 'cnt' })),
  getCompatibleTypes: vi.fn(() => ['bar', 'horizontal_bar']),
}));

const { handleDataQuery } = await import('./sapQueryChatHandler.js');

describe('sapQueryChatHandler', () => {
  beforeEach(() => {
    mockInvokeAiProxy.mockReset();
    mockExecuteQuery.mockReset();
    mockProbeTables.mockReset();
  });

  it('returns SQL results with query plan metadata when candidate tables are available', async () => {
    mockProbeTables.mockResolvedValue({
      success: true,
      tables: [{
        table_name: 'orders',
        row_count: 99441,
        is_empty: false,
        dataset_label: 'Dataset A: Olist E-Commerce',
        dataset_scope: 'builtin_csv',
      }],
    });
    mockInvokeAiProxy.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT order_status AS status, COUNT(*) AS cnt FROM orders GROUP BY order_status',
        chart: { type: 'bar', xKey: 'status', yKey: 'cnt' },
      }),
    });
    mockExecuteQuery.mockResolvedValue({
      success: true,
      rows: [{ status: 'delivered', cnt: 10 }],
      rowCount: 1,
      truncated: false,
      meta: {
        tables_queried: ['orders'],
        dataset_label: 'Dataset A: Olist E-Commerce',
        dataset_scope: 'builtin_csv',
      },
    });

    const result = await handleDataQuery('show order count by status');

    expect(mockProbeTables).toHaveBeenCalledWith(['orders']);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(result.sql).toContain('FROM orders');
    expect(result.result.success).toBe(true);
    expect(result.meta.datasetScope).toBe('builtin_csv');
    expect(result.meta.tablesChecked).toHaveLength(1);
    expect(result.charts).toHaveLength(1);
  });

  it('retries once in the same dataset after a 0-row result', async () => {
    mockProbeTables.mockResolvedValue({
      success: true,
      tables: [{
        table_name: 'inventory_snapshots',
        row_count: 32,
        is_empty: false,
        dataset_label: 'Dataset B: DI Operations',
        dataset_scope: 'current_user_scoped',
      }],
    });
    mockInvokeAiProxy
      .mockResolvedValueOnce({
        text: JSON.stringify({
          sql: 'SELECT plant_id, SUM(onhand_qty) AS qty FROM inventory_snapshots WHERE plant_id = \'PLT-Z\' GROUP BY plant_id',
          chart: null,
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          sql: 'SELECT plant_id, SUM(onhand_qty) AS qty FROM inventory_snapshots GROUP BY plant_id',
          chart: null,
        }),
      });
    mockExecuteQuery
      .mockResolvedValueOnce({
        success: true,
        rows: [],
        rowCount: 0,
        truncated: false,
        meta: {
          tables_queried: ['inventory_snapshots'],
          dataset_label: 'Dataset B: DI Operations',
          dataset_scope: 'current_user_scoped',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        rows: [{ plant_id: 'PLT-A', qty: 120 }],
        rowCount: 1,
        truncated: false,
        meta: {
          tables_queried: ['inventory_snapshots'],
          dataset_label: 'Dataset B: DI Operations',
          dataset_scope: 'current_user_scoped',
        },
      });

    const result = await handleDataQuery('show inventory by plant');

    expect(mockInvokeAiProxy).toHaveBeenCalledTimes(2);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    expect(result.result.rowCount).toBe(1);
    expect(result.meta.retryCount).toBe(1);
    expect(result.meta.datasetScope).toBe('current_user_scoped');
    expect(result.meta.sqlAttempts).toHaveLength(2);
  });

  it('returns an explicit empty-dataset result when probed tables are empty', async () => {
    mockProbeTables.mockResolvedValue({
      success: true,
      tables: [{
        table_name: 'inventory_snapshots',
        row_count: 0,
        is_empty: true,
        dataset_label: 'Dataset B: DI Operations',
        dataset_scope: 'current_user_scoped',
      }],
    });

    const result = await handleDataQuery('show inventory by plant');

    expect(mockInvokeAiProxy).not.toHaveBeenCalled();
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.result.success).toBe(true);
    expect(result.result.rowCount).toBe(0);
    expect(result.meta.emptyReason).toBe('dataset_tables_empty');
    expect(result.summary).toContain('no queryable data');
  });
});
