/**
 * hardening.test.js — Tests for Integration Hardening services (Phase 7)
 *
 * Covers:
 *   - exportSchemaValidator: schema validation, normalization, CSV export
 *   - erpAdapterPayload: ERP transformation, validation, SAP IDoc fixtures
 *   - idempotencyService: lock acquisition, completion, stale detection
 *   - publishRecoveryService: retry, backoff, idempotency-protected execution
 *   - auditTrailService: entry building, full trail, completeness scoring
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── exportSchemaValidator ───────────────────────────────────────────────────

import {
  EXPORT_COLUMNS,
  validateExportSchema,
  normalizeExportRows,
  exportToCsv,
} from './exportSchemaValidator.js';

describe('exportSchemaValidator', () => {
  describe('EXPORT_COLUMNS', () => {
    it('defines 10 columns with required and optional fields', () => {
      expect(EXPORT_COLUMNS).toHaveLength(10);
      const required = EXPORT_COLUMNS.filter(c => c.required);
      expect(required.map(c => c.key)).toEqual([
        'material_code', 'plant_id', 'action', 'quantity',
      ]);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(EXPORT_COLUMNS)).toBe(true);
    });
  });

  describe('validateExportSchema', () => {
    it('returns valid for correct data', () => {
      const artifact = {
        data: [
          { material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: 100 },
          { material_code: 'MAT-002', plant_id: 'P20', action: 'create_po', quantity: 200 },
        ],
      };
      const result = validateExportSchema(artifact);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns errors for missing required columns', () => {
      const artifact = {
        data: [{ material_code: 'MAT-001', quantity: 100 }],
      };
      const result = validateExportSchema(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('plant_id'))).toBe(true);
      expect(result.errors.some(e => e.includes('action'))).toBe(true);
    });

    it('returns warnings for unknown columns', () => {
      const artifact = {
        data: [
          { material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: 100, custom_field: 'hello' },
        ],
      };
      const result = validateExportSchema(artifact);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('custom_field'))).toBe(true);
    });

    it('returns warning for empty data', () => {
      const result = validateExportSchema({ data: [] });
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
    });

    it('rejects null artifact', () => {
      const result = validateExportSchema(null);
      expect(result.valid).toBe(false);
    });

    it('rejects non-array data', () => {
      const result = validateExportSchema({ data: 'not-an-array' });
      expect(result.valid).toBe(false);
    });

    it('warns on type mismatches', () => {
      const artifact = {
        data: [
          { material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: 'not-a-number' },
        ],
      };
      const result = validateExportSchema(artifact);
      expect(result.warnings.some(w => w.includes('quantity'))).toBe(true);
    });
  });

  describe('normalizeExportRows', () => {
    it('fills missing optional columns with null', () => {
      const rows = [{ material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: 100 }];
      const normalized = normalizeExportRows(rows);
      expect(normalized[0].order_date).toBeNull();
      expect(normalized[0].supplier_id).toBeNull();
      expect(normalized[0].unit_cost).toBeNull();
    });

    it('coerces numeric strings to numbers', () => {
      const rows = [{ material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: '100' }];
      const normalized = normalizeExportRows(rows);
      expect(normalized[0].quantity).toBe(100);
    });

    it('preserves extra columns', () => {
      const rows = [{ material_code: 'MAT-001', plant_id: 'P10', action: 'x', quantity: 1, custom: 'val' }];
      const normalized = normalizeExportRows(rows);
      expect(normalized[0].custom).toBe('val');
    });

    it('returns empty array for non-array input', () => {
      expect(normalizeExportRows(null)).toEqual([]);
      expect(normalizeExportRows('bad')).toEqual([]);
    });
  });

  describe('exportToCsv', () => {
    it('generates valid CSV with header', () => {
      const rows = [{ material_code: 'MAT-001', plant_id: 'P10', action: 'create_po', quantity: 100 }];
      const normalized = normalizeExportRows(rows);
      const csv = exportToCsv(normalized);
      const lines = csv.split('\n');
      expect(lines[0]).toContain('material_code');
      expect(lines[1]).toContain('MAT-001');
    });

    it('quotes values with commas', () => {
      const rows = normalizeExportRows([
        { material_code: 'MAT,001', plant_id: 'P10', action: 'create', quantity: 1 },
      ]);
      const csv = exportToCsv(rows);
      expect(csv).toContain('"MAT,001"');
    });

    it('returns empty string for empty input', () => {
      expect(exportToCsv([])).toBe('');
      expect(exportToCsv(null)).toBe('');
    });
  });
});

// ── erpAdapterPayload ───────────────────────────────────────────────────────

import {
  ERP_SCHEMAS,
  transformToErpPayload,
  validateForErp,
  SAP_IDOC_FIXTURES,
} from './erpAdapterPayload.js';

describe('erpAdapterPayload', () => {
  const validPayload = {
    target_system: 'sap_mm',
    idempotency_key: 'test-key-1',
    approval_metadata: { approved_by: 'user1' },
    intended_mutations: [
      {
        action: 'create_po',
        entity: 'purchase_order',
        field_changes: {
          material_code: 'MAT-001',
          plant_id: 'P10',
          quantity: 500,
        },
      },
    ],
  };

  describe('ERP_SCHEMAS', () => {
    it('defines sap_mm, oracle_scm, and generic schemas', () => {
      expect(ERP_SCHEMAS.sap_mm).toBeDefined();
      expect(ERP_SCHEMAS.oracle_scm).toBeDefined();
      expect(ERP_SCHEMAS.generic).toBeDefined();
    });

    it('each schema has a transform function', () => {
      for (const schema of Object.values(ERP_SCHEMAS)) {
        expect(typeof schema.transform).toBe('function');
      }
    });

    it('sap_mm transform produces IDoc structure', () => {
      const mutation = { field_changes: { material_code: 'MAT-X', plant_id: 'P1', quantity: 10 } };
      const result = ERP_SCHEMAS.sap_mm.transform(mutation);
      expect(result.IDOC_TYPE).toBe('MATMAS05');
      expect(result.E1MARAM.MATNR).toBe('MAT-X');
      expect(result.E1MARCM.WERKS).toBe('P1');
    });

    it('oracle_scm transform produces PurchaseOrder structure', () => {
      const mutation = { field_changes: { material_code: 'MAT-Y', plant_id: 'P2', quantity: 20 } };
      const result = ERP_SCHEMAS.oracle_scm.transform(mutation);
      expect(result.OrderType).toBe('STANDARD');
      expect(result.Lines[0].ItemNumber).toBe('MAT-Y');
      expect(result.Lines[0].Quantity).toBe(20);
    });
  });

  describe('transformToErpPayload', () => {
    it('transforms valid payload to SAP format', () => {
      const result = transformToErpPayload(validPayload);
      expect(result.ok).toBe(true);
      expect(result.adapter_payload.target_system).toBe('sap_mm');
      expect(result.adapter_payload.records).toHaveLength(1);
      expect(result.adapter_payload.records[0].IDOC_TYPE).toBe('MATMAS05');
    });

    it('falls back to generic for unknown target system', () => {
      const payload = { ...validPayload, target_system: 'unknown_erp' };
      const result = transformToErpPayload(payload);
      expect(result.ok).toBe(true);
      expect(result.adapter_payload.target_system).toBe('unknown_erp');
    });

    it('fails with no mutations', () => {
      const result = transformToErpPayload({ intended_mutations: [] });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('No mutations');
    });

    it('fails with missing required fields', () => {
      const payload = {
        target_system: 'sap_mm',
        intended_mutations: [{ field_changes: { material_code: 'MAT-001' } }],
      };
      const result = transformToErpPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.includes('plant_id'))).toBe(true);
      expect(result.errors.some(e => e.includes('quantity'))).toBe(true);
    });

    it('includes idempotency_key and approval_metadata in output', () => {
      const result = transformToErpPayload(validPayload);
      expect(result.adapter_payload.idempotency_key).toBe('test-key-1');
      expect(result.adapter_payload.approval_metadata.approved_by).toBe('user1');
    });
  });

  describe('validateForErp', () => {
    it('validates against specific ERP schema', () => {
      const result = validateForErp(validPayload, 'sap_mm');
      expect(result.valid).toBe(true);
    });

    it('returns errors for unknown ERP system', () => {
      const result = validateForErp(validPayload, 'nonexistent');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown ERP');
    });

    it('detects missing fields', () => {
      const payload = {
        intended_mutations: [{ field_changes: { material_code: 'X' } }],
      };
      const result = validateForErp(payload, 'oracle_scm');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('SAP_IDOC_FIXTURES', () => {
    it('provides purchase_order and material_master fixtures', () => {
      expect(SAP_IDOC_FIXTURES.purchase_order).toBeDefined();
      expect(SAP_IDOC_FIXTURES.material_master).toBeDefined();
      expect(SAP_IDOC_FIXTURES.purchase_order.IDOC_TYPE).toBe('ORDERS05');
      expect(SAP_IDOC_FIXTURES.material_master.IDOC_TYPE).toBe('MATMAS05');
    });
  });
});

// ── idempotencyService ──────────────────────────────────────────────────────

import {
  checkIdempotency,
  acquireLock,
  markCompleted,
  markFailed,
  listRecords,
  getStats,
  _resetForTesting,
} from './idempotencyService.js';

describe('idempotencyService', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('checkIdempotency', () => {
    it('returns exists:false for unknown key', () => {
      const result = checkIdempotency('key1', 'export');
      expect(result.exists).toBe(false);
    });

    it('returns exists:true for completed operation', () => {
      acquireLock('key1', 'export', 'task1');
      markCompleted('key1', 'export', { ok: true });
      const result = checkIdempotency('key1', 'export');
      expect(result.exists).toBe(true);
      expect(result.record.status).toBe('completed');
    });

    it('returns exists:true for in-progress operation', () => {
      acquireLock('key1', 'export', 'task1');
      const result = checkIdempotency('key1', 'export');
      expect(result.exists).toBe(true);
      expect(result.record.status).toBe('in_progress');
    });

    it('returns exists:false for failed operation (allows retry)', () => {
      acquireLock('key1', 'export', 'task1');
      markFailed('key1', 'export', 'network error');
      const result = checkIdempotency('key1', 'export');
      expect(result.exists).toBe(false);
    });

    it('differentiates operations on same key', () => {
      acquireLock('key1', 'export', 'task1');
      markCompleted('key1', 'export', { ok: true });
      const exportCheck = checkIdempotency('key1', 'export');
      const writebackCheck = checkIdempotency('key1', 'writeback');
      expect(exportCheck.exists).toBe(true);
      expect(writebackCheck.exists).toBe(false);
    });
  });

  describe('acquireLock', () => {
    it('acquires lock for new operation', () => {
      const result = acquireLock('key1', 'export', 'task1');
      expect(result.acquired).toBe(true);
    });

    it('rejects lock for completed operation', () => {
      acquireLock('key1', 'export', 'task1');
      markCompleted('key1', 'export', {});
      const result = acquireLock('key1', 'export', 'task2');
      expect(result.acquired).toBe(false);
      expect(result.reason).toContain('completed');
    });

    it('rejects lock for in-progress operation', () => {
      acquireLock('key1', 'export', 'task1');
      const result = acquireLock('key1', 'export', 'task2');
      expect(result.acquired).toBe(false);
      expect(result.reason).toContain('in progress');
    });

    it('allows lock after failure (retry)', () => {
      acquireLock('key1', 'export', 'task1');
      markFailed('key1', 'export', 'error');
      const result = acquireLock('key1', 'export', 'task1');
      expect(result.acquired).toBe(true);
    });
  });

  describe('markCompleted / markFailed', () => {
    it('stores result on completion', () => {
      acquireLock('key1', 'export', 'task1');
      markCompleted('key1', 'export', { rows: 10 });
      const check = checkIdempotency('key1', 'export');
      expect(check.record.result.rows).toBe(10);
      expect(check.record.completedAt).toBeDefined();
    });

    it('stores error on failure', () => {
      acquireLock('key1', 'export', 'task1');
      markFailed('key1', 'export', 'timeout');
      const stats = getStats();
      expect(stats.failed).toBe(1);
    });
  });

  describe('listRecords / getStats', () => {
    it('returns all records', () => {
      acquireLock('k1', 'export', 't1');
      acquireLock('k2', 'writeback', 't2');
      markCompleted('k1', 'export', {});
      const records = listRecords();
      expect(records).toHaveLength(2);
    });

    it('counts by status', () => {
      acquireLock('k1', 'export', 't1');
      acquireLock('k2', 'writeback', 't2');
      markCompleted('k1', 'export', {});
      markFailed('k2', 'writeback', 'err');
      const stats = getStats();
      expect(stats.total).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.in_progress).toBe(0);
    });
  });

  describe('_resetForTesting', () => {
    it('clears all records', () => {
      acquireLock('k1', 'export', 't1');
      _resetForTesting();
      expect(listRecords()).toHaveLength(0);
    });
  });
});

// ── publishRecoveryService ──────────────────────────────────────────────────

import {
  executeWithRecovery,
  calculateRetryDelay,
  buildPublishAuditEntry,
} from './publishRecoveryService.js';

describe('publishRecoveryService', () => {
  beforeEach(() => {
    _resetForTesting(); // clear idempotency registry
  });

  describe('executeWithRecovery', () => {
    it('succeeds on first attempt', async () => {
      const result = await executeWithRecovery({
        idempotencyKey: 'test-1',
        operation: 'export',
        taskId: 'task-1',
        executeFn: async () => ({ ok: true, data: 'exported' }),
      });
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.deduplicated).toBeUndefined();
    });

    it('returns deduplicated result for completed operation', async () => {
      // First execution
      await executeWithRecovery({
        idempotencyKey: 'test-2',
        operation: 'export',
        taskId: 'task-2',
        executeFn: async () => ({ ok: true }),
      });
      // Second execution with same key
      const result = await executeWithRecovery({
        idempotencyKey: 'test-2',
        operation: 'export',
        taskId: 'task-2',
        executeFn: async () => ({ ok: true }),
      });
      expect(result.ok).toBe(true);
      expect(result.deduplicated).toBe(true);
      expect(result.attempts).toBe(0);
    });

    it('retries on failure and succeeds', async () => {
      let callCount = 0;
      const result = await executeWithRecovery({
        idempotencyKey: 'test-3',
        operation: 'export',
        taskId: 'task-3',
        maxRetries: 2,
        executeFn: async () => {
          callCount++;
          if (callCount < 3) return { ok: false, error: 'transient' };
          return { ok: true, data: 'done' };
        },
      });
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('exhausts retries and fails', async () => {
      const result = await executeWithRecovery({
        idempotencyKey: 'test-4',
        operation: 'export',
        taskId: 'task-4',
        maxRetries: 1,
        executeFn: async () => ({ ok: false, error: 'persistent failure' }),
      });
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(2); // initial + 1 retry
      expect(result.retryable).toBe(true);
    });

    it('does not retry non-retryable errors', async () => {
      const result = await executeWithRecovery({
        idempotencyKey: 'test-5',
        operation: 'export',
        taskId: 'task-5',
        maxRetries: 3,
        executeFn: async () => ({ ok: false, error: 'idempotency conflict', needs_approval: true }),
      });
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.retryable).toBe(false);
    });

    it('handles exceptions as retryable', async () => {
      let callCount = 0;
      const result = await executeWithRecovery({
        idempotencyKey: 'test-6',
        operation: 'export',
        taskId: 'task-6',
        maxRetries: 1,
        executeFn: async () => {
          callCount++;
          if (callCount === 1) throw new Error('network timeout');
          return { ok: true };
        },
      });
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  describe('calculateRetryDelay', () => {
    it('returns initial delay for attempt 0', () => {
      expect(calculateRetryDelay(0, 1000)).toBe(1000);
    });

    it('doubles delay for each attempt', () => {
      expect(calculateRetryDelay(1, 1000)).toBe(2000);
      expect(calculateRetryDelay(2, 1000)).toBe(4000);
    });

    it('caps at MAX_DELAY_MS (30000)', () => {
      expect(calculateRetryDelay(10, 1000)).toBe(30000);
    });
  });

  describe('buildPublishAuditEntry', () => {
    it('builds a structured audit entry', () => {
      const entry = buildPublishAuditEntry({
        taskId: 'task-1',
        operation: 'export',
        idempotencyKey: 'key-1',
        attempt: 1,
        ok: true,
      });
      expect(entry.event_type).toBe('publish_attempt');
      expect(entry.task_id).toBe('task-1');
      expect(entry.ok).toBe(true);
      expect(entry.timestamp).toBeDefined();
    });

    it('includes error for failed attempts', () => {
      const entry = buildPublishAuditEntry({
        taskId: 'task-1',
        operation: 'writeback',
        idempotencyKey: 'key-1',
        attempt: 2,
        ok: false,
        error: 'connection refused',
      });
      expect(entry.ok).toBe(false);
      expect(entry.error).toBe('connection refused');
    });
  });
});

// ── auditTrailService ───────────────────────────────────────────────────────

import {
  AUDIT_EVENTS,
  buildAuditEntry,
  buildFullAuditTrail,
  checkAuditCompleteness,
  formatAuditTrail,
} from './auditTrailService.js';

describe('auditTrailService', () => {
  describe('AUDIT_EVENTS', () => {
    it('defines all 16 event types', () => {
      const values = Object.values(AUDIT_EVENTS);
      expect(values.length).toBeGreaterThanOrEqual(16);
      expect(values).toContain('task_received');
      expect(values).toContain('artifact_produced');
      expect(values).toContain('publish_succeeded');
      expect(values).toContain('value_recorded');
      expect(values).toContain('self_heal');
    });

    it('is frozen', () => {
      expect(Object.isFrozen(AUDIT_EVENTS)).toBe(true);
    });
  });

  describe('buildAuditEntry', () => {
    it('builds entry with all context fields', () => {
      const entry = buildAuditEntry(
        AUDIT_EVENTS.TASK_RECEIVED,
        { source: 'event_queue' },
        { taskId: 't1', workerId: 'w1', stepName: 'ingest', userId: 'u1' },
      );
      expect(entry.audit_event).toBe('task_received');
      expect(entry.task_id).toBe('t1');
      expect(entry.worker_id).toBe('w1');
      expect(entry.step_name).toBe('ingest');
      expect(entry.user_id).toBe('u1');
      expect(entry.data.source).toBe('event_queue');
      expect(entry.timestamp).toBeDefined();
    });

    it('defaults context fields to null', () => {
      const entry = buildAuditEntry(AUDIT_EVENTS.PHASE_STARTED, {});
      expect(entry.task_id).toBeNull();
      expect(entry.worker_id).toBeNull();
    });
  });

  describe('buildFullAuditTrail', () => {
    it('assembles trail from worklogs, steps, resolution, publish, and value events', () => {
      const { entries, completeness } = buildFullAuditTrail({
        worklogs: [
          { event: 'task_received', task_id: 't1', employee_id: 'w1', created_at: '2026-01-01T00:00:00Z' },
        ],
        steps: [
          {
            task_id: 't1',
            step_name: 'forecast',
            step_index: 0,
            status: 'succeeded',
            artifact_refs: [{ artifact_type: 'forecast_series', type: 'forecast_series' }],
          },
        ],
        resolution: {
          task_id: 't1',
          decision: 'approved',
          reviewer_id: 'user1',
          publish_permission: { export: true },
          review_notes: 'LGTM',
        },
        publishAttempts: [
          { task_id: 't1', ok: true, operation: 'export', idempotency_key: 'abc123' },
        ],
        valueEvents: [
          { task_id: 't1', worker_id: 'w1', value_type: 'cost_saved', value_amount: 5000, confidence: 0.8 },
        ],
      });

      // Should have 5 entries: 1 worklog + 1 artifact + 1 review + 1 publish + 1 value
      expect(entries).toHaveLength(5);

      // Should be sorted by timestamp
      for (let i = 1; i < entries.length; i++) {
        expect((entries[i].timestamp || '') >= (entries[i - 1].timestamp || '')).toBe(true);
      }

      // Completeness should be complete (has task_received and artifact_produced)
      expect(completeness.complete).toBe(true);
    });

    it('handles empty inputs', () => {
      const { entries, completeness } = buildFullAuditTrail({});
      expect(entries).toHaveLength(0);
      expect(completeness.complete).toBe(false);
    });

    it('skips artifacts for non-succeeded steps', () => {
      const { entries } = buildFullAuditTrail({
        steps: [
          { task_id: 't1', step_name: 'forecast', status: 'failed', artifact_refs: [{ type: 'x' }] },
        ],
      });
      expect(entries).toHaveLength(0);
    });
  });

  describe('checkAuditCompleteness', () => {
    it('returns complete when required events present', () => {
      const entries = [
        { audit_event: 'task_received' },
        { audit_event: 'artifact_produced' },
      ];
      const result = checkAuditCompleteness(entries);
      expect(result.complete).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('returns incomplete when required events missing', () => {
      const entries = [{ audit_event: 'publish_succeeded' }];
      const result = checkAuditCompleteness(entries);
      expect(result.complete).toBe(false);
      expect(result.missing.some(m => m.includes('[required]'))).toBe(true);
    });

    it('includes desired events in missing list', () => {
      const entries = [
        { audit_event: 'task_received' },
        { audit_event: 'artifact_produced' },
      ];
      const result = checkAuditCompleteness(entries);
      expect(result.missing.some(m => m.includes('[desired]'))).toBe(true);
    });

    it('scores 1.0 when all events present', () => {
      const entries = [
        { audit_event: 'task_received' },
        { audit_event: 'artifact_produced' },
        { audit_event: 'review_submitted' },
        { audit_event: 'publish_succeeded' },
        { audit_event: 'value_recorded' },
      ];
      const result = checkAuditCompleteness(entries);
      expect(result.score).toBe(1);
      expect(result.missing).toHaveLength(0);
    });
  });

  describe('formatAuditTrail', () => {
    it('formats entries for display', () => {
      const entries = [
        {
          audit_event: AUDIT_EVENTS.ARTIFACT_PRODUCED,
          timestamp: '2026-01-01T00:00:00Z',
          user_id: null,
          worker_id: 'w1',
          step_name: 'forecast',
          data: { artifact_type: 'forecast_series', step_name: 'forecast' },
        },
      ];
      const formatted = formatAuditTrail(entries);
      expect(formatted).toHaveLength(1);
      expect(formatted[0].event).toBe('artifact_produced');
      expect(formatted[0].actor).toBe('w1');
      expect(formatted[0].summary).toContain('Produced');
    });

    it('uses "system" as default actor', () => {
      const entries = [
        { audit_event: 'unknown', timestamp: '2026-01-01', data: {} },
      ];
      const formatted = formatAuditTrail(entries);
      expect(formatted[0].actor).toBe('system');
    });

    it('formats review events with reviewer info', () => {
      const entries = [
        {
          audit_event: AUDIT_EVENTS.REVIEW_SUBMITTED,
          timestamp: '2026-01-01',
          user_id: 'reviewer1',
          data: { decision: 'approved', reviewer_id: 'reviewer1' },
        },
      ];
      const formatted = formatAuditTrail(entries);
      expect(formatted[0].summary).toContain('approved');
      expect(formatted[0].summary).toContain('reviewer1');
    });

    it('formats value events with amount', () => {
      const entries = [
        {
          audit_event: AUDIT_EVENTS.VALUE_RECORDED,
          timestamp: '2026-01-01',
          worker_id: 'w1',
          data: { value_type: 'cost_saved', value_amount: 5000, confidence: 0.85 },
        },
      ];
      const formatted = formatAuditTrail(entries);
      expect(formatted[0].summary).toContain('5000');
      expect(formatted[0].summary).toContain('85%');
    });
  });
});
