/**
 * Import Metrics Collector
 *
 * Instruments the import pipeline to collect per-sheet and aggregate metrics.
 */

import { logger } from './structuredLogger';

export function createImportMetricsCollector(importId) {
  const sheets = new Map();
  const startedAt = Date.now();

  function getSheet(sheetName) {
    if (!sheets.has(sheetName)) {
      sheets.set(sheetName, {
        sheetName,
        classification: null,
        validation: null,
        ingest: null,
        mapping: null,
        timing: {},
      });
    }
    return sheets.get(sheetName);
  }

  return {
    recordClassification(sheetName, { uploadType, confidence, enabled }) {
      const sheet = getSheet(sheetName);
      sheet.classification = { uploadType, confidence, enabled };
      logger.info('import-metrics', `Sheet "${sheetName}" classified as ${uploadType} (${Math.round(confidence * 100)}%)`, {
        importId, sheetName, uploadType, confidence,
      });
    },

    recordMapping(sheetName, { totalFields, autoMapped, manualCorrections, confidence }) {
      const sheet = getSheet(sheetName);
      sheet.mapping = {
        totalFields,
        autoMapped,
        manualCorrections,
        autoMappedPct: totalFields > 0 ? Math.round((autoMapped / totalFields) * 100) : 0,
        avgConfidence: confidence,
      };
    },

    recordValidation(sheetName, { total, valid, invalid, quarantined = 0, durationMs }) {
      const sheet = getSheet(sheetName);
      sheet.validation = { total, valid, invalid, quarantined };
      sheet.timing.validateMs = durationMs;
      logger.info('import-metrics', `Sheet "${sheetName}" validation: ${valid}/${total} valid`, {
        importId, sheetName, total, valid, invalid,
      });
    },

    recordIngest(sheetName, { savedCount, chunks, durationMs }) {
      const sheet = getSheet(sheetName);
      sheet.ingest = { savedCount, chunks };
      sheet.timing.ingestMs = durationMs;
    },

    getSummary() {
      const allSheets = [...sheets.values()];
      return {
        importId,
        totalDurationMs: Date.now() - startedAt,
        sheetsProcessed: allSheets.length,
        totalRowsProcessed: allSheets.reduce((sum, s) => sum + (s.validation?.total || 0), 0),
        totalRowsValid: allSheets.reduce((sum, s) => sum + (s.validation?.valid || 0), 0),
        totalRowsInvalid: allSheets.reduce((sum, s) => sum + (s.validation?.invalid || 0), 0),
        totalRowsIngested: allSheets.reduce((sum, s) => sum + (s.ingest?.savedCount || 0), 0),
        avgAutoMappedPct: allSheets.length > 0
          ? Math.round(allSheets.reduce((sum, s) => sum + (s.mapping?.autoMappedPct || 0), 0) / allSheets.length)
          : 0,
        sheets: allSheets.map(s => ({
          sheetName: s.sheetName,
          uploadType: s.classification?.uploadType,
          ...s.validation,
          ...s.mapping,
          ...s.ingest,
          timing: s.timing,
        })),
      };
    },
  };
}
