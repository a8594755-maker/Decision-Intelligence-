/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  trimMessagesForLocalStorage,
  saveLocalConversations,
  loadLocalConversations,
  mergeConversationRecords,
  mergeConversationCollections,
  STORAGE_KEY,
} from './helpers.js';

// ── trimMessagesForLocalStorage ─────────────────────────────────────

describe('trimMessagesForLocalStorage', () => {
  it('leaves plain text messages untouched', () => {
    const convs = [{
      id: '1',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'ai', content: 'hi there' },
      ],
    }];
    const result = trimMessagesForLocalStorage(convs);
    expect(result[0].messages).toEqual(convs[0].messages);
  });

  it('trims heavy card payloads to skeleton', () => {
    const bigPayload = {
      title: 'Revenue Analysis',
      summary: 'Revenue trending up',
      analysisType: 'trend',
      metrics: { total_revenue: 1000000 },
      highlights: ['Peak in Nov'],
      // These should be stripped:
      charts: [{ type: 'line', data: new Array(500).fill({ x: 1, y: 2 }) }],
      tables: [{ columns: ['a', 'b'], rows: new Array(200).fill([1, 2]) }],
      details: ['detail1', 'detail2'],
      _methodology: { queries: [{ sql: 'SELECT ...', rowCount: 1000 }] },
      _executionMeta: { code: 'import pandas as pd\n...', llm_model: 'gpt-5.4' },
    };

    const convs = [{
      id: '1',
      messages: [
        { role: 'user', content: 'analyze revenue' },
        { role: 'ai', type: 'analysis_result_card', payload: bigPayload },
      ],
    }];

    const result = trimMessagesForLocalStorage(convs);
    const trimmedMsg = result[0].messages[1];

    // Skeleton fields preserved
    expect(trimmedMsg.payload._trimmedForLocalStorage).toBe(true);
    expect(trimmedMsg.payload.title).toBe('Revenue Analysis');
    expect(trimmedMsg.payload.summary).toBe('Revenue trending up');
    expect(trimmedMsg.payload.metrics).toEqual({ total_revenue: 1000000 });
    expect(trimmedMsg.payload.highlights).toEqual(['Peak in Nov']);

    // Heavy fields stripped
    expect(trimmedMsg.payload.charts).toBeUndefined();
    expect(trimmedMsg.payload.tables).toBeUndefined();
    expect(trimmedMsg.payload.details).toBeUndefined();
    expect(trimmedMsg.payload._methodology).toBeUndefined();
    expect(trimmedMsg.payload._executionMeta).toBeUndefined();
  });

  it('trims all heavy card types', () => {
    const heavyTypes = [
      'analysis_result_card', 'forecast_result_card', 'plan_table_card',
      'inventory_projection_card', 'plan_summary_card', 'plan_exceptions_card',
      'bom_bottlenecks_card', 'downloads_card', 'risk_aware_plan_comparison_card',
      'eda_report_card',
    ];

    const convs = [{
      id: '1',
      messages: heavyTypes.map((type) => ({
        role: 'ai',
        type,
        payload: {
          title: `Card ${type}`,
          bigData: new Array(1000).fill('x'),
        },
      })),
    }];

    const result = trimMessagesForLocalStorage(convs);
    result[0].messages.forEach((msg) => {
      expect(msg.payload._trimmedForLocalStorage).toBe(true);
      expect(msg.payload.bigData).toBeUndefined();
    });
  });

  it('does NOT trim non-heavy card types', () => {
    const convs = [{
      id: '1',
      messages: [
        { role: 'ai', type: 'data_summary_card', payload: { sheets: [1, 2, 3] } },
        { role: 'ai', type: 'decision_bundle', payload: { recommendation: 'buy' } },
      ],
    }];

    const result = trimMessagesForLocalStorage(convs);
    expect(result[0].messages[0].payload.sheets).toEqual([1, 2, 3]);
    expect(result[0].messages[1].payload.recommendation).toBe('buy');
  });

  it('significantly reduces payload size', () => {
    // Simulate a realistic heavy conversation
    const bigChart = { type: 'line', data: new Array(500).fill({ date: '2025-01', value: 12345.67 }) };
    const bigTable = { columns: ['a', 'b', 'c', 'd', 'e'], rows: new Array(200).fill(['val1', 'val2', 'val3', 'val4', 'val5']) };

    const convs = [{
      id: '1',
      messages: [
        { role: 'user', content: 'analyze' },
        {
          role: 'ai', type: 'analysis_result_card',
          payload: {
            title: 'Test', summary: 'Summary',
            charts: [bigChart, bigChart],
            tables: [bigTable],
            _executionMeta: { code: 'x'.repeat(5000) },
          },
        },
        {
          role: 'ai', type: 'forecast_result_card',
          payload: {
            title: 'Forecast', summary: 'Looks good',
            series_groups: new Array(100).fill({ points: new Array(30).fill({ date: '2025-01', actual: 100, forecast: 110 }) }),
          },
        },
      ],
    }];

    const originalSize = JSON.stringify(convs).length;
    const trimmedSize = JSON.stringify(trimMessagesForLocalStorage(convs)).length;

    // Trimmed should be at least 90% smaller
    expect(trimmedSize).toBeLessThan(originalSize * 0.1);
  });

  it('handles conversations with no messages gracefully', () => {
    const convs = [
      { id: '1', messages: [] },
      { id: '2' },
    ];
    const result = trimMessagesForLocalStorage(convs);
    expect(result[0].messages).toEqual([]);
    expect(result[1].messages).toBeUndefined();
  });

  it('preserves kpis field for plan_summary_card', () => {
    const convs = [{
      id: '1',
      messages: [{
        role: 'ai',
        type: 'plan_summary_card',
        payload: {
          title: 'Plan',
          kpis: { service_level: 0.95, total_cost: 50000 },
          solver_meta: { iterations: 100, objective: 12345 },
        },
      }],
    }];

    const result = trimMessagesForLocalStorage(convs);
    expect(result[0].messages[0].payload.kpis).toEqual({ service_level: 0.95, total_cost: 50000 });
    expect(result[0].messages[0].payload.solver_meta).toBeUndefined();
  });
});

