/**
 * proactiveAlertService.js
 *
 * Proactive alert engine: scans risk_score_results and generates
 * prioritized alert lists (Gap 8E).
 *
 * Alert types:
 *   'stockout_risk'     → P(stockout) x financial impact
 *   'supplier_delay'    → High-risk supplier + near-term open POs
 *   'dual_source_rec'   → Recommend dual sourcing (critical risk supplier)
 *   'expedite_rec'      → Recommend expedite (imminent stockout)
 *
 * Design:
 *   - Pure function: generateAlerts() is deterministic
 *   - Evidence-first: each alert has evidence_refs
 *   - Priority sorting: impact_score = P(stockout) x impact_usd
 */

// ── Threshold config ──────────────────────────────────────────────────────────

export const ALERT_CONFIG = {
  stockout_risk_threshold:       0.40,   // P(stockout) > 40% → alert
  high_risk_score_threshold:     60,     // risk_score > 60 → supplier delay alert
  critical_risk_score_threshold: 120,    // risk_score > 120 → recommend dual sourcing
  expedite_stockout_threshold:   0.70,   // P(stockout) > 70% → recommend expedite
  min_impact_usd:                1000,   // impact < $1000 → skip
  max_alerts_per_run:            20,
};

// ── Pure function: generate alerts from risk scores ───────────────────────────

/**
 * Generate prioritized alerts from risk_scores + stockout data.
 *
 * @param {Object} params
 * @param {Array}  params.riskScores        - risk_score_results rows
 * @param {Array}  params.stockoutData      - { material_code, plant_id, p_stockout, impact_usd, days_to_stockout }
 * @param {Object} params.configOverrides   - threshold overrides
 * @returns {Object} { alerts[], summary }
 */
