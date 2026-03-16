/**
 * Tests for Phase 3 artifact builders:
 *   - decisionArtifactBuilder.js (decision_brief)
 *   - evidencePackBuilder.js (evidence_pack_v2)
 *   - writebackPayloadBuilder.js (writeback_payload)
 *
 * + contract validation integration
 */

import { describe, it, expect } from 'vitest';
import { buildDecisionBrief } from './decisionArtifactBuilder.js';
import { buildEvidencePack } from './evidencePackBuilder.js';
import {
  buildWritebackPayload,
  applyApproval,
  markWritebackFailed,
  TARGET_SYSTEMS,
  MUTATION_ACTIONS,
} from './writebackPayloadBuilder.js';
import {
  validateDecisionBrief,
  validateEvidencePackV2,
  validateWritebackPayload,
} from '../../contracts/decisionArtifactContract.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const PLAN_TABLE_ARTIFACT = {
  artifact_type: 'plan_table',
  payload: {
    rows: [
      { sku: 'MAT-001', plant_id: 'P10', order_qty: 500, order_date: '2026-04-01', arrival_date: '2026-04-15', supplier_id: 'SUP-A' },
      { sku: 'MAT-002', plant_id: 'P20', order_qty: 300, order_date: '2026-04-02', delivery_date: '2026-04-18' },
      { sku: 'MAT-001', plant_id: 'P10', order_qty: 200, order_type: 'production' },
    ],
  },
};

const SOLVER_META_ARTIFACT = {
  artifact_type: 'solver_meta',
  payload: {
    status: 'optimal',
    objective_value: 12500,
    constraints_checked: true,
    kpis: { total_cost: 45000, total_order_qty: 1000, num_orders: 3 },
  },
};

const CONSTRAINT_CHECK_ARTIFACT = {
  artifact_type: 'constraint_check',
  payload: {
    violations: [
      { rule: 'MOQ', sku: 'MAT-001', details: 'Below minimum order qty' },
    ],
  },
};

const REPLAY_METRICS_ARTIFACT = {
  artifact_type: 'replay_metrics',
  payload: {
    with_plan: { service_level_proxy: 0.95, stockout_units: 10 },
    without_plan: { service_level_proxy: 0.82, stockout_units: 150 },
  },
};

const FORECAST_METRICS_ARTIFACT = {
  artifact_type: 'metrics',
  payload: { mape: 0.12 },
};

const RISK_ADJUSTMENTS_ARTIFACT = {
  artifact_type: 'risk_adjustments',
  payload: {
    adjustments: [
      { param: 'lead_time', factor: 1.2 },
      { param: 'safety_stock', factor: 1.3 },
    ],
  },
};

const TASK_META = { id: 'task_001', title: 'Weekly Replenishment Plan', workflowType: 'replenishment' };

function buildArtifactMap(artifacts) {
  return { step_plan: artifacts };
}

// ── Decision Brief ──────────────────────────────────────────────────────────

