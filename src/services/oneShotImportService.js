/**
 * One-shot Import Service - Generic multi-sheet import framework
 * Supports chunk ingest (>1000 rows), idempotency, abort, detailed reporting
 */

import * as XLSX from 'xlsx';
import { classifySheet, getClassificationReasons } from '../utils/sheetClassifier';
import { getUploadStrategy, getIdempotencyKey } from './uploadStrategies';
import { importBatchesService } from './importHistoryService';
import { userFilesService } from './supabaseClient';
import { validateAndCleanData } from '../utils/dataValidation';
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
import { suggestMappingWithLLM } from './oneShotAiSuggestService';

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
export function generateSheetPlans(workbook, fileName = 'unknown', fileSize = 0, fileLastModified = 0, options = {}) {
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
      
      // ✅ A) Calculate actual mapping state (using rule-based mapping)
      const uploadType = classification.suggestedType;
      let mappingStatus = {
        coverage: 0,
        missingRequired: [],
        isComplete: false
      };
      let initialMapping = {};
      
      if (uploadType && UPLOAD_SCHEMAS[uploadType]) {
        const schema = UPLOAD_SCHEMAS[uploadType];
        
        // Use rule-based mapping to calculate initial coverage
        const ruleMappings = ruleBasedMapping(headers, uploadType, schema.fields);
        initialMapping = {};
        ruleMappings.forEach(m => {
          if (m.target && m.confidence >= 0.7) {
            initialMapping[m.source] = m.target;
          }
        });
        
        // Calculate mapping status
        mappingStatus = getRequiredMappingStatus({
          uploadType,
          columns: headers,
          columnMapping: initialMapping
        });
        
        console.log(`[generateSheetPlans] ${sheetName} (${uploadType}): coverage=${Math.round(mappingStatus.coverage * 100)}%, missing=[${mappingStatus.missingRequired.join(', ')}], typeConfidence=${Math.round(classification.confidence * 100)}%`);
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
        mappingDraft: { ...initialMapping },
        mappingFinal: null,
        mappingConfirmed: false,
        requiredCoverage: mappingStatus.coverage,
        missingRequired: mappingStatus.missingRequired,
        isComplete: mappingStatus.isComplete
      };
      sendAgentLog({location:'oneShotImportService.js:generateSheetPlans',message:'[generateSheetPlans] Plan pushed',data:{sheetName,uploadType:classification.suggestedType,isComplete:mappingStatus.isComplete,requiredCoverage:mappingStatus.coverage,missingRequired:mappingStatus.missingRequired,mappingDraftKeys:Object.keys(initialMapping)},sessionId:'debug-session',hypothesisId:'H1'});
      plans.push(planPayload);
      
    } catch (error) {
      console.error(`[One-shot] Failed to analyze sheet "${sheetName}":`, error);
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
  
  console.log('[One-shot] Generated sheet plans:', plans.map(p => ({ 
    sheetId: p.sheetId, 
    name: p.sheetName, 
    type: p.uploadType, 
    confidence: Math.round(p.confidence * 100) + '%',
    enabled: p.enabled 
  })));
  
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
  
  // Check if ingest_key support is deployed
  const hasIngestKeySupport = await checkIngestKeySupport();
  
  if (!hasIngestKeySupport) {
    console.warn('[One-shot] Ingest key support not deployed, using fallback mode');
    // All-or-nothing mode requires ingest_key support
    if (mode === 'all-or-nothing') {
      console.warn('[One-shot] All-or-nothing mode requires ingest_key support, falling back to best-effort');
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
    sheetReports: []
  };
  
  // Track succeeded sheets for rollback (All-or-nothing mode)
  const succeededSheetsForRollback = [];
  
  // Import sheets sequentially
  for (let i = 0; i < enabledPlans.length; i++) {
    const plan = enabledPlans[i];
    const { sheetName, suggestedType: uploadType } = plan;
    
    console.log(`[One-shot] Processing sheet ${i + 1}/${enabledPlans.length}: ${sheetName} (${uploadType})`);
    
    // Check abort
    if (signal?.aborted) {
      console.log('[One-shot] Aborted by user');
      report.sheetReports.push({
        sheetName,
        uploadType,
        status: 'ABORTED',
        reason: 'Import aborted by user'
      });
      
      // All-or-nothing: rollback on abort
      if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
        console.log('[One-shot] All-or-nothing mode: Rolling back succeeded sheets due to abort');
        await rollbackSucceededSheets(succeededSheetsForRollback, userId);
        report.rolledBack = true;
      }
      
      break;
    }
    
    // ✅ Two-step Gate: Hard gate check for mappingFinal
    if (!plan.mappingFinal || Object.keys(plan.mappingFinal).length === 0) {
      console.log(`[One-shot] Sheet "${sheetName}" NEEDS_REVIEW: no mappingFinal`);
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
          
          console.log(`[One-shot] Pre-import check for ${sheetName}: coverage=${Math.round(mappingStatus.coverage * 100)}%, missing=${mappingStatus.missingRequired.join(',')}`);
          
          if (!mappingStatus.isComplete) {
            // Hard block: import not allowed
            console.warn(`[One-shot] BLOCKED: ${sheetName} mapping incomplete`);
            
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
      console.error(`[One-shot] Pre-check error for ${sheetName}:`, preCheckError);
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
          console.log('[One-shot] All-or-nothing mode: Rolling back succeeded sheets due to failure');
          await rollbackSucceededSheets(succeededSheetsForRollback, userId);
          report.rolledBack = true;
        }
      }
      
      report.sheetReports.push(sheetResult);
      
    } catch (error) {
      console.error(`[One-shot] Failed to import sheet "${sheetName}":`, error);
      
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
        console.log('[One-shot] All-or-nothing mode: Rolling back succeeded sheets due to exception');
        await rollbackSucceededSheets(succeededSheetsForRollback, userId);
        report.rolledBack = true;
      }
    }
  }
  
  report.finishedAt = new Date().toISOString();
  
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
  console.log(`[One-shot] Rolling back ${succeededSheets.length} succeeded sheets...`);
  
  for (const sheet of succeededSheets) {
    try {
      console.log(`[One-shot] Rolling back "${sheet.sheetName}" (${sheet.uploadType}), ingest_key: ${sheet.idempotencyKey}`);
      
      const deletedCount = await deletePreviousDataByIngestKey(
        userId,
        sheet.idempotencyKey,
        sheet.uploadType
      );
      
      console.log(`[One-shot] Rolled back "${sheet.sheetName}": ${deletedCount} rows deleted`);
      
    } catch (error) {
      console.error(`[One-shot] Failed to rollback "${sheet.sheetName}":`, error);
      // Continue rolling back other sheets, don't interrupt
    }
  }
  
  console.log('[One-shot] Rollback completed');
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
    // 1. Parse sheet data
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    
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
      console.log(`[importSingleSheet] GATE: No providedMapping for ${sheetName}, marking NEEDS_REVIEW`);
      return {
        sheetName,
        uploadType,
        status: 'NEEDS_REVIEW',
        reason: 'No mapping provided (mappingFinal missing from Step 2)'
      };
    }
    
    // ✅ Use providedMapping (mappingFinal from Step 2)
    const columnMapping = providedMapping;
    console.log(`[importSingleSheet] ✅ Using mappingFinal:`, Object.keys(columnMapping).length, 'mappings');
    
    // 4. Check required fields coverage
    const mappingStatus = getRequiredMappingStatus({
      uploadType,
      columns: headers,
      columnMapping
    });
    
    console.log(`[importSingleSheet] Final coverage: ${Math.round(mappingStatus.coverage * 100)}%, missing:`, mappingStatus.missingRequired);
    
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
    
    // 8. Auto-fill common missing fields (for any remaining fillable fields)
    const autoFillResult = autoFillRows(validationResult.validRows, uploadType);
    const rowsToIngest = autoFillResult.rows;
    
    // Log auto-fill summary
    if (autoFillResult.autoFillCount > 0) {
      console.log(`[One-shot] Auto-filled ${autoFillResult.autoFillCount} rows:`, autoFillResult.autoFillSummary.join(', '));
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
      console.warn(`[One-shot] createBatch failed or timed out (non-blocking):`, batchErr?.message);
      batchId = `local-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    
    // 7. Generate idempotency key
    const idempotencyKey = getIdempotencyKey({ batchId, sheetName, uploadType });
    
    // 8. Check if already succeeded (idempotency)
    onProgress({ stage: 'substep', sheetName, uploadType, substep: 'Checking import history...' });
    if (hasIngestKeySupport && !forceRerun) {
      const existingRun = await withTimeout(findSucceededRun(userId, idempotencyKey), 5000, null);
      if (existingRun) {
        console.log(`[One-shot] Sheet "${sheetName}" already imported (run: ${existingRun.id}), skipping`);
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
        console.warn(`[One-shot] upsertSheetRun failed or timed out (non-blocking):`, runErr?.message);
      }

      // Delete previous data (idempotent)
      try {
        const deletedCount = await withTimeout(
          deletePreviousDataByIngestKey(userId, idempotencyKey, uploadType),
          8000,
          0
        );
        console.log(`[One-shot] Deleted ${deletedCount} previous rows for sheet "${sheetName}"`);
      } catch (deleteError) {
        console.warn(`[One-shot] Failed to delete previous data:`, deleteError);
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
      console.warn(`[One-shot] saveFile failed (non-blocking):`, saveErr?.message);
    }
    if (!uploadFileId) {
      uploadFileId = `local-file-${Date.now()}`;
      console.warn(`[One-shot] Using local file ID: ${uploadFileId}`);
    }
    
    // 11. Use already validated and auto-filled rows (rowsToIngest already defined above)
    
    // 11.5. Final validation of critical required fields
    const finalValidation = validateRequiredFields(rowsToIngest, uploadType);
    if (!finalValidation.isValid) {
      console.error(`[One-shot] Critical required fields still missing:`, finalValidation.missingFields);
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
      chunkSize,
      onProgress: (chunkProgress) => {
        onProgress({
          stage: 'ingesting',
          sheetName,
          uploadType,
          chunkIndex: chunkProgress.chunkIndex,
          totalChunks: chunkProgress.totalChunks,
          savedSoFar: chunkProgress.savedSoFar
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
      console.warn(`[One-shot] updateBatch failed or timed out (non-blocking):`, updateErr?.message);
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
        console.warn(`[One-shot] updateSheetRun failed or timed out (non-blocking):`, runUpdateErr?.message);
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
      idempotencyKey: hasIngestKeySupport ? idempotencyKey : null // For rollback
    };
    
  } catch (error) {
    console.error(`[One-shot] Import error for sheet "${sheetName}":`, error);
    
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
        console.error('[One-shot] Failed to update sheet run status:', updateError);
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
