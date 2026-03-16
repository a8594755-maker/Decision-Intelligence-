/**
 * Tests for Phase 0 Decision Contracts:
 *   - Decision Work Order Contract
 *   - Decision Artifact Contract (decision_brief, evidence_pack_v2, writeback_payload)
 *   - Review Contract
 *   - Registration in diArtifactContractV1
 */

import { describe, it, expect } from 'vitest';

import {
  validateDecisionWorkOrder,
  createDecisionWorkOrder,
  fromLegacyWorkOrder,
  INTENT_TYPES,
  BUSINESS_DOMAINS,
  SOURCE_CHANNELS,
  RISK_LEVELS,
  DECISION_TYPES,
} from './decisionWorkOrderContract.js';

import {
  validateDecisionBrief,
  validateEvidencePackV2,
  validateWritebackPayload,
} from './decisionArtifactContract.js';

import {
  validateReviewResolution,
  createReviewResolution,
  createApprovalPolicy,
  checkApprovalGate,
  REVIEW_DECISIONS,
} from './reviewContract.js';

import { validateArtifactOrThrow } from './diArtifactContractV1.js';

// ── Decision Work Order ─────────────────────────────────────────────────────

describe('Decision Work Order Contract', () => {
  const validDWO = {
    intent_type: INTENT_TYPES.INVENTORY_REPLAN,
    worker_id: 'worker-123',
    source_channel: SOURCE_CHANNELS.EVENT_QUEUE,
    request_summary: 'Inventory DOH below threshold for SKU-001 at Plant P001',
    business_domain: BUSINESS_DOMAINS.SUPPLY_PLANNING,
    entity_refs: { sku: ['SKU-001'], site: ['P001'] },
    required_decision: DECISION_TYPES.REPLENISH_OR_REALLOCATE,
    risk_level: RISK_LEVELS.HIGH,
    due_at: '2026-03-20T12:00:00Z',
  };

  it('validates a correct DWO', () => {
    const result = validateDecisionWorkOrder(validDWO);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects null input', () => {
    const result = validateDecisionWorkOrder(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = validateDecisionWorkOrder({ worker_id: 'w1' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('intent_type'))).toBe(true);
    expect(result.errors.some(e => e.includes('source_channel'))).toBe(true);
    expect(result.errors.some(e => e.includes('request_summary'))).toBe(true);
  });

  it('rejects unknown intent_type', () => {
    const result = validateDecisionWorkOrder({ ...validDWO, intent_type: 'magic' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unknown intent_type');
  });

  it('rejects invalid due_at', () => {
    const result = validateDecisionWorkOrder({ ...validDWO, due_at: 'not-a-date' });
    expect(result.valid).toBe(false);
  });

  it('creates a DWO with factory', () => {
    const dwo = createDecisionWorkOrder({
      intent_type: INTENT_TYPES.FORECAST_REFRESH,
      worker_id: 'w1',
      source_channel: SOURCE_CHANNELS.SCHEDULE,
      request_summary: 'Weekly forecast refresh',
    });
    expect(dwo.id).toMatch(/^dwo_/);
    expect(dwo.version).toBe('2.0');
    expect(dwo.business_domain).toBe(BUSINESS_DOMAINS.SUPPLY_PLANNING);
    expect(dwo.risk_level).toBe(RISK_LEVELS.MEDIUM);
  });

  it('converts legacy WorkOrder to DWO', () => {
    const legacy = {
      id: 'wo_123',
      source: 'chat',
      title: 'Run forecast',
      description: 'Please run weekly forecast',
      priority: 'high',
      employee_id: 'emp-1',
      user_id: 'user-1',
      sla: { due_at: '2026-04-01T00:00:00Z' },
      context: { original_source: 'chat' },
    };
    const dwo = fromLegacyWorkOrder(legacy, { intent_type: INTENT_TYPES.FORECAST_REFRESH });
    expect(dwo.intent_type).toBe(INTENT_TYPES.FORECAST_REFRESH);
    expect(dwo.source_channel).toBe(SOURCE_CHANNELS.CHAT);
    expect(dwo.worker_id).toBe('emp-1');
  });
});

// ── Decision Artifact Contract ──────────────────────────────────────────────

describe('Decision Artifact Contract', () => {
  describe('decision_brief', () => {
    const valid = {
      summary: 'Recommend immediate replenishment for SKU-001',
      recommended_action: 'replenish_now',
      business_impact: { cost_delta: -5200, service_level_impact: '+3%' },
      risk_flags: [{ level: 'medium', category: 'lead_time', description: 'Supplier lead time variance high' }],
      confidence: 0.82,
      assumptions: ['Lead time stays at 14 days', 'No new orders in pipeline'],
    };

    it('validates a correct decision_brief', () => {
      expect(validateDecisionBrief(valid).valid).toBe(true);
    });

    it('rejects missing summary', () => {
      const { summary, ...rest } = valid;
      expect(validateDecisionBrief(rest).valid).toBe(false);
    });

    it('rejects confidence out of range', () => {
      expect(validateDecisionBrief({ ...valid, confidence: 1.5 }).valid).toBe(false);
    });

    it('passes through diArtifactContractV1 validation', () => {
      expect(() => validateArtifactOrThrow('decision_brief', valid)).not.toThrow();
    });
  });

  describe('evidence_pack_v2', () => {
    const valid = {
      source_datasets: [{ dataset_id: 'ds-1', name: 'inventory_master', row_count: 1200, loaded_at: '2026-03-16T10:00:00Z' }],
      timestamps: { analysis_started_at: '2026-03-16T10:00:00Z', analysis_completed_at: '2026-03-16T10:02:00Z' },
      referenced_tables: [{ table_name: 'inventory_master', fields_used: ['sku', 'on_hand', 'reorder_point'] }],
      engine_versions: { solver: '1.2.0', forecaster: '2.0.1' },
      calculation_logic: 'DOH = on_hand / avg_daily_demand; if DOH < safety_days, recommend replenish',
      assumptions: ['Demand is stationary'],
    };

    it('validates a correct evidence_pack_v2', () => {
      expect(validateEvidencePackV2(valid).valid).toBe(true);
    });

    it('rejects missing source_datasets', () => {
      const { source_datasets, ...rest } = valid;
      expect(validateEvidencePackV2(rest).valid).toBe(false);
    });

    it('passes through diArtifactContractV1 validation', () => {
      expect(() => validateArtifactOrThrow('evidence_pack_v2', valid)).not.toThrow();
    });
  });

  describe('writeback_payload', () => {
    const valid = {
      target_system: 'sap_mm',
      format: 'json',
      intended_mutations: [
        { entity: 'purchase_order', action: 'create', field_changes: { qty: 500, delivery_date: '2026-04-01' } },
      ],
      affected_records: [
        { entity_type: 'material', entity_id: 'SKU-001', description: 'Create PO for SKU-001' },
      ],
      idempotency_key: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      approval_metadata: { approved_by: 'manager-1', approved_at: '2026-03-16T12:00:00Z' },
      status: 'pending_approval',
    };

    it('validates a correct writeback_payload', () => {
      expect(validateWritebackPayload(valid).valid).toBe(true);
    });

    it('rejects missing idempotency_key', () => {
      const { idempotency_key, ...rest } = valid;
      expect(validateWritebackPayload(rest).valid).toBe(false);
    });

    it('rejects invalid status', () => {
      expect(validateWritebackPayload({ ...valid, status: 'unknown' }).valid).toBe(false);
    });

    it('passes through diArtifactContractV1 validation', () => {
      expect(() => validateArtifactOrThrow('writeback_payload', valid)).not.toThrow();
    });
  });
});

// ── Review Contract ─────────────────────────────────────────────────────────

describe('Review Contract', () => {
  it('validates a correct review resolution', () => {
    const result = validateReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'manager-1',
      task_id: 'task-123',
      review_notes: 'Looks good',
      approved_actions: ['replenish_now'],
      rejected_actions: [],
      publish_permission: { export: true, writeback: false },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects missing reviewer_id', () => {
    const result = validateReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      task_id: 'task-123',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('reviewer_id'))).toBe(true);
  });

  it('rejects unknown decision', () => {
    const result = validateReviewResolution({
      decision: 'maybe',
      reviewer_id: 'mgr-1',
      task_id: 'task-1',
    });
    expect(result.valid).toBe(false);
  });

  it('creates a review resolution with factory', () => {
    const rev = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'mgr-1',
      task_id: 'task-1',
      publish_permission: { export: true, writeback: true, notify: false },
    });
    expect(rev.id).toMatch(/^rev_/);
    expect(rev.decision).toBe('approved');
    expect(rev.resolved_at).toBeTruthy();
  });

  describe('Approval Policy', () => {
    it('creates a default policy', () => {
      const policy = createApprovalPolicy({ worker_template_id: 'tpl-supply-planner' });
      expect(policy.policy_id).toMatch(/^ap_/);
      expect(policy.rules).toHaveLength(3);
      expect(policy.rules[0].action_type).toBe('writeback');
      expect(policy.rules[0].requires_approval).toBe(true);
    });

    it('gate: writeback always requires approval in v1 default', () => {
      const policy = createApprovalPolicy({ worker_template_id: 'tpl-1' });
      const check = checkApprovalGate(policy, 'writeback', { autonomy_level: 'A2' });
      expect(check.requires_approval).toBe(true);
    });

    it('gate: export auto-approves at A2+', () => {
      const policy = createApprovalPolicy({ worker_template_id: 'tpl-1' });
      const check = checkApprovalGate(policy, 'export', { autonomy_level: 'A3' });
      expect(check.requires_approval).toBe(false);
    });

    it('gate: notify auto-approves at A3+', () => {
      const policy = createApprovalPolicy({ worker_template_id: 'tpl-1' });
      const check = checkApprovalGate(policy, 'notify', { autonomy_level: 'A3' });
      expect(check.requires_approval).toBe(false);
    });

    it('gate: notify requires approval at A2', () => {
      const policy = createApprovalPolicy({ worker_template_id: 'tpl-1' });
      const check = checkApprovalGate(policy, 'notify', { autonomy_level: 'A2' });
      expect(check.requires_approval).toBe(true);
    });

    it('gate: unknown action defaults to require approval', () => {
      const policy = createApprovalPolicy({ worker_template_id: 'tpl-1' });
      const check = checkApprovalGate(policy, 'deploy_to_prod', {});
      expect(check.requires_approval).toBe(true);
    });

    it('gate: no policy defaults to require approval', () => {
      const check = checkApprovalGate(null, 'writeback', {});
      expect(check.requires_approval).toBe(true);
    });
  });
});