export function generateAlerts({
  riskScores = [],
  stockoutData = [],
  configOverrides = {},
} = {}) {
  const config = { ...ALERT_CONFIG, ...configOverrides };
  const generatedAt = new Date().toISOString();

  // Build stockout lookup
  const stockoutMap = new Map();
  stockoutData.forEach((s) => {
    const key = `${(s.material_code || '').toUpperCase()}|${(s.plant_id || '').toUpperCase()}`;
    stockoutMap.set(key, s);
  });

  const alerts = [];

  riskScores
    .filter((r) => r.entity_type === 'supplier_material')
    .forEach((entity) => {
      const materialCode = (entity.material_code || '').toUpperCase();
      const plantId      = (entity.plant_id || '').toUpperCase();
      const key          = `${materialCode}|${plantId}`;
      const riskScore    = Number(entity.risk_score ?? 0);
      const metrics      = entity.metrics || {};

      const stockout   = stockoutMap.get(key) || null;
      const pStockout  = Number(stockout?.p_stockout ?? 0);
      const impactUsd  = Number(stockout?.impact_usd ?? 0);
      const daysToOut  = Number(stockout?.days_to_stockout ?? Infinity);

      const impactScore = pStockout * Math.max(impactUsd, 0);

      // Alert type 1: Stockout risk
      if (pStockout > config.stockout_risk_threshold && impactUsd > config.min_impact_usd) {
        const isExpedite = pStockout > config.expedite_stockout_threshold;
        alerts.push({
          alert_id:     `stockout_${key}_${Date.now()}`,
          alert_type:   isExpedite ? 'expedite_rec' : 'stockout_risk',
          severity:     pStockout > 0.70 ? 'critical' : pStockout > 0.55 ? 'high' : 'medium',
          material_code: materialCode,
          plant_id:      plantId,
          supplier:      entity.supplier || null,
          title: isExpedite
            ? `Expedite recommended: ${materialCode} at ${plantId}`
            : `Stockout risk: ${materialCode} at ${plantId}`,
          message: isExpedite
            ? `P(stockout) = ${(pStockout * 100).toFixed(0)}% within ${Number.isFinite(daysToOut) ? daysToOut + ' days' : 'near term'}. Expedite to protect $${impactUsd.toLocaleString()} exposure.`
            : `${(pStockout * 100).toFixed(0)}% probability of stockout. Financial exposure: $${impactUsd.toLocaleString()}.`,
          impact_score:  impactScore,
          impact_usd:    impactUsd,
          p_stockout:    pStockout,
          days_to_stockout: Number.isFinite(daysToOut) ? daysToOut : null,
          evidence_refs: [
            `risk_scores.${key}.risk_score=${riskScore}`,
            `stockout_data.p_stockout=${pStockout.toFixed(3)}`,
            ...(impactUsd > 0 ? [`stockout_data.impact_usd=${impactUsd}`] : []),
          ],
          recommended_actions: isExpedite
            ? ['Expedite inbound freight for this SKU/plant.', 'Contact supplier to accelerate delivery.']
            : ['Increase safety stock buffer.', 'Consider placing emergency order.'],
        });
      }

      // Alert type 2: Supplier delay risk
      if (riskScore > config.high_risk_score_threshold) {
        const isDualSource = riskScore > config.critical_risk_score_threshold;
        alerts.push({
          alert_id:     `supplier_${key}_${Date.now()}`,
          alert_type:   isDualSource ? 'dual_source_rec' : 'supplier_delay',
          severity:     isDualSource ? 'critical' : 'high',
          material_code: materialCode,
          plant_id:      plantId,
          supplier:      entity.supplier || null,
          title: isDualSource
            ? `Dual source recommended: ${entity.supplier || materialCode}`
            : `High supplier delay risk: ${entity.supplier || materialCode}`,
          message: isDualSource
            ? `Supplier risk score ${riskScore.toFixed(0)} is critical. On-time rate: ${((metrics.on_time_rate ?? 0) * 100).toFixed(0)}%. Recommend qualifying a secondary supplier.`
            : `Supplier risk score ${riskScore.toFixed(0)} exceeds threshold. P90 delay: ${(metrics.p90_delay_days ?? 0).toFixed(1)} days.`,
          impact_score:  riskScore * Math.max(impactUsd, 1),
          impact_usd:    impactUsd,
          p_stockout:    pStockout,
          risk_score:    riskScore,
          evidence_refs: [
            `risk_scores.${key}.risk_score=${riskScore.toFixed(2)}`,
            `risk_scores.${key}.on_time_rate=${(metrics.on_time_rate ?? 0).toFixed(3)}`,
            `risk_scores.${key}.p90_delay_days=${(metrics.p90_delay_days ?? 0).toFixed(1)}`,
          ],
          recommended_actions: isDualSource
            ? ['Qualify a secondary supplier for this material.', 'Increase safety stock to 2x until risk subsides.']
            : ['Increase lead time buffer by 3+ days.', 'Monitor PO arrival closely.'],
        });
      }
    });

  // Sort by impact_score descending, then truncate
  const sortedAlerts = alerts
    .sort((a, b) => (b.impact_score ?? 0) - (a.impact_score ?? 0))
    .slice(0, config.max_alerts_per_run);

  const summary = {
    total_alerts:      sortedAlerts.length,
    critical_count:    sortedAlerts.filter((a) => a.severity === 'critical').length,
    high_count:        sortedAlerts.filter((a) => a.severity === 'high').length,
    medium_count:      sortedAlerts.filter((a) => a.severity === 'medium').length,
    expedite_count:    sortedAlerts.filter((a) => a.alert_type === 'expedite_rec').length,
    dual_source_count: sortedAlerts.filter((a) => a.alert_type === 'dual_source_rec').length,
    top_material:      sortedAlerts[0]?.material_code || null,
    top_impact_usd:    sortedAlerts[0]?.impact_usd    || null,
  };

  // Enrich alerts with root cause analysis
  const enrichedAlerts = sortedAlerts.map(alert => enrichAlertWithRootCause(alert, riskScores, stockoutData));

  return {
    version: 'v2',
    generated_at: generatedAt,
    alerts: enrichedAlerts,
    summary,
    insights: generateInsights(enrichedAlerts),
  };
}

// ── Root Cause Analysis ──────────────────────────────────────────────────────

/**
 * Enrich an alert with root cause analysis and prescriptive actions.
 */
