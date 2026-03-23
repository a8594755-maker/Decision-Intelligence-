import { describe, it, expect, vi } from 'vitest';
import { buildActionParams, isExecutionType, routeIntent } from './chatIntentService';

describe('chatIntentService', () => {
  describe('buildActionParams', () => {
    it('extracts budget_cap from entities', () => {
      const result = buildActionParams(
        { entities: { budget_cap: 500000 } },
        {}
      );
      expect(result.constraints.budget_cap).toBe(500000);
    });

    it('extracts service_level_target from entities', () => {
      const result = buildActionParams(
        { entities: { service_level_target: 0.97 } },
        {}
      );
      expect(result.objective.service_level_target).toBe(0.97);
    });

    it('falls back to session context overrides', () => {
      const result = buildActionParams(
        { entities: {} },
        { overrides: { budget_cap: 300000 }, plan: {} }
      );
      expect(result.constraints.budget_cap).toBe(300000);
    });

    it('returns null constraints when nothing specified', () => {
      const result = buildActionParams({ entities: {} }, {});
      expect(result.constraints).toBeNull();
    });

    it('merges with current plan constraints', () => {
      const result = buildActionParams(
        { entities: { budget_cap: 500000 } },
        { plan: { constraints: { moq: [{ sku: 'A', min_qty: 100 }] } } }
      );
      expect(result.constraints.budget_cap).toBe(500000);
      expect(result.constraints.moq).toBeDefined();
    });
  });

  describe('isExecutionType', () => {
    it('returns true for execution intents', () => {
      expect(isExecutionType('RUN_PLAN')).toBe(true);
      expect(isExecutionType('RUN_FORECAST')).toBe(true);
      expect(isExecutionType('RUN_WORKFLOW_A')).toBe(true);
      expect(isExecutionType('RUN_WORKFLOW_B')).toBe(true);
      expect(isExecutionType('CHANGE_PARAM')).toBe(true);
      expect(isExecutionType('WHAT_IF')).toBe(true);
    });

    it('returns false for non-execution intents', () => {
      expect(isExecutionType('QUERY_DATA')).toBe(false);
      expect(isExecutionType('COMPARE_PLANS')).toBe(false);
      expect(isExecutionType('APPROVE')).toBe(false);
      expect(isExecutionType('GENERAL_CHAT')).toBe(false);
    });

    it('returns true for ACCEPT_NEGOTIATION_OPTION', () => {
      expect(isExecutionType('ACCEPT_NEGOTIATION_OPTION')).toBe(true);
    });
  });

  describe('routeIntent', () => {
    it('routes QUERY_DATA to queryData handler instead of assignTask', async () => {
      const queryData = vi.fn();
      const assignTask = vi.fn();

      const result = await routeIntent(
        {
          intent: 'QUERY_DATA',
          confidence: 0.95,
          entities: { freeform_query: 'show inventory by plant' },
          requires_dataset: false,
        },
        {},
        { queryData, assignTask },
        {}
      );

      expect(result).toEqual({ handled: true, intent: 'QUERY_DATA' });
      expect(queryData).toHaveBeenCalledWith({ userMessage: 'show inventory by plant' });
      expect(assignTask).not.toHaveBeenCalled();
    });
  });
});
