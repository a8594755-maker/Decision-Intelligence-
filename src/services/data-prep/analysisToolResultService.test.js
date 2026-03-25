import { describe, expect, it } from 'vitest';
import { extractAnalysisPayloadsFromToolCall, isRenderableAnalysisToolCall } from './analysisToolResultService.js';

describe('extractAnalysisPayloadsFromToolCall', () => {
  it('returns [] for failed tool calls', () => {
    expect(extractAnalysisPayloadsFromToolCall({
      name: 'generate_chart',
      result: { success: false, error: 'boom' },
    })).toEqual([]);
  });

  // ── run_python_analysis (single-level envelope) ──

  it('extracts from run_python_analysis via _analysisCards', () => {
    const cards = extractAnalysisPayloadsFromToolCall({
      name: 'run_python_analysis',
      result: {
        success: true,
        _analysisCards: [
          { analysisType: 'seller', title: 'Seller Overview' },
        ],
      },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Seller Overview');
  });

  it('extracts from run_python_analysis via result fallback', () => {
    const cards = extractAnalysisPayloadsFromToolCall({
      name: 'run_python_analysis',
      result: {
        success: true,
        result: { analysisType: 'revenue', title: 'Revenue Analysis' },
      },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Revenue Analysis');
  });

  // ── generate_chart (double-level envelope from chatToolAdapter) ──

  it('extracts from generate_chart via nested _analysisCards (adapter envelope)', () => {
    const cards = extractAnalysisPayloadsFromToolCall({
      name: 'generate_chart',
      result: {
        success: true,
        result: {
          success: true,
          result: { analysisType: 'trend', title: 'Revenue Trend' },
          _analysisCards: [
            { analysisType: 'trend', title: 'Revenue Trend' },
          ],
          toolId: 'generate_chart',
          artifactTypes: ['analysis_result'],
        },
        toolId: 'generate_chart',
        artifactTypes: ['analysis_result'],
      },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Revenue Trend');
  });

  it('extracts from generate_chart via nested result fallback (no _analysisCards)', () => {
    const cards = extractAnalysisPayloadsFromToolCall({
      name: 'generate_chart',
      result: {
        success: true,
        result: {
          success: true,
          result: { analysisType: 'time_pattern', title: 'Hourly Orders' },
          toolId: 'generate_chart',
        },
        toolId: 'generate_chart',
      },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Hourly Orders');
  });

  it('returns [] for generate_chart with empty inner result', () => {
    expect(extractAnalysisPayloadsFromToolCall({
      name: 'generate_chart',
      result: {
        success: true,
        result: {
          success: true,
          result: { count: 0 }, // no title or analysisType
        },
      },
    })).toEqual([]);
  });

  // ── isRenderableAnalysisToolCall ──

  it('isRenderableAnalysisToolCall returns true for generate_chart with valid cards', () => {
    expect(isRenderableAnalysisToolCall({
      name: 'generate_chart',
      result: {
        success: true,
        result: {
          success: true,
          _analysisCards: [{ title: 'Chart' }],
        },
      },
    })).toBe(true);
  });

  it('isRenderableAnalysisToolCall returns false for unknown tools', () => {
    expect(isRenderableAnalysisToolCall({
      name: 'some_other_tool',
      result: { success: true, result: { title: 'Data' } },
    })).toBe(false);
  });
});
