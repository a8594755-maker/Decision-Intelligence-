/**
 * One-shot Import Service - Generic multi-sheet import framework
 * Supports chunk ingest (>1000 rows), idempotency, abort, detailed reporting
 */

import * as XLSX from 'xlsx';
import { classifySheet, getClassificationReasons } from '../utils/sheetClassifier';
import { getUploadStrategy, getIdempotencyKey } from './uploadStrategies';
import { importBatchesService } from './importHistoryService';
import { userFilesService } from './supabaseClient';
import { buildQuarantineReport } from '../utils/dataValidation';
import { validateInWorker } from '../utils/dataValidationWorkerClient';
import { ruleBasedMapping } from '../utils/aiMappingHelper';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import { ingestInChunks, DEFAULT_CHUNK_SIZE } from './chunkIngestService';
import { sendAgentLog } from '../utils/sendAgentLog';
import {
  checkIngestKeySupport,
  upsertSheetRun,
  updateSheetRun,
  findSucceededRun,
  deletePreviousDataByIngestKey
} from './sheetRunsService';
import { autoFillRows, validateRequiredFields } from '../utils/dataAutoFill';
import { getRequiredMappingStatus } from '../utils/requiredMappingStatus';
import { logger, createSpan, createImportMetricsCollector } from './observability';

/**
 * Wrap a promise with a timeout. Returns fallbackValue on timeout if provided.
 */
function withTimeout(promise, ms, fallbackValue) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (fallbackValue !== undefined) {
        resolve(fallbackValue);
      } else {
        reject(new Error(`Operation timed out after ${ms}ms`));
      }
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Generate sheet plans from workbook (classification phase)
 * 
 * @param {object} workbook - XLSX workbook object
 * @param {object} options - { maxRowsPerSheet: 10000 }
 * @returns {object[]} Array of sheet plans
 */
export function generateSheetPlans(workbook, fileName = 'unknown', fileSize = 0, fileLastModified = 0, _options = {}) {
  const plans = [];
  const sheetNames = workbook.SheetNames;
  
  for (let sheetIndex = 0; sheetIndex < sheetNames.length; sheetIndex++) {
    const sheetName = sheetNames[sheetIndex];
    
    // Create stable unique sheetId
    const sheetId = `${fileName}:${fileSize}:${fileLastModified}:${sheetIndex}`;
    
    try {
      // Parse sheet data
      const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      
      // Check if empty
      if (sheetData.length === 0) {
      plans.push({
        sheetId,
        sheetName,
        uploadType: null,
        suggestedType: null,
        confidence: 0,
        enabled: false,
        disabledReason: 'Sheet is empty (0 rows)',
        rowCount: 0,
        // ✅ Two-step Gate: Initialize mapping state
        headers: [],
        mappingDraft: {},
        mappingFinal: null,
        mappingConfirmed: false,
        requiredCoverage: 0,
        missingRequired: [],
        isComplete: false
      });
        continue;
      }
      
      // Get headers and sample rows
      const headers = Object.keys(sheetData[0]);
      const sampleRows = sheetData.slice(0, 50); // Increased to 50 rows for better type checking
      
      // Classify sheet
      const classification = classifySheet({ sheetName, headers, sampleRows });
      const reasons = classification.reasons || getClassificationReasons(classification);

      // Observability: log classification
      logger.info('import-pipeline', `Sheet "${sheetName}" classified as ${classification.suggestedType || 'unknown'}`, {
        sheetName, uploadType: classification.suggestedType, confidence: classification.confidence,
      });

      // ✅ A) Calculate actual mapping state (using rule-based mapping)
      const uploadType = classification.suggestedType;
      let mappingStatus = {
        coverage: 0,
        missingRequired: [],
        isComplete: false
      };
      let initialMapping = {};
      
      // Per-field confidence metadata for mapping review
      let mappingMeta = {};

      if (uploadType && UPLOAD_SCHEMAS[uploadType]) {
        const schema = UPLOAD_SCHEMAS[uploadType];

        // Use rule-based mapping to calculate initial coverage
        const ruleMappings = ruleBasedMapping(headers, uploadType, schema.fields);
        initialMapping = {};
        ruleMappings.forEach(m => {
          if (m.target && m.confidence >= 0.7) {
            initialMapping[m.source] = m.target;
            // Capture per-field confidence metadata
            mappingMeta[m.source] = {
              confidence: m.confidence,
              matchType: m.confidence >= 1.0 ? 'exact' : (m.confidence >= 0.8 ? 'synonym' : 'inference'),
            };
          }
        });

        // Calculate mapping status with confidence metadata
        mappingStatus = getRequiredMappingStatus({
          uploadType,
          columns: headers,
          columnMapping: initialMapping,
          mappingMeta,
        });

        logger.info('import-classify', `${sheetName} (${uploadType}): coverage=${Math.round(mappingStatus.coverage * 100)}%, typeConfidence=${Math.round(classification.confidence * 100)}%`, { sheetName, uploadType, coverage: mappingStatus.coverage, missingRequired: mappingStatus.missingRequired });
      }
      
      // ✅ B) Fix auto-enable rule: only check mapping completeness, not type confidence
      let enabled = mappingStatus.isComplete === true;
      let warningMessage = null;
      
      // Large file warning (but don't disable)
      if (sheetData.length > 10000) {
        warningMessage = `⚠ Large sheet (${sheetData.length.toLocaleString()} rows), will use chunk ingest`;
        // Don't force disable, allow user to check
      }
      
      const planPayload = {
        sheetId,
        sheetName,
        uploadType: classification.suggestedType, // Initial value
        suggestedType: classification.suggestedType,
        confidence: classification.confidence,
        enabled,
        evidence: classification.evidence,
        reasons,
        rowCount: sheetData.length,
        candidates: classification.candidates,
        needsChunking: sheetData.length > 500,
        warningMessage,
        // ✅ Two-step Gate: Write actual mapping state (mappingDraft uses rule-based result, consistent with coverage/isComplete)
        headers: Object.keys(sheetData[0] || {}),
        sampleRows: sampleRows.slice(0, 5), // First 5 rows for mapping review preview
        mappingDraft: { ...initialMapping },
        mappingMeta,
        mappingFinal: null,
        mappingConfirmed: false,
        requiredCoverage: mappingStatus.coverage,
        missingRequired: mappingStatus.missingRequired,
        isComplete: mappingStatus.isComplete,
        reviewRequired: mappingStatus.reviewRequired || false,
      };
      sendAgentLog({location:'oneShotImportService.js:generateSheetPlans',message:'[generateSheetPlans] Plan pushed',data:{sheetName,uploadType:classification.suggestedType,isComplete:mappingStatus.isComplete,requiredCoverage:mappingStatus.coverage,missingRequired:mappingStatus.missingRequired,mappingDraftKeys:Object.keys(initialMapping)},sessionId:'debug-session',hypothesisId:'H1'});
      plans.push(planPayload);
      
    } catch (error) {
      logger.error('import-classify', `Failed to analyze sheet "${sheetName}": ${error.message}`, { sheetName, error: error.message });
      plans.push({
        sheetId,
        sheetName,
        uploadType: null,
        suggestedType: null,
        confidence: 0,
        enabled: false,
        disabledReason: `Analysis failed: ${error.message}`,
        rowCount: 0,
        // ✅ Two-step Gate: Initialize mapping state
        headers: [],
        mappingDraft: {},
        mappingFinal: null,
        mappingConfirmed: false,
        requiredCoverage: 0,
        missingRequired: [],
        isComplete: false
      });
    }
  }
  
  logger.info('import-classify', `Generated ${plans.length} sheet plans`, { plans: plans.map(p => ({ name: p.sheetName, type: p.uploadType, enabled: p.enabled })) });
  
  return plans;
}

