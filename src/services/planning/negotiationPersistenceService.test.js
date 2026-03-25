/**
 * Tests: Negotiation Persistence Service
 *
 * Tests CRUD operations for negotiation cases and events.
 * Uses mocked Supabase to test both happy path and localStorage fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Supabase ───────────────────────────────────────────────────────────

const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn(() => ({
  single: mockSingle,
  maybeSingle: mockMaybeSingle,
  order: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle }) }),
}));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockReturnValue({ select: mockSelect }) }));
const mockEq = vi.fn().mockReturnThis();
const mockIn = vi.fn().mockReturnThis();
const mockOrder = vi.fn().mockReturnThis();
const mockLimit = vi.fn();

const mockFrom = vi.fn(() => ({
  insert: mockInsert,
  update: mockUpdate,
  select: vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => ({
              maybeSingle: mockMaybeSingle,
            })),
          })),
        })),
      })),
      order: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
      single: mockSingle,
    })),
    order: mockOrder,
    limit: mockLimit,
  })),
  eq: mockEq,
  in: mockIn,
  order: mockOrder,
  limit: mockLimit,
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    from: (...args) => mockFrom(...args),
  },
}));

// ── Import SUT after mocks ──────────────────────────────────────────────────

import {
  createCase,
  recordEvent,
  resolveCase,
  getCaseStats,
} from './negotiationPersistenceService';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('negotiationPersistenceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage
    try { localStorage.removeItem('di_negotiation_cases_local'); } catch { /* noop */ }
  });

  describe('createCase', () => {
    it('should create a case with correct fields', async () => {
      const mockCase = {
        id: 'case-uuid-1',
        user_id: 'user-1',
        plan_run_id: 42,
        trigger: 'infeasible',
        status: 'active',
        buyer_position: { bucket: 3, name: 'STRONG' },
        scenario_id: 'cooperative_normal',
        supplier_kpis: { on_time: 0.88 },
        current_round: 0,
        current_round_name: 'OPENING',
      };

      mockSingle.mockResolvedValueOnce({ data: mockCase, error: null });

      const result = await createCase('user-1', {
        planRunId: 42,
        trigger: 'infeasible',
        buyerPosition: { bucket: 3, name: 'STRONG' },
        scenarioId: 'cooperative_normal',
        supplierKpis: { on_time: 0.88 },
      });

      expect(result).toBeTruthy();
      expect(result.id).toBe('case-uuid-1');
      expect(result.trigger).toBe('infeasible');
      expect(result.status).toBe('active');
    });

    it('should fall back to local storage when Supabase fails', async () => {
      mockSingle.mockRejectedValueOnce(new Error('Network error'));

      const result = await createCase('user-1', {
        planRunId: 99,
        trigger: 'kpi_shortfall',
        buyerPosition: { bucket: 2, name: 'NEUTRAL' },
      });

      expect(result).toBeTruthy();
      expect(result.id).toMatch(/^local-neg-/);
      expect(result.trigger).toBe('kpi_shortfall');
      expect(result.status).toBe('active');
      expect(result.current_round).toBe(0);
      expect(result.current_round_name).toBe('OPENING');
    });

    it('should set correct default values', async () => {
      mockSingle.mockRejectedValueOnce(new Error('fail'));

      const result = await createCase('user-1', {
        planRunId: 1,
        trigger: 'infeasible',
      });

      expect(result.cfr_history_key).toBe('');
      expect(result.current_round).toBe(0);
      expect(result.outcome).toBeNull();
      expect(result.buyer_position).toEqual({});
      expect(result.supplier_kpis).toEqual({});
    });
  });

  describe('recordEvent', () => {
    it('should create an event with correct fields', async () => {
      const mockEvent = {
        id: 'evt-uuid-1',
        case_id: 'case-1',
        round: 0,
        round_name: 'OPENING',
        player: 'buyer',
        action: 'counter',
        details: { price_proposed: 100 },
      };

      mockSingle.mockResolvedValueOnce({ data: mockEvent, error: null });

      const result = await recordEvent('case-1', {
        round: 0,
        roundName: 'OPENING',
        player: 'buyer',
        action: 'counter',
        details: { price_proposed: 100 },
        draftTone: 'persuasion',
        draftBody: 'Dear supplier...',
      });

      expect(result).toBeTruthy();
      expect(result.case_id).toBe('case-1');
      expect(result.action).toBe('counter');
    });

    it('should fall back when Supabase fails', async () => {
      mockSingle.mockRejectedValueOnce(new Error('fail'));

      const result = await recordEvent('case-1', {
        round: 1,
        roundName: 'CONCESSION',
        player: 'supplier',
        action: 'accept',
      });

      expect(result).toBeTruthy();
      expect(result.id).toMatch(/^local-evt-/);
      expect(result.action).toBe('accept');
    });
  });

  describe('resolveCase', () => {
    it('should update status and outcome', async () => {
      const mockResolved = {
        id: 'case-1',
        status: 'resolved_agreement',
        outcome: { price: 95, lead_time: 14 },
      };

      mockSingle.mockResolvedValueOnce({ data: mockResolved, error: null });

      const result = await resolveCase('case-1', {
        status: 'resolved_agreement',
        terms: { price: 95, lead_time: 14 },
      });

      expect(result).toBeTruthy();
      expect(result.status).toBe('resolved_agreement');
      expect(result.outcome).toEqual({ price: 95, lead_time: 14 });
    });
  });

  describe('getCaseStats', () => {
    it('should compute correct status counts from returned cases', async () => {
      const mockCases = [
        { id: '1', user_id: 'user-1', status: 'active' },
        { id: '2', user_id: 'user-1', status: 'active' },
        { id: '3', user_id: 'user-1', status: 'resolved_agreement' },
        { id: '4', user_id: 'user-1', status: 'resolved_walkaway' },
        { id: '5', user_id: 'user-1', status: 'expired' },
      ];

      // Mock the full Supabase query chain for listCases
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: mockCases, error: null }),
            }),
          }),
        }),
      });

      const stats = await getCaseStats('user-1');

      expect(stats.total).toBe(5);
      expect(stats.active).toBe(2);
      expect(stats.resolved_agreement).toBe(1);
      expect(stats.resolved_walkaway).toBe(1);
      expect(stats.expired).toBe(1);
    });
  });
});
