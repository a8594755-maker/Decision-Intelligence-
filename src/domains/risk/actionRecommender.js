/**
 * Action Recommender Engine (Pure Functions)
 *
 * Generates per-row recommended actions and decision ranking score.
 * Inputs: enriched risk row (with assumptions, confidence_score)
 * Outputs: ranked actions array + decision_ranking_score
 */

export const ACTION_TYPES = {
  EXPEDITE: 'expedite',
  TRANSFER_STOCK: 'transfer_stock',
  CHANGE_SUPPLIER: 'change_supplier',
  INCREASE_SAFETY: 'increase_safety_stock',
  REVIEW_DEMAND: 'review_demand',
  UPLOAD_DATA: 'upload_missing_data',
};

/**
 * Compute decision ranking score for a single row.
 * Multi-signal composite: stockout_likelihood × revenue_impact × data_confidence × supplier_reliability
 *
 * @param {Object} row - Enriched UI row
 * @param {Object} context - { maxProfitAtRisk, maxRevAtRisk }
 * @returns {number} 0-1 composite score (higher = more urgent)
 */
export function computeDecisionRankingScore(row, context = {}) {
  const maxProfitAtRisk = context.maxProfitAtRisk || 1;
  const maxRevAtRisk = context.maxRevAtRisk || 1;

  // Factor 1: Stockout likelihood
  const pStockout = row.pStockout ?? (
    row.riskLevel === 'critical' ? 0.9 :
    row.riskLevel === 'warning' ? 0.5 : 0.1
  );

  // Factor 2: Revenue impact (normalized)
  const revenueSignal = row.revTotalAtRisk
    ? Math.min(row.revTotalAtRisk / maxRevAtRisk, 1)
    : Math.min((row.profitAtRisk || 0) / maxProfitAtRisk, 1);

  // Factor 3: Data confidence gap (low confidence → higher need)
  const dataConfidenceGap = 1 - (row.confidence_score ?? 0.5);

  // Factor 4: Supplier reliability concern
  const supplierConcern = row.riskScoreUrgency
    ? Math.min(row.riskScoreUrgency / 1.5, 1)
    : (row.riskLevel === 'critical' ? 0.8 : row.riskLevel === 'warning' ? 0.5 : 0.2);

  const score = (
    pStockout * 0.35 +
    revenueSignal * 0.30 +
    dataConfidenceGap * 0.15 +
    supplierConcern * 0.20
  );

  return Math.round(Math.min(score, 1) * 1000) / 1000;
}

/**
 * Generate recommended actions for a single risk row.
 *
 * @param {Object} row - Enriched UI row (with assumptions, computationTrace, etc.)
 * @param {Object} context - { maxProfitAtRisk }
 * @returns {Array<Object>} Sorted actions array
 */
