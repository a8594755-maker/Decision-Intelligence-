/**
 * E2E: Import → Inference → Planning → Lineage Verification
 *
 * Tests the complete pipeline from messy Excel headers through
 * pattern inference, mapping, import, planning, and verifies
 * that row-level lineage metadata (_meta) is attached to plan rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external services BEFORE importing modules under test ────────────

vi.mock('../../services/infra/supabaseClient', () => ({
  userFilesService: {
    getFileById: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ id: 'file-saved-1' }),
  },
}));

vi.mock('../../services/planning/diRunsService', () => ({
  diRunsService: {
    createRun: vi.fn().mockResolvedValue({ id: 'run-e2e-itp-1', status: 'created' }),
    updateRunStatus: vi.fn().mockResolvedValue({ id: 'run-e2e-itp-1', status: 'succeeded' }),
    getRunById: vi.fn().mockResolvedValue(null),
    getLatestRunByStage: vi.fn().mockResolvedValue({
      id: 'forecast-run-1', stage: 'forecast', status: 'succeeded',
    }),
    getArtifactsForRun: vi.fn().mockResolvedValue([
      {
        artifact_type: 'forecast_series',
        artifact_json: {
          groups: [
            {
              material_code: 'SKU-001', plant_id: 'PLANT-A',
              points: [
                { time_bucket: '2025-02-01', p50: 120, is_forecast: true },
                { time_bucket: '2025-02-08', p50: 90, is_forecast: true },
              ],
            },
          ],
        },
      },
    ]),
    saveArtifact: vi.fn().mockImplementation(({ artifact_type, artifact_json }) =>
      Promise.resolve({ id: `art-${Date.now()}`, artifact_type, artifact_json })
    ),
  },
}));

vi.mock('../../services/memory/reuseMemoryService', () => ({
  reuseMemoryService: { upsertRunSettingsTemplate: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../services/planning/optimizationApiClient', () => ({
  default: { createReplenishmentPlan: vi.fn() },
}));

vi.mock('../../utils/constraintChecker', () => ({
  constraintChecker: vi.fn().mockReturnValue({
    passed: true, all_passed: true, violated_constraints: [], violations: [],
  }),
}));

vi.mock('../../utils/replaySimulator', () => ({
  replaySimulator: vi.fn().mockReturnValue({
    initial_inventory: [], final_inventory: [],
    total_stockouts: 0, total_holding: 10, daily_projection: [],
    total_orders: 1, total_order_qty: 200, stockout_events: [],
    inventory_projection: [],
    metrics: { service_level_proxy: 0.92, stockout_units: 10, holding_units: 80, total_cost: 2500 },
  }),
}));

vi.mock('../../utils/artifactStore', () => ({
  saveJsonArtifact: vi.fn().mockImplementation((_runId, type, payload) =>
    Promise.resolve({
      artifact: { id: `art-${type}`, artifact_type: type, artifact_json: payload },
      ref: { storage: 'inline', artifact_type: type, size_bytes: 100 },
    })
  ),
  saveCsvArtifact: vi.fn().mockImplementation((_runId, type) =>
    Promise.resolve({
      artifact: { id: `csv-${type}`, artifact_type: type },
      ref: { storage: 'inline', artifact_type: type, size_bytes: 50 },
    })
  ),
}));

vi.mock('../../services/planning/diModelRouterService', () => ({
  DI_PROMPT_IDS: { WORKFLOW_A_READINESS: 'readiness', WORKFLOW_A_REPORT: 'report' },
  runDiPrompt: vi.fn().mockResolvedValue({
    parsed: { minimal_questions: [], summary: 'Test report' },
    provider: 'mock', model: 'mock',
  }),
}));

vi.mock('../../utils/buildDecisionNarrative', () => ({
  buildDecisionNarrativeFromPlanResult: vi.fn().mockReturnValue({
    summary_text: 'Narrative.', sections: [],
  }),
}));

vi.mock('../../services/planning/planAuditService', () => ({
  recordPlanGenerated: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/planning/multiEchelonBomService', () => ({
  MULTI_ECHELON_MODES: { OFF: 'off', AUTO: 'auto', FORCE: 'force' },
  resolveMultiEchelonConfig: vi.fn().mockReturnValue({ mode: 'off', max_bom_depth: 1 }),
  normalizeSkuKey: vi.fn((s) => s),
  explodeBomForRun: vi.fn().mockResolvedValue({
    componentDemand: [], explosion_rows: [], artifact: null, mode: 'off', max_bom_depth: 1,
  }),
}));

// ── Now import modules under test ─────────────────────────────────────────

import { runPlanFromDatasetProfile } from '../../services/planning/chatPlanningService';
import { userFilesService } from '../../services/infra/supabaseClient';
import optimizationApiClient from '../../services/planning/optimizationApiClient';
import { saveJsonArtifact } from '../../utils/artifactStore';

// Pure function imports for inference chain
import { normalizeHeader } from '../../utils/headerNormalize';
import { ruleBasedMapping } from '../../utils/aiMappingHelper';

// ── Test data: messy headers simulating real-world Excel ──────────────────

const messyRawRows = [
  { __sheet_name: 'Stock', '\uFEFF SKU Code ': 'SKU-001', 'Plant\u00A0ID': 'PLANT-A', ' On Hand Qty': '500', 'Snap Date': '2025-01-15', 'Safety\u00A0Stock': '50', 'Lead Time\u00A0Days': '7' },
  { __sheet_name: 'Stock', '\uFEFF SKU Code ': 'SKU-002', 'Plant\u00A0ID': 'PLANT-A', ' On Hand Qty': '200', 'Snap Date': '2025-01-15' },
  { __sheet_name: 'Stock', '\uFEFF SKU Code ': 'SKU-003', 'Plant\u00A0ID': 'PLANT-B', ' On Hand Qty': '0', 'Snap Date': '2025-01-15', 'Safety\u00A0Stock': '30', 'Lead Time\u00A0Days': '14' },
];

const mockProfileRow = {
  id: 'profile-itp-1',
  user_file_id: 'file-itp-1',
  fingerprint: 'fp-itp-1',
  contract_json: {
    datasets: [{
      upload_type: 'inventory_snapshots',
      sheet_name: 'Stock',
      mapping: {
        '\uFEFF SKU Code ': 'material_code',
        'Plant\u00A0ID': 'plant_id',
        ' On Hand Qty': 'onhand_qty',
        'Snap Date': 'snapshot_date',
        'Safety\u00A0Stock': 'safety_stock',
        'Lead Time\u00A0Days': 'lead_time_days',
      },
      validation: { status: 'pass' },
    }],
  },
  profile_json: { global: { workflow_guess: { label: 'A' } } },
};

const mockSolverResult = {
  status: 'feasible',
  plan: [
    { sku: 'SKU-001', plant_id: 'PLANT-A', order_date: '2025-02-01', arrival_date: '2025-02-08', order_qty: 100 },
    { sku: 'SKU-002', plant_id: 'PLANT-A', order_date: '2025-02-01', arrival_date: '2025-02-08', order_qty: 200 },
    { sku: 'SKU-003', plant_id: 'PLANT-B', order_date: '2025-02-01', arrival_date: '2025-02-15', order_qty: 300 },
  ],
  kpis: { estimated_service_level: 0.92, estimated_stockout_units: 10, estimated_holding_units: 80, estimated_total_cost: 2500 },
  solver_meta: { solver: 'heuristic', solve_time_ms: 55, objective_value: 2500, gap: 0, multi_echelon_mode: 'off' },
  infeasible_reasons: [],
  proof: { objective_terms: [{ name: 'total_cost', value: 2500 }], constraints_checked: [] },
  component_plan: [],
  component_inventory_projection: { total_rows: 0, rows: [], truncated: false },
  bottlenecks: { generated_at: '2025-01-01', total_rows: 0, rows: [] },
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Import → Planning E2E (Messy Headers → Lineage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFilesService.getFileById.mockResolvedValue({
      id: 'file-itp-1', filename: 'messy_stock.xlsx', data: messyRawRows,
    });
    optimizationApiClient.createReplenishmentPlan.mockResolvedValue(mockSolverResult);
  });

  it('normalizes BOM and NBSP characters in headers consistently', () => {
    const h1 = normalizeHeader('\uFEFF SKU Code ');
    const h2 = normalizeHeader('SKU Code');
    expect(h1).toBe(h2);

    const h3 = normalizeHeader('Plant\u00A0ID');
    const h4 = normalizeHeader('Plant ID');
    expect(h3).toBe(h4);
  });

  it('ruleBasedMapping handles messy headers with sample rows', () => {
    const headers = ['\uFEFF SKU Code ', 'Plant\u00A0ID', ' On Hand Qty', 'Snap Date', 'Safety\u00A0Stock', 'Lead Time\u00A0Days'];
    const sampleRows = messyRawRows.slice(0, 2);
    const mappings = ruleBasedMapping(headers, 'inventory_snapshots', undefined, sampleRows);

    expect(mappings).toBeDefined();
    expect(Array.isArray(mappings)).toBe(true);
    // Should produce some mappings (exact targets depend on synonym config)
    const mapped = mappings.filter(m => m.target);
    expect(mapped.length).toBeGreaterThan(0);
  });

  it('runs full pipeline and produces plan_table with lineage_summary', async () => {
    const result = await runPlanFromDatasetProfile({
      userId: 'user-itp-1',
      datasetProfileRow: mockProfileRow,
      settings: {},
    });

    expect(result.run.status).toBe('succeeded');

    // Find plan_table artifact
    const ptCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'plan_table');
    expect(ptCall).toBeDefined();
    const planTable = ptCall[2];

    expect(planTable.total_rows).toBeGreaterThan(0);
    expect(planTable.rows).toBeDefined();
    expect(Array.isArray(planTable.rows)).toBe(true);

    // Verify lineage_summary is attached
    expect(planTable.lineage_summary).toBeDefined();
    expect(typeof planTable.lineage_summary.rows_with_fallback).toBe('number');
    expect(typeof planTable.lineage_summary.rows_with_full_data).toBe('number');
    expect(Array.isArray(planTable.lineage_summary.datasets_used)).toBe(true);
    expect(Array.isArray(planTable.lineage_summary.datasets_missing)).toBe(true);
  });

  it('attaches _meta to plan rows with fallback tracking', async () => {
    const result = await runPlanFromDatasetProfile({
      userId: 'user-itp-1',
      datasetProfileRow: mockProfileRow,
      settings: {},
    });

    expect(result.run.status).toBe('succeeded');

    const ptCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'plan_table');
    const planTable = ptCall[2];
    const rows = planTable.rows;

    // At least some rows should have _meta
    const rowsWithMeta = rows.filter(r => r._meta);
    expect(rowsWithMeta.length).toBeGreaterThan(0);

    // Rows with _meta should have the expected structure
    for (const row of rowsWithMeta) {
      expect(row._meta).toHaveProperty('fallback_fields');
      expect(row._meta).toHaveProperty('datasets_used');
      expect(row._meta).toHaveProperty('confidence');
      expect(Array.isArray(row._meta.fallback_fields)).toBe(true);
      expect(Array.isArray(row._meta.datasets_used)).toBe(true);
      expect(typeof row._meta.confidence).toBe('number');
      expect(row._meta.confidence).toBeGreaterThanOrEqual(0);
      expect(row._meta.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('produces data_quality_report showing missing optional datasets', async () => {
    await runPlanFromDatasetProfile({
      userId: 'user-itp-1',
      datasetProfileRow: mockProfileRow,
      settings: {},
    });

    const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
    expect(dqCall).toBeDefined();
    const dq = dqCall[2];

    expect(dq.coverage_level).toBeDefined();
    expect(dq.available_datasets).toContain('inventory_snapshots');
    // Missing optional datasets should be listed
    expect(dq.missing_datasets.length).toBeGreaterThan(0);
  });

  it('data_quality_report row_stats clean + with_fallback = total', async () => {
    await runPlanFromDatasetProfile({
      userId: 'user-itp-1',
      datasetProfileRow: mockProfileRow,
      settings: {},
    });

    const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
    const dq = dqCall[2];

    if (dq.row_stats) {
      expect(dq.row_stats.total).toBeGreaterThan(0);
      expect(dq.row_stats.clean + dq.row_stats.with_fallback).toBe(dq.row_stats.total);
    }
  });
});
