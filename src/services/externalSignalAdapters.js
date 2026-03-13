/**
 * External Signal Adapters — Real data sources for the Macro-Oracle
 *
 * Each adapter implements: fetchSignals(since) → { commodityPrices, geopoliticalEvents, ... }
 * These feed directly into macroSignalService.processExternalSignals().
 *
 * Adapters:
 *   1. GDELT GKG API — geopolitical events (free, no API key)
 *   2. Reddit r/supplychain — real supply chain news (free, no API key)
 *   3. ExchangeRate API — live currency rates (free, no API key)
 *   4. Simulated commodity prices — configurable scenarios for demo/testing
 *
 * Design:
 *   - Each adapter is independent and stateless
 *   - Errors in one adapter do not block others
 *   - All adapters return data in macroSignalService's expected input format
 */

// ---------------------------------------------------------------------------
// GDELT GKG Adapter — Geopolitical events from the GDELT Global Knowledge Graph
// ---------------------------------------------------------------------------

/**
 * GDELT GKG themes relevant to supply chain disruption.
 * Mapped to macroSignalService event_types.
 */
const GDELT_THEME_MAP = {
  // Natural disasters
  NATURAL_DISASTER: 'earthquake',
  NATURAL_DISASTER_EARTHQUAKE: 'earthquake',
  NATURAL_DISASTER_FLOOD: 'flood',
  NATURAL_DISASTER_TYPHOON: 'typhoon',
  // Trade & sanctions
  ECON_TRADE_DISPUTE: 'trade_war',
  SANCTION: 'sanctions',
  TRADE_PROTECTIONISM: 'trade_war',
  // Conflict & instability
  ARMED_CONFLICT: 'conflict',
  POLITICAL_TURMOIL: 'conflict',
  // Transport & logistics
  TRANSPORTATION_DISRUPTION: 'port_closure',
  MARITIME_INCIDENT: 'port_closure',
  // Pandemic / health
  HEALTH_PANDEMIC: 'pandemic',
  DISEASE_OUTBREAK: 'pandemic',
};

/**
 * GDELT country codes to region mapping (simplified).
 */
const COUNTRY_TO_REGION = {
  US: 'NA', CA: 'NA', MX: 'NA',
  CN: 'APAC', JP: 'APAC', KR: 'APAC', TW: 'APAC', IN: 'APAC', VN: 'APAC', TH: 'APAC',
  DE: 'EU', FR: 'EU', IT: 'EU', NL: 'EU', GB: 'EU', PL: 'EU', ES: 'EU',
  RU: 'CIS', UA: 'CIS',
  BR: 'LATAM', AR: 'LATAM', CL: 'LATAM',
  SA: 'MENA', AE: 'MENA', IR: 'MENA', IL: 'MENA', EG: 'MENA',
  ZA: 'AFRICA', NG: 'AFRICA',
};

/**
 * Fetch supply-chain-relevant events from GDELT GKG API.
 *
 * Uses the GDELT DOC 2.0 API (free, no auth required).
 * Endpoint: https://api.gdeltproject.org/api/v2/doc/doc
 *
 * @param {Object} [options]
 * @param {string} [options.query]       - Search query (default: supply chain related)
 * @param {number} [options.maxRecords]  - Max articles to return (default: 10)
 * @param {string} [options.timespan]    - Timespan filter (default: '60min')
 * @param {Function} [options.fetchFn]   - Custom fetch function (for testing)
 * @returns {Promise<Object[]>} Array of geopolitical events for processExternalSignals()
 */
