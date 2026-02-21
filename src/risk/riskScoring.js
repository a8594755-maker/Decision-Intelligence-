const DAY_MS = 24 * 60 * 60 * 1000;

const normalizeText = (value) => String(value || '').trim();
const normalizeKey = (value, fallback = 'unknown') => {
  const normalized = normalizeText(value);
  return normalized || fallback;
};

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));

const parseDateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && value > 1 && value < 100000) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + (value * DAY_MS));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const weekMatch = raw.match(/^(\d{4})[-/ ]?W(\d{1,2})$/i);
  if (weekMatch) {
    const year = Number(weekMatch[1]);
    const week = Number(weekMatch[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const target = new Date(week1Monday);
    target.setUTCDate(week1Monday.getUTCDate() + ((week - 1) * 7));
    return Number.isNaN(target.getTime()) ? null : target;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toIsoDay = (dateObj) => (
  dateObj && !Number.isNaN(dateObj.getTime()) ? dateObj.toISOString().slice(0, 10) : null
);

const mean = (values = []) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stddev = (values = []) => {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
};

const percentile = (values = [], p = 0.9) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const ratio = position - lower;
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * ratio);
};

const safeRound = (value, digits = 4) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(digits));
};

const severityRank = (value) => {
  if (value >= 80) return 4;
  if (value >= 70) return 3;
  if (value >= 55) return 2;
  return 1;
};

const buildEntityId = (entityType, supplier, materialCode, plantId = null) => {
  if (entityType === 'supplier') return normalizeKey(supplier, 'unknown_supplier');
  if (entityType === 'material') return normalizeKey(materialCode, 'unknown_material');
  const supplierKey = normalizeKey(supplier, 'unknown_supplier');
  const materialKey = normalizeKey(materialCode, 'unknown_material');
  const plantKey = normalizeKey(plantId, '');
  return [supplierKey, materialKey, plantKey].filter(Boolean).join('|');
};

const ensureEntityMetrics = (map, entityType, supplier, materialCode, plantId = null) => {
  const entityId = buildEntityId(entityType, supplier, materialCode, plantId);
  const key = `${entityType}:${entityId}`;
  if (!map.has(key)) {
    map.set(key, {
      entity_type: entityType,
      entity_id: entityId,
      supplier: normalizeKey(supplier, null),
      material_code: normalizeKey(materialCode, null),
      plant_id: normalizeKey(plantId, null),
      on_time_total: 0,
      on_time_hits: 0,
      delays: [],
      delay_points: [],
      open_backlog_qty: 0,
      overdue_open_qty: 0,
      receipts_count: 0,
      open_lines_count: 0,
      receipt_qty_total: 0
    });
  }
  return map.get(key);
};

const addOpenLineMetrics = (entity, row, nowDate) => {
  const qty = Math.max(0, toNumber(row.open_qty, 0));
  entity.open_backlog_qty += qty;
  entity.open_lines_count += 1;

  const promisedDate = parseDateValue(row.promised_date);
  if (promisedDate && promisedDate < nowDate) {
    entity.overdue_open_qty += qty;
  }
};

const addReceiptMetrics = (entity, row) => {
  entity.receipts_count += 1;
  entity.receipt_qty_total += Math.max(0, toNumber(row.received_qty, 0));

  const actualDate = parseDateValue(row.actual_delivery_date);
  const promisedDate = parseDateValue(row.promised_date);
  if (!actualDate || !promisedDate) return;

  const delayDays = Math.round((actualDate.getTime() - promisedDate.getTime()) / DAY_MS);
  entity.on_time_total += 1;
  if (delayDays <= 0) entity.on_time_hits += 1;
  entity.delays.push(delayDays);
  entity.delay_points.push({
    actual_date: toIsoDay(actualDate),
    promised_date: toIsoDay(promisedDate),
    delay_days: delayDays
  });
};

