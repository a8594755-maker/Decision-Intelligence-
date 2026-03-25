import { describe, it, expect, vi } from 'vitest';
import {
  fetchGdeltEvents,
  fetchRedditSupplyChainNews,
  fetchCurrencyMoves,
  loadDemoScenario,
  fetchAllSignals,
  DEMO_SCENARIOS,
} from './externalSignalAdapters.js';

// ---------------------------------------------------------------------------
// loadDemoScenario
// ---------------------------------------------------------------------------

describe('loadDemoScenario', () => {
  it('loads semiconductor_fire scenario', () => {
    const scenario = loadDemoScenario('semiconductor_fire');
    expect(scenario.label).toContain('Semiconductor');
    expect(scenario.commodityPrices).toHaveLength(1);
    expect(scenario.commodityPrices[0].commodity).toBe('semiconductors');
    expect(scenario.commodityPrices[0].current_price).toBeGreaterThan(scenario.commodityPrices[0].previous_price);
    expect(scenario.geopoliticalEvents).toHaveLength(1);
    expect(scenario.geopoliticalEvents[0].severity).toBe('critical');
  });

  it('loads all predefined scenarios without error', () => {
    for (const key of Object.keys(DEMO_SCENARIOS)) {
      const scenario = loadDemoScenario(key);
      expect(scenario.commodityPrices.length).toBeGreaterThanOrEqual(1);
      expect(scenario.label).toBeTruthy();
    }
  });

  it('throws on unknown scenario', () => {
    expect(() => loadDemoScenario('nonexistent')).toThrow('Unknown demo scenario');
  });

  it('includes currencyMoves (empty by default)', () => {
    const scenario = loadDemoScenario('suez_blockage');
    expect(scenario.currencyMoves).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchGdeltEvents
// ---------------------------------------------------------------------------

describe('fetchGdeltEvents', () => {
  it('parses GDELT articles into geopolitical events', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        articles: [
          {
            title: 'Major earthquake strikes semiconductor manufacturing region in Taiwan',
            url: 'https://example.com/news/1',
            seendate: '2026-03-10T12:00:00Z',
            sourcecountry: 'TW',
            tone: -7.5,
            domain: 'reuters.com',
          },
          {
            title: 'Local sports team wins championship',
            url: 'https://example.com/news/2',
            seendate: '2026-03-10T11:00:00Z',
            sourcecountry: 'US',
            tone: 5.0,
          },
        ],
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const events = await fetchGdeltEvents({ fetchFn: mockFetch });

    // Should filter out irrelevant articles
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('earthquake');
    expect(events[0].region).toBe('APAC');
    expect(events[0].severity).toBe('high');
    expect(events[0].affected_commodities).toContain('semiconductors');
    expect(events[0].source).toBe('gdelt_gkg');
  });

  it('handles empty GDELT response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ articles: [] }),
    });

    const events = await fetchGdeltEvents({ fetchFn: mockFetch });
    expect(events).toEqual([]);
  });

  it('throws on API error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(fetchGdeltEvents({ fetchFn: mockFetch })).rejects.toThrow('GDELT API error');
  });

  it('calls GDELT API with correct URL parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ articles: [] }),
    });

    await fetchGdeltEvents({ fetchFn: mockFetch, maxRecords: 5, timespan: '30min' });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('api.gdeltproject.org');
    expect(calledUrl).toContain('maxrecords=5');
    expect(calledUrl).toContain('timespan=30min');
    expect(calledUrl).toContain('format=json');
  });

  it('correctly maps severity from GDELT tone', async () => {
    const articles = [
      { title: 'Port closure disrupts shipping lanes', tone: -9, sourcecountry: 'SG' },
      { title: 'Sanctions trade ban announced', tone: -3, sourcecountry: 'US' },
      { title: 'Flood damages supply chain hub', tone: -1, sourcecountry: 'TH' },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ articles }),
    });

    const events = await fetchGdeltEvents({ fetchFn: mockFetch });
    expect(events[0].severity).toBe('critical');  // tone -9
    expect(events[1].severity).toBe('medium');     // tone -3
    expect(events[2].severity).toBe('low');        // tone -1
  });
});

