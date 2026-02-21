const ML_API_BASE = import.meta.env.VITE_ML_API_URL || '';

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Optimization API timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function postJson(path, payload, timeoutMs = 20000) {
  const baseUrl = normalizeBaseUrl(ML_API_BASE);
  if (!baseUrl) {
    throw new Error('VITE_ML_API_URL is not configured');
  }

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }),
    timeoutMs
  );

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Optimization API ${response.status}: ${message || response.statusText}`);
  }

  const parsed = await response.json();
  if (parsed?.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

function toNumber(value, defaultValue = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
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

function addDays(base, days) {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function keyOf(sku, plantId) {
  return `${String(sku || '').trim()}|${String(plantId || '').trim()}`;
}

function buildSkuMap(rows = [], valueKey) {
  const map = new Map();
  rows.forEach((row) => {
    const sku = String(row?.sku || '').trim();
    if (!sku) return;
    const value = toNumber(row?.[valueKey], NaN);
    if (!Number.isFinite(value)) return;
    map.set(sku, Math.max(0, value));
  });
  return map;
}

function inferPeriodDays(sortedDates = []) {
  if (!Array.isArray(sortedDates) || sortedDates.length <= 1) return 1;
  const deltas = [];
  for (let i = 1; i < sortedDates.length; i += 1) {
    const prev = parseIsoDay(sortedDates[i - 1]);
    const next = parseIsoDay(sortedDates[i]);
    if (!prev || !next) continue;
    const days = Math.round((next.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
    if (days > 0) deltas.push(days);
  }
  if (deltas.length === 0) return 1;
  deltas.sort((a, b) => a - b);
  return Math.max(1, deltas[Math.floor(deltas.length / 2)]);
}

function applyLotSizing({ sku, qty, moqBySku, packBySku, maxBySku }) {
  let next = Math.max(0, toNumber(qty, 0));
  const moq = moqBySku.get(sku) || 0;
  const pack = packBySku.get(sku) || 0;
  const maxQty = maxBySku.get(sku) || 0;

  if (maxQty > 0 && next > maxQty) next = maxQty;
  if (moq > 0 && next > 0 && next < moq) next = moq;
  if (pack > 1 && next > 0) next = Math.ceil(next / pack) * pack;
  return Number(next.toFixed(6));
}

function buildComponentFallbackArtifacts({
  payload = {},
  fgPlan = [],
  moqBySku,
  packBySku,
  maxBySku
}) {
  const mode = String(payload?.multi_echelon?.mode || '').trim().toLowerCase();
  const usageRows = Array.isArray(payload?.bom_usage) ? payload.bom_usage : [];
  if (mode !== 'bom_v0' || usageRows.length === 0) {
    return {
      component_plan: [],
      component_inventory_projection: { total_rows: 0, rows: [], truncated: false },
      bottlenecks: { generated_at: new Date().toISOString(), total_rows: 0, rows: [] }
    };
  }

  const horizonDates = Array.from(new Set(
    (Array.isArray(payload?.demand_forecast?.series) ? payload.demand_forecast.series : [])
      .map((row) => toIsoDay(parseIsoDay(row?.date)))
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  if (horizonDates.length === 0) {
    return {
      component_plan: [],
      component_inventory_projection: { total_rows: 0, rows: [], truncated: false },
      bottlenecks: { generated_at: new Date().toISOString(), total_rows: 0, rows: [] }
    };
  }

  const periodDays = inferPeriodDays(horizonDates);
  const usageByFg = new Map();
  const componentToFg = new Map();
  usageRows.forEach((row) => {
    const fgSku = String(row?.fg_sku || '').trim();
    const componentSku = String(row?.component_sku || '').trim();
    const plantId = String(row?.plant_id || '').trim() || null;
    const usageQty = Math.max(0, toNumber(row?.usage_qty, 0));
    if (!fgSku || !componentSku || usageQty <= 0) return;
    const key = keyOf(fgSku, plantId);
    if (!usageByFg.has(key)) usageByFg.set(key, []);
    usageByFg.get(key).push({
      fg_sku: fgSku,
      component_sku: componentSku,
      plant_id: plantId,
      usage_qty: usageQty
    });

    const componentKey = keyOf(componentSku, plantId);
    if (!componentToFg.has(componentKey)) componentToFg.set(componentKey, new Set());
    componentToFg.get(componentKey).add(fgSku);
  });

  const depDemandByCompDate = new Map();
  fgPlan.forEach((row) => {
    const fgSku = String(row?.sku || '').trim();
    const fgPlant = String(row?.plant_id || '').trim() || null;
    const arrivalDate = toIsoDay(parseIsoDay(row?.arrival_date));
    const qty = Math.max(0, toNumber(row?.order_qty, 0));
    if (!fgSku || !arrivalDate || qty <= 0) return;

    const usageCandidates = [
      ...(usageByFg.get(keyOf(fgSku, fgPlant)) || []),
      ...(fgPlant ? [] : (usageByFg.get(keyOf(fgSku, null)) || []))
    ];

    usageCandidates.forEach((usage) => {
      const compKey = keyOf(usage.component_sku, usage.plant_id || fgPlant);
      if (!depDemandByCompDate.has(compKey)) depDemandByCompDate.set(compKey, new Map());
      const dateMap = depDemandByCompDate.get(compKey);
      dateMap.set(arrivalDate, toNumber(dateMap.get(arrivalDate), 0) + (qty * usage.usage_qty));
    });
  });

  const inventoryRows = Array.isArray(payload?.inventory) ? payload.inventory : [];
  const componentInventory = new Map();
  inventoryRows.forEach((row) => {
    const sku = String(row?.sku || '').trim();
    if (!sku) return;
    const key = keyOf(row?.sku, row?.plant_id);
    const snapshot = parseIsoDay(row?.as_of_date);
    if (!snapshot) return;
    const prev = componentInventory.get(key);
    if (!prev || snapshot > prev.snapshot) {
      componentInventory.set(key, {
        snapshot,
        on_hand: Math.max(0, toNumber(row?.on_hand, 0)),
        safety_stock: Math.max(0, toNumber(row?.safety_stock, 0)),
        lead_time_days: Math.max(0, Math.floor(toNumber(row?.lead_time_days, 0)))
      });
    }
  });

  const openPosRows = Array.isArray(payload?.open_pos) ? payload.open_pos : [];
  const openPosByCompDate = new Map();
  openPosRows.forEach((row) => {
    const sku = String(row?.sku || '').trim();
    const eta = toIsoDay(parseIsoDay(row?.eta_date));
    const qty = Math.max(0, toNumber(row?.qty, 0));
    if (!sku || !eta || qty <= 0) return;
    const key = keyOf(row?.sku, row?.plant_id);
    if (!openPosByCompDate.has(key)) openPosByCompDate.set(key, new Map());
    const dateMap = openPosByCompDate.get(key);
    dateMap.set(eta, toNumber(dateMap.get(eta), 0) + qty);
  });

  const componentKeys = Array.from(new Set([
    ...Array.from(depDemandByCompDate.keys()),
    ...Array.from(componentInventory.keys())
  ])).sort();

  const componentPlan = [];
  const componentProjection = [];
  const bottleneckByComp = new Map();

  componentKeys.forEach((compKey) => {
    const [componentSku, plantRaw] = compKey.split('|');
    const plantId = plantRaw || null;
    const inv = componentInventory.get(compKey) || {
      on_hand: 0,
      safety_stock: 0,
      lead_time_days: 0
    };
    const leadOffset = Math.max(0, Math.ceil(toNumber(inv.lead_time_days, 0) / periodDays));
    const demandMap = depDemandByCompDate.get(compKey) || new Map();
    const openMap = openPosByCompDate.get(compKey) || new Map();
    const plannedArrivals = new Map();

    let onHand = Math.max(0, toNumber(inv.on_hand, 0));
    const safetyStock = Math.max(0, toNumber(inv.safety_stock, 0));

    horizonDates.forEach((date, idx) => {
      const inboundOpenPos = toNumber(openMap.get(date), 0);
      const inboundPlan = toNumber(plannedArrivals.get(date), 0);
      onHand += inboundOpenPos + inboundPlan;

      const dependentDemand = Math.max(0, toNumber(demandMap.get(date), 0));
      const shortage = Math.max(0, dependentDemand - onHand);
      const onHandEnd = onHand - dependentDemand;

      if (shortage > 0) {
        if (!bottleneckByComp.has(compKey)) {
          bottleneckByComp.set(compKey, {
            component_sku: componentSku,
            plant_id: plantId,
            missing_qty: 0,
            periods_impacted: new Set(),
            affected_fg_skus: new Set()
          });
        }
        const bucket = bottleneckByComp.get(compKey);
        bucket.missing_qty += shortage;
        bucket.periods_impacted.add(date);
        (componentToFg.get(compKey) || new Set()).forEach((fgSku) => bucket.affected_fg_skus.add(fgSku));
      }

      const refill = Math.max(0, safetyStock - onHandEnd);
      if (refill > 0) {
        const arrivalIdx = idx + leadOffset;
        if (arrivalIdx < horizonDates.length) {
          const orderQty = applyLotSizing({
            sku: componentSku,
            qty: refill,
            moqBySku,
            packBySku,
            maxBySku
          });
          if (orderQty > 0) {
            const orderDate = horizonDates[idx];
            const arrivalDate = horizonDates[arrivalIdx];
            componentPlan.push({
              component_sku: componentSku,
              plant_id: plantId,
              order_date: orderDate,
              arrival_date: arrivalDate,
              order_qty: orderQty
            });
            plannedArrivals.set(arrivalDate, toNumber(plannedArrivals.get(arrivalDate), 0) + orderQty);
          }
        }
      }

      componentProjection.push({
        component_sku: componentSku,
        plant_id: plantId,
        date,
        on_hand_end: Number(onHandEnd.toFixed(6)),
        backlog: Number(shortage.toFixed(6)),
        demand_dependent: Number(dependentDemand.toFixed(6)),
        inbound_plan: Number(inboundPlan.toFixed(6)),
        inbound_open_pos: Number(inboundOpenPos.toFixed(6))
      });

      onHand = onHandEnd;
    });
  });

  componentPlan.sort((a, b) => {
    if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    if (a.order_date !== b.order_date) return a.order_date.localeCompare(b.order_date);
    return a.arrival_date.localeCompare(b.arrival_date);
  });

  const bottlenecksRows = Array.from(bottleneckByComp.values())
    .map((row) => ({
      component_sku: row.component_sku,
      plant_id: row.plant_id,
      missing_qty: Number(row.missing_qty.toFixed(6)),
      periods_impacted: Array.from(row.periods_impacted).sort((a, b) => a.localeCompare(b)),
      affected_fg_skus: Array.from(row.affected_fg_skus).sort((a, b) => a.localeCompare(b))
    }))
    .sort((a, b) => {
      if (b.missing_qty !== a.missing_qty) return b.missing_qty - a.missing_qty;
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      return (a.plant_id || '').localeCompare(b.plant_id || '');
    });

  return {
    component_plan: componentPlan,
    component_inventory_projection: {
      total_rows: componentProjection.length,
      rows: componentProjection,
      truncated: false
    },
    bottlenecks: {
      generated_at: new Date().toISOString(),
      total_rows: bottlenecksRows.length,
      rows: bottlenecksRows
    }
  };
}

function runLocalHeuristic(payload = {}) {
  const started = Date.now();

  const demandSeries = Array.isArray(payload?.demand_forecast?.series)
    ? payload.demand_forecast.series
    : [];
  const planningHorizonDays = Math.max(1, Math.floor(toNumber(payload?.planning_horizon_days, 30)));

  const demandByKey = new Map();
  demandSeries.forEach((point) => {
    const dateObj = parseIsoDay(point?.date);
    const sku = String(point?.sku || '').trim();
    if (!dateObj || !sku) return;
    const key = keyOf(point?.sku, point?.plant_id);
    if (!demandByKey.has(key)) {
      demandByKey.set(key, []);
    }
    demandByKey.get(key).push({
      dateObj,
      date: toIsoDay(dateObj),
      sku,
      plant_id: String(point?.plant_id || '').trim() || null,
      p50: Math.max(0, toNumber(point?.p50, 0)),
      p90: point?.p90 === null || point?.p90 === undefined
        ? null
        : Math.max(0, toNumber(point?.p90, 0))
    });
  });

  if (demandByKey.size === 0) {
    return {
      status: 'infeasible',
      plan: [],
      kpis: {
        estimated_service_level: null,
        estimated_stockout_units: null,
        estimated_holding_units: null,
        estimated_total_cost: null
      },
      solver_meta: {
        solver: 'heuristic',
        solve_time_ms: Date.now() - started,
        objective_value: null,
        gap: null
      },
      infeasible_reasons: ['No demand forecast rows were provided.'],
      proof: {
        objective_terms: [],
        constraints_checked: []
      }
    };
  }

  const inventoryRows = Array.isArray(payload?.inventory) ? payload.inventory : [];
  const inventoryByKey = new Map();
  inventoryRows.forEach((row) => {
    const sku = String(row?.sku || '').trim();
    if (!sku) return;
    const snapshotDate = parseIsoDay(row?.as_of_date);
    if (!snapshotDate) return;

    const key = keyOf(row?.sku, row?.plant_id);
    const current = inventoryByKey.get(key);
    if (!current || snapshotDate > current.snapshotDate) {
      inventoryByKey.set(key, {
        snapshotDate,
        on_hand: toNumber(row?.on_hand, 0),
        safety_stock: Math.max(0, toNumber(row?.safety_stock, 0)),
        lead_time_days: Math.max(0, Math.floor(toNumber(row?.lead_time_days, 0)))
      });
    }
  });

  const openPosRows = Array.isArray(payload?.open_pos) ? payload.open_pos : [];
  const inboundByKey = new Map();
  openPosRows.forEach((row) => {
    const sku = String(row?.sku || '').trim();
    if (!sku) return;
    const eta = parseIsoDay(row?.eta_date);
    if (!eta) return;

    const qty = Math.max(0, toNumber(row?.qty, 0));
    if (qty <= 0) return;

    const key = keyOf(row?.sku, row?.plant_id);
    if (!inboundByKey.has(key)) {
      inboundByKey.set(key, new Map());
    }
    const dateKey = toIsoDay(eta);
    const dateMap = inboundByKey.get(key);
    dateMap.set(dateKey, toNumber(dateMap.get(dateKey), 0) + qty);
  });

  const constraints = payload?.constraints || {};
  const moqBySku = buildSkuMap(constraints?.moq || [], 'min_qty');
  const packBySku = buildSkuMap(constraints?.pack_size || [], 'pack_qty');
  const maxBySku = buildSkuMap(constraints?.max_order_qty || [], 'max_qty');
  const budgetCap = constraints?.budget_cap === null || constraints?.budget_cap === undefined
    ? null
    : Math.max(0, toNumber(constraints?.budget_cap, 0));

  let totalOrderQty = 0;
  let totalDemand = 0;
  let stockoutUnits = 0;
  let holdingUnits = 0;

  const infeasibleReasons = [];
  const plan = [];
  const roundingAdjustments = [];

  const sortedKeys = Array.from(demandByKey.keys()).sort();
  sortedKeys.forEach((key) => {
    const series = demandByKey.get(key)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    if (series.length === 0) return;

    const startDate = parseIsoDay(series[0].date);
    const endDate = addDays(startDate, planningHorizonDays - 1);
    const horizonSeries = series.filter((point) => point.dateObj <= endDate);
    if (horizonSeries.length === 0) return;

    const inv = inventoryByKey.get(key) || {
      on_hand: 0,
      safety_stock: 0,
      lead_time_days: 0
    };

    const [sku, plant] = key.split('|');
    let onHand = toNumber(inv.on_hand, 0);
    const safetyStock = Math.max(0, toNumber(inv.safety_stock, 0));
    const leadTimeDays = Math.max(0, Math.floor(toNumber(inv.lead_time_days, 0)));

    const inboundMap = inboundByKey.get(key) || new Map();

    horizonSeries.forEach((point) => {
      const inboundToday = toNumber(inboundMap.get(point.date), 0);
      onHand += inboundToday;

      const demand = Math.max(0, toNumber(point.p50, 0));
      totalDemand += demand;

      let projectedAfterDemand = onHand - demand;
      const required = Math.max(0, safetyStock - projectedAfterDemand);

      let orderQty = required;
      const roundingNotes = [];

      const skuMoq = moqBySku.get(sku) || 0;
      const skuPack = packBySku.get(sku) || 0;
      const skuMax = maxBySku.get(sku) || 0;

      if (orderQty > 0) {
        if (skuMax > 0 && orderQty > skuMax) {
          orderQty = skuMax;
          roundingNotes.push('max_order_qty_cap');
        }

        if (skuMoq > 0 && orderQty > 0 && orderQty < skuMoq) {
          orderQty = skuMoq;
          roundingNotes.push('moq_floor');
        }

        if (skuPack > 1 && orderQty > 0) {
          const rounded = Math.ceil(orderQty / skuPack) * skuPack;
          if (Math.abs(rounded - orderQty) > 1e-9) {
            roundingNotes.push('pack_round_up');
          }
          orderQty = rounded;
        }

        if (budgetCap !== null) {
          const remaining = budgetCap - totalOrderQty;
          if (remaining <= 0) {
            orderQty = 0;
            infeasibleReasons.push(`Budget cap exhausted before ${sku} on ${point.date}.`);
          } else if (orderQty > remaining) {
            let clipped = remaining;
            if (skuPack > 1) {
              clipped = Math.floor(clipped / skuPack) * skuPack;
            }
            if (skuMoq > 0 && clipped > 0 && clipped < skuMoq) {
              clipped = 0;
            }
            if (clipped < orderQty) {
              roundingNotes.push('budget_cap_clipped');
            }
            orderQty = Math.max(0, clipped);
            if (orderQty === 0) {
              infeasibleReasons.push(`Budget cap blocked MOQ/pack order for ${sku} on ${point.date}.`);
            }
          }
        }
      }

      if (orderQty > 0) {
        const arrivalDateObj = parseIsoDay(point.date);
        const orderDateObj = addDays(arrivalDateObj, -leadTimeDays);
        plan.push({
          sku,
          plant_id: plant || null,
          order_date: toIsoDay(orderDateObj),
          arrival_date: toIsoDay(arrivalDateObj),
          order_qty: Number(orderQty.toFixed(6))
        });
        totalOrderQty += orderQty;
        projectedAfterDemand += orderQty;

        if (roundingNotes.length > 0) {
          roundingAdjustments.push(`${sku}@${plant || 'NA'} ${point.date}: ${Array.from(new Set(roundingNotes)).join(', ')}`);
        }
      }

      onHand = projectedAfterDemand;
      if (onHand < 0) {
        stockoutUnits += Math.abs(onHand);
      }
      holdingUnits += Math.max(0, onHand);
    });
  });

  let moqViolations = 0;
  let packViolations = 0;
  let maxViolations = 0;
  let nonNegativeViolations = 0;

  plan.forEach((row) => {
    const sku = row.sku;
    const qty = toNumber(row.order_qty, 0);

    if (qty < -1e-9) nonNegativeViolations += 1;

    const moq = moqBySku.get(sku) || 0;
    if (moq > 0 && qty > 0 && qty + 1e-9 < moq) {
      moqViolations += 1;
    }

    const pack = packBySku.get(sku) || 0;
    if (pack > 1 && qty > 0) {
      const ratio = qty / pack;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
        packViolations += 1;
      }
    }

    const maxQty = maxBySku.get(sku) || 0;
    if (maxQty > 0 && qty - maxQty > 1e-9) {
      maxViolations += 1;
    }
  });

  const budgetPassed = budgetCap === null || totalOrderQty <= budgetCap + 1e-9;
  if (!budgetPassed) {
    infeasibleReasons.push('Total order quantity exceeds budget cap.');
  }

  const stockoutPenalty = toNumber(payload?.objective?.stockout_penalty, 1);
  const holdingCost = toNumber(payload?.objective?.holding_cost, 0);
  const estimatedTotalCost = totalOrderQty + (stockoutPenalty * stockoutUnits) + (holdingCost * holdingUnits);

  const constraintChecks = [
    {
      name: 'order_qty_non_negative',
      passed: nonNegativeViolations === 0,
      details: `Negative quantity rows: ${nonNegativeViolations}.`
    },
    {
      name: 'moq',
      passed: moqViolations === 0,
      details: `Rows violating MOQ: ${moqViolations}.`
    },
    {
      name: 'pack_size_multiple',
      passed: packViolations === 0,
      details: `Rows violating pack-size multiple: ${packViolations}.`
    },
    {
      name: 'budget_cap',
      passed: budgetPassed,
      details: budgetCap === null
        ? 'No budget cap provided.'
        : `Total ordered qty ${Number(totalOrderQty.toFixed(6))} vs cap ${Number(budgetCap.toFixed(6))}.`
    },
    {
      name: 'max_order_qty',
      passed: maxViolations === 0,
      details: `Rows violating max_order_qty: ${maxViolations}.`
    }
  ];

  const uniqueReasons = Array.from(new Set(infeasibleReasons.filter(Boolean))).sort();

  if (plan.length === 0 && totalDemand > 0) {
    uniqueReasons.push('No replenishment orders generated for non-zero demand horizon.');
  }
  if (roundingAdjustments.length > 0) {
    uniqueReasons.push(`Rounding adjustments applied: ${roundingAdjustments.length} events.`);
  }

  const allChecksPass = constraintChecks.every((item) => item.passed);
  const status = (plan.length === 0 && totalDemand > 0)
    ? 'infeasible'
    : (allChecksPass && uniqueReasons.length === 0 ? 'optimal' : 'feasible');

  const multiEchelonMode = String(payload?.multi_echelon?.mode || '').trim().toLowerCase() === 'bom_v0'
    ? 'bom_v0'
    : 'off';
  const componentArtifacts = buildComponentFallbackArtifacts({
    payload,
    fgPlan: plan,
    moqBySku,
    packBySku,
    maxBySku
  });

  if (multiEchelonMode === 'bom_v0' && componentArtifacts?.bottlenecks?.total_rows > 0) {
    uniqueReasons.push(`BOM bottlenecks detected: ${componentArtifacts.bottlenecks.total_rows} components.`);
  }

  const serviceLevel = totalDemand > 0
    ? Math.max(0, Math.min(1, 1 - (stockoutUnits / totalDemand)))
    : null;

  return {
    status,
    plan,
    kpis: {
      estimated_service_level: serviceLevel === null ? null : Number(serviceLevel.toFixed(6)),
      estimated_stockout_units: Number(stockoutUnits.toFixed(6)),
      estimated_holding_units: Number(holdingUnits.toFixed(6)),
      estimated_total_cost: Number(estimatedTotalCost.toFixed(6))
    },
    solver_meta: {
      solver: 'heuristic',
      solve_time_ms: Date.now() - started,
      objective_value: Number(estimatedTotalCost.toFixed(6)),
      gap: 0,
      multi_echelon_mode: multiEchelonMode,
      max_bom_depth: toNumber(payload?.multi_echelon?.max_bom_depth, 50),
      bom_explosion_used: Boolean(payload?.multi_echelon?.bom_explosion_used),
      bom_explosion_reused: Boolean(payload?.multi_echelon?.bom_explosion_reused)
    },
    infeasible_reasons: uniqueReasons,
    proof: {
      objective_terms: [
        { name: 'ordered_units', value: Number(totalOrderQty.toFixed(6)), note: 'Total planned replenishment quantity.' },
        { name: 'stockout_units', value: Number(stockoutUnits.toFixed(6)), note: 'Projected unmet demand units.' },
        { name: 'holding_units', value: Number(holdingUnits.toFixed(6)), note: 'Projected positive inventory accumulation.' },
        { name: 'estimated_total_cost', value: Number(estimatedTotalCost.toFixed(6)), note: 'Heuristic cost proxy from order + penalties.' },
        { name: 'component_plan_rows', value: Number(componentArtifacts?.component_plan?.length || 0), note: 'Derived component procurement rows in BOM mode.' }
      ],
      constraints_checked: constraintChecks.concat(
        multiEchelonMode === 'bom_v0'
          ? [{
              name: 'bom_mode',
              passed: true,
              details: `BOM mode active. bottlenecks=${componentArtifacts?.bottlenecks?.total_rows || 0}.`
            }]
          : [],
        roundingAdjustments.length > 0
          ? [{
              name: 'rounding_adjustments',
              passed: true,
              details: roundingAdjustments.slice(0, 25).join('; ')
            }]
          : []
      )
    },
    component_plan: componentArtifacts?.component_plan || [],
    component_inventory_projection: componentArtifacts?.component_inventory_projection || { total_rows: 0, rows: [], truncated: false },
    bottlenecks: componentArtifacts?.bottlenecks || { generated_at: new Date().toISOString(), total_rows: 0, rows: [] }
  };
}

export const optimizationApiClient = {
  isConfigured() {
    return Boolean(normalizeBaseUrl(ML_API_BASE));
  },

  async createReplenishmentPlan(payload, options = {}) {
    const timeoutMs = options.timeoutMs || 20000;
    const allowFallback = options.allowFallback !== false;
    const forceLocal = options.forceLocal === true;

    if (!forceLocal && this.isConfigured()) {
      try {
        return await postJson('/replenishment-plan', payload, timeoutMs);
      } catch (error) {
        if (!allowFallback) {
          throw error;
        }
        const local = runLocalHeuristic(payload);
        local.solver_meta = {
          ...(local.solver_meta || {}),
          solver: 'heuristic',
          fallback_reason: error.message
        };
        return local;
      }
    }

    return runLocalHeuristic(payload);
  }
};

export default optimizationApiClient;