/**
 * Generate sheet plans from pre-parsed workbook metadata (Worker path).
 * Same logic as generateSheetPlans but skips XLSX parsing since data is already extracted.
 *
 * @param {{ sheetNames: string[], sheets: Array<{ name, headers, sampleRows, rowCount }> }} parsed
 * @param {string} fileName
 * @param {number} fileSize
 * @param {number} fileLastModified
 * @returns {object[]} Array of sheet plans
 */
export function generateSheetPlansFromParsed(parsed, fileName = 'unknown', fileSize = 0, fileLastModified = 0) {
  const plans = [];

  for (let sheetIndex = 0; sheetIndex < parsed.sheets.length; sheetIndex++) {
    const sheet = parsed.sheets[sheetIndex];
    const sheetName = sheet.name;
    const sheetId = `${fileName}:${fileSize}:${fileLastModified}:${sheetIndex}`;

    try {
      if (sheet.rowCount === 0) {
        plans.push({
          sheetId, sheetName, uploadType: null, suggestedType: null, confidence: 0,
          enabled: false, disabledReason: 'Sheet is empty (0 rows)', rowCount: 0,
          headers: [], mappingDraft: {}, mappingFinal: null, mappingConfirmed: false,
          requiredCoverage: 0, missingRequired: [], isComplete: false
        });
        continue;
      }

      const { headers, sampleRows, rowCount } = sheet;

      const classification = classifySheet({ sheetName, headers, sampleRows });
      const reasons = classification.reasons || getClassificationReasons(classification);

      logger.info('import-pipeline', `Sheet "${sheetName}" classified as ${classification.suggestedType || 'unknown'}`, {
        sheetName, uploadType: classification.suggestedType, confidence: classification.confidence,
      });

      const uploadType = classification.suggestedType;
      let mappingStatus = { coverage: 0, missingRequired: [], isComplete: false };
      let initialMapping = {};
      let mappingMeta = {};

      if (uploadType && UPLOAD_SCHEMAS[uploadType]) {
        const schema = UPLOAD_SCHEMAS[uploadType];
        const ruleMappings = ruleBasedMapping(headers, uploadType, schema.fields);
        ruleMappings.forEach(m => {
          if (m.target && m.confidence >= 0.7) {
            initialMapping[m.source] = m.target;
            mappingMeta[m.source] = {
              confidence: m.confidence,
              matchType: m.confidence >= 1.0 ? 'exact' : (m.confidence >= 0.8 ? 'synonym' : 'inference'),
            };
          }
        });

        mappingStatus = getRequiredMappingStatus({
          uploadType, columns: headers, columnMapping: initialMapping, mappingMeta,
        });
      }

      let enabled = mappingStatus.isComplete === true;
      let warningMessage = null;
      if (rowCount > 10000) {
        warningMessage = `Large sheet (${rowCount.toLocaleString()} rows), will use chunk ingest`;
      }

      plans.push({
        sheetId, sheetName,
        uploadType: classification.suggestedType, suggestedType: classification.suggestedType,
        confidence: classification.confidence, enabled,
        evidence: classification.evidence, reasons,
        rowCount, candidates: classification.candidates,
        needsChunking: rowCount > 500, warningMessage,
        headers, sampleRows: sampleRows.slice(0, 5),
        mappingDraft: { ...initialMapping }, mappingMeta,
        mappingFinal: null, mappingConfirmed: false,
        requiredCoverage: mappingStatus.coverage,
        missingRequired: mappingStatus.missingRequired,
        isComplete: mappingStatus.isComplete,
        reviewRequired: mappingStatus.reviewRequired || false,
      });
    } catch (error) {
      logger.error('import-classify', `Failed to analyze sheet "${sheetName}": ${error.message}`, { sheetName, error: error.message });
      plans.push({
        sheetId, sheetName, uploadType: null, suggestedType: null, confidence: 0,
        enabled: false, disabledReason: `Analysis failed: ${error.message}`, rowCount: 0,
        headers: [], mappingDraft: {}, mappingFinal: null, mappingConfirmed: false,
        requiredCoverage: 0, missingRequired: [], isComplete: false
      });
    }
  }

  logger.info('import-classify', `Generated ${plans.length} sheet plans (from parsed)`, { plans: plans.map(p => ({ name: p.sheetName, type: p.uploadType, enabled: p.enabled })) });

  return plans;
}