describe('buildDecisionBrief', () => {
  it('builds a valid brief from plan artifacts', () => {
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    expect(brief.summary).toContain('Weekly Replenishment Plan');
    expect(brief.summary).toContain('optimal');
    expect(brief.recommended_action).toBe('replenish_now');
    expect(brief.confidence).toBeGreaterThan(0.5);
    expect(brief.generated_at).toBeTruthy();
    expect(brief.workflow_type).toBe('replenishment');
  });

  it('passes contract validation', () => {
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    const result = validateDecisionBrief(brief);
    expect(result.valid).toBe(true);
  });

  it('returns no_action when plan table is empty', () => {
    const brief = buildDecisionBrief({
      planArtifacts: { step_plan: [{ artifact_type: 'plan_table', payload: { rows: [] } }] },
      taskMeta: TASK_META,
    });
    expect(brief.recommended_action).toBe('no_action');
  });

  it('flags constraint violations', () => {
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([
        SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT, CONSTRAINT_CHECK_ARTIFACT,
      ]),
      taskMeta: TASK_META,
    });
    expect(brief.recommended_action).toBe('replenish_with_constraints');
    expect(brief.risk_flags.length).toBeGreaterThan(0);
    expect(brief.risk_flags.some(f => f.category === 'constraint')).toBe(true);
  });

  it('calculates business impact from solver KPIs + replay', () => {
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([
        SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT, REPLAY_METRICS_ARTIFACT,
      ]),
      taskMeta: TASK_META,
    });
    expect(brief.business_impact.total_cost).toBe(45000);
    expect(brief.business_impact.service_level_impact).toContain('+');
    expect(brief.business_impact.stockouts_prevented).toBe(140);
  });

  it('adds forecast accuracy risk flag for high MAPE', () => {
    const highMape = { artifact_type: 'metrics', payload: { mape: 0.45 } };
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT, highMape]),
      taskMeta: TASK_META,
    });
    expect(brief.risk_flags.some(f => f.category === 'forecast_accuracy')).toBe(true);
  });

  it('boosts confidence for low MAPE', () => {
    const lowMape = { artifact_type: 'metrics', payload: { mape: 0.10 } };
    const briefLow = buildDecisionBrief({
      planArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT, lowMape]),
      taskMeta: TASK_META,
    });
    const briefNone = buildDecisionBrief({
      planArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    expect(briefLow.confidence).toBeGreaterThan(briefNone.confidence);
  });

  it('includes scenario comparison when provided', () => {
    const sc = { scenario_run_id: 'sc_1', label: 'Alt', kpis: { cost: 50000 } };
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
      scenarioComparison: sc,
    });
    expect(brief.scenario_comparison).toEqual(sc);
  });

  it('returns review_and_decide for feasible solver', () => {
    const feasible = { ...SOLVER_META_ARTIFACT, payload: { ...SOLVER_META_ARTIFACT.payload, status: 'feasible' } };
    const brief = buildDecisionBrief({
      planArtifacts: buildArtifactMap([feasible, PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    expect(brief.recommended_action).toBe('review_and_decide');
  });

  it('handles flat artifact array', () => {
    const brief = buildDecisionBrief({
      planArtifacts: [SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT],
      taskMeta: TASK_META,
    });
    expect(brief.summary).toContain('optimal');
  });
});

// ── Evidence Pack ───────────────────────────────────────────────────────────

describe('buildEvidencePack', () => {
  const priorStepResults = [
    { step_name: 'forecast', status: 'succeeded', started_at: '2026-04-01T00:00:00Z', artifacts: [FORECAST_METRICS_ARTIFACT] },
    { step_name: 'optimize', status: 'succeeded', artifacts: [SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT] },
    { step_name: 'verify', status: 'succeeded', artifacts: [CONSTRAINT_CHECK_ARTIFACT] },
  ];

  it('builds a valid evidence pack', () => {
    const ep = buildEvidencePack({
      priorArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT, FORECAST_METRICS_ARTIFACT]),
      taskMeta: TASK_META,
      inputData: {
        datasetProfileId: 'ds_001',
        datasetProfileRow: { file_name: 'orders.xlsx', row_count: 1500, created_at: '2026-03-01' },
      },
      priorStepResults,
    });
    expect(ep.source_datasets.length).toBeGreaterThan(0);
    expect(ep.source_datasets[0].dataset_id).toBe('ds_001');
    expect(ep.timestamps.analysis_started_at).toBeTruthy();
    expect(ep.timestamps.analysis_completed_at).toBeTruthy();
    expect(ep.engine_versions.platform).toBe('decision-intelligence-v2');
    expect(ep.engine_versions.solver).toBeTruthy();
    expect(ep.calculation_logic).toContain('3 step(s)');
    expect(ep.generated_at).toBeTruthy();
  });

  it('passes contract validation', () => {
    const ep = buildEvidencePack({
      priorArtifacts: buildArtifactMap([SOLVER_META_ARTIFACT]),
      taskMeta: TASK_META,
      inputData: {},
      priorStepResults,
    });
    const result = validateEvidencePackV2(ep);
    expect(result.valid).toBe(true);
  });

  it('includes sheets as source datasets', () => {
    const ep = buildEvidencePack({
      priorArtifacts: {},
      taskMeta: TASK_META,
      inputData: {
        sheets: {
          Orders: [{ sku: 'A', qty: 10 }, { sku: 'B', qty: 20 }],
          Inventory: [{ sku: 'A', stock: 100 }],
        },
      },
      priorStepResults: [],
    });
    expect(ep.source_datasets.length).toBe(2);
    expect(ep.source_datasets[0].name).toBe('Orders');
    expect(ep.source_datasets[0].row_count).toBe(2);
  });

  it('builds referenced tables from sheets', () => {
    const ep = buildEvidencePack({
      priorArtifacts: {},
      taskMeta: {},
      inputData: {
        sheets: { Orders: [{ sku: 'A', qty: 10, price: 5 }] },
      },
      priorStepResults: [],
    });
    expect(ep.referenced_tables.length).toBe(1);
    expect(ep.referenced_tables[0].table_name).toBe('Orders');
    expect(ep.referenced_tables[0].fields_used).toContain('sku');
  });

  it('detects CFR engine version', () => {
    const cfrArt = { artifact_type: 'cfr_negotiation_strategy', payload: {} };
    const ep = buildEvidencePack({
      priorArtifacts: buildArtifactMap([cfrArt]),
      taskMeta: {},
      inputData: {},
      priorStepResults: [],
    });
    expect(ep.engine_versions.cfr_engine).toBe('cfr-v3');
  });

  it('builds artifact inventory from step results', () => {
    const ep = buildEvidencePack({
      priorArtifacts: {},
      taskMeta: {},
      inputData: {},
      priorStepResults,
    });
    expect(ep.artifact_inventory.forecast).toContain('metrics');
    expect(ep.artifact_inventory.optimize).toContain('solver_meta');
  });

  it('provides inline fallback when no data sources', () => {
    const ep = buildEvidencePack({
      priorArtifacts: {},
      taskMeta: {},
      inputData: {},
      priorStepResults: [],
    });
    expect(ep.source_datasets.length).toBe(1);
    expect(ep.source_datasets[0].dataset_id).toBe('inline');
  });

  it('builds evidence refs from succeeded steps', () => {
    const ep = buildEvidencePack({
      priorArtifacts: {},
      taskMeta: {},
      inputData: {},
      priorStepResults,
    });
    expect(ep.evidence_refs.length).toBe(4); // metrics + solver_meta + plan_table + constraint_check
    expect(ep.evidence_refs[0].step_name).toBe('forecast');
  });
});

