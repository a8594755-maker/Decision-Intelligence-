/**
 * Macro Signal Service (Macro-Oracle)
 *
 * Monitors external signals — commodity price feeds, currency movements,
 * geopolitical events — and translates them into supplier events for the
 * existing supplierEventConnectorService pipeline.
 *
 * Design:
 *   - Polling-based with configurable intervals per signal source
 *   - Each source adapter is a pure function: rawData → normalized signal[]
 *   - Signals above threshold are converted to supplier events
 *   - Feeds into supplierEventConnectorService → negotiation-state-tracker
 *   - Initially stubbed: uses simulated data sources, interface ready for real APIs
 */

// ── Configuration ────────────────────────────────────────────────────────────

export const MACRO_SIGNAL_CONFIG = {
  /** Polling interval in ms (default 5 minutes) */
  poll_interval_ms: 5 * 60 * 1000,

  /** Minimum absolute price change (%) to generate a signal */
  commodity_price_change_threshold_pct: 3.0,

  /** Minimum currency move (%) to generate a signal */
  currency_change_threshold_pct: 2.0,

  /** Geopolitical severity mapping */
  geo_severity_map: {
    low: 'low',
    medium: 'medium',
    high: 'high',
    critical: 'critical',
  },

  /** Signal-to-supplier-event type mapping */
  signal_to_event_type: {
    commodity_price_spike: 'price_change',
    commodity_price_drop: 'price_change',
    currency_shock: 'price_change',
    geopolitical_disruption: 'force_majeure',
    trade_restriction: 'capacity_change',
    port_congestion: 'shipment_status',
    natural_disaster: 'force_majeure',
  },

  /** Supplier mapping: which suppliers are affected by which commodities */
  // In production, this would come from a database or config
  commodity_supplier_map: {},

  /** Max signals per poll cycle */
  max_signals_per_cycle: 50,
};

// ── Signal Types ─────────────────────────────────────────────────────────────

export const SIGNAL_TYPES = Object.freeze({
  COMMODITY_PRICE_SPIKE: 'commodity_price_spike',
  COMMODITY_PRICE_DROP: 'commodity_price_drop',
  CURRENCY_SHOCK: 'currency_shock',
  GEOPOLITICAL_DISRUPTION: 'geopolitical_disruption',
  TRADE_RESTRICTION: 'trade_restriction',
  PORT_CONGESTION: 'port_congestion',
  NATURAL_DISASTER: 'natural_disaster',
});

// ── Signal Shape ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MacroSignal
 * @property {string} signal_id       - Unique signal identifier
 * @property {string} signal_type     - One of SIGNAL_TYPES
 * @property {string} source          - Data source identifier
 * @property {string} commodity       - Affected commodity (e.g., 'steel', 'copper')
 * @property {string} region          - Affected region (e.g., 'APAC', 'EU')
 * @property {number} magnitude       - Normalized magnitude (0-100)
 * @property {string} severity        - 'low' | 'medium' | 'high' | 'critical'
 * @property {string} description     - Human-readable description
 * @property {string} detected_at     - ISO timestamp
 * @property {Object} raw_data        - Original data from source
 */

// ── Pure Functions: Source Adapters ──────────────────────────────────────────

/**
 * Parse commodity price data into signals.
 *
 * @param {Object} priceData - { commodity, current_price, previous_price, currency, source }
 * @param {Object} [config]  - MACRO_SIGNAL_CONFIG
 * @returns {MacroSignal|null}
 */
