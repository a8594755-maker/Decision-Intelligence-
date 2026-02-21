function toNumber(value, defaultValue = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function keyOf(sku, plantId) {
  return `${normalizeText(sku)}|${normalizeText(plantId)}`;
}

function parseIsoDay(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoDay(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function sortedUniqueDays(values = []) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function buildLatestInventoryByKey(inventoryRows = []) {
  const map = new Map();
  inventoryRows.forEach((row) => {
    const sku = normalizeText(row?.sku);
    if (!sku) return;

    const snapshotDateObj = parseIsoDay(row?.as_of_date || row?.snapshot_date);
    if (!snapshotDateObj) return;

    const key = keyOf(row?.sku, row?.plant_id);
    const current = map.get(key);
    if (!current || snapshotDateObj > current.snapshotDateObj) {
      map.set(key, {
        snapshotDateObj,
        on_hand: toNumber(row?.on_hand, 0),
        safety_stock: Math.max(0, toNumber(row?.safety_stock, 0))
      });
    }
  });
  return map;
}

function buildQtyMapByKeyDate(rows = [], dateField, qtyField) {
  const map = new Map();
  rows.forEach((row) => {
    const sku = normalizeText(row?.sku);
    if (!sku) return;

    const dateObj = parseIsoDay(row?.[dateField]);
    if (!dateObj) return;

    const qty = Math.max(0, toNumber(row?.[qtyField], 0));
    if (qty <= 0) return;

    const key = keyOf(row?.sku, row?.plant_id);
    if (!map.has(key)) {
      map.set(key, new Map());
    }

    const date = toIsoDay(dateObj);
    const dateMap = map.get(key);
    dateMap.set(date, toNumber(dateMap.get(date), 0) + qty);
  });

  return map;
}

function buildDemandMapByKeyDate(forecastSeries = [], demandField = 'p50') {
  const demandByKey = new Map();

  forecastSeries.forEach((point) => {
    const sku = normalizeText(point?.sku);
    if (!sku) return;

    const dateObj = parseIsoDay(point?.date);
    if (!dateObj) return;

    const key = keyOf(point?.sku, point?.plant_id);
    if (!demandByKey.has(key)) {
      demandByKey.set(key, new Map());
    }

    const demand = Math.max(0, toNumber(point?.[demandField], 0));
    const date = toIsoDay(dateObj);
    const dateMap = demandByKey.get(key);
    dateMap.set(date, toNumber(dateMap.get(date), 0) + demand);
  });

  return demandByKey;
}

/**
 * Deterministic replay simulator for inventory projection.
 */
export function replaySimulator({
  forecast_series = [],
  inventory = [],
  open_pos = [],
  plan = [],
  horizon_dates = null,
  use_p90 = false
} = {}) {
  const demandField = use_p90 ? 'p90' : 'p50';

  const demandByKey = buildDemandMapByKeyDate(Array.isArray(forecast_series) ? forecast_series : [], demandField);
  const openPosByKey = buildQtyMapByKeyDate(Array.isArray(open_pos) ? open_pos : [], 'eta_date', 'qty');
  const planInboundByKey = buildQtyMapByKeyDate(Array.isArray(plan) ? plan : [], 'arrival_date', 'order_qty');
  const inventoryByKey = buildLatestInventoryByKey(Array.isArray(inventory) ? inventory : []);

  const keys = new Set([
    ...Array.from(demandByKey.keys()),
    ...Array.from(openPosByKey.keys()),
    ...Array.from(planInboundByKey.keys()),
    ...Array.from(inventoryByKey.keys())
  ]);

  const globalHorizon = Array.isArray(horizon_dates)
    ? sortedUniqueDays(
        horizon_dates
          .map((day) => parseIsoDay(day))
          .filter(Boolean)
          .map(toIsoDay)
      )
    : [];

  const projection = [];
  const stockoutEvents = [];

  let totalDemand = 0;
  let fulfilledUnits = 0;
  let stockoutUnits = 0;
  let holdingUnits = 0;

  const bySku = [];

  Array.from(keys).sort().forEach((key) => {
    const [sku, plantIdRaw] = key.split('|');
    const plant_id = normalizeText(plantIdRaw) || null;

    const demandMap = demandByKey.get(key) || new Map();
    const openMap = openPosByKey.get(key) || new Map();
    const planMap = planInboundByKey.get(key) || new Map();

    const keyDates = sortedUniqueDays([
      ...globalHorizon,
      ...Array.from(demandMap.keys()),
      ...Array.from(openMap.keys()),
      ...Array.from(planMap.keys())
    ]);

    if (keyDates.length === 0) return;

    const inv = inventoryByKey.get(key) || {
      on_hand: 0,
      safety_stock: 0
    };

    let currentOnHand = toNumber(inv.on_hand, 0);
    const safetyStock = Math.max(0, toNumber(inv.safety_stock, 0));

    let skuDemand = 0;
    let skuFulfilled = 0;
    let skuStockout = 0;

    keyDates.forEach((date) => {
      const on_hand_start = currentOnHand;
      const inbound_open_pos = toNumber(openMap.get(date), 0);
      const inbound_plan = toNumber(planMap.get(date), 0);
      const demand = toNumber(demandMap.get(date), 0);

      const available = on_hand_start + inbound_open_pos + inbound_plan;
      const fulfilled = Math.min(Math.max(available, 0), demand);
      const stockout = Math.max(0, demand - fulfilled);
      const on_hand_end = available - demand;

      projection.push({
        sku,
        plant_id,
        date,
        on_hand_start: Number(on_hand_start.toFixed(6)),
        inbound_open_pos: Number(inbound_open_pos.toFixed(6)),
        inbound_plan: Number(inbound_plan.toFixed(6)),
        demand: Number(demand.toFixed(6)),
        fulfilled: Number(fulfilled.toFixed(6)),
        stockout_units: Number(stockout.toFixed(6)),
        on_hand_end: Number(on_hand_end.toFixed(6)),
        safety_stock: Number(safetyStock.toFixed(6))
      });

      if (stockout > 0) {
        stockoutEvents.push({
          sku,
          plant_id,
          date,
          units_short: Number(stockout.toFixed(6))
        });
      }

      totalDemand += demand;
      fulfilledUnits += fulfilled;
      stockoutUnits += stockout;
      holdingUnits += Math.max(0, on_hand_end);

      skuDemand += demand;
      skuFulfilled += fulfilled;
      skuStockout += stockout;

      currentOnHand = on_hand_end;
    });

    bySku.push({
      sku,
      plant_id,
      demand_units: Number(skuDemand.toFixed(6)),
      fulfilled_units: Number(skuFulfilled.toFixed(6)),
      stockout_units: Number(skuStockout.toFixed(6)),
      fill_rate: skuDemand > 0 ? Number((skuFulfilled / skuDemand).toFixed(6)) : null
    });
  });

  const metrics = {
    total_demand_units: Number(totalDemand.toFixed(6)),
    fulfilled_units: Number(fulfilledUnits.toFixed(6)),
    stockout_units: Number(stockoutUnits.toFixed(6)),
    stockout_days: stockoutEvents.length,
    holding_units: Number(holdingUnits.toFixed(6)),
    fill_rate: totalDemand > 0 ? Number((fulfilledUnits / totalDemand).toFixed(6)) : null,
    service_level_proxy: totalDemand > 0 ? Number((fulfilledUnits / totalDemand).toFixed(6)) : null,
    sku_count: bySku.length
  };

  return {
    inventory_projection: projection,
    stockout_events: stockoutEvents,
    metrics,
    by_sku: bySku
  };
}

export default replaySimulator;