// ---------------------------------------------------------------------------
// fetchRedditSupplyChainNews
// ---------------------------------------------------------------------------

describe('fetchRedditSupplyChainNews', () => {
  it('parses Reddit posts into geopolitical events', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                title: 'Trump tariff refund update expected this week',
                selftext: 'Major tariff changes affecting US supply chain',
                score: 42,
                upvote_ratio: 0.90,
                num_comments: 15,
                created_utc: 1773164797,
                permalink: '/r/supplychain/comments/abc/tariff_update/',
                url_overridden_by_dest: 'https://www.newsweek.com/tariff-update',
              },
            },
            {
              data: {
                title: 'Supply Chain Salaries 2026 Megathread',
                selftext: 'Post your salary information here',
                score: 178,
                upvote_ratio: 0.98,
                num_comments: 280,
                created_utc: 1768166426,
                permalink: '/r/supplychain/comments/xyz/salaries/',
              },
            },
            {
              data: {
                title: 'MSC is invoking end of voyage for all exports ex Arabian and Persian gulf area',
                selftext: '',
                score: 17,
                upvote_ratio: 1.0,
                num_comments: 5,
                created_utc: 1773100000,
                permalink: '/r/supplychain/comments/msc/gulf/',
              },
            },
          ],
        },
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const events = await fetchRedditSupplyChainNews({
      subreddits: ['supplychain'],
      fetchFn: mockFetch,
    });

    // "Salaries" post should be filtered out (no supply chain event keywords)
    // "Tariff" and "Gulf/Persian" posts should be detected
    expect(events.length).toBeGreaterThanOrEqual(1);

    const tariffEvent = events.find(e => e.event_type === 'trade_war');
    expect(tariffEvent).toBeTruthy();
    expect(tariffEvent.source).toBe('reddit');
    expect(tariffEvent.region).toBe('NA'); // "trump" → NA
    expect(tariffEvent.url).toBe('https://www.newsweek.com/tariff-update');
  });

  it('filters out non-supply-chain posts', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        data: {
          children: [
            { data: { title: 'Best books for learning logistics career advice?', selftext: 'Looking for recommendations', score: 5, upvote_ratio: 1.0 } },
          ],
        },
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const events = await fetchRedditSupplyChainNews({ subreddits: ['supplychain'], fetchFn: mockFetch });
    expect(events).toHaveLength(0);
  });

  it('handles API error gracefully per-subreddit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const events = await fetchRedditSupplyChainNews({ subreddits: ['supplychain'], fetchFn: mockFetch });
    expect(events).toEqual([]);
  });

  it('assigns severity based on Reddit score', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        data: {
          children: [
            { data: { title: 'Major port closure in Shanghai disrupts shipping lanes', score: 100, upvote_ratio: 0.95, created_utc: 1773100000 } },
            { data: { title: 'Minor tariff adjustment on steel import announced', score: 3, upvote_ratio: 0.6, created_utc: 1773100000 } },
          ],
        },
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const events = await fetchRedditSupplyChainNews({ subreddits: ['supplychain'], fetchFn: mockFetch });

    const portEvent = events.find(e => e.description?.includes('port closure'));
    const tariffEvent = events.find(e => e.description?.includes('tariff'));
    expect(portEvent?.severity).toBe('high');
    expect(tariffEvent?.severity).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// fetchCurrencyMoves
// ---------------------------------------------------------------------------

describe('fetchCurrencyMoves', () => {
  it('detects significant currency moves', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        rates: {
          CNY: 7.35,   // +3.5% from baseline 7.10
          EUR: 0.92,   // no change
          JPY: 155.0,  // +3.3% from baseline 150
          KRW: 1350,   // no change
        },
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const moves = await fetchCurrencyMoves({ fetchFn: mockFetch });

    expect(moves.length).toBeGreaterThanOrEqual(2);

    const cnyMove = moves.find(m => m.currency_pair === 'USD/CNY');
    expect(cnyMove).toBeTruthy();
    expect(cnyMove.direction).toBe('weakening');
    expect(cnyMove.change_pct).toBeGreaterThan(3);
    expect(cnyMove.source).toBe('exchangerate_api');
  });

  it('returns empty when all rates within threshold', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        rates: { CNY: 7.10, EUR: 0.92, JPY: 150.0, KRW: 1350, MXN: 17.5, INR: 83.5 },
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const moves = await fetchCurrencyMoves({ fetchFn: mockFetch });
    expect(moves).toHaveLength(0);
  });

  it('throws on API error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchCurrencyMoves({ fetchFn: mockFetch })).rejects.toThrow('ExchangeRate API error');
  });

  it('respects custom threshold', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ rates: { CNY: 7.15 } }),  // +0.7% from 7.10
    };

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);

    // Default threshold (1.0%) — should not report
    const moves1 = await fetchCurrencyMoves({ fetchFn: mockFetch });
    expect(moves1).toHaveLength(0);

    // Lower threshold (0.5%) — should report
    const moves2 = await fetchCurrencyMoves({ fetchFn: mockFetch, thresholdPct: 0.5 });
    expect(moves2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAllSignals
// ---------------------------------------------------------------------------

describe('fetchAllSignals', () => {
  it('returns demo scenario data when demoScenario specified', async () => {
    const result = await fetchAllSignals({ demoScenario: 'china_rare_earth' });

    expect(result.source).toBe('demo:china_rare_earth');
    expect(result.commodityPrices).toHaveLength(1);
    expect(result.geopoliticalEvents).toHaveLength(1);
    expect(result.currencyMoves).toEqual([]);
  });

  it('merges extra data with demo scenario', async () => {
    const result = await fetchAllSignals({
      demoScenario: 'semiconductor_fire',
      extraCommodityPrices: [
        { commodity: 'copper', current_price: 9500, previous_price: 8800, currency: 'USD' },
      ],
    });

    expect(result.commodityPrices).toHaveLength(2);
  });

  it('returns empty data when no sources configured', async () => {
    const result = await fetchAllSignals();

    expect(result.commodityPrices).toEqual([]);
    expect(result.geopoliticalEvents).toEqual([]);
    expect(result.source).toBe('none');
  });

  it('handles GDELT failure gracefully', async () => {
    // Mock global fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    try {
      const result = await fetchAllSignals({ enableGdelt: true });
      // Should not throw — GDELT failure is non-blocking
      expect(result.source).toBe('none');
      expect(result.geopoliticalEvents).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('combines demo + GDELT sources', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        articles: [
          { title: 'Earthquake strikes factory region', tone: -6, sourcecountry: 'JP' },
        ],
      }),
    });

    try {
      const result = await fetchAllSignals({
        demoScenario: 'eu_steel_tariff',
        enableGdelt: true,
      });

      expect(result.source).toBe('demo:eu_steel_tariff+gdelt');
      expect(result.geopoliticalEvents.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('enableLive activates Reddit + Currency', async () => {
    const originalFetch = globalThis.fetch;

    // Mock that handles both Reddit and ExchangeRate API
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('reddit.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              children: [
                { data: { title: 'New tariff on steel imports announced', score: 30, upvote_ratio: 0.85, created_utc: Date.now() / 1000 } },
              ],
            },
          }),
        });
      }
      if (url.includes('exchangerate-api.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ rates: { CNY: 7.50, EUR: 0.92, JPY: 150, KRW: 1350, MXN: 17.5, INR: 83.5 } }),
        });
      }
      return Promise.reject(new Error('Unexpected URL'));
    });

    try {
      const result = await fetchAllSignals({ enableLive: true });

      expect(result.source).toContain('reddit');
      expect(result.source).toContain('exchangerate');
      expect(result.geopoliticalEvents.length).toBeGreaterThanOrEqual(1);
      expect(result.currencyMoves.length).toBeGreaterThanOrEqual(1); // CNY moved +5.6%
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles Reddit failure gracefully with enableLive', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('reddit.com')) {
        return Promise.reject(new Error('Network error'));
      }
      if (url.includes('exchangerate-api.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ rates: { CNY: 7.50 } }),
        });
      }
      return Promise.reject(new Error('Unexpected URL'));
    });

    try {
      const result = await fetchAllSignals({ enableLive: true });
      // Should not throw — Reddit failure is non-blocking
      expect(result.source).toContain('exchangerate');
      expect(result.currencyMoves.length).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