export function parseCommodityPrice(priceData, config = MACRO_SIGNAL_CONFIG) {
  if (!priceData?.commodity || !Number.isFinite(priceData.current_price) || !Number.isFinite(priceData.previous_price)) {
    return null;
  }

  const { current_price, previous_price, commodity } = priceData;
  if (previous_price === 0) return null;

  const changePct = ((current_price - previous_price) / previous_price) * 100;
  const absChange = Math.abs(changePct);

  if (absChange < config.commodity_price_change_threshold_pct) return null;

  const isSpike = changePct > 0;
  const severity = absChange >= 15 ? 'critical'
    : absChange >= 10 ? 'high'
    : absChange >= 5 ? 'medium'
    : 'low';

  return {
    signal_id: `commodity_${commodity}_${Date.now()}`,
    signal_type: isSpike ? SIGNAL_TYPES.COMMODITY_PRICE_SPIKE : SIGNAL_TYPES.COMMODITY_PRICE_DROP,
    source: priceData.source || 'commodity_feed',
    commodity,
    region: priceData.region || 'GLOBAL',
    magnitude: Math.min(100, Math.round(absChange * 3)),
    severity,
    description: `${commodity} price ${isSpike ? 'increased' : 'decreased'} by ${changePct.toFixed(1)}% (${previous_price} → ${current_price} ${priceData.currency || 'USD'})`,
    detected_at: new Date().toISOString(),
    raw_data: priceData,
  };
}

/**
 * Parse currency movement data into signals.
 *
 * @param {Object} fxData - { pair, current_rate, previous_rate, source }
 * @param {Object} [config]
 * @returns {MacroSignal|null}
 */
export function parseCurrencyMovement(fxData, config = MACRO_SIGNAL_CONFIG) {
  if (!fxData?.pair || !Number.isFinite(fxData.current_rate) || !Number.isFinite(fxData.previous_rate)) {
    return null;
  }

  const { current_rate, previous_rate, pair } = fxData;
  if (previous_rate === 0) return null;

  const changePct = Math.abs(((current_rate - previous_rate) / previous_rate) * 100);

  if (changePct < config.currency_change_threshold_pct) return null;

  const severity = changePct >= 8 ? 'critical'
    : changePct >= 5 ? 'high'
    : changePct >= 3 ? 'medium'
    : 'low';

  return {
    signal_id: `fx_${pair}_${Date.now()}`,
    signal_type: SIGNAL_TYPES.CURRENCY_SHOCK,
    source: fxData.source || 'fx_feed',
    commodity: pair,
    region: fxData.region || 'GLOBAL',
    magnitude: Math.min(100, Math.round(changePct * 5)),
    severity,
    description: `${pair} moved ${changePct.toFixed(2)}% (${previous_rate.toFixed(4)} → ${current_rate.toFixed(4)})`,
    detected_at: new Date().toISOString(),
    raw_data: fxData,
  };
}

/**
 * Parse geopolitical event data into signals.
 *
 * @param {Object} geoEvent - { event_type, region, severity, description, source, affected_commodities }
 * @returns {MacroSignal|null}
 */
export function parseGeopoliticalEvent(geoEvent) {
  if (!geoEvent?.event_type || !geoEvent?.region) return null;

  const typeMap = {
    conflict: SIGNAL_TYPES.GEOPOLITICAL_DISRUPTION,
    sanctions: SIGNAL_TYPES.TRADE_RESTRICTION,
    trade_war: SIGNAL_TYPES.TRADE_RESTRICTION,
    port_closure: SIGNAL_TYPES.PORT_CONGESTION,
    earthquake: SIGNAL_TYPES.NATURAL_DISASTER,
    typhoon: SIGNAL_TYPES.NATURAL_DISASTER,
    flood: SIGNAL_TYPES.NATURAL_DISASTER,
    pandemic: SIGNAL_TYPES.GEOPOLITICAL_DISRUPTION,
  };

  const signalType = typeMap[geoEvent.event_type] || SIGNAL_TYPES.GEOPOLITICAL_DISRUPTION;
  const severity = geoEvent.severity || 'medium';
  const magnitudeMap = { low: 20, medium: 45, high: 70, critical: 95 };

  return {
    signal_id: `geo_${geoEvent.event_type}_${geoEvent.region}_${Date.now()}`,
    signal_type: signalType,
    source: geoEvent.source || 'geopolitical_feed',
    commodity: geoEvent.affected_commodities?.[0] || null,
    region: geoEvent.region,
    magnitude: magnitudeMap[severity] || 50,
    severity,
    description: geoEvent.description || `${geoEvent.event_type} in ${geoEvent.region}`,
    detected_at: new Date().toISOString(),
    raw_data: geoEvent,
  };
}