const aggregateEntityMetrics = ({ po_open_lines = [], goods_receipt = [], nowDate }) => {
  const entityMap = new Map();
  const today = parseDateValue(nowDate) || new Date();

  po_open_lines.forEach((row) => {
    const supplier = normalizeKey(row.supplier, 'unknown_supplier');
    const materialCode = normalizeKey(row.material_code, 'unknown_material');
    const plantId = normalizeKey(row.plant_id, null);

    addOpenLineMetrics(ensureEntityMetrics(entityMap, 'supplier', supplier, null, null), row, today);
    addOpenLineMetrics(ensureEntityMetrics(entityMap, 'material', null, materialCode, null), row, today);
    addOpenLineMetrics(ensureEntityMetrics(entityMap, 'supplier_material', supplier, materialCode, plantId), row, today);
  });

  goods_receipt.forEach((row) => {
    const supplier = normalizeKey(row.supplier, 'unknown_supplier');
    const materialCode = normalizeKey(row.material_code, 'unknown_material');
    const plantId = normalizeKey(row.plant_id, null);

    addReceiptMetrics(ensureEntityMetrics(entityMap, 'supplier', supplier, null, null), row);
    addReceiptMetrics(ensureEntityMetrics(entityMap, 'material', null, materialCode, null), row);
    addReceiptMetrics(ensureEntityMetrics(entityMap, 'supplier_material', supplier, materialCode, plantId), row);
  });

  return Array.from(entityMap.values());
};

const computeTrend = (delayPoints = [], nowDate) => {
  const now = parseDateValue(nowDate) || new Date();
  const recentCutoff = new Date(now.getTime() - (28 * DAY_MS));
  const previousCutoff = new Date(now.getTime() - (56 * DAY_MS));

  const recent = [];
  const previous = [];

  delayPoints.forEach((point) => {
    const actualDate = parseDateValue(point.actual_date);
    if (!actualDate) return;
    if (actualDate >= recentCutoff) {
      recent.push(point.delay_days);
    } else if (actualDate >= previousCutoff && actualDate < recentCutoff) {
      previous.push(point.delay_days);
    }
  });

  if (recent.length < 2 || previous.length < 2) {
    return { label: 'stable', delta_days: null };
  }

  const delta = mean(recent) - mean(previous);
  if (delta > 1) return { label: 'worsening', delta_days: safeRound(delta, 3) };
  if (delta < -1) return { label: 'improving', delta_days: safeRound(delta, 3) };
  return { label: 'stable', delta_days: safeRound(delta, 3) };
};

const driverDescriptor = {
  on_time_risk: {
    name: 'on_time_rate',
    note: 'Lower on-time delivery increases risk.'
  },
  avg_delay_risk: {
    name: 'avg_delay_days',
    note: 'Higher average delay increases risk.'
  },
  p90_delay_risk: {
    name: 'p90_delay_days',
    note: 'Tail delays increase risk.'
  },
  variability_risk: {
    name: 'lead_time_variability',
    note: 'High delay variability reduces planning reliability.'
  },
  overdue_risk: {
    name: 'overdue_open_ratio',
    note: 'A larger overdue backlog increases exception risk.'
  },
  backlog_scale_risk: {
    name: 'open_backlog_qty',
    note: 'Large backlog volume amplifies impact.'
  },
  trend_risk: {
    name: 'recent_trend',
    note: 'Worsening trend increases risk.'
  }
};

const computeRiskComponents = (entity, maxBacklogForType = 1, nowDate) => {
  const onTimeRate = entity.on_time_total > 0
    ? entity.on_time_hits / entity.on_time_total
    : null;
  const avgDelayDays = entity.delays.length ? mean(entity.delays) : 0;
  const p90DelayDays = entity.delays.length ? percentile(entity.delays, 0.9) : 0;
  const variability = entity.delays.length ? stddev(entity.delays) : 0;
  const overdueRatio = entity.open_backlog_qty > 0
    ? entity.overdue_open_qty / entity.open_backlog_qty
    : 0;
  const trend = computeTrend(entity.delay_points, nowDate);

  const normalized = {
    on_time_risk: clamp01(onTimeRate === null ? 0.5 : 1 - onTimeRate),
    avg_delay_risk: clamp01(avgDelayDays / 14),
    p90_delay_risk: clamp01(p90DelayDays / 21),
    variability_risk: clamp01(variability / 10),
    overdue_risk: clamp01(overdueRatio),
    backlog_scale_risk: clamp01(entity.open_backlog_qty / Math.max(1, maxBacklogForType)),
    trend_risk: trend.label === 'worsening' ? 1 : trend.label === 'improving' ? 0.2 : 0.5
  };

  const weights = {
    on_time_risk: 0.3,
    avg_delay_risk: 0.2,
    p90_delay_risk: 0.1,
    variability_risk: 0.1,
    overdue_risk: 0.2,
    backlog_scale_risk: 0.05,
    trend_risk: 0.05
  };

  const contributions = Object.entries(weights).map(([key, weight]) => {
    const value = normalized[key];
    return {
      key,
      weight,
      value,
      contribution: value * weight
    };
  });

  const riskScore = safeRound(
    contributions.reduce((sum, item) => sum + item.contribution, 0) * 100,
    2
  ) || 0;

  const metrics = {
    on_time_rate: onTimeRate === null ? null : safeRound(onTimeRate, 4),
    avg_delay_days: safeRound(avgDelayDays, 3) || 0,
    p90_delay_days: safeRound(p90DelayDays, 3) || 0,
    lead_time_variability: safeRound(variability, 3) || 0,
    open_backlog_qty: safeRound(entity.open_backlog_qty, 3) || 0,
    overdue_open_qty: safeRound(entity.overdue_open_qty, 3) || 0,
    overdue_ratio: safeRound(overdueRatio, 4) || 0,
    recent_trend: trend.label,
    trend_delta_days: trend.delta_days,
    receipts_count: entity.receipts_count,
    open_lines_count: entity.open_lines_count
  };

  const drivers = contributions
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 4)
    .map((item) => ({
      name: driverDescriptor[item.key]?.name || item.key,
      weight: item.weight,
      normalized_value: safeRound(item.value, 4),
      contribution: safeRound(item.contribution, 4),
      note: driverDescriptor[item.key]?.note || ''
    }));

  return {
    risk_score: riskScore,
    metrics,
    drivers
  };
};

