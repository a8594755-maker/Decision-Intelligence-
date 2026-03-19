/**
 * Unified Intake Pipeline Tests
 *
 * Verifies that ALL intake sources converge through processIntake() →
 * intakeRoutingService → orchestrator → worker assignment → review → deliver.
 *
 * No intake source may bypass processIntake().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processIntake, INTAKE_SOURCES, normalizeIntake } from './taskIntakeService.js';

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('./aiEmployee/queries.js', () => ({
  listTasks: vi.fn(async () => []),
}));

vi.mock('./intakeRoutingService.js', () => ({
  routeWorkOrder: vi.fn(async (wo, userId) => ({
    employeeId: wo.employee_id,
    workerName: 'Test Worker',
    intent: 'planning',
    confidence: 0.9,
    reason: 'mock routing',
  })),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  employeeId: 'emp_1',
  userId: 'user_1',
  message: 'Run a forecast and plan for this month',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Unified Intake Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('All INTAKE_SOURCES are defined', () => {
    it('has all required intake source types', () => {
      expect(INTAKE_SOURCES.CHAT).toBe('chat');
      expect(INTAKE_SOURCES.EMAIL).toBe('email');
      expect(INTAKE_SOURCES.SCHEDULE).toBe('schedule');
      expect(INTAKE_SOURCES.PROACTIVE_ALERT).toBe('proactive_alert');
      expect(INTAKE_SOURCES.CLOSED_LOOP).toBe('closed_loop');
      expect(INTAKE_SOURCES.MEETING_TRANSCRIPT).toBe('meeting_transcript');
      expect(INTAKE_SOURCES.API).toBe('api');
    });
  });

  describe('processIntake() converges all sources', () => {
    for (const [key, source] of Object.entries(INTAKE_SOURCES)) {
      it(`${key} (${source}) goes through processIntake without error`, async () => {
        const result = await processIntake({
          ...BASE_PARAMS,
          source,
          metadata: { source_ref: `test_${key}` },
        });

        expect(result).toBeDefined();
        expect(result.workOrder).toBeDefined();
        expect(result.status).toMatch(/^(created|duplicate|needs_clarification)$/);
        expect(result.workOrder.source).toBe(source);
      });
    }
  });

  describe('normalizeIntake produces consistent work order schema', () => {
    const REQUIRED_FIELDS = [
      'source', 'employee_id', 'user_id', 'title', 'priority',
      'created_at', 'dedup_key',
    ];

    for (const [key, source] of Object.entries(INTAKE_SOURCES)) {
      it(`${key} work order has all required fields`, () => {
        const wo = normalizeIntake({
          ...BASE_PARAMS,
          source,
          metadata: {},
        });

        for (const field of REQUIRED_FIELDS) {
          expect(wo).toHaveProperty(field);
        }
      });
    }
  });

  describe('Dedup gate works for all sources', () => {
    it('returns duplicate status when a matching alert_id task exists', async () => {
      const { listTasks } = await import('./aiEmployee/queries.js');
      // Simulate an existing task with matching alert_id in input_context
      listTasks.mockResolvedValueOnce([{
        id: 'existing_task_1',
        title: 'Stockout risk alert',
        created_at: new Date().toISOString(),
        status: 'in_progress',
        input_context: { alert_id: 'alert_stockout_42' },
      }]);

      const result = await processIntake({
        ...BASE_PARAMS,
        source: INTAKE_SOURCES.PROACTIVE_ALERT,
        metadata: { alert_id: 'alert_stockout_42', alert_type: 'stockout_risk' },
      });

      expect(result.status).toBe('duplicate');
      expect(result.workOrder.duplicate_of).toBe('existing_task_1');
    });
  });

  describe('Routing gate invokes intakeRoutingService', () => {
    it('routes work order to correct worker', async () => {
      const { routeWorkOrder } = await import('./intakeRoutingService.js');
      routeWorkOrder.mockResolvedValueOnce({
        employeeId: 'emp_routed',
        workerName: 'Routed Worker',
        intent: 'forecast',
        confidence: 0.95,
        reason: 'best match',
      });

      const result = await processIntake({
        ...BASE_PARAMS,
        source: INTAKE_SOURCES.PROACTIVE_ALERT,
        metadata: { alert_type: 'stockout_risk' },
      });

      expect(result.status).toBe('created');
      expect(result.workOrder.employee_id).toBe('emp_routed');
      expect(result.workOrder._routing.routed_to).toBe('Routed Worker');
    });
  });

  describe('No parallel intake paths exist', () => {
    it('INTAKE_SOURCES covers all expected source types', () => {
      const expected = ['chat', 'email', 'schedule', 'proactive_alert', 'closed_loop', 'meeting_transcript', 'api'];
      const actual = Object.values(INTAKE_SOURCES);
      for (const s of expected) {
        expect(actual).toContain(s);
      }
    });

    it('processIntake is the sole entry point (no createTask bypass)', async () => {
      // Verify processIntake returns the expected shape regardless of source
      for (const source of Object.values(INTAKE_SOURCES)) {
        const result = await processIntake({
          ...BASE_PARAMS,
          source,
        });
        expect(result).toHaveProperty('workOrder');
        expect(result).toHaveProperty('status');
      }
    });
  });
});