/**
 * Import multiple sheets from a workbook
 * Supports chunk ingest, idempotency, abort, detailed reporting
 *
 * @param {object} params
 * @param {string} params.userId - User ID
 * @param {object} params.workbook - XLSX workbook object
 * @param {string} params.fileName - Original file name
 * @param {object[]} params.sheetPlans - Sheet plans (must have suggestedType for enabled sheets)
 * @param {object} params.options - Import options
 * @param {boolean} params.options.strictMode - Strict validation mode
 * @param {number} params.options.chunkSize - Chunk size (default 500)
 * @param {function} params.options.onProgress - Progress callback
 * @param {AbortSignal} params.options.signal - Abort signal
 * @param {boolean} params.options.forceRerun - Force rerun even if already succeeded
 * @returns {Promise<object>} Import report
 */
export async function importWorkbookSheets({ userId, workbook, fileName, sheetPlans, options = {} }) {
  const {
    strictMode = false,
    chunkSize = DEFAULT_CHUNK_SIZE,
    mode = 'best-effort', // 'best-effort' | 'all-or-nothing'
    onProgress = () => {},
    signal = null,
    forceRerun = false
  } = options;

  const importId = `import-${Date.now()}`;
  const metrics = createImportMetricsCollector(importId);
  const pipelineSpan = createSpan('import', 'workbook', null);
  logger.info('import-pipeline', `Starting import: ${fileName}`, { _traceId: pipelineSpan.traceId, fileName, sheetsCount: sheetPlans.length });

  // Check if ingest_key support is deployed
  const hasIngestKeySupport = await checkIngestKeySupport();
  
  if (!hasIngestKeySupport) {
    logger.warn('import-pipeline', 'Ingest key support not deployed, using fallback mode');
    // All-or-nothing mode requires ingest_key support
    if (mode === 'all-or-nothing') {
      logger.warn('import-pipeline', 'All-or-nothing mode requires ingest_key support, falling back to best-effort');
    }
  }
  
  const enabledPlans = sheetPlans.filter(p => p.enabled && p.suggestedType);
  const totalSheets = enabledPlans.length;
  
  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalSheets,
    enabledSheets: totalSheets,
    succeededSheets: 0,
    failedSheets: 0,
    skippedSheets: 0,
    needsReviewSheets: 0,
    hasIngestKeySupport,
    mode,
    rolledBack: false, // Flag whether rollback was triggered
    sheetReports: [],
    quarantineSummary: { totalRejected: 0, totalWarnings: 0, bySheet: {} }
  };
  
  // Track succeeded sheets for rollback (All-or-nothing mode)
  const succeededSheetsForRollback = [];
  
  // Import sheets sequentially
  for (let i = 0; i < enabledPlans.length; i++) {
    const plan = enabledPlans[i];
    const { sheetName, suggestedType: uploadType } = plan;
    
    logger.info('import-pipeline', `Processing sheet ${i + 1}/${enabledPlans.length}: ${sheetName} (${uploadType})`, { _traceId: pipelineSpan.traceId, sheetName, uploadType });
    
    // Check abort
    if (signal?.aborted) {
      logger.warn('import-pipeline', 'Aborted by user', { _traceId: pipelineSpan.traceId });
      report.sheetReports.push({
        sheetName,
        uploadType,
        status: 'ABORTED',
        reason: 'Import aborted by user'
      });
      
      // All-or-nothing: rollback on abort
      if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
        logger.warn('import-pipeline', 'All-or-nothing: rolling back due to abort', { _traceId: pipelineSpan.traceId });
        await rollbackSucceededSheets(succeededSheetsForRollback, userId);
        report.rolledBack = true;
      }
      
      break;
    }
    
    // ✅ Two-step Gate: Hard gate check for mappingFinal
    if (!plan.mappingFinal || Object.keys(plan.mappingFinal).length === 0) {
      logger.info('import-pipeline', `Sheet "${sheetName}" NEEDS_REVIEW: no mappingFinal`, { _traceId: pipelineSpan.traceId, sheetName });
      report.needsReviewSheets++;
      report.sheetReports.push({
        sheetName,
        uploadType,
        status: 'NEEDS_REVIEW',
        reason: 'No confirmed mapping (mappingFinal missing from Step 2)'
      });
      onProgress({ stage: 'sheet-complete', current: i + 1, total: totalSheets, sheetName, status: 'NEEDS_REVIEW' });
      continue;
    }
    
    // Hard gate check: validate mapping completeness before ingest
    try {
      const sheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      
      if (sheetData.length > 0) {
        const headers = Object.keys(sheetData[0]);
        const schema = UPLOAD_SCHEMAS[uploadType];
        
        if (schema) {
          // ✅ Use plan.mappingFinal (from Step 2 manual confirmation)
          const columnMapping = plan.mappingFinal;
          
          const mappingStatus = getRequiredMappingStatus({
            uploadType,
            columns: headers,
            columnMapping
          });
          
          logger.info('import-pipeline', `Pre-import check for ${sheetName}: coverage=${Math.round(mappingStatus.coverage * 100)}%`, { _traceId: pipelineSpan.traceId, sheetName, coverage: mappingStatus.coverage, missingRequired: mappingStatus.missingRequired });

          if (!mappingStatus.isComplete) {
            // Hard block: import not allowed
            logger.warn('import-pipeline', `BLOCKED: ${sheetName} mapping incomplete`, { _traceId: pipelineSpan.traceId, sheetName, missingRequired: mappingStatus.missingRequired });
            
            report.needsReviewSheets++;
            report.sheetReports.push({
              sheetName,
              uploadType,
              status: 'NEEDS_REVIEW',
              reason: `Required mapping incomplete (${Math.round(mappingStatus.coverage * 100)}%). Missing: ${mappingStatus.missingRequired.join(', ')}`,
              missingFields: mappingStatus.missingRequired,
              coverage: mappingStatus.coverage,
              rowCount: sheetData.length
            });
            
            onProgress({
              stage: 'sheet-complete',
              current: i + 1,
              total: totalSheets,
              sheetName,
              status: 'NEEDS_REVIEW'
            });
            
            continue; // Skip, do not execute ingest at all
          }
        }
      }
    } catch (preCheckError) {
      logger.error('import-pipeline', `Pre-check error for ${sheetName}: ${preCheckError.message}`, { _traceId: pipelineSpan.traceId, sheetName, error: preCheckError.message });
      report.needsReviewSheets++;
      report.sheetReports.push({
        sheetName,
        uploadType,
        status: 'NEEDS_REVIEW',
        reason: `Pre-check failed: ${preCheckError.message}`
      });
      onProgress({ stage: 'sheet-complete', current: i + 1, total: totalSheets, sheetName, status: 'NEEDS_REVIEW' });
      continue;
    }
    
    // Progress callback
    onProgress({
      stage: 'processing',
      current: i + 1,
      total: totalSheets,
      sheetName,
      uploadType
    });
    
    try {
      const sheetResult = await importSingleSheet({
        userId,
        workbook,
        sheetName,
        uploadType,
        fileName: `${fileName} - ${sheetName}`,
        strictMode,
        chunkSize,
        onProgress,
        signal,
        hasIngestKeySupport,
        forceRerun,
        columnMapping: plan.mappingFinal  // ✅ Two-step Gate: Only use mappingFinal (from Step 2 manual confirmation)
      });
      
      if (sheetResult.status === 'IMPORTED') {
        report.succeededSheets++;
        
        // Track for rollback (All-or-nothing mode)
        if (mode === 'all-or-nothing' && hasIngestKeySupport && sheetResult.idempotencyKey) {
          succeededSheetsForRollback.push({
            sheetName,
            uploadType,
            idempotencyKey: sheetResult.idempotencyKey,
            savedCount: sheetResult.savedCount
          });
        }
        
      } else if (sheetResult.status === 'SKIPPED') {
        report.skippedSheets++;
      } else if (sheetResult.status === 'NEEDS_REVIEW') {
        report.needsReviewSheets++;
      } else {
        report.failedSheets++;
        
        // All-or-nothing: rollback on any failure
        if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
          logger.warn('import-pipeline', 'All-or-nothing: rolling back due to failure', { _traceId: pipelineSpan.traceId });
          await rollbackSucceededSheets(succeededSheetsForRollback, userId);
          report.rolledBack = true;
        }
      }
      
      report.sheetReports.push(sheetResult);

      // Aggregate quarantine data
      if (sheetResult.quarantineReport) {
        report.quarantineSummary.totalRejected += sheetResult.quarantineReport.rejected;
        report.quarantineSummary.totalWarnings += sheetResult.quarantineReport.warnings;
        report.quarantineSummary.bySheet[sheetResult.sheetName] = {
          rejected: sheetResult.quarantineReport.rejected,
          warnings: sheetResult.quarantineReport.warnings,
        };
      }

      // Observability: record per-sheet metrics
      if (sheetResult.status === 'IMPORTED') {
        metrics.recordClassification(sheetName, {
          uploadType, confidence: plan.confidence ?? 1, enabled: true,
        });
        metrics.recordValidation(sheetName, {
          total: sheetResult.totalRows || 0,
          valid: sheetResult.savedCount || 0,
          invalid: sheetResult.errorCount || 0,
          quarantined: sheetResult.quarantineReport?.rejected || 0,
        });
        metrics.recordIngest(sheetName, {
          savedCount: sheetResult.savedCount || 0,
          chunks: sheetResult.chunks?.length || 0,
        });
      }

    } catch (error) {
      logger.error('import-pipeline', `Failed to import sheet "${sheetName}": ${error.message}`, { _traceId: pipelineSpan.traceId, sheetName, error: error.message });
      
      report.sheetReports.push({
        sheetName,
        uploadType,
        status: 'FAILED',
        reason: error.message || 'Unknown error',
        error: error.stack
      });
      report.failedSheets++;
      
      // All-or-nothing: rollback on exception
      if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
        logger.warn('import-pipeline', 'All-or-nothing: rolling back due to exception', { _traceId: pipelineSpan.traceId });
        await rollbackSucceededSheets(succeededSheetsForRollback, userId);
        report.rolledBack = true;
      }
    }
  }
  
  report.finishedAt = new Date().toISOString();

  // Observability: finalize pipeline span + log summary
  pipelineSpan.addMetric('sheetsProcessed', report.succeededSheets);
  pipelineSpan.addMetric('totalRowsIngested', metrics.getSummary().totalRowsIngested);
  pipelineSpan.addMetric('quarantined', report.quarantineSummary.totalRejected);
  pipelineSpan.end();

  logger.info('import-pipeline', `Import complete: ${report.succeededSheets}/${report.totalSheets} sheets`, {
    _traceId: pipelineSpan.traceId,
    durationMs: pipelineSpan.durationMs,
    succeeded: report.succeededSheets,
    failed: report.failedSheets,
    skipped: report.skippedSheets,
    quarantined: report.quarantineSummary.totalRejected,
  });

  report.observability = { traceId: pipelineSpan.traceId, metrics: metrics.getSummary(), span: pipelineSpan.toJSON() };

  return report;
}

