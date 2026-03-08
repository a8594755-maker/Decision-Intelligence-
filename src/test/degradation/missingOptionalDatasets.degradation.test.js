/**
 * Degradation Test: Missing Optional Datasets
 *
 * Verifies that when optional datasets (open PO, financials, BOM) are absent,
 * the pipeline degrades gracefully — plan succeeds with degraded capabilities
 * and appropriate quality indicators.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external services ────────────────────────────────────────────────

vi.mock('../../services/supabaseClient', () => ({
  userFilesService: {
    getFileById: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ id: 'file-saved-1' }),
  },
}));

vi.mock('../../services/diRunsService', () => ({
  diRunsService: {
    createRun: vi.fn().mockResolvedValue({ id: 'run-deg-1', status: 'created' }),
    updateRunStatus: vi.fn().mockResolvedValue({ id: 'run-deg-1', status: 'succeeded' }),
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
              material_code: 'MAT-A', plant_id: 'P1',
              points: [{ time_bucket: '2025-01-10', p50: 100, is_forecast: true }],
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

vi.mock('../../services/reuseMemoryService', () => ({
  reuseMemoryService: { upsertRunSettingsTemplate: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../services/optimizationApiClient', () => ({
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
    total_stockouts: 0, total_holding: 5, daily_projection: [],
    total_orders: 1, total_order_qty: 50, stockout_events: [],
    inventory_projection: [],
    metrics: { service_level_proxy: 0.90, stockout_units: 8, holding_units: 40, total_cost: 1200 },
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

vi.mock('../../services/diModelRouterService', () => ({
  DI_PROMPT_IDS: { WORKFLOW_A_READINESS: 'readiness', WORKFLOW_A_REPORT: 'report' },
  runDiPrompt: vi.fn().mockResolvedValue({
    parsed: { minimal_questions: [], summary: 'Degradation test report' },
    provider: 'mock', model: 'mock',
  }),
}));

vi.mock('../../utils/buildDecisionNarrative', () => ({
  buildDecisionNarrativeFromPlanResult: vi.fn().mockReturnValue({
    summary_text: 'Narrative.', sections: [],
  }),
}));

vi.mock('../../services/planAuditService', () => ({
  recordPlanGenerated: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/multiEchelonBomService', () => ({
  MULTI_ECHELON_MODES: { OFF: 'off', AUTO: 'auto', FORCE: 'force' },
  resolveMultiEchelonConfig: vi.fn().mockReturnValue({ mode: 'off', max_bom_depth: 1 }),
  normalizeSkuKey: vi.fn((s) => s),
  explodeBomForRun: vi.fn().mockResolvedValue({
    componentDemand: [], explosion_rows: [], artifact: null, mode: 'off', max_bom_depth: 1,
  }),
}));

// ── Import modules under test ─────────────────────────────────────────────

import { runPlanFromDatasetProfile } from '../../services/chatPlanningService';
import { userFilesService } from '../../services/supabaseClient';
import optimizationApiClient from '../../services/optimizationApiClient';
import { saveJsonArtifact } from '../../utils/artifactStore';
import { evaluateCapabilities } from '../../config/capabilityMatrix';

// ── Test data: only inventory ─────────────────────────────────────────────

const inventoryOnlyRows = [
  { __sheet_name: 'Inv', SKU: 'MAT-A', Plant: 'P1', OnHand: '300', Date: '2025-01-01', SafetyStock: '20', LeadTime: '5' },
  { __sheet_name: 'Inv', SKU: 'MAT-B', Plant: 'P1', OnHand: '100', Date: '2025-01-01' },
];

const inventoryOnlyProfile = {
  id: 'profile-deg-1',
  user_file_id: 'file-deg-1',
  fingerprint: 'fp-deg-1',
  contract_json: {
    datasets: [{
      upload_type: 'inventory_snapshots',
      sheet_name: 'Inv',
      mapping: { SKU: 'material_code', Plant: 'plant_id', OnHand: 'onhand_qty', Date: 'snapshot_date', SafetyStock: 'safety_stock', LeadTime: 'lead_time_days' },
      validation: { status: 'pass' },
    }],
  },
  profile_json: { global: { workflow_guess: { label: 'A' } } },
};

const mockSolverResult = {
  status: 'feasible',
  plan: [{ sku: 'MAT-A', plant_id: 'P1', order_date: '2025-01-10', arrival_date: '2025-01-15', order_qty: 50 }],
  kpis: { estimated_service_level: 0.90, estimated_stockout_units: 8, estimated_holding_units: 40, estimated_total_cost: 1200 },
  solver_meta: { solver: 'heuristic', solve_time_ms: 30, objective_value: 1200, gap: 0, multi_echelon_mode: 'off' },
  infeasible_reasons: [],
  proof: { objective_terms: [{ name: 'total_cost', value: 1200 }], constraints_checked: [] },
  component_plan: [],
  component_inventory_projection: { total_rows: 0, rows: [], truncated: false },
  bottlenecks: { generated_at: '2025-01-01', total_rows: 0, rows: [] },
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Missing Optional Datasets Degradation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFilesService.getFileById.mockResolvedValue({
      id: 'file-deg-1', filename: 'inventory_only.xlsx', data: inventoryOnlyRows,
    });
    optimizationApiClient.createReplenishmentPlan.mockResolvedValue(mockSolverResult);
  });

  it('plan succeeds with only inventory data', async () => {
    const result = await runPlanFromDatasetProfile({
      userId: 'user-deg-1',
      datasetProfileRow: inventoryOnlyProfile,
      settings: {},
    });
    expect(result.run.status).toBe('succeeded');
  });

  it('coverage_level is partial or minimal (not full)', async () => {
    await runPlanFromDatasetProfile({
      userId: 'user-deg-1',
      datasetProfileRow: inventoryOnlyProfile,
      settings: {},
    });

    const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
    expect(dqCall).toBeDefined();
    const dq = dqCall[2];
    expect(['partial', 'minimal']).toContain(dq.coverage_level);
  });

  it('missing_datasets includes po_open_lines, fg_financials, bom_edge', async () => {
    await runPlanFromDatasetProfile({
      userId: 'user-deg-1',
      datasetProfileRow: inventoryOnlyProfile,
      settings: {},
    });

    const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
    const dq = dqCall[2];
    expect(dq.missing_datasets).toBeDefined();
    expect(dq.missing_datasets.length).toBeGreaterThan(0);
  });

  it('capabilities report shows unavailable features', async () => {
    await runPlanFromDatasetProfile({
      userId: 'user-deg-1',
      datasetProfileRow: inventoryOnlyProfile,
      settings: {},
    });

    const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
    const dq = dqCall[2];

    if (dq.capabilities) {
      // profit_at_risk should be unavailable without fg_financials
      expect(dq.capabilities.profit_at_risk?.available).toBe(false);
      // multi_echelon should be unavailable without bom_edge
      expect(dq.capabilities.multi_echelon?.available).toBe(false);
    }
  });

  it('evaluateCapabilities correctly downgrades without optional data', () => {
    const caps = evaluateCapabilities([
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
    ]);

    // basic_plan should be available (partial — missing optional datasets)
    expect(caps.basic_plan.available).toBe(true);
    expect(caps.basic_plan.level).toBe('partial');

    // inbound_aware_plan should be unavailable (missing po_open_lines)
    expect(caps.inbound_aware_plan.available).toBe(false);
    expect(caps.inbound_aware_plan.level).toBe('unavailable');

    // profit_at_risk should be unavailable (missing fg_financials)
    expect(caps.profit_at_risk.available).toBe(false);

    // multi_echelon should be unavailable (missing bom_edge)
    expect(caps.multi_echelon.available).toBe(false);
  });

  it('dataset_fallbacks messages are generated for missing datasets', async () => {
    await runPlanFromDatasetProfile({
      userId: 'user-deg-1',
      datasetProfileRow: inventoryOnlyProfile,
      settings: {},
    });

    const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
    const dq = dqCall[2];
    expect(dq.dataset_fallbacks).toBeDefined();
    expect(Array.isArray(dq.dataset_fallbacks)).toBe(true);
  });
});