// ── Signal → Supplier Event Conversion ───────────────────────────────────────

/**
 * Convert a macro signal into supplier event format for the connector service.
 *
 * @param {MacroSignal} signal
 * @param {Object}      [supplierContext] - { supplier_id, supplier_name, material_code, plant_id }
 * @param {Object}      [config]
 * @returns {Object} Supplier event suitable for processSupplierEvent()
 */
export function signalToSupplierEvent(signal, supplierContext = {}, config = MACRO_SIGNAL_CONFIG) {
  const eventType = config.signal_to_event_type[signal.signal_type] || 'force_majeure';

  const details = {};
  if (eventType === 'price_change' && signal.raw_data) {
    details.old_unit_price = signal.raw_data.previous_price || signal.raw_data.previous_rate || 0;
    details.new_unit_price = signal.raw_data.current_price || signal.raw_data.current_rate || 0;
    details.currency = signal.raw_data.currency || 'USD';
  } else if (eventType === 'force_majeure') {
    details.event_category = signal.signal_type;
    details.estimated_duration_days = signal.severity === 'critical' ? 30
      : signal.severity === 'high' ? 14
      : signal.severity === 'medium' ? 7
      : 3;
  } else if (eventType === 'capacity_change') {
    const reduction = signal.magnitude / 100;
    details.previous_capacity_pct = 100;
    details.new_capacity_pct = Math.max(0, 100 - Math.round(reduction * 50));
  } else if (eventType === 'shipment_status') {
    details.status = signal.severity === 'critical' ? 'customs_hold' : 'delayed';
  }

  return {
    event_id: signal.signal_id,
    event_type: eventType,
    supplier_id: supplierContext.supplier_id || `macro_${signal.region || 'GLOBAL'}`,
    supplier_name: supplierContext.supplier_name || `Macro Signal (${signal.region || 'Global'})`,
    material_code: supplierContext.material_code || null,
    plant_id: supplierContext.plant_id || null,
    severity: signal.severity,
    occurred_at: signal.detected_at,
    source_system: `macro_oracle:${signal.source}`,
    description: signal.description,
    details,
    metadata: {
      signal_type: signal.signal_type,
      commodity: signal.commodity,
      region: signal.region,
      magnitude: signal.magnitude,
    },
  };
}

// ── Poll Orchestrator ────────────────────────────────────────────────────────

/**
 * Process a batch of raw external data and return generated supplier events.
 *
 * @param {Object} params
 * @param {Object[]} [params.commodityPrices]   - Raw commodity price updates
 * @param {Object[]} [params.currencyMoves]     - Raw FX data
 * @param {Object[]} [params.geopoliticalEvents] - Raw geopolitical events
 * @param {Object}   [params.supplierContext]   - Default supplier context
 * @param {Object}   [params.config]            - Override config
 * @returns {{ signals: MacroSignal[], supplierEvents: Object[], skipped: number }}
 */
export function processExternalSignals({
  commodityPrices = [],
  currencyMoves = [],
  geopoliticalEvents = [],
  supplierContext = {},
  config = MACRO_SIGNAL_CONFIG,
}) {
  const signals = [];
  let skipped = 0;

  // Process commodity prices
  for (const priceData of commodityPrices) {
    const signal = parseCommodityPrice(priceData, config);
    if (signal) signals.push(signal);
    else skipped++;
  }

  // Process currency movements
  for (const fxData of currencyMoves) {
    const signal = parseCurrencyMovement(fxData, config);
    if (signal) signals.push(signal);
    else skipped++;
  }

  // Process geopolitical events
  for (const geoEvent of geopoliticalEvents) {
    const signal = parseGeopoliticalEvent(geoEvent);
    if (signal) signals.push(signal);
    else skipped++;
  }

  // Cap signals
  const cappedSignals = signals.slice(0, config.max_signals_per_cycle);

  // Convert to supplier events
  const supplierEvents = cappedSignals.map(s => signalToSupplierEvent(s, supplierContext, config));

  return { signals: cappedSignals, supplierEvents, skipped };
}

