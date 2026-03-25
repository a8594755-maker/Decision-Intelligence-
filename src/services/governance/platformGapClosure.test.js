/**
 * platformGapClosure.test.js — Tests for the 5 gap-closure services
 *
 * Covers:
 *   1. intakeRoutingService — intent detection + worker scoring
 *   2. emailIntakeEndpoint — request handling + rate limiting
 *   3. toolPermissionGuard — tier restrictions + combined checks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Intake Routing Service ───────────────────────────────────────────────

import { detectIntent, getSourceCapabilityHint } from '../chat/intakeRoutingService.js';

describe('intakeRoutingService', () => {
  describe('detectIntent()', () => {
    it('detects forecast intent from English keywords', () => {
      const result = detectIntent({ title: 'Run demand forecast for Q2', description: '' });
      expect(result.intent).toBe('forecast');
      expect(result.capabilities).toContain('forecast');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('detects planning intent from Chinese keywords', () => {
      const result = detectIntent({ title: '補貨計畫', description: '庫存不足需要補貨' });
      expect(result.intent).toBe('planning');
      expect(result.capabilities).toContain('planning');
    });

    it('detects risk intent', () => {
      const result = detectIntent({ title: 'Supply shortage alert', description: 'Material delay disruption' });
      expect(result.intent).toBe('risk');
    });

    it('detects procurement intent', () => {
      const result = detectIntent({ title: '', description: 'Negotiate with supplier for better quote' });
      expect(result.intent).toBe('procurement');
    });

    it('detects reporting intent', () => {
      const result = detectIntent({ title: 'Generate MBR report and KPI summary', description: '' });
      expect(result.intent).toBe('reporting');
    });

    it('detects integration intent', () => {
      const result = detectIntent({ title: 'Sync data to SAP ERP', description: 'Export and writeback' });
      expect(result.intent).toBe('integration');
    });

    it('returns general intent for unrecognizable text', () => {
      const result = detectIntent({ title: 'hello world', description: 'foo bar' });
      expect(result.intent).toBe('general');
      expect(result.confidence).toBe(0.3);
    });

    it('handles empty work order', () => {
      const result = detectIntent({});
      expect(result.intent).toBe('general');
    });

    it('uses context fields (subject, alert_type)', () => {
      const result = detectIntent({
        title: '',
        description: '',
        context: { subject: 'Inventory reorder needed', alert_type: 'shortage' },
      });
      expect(result.intent).toBe('planning');
    });

    it('confidence scales with keyword matches', () => {
      const low = detectIntent({ title: 'forecast', description: '' });
      const high = detectIntent({ title: 'demand forecast prediction trend', description: '' });
      expect(high.confidence).toBeGreaterThan(low.confidence);
    });
  });

  describe('getSourceCapabilityHint()', () => {
    it('returns planning capabilities for schedule source', () => {
      const caps = getSourceCapabilityHint('schedule');
      expect(caps).toContain('planning');
    });

    it('returns risk capabilities for alert source', () => {
      const caps = getSourceCapabilityHint('proactive_alert');
      expect(caps).toContain('risk');
    });

    it('returns integration capabilities for API source', () => {
      const caps = getSourceCapabilityHint('api');
      expect(caps).toContain('integration');
    });

    it('returns default for unknown source', () => {
      const caps = getSourceCapabilityHint('unknown');
      expect(caps.length).toBeGreaterThan(0);
    });
  });
});

// ── 2. Email Intake Endpoint ────────────────────────────────────────────────

import { handleEmailIntakeRequest, _resetEmailRateLimitsForTesting } from '../chat/emailIntakeEndpoint.js';

// Mock dependencies
vi.mock('./emailIntakeService.js', () => ({
  processEmailIntake: vi.fn().mockResolvedValue({
    work_orders: [{ id: 'wo_test', title: '[Email] Test' }],
    statuses: ['created'],
    action_items: ['run forecast'],
    headers: { from: 'a@b.com', subject: 'Test' },
  }),
}));

vi.mock('./webhookIntakeService.js', () => ({
  getWebhookByApiKey: vi.fn().mockImplementation((key) => {
    if (key === 'valid_key') return Promise.resolve({ employee_id: 'emp_1', user_id: 'usr_1', source_type: 'email' });
    return Promise.resolve(null);
  }),
  logWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./supabaseClient.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }),
  },
}));

vi.mock('./eventBus.js', () => ({
  eventBus: { emit: vi.fn() },
  EVENT_NAMES: { TASK_CREATED: 'task:created' },
}));

describe('emailIntakeEndpoint', () => {
  beforeEach(() => {
    _resetEmailRateLimitsForTesting();
    vi.clearAllMocks();
  });

  it('rejects missing body/subject', async () => {
    const result = await handleEmailIntakeRequest({ payload: {} });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(400);
  });

  it('rejects invalid API key', async () => {
    const result = await handleEmailIntakeRequest({
      apiKey: 'bad_key',
      payload: { subject: 'Test', body: 'Hello' },
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(401);
  });

  it('processes email with valid API key', async () => {
    const result = await handleEmailIntakeRequest({
      apiKey: 'valid_key',
      payload: { from: 'test@co.com', subject: 'Run forecast', body: 'Please run forecast for Q2' },
    });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.workOrders).toHaveLength(1);
  });

  it('processes email with explicit employee/user', async () => {
    const result = await handleEmailIntakeRequest({
      payload: { subject: 'Test', body: 'Do something' },
      employeeId: 'emp_direct',
      userId: 'usr_direct',
    });
    expect(result.ok).toBe(true);
  });

  it('enforces rate limiting', async () => {
    const payload = { from: 'spammer@bad.com', subject: 'Spam', body: 'Buy now!' };
    const opts = { payload, employeeId: 'e', userId: 'u' };

    // Send 30 emails (limit)
    for (let i = 0; i < 30; i++) {
      await handleEmailIntakeRequest(opts);
    }

    // 31st should be rate-limited
    const result = await handleEmailIntakeRequest(opts);
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(429);
  });

  it('returns 422 when no employee can be resolved', async () => {
    const result = await handleEmailIntakeRequest({
      payload: { subject: 'Test', body: 'Hello' },
      // No apiKey, no employeeId, no userId
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(422);
  });
});

// ── 3. Tool Permission Guard — Tier Restrictions ────────────────────────────

import {
  checkToolTier,
  canExecuteTool,
  TEMPLATE_TIER_RESTRICTIONS,
} from '../ai-infra/toolPermissionGuard.js';

describe('toolPermissionGuard — tier restrictions', () => {
  describe('TEMPLATE_TIER_RESTRICTIONS', () => {
    it('operations_coordinator is restricted from tier_c', () => {
      expect(TEMPLATE_TIER_RESTRICTIONS.operations_coordinator).not.toContain('tier_c');
    });

    it('supply_chain_analyst has all tiers', () => {
      expect(TEMPLATE_TIER_RESTRICTIONS.supply_chain_analyst).toContain('tier_c');
    });
  });

  describe('checkToolTier()', () => {
    it('allows any tier for unknown roles', () => {
      const result = checkToolTier({ role: 'unknown_role' }, 'tier_c');
      expect(result.allowed).toBe(true);
    });

    it('blocks tier_c for operations_coordinator', () => {
      const result = checkToolTier({ role: 'operations_coordinator' }, 'tier_c');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('tier_c');
    });

    it('allows tier_b for operations_coordinator', () => {
      const result = checkToolTier({ role: 'operations_coordinator' }, 'tier_b');
      expect(result.allowed).toBe(true);
    });

    it('allows when no tier specified', () => {
      const result = checkToolTier({ role: 'operations_coordinator' }, null);
      expect(result.allowed).toBe(true);
    });

    it('respects DB template override (allowed_tiers)', () => {
      const template = { name: 'Custom', allowed_tiers: ['tier_a'] };
      const result = checkToolTier({ role: 'data_analyst' }, 'tier_c', template);
      expect(result.allowed).toBe(false);
    });

    it('allows via DB template override', () => {
      const template = { name: 'Custom', allowed_tiers: ['tier_a', 'tier_b', 'tier_c'] };
      const result = checkToolTier({ role: 'operations_coordinator' }, 'tier_c', template);
      expect(result.allowed).toBe(true);
    });
  });

  describe('canExecuteTool()', () => {
    const fullPermEmployee = {
      name: 'TestWorker',
      role: 'supply_chain_analyst',
      permissions: {
        can_run_forecast: true,
        can_run_plan: true,
        can_run_builtin_tool: true,
      },
    };

    const restrictedEmployee = {
      name: 'OpsWorker',
      role: 'operations_coordinator',
      permissions: {
        can_run_builtin_tool: true,
      },
    };

    it('allows when both permission and tier pass', () => {
      const result = canExecuteTool(fullPermEmployee, 'forecast', 'tier_c');
      expect(result.allowed).toBe(true);
      expect(result.tierBlocked).toBe(false);
    });

    it('blocks when permission missing', () => {
      const result = canExecuteTool(restrictedEmployee, 'forecast', 'tier_a');
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain('can_run_forecast');
    });

    it('blocks when tier restricted', () => {
      const result = canExecuteTool(
        { ...restrictedEmployee, permissions: { ...restrictedEmployee.permissions, can_run_forecast: true } },
        'forecast',
        'tier_c',
      );
      expect(result.allowed).toBe(false);
      expect(result.tierBlocked).toBe(true);
    });

    it('allows synthesize (no special permission) at any tier', () => {
      const result = canExecuteTool(fullPermEmployee, 'synthesize', 'tier_a');
      expect(result.allowed).toBe(true);
    });
  });
});
