/**
 * Tests for Phase 7 — Integration Hardening
 *
 * Covers:
 *   - exportSchemaStabilizer — versioned schema + stable export
 *   - erpPayloadStabilizer — SAP IDoc fixtures + round-trip
 *   - idempotencyService — lock/check/mark lifecycle
 *   - publishRecoveryService — retry + exponential backoff
 *   - auditTrailService — audit trail completeness
 *   - signatureService — HMAC, permissions, authorization
 *   - replayTestingService — snapshot + replay validation
 */

import { describe, it, expect, beforeEach } from 'vitest';

// 7.1 — Export Schema Stabilizer
import {
  buildStableExport,
  validateSchemaCompatibility,
  getSchemaFingerprint,
  SCHEMA_VERSION,
  SCHEMA_VERSIONS,
} from './exportSchemaStabilizer.js';

// 7.2 — ERP Payload Stabilizer
import {
  buildStableErpPayload,
  validateRoundTrip,
  generateFixture,
  ERP_SCHEMA_VERSION,
  SAP_IDOC_FULL_FIXTURES,
} from './erpPayloadStabilizer.js';

// 7.3 — Idempotency
import {
  checkIdempotency,
  acquireLock,
  markCompleted,
  markFailed,
  getStats,
  _resetForTesting as resetIdempotency,
} from './idempotencyService.js';

// 7.4 — Recovery
import {
  executeWithRecovery,
  calculateRetryDelay,
  buildPublishAuditEntry,
} from './publishRecoveryService.js';

// 7.5 — Audit Trail
import {
  buildAuditEntry,
  buildFullAuditTrail,
  checkAuditCompleteness,
  formatAuditTrail,
  AUDIT_EVENTS,
} from './auditTrailService.js';

// 7.6 — Signature
import {
  generateSignature,
  verifySignature,
  checkPermission,
  authorizeAction,
  validateWebhookSignature,
  PERMISSIONS,
} from './signatureService.js';

// 7.7 — Replay
import {
  captureSnapshot,
  replayAndValidate,
  runReplayTestSuite,
} from './replayTestingService.js';

// ═══════════════════════════════════════════════════════════════════════════
// 7.1 — Export Schema Stabilizer
// ═══════════════════════════════════════════════════════════════════════════

