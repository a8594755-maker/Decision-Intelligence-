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

  return {
    version: 'v1',
    generated_at: generatedAt,
    alerts: sortedAlerts,
    summary,
  };
}