export function generateRowActions(row, _context = {}) {
  const actions = [];

  // 1. EXPEDITE: if critical/warning with inbound POs to shift
  if ((row.riskLevel === 'critical' || row.riskLevel === 'warning') && (row.inboundCount || 0) > 0) {
    const savingEstimate = Math.min(row.inboundQty || 0, row.gapQty || 0) * (row.profitPerUnit || 10);
    actions.push({
      type: ACTION_TYPES.EXPEDITE,
      title: 'Expedite inbound shipment',
      description: `Shift ${row.nextTimeBucket || 'next'} PO earlier to close gap of ${row.gapQty}`,
      expected_impact_usd: savingEstimate,
      priority: row.riskLevel === 'critical' ? 0.9 : 0.6,
      feasibility: 'high',
      evidence: [`inboundCount=${row.inboundCount}`, `gapQty=${row.gapQty}`]
    });
  }

  // 2. TRANSFER_STOCK: if gap exists and on-hand is below safety stock
  if ((row.gapQty || 0) > 0 && (row.onHand || 0) < (row.safetyStock || 0)) {
    actions.push({
      type: ACTION_TYPES.TRANSFER_STOCK,
      title: 'Inter-plant stock transfer',
      description: `Check if other plants have surplus of ${row.item} to transfer`,
      expected_impact_usd: (row.gapQty || 0) * (row.profitPerUnit || 10) * 0.5,
      priority: 0.5,
      feasibility: 'medium',
      evidence: [`onHand=${row.onHand}`, `safetyStock=${row.safetyStock}`]
    });
  }

  // 3. CHANGE_SUPPLIER: if high risk score or critical
  if ((row.riskScore || 0) > 5000 || row.riskLevel === 'critical') {
    actions.push({
      type: ACTION_TYPES.CHANGE_SUPPLIER,
      title: 'Qualify alternate supplier',
      description: 'Current supplier risk is elevated; qualify a backup source',
      expected_impact_usd: (row.profitAtRisk || 0) * 0.3,
      priority: (row.riskScore || 0) > 10000 ? 0.8 : 0.4,
      feasibility: 'low',
      evidence: [`riskScore=${row.riskScore || 0}`]
    });
  }

  // 4. INCREASE_SAFETY_STOCK: if safety stock is 0 or gap exists
  if ((row.safetyStock || 0) === 0 || (row.gapQty || 0) > 0) {
    const suggestedSS = Math.ceil((row.dailyDemand || 10) * (row.leadTimeDaysUsed || 7) * 0.5);
    actions.push({
      type: ACTION_TYPES.INCREASE_SAFETY,
      title: 'Increase safety stock',
      description: `Suggested: set safety stock to ${suggestedSS} units`,
      expected_impact_usd: 0,
      priority: 0.3,
      feasibility: 'high',
      evidence: [`currentSS=${row.safetyStock || 0}`, `suggestedSS=${suggestedSS}`]
    });
  }

  // 5. REVIEW_DEMAND: if no demand data
  if (!row.daysToStockout || row.daysToStockout === Infinity) {
    actions.push({
      type: ACTION_TYPES.REVIEW_DEMAND,
      title: 'Review demand forecast',
      description: 'No demand data available; run BOM explosion to get daysToStockout',
      expected_impact_usd: 0,
      priority: 0.2,
      feasibility: 'high',
      evidence: ['daysToStockout=N/A']
    });
  }

  // 6. UPLOAD_DATA: if assumptions are being used
  const defaultAssumptions = (row.assumptions || []).filter(a => a.isDefault);
  if (defaultAssumptions.length > 0) {
    const fields = defaultAssumptions.map(a => a.field).join(', ');
    actions.push({
      type: ACTION_TYPES.UPLOAD_DATA,
      title: 'Upload missing data',
      description: `Missing real data for: ${fields}`,
      expected_impact_usd: 0,
      priority: 0.15,
      feasibility: 'high',
      evidence: defaultAssumptions.map(a => `${a.field}=${a.source}`)
    });
  }

  // Sort by priority descending, then by expected_impact_usd
  actions.sort((a, b) => b.priority - a.priority || b.expected_impact_usd - a.expected_impact_usd);

  return actions;
}

/**
 * Batch: generate actions and ranking for all rows.
 *
 * @param {Array} rows - Enriched UI rows
 * @returns {Object} { rows: enrichedRows, summary }
 */
export function generateActionsBatch(rows) {
  if (!rows || rows.length === 0) return { rows: [], summary: {} };

  const maxProfitAtRisk = Math.max(...rows.map(r => r.profitAtRisk || 0), 1);
  const maxRevAtRisk = Math.max(...rows.map(r => r.revTotalAtRisk || 0), 1);
  const context = { maxProfitAtRisk, maxRevAtRisk };

  const enriched = rows.map(row => {
    const recommendedActions = generateRowActions(row, context);
    const decisionRankingScore = computeDecisionRankingScore(row, context);
    return {
      ...row,
      recommendedActions,
      topAction: recommendedActions[0] || null,
      decisionRankingScore
    };
  });

  const actionCounts = {};
  enriched.forEach(r => {
    if (r.topAction) {
      actionCounts[r.topAction.type] = (actionCounts[r.topAction.type] || 0) + 1;
    }
  });

  return {
    rows: enriched,
    summary: {
      totalActions: enriched.reduce((s, r) => s + (r.recommendedActions?.length || 0), 0),
      rowsWithActions: enriched.filter(r => r.recommendedActions?.length > 0).length,
      topActionDistribution: actionCounts,
      avgDecisionScore: enriched.length > 0
        ? Math.round(enriched.reduce((s, r) => s + (r.decisionRankingScore || 0), 0) / enriched.length * 1000) / 1000
        : 0
    }
  };
}