// ── saveLocalConversations — quota handling ──────────────────────────

describe('saveLocalConversations', () => {
  const userId = 'test-user-123';
  const key = `${STORAGE_KEY}_${userId}`;

  beforeEach(() => {
    localStorage.clear();
  });

  it('saves and loads conversations normally', () => {
    const convs = [{ id: '1', messages: [{ role: 'user', content: 'hi' }] }];
    saveLocalConversations(userId, convs);
    const loaded = loadLocalConversations(userId);
    expect(loaded).toEqual(convs);
  });

  it('retries with trimmed payloads when quota exceeded', () => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let callCount = 0;

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => {
      callCount++;
      if (callCount === 1) {
        // First call: simulate quota exceeded
        const err = new DOMException('QuotaExceededError', 'QuotaExceededError');
        throw err;
      }
      // Second call (trimmed): allow it
      originalSetItem(k, v);
    });

    const convs = [{
      id: '1',
      messages: [
        { role: 'user', content: 'analyze' },
        {
          role: 'ai',
          type: 'analysis_result_card',
          payload: {
            title: 'Big Analysis',
            summary: 'Summary here',
            charts: [{ data: new Array(100).fill(1) }],
            tables: [{ rows: new Array(100).fill([1, 2]) }],
          },
        },
      ],
    }];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    saveLocalConversations(userId, convs);

    // Should have warned
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('localStorage quota exceeded'),
      expect.anything(),
    );

    // Should have called setItem twice (original + retry)
    expect(callCount).toBe(2);

    // Load and verify trimmed data was saved
    const loaded = loadLocalConversations(userId);
    expect(loaded[0].messages[1].payload._trimmedForLocalStorage).toBe(true);
    expect(loaded[0].messages[1].payload.title).toBe('Big Analysis');
    expect(loaded[0].messages[1].payload.charts).toBeUndefined();

    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('logs error when even trimmed data exceeds quota', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    saveLocalConversations(userId, [{ id: '1', messages: [] }]);

    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('save failed even after trimming'),
      expect.anything(),
    );

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

describe('mergeConversationRecords', () => {
  it('prefers the newer local copy when Supabase is stale', () => {
    const merged = mergeConversationRecords(
      {
        id: 'conv-1',
        title: 'New Conversation',
        workspace: 'ai_employee',
        messages: [{ role: 'ai', content: 'welcome' }],
        updated_at: '2026-03-24T10:00:00.000Z',
      },
      {
        id: 'conv-1',
        title: 'Need a replenishment report',
        workspace: 'ai_employee',
        messages: [
          { role: 'ai', content: 'welcome' },
          { role: 'user', content: 'Need a replenishment report' },
          { role: 'ai', content: 'Working on it' },
        ],
        updated_at: '2026-03-24T10:02:00.000Z',
      },
      'ai_employee'
    );

    expect(merged.title).toBe('Need a replenishment report');
    expect(merged.messages).toHaveLength(3);
    expect(merged.updated_at).toBe('2026-03-24T10:02:00.000Z');
  });

  it('uses the longer history when timestamps are equal', () => {
    const merged = mergeConversationRecords(
      {
        id: 'conv-1',
        title: 'New Conversation',
        messages: [{ role: 'ai', content: 'welcome' }],
        updated_at: '2026-03-24T10:00:00.000Z',
      },
      {
        id: 'conv-1',
        title: 'Factory review',
        messages: [
          { role: 'ai', content: 'welcome' },
          { role: 'user', content: 'Show the factory review' },
        ],
        updated_at: '2026-03-24T10:00:00.000Z',
      },
      'ai_employee'
    );

    expect(merged.title).toBe('Factory review');
    expect(merged.messages).toHaveLength(2);
    expect(merged.workspace).toBe('ai_employee');
  });
});

describe('mergeConversationCollections', () => {
  it('sorts merged conversations by latest activity', () => {
    const merged = mergeConversationCollections(
      [
        {
          id: 'remote-older',
          title: 'Older remote',
          messages: [{ role: 'ai', content: 'welcome' }],
          updated_at: '2026-03-24T10:00:00.000Z',
        },
      ],
      [
        {
          id: 'local-newer',
          title: 'Latest local',
          workspace: 'ai_employee',
          messages: [{ role: 'user', content: 'latest' }],
          updated_at: '2026-03-24T10:05:00.000Z',
        },
      ],
      'ai_employee'
    );

    expect(merged.map((conversation) => conversation.id)).toEqual(['local-newer', 'remote-older']);
    expect(merged[0].workspace).toBe('ai_employee');
  });
});
