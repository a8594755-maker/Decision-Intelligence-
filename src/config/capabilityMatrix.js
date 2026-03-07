/**
 * Capability Matrix
 *
 * Defines which system features require which data types and fields.
 * Used to evaluate what the system CAN do given the available data,
 * instead of blocking on missing data (all-or-nothing).
 */

export const CAPABILITY_MATRIX = {
  forecast: {
    label: 'Demand Forecast',
    description: 'Time-series demand forecasting',
    requiredDatasets: ['demand_fg'],
    optionalDatasets: [],
    minFields: {
      demand_fg: ['material_code', 'demand_qty'],
    },
    timeFieldRequired: { demand_fg: ['week_bucket', 'date', 'time_bucket'] },
  },

  basic_plan: {
    label: 'Basic Replenishment Plan',
    description: 'Shortage-based replenishment planning using current inventory and demand',
    requiredDatasets: ['demand_fg', 'inventory_snapshots'],
    optionalDatasets: ['po_open_lines', 'fg_financials', 'bom_edge'],
    minFields: {
      demand_fg: ['material_code', 'plant_id', 'demand_qty'],
      inventory_snapshots: ['material_code', 'plant_id', 'onhand_qty'],
    },
    timeFieldRequired: {
      demand_fg: ['week_bucket', 'date', 'time_bucket'],
      inventory_snapshots: ['snapshot_date', 'date', 'time_bucket', 'week_bucket'],
    },
  },

  inbound_aware_plan: {
    label: 'Inbound-Aware Planning',
    description: 'Replenishment planning that considers incoming PO quantities and ETAs',
    requiredDatasets: ['demand_fg', 'inventory_snapshots', 'po_open_lines'],
    optionalDatasets: ['fg_financials'],
    minFields: {
      demand_fg: ['material_code', 'plant_id', 'demand_qty'],
      inventory_snapshots: ['material_code', 'plant_id', 'onhand_qty'],
      po_open_lines: ['material_code', 'open_qty'],
    },
    timeFieldRequired: {
      po_open_lines: ['week_bucket', 'date', 'time_bucket'],
    },
    degradationNote: 'Without open PO data, inbound arrivals will not be considered — the plan may over-order.',
  },

  shortage_risk: {
    label: 'Shortage / Stockout Risk',
    description: 'Identifies materials at risk of stockout',
    requiredDatasets: ['demand_fg', 'inventory_snapshots'],
    optionalDatasets: ['po_open_lines'],
    minFields: {
      demand_fg: ['material_code', 'plant_id', 'demand_qty'],
      inventory_snapshots: ['material_code', 'plant_id', 'onhand_qty'],
    },
    timeFieldRequired: {},
  },

  supplier_risk: {
    label: 'Supplier Risk Scoring',
    description: 'Scores supplier reliability based on delivery history',
    requiredDatasets: ['goods_receipt'],
    optionalDatasets: ['po_open_lines', 'supplier_master'],
    minFields: {
      goods_receipt: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'],
    },
    timeFieldRequired: {},
  },

  profit_at_risk: {
    label: 'Profit at Risk',
    description: 'Calculates financial impact of shortages using margin data',
    requiredDatasets: ['demand_fg', 'inventory_snapshots', 'fg_financials'],
    optionalDatasets: [],
    minFields: {
      demand_fg: ['material_code', 'plant_id', 'demand_qty'],
      inventory_snapshots: ['material_code', 'plant_id', 'onhand_qty'],
      fg_financials: ['material_code', 'unit_margin'],
    },
    timeFieldRequired: {},
    degradationNote: 'Without financial data (unit_margin), profit-at-risk analysis is unavailable. Shortage risk is still calculated.',
  },

  multi_echelon: {
    label: 'Multi-Echelon BOM Planning',
    description: 'Explodes BOM to plan component-level replenishment',
    requiredDatasets: ['demand_fg', 'inventory_snapshots', 'bom_edge'],
    optionalDatasets: ['po_open_lines'],
    minFields: {
      demand_fg: ['material_code', 'plant_id', 'demand_qty'],
      inventory_snapshots: ['material_code', 'plant_id', 'onhand_qty'],
      bom_edge: ['parent_material', 'child_material', 'qty_per'],
    },
    timeFieldRequired: {},
    degradationNote: 'Without BOM data, multi-echelon planning is unavailable. Single-level planning proceeds normally.',
  },
};

