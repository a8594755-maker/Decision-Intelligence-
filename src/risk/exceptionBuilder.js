const severityRank = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

const normalizeText = (value) => String(value || '').trim();

const buildEntityLabel = (item) => {
  if (item.entity_type === 'supplier') {
    return normalizeText(item.supplier) || item.entity_id;
  }
  if (item.entity_type === 'material') {
    return normalizeText(item.material_code) || item.entity_id;
  }
  const supplier = normalizeText(item.supplier) || 'unknown_supplier';
  const material = normalizeText(item.material_code) || 'unknown_material';
  const plant = normalizeText(item.plant_id);
  return plant ? `${supplier} / ${material} @ ${plant}` : `${supplier} / ${material}`;
};

const dedupeActions = (actions = []) => {
  const seen = new Set();
  const unique = [];
  actions.forEach((action) => {
    const normalized = normalizeText(action);
    if (!normalized) return;
    if (seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    unique.push(normalized);
  });
  return unique;
};

const classifySeverity = (riskScore = 0) => {
  const score = Number(riskScore || 0);
  if (score >= 85) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
};

const buildDescription = (item) => {
  const metrics = item.metrics || {};
  const delays = Number(metrics.avg_delay_days || 0);
  const overdue = Number(metrics.overdue_open_qty || 0);
  const onTimeRate = Number(metrics.on_time_rate);
  const onTimeText = Number.isFinite(onTimeRate)
    ? `${(onTimeRate * 100).toFixed(1)}% on-time`
    : 'on-time rate unavailable';

  const parts = [
    `Risk score ${Number(item.risk_score || 0).toFixed(1)}.`,
    onTimeText,
    `${delays.toFixed(1)} avg delay days.`,
    `${overdue.toFixed(0)} overdue open qty.`
  ];
  return parts.join(' ');
};

const buildActions = (item) => {
  const metrics = item.metrics || {};
  const actions = [];

  if (Number(metrics.overdue_open_qty || 0) > 0 && metrics.recent_trend === 'worsening') {
    actions.push('Expedite overdue orders and contact supplier for commit dates.');
    actions.push('Split urgent shipments and prioritize critical materials.');
  }

  if (Number(metrics.on_time_rate) < 0.85) {
    actions.push('Run supplier performance review and corrective action plan.');
    actions.push('Adjust planning lead times to reflect current reliability.');
  }

  if (Number(metrics.avg_delay_days || 0) >= 5) {
    actions.push('Increase safety stock buffer for impacted materials.');
  }

  if (Number(metrics.lead_time_variability || 0) >= 7) {
    actions.push('Use staggered purchase orders to reduce delay volatility.');
  }

  if (Number(metrics.overdue_ratio || 0) >= 0.3) {
    actions.push('Rebalance allocation to protect near-term service levels.');
  }

  if (actions.length === 0) {
    actions.push('Continue weekly monitoring and keep current controls.');
  }

  return dedupeActions(actions).slice(0, 4);
};

const shouldInclude = (item) => {
  const score = Number(item?.risk_score || 0);
  const metrics = item?.metrics || {};
  if (score >= 55) return true;
  if (Number(metrics.overdue_open_qty || 0) > 0) return true;
  if (metrics.recent_trend === 'worsening' && score >= 45) return true;
  return false;
};

export function buildExceptions({
  risk_scores = [],
  max_exceptions = 120
} = {}) {
  const rows = Array.isArray(risk_scores) ? risk_scores : [];

  const exceptions = rows
    .filter(shouldInclude)
    .map((item) => {
      const severity = classifySeverity(item.risk_score);
      const entity = {
        entity_type: item.entity_type,
        entity_id: item.entity_id,
        supplier: item.supplier || null,
        material_code: item.material_code || null,
        plant_id: item.plant_id || null,
        label: buildEntityLabel(item)
      };

      return {
        severity,
        risk_score: Number(item.risk_score || 0),
        entity,
        description: buildDescription(item),
        recommended_actions: buildActions(item),
        evidence_refs: Array.isArray(item.evidence_refs) ? item.evidence_refs : []
      };
    })
    .sort((a, b) => {
      const severityDiff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
      if (severityDiff !== 0) return severityDiff;
      if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;
      return (a.entity?.label || '').localeCompare(b.entity?.label || '');
    })
    .slice(0, Math.max(1, Number(max_exceptions) || 120));

  const aggregates = {
    total: exceptions.length,
    critical: exceptions.filter((item) => item.severity === 'critical').length,
    high: exceptions.filter((item) => item.severity === 'high').length,
    medium: exceptions.filter((item) => item.severity === 'medium').length,
    low: exceptions.filter((item) => item.severity === 'low').length
  };

  return {
    exceptions,
    aggregates
  };
}

export default {
  buildExceptions
};