// ── Writeback Payload ───────────────────────────────────────────────────────

describe('buildWritebackPayload', () => {
  it('builds a valid payload from plan artifacts', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    expect(wp.target_system).toBe(TARGET_SYSTEMS.CSV_EXPORT);
    expect(wp.format).toBe('json');
    expect(wp.intended_mutations.length).toBe(3);
    expect(wp.affected_records.length).toBe(2); // MAT-001@P10 and MAT-002@P20
    expect(wp.idempotency_key).toBeTruthy();
    expect(wp.status).toBe('pending_approval');
    expect(wp.task_id).toBe('task_001');
    expect(wp.generated_at).toBeTruthy();
  });

  it('passes contract validation', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    const result = validateWritebackPayload(wp);
    expect(result.valid).toBe(true);
  });

  it('maps action types correctly', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    // First two rows default to create_po, third is production
    expect(wp.intended_mutations[0].action).toBe(MUTATION_ACTIONS.CREATE_PO);
    expect(wp.intended_mutations[2].action).toBe(MUTATION_ACTIONS.CREATE_PRODUCTION);
  });

  it('resolves entity types from actions', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    expect(wp.intended_mutations[0].entity).toBe('purchase_order');
    expect(wp.intended_mutations[2].entity).toBe('production_order');
  });

  it('builds mutation summary', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    expect(wp.mutation_summary.total_mutations).toBe(3);
    expect(wp.mutation_summary.total_qty).toBe(1000); // 500 + 300 + 200
    expect(wp.mutation_summary.unique_skus).toBe(2);
    expect(wp.mutation_summary.unique_sites).toBe(2);
  });

  it('aggregates affected records', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    const mat001 = wp.affected_records.find(r => r.entity_id === 'MAT-001');
    expect(mat001).toBeTruthy();
    expect(mat001.qty).toBe(700); // 500 + 200
    expect(mat001.order_count).toBe(2);
  });

  it('uses specified target system', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
      targetSystem: TARGET_SYSTEMS.SAP_MM,
    });
    expect(wp.target_system).toBe('sap_mm');
  });

  it('handles safety stock adjustments', () => {
    const safetyRow = {
      artifact_type: 'plan_table',
      payload: {
        rows: [{
          sku: 'MAT-X', plant_id: 'P10', order_qty: 100,
          action_type: MUTATION_ACTIONS.ADJUST_SAFETY,
          current_safety_stock: 50, new_safety_stock: 100,
        }],
      },
    };
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([safetyRow]),
      taskMeta: TASK_META,
    });
    const m = wp.intended_mutations[0];
    expect(m.action).toBe(MUTATION_ACTIONS.ADJUST_SAFETY);
    expect(m.entity).toBe('material_master');
    expect(m.before.safety_stock).toBe(50);
    expect(m.after.safety_stock).toBe(100);
  });

  it('returns empty mutations for empty plan', () => {
    const wp = buildWritebackPayload({
      planArtifacts: {},
      taskMeta: TASK_META,
    });
    expect(wp.intended_mutations.length).toBe(0);
    expect(wp.affected_records.length).toBe(0);
    expect(wp.mutation_summary.total_mutations).toBe(0);
  });

  it('handles flat array plan table', () => {
    const flatPlan = {
      artifact_type: 'plan_table',
      payload: [
        { sku: 'F-001', plant_id: 'P1', order_qty: 100 },
      ],
    };
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([flatPlan]),
      taskMeta: TASK_META,
    });
    expect(wp.intended_mutations.length).toBe(1);
  });
});