/**
 * Feed macro signals into the supplier event connector pipeline.
 * Connects the Macro-Oracle output to the existing event processing infrastructure.
 *
 * @param {Object} params
 * @param {Object[]} params.supplierEvents  - From processExternalSignals()
 * @param {string}   params.userId
 * @param {Object}   [params.alertMonitor]
 * @param {Function} [params.loadRiskState]
 * @returns {Promise<{ processed: number, triggered_events: number, errors: string[] }>}
 */
export async function feedSignalsToConnector({
  supplierEvents,
  userId,
  alertMonitor = null,
  loadRiskState = null,
}) {
  const errors = [];
  let processed = 0;
  let triggeredEvents = 0;

  try {
    const { processSupplierEvent } = await import('../sap-erp/supplierEventConnectorService.js');

    for (const event of supplierEvents) {
      try {
        const result = await processSupplierEvent({
          event,
          userId,
          alertMonitor,
          loadRiskState,
        });

        if (result.accepted) {
          processed++;
          if (result.replan_triggered) triggeredEvents++;
        } else if (result.error) {
          errors.push(`${event.event_id}: ${result.error}`);
        }
      } catch (err) {
        errors.push(`${event.event_id}: ${err.message}`);
      }
    }
  } catch (importErr) {
    errors.push(`Failed to import supplierEventConnectorService: ${importErr.message}`);
  }

  return { processed, triggered_events: triggeredEvents, errors };
}

/**
 * Feed macro signals into active negotiations' state trackers.
 * Updates position buckets in real-time based on market moves.
 *
 * @param {Object} params
 * @param {MacroSignal[]}   params.signals     - From processExternalSignals()
 * @param {Object}          params.stateTracker - NegotiationStateTracker instance
 * @param {string[]}        [params.negotiationIds] - Specific negotiations (or all active)
 * @returns {{ updated: number, skipped: number }}
 */
export function feedSignalsToNegotiations({
  signals,
  stateTracker,
  negotiationIds = null,
}) {
  if (!stateTracker || !signals?.length) return { updated: 0, skipped: 0 };

  let updated = 0;
  let skipped = 0;

  const targetIds = negotiationIds || Array.from(stateTracker._negotiations?.keys() || []);

  for (const negId of targetIds) {
    for (const signal of signals) {
      const marketEvent = {
        event_type: signal.signal_type,
        severity: signal.severity,
        risk_delta: severityToRiskDelta(signal.severity, signal.magnitude),
        occurred_at: signal.detected_at,
        description: signal.description,
      };

      const result = stateTracker.recordMarketEvent(negId, marketEvent);
      if (result) updated++;
      else skipped++;
    }
  }

  return { updated, skipped };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map severity + magnitude to a risk score delta.
 */
function severityToRiskDelta(severity, magnitude) {
  const baseMap = { low: 5, medium: 12, high: 25, critical: 40 };
  const base = baseMap[severity] || 10;
  const magnitudeScale = (magnitude || 50) / 50; // normalized around 1.0
  return Math.round(base * magnitudeScale * 10) / 10;
}

export default {
  MACRO_SIGNAL_CONFIG,
  SIGNAL_TYPES,
  parseCommodityPrice,
  parseCurrencyMovement,
  parseGeopoliticalEvent,
  signalToSupplierEvent,
  processExternalSignals,
  feedSignalsToConnector,
  feedSignalsToNegotiations,
};