/**
 * Rollback succeeded sheets (All-or-nothing mode)
 * Uses ingest_key to delete successfully imported data
 * 
 * @param {Array} succeededSheets - Array of { sheetName, uploadType, idempotencyKey, savedCount }
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function rollbackSucceededSheets(succeededSheets, userId) {
  logger.warn('import-rollback', `Rolling back ${succeededSheets.length} succeeded sheets`);
  
  for (const sheet of succeededSheets) {
    try {
      logger.info('import-rollback', `Rolling back "${sheet.sheetName}" (${sheet.uploadType})`, { sheetName: sheet.sheetName, uploadType: sheet.uploadType });
      
      const deletedCount = await deletePreviousDataByIngestKey(
        userId,
        sheet.idempotencyKey,
        sheet.uploadType
      );
      
      logger.info('import-rollback', `Rolled back "${sheet.sheetName}": ${deletedCount} rows deleted`, { sheetName: sheet.sheetName, deletedCount });
      
    } catch (error) {
      logger.error('import-rollback', `Failed to rollback "${sheet.sheetName}": ${error.message}`, { sheetName: sheet.sheetName, error: error.message });
      // Continue rolling back other sheets, don't interrupt
    }
  }
  
  logger.info('import-rollback', 'Rollback completed');
}

/**
 * Import a single sheet with chunk support
 * 
 * @param {object} params
 * @returns {Promise<object>} Import result
 */
