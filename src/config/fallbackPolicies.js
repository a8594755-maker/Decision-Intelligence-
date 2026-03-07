/**
 * Centralized Fallback Policy Engine
 *
 * Consolidates all scattered fallback logic into a single declarative config.
 * Every fallback applied is audited — the system tracks what was used and why.
 */

// ── Fallback policy definitions ─────────────────────────────────────────────

export const FALLBACK_POLICIES = {
  lead_time_days: {
    strategies: [
      { source: 'mapped_field', description: 'From uploaded data' },
      { source: 'supplier_default', description: 'Supplier-level default' },
      { source: 'plant_default', description: 'Plant-level default' },
      { source: 'global_default', value: 7, description: 'System default (7 days)' },
    ],
    flag: 'estimated_lead_time',
    envOverride: 'VITE_DI_DEFAULT_LEAD_TIME_DAYS',
  },

  safety_stock: {
    strategies: [
      { source: 'mapped_field', description: 'From uploaded data' },
      { source: 'global_default', value: 0, description: 'System default (0)' },
    ],
    flag: 'estimated_safety_stock',
    envOverride: 'VITE_DI_DEFAULT_SAFETY_STOCK',
  },

  open_pos: {
    whenMissing: 'empty_array',
    degradesCapability: 'inbound_aware_plan',
    message: 'Open PO data missing — inbound arrivals will not be considered in planning. Basic shortage risk is still calculated.',
  },

  financials: {
    whenMissing: 'skip_feature',
    degradesCapability: 'profit_at_risk',
    message: 'Financial data missing — profit-at-risk analysis unavailable. Shortage risk and replenishment planning still proceed.',
  },

  bom_edge: {
    whenMissing: 'skip_feature',
    degradesCapability: 'multi_echelon',
    message: 'BOM data missing — multi-echelon planning unavailable. Single-level planning proceeds normally.',
  },
};

// ── Fallback audit collector ────────────────────────────────────────────────

/**
 * Create a fallback audit tracker to collect all fallbacks applied during a run.
 *
 * @returns {{ apply: Function, addDatasetFallback: Function, getAudit: Function }}
 */
export function createFallbackAudit() {
  const fieldFallbacks = [];   // Per-row field-level fallbacks
  const datasetFallbacks = []; // Dataset-level (missing open_pos, financials, etc.)

  return {
    /**
     * Apply fallback for a field on a single row.
     *
     * @param {string}  fieldKey   – e.g. 'lead_time_days'
     * @param {any}     rowValue   – The current value (may be null/undefined)
     * @param {object}  [context]  – Optional context (supplier, plant, etc.)
     * @returns {{ value: any, source: string, isFallback: boolean }}
     */
    apply(fieldKey, rowValue, context = {}) {
      const policy = FALLBACK_POLICIES[fieldKey];
      if (!policy || !policy.strategies) {
        return { value: rowValue, source: 'original', isFallback: false };
      }

      // If the value is present and valid, no fallback needed
      if (rowValue !== null && rowValue !== undefined && rowValue !== '') {
        return { value: rowValue, source: 'mapped_field', isFallback: false };
      }

      // Walk through fallback strategies in order
      for (const strategy of policy.strategies) {
        if (strategy.source === 'mapped_field') continue; // Already checked

        if (strategy.source === 'supplier_default' && context.supplierDefaults?.[fieldKey] != null) {
          const val = context.supplierDefaults[fieldKey];
          fieldFallbacks.push({ field: fieldKey, source: strategy.source, value: val, description: strategy.description });
          return { value: val, source: strategy.source, isFallback: true };
        }

        if (strategy.source === 'plant_default' && context.plantDefaults?.[fieldKey] != null) {
          const val = context.plantDefaults[fieldKey];
          fieldFallbacks.push({ field: fieldKey, source: strategy.source, value: val, description: strategy.description });
          return { value: val, source: strategy.source, isFallback: true };
        }

        if (strategy.source === 'global_default') {
          // Check env override first
          let val = strategy.value;
          if (policy.envOverride) {
            try {
              const envVal = import.meta.env?.[policy.envOverride];
              if (envVal != null && envVal !== '') {
                const parsed = Number(envVal);
                if (Number.isFinite(parsed)) val = parsed;
              }
            } catch {
              // Ignore env access errors
            }
          }
          fieldFallbacks.push({ field: fieldKey, source: strategy.source, value: val, description: strategy.description });
          return { value: val, source: strategy.source, isFallback: true };
        }
      }

      // No fallback found — return original null
      return { value: rowValue, source: 'none', isFallback: false };
    },

    /**
     * Record that an entire dataset is missing and a feature degrades.
     *
     * @param {string} datasetKey – e.g. 'open_pos', 'financials', 'bom_edge'
     */
    addDatasetFallback(datasetKey) {
      const policy = FALLBACK_POLICIES[datasetKey];
      if (!policy) return;

      datasetFallbacks.push({
        dataset: datasetKey,
        action: policy.whenMissing || 'skip_feature',
        degradesCapability: policy.degradesCapability || null,
        message: policy.message || `${datasetKey} data not available.`,
      });
    },

    /**
     * Get the full audit trail for this run.
     *
     * @returns {{
     *   fieldFallbacks: Array<{ field: string, source: string, value: any, description: string }>,
     *   datasetFallbacks: Array<{ dataset: string, action: string, degradesCapability: string|null, message: string }>,
     *   summary: { totalFieldFallbacks: number, totalDatasetFallbacks: number, fallbackFields: string[], degradedCapabilities: string[] }
     * }}
     */
    getAudit() {
      // Aggregate field fallbacks
      const fieldAgg = {};
      for (const fb of fieldFallbacks) {
        if (!fieldAgg[fb.field]) {
          fieldAgg[fb.field] = { field: fb.field, source: fb.source, value: fb.value, description: fb.description, count: 0 };
        }
        fieldAgg[fb.field].count++;
      }

      return {
        fieldFallbacks: Object.values(fieldAgg),
        datasetFallbacks,
        summary: {
          totalFieldFallbacks: fieldFallbacks.length,
          totalDatasetFallbacks: datasetFallbacks.length,
          fallbackFields: [...new Set(fieldFallbacks.map(f => f.field))],
          degradedCapabilities: datasetFallbacks
            .map(d => d.degradesCapability)
            .filter(Boolean),
        },
      };
    },
  };
}

/**
 * Get the human-friendly degradation message for a missing dataset.
 *
 * @param {string} datasetKey
 * @returns {string|null}
 */
export function getDegradationMessage(datasetKey) {
  const policy = FALLBACK_POLICIES[datasetKey];
  return policy?.message || null;
}

/**
 * Check if a dataset is a hard requirement (blocks execution) or soft (degrades gracefully).
 *
 * @param {string} datasetKey
 * @returns {'hard' | 'soft' | 'unknown'}
 */
export function getDatasetCriticality(datasetKey) {
  const policy = FALLBACK_POLICIES[datasetKey];
  if (!policy) return 'unknown';
  return policy.whenMissing ? 'soft' : 'hard';
}