// ── applyApproval ───────────────────────────────────────────────────────────

describe('applyApproval', () => {
  it('marks payload as approved with metadata', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    const approved = applyApproval(wp, {
      approved_by: 'manager@example.com',
      review_id: 'rev_123',
      policy_ref: 'ap_001',
    });
    expect(approved.status).toBe('approved');
    expect(approved.approval_metadata.approved_by).toBe('manager@example.com');
    expect(approved.approval_metadata.approved_at).toBeTruthy();
    expect(approved.approval_metadata.review_id).toBe('rev_123');
    // Original fields preserved
    expect(approved.intended_mutations.length).toBe(3);
  });
});

// ── markWritebackFailed ─────────────────────────────────────────────────────

describe('markWritebackFailed', () => {
  it('marks payload as failed with error message', () => {
    const wp = buildWritebackPayload({
      planArtifacts: buildArtifactMap([PLAN_TABLE_ARTIFACT]),
      taskMeta: TASK_META,
    });
    const failed = markWritebackFailed(wp, 'SAP connection timeout');
    expect(failed.status).toBe('failed');
    expect(failed.error_message).toBe('SAP connection timeout');
    expect(failed.failed_at).toBeTruthy();
  });
});

// ── Cross-builder integration ───────────────────────────────────────────────

describe('cross-builder integration', () => {
  it('all three artifacts validate together', () => {
    const artifacts = buildArtifactMap([
      SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT,
      CONSTRAINT_CHECK_ARTIFACT, REPLAY_METRICS_ARTIFACT,
      FORECAST_METRICS_ARTIFACT, RISK_ADJUSTMENTS_ARTIFACT,
    ]);
    const priorStepResults = [
      { step_name: 'forecast', status: 'succeeded', artifacts: [FORECAST_METRICS_ARTIFACT] },
      { step_name: 'optimize', status: 'succeeded', artifacts: [SOLVER_META_ARTIFACT, PLAN_TABLE_ARTIFACT] },
    ];

    const brief = buildDecisionBrief({ planArtifacts: artifacts, taskMeta: TASK_META });
    const evidence = buildEvidencePack({
      priorArtifacts: artifacts, taskMeta: TASK_META,
      inputData: { datasetProfileId: 'ds_1', datasetProfileRow: { file_name: 'test.xlsx', row_count: 100 } },
      priorStepResults,
    });
    const writeback = buildWritebackPayload({ planArtifacts: artifacts, taskMeta: TASK_META });

    expect(validateDecisionBrief(brief).valid).toBe(true);
    expect(validateEvidencePackV2(evidence).valid).toBe(true);
    expect(validateWritebackPayload(writeback).valid).toBe(true);

    // Cross-check: writeback mutations match plan rows
    expect(writeback.intended_mutations.length).toBe(3);
    // Brief references risk flags from constraints
    expect(brief.risk_flags.length).toBeGreaterThan(0);
    // Evidence has engine versions from solver
    expect(evidence.engine_versions.solver).toBeTruthy();
  });
});