async function importSingleSheet({
  userId,
  workbook,
  sheetName,
  uploadType,
  fileName,
  strictMode,
  chunkSize,
  onProgress,
  signal,
  hasIngestKeySupport,
  forceRerun,
  columnMapping: providedMapping = null  // ✅ Accept externally provided mapping (from AI Suggest / UI)
}) {
  let sheetRunId = null;
  
  try {
    // 1. Parse sheet data (try Worker extraction first, fallback to direct XLSX parsing)
    let sheetData;
    if (workbook && workbook.Sheets && workbook.Sheets[sheetName]) {
      sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    } else {
      // Worker path: workbook may be null; extract from worker
      try {
        const { extractSheetInWorker } = await import('../utils/xlsxParserWorkerClient');
        sheetData = await extractSheetInWorker(sheetName);
      } catch (workerErr) {
        logger.warn('import-ingest', `Worker extract failed for "${sheetName}": ${workerErr.message}`, { sheetName });
        // If workbook is available, try direct parse
        if (workbook?.Sheets?.[sheetName]) {
          sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
        } else {
          throw new Error(`Cannot extract sheet "${sheetName}": no workbook or worker available`);
        }
      }
    }

    if (sheetData.length === 0) {
      return {
        sheetName,
        uploadType,
        status: 'SKIPPED',
        reason: 'Sheet is empty'
      };
    }
    
    const headers = Object.keys(sheetData[0]);
    const totalRows = sheetData.length;
    
    // 2. Get schema
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) {
      return {
        sheetName,
        uploadType,
        status: 'SKIPPED',
        reason: `Unknown upload type: ${uploadType}`
      };
    }
    
    // ✅ Two-step Gate: Only use providedMapping (mappingFinal), no fallback allowed
    if (!providedMapping || Object.keys(providedMapping).length === 0) {
      logger.info('import-ingest', `No providedMapping for ${sheetName}, marking NEEDS_REVIEW`, { sheetName });
      return {
        sheetName,
        uploadType,
        status: 'NEEDS_REVIEW',
        reason: 'No mapping provided (mappingFinal missing from Step 2)'
      };
    }
    
    // ✅ Use providedMapping (mappingFinal from Step 2)
    const columnMapping = providedMapping;
    logger.info('import-ingest', `Using mappingFinal: ${Object.keys(columnMapping).length} mappings`, { sheetName, mappingCount: Object.keys(columnMapping).length });
    
    // 4. Check required fields coverage
    const mappingStatus = getRequiredMappingStatus({
      uploadType,
      columns: headers,
      columnMapping
    });
    
    logger.info('import-ingest', `Final coverage: ${Math.round(mappingStatus.coverage * 100)}%`, { sheetName, coverage: mappingStatus.coverage, missingRequired: mappingStatus.missingRequired });
    
    // If mapping insufficient, mark as NEEDS_REVIEW (import not allowed)
    if (!mappingStatus.isComplete) {
      return {
        sheetName,
        uploadType,
        status: 'NEEDS_REVIEW',
        reason: `Required field mapping incomplete (${Math.round(mappingStatus.coverage * 100)}%). Missing: ${mappingStatus.missingRequired.join(', ')}`,
        missingFields: mappingStatus.missingRequired,
        coverage: mappingStatus.coverage
      };
    }
    
    // 7. Validate and clean (use Web Worker for large datasets)
    onProgress({ stage: 'substep', sheetName, uploadType, substep: 'Validating data...' });
    const validationResult = await validateInWorker(sheetData, uploadType, columnMapping);

    // 7.5 Build quarantine report from validation result
    const quarantineReport = buildQuarantineReport(validationResult, sheetName, uploadType);

    // 8. Auto-fill common missing fields (for any remaining fillable fields)
    const autoFillResult = autoFillRows(validationResult.validRows, uploadType);
    const rowsToIngest = autoFillResult.rows;
    
    // Log auto-fill summary
    if (autoFillResult.autoFillCount > 0) {
      logger.info('import-ingest', `Auto-filled ${autoFillResult.autoFillCount} rows`, { sheetName, autoFillCount: autoFillResult.autoFillCount, summary: autoFillResult.autoFillSummary });
    }
    
    if (strictMode && validationResult.errorRows && validationResult.errorRows.length > 0) {
      return {
        sheetName,
        uploadType,
        status: 'SKIPPED',
        reason: `Strict mode: ${validationResult.errorRows.length} validation errors`,
        errorCount: validationResult.errorRows.length
      };
    }
    
    if (validationResult.validRows.length === 0) {
      return {
        sheetName,
        uploadType,
        status: 'SKIPPED',
        reason: 'No valid rows after validation',
        errorCount: validationResult.errorRows?.length || 0
      };
    }
    
    // 8. Create batch (non-blocking — local fallback if Supabase unavailable)
    const targetTableMap = {
      'goods_receipt': 'goods_receipts',
      'price_history': 'price_history',
      'supplier_master': 'suppliers',
      'bom_edge': 'bom_edges',
      'demand_fg': 'demand_fg',
      'po_open_lines': 'po_open_lines',
      'inventory_snapshots': 'inventory_snapshots',
      'fg_financials': 'fg_financials',
      'operational_costs': 'operational_costs'
    };

    onProgress({ stage: 'substep', sheetName, uploadType, substep: 'Creating import batch...' });
    let batchId;
    try {
      const batchRecord = await withTimeout(
        importBatchesService.createBatch(userId, {
          uploadType,
          filename: fileName,
          targetTable: targetTableMap[uploadType] || uploadType,
          totalRows: totalRows,
          metadata: {
            validRows: validationResult.validRows.length,
            errorRows: validationResult.errorRows?.length || 0,
            columns: headers,
            source: 'one-shot-import',
            sheetName,
            needsChunking: totalRows > 500
          }
        }),
        8000
      );
      batchId = batchRecord.id;
    } catch (batchErr) {
      logger.warn('import-ingest', `createBatch failed (non-blocking): ${batchErr?.message}`, { sheetName });
      batchId = `local-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    
    // 7. Generate idempotency key
    const idempotencyKey = getIdempotencyKey({ batchId, sheetName, uploadType });
    
    // 8. Check if already succeeded (idempotency)
    onProgress({ stage: 'substep', sheetName, uploadType, substep: 'Checking import history...' });
    if (hasIngestKeySupport && !forceRerun) {
      const existingRun = await withTimeout(findSucceededRun(userId, idempotencyKey), 5000, null);
      if (existingRun) {
        logger.info('import-ingest', `Sheet "${sheetName}" already imported (run: ${existingRun.id}), skipping`, { sheetName, existingRunId: existingRun.id });
        return {
          sheetName,
          uploadType,
          status: 'SKIPPED',
          reason: `Already imported (${existingRun.saved_rows} rows saved at ${existingRun.finished_at})`,
          savedCount: existingRun.saved_rows,
          batchId: existingRun.batch_id,
          existingRunId: existingRun.id
        };
      }
    }
    
    // 11. Create/update sheet run (running) — non-blocking
    if (hasIngestKeySupport) {
      try {
        const totalChunks = Math.ceil(validationResult.validRows.length / chunkSize);
        const sheetRun = await withTimeout(
          upsertSheetRun({
            userId,
            batchId,
            sheetName,
            uploadType,
            idempotencyKey,
            status: 'running',
            totalRows: validationResult.validRows.length,
            chunksTotal: totalChunks
          }),
          8000
        );
        sheetRunId = sheetRun.id;
      } catch (runErr) {
        logger.warn('import-ingest', `upsertSheetRun failed (non-blocking): ${runErr?.message}`, { sheetName });
      }

      // Delete previous data (idempotent)
      try {
        const deletedCount = await withTimeout(
          deletePreviousDataByIngestKey(userId, idempotencyKey, uploadType),
          8000,
          0
        );
        logger.info('import-ingest', `Deleted ${deletedCount} previous rows for "${sheetName}"`, { sheetName, deletedCount });
      } catch (deleteError) {
        logger.warn('import-ingest', `Failed to delete previous data: ${deleteError?.message}`, { sheetName });
        // Continue anyway (may be first import)
      }
    }

    // 10. Save original file — non-blocking
    let uploadFileId = null;
    try {
      const fileRecord = await withTimeout(
        userFilesService.saveFile(userId, `${sheetName}.json`, sheetData),
        8000,
        null
      );
      uploadFileId = fileRecord?.id;
    } catch (saveErr) {
      logger.warn('import-ingest', `saveFile failed (non-blocking): ${saveErr?.message}`, { sheetName });
    }
    if (!uploadFileId) {
      uploadFileId = `local-file-${Date.now()}`;
      logger.warn('import-ingest', `Using local file ID: ${uploadFileId}`, { sheetName, uploadFileId });
    }
    
    // 11. Use already validated and auto-filled rows (rowsToIngest already defined above)
    
    // 11.5. Final validation of critical required fields
    const finalValidation = validateRequiredFields(rowsToIngest, uploadType);
    if (!finalValidation.isValid) {
      logger.error('import-ingest', `Critical required fields still missing`, { sheetName, missingFields: finalValidation.missingFields });
      return {
        sheetName,
        uploadType,
        status: 'FAILED',
        reason: `Critical required fields missing: ${finalValidation.missingFields.join(', ')}`,
        invalidRows: finalValidation.invalidRows.length,
        errorDetails: finalValidation.invalidRows.slice(0, 5)  // First 5 rows
      };
    }
    
    // 12. Get upload strategy
    const strategy = getUploadStrategy(uploadType);

    // Adaptive chunk size: reduce for very large sheets to bound memory
    const effectiveChunkSize = rowsToIngest.length > 50000
      ? Math.min(chunkSize, 200)
      : chunkSize;

    // 13. Ingest in chunks
    onProgress({ stage: 'substep', sheetName, uploadType, substep: 'Ingesting data...' });
    const ingestResult = await withTimeout(ingestInChunks({
      strategy,
      userId,
      uploadType,
      rows: rowsToIngest,
      batchId,
      uploadFileId,
      fileName,
      sheetName,
      chunkSize: effectiveChunkSize,
      onProgress: (chunkProgress) => {
        onProgress({
          stage: 'ingesting',
          sheetName,
          uploadType,
          chunkIndex: chunkProgress.chunkIndex,
          totalChunks: chunkProgress.totalChunks,
          savedSoFar: chunkProgress.savedSoFar,
          totalRows: rowsToIngest.length
        });
      },
      signal,
      options: {
        idempotencyKey: hasIngestKeySupport ? idempotencyKey : null
      }
    }), 120000); // 120s total timeout for all chunks

    // 13. Update batch status — non-blocking
    onProgress({ stage: 'substep', sheetName, uploadType, substep: 'Finalizing...' });
    try {
      await withTimeout(
        importBatchesService.updateBatch(batchId, {
          successRows: ingestResult.savedCount,
          errorRows: validationResult.errorRows?.length || 0,
          status: 'completed'
        }),
        5000
      );
    } catch (updateErr) {
      logger.warn('import-ingest', `updateBatch failed (non-blocking): ${updateErr?.message}`, { sheetName });
    }

    // 14. Update sheet run status (succeeded) — non-blocking
    if (hasIngestKeySupport && sheetRunId) {
      try {
        await withTimeout(
          updateSheetRun(userId, idempotencyKey, {
            status: 'succeeded',
            finished_at: new Date().toISOString(),
            saved_rows: ingestResult.savedCount,
            error_rows: validationResult.errorRows?.length || 0,
            chunks_completed: ingestResult.chunks.filter(c => c.status === 'success').length
          }),
          5000
        );
      } catch (runUpdateErr) {
        logger.warn('import-ingest', `updateSheetRun failed (non-blocking): ${runUpdateErr?.message}`, { sheetName });
      }
    }
    
    return {
      sheetName,
      uploadType,
      status: 'IMPORTED',
      savedCount: ingestResult.savedCount,
      batchId,
      userFileId: uploadFileId,
      errorCount: validationResult.errorRows?.length || 0,
      totalRows,
      chunks: ingestResult.chunks,
      warnings: ingestResult.warnings,
      sheetRunId,
      idempotencyKey: hasIngestKeySupport ? idempotencyKey : null, // For rollback
      quarantineReport
    };
    
  } catch (error) {
    logger.error('import-ingest', `Import error for sheet "${sheetName}": ${error.message}`, { sheetName, error: error.message });
    
    // Update sheet run status (failed)
    if (hasIngestKeySupport && sheetRunId) {
      try {
        const idempotencyKey = getIdempotencyKey({ batchId: 'unknown', sheetName, uploadType });
        await updateSheetRun(userId, idempotencyKey, {
          status: error.message === 'ABORTED' ? 'aborted' : 'failed',
          finished_at: new Date().toISOString(),
          error: { message: error.message, stack: error.stack }
        });
      } catch (updateError) {
        logger.error('import-ingest', `Failed to update sheet run status: ${updateError.message}`, { sheetName, error: updateError.message });
      }
    }
    
    throw error;
  }
}

/**
 * Validate sheet plans before import
 * 
 * @param {object[]} sheetPlans 
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateSheetPlans(sheetPlans) {
  const errors = [];
  
  const enabledPlans = sheetPlans.filter(p => p.enabled);
  
  const confidenceSnapshot = enabledPlans.map(p => ({ sheetName: p.sheetName, confidence: p.confidence, suggestedType: p.suggestedType, uploadType: p.uploadType }));
  sendAgentLog({location:'oneShotImportService.js:validateSheetPlans',message:'[validateSheetPlans] Entry',data:{enabledCount:enabledPlans.length,confidenceSnapshot},sessionId:'debug-session',hypothesisId:'V1'});
  
  if (enabledPlans.length === 0) {
    errors.push('No sheets enabled for import');
  }
  
  for (const plan of enabledPlans) {
    if (!plan.suggestedType && !plan.uploadType) {
      errors.push(`Sheet "${plan.sheetName}": No upload type specified`);
    }
    
    // Skip confidence check when user has already confirmed mapping (manual/AI + Confirm)
    if (!plan.mappingConfirmed && plan.confidence < 0.5) {
      errors.push(`Sheet "${plan.sheetName}": Very low confidence (${Math.round(plan.confidence * 100)}%), please verify carefully`);
      sendAgentLog({location:'oneShotImportService.js:validateSheetPlans',message:'[validateSheetPlans] Low confidence plan',data:{sheetName:plan.sheetName,confidence:plan.confidence,uploadType:plan.uploadType},runId:'post-fix',sessionId:'debug-session',hypothesisId:'V2'});
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
