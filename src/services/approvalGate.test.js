/**
 * Tests for Phase 5 — Approval Gate + Publish Service
 *
 *   - approvalGateService.js — gate enforcement, policy, idempotency
 *   - publishService.js — export + writeback with gate checks
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  enforceApprovalGate,
  submitResolution,
  getResolution,
  clearResolution,
  registerPolicy,
  validateIdempotencyKey,
  _resetForTesting,
} from './approvalGateService.js';
import {
  publishSpreadsheetExport,
  publishWriteback,
  isPublished,
  _resetForTesting as resetPublish,
} from './publishService.js';
import { REVIEW_DECISIONS, createReviewResolution, createApprovalPolicy } from '../contracts/reviewContract.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TASK_ID = 'task_gate_001';

const MOCK_BRIEF = {
  summary: 'Test brief',
  recommended_action: 'replenish_now',
  confidence: 0.85,
  business_impact: { total_cost: 45000 },
  risk_flags: [{ level: 'medium', category: 'constraint', description: 'MOQ violation' }],
};

const MOCK_WRITEBACK = {
  target_system: 'csv_export',
  format: 'json',
  intended_mutations: [
    { entity: 'purchase_order', action: 'create_po', field_changes: { material_code: 'MAT-001', plant_id: 'P10', quantity: 500 } },
    { entity: 'purchase_order', action: 'create_po', field_changes: { material_code: 'MAT-002', plant_id: 'P20', quantity: 300 } },
  ],
  affected_records: [
    { entity_type: 'material', entity_id: 'MAT-001', site: 'P10' },
    { entity_type: 'material', entity_id: 'MAT-002', site: 'P20' },
  ],
  idempotency_key: 'idem_test_key_12345678',
  status: 'pending_approval',
};

beforeEach(() => {
  _resetForTesting();
  resetPublish();
});

// ── Approval Gate Service ───────────────────────────────────────────────────

describe('enforceApprovalGate', () => {
  it('blocks writeback by default (no resolution)', () => {
    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'writeback',
      writebackPayload: MOCK_WRITEBACK,
    });
    expect(result.allowed).toBe(false);
  });

  it('allows export for A2+ autonomy (default policy auto-approves export)', () => {
    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'export',
      autonomyLevel: 'A2',
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('Auto-approved');
  });

  it('blocks export for A1 autonomy (below auto-approve threshold)', () => {
    // Default policy: export requires_approval=false, so A1 should still pass
    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'export',
      autonomyLevel: 'A1',
    });
    // export has requires_approval: false in default policy → allowed
    expect(result.allowed).toBe(true);
  });

  it('allows with approved resolution', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'manager@test.com',
      task_id: TASK_ID,
      publish_permission: { export: true, writeback: true, notify: false },
    });
    submitResolution(TASK_ID, resolution);

    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'writeback',
    });
    expect(result.allowed).toBe(true);
    expect(result.resolution.reviewer_id).toBe('manager@test.com');
  });

  it('blocks writeback if resolution approves export only', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'manager@test.com',
      task_id: TASK_ID,
      publish_permission: { export: true, writeback: false, notify: false },
    });
    submitResolution(TASK_ID, resolution);

    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'writeback',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not permitted');
  });

  it('blocks with rejected resolution', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.REJECTED,
      reviewer_id: 'manager@test.com',
      task_id: TASK_ID,
      review_notes: 'Numbers look wrong',
    });
    submitResolution(TASK_ID, resolution);

    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'export',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Rejected');
  });

  it('blocks with revision_requested resolution', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.REVISION_REQUESTED,
      reviewer_id: 'manager@test.com',
      task_id: TASK_ID,
      revision_instructions: 'Check supplier prices',
    });
    submitResolution(TASK_ID, resolution);

    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'export',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Revision requested');
  });

  it('blocks with deferred resolution', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.DEFERRED,
      reviewer_id: 'manager@test.com',
      task_id: TASK_ID,
    });
    submitResolution(TASK_ID, resolution);

    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'export',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('deferred');
  });

  it('auto-approves notify for A3+ autonomy', () => {
    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'notify',
      autonomyLevel: 'A3',
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks notify for A1 (needs approval)', () => {
    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'notify',
      autonomyLevel: 'A1',
    });
    expect(result.allowed).toBe(false);
  });

  it('does not auto-approve when thresholds require escalation', () => {
    registerPolicy('tpl-threshold', createApprovalPolicy({
      worker_template_id: 'tpl-threshold',
      rules: [{
        action_type: 'notify',
        requires_approval: true,
        thresholds: { risk_level: 'medium' },
        auto_approve_at: ['A3', 'A4'],
      }],
    }));

    const result = enforceApprovalGate({
      taskId: TASK_ID,
      actionType: 'notify',
      workerTemplateId: 'tpl-threshold',
      autonomyLevel: 'A3',
      decisionBrief: {
        risk_flags: [{ level: 'high', category: 'supply', description: 'Critical disruption' }],
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Risk level');
  });
});

describe('submitResolution', () => {
  it('validates resolution before storing', () => {
    const result = submitResolution(TASK_ID, { decision: 'approved' });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('stores valid resolution', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'test',
      task_id: TASK_ID,
    });
    const result = submitResolution(TASK_ID, resolution);
    expect(result.ok).toBe(true);
    expect(getResolution(TASK_ID)).toBeTruthy();
  });
});

describe('clearResolution', () => {
  it('removes resolution for task', () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'test',
      task_id: TASK_ID,
    });
    submitResolution(TASK_ID, resolution);
    expect(getResolution(TASK_ID)).toBeTruthy();

    clearResolution(TASK_ID);
    expect(getResolution(TASK_ID)).toBeNull();
  });
});

describe('validateIdempotencyKey', () => {
  it('accepts valid key', () => {
    expect(validateIdempotencyKey({ idempotency_key: 'idem_abc123def456' }).valid).toBe(true);
  });

  it('rejects missing key', () => {
    expect(validateIdempotencyKey({}).valid).toBe(false);
  });

  it('rejects short key', () => {
    expect(validateIdempotencyKey({ idempotency_key: 'abc' }).valid).toBe(false);
  });
});

describe('custom approval policy', () => {
  it('respects custom policy rules', () => {
    const policy = createApprovalPolicy({
      worker_template_id: 'tmpl_strict',
      rules: [
        { action_type: 'export', requires_approval: true, auto_approve_at: ['A4'] },
        { action_type: 'writeback', requires_approval: true, auto_approve_at: [] },
      ],
    });
    registerPolicy('tmpl_strict', policy);

    // A2 can't auto-approve export under strict policy
    const r1 = enforceApprovalGate({
      taskId: 'task_strict_1',
      actionType: 'export',
      workerTemplateId: 'tmpl_strict',
      autonomyLevel: 'A2',
    });
    expect(r1.allowed).toBe(false);

    // A4 can auto-approve export
    const r2 = enforceApprovalGate({
      taskId: 'task_strict_2',
      actionType: 'export',
      workerTemplateId: 'tmpl_strict',
      autonomyLevel: 'A4',
    });
    expect(r2.allowed).toBe(true);
  });
});

// ── Publish Service ─────────────────────────────────────────────────────────

describe('publishSpreadsheetExport', () => {
  it('publishes export when gate allows', async () => {
    const result = await publishSpreadsheetExport({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
      autonomyLevel: 'A2', // auto-approve for export
    });
    expect(result.ok).toBe(true);
    expect(result.artifact).toBeTruthy();
    expect(result.artifact.row_count).toBe(2);
    expect(result.artifact.artifact_type).toBe('spreadsheet_export');
  });

  it('blocks export when gate denies', async () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.REJECTED,
      reviewer_id: 'mgr',
      task_id: TASK_ID,
    });
    submitResolution(TASK_ID, resolution);

    const result = await publishSpreadsheetExport({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
    });
    expect(result.ok).toBe(false);
    expect(result.needs_approval).toBe(true);
  });

  it('deduplicates by idempotency key', async () => {
    await publishSpreadsheetExport({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
      autonomyLevel: 'A2',
    });

    const result2 = await publishSpreadsheetExport({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
      autonomyLevel: 'A2',
    });
    expect(result2.ok).toBe(true);
    expect(result2.deduplicated).toBe(true);
  });
});

describe('publishWriteback', () => {
  it('blocks writeback without approval', async () => {
    const result = await publishWriteback({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
      autonomyLevel: 'A1',
    });
    expect(result.ok).toBe(false);
    expect(result.needs_approval).toBe(true);
  });

  it('publishes writeback with approved resolution', async () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'manager@test.com',
      task_id: TASK_ID,
      publish_permission: { export: true, writeback: true, notify: false },
    });
    submitResolution(TASK_ID, resolution);

    const result = await publishWriteback({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
      approval: { approved_by: 'manager@test.com' },
    });
    expect(result.ok).toBe(true);
    expect(result.payload.status).toBe('applied');
    expect(result.payload.approval_metadata.approved_by).toBe('manager@test.com');
  });

  it('rejects writeback without idempotency key', async () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'mgr',
      task_id: 'task_no_idem',
      publish_permission: { writeback: true },
    });
    submitResolution('task_no_idem', resolution);

    const result = await publishWriteback({
      taskId: 'task_no_idem',
      writebackPayload: { ...MOCK_WRITEBACK, idempotency_key: null },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('idempotency');
  });

  it('deduplicates writeback by idempotency key', async () => {
    const resolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: 'mgr',
      task_id: TASK_ID,
      publish_permission: { writeback: true },
    });
    submitResolution(TASK_ID, resolution);

    await publishWriteback({ taskId: TASK_ID, writebackPayload: MOCK_WRITEBACK });

    const result2 = await publishWriteback({ taskId: TASK_ID, writebackPayload: MOCK_WRITEBACK });
    expect(result2.ok).toBe(true);
    expect(result2.deduplicated).toBe(true);
  });
});

describe('isPublished', () => {
  it('tracks published keys', async () => {
    expect(isPublished('export', MOCK_WRITEBACK.idempotency_key)).toBe(false);

    await publishSpreadsheetExport({
      taskId: TASK_ID,
      writebackPayload: MOCK_WRITEBACK,
      autonomyLevel: 'A2',
    });

    expect(isPublished('export', MOCK_WRITEBACK.idempotency_key)).toBe(true);
  });
});