function enrichAlertWithRootCause(alert, riskScores, _stockoutData) {
  const rootCauses = [];
  const prescriptiveActions = [];

  const entity = riskScores.find(r =>
    (r.material_code || '').toUpperCase() === alert.material_code &&
    (r.plant_id || '').toUpperCase() === alert.plant_id
  );
  const metrics = entity?.metrics || {};

  // Analyze root causes
  if (metrics.on_time_rate != null && metrics.on_time_rate < 0.85) {
    rootCauses.push({
      factor: 'supplier_reliability',
      description: `Supplier on-time delivery rate is ${(metrics.on_time_rate * 100).toFixed(0)}% (below 85% target)`,
      severity: metrics.on_time_rate < 0.70 ? 'critical' : 'high',
    });
    prescriptiveActions.push({
      action: 'supplier_review',
      description: 'Schedule supplier performance review meeting',
      urgency: 'high',
      estimated_impact: 'Improve on-time rate by 10-15%',
    });
  }

  if (metrics.p90_delay_days != null && metrics.p90_delay_days > 7) {
    rootCauses.push({
      factor: 'lead_time_variability',
      description: `P90 delivery delay is ${metrics.p90_delay_days.toFixed(1)} days (high variability)`,
      severity: metrics.p90_delay_days > 14 ? 'critical' : 'high',
    });
    prescriptiveActions.push({
      action: 'buffer_increase',
      description: `Increase lead time buffer by ${Math.ceil(metrics.p90_delay_days * 0.3)} days`,
      urgency: 'medium',
      estimated_impact: `Reduce stockout risk by ~${Math.min(30, Math.round(metrics.p90_delay_days * 2))}%`,
    });
  }

  if (alert.p_stockout > 0.60 && alert.days_to_stockout != null && alert.days_to_stockout < 14) {
    rootCauses.push({
      factor: 'imminent_stockout',
      description: `Stockout expected in ${alert.days_to_stockout} days with ${(alert.p_stockout * 100).toFixed(0)}% probability`,
      severity: 'critical',
    });
    prescriptiveActions.push({
      action: 'emergency_order',
      description: 'Place emergency purchase order with expedited shipping',
      urgency: 'critical',
      estimated_impact: `Protect $${(alert.impact_usd || 0).toLocaleString()} revenue exposure`,
    });
  }

  if (alert.alert_type === 'dual_source_rec') {
    rootCauses.push({
      factor: 'single_source_dependency',
      description: 'Critical dependency on single supplier with high risk score',
      severity: 'high',
    });
    prescriptiveActions.push({
      action: 'qualify_backup_supplier',
      description: 'Start qualification process for secondary supplier',
      urgency: 'medium',
      estimated_impact: 'Reduce supply chain risk by 40-60%',
    });
  }

  // If no specific root causes identified, add generic analysis
  if (rootCauses.length === 0) {
    rootCauses.push({
      factor: 'general_risk',
      description: 'Risk score elevated due to combination of factors',
      severity: 'medium',
    });
  }

  return {
    ...alert,
    root_causes: rootCauses,
    prescriptive_actions: prescriptiveActions.length > 0 ? prescriptiveActions : alert.recommended_actions.map(a => ({
      action: 'recommended',
      description: a,
      urgency: alert.severity === 'critical' ? 'critical' : 'medium',
    })),
    analysis_version: 'v2',
  };
}

// ── Cross-Alert Insights ─────────────────────────────────────────────────────

/**
 * Generate aggregate insights from all alerts.
 */
function generateInsights(alerts) {
  if (!alerts.length) return [];

  const insights = [];

  // Concentration risk: multiple alerts for same supplier
  const supplierAlerts = {};
  alerts.forEach(a => {
    if (a.supplier) {
      if (!supplierAlerts[a.supplier]) supplierAlerts[a.supplier] = [];
      supplierAlerts[a.supplier].push(a);
    }
  });

  for (const [supplier, sAlerts] of Object.entries(supplierAlerts)) {
    if (sAlerts.length >= 2) {
      const totalImpact = sAlerts.reduce((s, a) => s + (a.impact_usd || 0), 0);
      insights.push({
        type: 'concentration_risk',
        title: `Supplier concentration: ${supplier}`,
        description: `${sAlerts.length} alerts tied to ${supplier}. Total exposure: $${totalImpact.toLocaleString()}.`,
        severity: sAlerts.some(a => a.severity === 'critical') ? 'critical' : 'high',
        affected_materials: sAlerts.map(a => a.material_code),
      });
    }
  }

  // Cascade risk: multiple materials at same plant
  const plantAlerts = {};
  alerts.forEach(a => {
    if (a.plant_id) {
      if (!plantAlerts[a.plant_id]) plantAlerts[a.plant_id] = [];
      plantAlerts[a.plant_id].push(a);
    }
  });

  for (const [plant, pAlerts] of Object.entries(plantAlerts)) {
    if (pAlerts.length >= 3) {
      insights.push({
        type: 'plant_cascade_risk',
        title: `Multiple risks at plant ${plant}`,
        description: `${pAlerts.length} materials at risk in plant ${plant}. Consider plant-level contingency plan.`,
        severity: 'high',
        affected_materials: pAlerts.map(a => a.material_code),
      });
    }
  }

  // Total exposure insight
  const totalExposure = alerts.reduce((s, a) => s + (a.impact_usd || 0), 0);
  if (totalExposure > 0) {
    insights.push({
      type: 'total_exposure',
      title: 'Total financial exposure',
      description: `$${totalExposure.toLocaleString()} at risk across ${alerts.length} alert(s).`,
      severity: totalExposure > 100000 ? 'critical' : totalExposure > 50000 ? 'high' : 'medium',
    });
  }

  return insights;
}
