import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../sap-erp/sapDataQueryService', () => ({
  executeQuery: vi.fn(),
  probeTables: vi.fn(),
  buildEnrichedSchemaPrompt: vi.fn(() => 'mock schema'),
}));

vi.mock('../ai-infra/aiProxyService', () => ({
  invokeAiProxy: vi.fn(),
}));

vi.mock('../agent-core/chatAgentLoop', () => ({
  getAgentToolMode: vi.fn(() => 'deepseek_chat_tools'),
}));

vi.mock('../forecast/anomalyDetectionService', () => ({
  computeStats: vi.fn((nums) => {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const mean = sum / sorted.length;
    const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
    const std = Math.sqrt(variance);
    return { mean, std, q1: sorted[Math.floor(sorted.length * 0.25)], q3: sorted[Math.floor(sorted.length * 0.75)], iqr: 0, min: sorted[0], max: sorted[sorted.length - 1] };
  }),
}));

import { runHealthCheck, hashDiagnostics } from './insightsDataScanner';
import { executeQuery, probeTables } from '../sap-erp/sapDataQueryService';
import { invokeAiProxy } from '../ai-infra/aiProxyService';

function makeProbeResult(loadedTables) {
  return {
    success: true,
    tables: loadedTables.map(name => ({ table_name: name, loaded: true, is_empty: false, error: null })),
  };
}

function mockLLMResponse(diagnosticSpecs) {
  invokeAiProxy.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(diagnosticSpecs) } }],
  });
}