/**
 * Evaluate which capabilities are available given the datasets present.
 *
 * @param {{ type: string, fields: string[] }[]} availableDatasets
 *   Each entry describes one detected/uploaded data type and the canonical
 *   fields that were successfully mapped for it.
 *
 * @returns {Record<string, {
 *   available: boolean,
 *   level: 'full' | 'partial' | 'unavailable',
 *   label: string,
 *   description: string,
 *   missingDatasets: string[],
 *   missingFields: Record<string, string[]>,
 *   degradationNote: string | null,
 *   optionalPresent: string[],
 *   optionalMissing: string[]
 * }>}
 */
export function evaluateCapabilities(availableDatasets = []) {
  // Build a lookup: datasetType → Set<canonicalField>
  const datasetMap = {};
  for (const ds of availableDatasets) {
    if (!datasetMap[ds.type]) {
      datasetMap[ds.type] = new Set();
    }
    for (const f of (ds.fields || [])) {
      datasetMap[ds.type].add(f);
    }
  }

  const result = {};

  for (const [capKey, cap] of Object.entries(CAPABILITY_MATRIX)) {
    const missingDatasets = [];
    const missingFields = {};
    let hasAllRequired = true;

    // Check required datasets and their minimum fields
    for (const dsType of cap.requiredDatasets) {
      if (!datasetMap[dsType]) {
        missingDatasets.push(dsType);
        hasAllRequired = false;
        continue;
      }

      // Check minimum fields
      const requiredFields = (cap.minFields || {})[dsType] || [];
      const missing = requiredFields.filter(f => !datasetMap[dsType].has(f));

      // Check time field requirement
      const timeGroup = (cap.timeFieldRequired || {})[dsType];
      if (timeGroup && timeGroup.length > 0) {
        const hasTimeField = timeGroup.some(tf => datasetMap[dsType].has(tf));
        if (!hasTimeField) {
          missing.push(`one of: ${timeGroup.join(', ')}`);
        }
      }

      if (missing.length > 0) {
        missingFields[dsType] = missing;
        hasAllRequired = false;
      }
    }

    // Check optional datasets
    const optionalPresent = (cap.optionalDatasets || []).filter(ds => datasetMap[ds]);
    const optionalMissing = (cap.optionalDatasets || []).filter(ds => !datasetMap[ds]);

    // Determine level
    let level;
    if (hasAllRequired && optionalMissing.length === 0) {
      level = 'full';
    } else if (hasAllRequired) {
      level = 'partial'; // All required present but some optional missing
    } else {
      level = 'unavailable';
    }

    result[capKey] = {
      available: level !== 'unavailable',
      level,
      label: cap.label,
      description: cap.description,
      missingDatasets,
      missingFields,
      degradationNote: level === 'unavailable' ? (cap.degradationNote || null) : null,
      optionalPresent,
      optionalMissing,
    };
  }

  return result;
}

/**
 * Get a human-friendly summary of what's available and what's missing.
 *
 * @param {ReturnType<typeof evaluateCapabilities>} capabilities
 * @returns {{ available: string[], partial: string[], unavailable: string[] }}
 */
export function summarizeCapabilities(capabilities) {
  const available = [];
  const partial = [];
  const unavailable = [];

  for (const [, cap] of Object.entries(capabilities)) {
    if (cap.level === 'full') available.push(cap.label);
    else if (cap.level === 'partial') partial.push(cap.label);
    else unavailable.push(cap.label);
  }

  return { available, partial, unavailable };
}

export default CAPABILITY_MATRIX;
