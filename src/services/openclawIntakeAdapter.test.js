/**
 * openclawIntakeAdapter.test.js — Tests for OpenClaw/MCP intake adapter
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeOpenClawMessage,
  buildWorkOrderFromMCPCall,
  formatMCPResponse,
  OPENCLAW_SOURCE,
} from './openclawIntakeAdapter.js';

describe('openclawIntakeAdapter', () => {
  // ── normalizeOpenClawMessage ───────────────────────────────────────────

  describe('normalizeOpenClawMessage', () => {
    it('normalizes a forecast MCP request into a work order', () => {
      const result = normalizeOpenClawMessage({
        tool_id: 'run_forecast',
        arguments: { horizonPeriods: 12 },
        agent_role: 'forecast',
        channel_context: { type: 'slack', channel_id: '#demand-planning' },
      });

      expect(result.source).toBe(OPENCLAW_SOURCE);
      expect(result.intent).toBe('run_forecast');
      expect(result.message).toContain('Demand Forecast');
      expect(result.metadata.tool_id).toBe('run_forecast');
      expect(result.metadata.agent_role).toBe('forecast');
      expect(result.metadata.arguments.horizonPeriods).toBe(12);
    });

    it('defaults to medium priority for normal requests', () => {
      const result = normalizeOpenClawMessage({
        tool_id: 'run_plan',
        arguments: {},
        agent_role: 'procurement',
      });

      expect(result.priority).toBe('medium');
    });

    it('detects urgent priority from arguments', () => {
      const result = normalizeOpenClawMessage({
        tool_id: 'run_risk_analysis',
        arguments: { note: 'URGENT: supplier delay' },
        agent_role: 'risk',
      });

      expect(result.priority).toBe('critical');
    });

    it('handles unknown tool IDs gracefully', () => {
      const result = normalizeOpenClawMessage({
        tool_id: 'unknown_tool',
        arguments: {},
      });

      expect(result.source).toBe(OPENCLAW_SOURCE);
      expect(result.intent).toBe('unknown_tool');
      expect(result.message).toContain('unknown tool');
    });

    it('truncates long argument summaries', () => {
      const result = normalizeOpenClawMessage({
        tool_id: 'run_forecast',
        arguments: {
          a: 'x'.repeat(100),
          b: 'y'.repeat(100),
          c: 'z'.repeat(100),
          d: '1',
          e: '2',
          f: '3',  // Only first 5 should appear
        },
      });

      // Should only include first 5 args
      expect(result.message.split(',').length).toBeLessThanOrEqual(6);
    });
  });

  // ── buildWorkOrderFromMCPCall ─────────────────────────────────────────

  describe('buildWorkOrderFromMCPCall', () => {
    it('builds a work order from an MCP tool call', () => {
      const result = buildWorkOrderFromMCPCall(
        'di_run_forecast',
        { horizonPeriods: 12 },
        { type: 'slack', channel_id: '#planning', user_id: 'U123' },
      );

      expect(result.source).toBe(OPENCLAW_SOURCE);
      expect(result.builtin_tool_id).toBe('run_forecast');
      expect(result.title).toBe('Demand Forecast');
      expect(result.channel.type).toBe('slack');
      expect(result.channel.user_id).toBe('U123');
      expect(result.parameters.horizonPeriods).toBe(12);
    });

    it('strips di_ prefix from tool names', () => {
      const result = buildWorkOrderFromMCPCall('di_run_plan', {}, {});
      expect(result.builtin_tool_id).toBe('run_plan');
      expect(result.title).toBe('Replenishment Plan');
    });

    it('handles tool names without di_ prefix', () => {
      const result = buildWorkOrderFromMCPCall('run_risk_analysis', {}, {});
      expect(result.builtin_tool_id).toBe('run_risk_analysis');
    });

    it('uses user_id as requested_by when display_name is absent', () => {
      const result = buildWorkOrderFromMCPCall('di_run_forecast', {}, {
        user_id: 'U456',
      });
      expect(result.requested_by).toBe('U456');
    });

    it('prefers display_name over user_id', () => {
      const result = buildWorkOrderFromMCPCall('di_run_forecast', {}, {
        user_id: 'U456',
        user_display_name: 'Alice',
      });
      expect(result.requested_by).toBe('Alice');
    });
  });

  // ── formatMCPResponse ─────────────────────────────────────────────────

  describe('formatMCPResponse', () => {
    it('formats a completed task with forecast artifacts', () => {
      const result = formatMCPResponse({
        status: 'completed',
        artifacts: {
          forecast_series: [
            { material_code: 'MAT-001', time_bucket: '2026-04', p50: 100, p10: 80, p90: 120 },
            { material_code: 'MAT-002', time_bucket: '2026-04', p50: 200, p10: 150, p90: 250 },
          ],
          metrics: { mape: 0.12, rmse: 15.3 },
        },
      });

      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThanOrEqual(2);
      expect(result.content[0].text).toContain('completed');
    });

    it('formats a failed task as error', () => {
      const result = formatMCPResponse({
        status: 'FAILED',
        artifacts: {},
      });

      expect(result.isError).toBe(true);
    });

    it('handles empty artifacts', () => {
      const result = formatMCPResponse({
        status: 'completed',
        artifacts: {},
      });

      expect(result.content.length).toBe(1);
      expect(result.content[0].text).toContain('0 artifact');
    });

    it('formats plan_table with total quantity', () => {
      const result = formatMCPResponse({
        status: 'completed',
        artifacts: {
          plan_table: [
            { material_code: 'MAT-001', order_qty: 100 },
            { material_code: 'MAT-002', order_qty: 200 },
          ],
        },
      });

      const planContent = result.content.find(c => c.text?.includes('Plan'));
      expect(planContent).toBeDefined();
    });

    it('formats risk_scores highlighting high-risk items', () => {
      const result = formatMCPResponse({
        status: 'completed',
        artifacts: {
          risk_scores: [
            { material_code: 'MAT-001', risk_score: 0.9, entity_id: 'SUP-A' },
            { material_code: 'MAT-002', risk_score: 0.3, entity_id: 'SUP-B' },
          ],
        },
      });

      const riskContent = result.content.find(c => c.text?.includes('high-risk'));
      expect(riskContent).toBeDefined();
    });
  });
});
