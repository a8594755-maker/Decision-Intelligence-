// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedSummary,
  setCachedSummary,
  clearCachedSummary,
  saveDashboardVersion,
  getDashboardHistory,
} from './dashboardSummaryCache.js';

const CACHE_KEY = 'di_canvas_layout';

beforeEach(() => {
  localStorage.clear();
});

describe('setCachedSummary + getCachedSummary', () => {
  it('stores and retrieves dataCards result', () => {
    const result = {
      dataCards: [{ id: 'card1', metrics: [{ label: 'Rev', value: 'R$1M' }] }],
      layout: { narrative: 'test', sections: [{ cardId: 'card1', width: 'full' }] },
      title: 'Test Dashboard',
    };
    setCachedSummary(CACHE_KEY, 'user123', result);
    const cached = getCachedSummary(CACHE_KEY, 'user123');

    expect(cached).not.toBeNull();
    expect(cached.dataCards).toHaveLength(1);
    expect(cached.dataCards[0].id).toBe('card1');
    expect(cached.layout.narrative).toBe('test');
  });

  it('returns null for different fingerprint', () => {
    setCachedSummary(CACHE_KEY, 'user123', { dataCards: [{ id: 'a' }] });
    const cached = getCachedSummary(CACHE_KEY, 'user456');
    expect(cached).toBeNull();
  });

  it('returns null when cache is empty', () => {
    const cached = getCachedSummary(CACHE_KEY, 'user123');
    expect(cached).toBeNull();
  });

  it('clearCachedSummary removes cache', () => {
    setCachedSummary(CACHE_KEY, 'user123', { dataCards: [{ id: 'a' }] });
    clearCachedSummary(CACHE_KEY);
    const cached = getCachedSummary(CACHE_KEY, 'user123');
    expect(cached).toBeNull();
  });
});

describe('saveDashboardVersion + getDashboardHistory', () => {
  it('saves dataCards-based dashboard to history', () => {
    const result = {
      dataCards: [{ id: 'card1', metrics: [{ label: 'Rev', value: 'R$1M' }], chartData: { type: 'bar', labels: ['A'], values: [100] } }],
      layout: { narrative: 'summary', sections: [{ cardId: 'card1', width: 'full' }] },
      title: 'V1',
      subtitle: '1 card',
    };
    saveDashboardVersion(result);
    const history = getDashboardHistory();

    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(1);
    expect(history[0].dataCards).toHaveLength(1);
    expect(history[0].dataCards[0].chartData.type).toBe('bar');
    expect(history[0].layout.narrative).toBe('summary');
  });

  it('saves multiple versions', () => {
    saveDashboardVersion({ dataCards: [{ id: 'a', metrics: [{ label: 'x', value: '1' }] }], title: 'V1' });
    saveDashboardVersion({ dataCards: [{ id: 'b', metrics: [{ label: 'y', value: '2' }] }], title: 'V2' });
    const history = getDashboardHistory();

    expect(history).toHaveLength(2);
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
  });

  it('skips save when no dataCards and no html', () => {
    saveDashboardVersion({ title: 'Empty' });
    expect(getDashboardHistory()).toHaveLength(0);
  });

  it('also saves html-only dashboards (legacy)', () => {
    saveDashboardVersion({ html: '<div>test</div>', title: 'Legacy' });
    const history = getDashboardHistory();
    expect(history).toHaveLength(1);
    expect(history[0].html).toBe('<div>test</div>');
  });
});
