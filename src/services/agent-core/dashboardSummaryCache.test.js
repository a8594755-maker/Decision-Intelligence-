// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedSummary,
  setCachedSummary,
  clearCachedSummary,
  saveDashboardVersion,
  getDashboardHistory,
} from './dashboardSummaryCache.js';

// Mock IndexedDB cache (jsdom doesn't have IndexedDB)
vi.mock('../storage/indexedDbCache.js', () => {
  const store = new Map();
  return {
    getCached: vi.fn(async (key) => store.get(key)?.data || null),
    setCached: vi.fn(async (key, data) => store.set(key, { data })),
    clearCached: vi.fn(async (key) => store.delete(key)),
    _store: store,
  };
});

const CACHE_KEY = 'di_canvas_layout';

beforeEach(async () => {
  localStorage.clear();
  const { _store } = await import('../storage/indexedDbCache.js');
  _store.clear();
});

describe('setCachedSummary + getCachedSummary (localStorage)', () => {
  it('stores and retrieves dataCards result', () => {
    const result = {
      dataCards: [{ id: 'card1', metrics: [{ label: 'Rev', value: 'R$1M' }] }],
      layout: { narrative: 'test', sections: [{ cardId: 'card1', width: 'full' }] },
    };
    setCachedSummary(CACHE_KEY, 'user123', result);
    const cached = getCachedSummary(CACHE_KEY, 'user123');
    expect(cached).not.toBeNull();
    expect(cached.dataCards).toHaveLength(1);
  });

  it('returns null for different fingerprint', () => {
    setCachedSummary(CACHE_KEY, 'user123', { dataCards: [{ id: 'a' }] });
    expect(getCachedSummary(CACHE_KEY, 'user456')).toBeNull();
  });

  it('returns null when empty', () => {
    expect(getCachedSummary(CACHE_KEY, 'user123')).toBeNull();
  });

  it('clearCachedSummary removes cache', () => {
    setCachedSummary(CACHE_KEY, 'user123', { dataCards: [{ id: 'a' }] });
    clearCachedSummary(CACHE_KEY);
    expect(getCachedSummary(CACHE_KEY, 'user123')).toBeNull();
  });
});

describe('saveDashboardVersion + getDashboardHistory (IndexedDB)', () => {
  it('saves dataCards dashboard to history', async () => {
    await saveDashboardVersion({
      dataCards: [{ id: 'card1', metrics: [{ label: 'Rev', value: 'R$1M' }], chartData: { type: 'bar' } }],
      layout: { narrative: 'summary' },
      title: 'V1',
    });
    const history = await getDashboardHistory();
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(1);
    expect(history[0].dataCards).toHaveLength(1);
  });

  it('saves multiple versions', async () => {
    await saveDashboardVersion({ dataCards: [{ id: 'a', metrics: [{ label: 'x', value: '1' }] }], title: 'V1' });
    await saveDashboardVersion({ dataCards: [{ id: 'b', metrics: [{ label: 'y', value: '2' }] }], title: 'V2' });
    const history = await getDashboardHistory();
    expect(history).toHaveLength(2);
    expect(history[1].version).toBe(2);
  });

  it('skips save when no dataCards and no html', async () => {
    await saveDashboardVersion({ title: 'Empty' });
    const history = await getDashboardHistory();
    expect(history).toHaveLength(0);
  });

  it('saves html-only dashboards (legacy)', async () => {
    await saveDashboardVersion({ html: '<div>test</div>', title: 'Legacy' });
    const history = await getDashboardHistory();
    expect(history).toHaveLength(1);
    expect(history[0].html).toBe('<div>test</div>');
  });
});