export function computeRiskScores({
  po_open_lines = [],
  goods_receipt = [],
  now_date = null
} = {}) {
  const providedNow = parseDateValue(now_date);
  const inferredLatest = [...(Array.isArray(po_open_lines) ? po_open_lines : []), ...(Array.isArray(goods_receipt) ? goods_receipt : [])]
    .flatMap((row) => [row?.promised_date, row?.actual_delivery_date, row?.order_date])
    .map((value) => parseDateValue(value))
    .filter(Boolean)
    .sort((a, b) => a - b)
    .pop();
  const nowDate = providedNow || inferredLatest || new Date(Date.UTC(2026, 0, 1));
  const entityMetrics = aggregateEntityMetrics({
    po_open_lines: Array.isArray(po_open_lines) ? po_open_lines : [],
    goods_receipt: Array.isArray(goods_receipt) ? goods_receipt : [],
    nowDate
  });

  const maxBacklogByType = entityMetrics.reduce((acc, entity) => {
    const existing = acc[entity.entity_type] || 0;
    const next = Math.max(existing, toNumber(entity.open_backlog_qty, 0));
    return { ...acc, [entity.entity_type]: next };
  }, {});

  const riskScores = entityMetrics
    .map((entity) => {
      const computed = computeRiskComponents(entity, maxBacklogByType[entity.entity_type] || 1, nowDate);
      const evidenceRefs = [
        `metric:${entity.entity_type}:${entity.entity_id}:on_time_rate`,
        `metric:${entity.entity_type}:${entity.entity_id}:avg_delay_days`,
        `metric:${entity.entity_type}:${entity.entity_id}:overdue_open_qty`
      ];

      return {
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
        supplier: entity.supplier,
        material_code: entity.material_code,
        plant_id: entity.plant_id,
        risk_score: computed.risk_score,
        drivers: computed.drivers,
        evidence_refs: evidenceRefs,
        metrics: computed.metrics
      };
    })
    .sort((a, b) => {
      if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;
      if (severityRank(b.risk_score) !== severityRank(a.risk_score)) {
        return severityRank(b.risk_score) - severityRank(a.risk_score);
      }
      if (a.entity_type !== b.entity_type) return a.entity_type.localeCompare(b.entity_type);
      return a.entity_id.localeCompare(b.entity_id);
    });

  const supportingMetrics = {
    generated_at: `${toIsoDay(nowDate)}T00:00:00.000Z`,
    inputs: {
      po_rows: Array.isArray(po_open_lines) ? po_open_lines.length : 0,
      receipt_rows: Array.isArray(goods_receipt) ? goods_receipt.length : 0
    },
    aggregates: {
      supplier_entities: riskScores.filter((item) => item.entity_type === 'supplier').length,
      material_entities: riskScores.filter((item) => item.entity_type === 'material').length,
      supplier_material_entities: riskScores.filter((item) => item.entity_type === 'supplier_material').length,
      high_risk_count: riskScores.filter((item) => item.risk_score >= 70).length,
      medium_risk_count: riskScores.filter((item) => item.risk_score >= 55 && item.risk_score < 70).length
    },
    entity_metrics: riskScores.map((item) => ({
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      supplier: item.supplier,
      material_code: item.material_code,
      plant_id: item.plant_id,
      risk_score: item.risk_score,
      ...item.metrics
    }))
  };

  return {
    risk_scores: riskScores,
    supporting_metrics: supportingMetrics
  };
}

export default {
  computeRiskScores
};
