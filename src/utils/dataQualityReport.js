/**
 * Unified Data Quality Report Builder
 * Centralizes quality metadata from import, planning, and risk pipelines.
 */

/**
 * Build a unified DataQualityReport.
 * @param {Object} params
 * @param {string[]} params.availableDatasets
 * @param {string[]} params.missingDatasets
 * @param {Object} [params.fallbackAudit] - { fieldFallbacks, datasetFallbacks, summary }
 * @param {Object} [params.capabilities] - from evaluateCapabilities()
 * @param {Object} [params.rowStats] - { total, clean, with_fallback, dropped }
 * @param {Object} [params.importQuality] - per-dataset { [type]: { total, accepted, rejected } }
 * @param {number} [params.quarantinedCount] - total quarantined rows
 * @returns {Object} DataQualityReport
 */
export function buildDataQualityReport({
  availableDatasets = [],
  missingDatasets = [],
  fallbackAudit = { fieldFallbacks: [], datasetFallbacks: [], summary: {} },
  capabilities = null,
  rowStats = null,
  importQuality = null,
  quarantinedCount = 0
}) {
  const coverageLevel = missingDatasets.length === 0
    ? 'full'
    : missingDatasets.length <= 2
      ? 'partial'
      : 'minimal';

  const report = {
    coverage_level: coverageLevel,
    available_datasets: availableDatasets,
    missing_datasets: missingDatasets,
    fallbacks_used: fallbackAudit.fieldFallbacks || [],
    dataset_fallbacks: fallbackAudit.datasetFallbacks || [],
    generated_at: new Date().toISOString()
  };

  if (capabilities) {
    report.capabilities = {};
    for (const [key, cap] of Object.entries(capabilities)) {
      report.capabilities[key] = { available: cap.available, level: cap.level || 'unavailable' };
    }
  }

  if (rowStats) {
    report.row_stats = { ...rowStats, quarantined: quarantinedCount };
  }

  if (importQuality) {
    report.import_quality = importQuality;
  }

  return report;
}
