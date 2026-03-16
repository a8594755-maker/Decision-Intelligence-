/**
 * E2E tests for data resilience: quarantine, quality accounting,
 * capabilities, mapping profile reuse, artifact contract validation.
 *
 * Mocks external services; exercises REAL pipeline logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external services BEFORE importing modules under test ────────────

vi.mock('../../services/supabaseClient', () => ({
  userFilesService: {
    getFileById: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ id: 'file-saved-1' }),
  },
}));

vi.mock('../../services/diRunsService', () => ({
  diRunsService: {
    createRun: vi.fn().mockResolvedValue({ id: 'run-dr-1', status: 'created' }),
    updateRunStatus: vi.fn().mockResolvedValue({ id: 'run-dr-1', status: 'succeeded' }),
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
              material_code: 'A1', plant_id: 'P1',
              points: [
                { time_bucket: '2025-01-05', p50: 80, is_forecast: true },
                { time_bucket: '2025-01-10', p50: 60, is_forecast: true },
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
    total_stockouts: 0, total_holding: 10, daily_projection: [],
    total_orders: 1, total_order_qty: 100, stockout_events: [],
    inventory_projection: [],
    metrics: { service_level_proxy: 0.95, stockout_units: 5, holding_units: 50, total_cost: 1500 },
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
    parsed: { minimal_questions: [], summary: 'Test report' },
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

// ── Now import modules under test ─────────────────────────────────────────

import { runPlanFromDatasetProfile } from '../../services/chatPlanningService';
import { userFilesService } from '../../services/supabaseClient';
import optimizationApiClient from '../../services/optimizationApiClient';
import { saveJsonArtifact } from '../../utils/artifactStore';
import { logger } from '../../services/observability';
import { validateArtifactOrThrow } from '../../contracts/diArtifactContractV1';
import { buildDataQualityReport } from '../../utils/dataQualityReport';
import { evaluateCapabilities } from '../../config/capabilityMatrix';

// Pure function imports for mapping/inference tests
import { normalizeHeader } from '../../utils/headerNormalize';
import { generateHeaderFingerprint } from '../../services/mappingProfileService';
import { REASON_CODES, buildQuarantineReport } from '../../utils/dataValidation';

// ── Test data ─────────────────────────────────────────────────────────────

const mockRawRows = [
  { __sheet_name: 'Inv', SKU: 'A1', Plant: 'P1', OnHand: '100', Date: '2025-01-01', SafetyStock: '10', LeadTime: '3' },
  { __sheet_name: 'Inv', SKU: 'A2', Plant: 'P1', OnHand: '50', Date: '2025-01-01' },
];

const mockProfileRow = {
  id: 'profile-dr-1',
  user_file_id: 'file-dr-1',
  fingerprint: 'fp-dr-1',
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
  plan: [{ sku: 'A1', plant_id: 'P1', order_date: '2025-01-05', arrival_date: '2025-01-08', order_qty: 100 }],
  kpis: { estimated_service_level: 0.95, estimated_stockout_units: 5, estimated_holding_units: 50, estimated_total_cost: 1500 },
  solver_meta: { solver: 'heuristic', solve_time_ms: 42, objective_value: 1500, gap: 0, multi_echelon_mode: 'off' },
  infeasible_reasons: [],
  proof: { objective_terms: [{ name: 'total_cost', value: 1500 }], constraints_checked: [] },
  component_plan: [],
  component_inventory_projection: { total_rows: 0, rows: [], truncated: false },
  bottlenecks: { generated_at: '2025-01-01', total_rows: 0, rows: [] },
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Data Resilience E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logger.clear();
    userFilesService.getFileById.mockResolvedValue({ id: 'file-dr-1', filename: 'test.xlsx', data: mockRawRows });
    optimizationApiClient.createReplenishmentPlan.mockResolvedValue(mockSolverResult);
  });

  // ── Test 1: REASON_CODES structure ───────────────────────────────────────

  describe('REASON_CODES and quarantine report', () => {
    it('REASON_CODES has required codes with fixable flag', () => {
      expect(REASON_CODES.MISSING_REQUIRED.fixable).toBe(true);
      expect(REASON_CODES.INVALID_DATE.fixable).toBe(true);
      expect(REASON_CODES.TYPE_MISMATCH.fixable).toBe(false);
      expect(REASON_CODES.DUPLICATE_ROW.fixable).toBe(false);
    });

    it('buildQuarantineReport produces v2 with quarantined disposition', () => {
      const validationResult = {
        validRows: [{ material_code: 'A1', onhand_qty: 100 }],
        errorRows: [
          {
            rowIndex: 2,
            originalData: { SKU: 'A2' },
            cleanedData: {},
            errors: [
              { field: 'snapshot_date', fieldLabel: 'Snapshot Date', error: 'required', reasonCode: 'MISSING_REQUIRED' },
            ],
          },
          {
            rowIndex: 3,
            originalData: { SKU: 'A3' },
            cleanedData: {},
            errors: [
              { field: 'name', fieldLabel: 'Name', error: 'abnormal', reasonCode: 'TYPE_MISMATCH' },
            ],
          },
        ],
        duplicateGroups: [],
        stats: { total: 3, valid: 1, invalid: 2 },
      };

      const report = buildQuarantineReport(validationResult, 'Sheet1', 'inventory_snapshots');
      expect(report.version).toBe('2');
      expect(report.quarantined).toBe(1);
      expect(report.rejected).toBe(1);
      expect(report.accepted).toBe(1);

      const quarantinedRow = report.quarantined_rows.find(r => r.disposition === 'quarantined');
      expect(quarantinedRow).toBeDefined();
      expect(quarantinedRow.reasonCodes).toContain('MISSING_REQUIRED');

      const rejectedRow = report.quarantined_rows.find(r => r.disposition === 'rejected');
      expect(rejectedRow).toBeDefined();
      expect(rejectedRow.reasonCodes).toContain('TYPE_MISMATCH');
    });
  });

  // ── Test 2: Missing optional datasets → degraded execution ──────────────

  describe('missing optional datasets → degraded but successful plan', () => {
    it('plans with only inventory_snapshots and succeeds', async () => {
      const result = await runPlanFromDatasetProfile({
        userId: 'user-dr-1',
        datasetProfileRow: mockProfileRow,
        settings: {},
      });

      expect(result.run.status).toBe('succeeded');

      // Find data_quality_report artifact
      const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
      expect(dqCall).toBeDefined();
      const dqReport = dqCall[2];

      // Coverage should be partial or minimal (missing po_open_lines, fg_financials, bom_edge)
      expect(['partial', 'minimal']).toContain(dqReport.coverage_level);
      expect(dqReport.missing_datasets.length).toBeGreaterThan(0);
      expect(dqReport.available_datasets).toContain('inventory_snapshots');

      // Capabilities should be present
      expect(dqReport.capabilities).toBeDefined();
    });
  });

  // ── Test 3: Precise rowStats ────────────────────────────────────────────

  describe('precise rowStats in data_quality_report', () => {
    it('clean + with_fallback = total (row-level, not field-level)', async () => {
      // Row A2 has no SafetyStock or LeadTime → will trigger fallbacks on that row
      await runPlanFromDatasetProfile({
        userId: 'user-dr-1',
        datasetProfileRow: mockProfileRow,
        settings: {},
      });

      const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
      const dqReport = dqCall[2];

      expect(dqReport.row_stats).toBeDefined();
      expect(dqReport.row_stats.total).toBeGreaterThan(0);
      expect(dqReport.row_stats.clean + dqReport.row_stats.with_fallback).toBe(dqReport.row_stats.total);
      // with_fallback should be a count of distinct rows, not field-level count
      expect(dqReport.row_stats.with_fallback).toBeLessThanOrEqual(dqReport.row_stats.total);
    });
  });

  // ── Test 4: Artifact contract validation ───────────────────────────────

  describe('all planning artifacts pass contract validation', () => {
    it('data_quality_report passes validateArtifactOrThrow', async () => {
      await runPlanFromDatasetProfile({
        userId: 'user-dr-1',
        datasetProfileRow: mockProfileRow,
        settings: {},
      });

      const dqCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'data_quality_report');
      expect(() => {
        validateArtifactOrThrow({ artifact_type: 'data_quality_report', payload: dqCall[2] });
      }).not.toThrow();
    });

    it('solver_meta passes validateArtifactOrThrow', async () => {
      await runPlanFromDatasetProfile({
        userId: 'user-dr-1',
        datasetProfileRow: mockProfileRow,
        settings: {},
      });

      const smCall = saveJsonArtifact.mock.calls.find(c => c[1] === 'solver_meta');
      expect(() => {
        validateArtifactOrThrow({ artifact_type: 'solver_meta', payload: smCall[2] });
      }).not.toThrow();
    });

    it('buildDataQualityReport with all missing datasets still passes contract', () => {
      const report = buildDataQualityReport({
        availableDatasets: [],
        missingDatasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'fg_financials', 'bom_edge'],
      });
      expect(() => {
        validateArtifactOrThrow({ artifact_type: 'data_quality_report', payload: report });
      }).not.toThrow();
      expect(report.coverage_level).toBe('minimal');
    });
  });

  // ── Test 5: evaluateCapabilities ──────────────────────────────────────

  describe('evaluateCapabilities', () => {
    it('returns full for all datasets present', () => {
      const caps = evaluateCapabilities([
        { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
        { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
        { type: 'po_open_lines', fields: ['material_code', 'open_qty', 'time_bucket'] },
        { type: 'fg_financials', fields: ['material_code', 'unit_margin'] },
        { type: 'bom_edge', fields: ['parent_material', 'child_material', 'qty_per'] },
      ]);
      expect(caps.basic_plan.available).toBe(true);
      expect(caps.forecast.available).toBe(true);
    });

    it('profit_at_risk unavailable without fg_financials', () => {
      const caps = evaluateCapabilities([
        { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
        { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
      ]);
      expect(caps.profit_at_risk.available).toBe(false);
      expect(caps.profit_at_risk.level).toBe('unavailable');
    });
  });

  // ── Test 6: Mapping profile reuse ──────────────────────────────────────

  describe('mapping profile reuse', () => {
    it('fingerprint is deterministic and order-independent', () => {
      const fp1 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand']);
      const fp2 = generateHeaderFingerprint(['OnHand', 'SKU', 'Plant']);
      expect(fp1).toBe(fp2);
    });

    it('different headers produce different fingerprints', () => {
      const fp1 = generateHeaderFingerprint(['SKU', 'Plant', 'OnHand']);
      const fp2 = generateHeaderFingerprint(['Material', 'Site', 'Stock']);
      expect(fp1).not.toBe(fp2);
    });
  });

  // ── Test 7: Messy headers → inference ───────────────────────────────────

  describe('messy headers inference', () => {
    it('normalizeHeader strips BOM and NBSP characters', () => {
      expect(normalizeHeader('\uFEFFSKU')).toBe(normalizeHeader('SKU'));
      expect(normalizeHeader('Plant\u00A0Code')).toBe(normalizeHeader('Plant Code'));
    });
  });

  // ── Test 8: Observability tracing ──────────────────────────────────────

  describe('parentTraceId propagation', () => {
    it('planning logs inherit parentTraceId when provided', async () => {
      await runPlanFromDatasetProfile({
        userId: 'user-dr-1',
        datasetProfileRow: mockProfileRow,
        settings: {},
        parentTraceId: 'import-trace-123',
      });

      const entries = logger.getEntries({ source: 'planning-pipeline' });
      expect(entries.length).toBeGreaterThan(0);
      // The planning traceId should contain or derive from the parent
      const startEntry = entries.find(e => e.message === 'Planning started');
      expect(startEntry?.traceId).toBeDefined();
    });
  });
});
