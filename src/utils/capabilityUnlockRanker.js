/**
 * Capability Unlock Ranker
 *
 * Given current capabilities and data quality, ranks missing datasets
 * by the value they would unlock if uploaded. Prioritizes datasets that
 * unlock the most capabilities or affect the most rows.
 */

import { CAPABILITY_MATRIX } from '../config/capabilityMatrix';

const DATASET_LABELS = {
  demand_fg: 'Demand Forecast (FG)',
  inventory_snapshots: 'Inventory Snapshots',
  po_open_lines: 'Open Purchase Orders',
  fg_financials: 'FG Financials (Unit Margin)',
  bom_edge: 'Bill of Materials (BOM)',
  goods_receipt: 'Goods Receipts',
  supplier_master: 'Supplier Master',
};

const IMPACT_HINTS = {
  po_open_lines: 'Enable inbound-aware planning and reduce over-ordering',
  fg_financials: 'Enable profit-at-risk analysis and financial prioritization',
  bom_edge: 'Enable multi-echelon BOM planning for component-level visibility',
  goods_receipt: 'Enable supplier risk scoring based on delivery history',
  supplier_master: 'Enrich supplier risk analysis with master data',
};

/**
 * Rank missing datasets by the value they would unlock.
 *
 * @param {Record<string, { available, level, missingDatasets, label }>} capabilities
 *   Output from evaluateCapabilities()
 * @param {{ rows_with_fallback?: number, rows_with_full_data?: number }} lineageSummary
 *   Optional lineage summary from plan_table artifact
 * @returns {Array<{ dataset, label, unlocks, estimated_impact, hint, priority_score }>}
 */
export function rankCapabilityUnlocks(capabilities, _lineageSummary = {}) {
  // Collect all missing datasets across all capabilities
  const datasetImpact = {};

  for (const [capKey, cap] of Object.entries(capabilities)) {
    if (cap.level === 'unavailable' || cap.level === 'partial') {
      for (const ds of (cap.missingDatasets || [])) {
        if (!datasetImpact[ds]) {
          datasetImpact[ds] = { unlocks: [], partials: [], capCount: 0 };
        }
        if (cap.level === 'unavailable') {
          datasetImpact[ds].unlocks.push(capKey);
        } else {
          datasetImpact[ds].partials.push(capKey);
        }
        datasetImpact[ds].capCount++;
      }
      // Also check optional missing
      for (const ds of (cap.optionalMissing || [])) {
        if (!datasetImpact[ds]) {
          datasetImpact[ds] = { unlocks: [], partials: [], capCount: 0 };
        }
        datasetImpact[ds].partials.push(capKey);
        datasetImpact[ds].capCount++;
      }
    }
  }

  // Score each missing dataset
  const ranked = Object.entries(datasetImpact).map(([ds, impact]) => {
    const unlockLabels = impact.unlocks.map(k => CAPABILITY_MATRIX[k]?.label || k);
    const partialLabels = impact.partials.map(k => CAPABILITY_MATRIX[k]?.label || k);

    // Priority score: unlock weight > partial weight
    const score = impact.unlocks.length * 3 + impact.partials.length * 1;

    // Estimated impact level
    let estimated_impact = 'low';
    if (impact.unlocks.length >= 2) estimated_impact = 'high';
    else if (impact.unlocks.length >= 1) estimated_impact = 'medium';

    return {
      dataset: ds,
      label: DATASET_LABELS[ds] || ds,
      unlocks: unlockLabels,
      improves: partialLabels,
      estimated_impact,
      hint: IMPACT_HINTS[ds] || `Upload ${DATASET_LABELS[ds] || ds} to unlock additional capabilities`,
      priority_score: score,
    };
  });

  // Sort by priority score descending
  ranked.sort((a, b) => b.priority_score - a.priority_score);

  return ranked;
}

/**
 * Get a concise "top recommendation" string for inline display.
 */
export function getTopUnlockHint(capabilities) {
  const ranked = rankCapabilityUnlocks(capabilities);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  return `Upload ${top.label} to unlock: ${top.unlocks.join(', ') || top.improves.join(', ')}`;
}