describe('exportSchemaStabilizer', () => {
  it('SCHEMA_VERSION is frozen at 1.0.0', () => {
    expect(SCHEMA_VERSION).toBe('1.0.0');
    expect(SCHEMA_VERSIONS['1.0.0']).toBeDefined();
    expect(SCHEMA_VERSIONS['1.0.0'].frozen_at).toBe('2026-03-17');
  });

  it('getSchemaFingerprint returns stable hash', () => {
    const fp1 = getSchemaFingerprint();
    const fp2 = getSchemaFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^v1\.0\.0-/);
  });

  it('buildStableExport succeeds with valid rows', () => {
    const result = buildStableExport({
      rows: [
        { material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: 500 },
      ],
      taskId: 'test-task',
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    expect(result.artifact.schema_version).toBe(SCHEMA_VERSION);
    expect(result.artifact.schema_fingerprint).toBeTruthy();
    expect(result.artifact.row_count).toBe(1);
    expect(result.artifact.csv).toContain('material_code');
    expect(result.artifact.csv).toContain('MAT-001');
  });

  it('buildStableExport produces warnings for unknown columns', () => {
    const result = buildStableExport({
      rows: [{ material_code: 'M', plant_id: 'P', action: 'A', quantity: 1, unknown_col: 'x' }],
      taskId: 'test-task',
    });
    expect(result.ok).toBe(true);
    expect(result.artifact.warnings?.some(w => w.includes('unknown_col') || w.includes('Unknown'))).toBe(true);
  });

  it('validateSchemaCompatibility checks artifacts', () => {
    const artifact = { schema_version: '1.0.0', data: [{ material_code: 'M', plant_id: 'P', action: 'A', quantity: 1 }] };
    const check = validateSchemaCompatibility(artifact);
    expect(check.compatible).toBe(true);
  });

  it('validateSchemaCompatibility rejects unknown version', () => {
    const check = validateSchemaCompatibility({ schema_version: '9.9.9', data: [] });
    expect(check.compatible).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.2 — ERP Payload Stabilizer
// ═══════════════════════════════════════════════════════════════════════════

describe('erpPayloadStabilizer', () => {
  const VALID_WRITEBACK = {
    target_system: 'sap_mm',
    idempotency_key: 'test-key-123',
    intended_mutations: [{
      entity: 'purchase_order',
      action: 'create_po',
      field_changes: { material_code: 'MAT-001', plant_id: 'P10', quantity: 500 },
    }],
  };

  it('buildStableErpPayload succeeds with valid writeback', () => {
    const result = buildStableErpPayload(VALID_WRITEBACK);
    expect(result.ok).toBe(true);
    expect(result.payload.schema_version).toBe(ERP_SCHEMA_VERSION);
    expect(result.payload.source).toBe('digital_worker_v1');
  });

  it('buildStableErpPayload fails with missing required fields', () => {
    const result = buildStableErpPayload({
      target_system: 'sap_mm',
      intended_mutations: [{ action: 'create_po', field_changes: {} }],
    });
    expect(result.ok).toBe(false);
  });

  it('validateRoundTrip passes for valid payload', () => {
    const buildResult = buildStableErpPayload(VALID_WRITEBACK);
    const rtCheck = validateRoundTrip(buildResult.payload);
    expect(rtCheck.ok).toBe(true);
    expect(rtCheck.serialized_size).toBeGreaterThan(0);
  });

  it('generateFixture creates ORDERS05 fixture', () => {
    const result = generateFixture('ORDERS05', { material: 'MAT-999', quantity: 42 });
    expect(result.ok).toBe(true);
    expect(result.fixture.IDOC_TYPE).toBe('ORDERS05');
  });

  it('generateFixture creates MATMAS05 fixture', () => {
    const result = generateFixture('MATMAS05', { plant: 'P20' });
    expect(result.ok).toBe(true);
    expect(result.fixture.E1MARCM.WERKS).toBe('P20');
  });

  it('generateFixture creates LOIPRO fixture', () => {
    const result = generateFixture('LOIPRO');
    expect(result.ok).toBe(true);
    expect(result.fixture.IDOC_TYPE).toBe('LOIPRO');
  });

  it('SAP_IDOC_FULL_FIXTURES has all three IDoc types', () => {
    expect(SAP_IDOC_FULL_FIXTURES.purchase_order_create).toBeDefined();
    expect(SAP_IDOC_FULL_FIXTURES.safety_stock_adjust).toBeDefined();
    expect(SAP_IDOC_FULL_FIXTURES.production_order_create).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.3 — Idempotency Service
// ═══════════════════════════════════════════════════════════════════════════

describe('idempotencyService', () => {
  beforeEach(() => resetIdempotency());

  it('checkIdempotency returns false for unknown key', () => {
    const result = checkIdempotency('unknown', 'export');
    expect(result.exists).toBe(false);
  });

  it('acquireLock + markCompleted + check returns cached', () => {
    const lock = acquireLock('key-1', 'export', 'task-1');
    expect(lock.acquired).toBe(true);

    markCompleted('key-1', 'export', { path: '/tmp/export.csv' });

    const check = checkIdempotency('key-1', 'export');
    expect(check.exists).toBe(true);
    expect(check.record.status).toBe('completed');
    expect(check.record.result.path).toBe('/tmp/export.csv');
  });

  it('acquireLock rejects duplicate in-progress', () => {
    acquireLock('key-2', 'writeback', 'task-2');
    const dup = acquireLock('key-2', 'writeback', 'task-2');
    expect(dup.acquired).toBe(false);
    expect(dup.reason).toContain('in progress');
  });

  it('markFailed allows retry', () => {
    acquireLock('key-3', 'export', 'task-3');
    markFailed('key-3', 'export', 'Network error');

    const check = checkIdempotency('key-3', 'export');
    expect(check.exists).toBe(false); // failed = retryable

    const retry = acquireLock('key-3', 'export', 'task-3');
    expect(retry.acquired).toBe(true);
  });

  it('getStats reports counts', () => {
    acquireLock('a', 'export', 't1');
    markCompleted('a', 'export');
    acquireLock('b', 'export', 't2');
    markFailed('b', 'export', 'err');
    acquireLock('c', 'export', 't3');

    const stats = getStats();
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.in_progress).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.4 — Publish Recovery
// ═══════════════════════════════════════════════════════════════════════════

describe('publishRecoveryService', () => {
  beforeEach(() => resetIdempotency());

  it('executeWithRecovery succeeds on first try', async () => {
    const result = await executeWithRecovery({
      idempotencyKey: 'rec-1',
      operation: 'export',
      taskId: 'task-1',
      executeFn: async () => ({ ok: true, path: '/export.csv' }),
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.result.path).toBe('/export.csv');
  });

  it('executeWithRecovery deduplicates completed operations', async () => {
    // First run
    await executeWithRecovery({
      idempotencyKey: 'rec-2',
      operation: 'export',
      taskId: 'task-2',
      executeFn: async () => ({ ok: true }),
    });
    // Second run (same key)
    const dup = await executeWithRecovery({
      idempotencyKey: 'rec-2',
      operation: 'export',
      taskId: 'task-2',
      executeFn: async () => ({ ok: true }),
    });
    expect(dup.ok).toBe(true);
    expect(dup.deduplicated).toBe(true);
    expect(dup.attempts).toBe(0);
  });

  it('calculateRetryDelay uses exponential backoff', () => {
    expect(calculateRetryDelay(0)).toBe(1000);
    expect(calculateRetryDelay(1)).toBe(2000);
    expect(calculateRetryDelay(2)).toBe(4000);
    expect(calculateRetryDelay(10)).toBe(30000); // capped at MAX_DELAY
  });

  it('buildPublishAuditEntry has required fields', () => {
    const entry = buildPublishAuditEntry({
      taskId: 't', operation: 'export', idempotencyKey: 'k',
      attempt: 1, ok: true,
    });
    expect(entry.event_type).toBe('publish_attempt');
    expect(entry.task_id).toBe('t');
    expect(entry.timestamp).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.5 — Audit Trail
// ═══════════════════════════════════════════════════════════════════════════

describe('auditTrailService', () => {
  it('buildAuditEntry creates structured entry', () => {
    const entry = buildAuditEntry(AUDIT_EVENTS.TASK_RECEIVED, { source: 'event' }, { taskId: 't1' });
    expect(entry.audit_event).toBe('task_received');
    expect(entry.task_id).toBe('t1');
    expect(entry.data.source).toBe('event');
    expect(entry.timestamp).toBeTruthy();
  });

  it('buildFullAuditTrail aggregates all sources', () => {
    const trail = buildFullAuditTrail({
      worklogs: [{ event: 'task_received', task_id: 't1', created_at: '2026-01-01T00:00:00Z' }],
      steps: [{ status: 'succeeded', step_name: 's1', artifact_refs: [{ type: 'decision_brief' }] }],
      resolution: { decision: 'approved', reviewer_id: 'u1', task_id: 't1' },
      publishAttempts: [{ task_id: 't1', ok: true, operation: 'export', idempotency_key: 'k1' }],
      valueEvents: [{ task_id: 't1', worker_id: 'w1', value_type: 'cost_saved', value_amount: 5000, confidence: 0.8 }],
    });
    expect(trail.entries.length).toBeGreaterThanOrEqual(4);
    expect(trail.completeness.complete).toBe(true);
    expect(trail.completeness.score).toBeGreaterThan(0.5);
  });

  it('checkAuditCompleteness detects missing required events', () => {
    const result = checkAuditCompleteness([]);
    expect(result.complete).toBe(false);
    expect(result.missing.some(m => m.includes('task_received'))).toBe(true);
  });

  it('formatAuditTrail returns human-readable entries', () => {
    const entries = [
      buildAuditEntry(AUDIT_EVENTS.ARTIFACT_PRODUCED, { artifact_type: 'decision_brief', step_name: 'build_brief' }),
    ];
    const formatted = formatAuditTrail(entries);
    expect(formatted[0].summary).toContain('decision_brief');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.6 — Signature Service
// ═══════════════════════════════════════════════════════════════════════════

describe('signatureService', () => {
  it('generateSignature produces consistent output', async () => {
    const sig1 = await generateSignature({ foo: 'bar' }, 'secret');
    const sig2 = await generateSignature({ foo: 'bar' }, 'secret');
    expect(sig1).toBe(sig2);
    expect(typeof sig1).toBe('string');
    expect(sig1.length).toBeGreaterThan(0);
  });

  it('verifySignature accepts correct signature', async () => {
    const sig = await generateSignature('test-payload', 'my-secret');
    const valid = await verifySignature('test-payload', sig, 'my-secret');
    expect(valid).toBe(true);
  });

  it('verifySignature rejects wrong secret', async () => {
    const sig = await generateSignature('test-payload', 'my-secret');
    const valid = await verifySignature('test-payload', sig, 'wrong-secret');
    expect(valid).toBe(false);
  });

  it('checkPermission allows admin all actions', () => {
    expect(checkPermission('admin', PERMISSIONS.PUBLISH_EXPORT).allowed).toBe(true);
    expect(checkPermission('admin', PERMISSIONS.PUBLISH_WRITEBACK).allowed).toBe(true);
    expect(checkPermission('admin', PERMISSIONS.DELEGATION_CREATE).allowed).toBe(true);
  });

  it('checkPermission restricts viewer', () => {
    expect(checkPermission('viewer', PERMISSIONS.PUBLISH_EXPORT).allowed).toBe(false);
    expect(checkPermission('viewer', PERMISSIONS.AUDIT_READ).allowed).toBe(true);
  });

  it('authorizeAction returns receipt for allowed action', () => {
    const auth = authorizeAction({
      userId: 'u1', role: 'manager',
      action: PERMISSIONS.PUBLISH_EXPORT,
      taskId: 't1', idempotencyKey: 'k1',
    });
    expect(auth.authorized).toBe(true);
    expect(auth.receipt.receipt_id).toBeTruthy();
    expect(auth.audit.allowed).toBe(true);
  });

  it('authorizeAction rejects unauthorized role', () => {
    const auth = authorizeAction({
      userId: 'u1', role: 'viewer',
      action: PERMISSIONS.PUBLISH_WRITEBACK,
      taskId: 't1', idempotencyKey: 'k1',
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('viewer');
  });

  it('validateWebhookSignature rejects missing signature', async () => {
    const result = await validateWebhookSignature({ body: 'data', signature: null, secret: 's' });
    expect(result.valid).toBe(false);
  });

  it('validateWebhookSignature accepts valid signature', async () => {
    const sig = await generateSignature('webhook-body', 'webhook-secret');
    const result = await validateWebhookSignature({ body: 'webhook-body', signature: sig, secret: 'webhook-secret' });
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7.7 — Replay Testing
// ═══════════════════════════════════════════════════════════════════════════

describe('replayTestingService', () => {
  beforeEach(() => resetIdempotency());

  function makeSnapshotData() {
    return {
      workOrder: { intent_type: 'inventory_replan', task_id: 'replay-1' },
      steps: [{ step_name: 'analyze', status: 'succeeded', artifact_refs: [] }],
      decisionBrief: { recommended_action: 'replenish', confidence: 0.85, risk_flags: [] },
      writebackPayload: {
        target_system: 'sap_mm',
        idempotency_key: `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        intended_mutations: [{ action: 'create_po', field_changes: { material_code: 'M1', plant_id: 'P1', quantity: 100 } }],
      },
      exportArtifact: {
        schema_version: '1.0.0',
        format: 'csv',
        row_count: 1,
        data: [{ material_code: 'M1', plant_id: 'P1', action: 'create_po', quantity: 100 }],
      },
      auditEntries: [
        { audit_event: 'task_received', timestamp: '2026-01-01T00:00:00Z' },
        { audit_event: 'artifact_produced', timestamp: '2026-01-01T00:01:00Z' },
        { audit_event: 'review_submitted', timestamp: '2026-01-01T00:02:00Z' },
        { audit_event: 'publish_succeeded', timestamp: '2026-01-01T00:03:00Z' },
        { audit_event: 'value_recorded', timestamp: '2026-01-01T00:04:00Z' },
      ],
    };
  }

  it('captureSnapshot produces valid snapshot', () => {
    const snapshot = captureSnapshot(makeSnapshotData());
    expect(snapshot.snapshot_version).toBe('1.0');
    expect(snapshot.captured_at).toBeTruthy();
    expect(snapshot.checksums).toBeDefined();
    expect(snapshot.artifacts.decision_brief).toBeTruthy();
  });

  it('replayAndValidate passes for valid snapshot', () => {
    const snapshot = captureSnapshot(makeSnapshotData());
    const result = replayAndValidate(snapshot);
    expect(result.passed).toBe(true);
    expect(result.summary.failed).toBe(0);
  });

  it('replayAndValidate detects determinism diffs', () => {
    const snapshot = captureSnapshot(makeSnapshotData());
    const altArtifacts = {
      writeback_payload: {
        intended_mutations: [{ a: 1 }, { b: 2 }, { c: 3 }], // different count
        target_system: 'sap_mm',
      },
    };
    const result = replayAndValidate(snapshot, altArtifacts);
    const deterTest = result.results.find(r => r.test === 'artifact_determinism');
    expect(deterTest).toBeDefined();
    expect(deterTest.passed).toBe(false);
  });

  it('runReplayTestSuite runs multiple snapshots', () => {
    const s1 = captureSnapshot(makeSnapshotData());
    const s2 = captureSnapshot(makeSnapshotData());
    const suite = runReplayTestSuite([s1, s2]);
    expect(suite.total).toBe(2);
    expect(suite.passed).toBe(true);
  });
});