export async function fetchGdeltEvents({
  query = 'supply chain disruption OR port closure OR factory fire OR earthquake semiconductor OR sanctions trade',
  maxRecords = 10,
  timespan = '60min',
  fetchFn = globalThis.fetch,
} = {}) {
  const params = new URLSearchParams({
    query,
    mode: 'ArtList',
    maxrecords: String(maxRecords),
    timespan,
    format: 'json',
    sort: 'DateDesc',
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;

  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`GDELT API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const articles = data?.articles || [];

  return articles
    .map((article) => gdeltArticleToGeoEvent(article))
    .filter(Boolean);
}

/**
 * Convert a GDELT article to a geopolitical event for macroSignalService.
 *
 * @param {Object} article - GDELT article object
 * @returns {Object|null} Geopolitical event or null if not relevant
 */
function gdeltArticleToGeoEvent(article) {
  if (!article?.title) return null;

  // Extract event type from title keywords
  const title = (article.title || '').toLowerCase();
  const eventType = inferEventType(title);
  if (!eventType) return null;

  // Extract region from source country or domain
  const country = article.sourcecountry || article.domain?.split('.').pop()?.toUpperCase() || '';
  const region = COUNTRY_TO_REGION[country] || 'GLOBAL';

  // Infer severity from GDELT tone (negative tone → higher severity)
  const tone = Number(article.tone) || 0;
  const severity = tone < -8 ? 'critical'
    : tone < -5 ? 'high'
    : tone < -2 ? 'medium'
    : 'low';

  // Infer affected commodities from title
  const commodities = inferCommodities(title);

  return {
    event_type: eventType,
    region,
    severity,
    description: article.title,
    source: 'gdelt_gkg',
    affected_commodities: commodities,
    url: article.url || null,
    published_at: article.seendate || new Date().toISOString(),
  };
}

/**
 * Infer event type from article title.
 */
function inferEventType(title) {
  const patterns = [
    { keywords: ['earthquake', 'quake', 'seismic'], type: 'earthquake' },
    { keywords: ['typhoon', 'hurricane', 'cyclone', 'storm'], type: 'typhoon' },
    { keywords: ['flood', 'flooding'], type: 'flood' },
    { keywords: ['factory fire', 'plant fire', 'warehouse fire', 'explosion'], type: 'conflict' },
    { keywords: ['port closure', 'port shut', 'port congestion', 'shipping delay'], type: 'port_closure' },
    { keywords: ['sanction', 'embargo', 'trade ban', 'export control'], type: 'sanctions' },
    { keywords: ['trade war', 'tariff', 'trade dispute', 'trade tension'], type: 'trade_war' },
    { keywords: ['armed conflict', 'civil war', 'war zone', 'military', 'invasion', 'attack on'], type: 'conflict' },
    { keywords: ['pandemic', 'outbreak', 'lockdown', 'quarantine'], type: 'pandemic' },
    { keywords: ['supply chain disruption', 'supply shortage', 'chip shortage', 'supply chain crisis'], type: 'port_closure' },
  ];

  for (const { keywords, type } of patterns) {
    if (keywords.some((kw) => title.includes(kw))) {
      return type;
    }
  }
  return null;
}

/**
 * Infer affected commodities from article title.
 */
function inferCommodities(title) {
  const commodityPatterns = [
    { keywords: ['semiconductor', 'chip', 'wafer', 'tsmc', 'intel'], commodity: 'semiconductors' },
    { keywords: ['steel', 'iron ore', 'metal'], commodity: 'steel' },
    { keywords: ['copper', 'aluminum', 'aluminium'], commodity: 'copper' },
    { keywords: ['oil', 'crude', 'petroleum', 'gasoline'], commodity: 'oil' },
    { keywords: ['lithium', 'battery', 'cobalt', 'nickel'], commodity: 'lithium' },
    { keywords: ['rare earth', 'rare-earth'], commodity: 'rare_earth' },
    { keywords: ['wheat', 'grain', 'corn', 'soybean'], commodity: 'grains' },
    { keywords: ['natural gas', 'lng'], commodity: 'natural_gas' },
  ];

  const found = [];
  for (const { keywords, commodity } of commodityPatterns) {
    if (keywords.some((kw) => title.includes(kw))) {
      found.push(commodity);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Reddit r/supplychain Adapter — Real supply chain news (free, no auth)
// ---------------------------------------------------------------------------

/**
 * Subreddits to scan for supply chain disruption signals.
 */
const REDDIT_SUBREDDITS = ['supplychain', 'logistics', 'shipping'];

/**
 * Fetch supply-chain-relevant posts from Reddit.
 *
 * Uses the public JSON API (append .json to any Reddit URL).
 * No API key or OAuth required.
 *
 * @param {Object} [options]
 * @param {string[]} [options.subreddits] - Subreddits to scan
 * @param {number}   [options.limit]      - Posts per subreddit (default: 15)
 * @param {string}   [options.sort]       - 'new' | 'hot' (default: 'new')
 * @param {Function} [options.fetchFn]    - Custom fetch function (for testing)
 * @returns {Promise<Object[]>} Array of geopolitical events
 */
export async function fetchRedditSupplyChainNews({
  subreddits = REDDIT_SUBREDDITS,
  limit = 15,
  sort = 'new',
  fetchFn = globalThis.fetch,
} = {}) {
  const allEvents = [];

  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=${limit}`;
      const response = await fetchFn(url, {
        headers: { 'User-Agent': 'DecisionIntelligence/1.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const posts = data?.data?.children || [];

      for (const { data: post } of posts) {
        const event = redditPostToGeoEvent(post);
        if (event) allEvents.push(event);
      }
    } catch {
      // Non-blocking: skip this subreddit
    }
  }

  return allEvents;
}

/**
 * Reddit-specific relevance filter.
 * Requires BOTH a disruption keyword AND a domain keyword to reduce false positives.
 * (GDELT articles are pre-filtered by their query, but Reddit posts are general.)
 */
const REDDIT_DISRUPTION_KEYWORDS = [
  'tariff', 'sanction', 'embargo', 'trade ban', 'export control', 'trade war',
  'earthquake', 'typhoon', 'hurricane', 'flood', 'fire', 'explosion',
  'port closure', 'port shut', 'shipping delay', 'shipping disruption',
  'shortage', 'disruption', 'crisis', 'halt', 'suspend', 'blockage', 'blocked',
  'pandemic', 'lockdown', 'outbreak',
  'invasion', 'military', 'strike', 'protest',
  'price spike', 'price surge', 'price hike', 'cost increase',
  'end of voyage', 'reroute', 'detour',
];

const REDDIT_DOMAIN_KEYWORDS = [
  'supply chain', 'shipping', 'freight', 'cargo', 'logistics', 'port',
  'semiconductor', 'chip', 'steel', 'oil', 'copper', 'rare earth', 'lithium',
  'manufacturing', 'factory', 'warehouse', 'procurement', 'import', 'export',
  'supplier', 'inventory', 'lead time', 'container', 'bulk carrier',
];

function isRedditPostRelevant(combined) {
  const hasDisruption = REDDIT_DISRUPTION_KEYWORDS.some((kw) => combined.includes(kw));
  const hasDomain = REDDIT_DOMAIN_KEYWORDS.some((kw) => combined.includes(kw));
  return hasDisruption && hasDomain;
}

/**
 * Convert a Reddit post to a geopolitical event for macroSignalService.
 *
 * @param {Object} post - Reddit post data object
 * @returns {Object|null} Geopolitical event or null if not supply-chain-relevant
 */
function redditPostToGeoEvent(post) {
  if (!post?.title) return null;

  const title = (post.title || '').toLowerCase();
  const selftext = (post.selftext || '').toLowerCase();
  const combined = `${title} ${selftext.slice(0, 500)}`;

  // Reddit-specific: require both disruption + domain keywords
  if (!isRedditPostRelevant(combined)) return null;

  const eventType = inferEventType(combined);
  if (!eventType) return null;

  // Score-based severity: higher upvotes = more attention = higher severity
  const score = post.score || 0;
  const ratio = post.upvote_ratio || 0.5;
  const severity = score > 50 && ratio > 0.8 ? 'high'
    : score > 20 && ratio > 0.7 ? 'medium'
    : 'low';

  const commodities = inferCommodities(combined);

  // Try to infer region from title/text
  const region = inferRegionFromText(combined);

  return {
    event_type: eventType,
    region,
    severity,
    description: post.title,
    source: 'reddit',
    affected_commodities: commodities,
    url: post.url_overridden_by_dest || `https://www.reddit.com${post.permalink}`,
    published_at: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : new Date().toISOString(),
    reddit_score: score,
    reddit_comments: post.num_comments || 0,
  };
}

/**
 * Infer region from free text.
 */
function inferRegionFromText(text) {
  const regionPatterns = [
    { keywords: ['china', 'chinese', 'beijing', 'shanghai', 'shenzhen', 'taiwan', 'tsmc', 'japan', 'korea', 'asia', 'apac', 'vietnam', 'india'], region: 'APAC' },
    { keywords: ['europe', 'eu ', 'germany', 'france', 'uk ', 'britain', 'european'], region: 'EU' },
    { keywords: ['us ', 'usa', 'america', 'united states', 'washington', 'trump', 'biden', 'congress'], region: 'NA' },
    { keywords: ['suez', 'saudi', 'iran', 'middle east', 'gulf', 'persian', 'arabian', 'israel'], region: 'MENA' },
    { keywords: ['russia', 'ukraine', 'moscow'], region: 'CIS' },
    { keywords: ['brazil', 'latin america', 'mexico', 'argentina'], region: 'LATAM' },
    { keywords: ['africa', 'nigeria', 'south africa'], region: 'AFRICA' },
  ];

  for (const { keywords, region } of regionPatterns) {
    if (keywords.some((kw) => text.includes(kw))) return region;
  }
  return 'GLOBAL';
}

// ---------------------------------------------------------------------------
// ExchangeRate API Adapter — Live currency data (free, no auth)
// ---------------------------------------------------------------------------

/**
 * Currency pairs relevant for supply chain cost monitoring.
 * Significant moves (>1% from baseline) become signals.
 */
const CURRENCY_BASELINES = {
  CNY: 7.10,   // USD/CNY — China manufacturing
  EUR: 0.92,   // USD/EUR — European suppliers
  JPY: 150.0,  // USD/JPY — Japanese components
  KRW: 1350,   // USD/KRW — Korean electronics
  MXN: 17.5,   // USD/MXN — Mexico nearshoring
  INR: 83.5,   // USD/INR — India services
};

/**
 * Fetch live currency rates and detect significant moves.
 *
 * @param {Object} [options]
 * @param {Object} [options.baselines] - Expected rates for comparison
 * @param {number} [options.thresholdPct] - Min % move to report (default: 1.0)
 * @param {Function} [options.fetchFn] - Custom fetch function
 * @returns {Promise<Object[]>} Array of currency move objects
 */
export async function fetchCurrencyMoves({
  baselines = CURRENCY_BASELINES,
  thresholdPct = 1.0,
  fetchFn = globalThis.fetch,
} = {}) {
  const url = 'https://api.exchangerate-api.com/v4/latest/USD';
  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`ExchangeRate API error: ${response.status}`);
  }

  const data = await response.json();
  const rates = data?.rates || {};
  const moves = [];

  for (const [currency, baseline] of Object.entries(baselines)) {
    const current = rates[currency];
    if (current == null) continue;

    const changePct = ((current - baseline) / baseline) * 100;
    if (Math.abs(changePct) >= thresholdPct) {
      moves.push({
        pair: `USD/${currency}`,
        currency_pair: `USD/${currency}`,
        current_rate: current,
        previous_rate: baseline,    // macroSignalService expects previous_rate
        baseline_rate: baseline,
        change_pct: Math.round(changePct * 100) / 100,
        direction: changePct > 0 ? 'weakening' : 'strengthening',
        source: 'exchangerate_api',
        fetched_at: new Date().toISOString(),
      });
    }
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Commodity Price Adapter — Scenario-based for demo, API-ready for production
// ---------------------------------------------------------------------------

/**
 * Predefined demo scenarios for commodity price disruptions.
 * In production, replace with Alpha Vantage / Yahoo Finance / internal feeds.
 */
export const DEMO_SCENARIOS = {
  semiconductor_fire: {
    label: 'TSMC Fab Fire — Semiconductor Price Spike',
    commodityPrices: [
      { commodity: 'semiconductors', current_price: 145, previous_price: 100, currency: 'USD', source: 'demo_scenario', region: 'APAC' },
    ],
    geopoliticalEvents: [
      { event_type: 'conflict', region: 'APAC', severity: 'critical', description: 'Major fire at semiconductor fabrication plant in Hsinchu, Taiwan. Production halted for estimated 6-8 weeks.', source: 'demo_scenario', affected_commodities: ['semiconductors'] },
    ],
  },
  suez_blockage: {
    label: 'Suez Canal Blockage — Global Shipping Disruption',
    commodityPrices: [
      { commodity: 'oil', current_price: 88, previous_price: 75, currency: 'USD', source: 'demo_scenario', region: 'MENA' },
    ],
    geopoliticalEvents: [
      { event_type: 'port_closure', region: 'MENA', severity: 'high', description: 'Container vessel grounded in Suez Canal blocking both directions of traffic. Over 300 ships queued.', source: 'demo_scenario', affected_commodities: ['oil'] },
    ],
  },
  china_rare_earth: {
    label: 'China Rare Earth Export Controls',
    commodityPrices: [
      { commodity: 'rare_earth', current_price: 280, previous_price: 180, currency: 'USD', source: 'demo_scenario', region: 'APAC' },
    ],
    geopoliticalEvents: [
      { event_type: 'sanctions', region: 'APAC', severity: 'critical', description: 'China announces export controls on rare earth elements effective immediately. Gallium and germanium exports require new licenses.', source: 'demo_scenario', affected_commodities: ['rare_earth', 'semiconductors'] },
    ],
  },
  eu_steel_tariff: {
    label: 'EU Steel Anti-Dumping Tariffs',
    commodityPrices: [
      { commodity: 'steel', current_price: 820, previous_price: 680, currency: 'USD', source: 'demo_scenario', region: 'EU' },
    ],
    geopoliticalEvents: [
      { event_type: 'trade_war', region: 'EU', severity: 'medium', description: 'EU imposes 25% anti-dumping tariff on imported steel products, effective Q2.', source: 'demo_scenario', affected_commodities: ['steel'] },
    ],
  },
};

/**
 * Load a demo scenario as external signal data.
 *
 * @param {string} scenarioKey - One of DEMO_SCENARIOS keys
 * @returns {{ commodityPrices: Object[], geopoliticalEvents: Object[], label: string }}
 */
export function loadDemoScenario(scenarioKey) {
  const scenario = DEMO_SCENARIOS[scenarioKey];
  if (!scenario) {
    const available = Object.keys(DEMO_SCENARIOS).join(', ');
    throw new Error(`Unknown demo scenario: "${scenarioKey}". Available: ${available}`);
  }
  return {
    commodityPrices: scenario.commodityPrices || [],
    geopoliticalEvents: scenario.geopoliticalEvents || [],
    currencyMoves: [],
    label: scenario.label,
  };
}

// ---------------------------------------------------------------------------
// Unified adapter interface
// ---------------------------------------------------------------------------

/**
 * Fetch signals from all configured external sources.
 *
 * @param {Object} [options]
 * @param {boolean} [options.enableGdelt=false]      - Enable live GDELT fetching
 * @param {boolean} [options.enableReddit=false]     - Enable live Reddit r/supplychain
 * @param {boolean} [options.enableCurrency=false]   - Enable live currency rate tracking
 * @param {boolean} [options.enableLive=false]       - Enable all live sources (Reddit + Currency; GDELT opt-in)
 * @param {string}  [options.demoScenario=null]      - Load a demo scenario instead
 * @param {Object}  [options.gdeltOptions]           - Options for fetchGdeltEvents()
 * @param {Object}  [options.redditOptions]          - Options for fetchRedditSupplyChainNews()
 * @param {Object}  [options.currencyOptions]        - Options for fetchCurrencyMoves()
 * @param {Object[]} [options.extraCommodityPrices]  - Additional commodity price data
 * @param {Object[]} [options.extraGeoEvents]        - Additional geopolitical events
 * @returns {Promise<{ commodityPrices: Object[], currencyMoves: Object[], geopoliticalEvents: Object[], source: string }>}
 */
export async function fetchAllSignals({
  enableGdelt = false,
  enableReddit = false,
  enableCurrency = false,
  enableLive = false,
  demoScenario = null,
  gdeltOptions = {},
  redditOptions = {},
  currencyOptions = {},
  extraCommodityPrices = [],
  extraGeoEvents = [],
} = {}) {
  const commodityPrices = [...extraCommodityPrices];
  const geopoliticalEvents = [...extraGeoEvents];
  const currencyMoves = [];
  const sources = [];

  // enableLive is a convenience flag for Reddit + Currency
  const useReddit = enableReddit || enableLive;
  const useCurrency = enableCurrency || enableLive;

  // Priority 1: Demo scenario (deterministic, for testing/demos)
  if (demoScenario) {
    const scenario = loadDemoScenario(demoScenario);
    commodityPrices.push(...scenario.commodityPrices);
    geopoliticalEvents.push(...scenario.geopoliticalEvents);
    sources.push(`demo:${demoScenario}`);
  }

  // Priority 2: Live sources (run in parallel for speed)
  const liveJobs = [];

  if (enableGdelt) {
    liveJobs.push(
      fetchGdeltEvents(gdeltOptions)
        .then((events) => { geopoliticalEvents.push(...events); sources.push('gdelt'); })
        .catch((err) => console.warn('[externalSignalAdapters] GDELT fetch failed:', err.message))
    );
  }

  if (useReddit) {
    liveJobs.push(
      fetchRedditSupplyChainNews(redditOptions)
        .then((events) => { geopoliticalEvents.push(...events); sources.push('reddit'); })
        .catch((err) => console.warn('[externalSignalAdapters] Reddit fetch failed:', err.message))
    );
  }

  if (useCurrency) {
    liveJobs.push(
      fetchCurrencyMoves(currencyOptions)
        .then((moves) => { currencyMoves.push(...moves); sources.push('exchangerate'); })
        .catch((err) => console.warn('[externalSignalAdapters] Currency fetch failed:', err.message))
    );
  }

  await Promise.all(liveJobs);

  return {
    commodityPrices,
    currencyMoves,
    geopoliticalEvents,
    source: sources.length > 0 ? sources.join('+') : 'none',
  };
}

export default {
  fetchGdeltEvents,
  fetchRedditSupplyChainNews,
  fetchCurrencyMoves,
  loadDemoScenario,
  fetchAllSignals,
  DEMO_SCENARIOS,
};
