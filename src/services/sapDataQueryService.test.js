/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockRegisterFileText = vi.fn();
const mockSupabaseFrom = vi.fn();

vi.mock('@duckdb/duckdb-wasm', () => ({
  getJsDelivrBundles: vi.fn(() => ({})),
  selectBundle: vi.fn(async () => ({
    mainWorker: 'worker.js',
    mainModule: 'main.wasm',
    pthreadWorker: 'pthread.js',
  })),
  ConsoleLogger: class {},
  AsyncDuckDB: class {
    async instantiate() {}
    async connect() {
      return { query: (...args) => mockQuery(...args) };
    }
    async registerFileText(...args) {
      return mockRegisterFileText(...args);
    }
  },
}));

vi.mock('./supabaseClient.js', () => ({
  supabase: {
    from: (...args) => mockSupabaseFrom(...args),
  },
}));

const { probeTables } = await import('./sapDataQueryService.js');

describe('sapDataQueryService probeTables', () => {
  beforeAll(() => {
    globalThis.Worker = class {};
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockRegisterFileText.mockReset();
    mockSupabaseFrom.mockReset();

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => 'customer_id,customer_city\n1,Sao Paulo\n',
    }));

    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT COUNT(*)::INTEGER as cnt FROM customers')) {
        return { toArray: () => [{ cnt: 99442 }] };
      }
      return { toArray: () => [] };
    });

    mockSupabaseFrom.mockImplementation((tableName) => ({
      select: () => ({
        limit: async () => ({
          data: tableName === 'suppliers' ? [] : [{ id: 1 }],
          error: null,
        }),
      }),
    }));
  });

  it('distinguishes built-in Olist tables from empty current-user operational tables', async () => {
    const result = await probeTables(['customers', 'suppliers']);

    const customers = result.tables.find((table) => table.table_name === 'customers');
    const suppliers = result.tables.find((table) => table.table_name === 'suppliers');

    expect(customers.dataset_label).toBe('Dataset A: Olist E-Commerce');
    expect(customers.dataset_scope).toBe('builtin_csv');
    expect(customers.row_count).toBe(99442);
    expect(customers.is_empty).toBe(false);

    expect(suppliers.dataset_label).toBe('Dataset B: DI Operations');
    expect(suppliers.dataset_scope).toBe('current_user_scoped');
    expect(suppliers.row_count).toBe(0);
    expect(suppliers.is_empty).toBe(true);
  });
});