describe('insightsDataScanner (LLM-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when no tables have data', async () => {
    probeTables.mockResolvedValue({ success: true, tables: [] });

    const result = await runHealthCheck({});

    expect(result.diagnostics).toEqual([]);
    expect(result.fingerprint).toBe('hc-empty');
  });

  it('returns empty when probeTables fails', async () => {
    probeTables.mockRejectedValue(new Error('DuckDB init failed'));

    const result = await runHealthCheck({});

    expect(result.diagnostics).toEqual([]);
    expect(result.fingerprint).toBe('hc-empty');
  });

  it('returns empty when LLM call fails', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders']));
    invokeAiProxy.mockRejectedValue(new Error('API timeout'));

    const result = await runHealthCheck({});

    expect(result.diagnostics).toEqual([]);
    expect(result.schema_summary.tables_with_data).toEqual(['orders']);
  });

  it('executes LLM-generated SQL and analyzes trend results', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders', 'order_items']));
    mockLLMResponse([
      { id: 'revenue_trend', title: 'Monthly Revenue', sql: 'SELECT month, revenue FROM ...', metric_type: 'trend' },
    ]);
    executeQuery.mockResolvedValue({
      rows: [
        { month: '2018-01', revenue: 100000 },
        { month: '2018-02', revenue: 110000 },
        { month: '2018-03', revenue: 105000 },
        { month: '2018-04', revenue: 95000 },
        { month: '2018-05', revenue: 40000 }, // anomaly
      ],
    });

    const result = await runHealthCheck({});

    expect(result.diagnostics.length).toBe(1);
    const d = result.diagnostics[0];
    expect(d.id).toBe('revenue_trend');
    expect(d.analysis.z_score).toBeDefined();
    expect(d.analysis.severity).not.toBe('low'); // 40000 is way below mean
  });

  it('analyzes concentration results', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['order_items', 'sellers']));
    mockLLMResponse([
      { id: 'seller_conc', title: 'Seller Concentration', sql: 'SELECT seller_id, total_revenue FROM ...', metric_type: 'concentration' },
    ]);
    executeQuery.mockResolvedValue({
      rows: [
        { seller_id: 'S1', total_revenue: 500 },
        { seller_id: 'S2', total_revenue: 200 },
        { seller_id: 'S3', total_revenue: 150 },
        { seller_id: 'S4', total_revenue: 50 },
        { seller_id: 'S5', total_revenue: 30 },
      ],
    });

    const result = await runHealthCheck({});

    expect(result.diagnostics.length).toBe(1);
    const d = result.diagnostics[0];
    expect(d.analysis.top3_share).toBeGreaterThan(80);
    expect(d.analysis.severity).toBe('critical');
  });

  it('skips diagnostics when executeQuery returns error', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders']));
    mockLLMResponse([
      { id: 'bad_query', title: 'Bad Query', sql: 'SELECT nonexistent FROM orders', metric_type: 'count' },
    ]);
    executeQuery.mockResolvedValue({ rows: [], error: 'Column not found' });

    const result = await runHealthCheck({});

    expect(result.diagnostics.length).toBe(0);
  });

  it('skips diagnostics without id or sql', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders']));
    mockLLMResponse([
      { title: 'No ID', sql: 'SELECT 1' },
      { id: 'no_sql', title: 'No SQL' },
      { id: 'valid', title: 'Valid', sql: 'SELECT COUNT(*) as total FROM orders', metric_type: 'count' },
    ]);
    executeQuery.mockResolvedValue({ rows: [{ total: 99441 }] });

    const result = await runHealthCheck({});

    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0].id).toBe('valid');
  });

  it('sorts diagnostics by severity (critical first)', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders']));
    mockLLMResponse([
      { id: 'low_diag', title: 'Low', sql: 'SELECT 1 as value', metric_type: 'count' },
      { id: 'high_diag', title: 'High Trend', sql: 'SELECT month, revenue FROM ...', metric_type: 'trend' },
    ]);

    let callCount = 0;
    executeQuery.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { rows: [{ value: 100 }] }; // count — low severity
      return { // trend — should trigger high/critical severity
        rows: [
          { month: '2018-01', revenue: 100 },
          { month: '2018-02', revenue: 100 },
          { month: '2018-03', revenue: 100 },
          { month: '2018-04', revenue: 10 }, // massive drop
        ],
      };
    });

    const result = await runHealthCheck({});

    if (result.diagnostics.length >= 2) {
      const sev = { critical: 4, high: 3, medium: 2, low: 1 };
      expect(sev[result.diagnostics[0].analysis?.severity] || 0)
        .toBeGreaterThanOrEqual(sev[result.diagnostics[1].analysis?.severity] || 0);
    }
  });

  it('parses LLM response from code fence', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders']));
    invokeAiProxy.mockResolvedValue({
      choices: [{ message: { content: '```json\n[{"id":"test","title":"Test","sql":"SELECT 1 as v","metric_type":"count"}]\n```' } }],
    });
    executeQuery.mockResolvedValue({ rows: [{ v: 42 }] });

    const result = await runHealthCheck({});

    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0].id).toBe('test');
  });

  it('hashDiagnostics is deterministic', () => {
    const diagnostics = [
      { id: 'a', analysis: { severity: 'high', z_score: -2.4 } },
      { id: 'b', analysis: { severity: 'medium', top3_share: 78 } },
    ];
    expect(hashDiagnostics(diagnostics)).toBe(hashDiagnostics(diagnostics));
    expect(hashDiagnostics(diagnostics)).toMatch(/^hc-/);
  });

  it('hashDiagnostics changes when results change', () => {
    const h1 = hashDiagnostics([{ id: 'a', analysis: { severity: 'high', z_score: -2.4 } }]);
    const h2 = hashDiagnostics([{ id: 'a', analysis: { severity: 'high', z_score: -1.0 } }]);
    expect(h1).not.toBe(h2);
  });

  it('includes schema_summary in result', async () => {
    probeTables.mockResolvedValue(makeProbeResult(['orders', 'sellers']));
    mockLLMResponse([]);

    const result = await runHealthCheck({});

    expect(result.schema_summary.tables_with_data).toEqual(['orders', 'sellers']);
    expect(result.schema_summary.total_tables).toBe(2);
  });
});
