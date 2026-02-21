/**
 * Enhanced External Systems View
 * Enhanced external system data upload - Supports multiple upload types, field mapping, and data validation
 */

import React, { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Database, Upload, Download, X, RefreshCw, Sparkles,
  Check, AlertTriangle, ArrowRight, ArrowLeft, FileSpreadsheet, Loader2, TrendingUp,
  Layers
} from 'lucide-react';
import { Card, Button } from '../components/ui';
import { callGeminiAPI } from '../services/geminiAPI';
import { userFilesService, uploadMappingsService } from '../services/supabaseClient';
import { importBatchesService } from '../services/importHistoryService';
import { getUploadStrategy } from '../services/uploadStrategies';
import { useUploadWorkflow } from '../hooks/useUploadWorkflow';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import { validateAndCleanData } from '../utils/dataValidation';
import { downloadErrorReport } from '../utils/errorReport';
import {
  extractAiJson,
  generateMappingPrompt,
  validateMappingResponse,
  mergeMappings,
  ruleBasedMapping
} from '../utils/aiMappingHelper';
import { generateSheetPlans, importWorkbookSheets, validateSheetPlans } from '../services/oneShotImportService';
import { suggestSheetMapping } from '../services/oneShotAiSuggestService';
import { runWithConcurrencyAbortable } from '../utils/concurrency';
import { getRequiredMappingStatus, formatMissingRequiredMessage } from '../utils/requiredMappingStatus';
import { getSearchParams, updateUrlSearch } from '../utils/router';
import { createDatasetProfileFromSheets } from '../services/datasetProfilingService';
import { sendAgentLog } from '../utils/sendAgentLog';

// Note: Upload type configuration has been moved to src/utils/uploadSchemas.js
// Kept here for compatibility, but UPLOAD_SCHEMAS should be used

const EnhancedExternalSystemsView = ({ addNotification, user, setView }) => {
  // Use useUploadWorkflow hook to manage core workflow state
  const { state: workflowState, actions: workflowActions } = useUploadWorkflow();
  const {
    currentStep,
    uploadType,
    file,
    fileName,
    rawRows,
    columns,
    columnMapping,
    mappingComplete,
    validationResult,
    strictMode,
    loading,
    saving
  } = workflowState;

  // Remaining state kept as useState (not moved into reducer to avoid risk)
  const [workbook, setWorkbook] = useState(null); // Store workbook for sheet switching
  const [sheetNames, setSheetNames] = useState([]); // Available sheet names
  const [selectedSheet, setSelectedSheet] = useState(''); // Currently selected sheet

  // AI mapping suggestion status
  const [mappingAiStatus, setMappingAiStatus] = useState('idle'); // 'idle' | 'analyzing' | 'ready' | 'error'
  const [mappingAiError, setMappingAiError] = useState('');

  const [uploadProgress, setUploadProgress] = useState(0);
  
  // Batch upload progress state
  const [saveProgress, setSaveProgress] = useState({
    stage: '', // 'suppliers' | 'materials' | 'receipts' | 'rpc'
    current: 0,
    total: 0,
    message: ''
  });

  // ===== One-shot Import related state (tab=upload|oneshot in URL for persistence) =====
  const [oneShotEnabled, setOneShotEnabled] = useState(() => getSearchParams().tab === 'oneshot');
  useEffect(() => {
    updateUrlSearch({ tab: oneShotEnabled ? 'oneshot' : 'upload' });
  }, [oneShotEnabled]);
  const [oneShotStep, setOneShotStep] = useState('IDLE'); // ✅ 'IDLE' | 'CLASSIFY' | 'REVIEW' | 'IMPORTING' | 'RESULT'
  const [currentEditingSheetIndex, setCurrentEditingSheetIndex] = useState(0); // ✅ Current editing sheet index in Step 2
  const [activeReviewSheetId, setActiveReviewSheetId] = useState(null); // ✅ Currently editing sheetId in Step 2
  const [sheetPlans, setSheetPlans] = useState([]); // ✅ [{sheetName, uploadType, enabled, mappingDraft, mappingFinal, mappingConfirmed}]
  const [oneShotProgress, setOneShotProgress] = useState({ 
    stage: '', 
    current: 0, 
    total: 0, 
    sheetName: '',
    chunkIndex: 0,
    totalChunks: 0,
    savedSoFar: 0
  });
  const [importReport, setImportReport] = useState(null); // ✅ Complete import report (corresponds to Download Report)
  const [oneShotResult, setOneShotResult] = useState(null); // Import result summary (backward compatible)
  const [oneShotError, setOneShotError] = useState('');
  const [isImporting, setIsImporting] = useState(false); // ✅ Controls loading/buttons
  const [chunkSize, setChunkSize] = useState(500); // Chunk size selection
  const [abortController, setAbortController] = useState(null); // Abort controller
  const [aiSuggestLoading, setAiSuggestLoading] = useState({}); // { sheetId: boolean }
  const [oneShotMode, setOneShotMode] = useState('best-effort'); // 'best-effort' | 'all-or-nothing'
  
  // AI Suggest All related state
  const [aiSuggestAllRunning, setAiSuggestAllRunning] = useState(false);
  const [aiSuggestAllProgress, setAiSuggestAllProgress] = useState({ completed: 0, total: 0 });
  const [aiSuggestAllAbortController, setAiSuggestAllAbortController] = useState(null);
  const [includeAlreadyReady, setIncludeAlreadyReady] = useState(false); // checkbox: whether to include already-ready sheets

  const fileInputRef = useRef(null);

  // Step 1: Select upload type
  const handleTypeSelect = (type) => {
    workflowActions.setUploadType(type);
    // Reset other states (non-workflow states)
    setWorkbook(null);
    setSheetNames([]);
    setSelectedSheet('');
    // Reset One-shot states
    setSheetPlans([]);
    setOneShotResult(null);
    setOneShotError('');
  };

  // Handle sheet change
  const handleSheetChange = (sheetName) => {
    if (!workbook) return;
    
    try {
      workflowActions.startLoading();
      
      // Read data from selected sheet
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      
      if (data.length === 0) {
        addNotification(`Sheet "${sheetName}" is empty`, "error");
        workflowActions.stopLoading();
        return;
      }
      
      const cols = Object.keys(data[0]);
      
      // Update state
      setSelectedSheet(sheetName);
      workflowActions.setFile(file, fileName, data, cols);
      
      // Reset mapping when switching sheets
      workflowActions.setMapping({});
      workflowActions.setMappingComplete(false);
      setMappingAiStatus('idle');
      
      // Stay on step 3 (mapping) if already there, otherwise go to step 3
      if (currentStep >= 3) {
        workflowActions.setStep(3);
      }
      
      addNotification(`Switched to sheet "${sheetName}", loaded ${data.length} rows`, "success");
      workflowActions.stopLoading();
    } catch (error) {
      console.error('Error switching sheet:', error);
      addNotification(`Failed to load sheet "${sheetName}": ${error.message}`, "error");
      workflowActions.stopLoading();
    }
  };

  // Step 2: Upload file
  const handleFileChange = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    // One-shot mode: no need to select uploadType
    // Normal mode: need to select uploadType
    if (!oneShotEnabled && !uploadType) {
      addNotification("Please select upload type before choosing file", "error");
      // Clear file selection
      e.target.value = '';
      return;
    }

    const lower = selectedFile.name.toLowerCase();
    const isExcel = lower.endsWith('.xlsx') || lower.endsWith('.xls');
    const isCsv = lower.endsWith('.csv');

    if (!isExcel && !isCsv) {
      addNotification("Invalid file type. Please upload CSV or Excel files (.csv, .xlsx, .xls)", "error");
      return;
    }

    // One-shot only supports Excel
    if (oneShotEnabled && !isExcel) {
      addNotification("One-shot import only supports Excel files (.xlsx, .xls)", "error");
      return;
    }

    if (selectedFile.size > 100 * 1024 * 1024) {
      addNotification("File too large. Maximum size is 100MB", "error");
      return;
    }

    setUploadProgress(10);
    workflowActions.startLoading();

    try {
      const { workbookData, rows, cols, sheets, defaultSheet } = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const bstr = evt.target.result;
            const wb = XLSX.read(bstr, { type: 'binary' });
            
            // Get all sheet names
            const sheets = wb.SheetNames;
            
            // Default to first sheet
            const defaultSheet = sheets[0];
            const data = XLSX.utils.sheet_to_json(wb.Sheets[defaultSheet], { defval: '' });
            
            if (data.length === 0) {
              reject(new Error(`Sheet "${defaultSheet}" is empty`));
              return;
            }
            
            const cols = Object.keys(data[0]);
            
            resolve({
              workbookData: wb,
              rows: data,
              cols: cols,
              sheets: sheets,
              defaultSheet: defaultSheet
            });
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsBinaryString(selectedFile);
      });

      // Store workbook and sheet info
      setWorkbook(workbookData);
      setSheetNames(sheets);
      setSelectedSheet(defaultSheet);
      workflowActions.setFile(selectedFile, selectedFile.name, rows, cols);
      setUploadProgress(100);

      // ===== One-shot mode: auto-classify all sheets =====
      if (oneShotEnabled && isExcel) {
        try {
          console.log('[One-shot] Generating sheet plans for', sheets.length, 'sheets');
          console.log('[One-shot] File metadata:', { name: selectedFile.name, size: selectedFile.size, lastModified: selectedFile.lastModified });
          
          // Use generic generateSheetPlans (pass in file metadata)
          const plans = generateSheetPlans(workbookData, selectedFile.name, selectedFile.size, selectedFile.lastModified);
          
          setSheetPlans(plans);
          
          console.log('[One-shot] Sheet plans generated:', plans.map(p => ({ 
            sheetId: p.sheetId,
            name: p.sheetName, 
            type: p.uploadType, 
            confidence: Math.round(p.confidence * 100) + '%',
            enabled: p.enabled,
            rows: p.rowCount
          })));
          
          // ✅ A) State Machine: enter CLASSIFY after generating plans
          console.log('[OneShotStep] IDLE -> CLASSIFY (sheet plans generated)');
          setOneShotStep('CLASSIFY');
          
          const enabledCount = plans.filter(p => p.enabled).length;
          addNotification(
            `Analyzed ${sheets.length} sheets: ${enabledCount} auto-enabled, ${sheets.length - enabledCount} need review`,
            "success"
          );

          // Save an initial dataset profile snapshot from one-shot classification (best-effort)
          if (user?.id) {
            const sheetsRawForProfile = plans.map((plan) => {
              const sheet = workbookData?.Sheets?.[plan.sheetName];
              const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }) : [];
              const headers = plan.headers?.length > 0 ? plan.headers : Object.keys(rows[0] || {});

              return {
                sheet_name: plan.sheetName,
                columns: headers,
                rows,
                row_count_estimate: plan.rowCount || rows.length
              };
            });

            const mappingPlans = plans.map((plan) => ({
              sheet_name: plan.sheetName,
              upload_type: plan.uploadType || plan.suggestedType || 'unknown',
              confidence: plan.confidence || 0,
              mapping: plan.mappingFinal || plan.mappingDraft || {}
            }));

            createDatasetProfileFromSheets({
              userId: user.id,
              userFileId: null,
              fileName: selectedFile.name,
              sheetsRaw: sheetsRawForProfile,
              mappingPlans
            }).catch((profileError) => {
              console.error('[dataset profile] initial one-shot profile generation failed:', profileError);
            });
          }
          
          // Enter One-shot preparation screen (uses step 3, but conditionally shows different content)
          workflowActions.setStep(3);
          
        } catch (classifyError) {
          console.error('One-shot classification failed:', classifyError);
          setOneShotError('One-shot classification failed. Please use single-sheet import.');
          setOneShotEnabled(false);
          addNotification('One-shot failed, switched to normal mode', 'error');
        }
        
        workflowActions.stopLoading();
        setTimeout(() => setUploadProgress(0), 1000);
        return;
      }

      // ===== Normal mode: single sheet upload =====
      const sheetInfo = sheets.length > 1 ? ` (Sheet: ${defaultSheet}, ${sheets.length} sheets available)` : '';
      addNotification(`Loaded ${rows.length} rows${sheetInfo}`, "success");

      // Automatically proceed to field mapping step and load previous mapping
      setTimeout(async () => {
        workflowActions.setStep(3);
        
        // Try to load and apply previously saved mapping template
        try {
          if (user?.id) {
            const smartMapping = await uploadMappingsService.smartMapping(
              user.id,
              uploadType,
              cols
            );

            if (Object.keys(smartMapping).length > 0) {
              workflowActions.setMapping(smartMapping);
              addNotification(
                `Auto-applied previous field mapping (${Object.keys(smartMapping).filter(k => smartMapping[k]).length} fields)`,
                "info"
              );
              
              // Check if mapping is complete
              checkMappingComplete(smartMapping);
            } else {
              // No saved mapping, initialize empty mapping
              const initialMapping = {};
              cols.forEach(col => {
                initialMapping[col] = '';
              });
              workflowActions.setMapping(initialMapping);
            }
          } else {
            // Not logged in, initialize empty mapping
            const initialMapping = {};
            cols.forEach(col => {
              initialMapping[col] = '';
            });
            workflowActions.setMapping(initialMapping);
          }
        } catch (error) {
          console.error('Failed to load mapping template:', error);
          // On failure, initialize empty mapping
          const initialMapping = {};
          cols.forEach(col => {
            initialMapping[col] = '';
          });
          workflowActions.setMapping(initialMapping);
        }
      }, 500);

    } catch (error) {
      addNotification(`Upload failed: ${error.message}`, "error");
      workflowActions.setError(error.message);
      
      // One-shot failure handling
      if (oneShotEnabled) {
        setOneShotError('One-shot failed. Please use single-sheet import.');
        setOneShotEnabled(false);
      }
    } finally {
      workflowActions.stopLoading();
      setTimeout(() => setUploadProgress(0), 1000);
    }
  };

  // Update column mapping - from Excel column -> system field
  const updateColumnMapping = (excelColumn, systemFieldKey) => {
    const updated = { ...columnMapping, [excelColumn]: systemFieldKey };
    workflowActions.setMapping(updated);
    checkMappingComplete(updated);
  };

  // Check if mapping is complete (all required fields are mapped)
  const checkMappingComplete = (mapping) => {
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) {
      workflowActions.setMappingComplete(false);
      return;
    }

    // Get all required fields
    const requiredFields = schema.fields
      .filter(f => f.required)
      .map(f => f.key);

    // Get mapped system fields
    const mappedSystemFields = Object.values(mapping).filter(v => v !== '');

    // Check if all required fields are mapped
    const allRequiredMapped = requiredFields.every(reqField => 
      mappedSystemFields.includes(reqField)
    );

    workflowActions.setMappingComplete(allRequiredMapped);
  };

  // Get unmapped required fields
  const getUnmappedRequiredFields = () => {
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) return [];

    const requiredFields = schema.fields
      .filter(f => f.required)
      .map(f => f.key);

    const mappedSystemFields = Object.values(columnMapping).filter(v => v !== '');

    return requiredFields.filter(reqField => 
      !mappedSystemFields.includes(reqField)
    );
  };

  /**
   * AI Auto Field Mapping Suggestion
   * Uses Gemini AI to analyze fields and suggest mappings
   */
  const runAiMappingSuggestion = async () => {
    // Pre-condition checks
    if (!uploadType) {
      addNotification("Please select upload type first", "error");
      return;
    }

    if (!rawRows || rawRows.length === 0) {
      addNotification("Please upload file first", "error");
      return;
    }

    if (!columns || columns.length === 0) {
      addNotification("Unable to retrieve file column information", "error");
      return;
    }

    // Start AI analysis
    setMappingAiStatus('analyzing');
    setMappingAiError('');

    // Get schema (defined outside try so catch can also use it)
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) {
      addNotification(`Unknown upload type: ${uploadType}`, "error");
      setMappingAiStatus('error');
      return;
    }

    try {

      // Prepare sample data (first 20 rows)
      const sampleRows = rawRows.slice(0, 20);

      // Generate prompt
      const prompt = generateMappingPrompt(
        uploadType,
        schema.fields,
        columns,
        sampleRows
      );

      // Call Gemini API
      console.log('=== AI Mapping Request ===');
      console.log('Upload Type:', uploadType);
      console.log('Columns:', columns);
      console.log('Prompt:', prompt);
      
      const aiResponse = await callGeminiAPI(prompt);
      console.log('=== AI Raw Response ===');
      console.log('Length:', aiResponse?.length);
      console.log('Content:', aiResponse);
      console.log('First 200 chars:', aiResponse?.substring(0, 200));

      // Parse AI response
      const parsedResponse = extractAiJson(aiResponse);
      console.log('=== Parsed Response ===');
      console.log('Type:', typeof parsedResponse);
      console.log('Has mappings:', parsedResponse?.mappings ? 'Yes' : 'No');
      console.log('Mappings count:', parsedResponse?.mappings?.length);
      console.log('Full parsed:', JSON.stringify(parsedResponse, null, 2));

      // Validate response format
      if (!validateMappingResponse(parsedResponse)) {
        console.error('=== Validation Failed ===');
        console.error('Invalid response structure:', parsedResponse);
        console.error('Validation details: missing "mappings" array or invalid mapping structure');
        throw new Error('AI response format is incorrect. The AI may have returned explanatory text instead of pure JSON. Please try again or use manual mapping.');
      }
      
      console.log('=== Validation Passed ===');

      // Merge mapping suggestions into existing columnMapping
      const { mapping: newMapping, appliedCount, skippedCount } = mergeMappings(
        columnMapping,
        parsedResponse.mappings,
        0.6 // Minimum confidence threshold
      );

      // Update columnMapping
      workflowActions.setMapping(newMapping);
      
      // Check if mapping is complete
      checkMappingComplete(newMapping);

      // Set status to success
      setMappingAiStatus('ready');

      // Show success notification
      if (appliedCount > 0) {
        addNotification(
          `Applied AI field suggestions (${appliedCount} fields). Please review before saving.${skippedCount > 0 ? ` ${skippedCount} already-mapped fields were not overwritten.` : ''}`,
          "success"
        );
      } else {
        addNotification(
          "AI could not provide suggestions with sufficient confidence. Please use manual mapping.",
          "info"
        );
      }

    } catch (error) {
      console.error('AI field suggestion failed:', error);
      console.log('Falling back to rule-based mapping...');
      
      // Try rule-based mapping as fallback
      try {
        const ruleMappings = ruleBasedMapping(columns, uploadType, schema.fields);
        console.log('Rule-based mappings:', ruleMappings);
        
        // Filter valid mappings (target is not null and confidence >= 0.7)
        const validMappings = ruleMappings.filter(m => m.target && m.confidence >= 0.7);
        
        if (validMappings.length > 0) {
          // Use rule-based mapping results
          const { mapping: newMapping, appliedCount } = mergeMappings(
            columnMapping,
            validMappings,
            0.7
          );
          
          workflowActions.setMapping(newMapping);
          checkMappingComplete(newMapping);
          setMappingAiStatus('ready');
          
          addNotification(
            `AI failed, but applied ${appliedCount} smart suggestions based on common patterns. Please review.`,
            "info"
          );
        } else {
          // Rule-based mapping also found no sufficient matches
          setMappingAiStatus('error');
          setMappingAiError(error.message || 'AI analysis failed');
          addNotification(
            `AI field suggestion failed: ${error.message}. Please use manual mapping.`,
            "error"
          );
        }
      } catch (ruleError) {
        console.error('Rule-based mapping also failed:', ruleError);
        setMappingAiStatus('error');
        setMappingAiError(error.message || 'AI analysis failed');
        addNotification(
          `AI field suggestion failed: ${error.message}. Please use manual mapping.`,
          "error"
        );
      }
    }
  };

  /**
   * Convert Excel date serial number to readable date format
   * @param {any} value - Date value (could be number, string, Date object)
   * @returns {string} Formatted date string or original value
   */
  const formatDateForPreview = (value) => {
    if (!value) return value;

    // If it's an Excel serial number (number between 1 and 50000)
    if (typeof value === 'number' && value >= 1 && value <= 50000) {
      try {
        // Excel epoch is 1899-12-30 (accounting for Excel's 1900 leap year bug)
        const excelEpoch = new Date(1899, 11, 30);
        const date = new Date(excelEpoch.getTime() + value * 86400000);
        
        if (!isNaN(date.getTime())) {
          return date.toISOString().split('T')[0]; // Returns YYYY-MM-DD
        }
      } catch (e) {
        console.error('Error converting Excel date:', value, e);
      }
    }

    // If it's already a Date object
    if (value instanceof Date && !isNaN(value.getTime())) {
      return value.toISOString().split('T')[0];
    }

    // Return original value for strings and other types
    return value;
  };

  /**
   * Generate mapped data preview - shows how data will look after field mapping
   * @returns {Array} Preview rows with system field names
   */
  const generateMappedPreview = () => {
    if (!rawRows || rawRows.length === 0 || !columnMapping) {
      return [];
    }

    // Get schema to check field types
    const schema = UPLOAD_SCHEMAS[uploadType];
    
    // Take first 5 rows for preview
    const previewRows = rawRows.slice(0, 5);
    
    return previewRows.map((row, index) => {
      const mappedRow = { _rowIndex: index + 1 };
      
      // Transform data according to columnMapping
      Object.entries(columnMapping).forEach(([excelCol, systemField]) => {
        if (systemField && systemField !== '') {
          let value = row[excelCol];
          
          // Check if this field is a date type and format it
          const fieldDef = schema?.fields.find(f => f.key === systemField);
          if (fieldDef && fieldDef.type === 'date') {
            value = formatDateForPreview(value);
          }
          
          mappedRow[systemField] = value;
        }
      });
      
      return mappedRow;
    });
  };

  /**
   * Get all mapped system fields (sorted by required first)
   * @returns {Array} Array of field objects that have been mapped
   */
  const getMappedSystemFields = () => {
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) return [];
    
    const mappedFields = Object.values(columnMapping).filter(v => v !== '');
    
    return schema.fields
      .filter(f => mappedFields.includes(f.key))
      .sort((a, b) => {
        // Required fields first
        if (a.required && !b.required) return -1;
        if (!a.required && b.required) return 1;
        return 0;
      });
  };

  // Step 4: Validate and clean data
  const validateData = () => {
    // Use new helper to check mapping completeness
    const mappingStatus = getRequiredMappingStatus({
      uploadType,
      columns,
      columnMapping
    });

    if (!mappingStatus.isComplete) {
      const message = formatMissingRequiredMessage(mappingStatus.missingRequired);
      addNotification(`Cannot proceed: ${message}`, "error");
      console.error('[validateData] Mapping incomplete:', mappingStatus);
      return;
    }

    workflowActions.startLoading();

    try {
      // Use new validation function: transform -> validate -> clean
      const result = validateAndCleanData(rawRows, uploadType, columnMapping);
      workflowActions.setValidation(result);

      // Show different notifications based on success rate
      if (result.stats.successRate === 100) {
        addNotification(`Validation complete: All ${result.stats.total} rows are valid!`, "success");
      } else if (result.stats.successRate >= 50) {
        addNotification(`Validation complete: ${result.stats.valid} valid, ${result.stats.invalid} errors`, "success");
      } else {
        addNotification(`Warning: Only ${result.stats.successRate}% of data is valid (${result.stats.valid}/${result.stats.total})`, "error");
      }
    } catch (error) {
      addNotification(`Validation failed: ${error.message}`, "error");
      console.error('Validation error:', error);
      workflowActions.stopLoading();
    }
  };

  /**
   * Step 5: Save to database (using strategy pattern)
   */
  const handleSave = async () => {
    // Hard block: single-file mode must complete required mapping
    if (!oneShotEnabled) {
      const mappingStatus = getRequiredMappingStatus({
        uploadType,
        columns,
        columnMapping
      });

      if (!mappingStatus.isComplete) {
        const message = formatMissingRequiredMessage(mappingStatus.missingRequired);
        addNotification(`Cannot save: ${message}`, "error");
        console.error('[handleSave] Blocked: mapping incomplete', mappingStatus);
        return; // Hard return, do not allow entering save
      }
    }
    
    // Guard: check for valid data
    if (!validationResult || validationResult.validRows.length === 0) {
      addNotification("No valid data to save", "error");
      return;
    }

    // Strict mode check: do not allow saving if there are errors
    if (strictMode && validationResult.errorRows && validationResult.errorRows.length > 0) {
      addNotification(
        `Strict mode enabled: Cannot save with ${validationResult.errorRows.length} error rows. Please fix errors or switch to Best-effort mode.`,
        "error"
      );
      return;
    }

    const rowsToSave = validationResult.validRows;
    const mergedCount = validationResult.stats.merged || 0;
    const userId = user?.id;
    
    if (!userId) {
      addNotification('User not logged in, cannot save data', "error");
      return;
    }

    workflowActions.startSaving();

    let batchId = null;

    try {
      // 1. Create import batch
      const targetTableMap = {
        'goods_receipt': 'goods_receipts', 'price_history': 'price_history',
        'supplier_master': 'suppliers', 'bom_edge': 'bom_edges', 'demand_fg': 'demand_fg',
        'po_open_lines': 'po_open_lines', 'inventory_snapshots': 'inventory_snapshots',
        'fg_financials': 'fg_financials', 'operational_costs': 'operational_costs'
      };
      
      const batchRecord = await importBatchesService.createBatch(userId, {
        uploadType, filename: fileName, targetTable: targetTableMap[uploadType] || uploadType,
        totalRows: rawRows.length,
        metadata: { validRows: validationResult.validRows.length, errorRows: validationResult.errorRows.length, columns }
      });
      batchId = batchRecord.id;

      // 2. Save raw file
      const fileRecord = await userFilesService.saveFile(userId, fileName, rawRows);
      const uploadFileId = fileRecord?.id;
      if (!uploadFileId) throw new Error('saveFile did not return id, data consistency error');

      // 3. Execute data write using strategy pattern
      const strategy = getUploadStrategy(uploadType);
      const { savedCount } = await strategy.ingest({
        userId, rows: rowsToSave, batchId, uploadFileId, fileName,
        addNotification, setSaveProgress
      });

      // 4. Update batch status to completed
      await importBatchesService.updateBatch(batchId, {
        successRows: rowsToSave.length, errorRows: validationResult.errorRows.length, status: 'completed'
      });

      // 5. Save field mapping template
      try {
        await uploadMappingsService.saveMapping(userId, uploadType, columns, columnMapping);
      } catch (mappingError) {
        console.error('Failed to save mapping template:', mappingError);
      }

      // 5.5 Save dataset profile (non-blocking, do not interrupt upload success)
      createDatasetProfileFromSheets({
        userId,
        userFileId: uploadFileId,
        fileName,
        sheetsRaw: [
          {
            sheet_name: selectedSheet || fileName || 'Sheet1',
            columns,
            rows: rawRows,
            row_count_estimate: rawRows.length
          }
        ],
        mappingPlans: [
          {
            sheet_name: selectedSheet || fileName || 'Sheet1',
            upload_type: uploadType,
            mapping: columnMapping,
            confidence: 1
          }
        ]
      }).catch((profileError) => {
        console.error('[dataset profile] single-file profile generation failed:', profileError);
      });

      // 6. Show success message
      const details = [];
      if (mergedCount > 0) details.push(`${mergedCount} duplicates merged`);
      if (validationResult.errorRows.length > 0) details.push(`${validationResult.errorRows.length} errors skipped`);
      addNotification(`Successfully saved ${savedCount} rows${details.length > 0 ? ` (${details.join(', ')})` : ''}`, "success");

      // 7. Special prompt (demand_fg / bom_edge)
      if (['demand_fg', 'bom_edge'].includes(uploadType)) {
        setTimeout(() => {
          addNotification(
            `✅ ${uploadType === 'demand_fg' ? 'FG Demand' : 'BOM Edge'} data uploaded! Go to Forecasts page to run BOM Explosion →`,
            "success"
          );
        }, 1000);
      }

      // 8. Reset workflow
      setTimeout(() => workflowActions.reset(), 2000);

    } catch (error) {
      console.error('Error saving data:', error);
      const errorMsg = error?.message || error?.details || JSON.stringify(error);
      addNotification(`Save failed: ${errorMsg}`, "error");
      workflowActions.saveError(errorMsg);
      
      // Update batch status to failed
      if (batchId) {
        try {
          await importBatchesService.updateBatch(batchId, {
            status: 'failed', successRows: 0, errorRows: rawRows.length,
            metadata: { error: errorMsg, failedAt: new Date().toISOString(), originalFileName: fileName, uploadType }
          });
        } catch (updateError) {
          console.error('Failed to update batch status:', updateError);
        }
      }
    }
  };

  // ===== All save functions replaced by strategy pattern (see uploadStrategies.js) =====

  /**
   * One-shot Import: execute import for all enabled sheets
   */
  const handleOneShotImport = async () => {
    if (!workbook || !user?.id) {
      console.log('[OneShotStep] Import blocked: missing workbook or user');
      addNotification('Missing workbook or user session', 'error');
      return;
    }
    
    // Validate sheet plans
    sendAgentLog({location:'EnhancedExternalSystemsView.jsx:handleOneShotImport',message:'[Before validateSheetPlans] sheetPlans snapshot',data:{total:sheetPlans.length,enabled:sheetPlans.filter(p=>p.enabled).length,perSheet:sheetPlans.filter(p=>p.enabled).map(p=>({sheetName:p.sheetName,confidence:p.confidence,uploadType:p.uploadType}))},sessionId:'debug-session',hypothesisId:'V3'});
    const validation = validateSheetPlans(sheetPlans);
    if (!validation.valid) {
      console.log('[OneShotStep] Import blocked: validation failed', validation.errors);
      addNotification(
        `Validation failed: ${validation.errors.join('; ')}`,
        'error'
      );
      return;
    }
    
    // ✅ A) State Machine: REVIEW → IMPORTING
    console.log('[OneShotStep] REVIEW -> IMPORTING (starting import)');
    setOneShotStep('IMPORTING');
    setIsImporting(true);
    
    // ✅ C) Clear old report
    setImportReport(null);
    setOneShotResult(null);
    setOneShotError('');
    
    // Create abort controller
    const controller = new AbortController();
    setAbortController(controller);
    
    workflowActions.startSaving();
    
    try {
      const result = await importWorkbookSheets({
        userId: user.id,
        workbook,
        fileName: fileName || 'Workbook',
        sheetPlans,
        options: {
          strictMode,
          chunkSize,
          mode: oneShotMode, // 'best-effort' | 'all-or-nothing'
          signal: controller.signal,
          onProgress: (event) => {
            setOneShotProgress({
              stage: event.stage,
              current: event.current || 0,
              total: event.total || 0,
              sheetName: event.sheetName || '',
              uploadType: event.uploadType || '',
              chunkIndex: event.chunkIndex || 0,
              totalChunks: event.totalChunks || 0,
              savedSoFar: event.savedSoFar || 0
            });
          }
        }
      });
      
      // ✅ C) Write back report
      console.log('[OneShotStep] Import completed, writing report:', {
        totalSheets: result.totalSheets,
        succeeded: result.succeededSheets,
        needsReview: result.needsReviewSheets,
        failed: result.failedSheets
      });
      
      setImportReport(result);  // ✅ Complete report
      setOneShotResult(result);  // Backward compatible
      setAbortController(null);
      
      // ✅ A) State Machine: IMPORTING → RESULT
      console.log('[OneShotStep] IMPORTING -> RESULT (import finished)');
      setOneShotStep('RESULT');
      
      if (result.succeededSheets > 0) {
        const msg = `✓ One-shot import completed! ${result.succeededSheets} succeeded${result.needsReviewSheets > 0 ? `, ${result.needsReviewSheets} need review` : ''}${result.skippedSheets > 0 ? `, ${result.skippedSheets} skipped` : ''}${result.failedSheets > 0 ? `, ${result.failedSheets} failed` : ''}.`;
        addNotification(msg, result.needsReviewSheets > 0 ? 'warning' : 'success');
      } else {
        const msg = `⚠ No sheets imported.${result.needsReviewSheets > 0 ? ` ${result.needsReviewSheets} need review,` : ''} ${result.skippedSheets} skipped, ${result.failedSheets} failed.`;
        addNotification(msg, 'warning');
      }
      
      // Warning: if DB has not deployed idempotency support
      if (!result.hasIngestKeySupport) {
        addNotification(
          '⚠ DB has not deployed chunk-idempotency, degraded mode (recommend running one_shot_chunk_idempotency.sql)',
          'warning'
        );
      }

      // Save dataset profile for one-shot import (non-blocking)
      const userFileIdFromReport = result.sheetReports?.find((sheetReport) => sheetReport.userFileId)?.userFileId || null;
      const sheetsRawForProfile = sheetPlans.map((plan) => {
        const sheet = workbook?.Sheets?.[plan.sheetName];
        const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }) : [];
        const headers = plan.headers?.length > 0 ? plan.headers : Object.keys(rows[0] || {});

        return {
          sheet_name: plan.sheetName,
          columns: headers,
          rows,
          row_count_estimate: plan.rowCount || rows.length
        };
      });

      const mappingPlans = sheetPlans.map((plan) => ({
        sheet_name: plan.sheetName,
        upload_type: plan.uploadType || plan.suggestedType || 'unknown',
        confidence: plan.confidence || 0,
        mapping: plan.mappingFinal || plan.mappingDraft || {}
      }));

      createDatasetProfileFromSheets({
        userId: user.id,
        userFileId: userFileIdFromReport,
        fileName: fileName || 'Workbook',
        sheetsRaw: sheetsRawForProfile,
        mappingPlans
      }).catch((profileError) => {
        console.error('[dataset profile] one-shot profile generation failed:', profileError);
      });
      
    } catch (error) {
      console.error('[OneShotStep] Import error:', error);
      
      // ✅ C) catch also needs to write report
      const errorReport = {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        totalSheets: sheetPlans.filter(p => p.enabled).length,
        succeededSheets: 0,
        failedSheets: 0,
        skippedSheets: 0,
        needsReviewSheets: 0,
        error: error.message || 'Unknown error',
        stack: error.stack,
        sheetReports: []
      };
      
      setImportReport(errorReport);
      
      // ✅ A) State Machine: IMPORTING → RESULT (enter result page even on failure)
      console.log('[OneShotStep] IMPORTING -> RESULT (import failed)');
      setOneShotStep('RESULT');
      
      if (error.message === 'ABORTED') {
        setOneShotError('Import aborted by user');
        addNotification('Import aborted', 'info');
      } else {
        setOneShotError(error.message || 'Unknown error');
        addNotification(`One-shot import failed: ${error.message}`, 'error');
      }
    } finally {
      workflowActions.saveSuccess();
      setIsImporting(false);
      setAbortController(null);
      setOneShotProgress({ 
        stage: '', 
        current: 0, 
        total: 0, 
        sheetName: '', 
        uploadType: '',
        chunkIndex: 0,
        totalChunks: 0,
        savedSoFar: 0
      });
    }
  };
  
  /**
   * Abort One-shot Import
   */
  const handleAbortImport = () => {
    if (abortController) {
      abortController.abort();
      addNotification('Aborting import...', 'info');
    }
  };

  /**
   * Update Sheet Plan
   */
  const updateSheetPlan = (sheetId, updates) => {
    console.log('[DEBUG] updateSheetPlan:', { sheetId, updates });
    
    const hasMappingDraft = updates.hasOwnProperty('mappingDraft');
    sendAgentLog({location:'EnhancedExternalSystemsView.jsx:updateSheetPlan',message:'[updateSheetPlan] Called',data:{sheetId,updatesKeys:Object.keys(updates),hasMappingDraft,hasIsComplete:updates.hasOwnProperty('isComplete'),hasMissingRequired:updates.hasOwnProperty('missingRequired'),mappingDraftKeys:updates.mappingDraft?Object.keys(updates.mappingDraft):null},runId:'incomplete-debug',sessionId:'debug-session',hypothesisId:'H4'});
    
    setSheetPlans(prev => {
      const planBefore = prev.find(p => p.sheetId === sheetId);
      
      if(planBefore){sendAgentLog({location:'EnhancedExternalSystemsView.jsx:updateSheetPlan',message:'[updateSheetPlan] Plan before update',data:{sheetId,mappingBefore:planBefore.mapping,mappingDraftBefore:planBefore.mappingDraft,headersBefore:planBefore.headers},sessionId:'debug-session',hypothesisId:'C'});}
      
      const updated = prev.map(plan => 
        plan.sheetId === sheetId ? { ...plan, ...updates } : plan
      );
      
      const planAfter = updated.find(p => p.sheetId === sheetId);
      
      if(planAfter){sendAgentLog({location:'EnhancedExternalSystemsView.jsx:updateSheetPlan',message:'[updateSheetPlan] Plan after update',data:{sheetId,mappingAfter:planAfter.mapping,mappingDraftAfter:planAfter.mappingDraft,headersAfter:planAfter.headers,mappingKeysAfter:planAfter.mapping?Object.keys(planAfter.mapping):null,mappingDraftKeysAfter:planAfter.mappingDraft?Object.keys(planAfter.mappingDraft):null},sessionId:'debug-session',hypothesisId:'C'});}
      
      console.log('[DEBUG] After update:', updated.map(p => ({ 
        sheetId: p.sheetId, 
        name: p.sheetName, 
        type: p.uploadType, 
        enabled: p.enabled 
      })));
      
      return updated;
    });
  };

  // ✅ Two-step Gate: Step 1 → Step 2
  const handleNextToMappingReview = () => {
    const enabledSheets = sheetPlans.filter(p => p.enabled);
    
    if (enabledSheets.length === 0) {
      console.log('[OneShotStep] CLASSIFY -> REVIEW blocked: no enabled sheets');
      addNotification('Please enable at least one sheet', 'error');
      return;
    }
    
    // Check all enabled sheets have uploadType
    const missingType = enabledSheets.filter(p => !p.uploadType);
    if (missingType.length > 0) {
      console.log('[OneShotStep] CLASSIFY -> REVIEW blocked: missing uploadType for', missingType.length, 'sheets');
      addNotification(`${missingType.length} sheets have not selected an Upload Type`, 'error');
      return;
    }
    
    // ✅ A) State Machine: CLASSIFY → REVIEW
    console.log('[OneShotStep] CLASSIFY -> REVIEW (moving to mapping review)');
    setOneShotStep('REVIEW');
    setCurrentEditingSheetIndex(0); // Default to editing first enabled sheet
    
    // Set first enabled sheet as active
    if (enabledSheets.length > 0) {
      setActiveReviewSheetId(enabledSheets[0].sheetId);
      console.log('[OneShotStep] Active review sheet:', enabledSheets[0].sheetName);
    }
  };

  // ✅ Two-step Gate: Step 2 → Step 1 (Back)
  const handleBackToClassification = () => {
    // ✅ A) State Machine: REVIEW → CLASSIFY
    console.log('[OneShotStep] REVIEW -> CLASSIFY (back to classification)');
    setOneShotStep('CLASSIFY');
    setActiveReviewSheetId(null);
  };

  // ✅ Two-step Gate: manual mapping change (Step 2)
  const handleMappingChange = (sheetId, sourceHeader, targetField) => {
    sendAgentLog({location:'EnhancedExternalSystemsView.jsx:handleMappingChange',message:'[handleMappingChange] Entry',data:{sheetId,sourceHeader,targetField,sheetPlansCount:sheetPlans.length},runId:'manual-mapping',sessionId:'debug-session',hypothesisId:'A'});
    
    setSheetPlans(prev => prev.map(plan => {
      if (plan.sheetId !== sheetId) return plan;
      
      const oldMappingDraft = plan.mappingDraft || {};
      sendAgentLog({location:'EnhancedExternalSystemsView.jsx:handleMappingChange',message:'[handleMappingChange] Before update',data:{sheetId:plan.sheetId,sheetName:plan.sheetName,oldMappingDraft,oldMappingDraftKeys:Object.keys(oldMappingDraft),mappingConfirmed:plan.mappingConfirmed},runId:'manual-mapping',sessionId:'debug-session',hypothesisId:'B'});
      
      const newMapping = { ...(plan.mappingDraft || {}) };
      if (targetField) {
        newMapping[sourceHeader] = targetField;
      } else {
        delete newMapping[sourceHeader];
      }
      
      // Recalculate coverage
      const schema = UPLOAD_SCHEMAS[plan.uploadType];
      if (!schema) return plan;
      
      const status = getRequiredMappingStatus({
        uploadType: plan.uploadType,
        columns: plan.headers || [],
        columnMapping: newMapping
      });
      
      sendAgentLog({location:'EnhancedExternalSystemsView.jsx:handleMappingChange',message:'[handleMappingChange] After update',data:{sheetId:plan.sheetId,newMapping,newMappingKeys:Object.keys(newMapping),newCoverage:status.coverage,newIsComplete:status.isComplete},runId:'manual-mapping',sessionId:'debug-session',hypothesisId:'D'});
      
      return {
        ...plan,
        mappingDraft: newMapping,
        requiredCoverage: status.coverage,
        missingRequired: status.missingRequired,
        isComplete: status.isComplete
      };
    }));
  };

  // ✅ Two-step Gate: Confirm Mapping (Step 2 gate)
  const handleConfirmMapping = (sheetId) => {
    const plan = sheetPlans.find(p => p.sheetId === sheetId);
    
    if (!plan) return;
    
    const mappingDraft = plan.mappingDraft || {};
    const status = plan.uploadType && plan.headers ? getRequiredMappingStatus({ uploadType: plan.uploadType, columns: plan.headers, columnMapping: mappingDraft }) : null;
    const canConfirm = status ? status.isComplete : plan.isComplete;
    if (!canConfirm) {
      addNotification('Cannot confirm: required fields mapping is incomplete', 'error');
      return;
    }
    
    console.log('[Two-step Gate] Confirming mapping for:', plan.sheetName);
    
    setSheetPlans(prev => prev.map(p => 
      p.sheetId === sheetId 
        ? {
            ...p,
            mappingFinal: { ...(p.mappingDraft || {}) },  // ✅ Lock mapping
            mappingConfirmed: true,
            isComplete: true,
            missingRequired: [],
            requiredCoverage: status ? status.coverage : 1
          }
        : p
    ));
    
    addNotification(`Mapping confirmed for "${plan.sheetName}"`, 'success');
  };

  // ✅ Two-step Gate: Unlock Mapping (allow re-editing)
  const handleUnlockMapping = (sheetId) => {
    console.log('[Two-step Gate] Unlocking mapping for:', sheetId);
    
    setSheetPlans(prev => prev.map(p => 
      p.sheetId === sheetId 
        ? {
            ...p,
            mappingFinal: null,
            mappingConfirmed: false
          }
        : p
    ));
    
    addNotification('Mapping unlocked for editing', 'info');
  };

  // ✅ A) Disable/Remove single sheet from import (Step2)
  const handleDisableSheetFromImport = (sheetId) => {
    const plan = sheetPlans.find(p => p.sheetId === sheetId);
    if (!plan) return;
    
    console.log('[Two-step Gate] Disabling sheet from import:', plan.sheetName);
    
    setSheetPlans(prev => prev.map(p => 
      p.sheetId === sheetId 
        ? {
            ...p,
            enabled: false,           // ✅ Set to disabled
            mappingConfirmed: false   // ✅ Clear confirmed status
          }
        : p
    ));
    
    // If currently editing this sheet, switch to next enabled sheet
    const enabledSheets = sheetPlans.filter(p => p.enabled && p.sheetId !== sheetId);
    if (enabledSheets.length > 0) {
      setCurrentEditingSheetIndex(0);
      setActiveReviewSheetId(enabledSheets[0].sheetId);
      console.log('[Two-step Gate] Switched to next enabled sheet:', enabledSheets[0].sheetName);
    } else {
      setCurrentEditingSheetIndex(0);
      setActiveReviewSheetId(null);
      console.log('[Two-step Gate] No enabled sheets remaining');
    }
    
    addNotification(`"${plan.sheetName}" disabled from import`, 'info');
  };

  // ✅ Two-step Gate: AI Field Suggestion (only fills mappingDraft)
  const handleAiFieldSuggestion = async (sheetId) => {
    const plan = sheetPlans.find(p => p.sheetId === sheetId);
    if (!plan || !plan.uploadType) {
      addNotification('Please select an Upload Type first', 'error');
      return;
    }
    
    try {
      setAiSuggestLoading(prev => ({ ...prev, [sheetId]: true }));
      addNotification(`Generating field mapping suggestions for "${plan.sheetName}"...`, 'info');

      // Read data from workbook
      const sheet = workbook.Sheets[plan.sheetName];
      const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const headers = sheetData[0] || [];
      const sampleRows = sheetData.slice(1, 51).map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = row[i] || '';
        });
        return obj;
      });

      // ✅ B) Header Normalize: build header index
      const { buildHeaderIndex, logHeaderStats, alignAiMappings, logMappingAlignStats } = await import('../utils/headerNormalize');
      const headerIndexResult = buildHeaderIndex(headers);
      logHeaderStats(headers, headerIndexResult);

      const schema = UPLOAD_SCHEMAS[plan.uploadType];
      
      // Step 1: Rule-based mapping
      const ruleMappings = ruleBasedMapping(headers, plan.uploadType, schema.fields);
      let columnMapping = {};
      ruleMappings.forEach(m => {
        if (m.target && m.confidence >= 0.7) {
          columnMapping[m.source] = m.target;
        }
      });
      
      // Step 2: Check coverage
      const status = getRequiredMappingStatus({
        uploadType: plan.uploadType,
        columns: headers,
        columnMapping
      });
      
      // Step 3: Always call LLM for comprehensive mapping (including optional fields)
      const { suggestMappingWithLLM } = await import('../services/oneShotAiSuggestService');
      
      const llmResult = await suggestMappingWithLLM({
        uploadType: plan.uploadType,
        headers,
        sampleRows,
        schemaFields: schema.fields,
        requiredFields: schema.fields.filter(f => f.required).map(f => f.key),
        optionalFields: schema.fields.filter(f => !f.required).map(f => f.key)
      });
      
      // ✅ B) Header Normalize: align AI mappings
      const alignResult = alignAiMappings(llmResult.mappings, headerIndexResult.index);
      logMappingAlignStats(alignResult);
      
      // Merge: Add all aligned LLM mappings (required + optional)
      // Rule-based mappings are kept if not overridden by LLM
      alignResult.alignedMappings.forEach(m => {
        // Add all LLM suggestions (required + optional)
        // Only skip if already mapped to the same target
        const existingTarget = columnMapping[m.source];
        if (!existingTarget || existingTarget !== m.target) {
          columnMapping[m.source] = m.target;  // ✅ Use aligned source (originalHeader)
        }
      });
      
      // Final status check
      const finalStatus = getRequiredMappingStatus({
        uploadType: plan.uploadType,
        columns: headers,
        columnMapping
      });
      
      // ✅ C) Update mappingDraft only for the correct sheetId (use sheetId not index)
      console.log('[AI Field Suggestion] Updating mappingDraft for sheetId:', sheetId);
      setSheetPlans(prev => prev.map(p => 
        p.sheetId === sheetId 
          ? {
              ...p,
              headers,
              mappingDraft: columnMapping,
              requiredCoverage: finalStatus.coverage,
              missingRequired: finalStatus.missingRequired,
              isComplete: finalStatus.isComplete
            }
          : p
      ));
      
      addNotification(
        `AI mapping suggestion completed (${Math.round(finalStatus.coverage * 100)}% coverage)`,
        'success'
      );
    } catch (error) {
      console.error('[AI Field Suggestion] Error:', error);
      addNotification(`AI mapping suggestion failed: ${error.message}`, 'error');
    } finally {
      setAiSuggestLoading(prev => ({ ...prev, [sheetId]: false }));
    }
  };

  // Handle AI Suggest for a single sheet
  const handleAiSuggest = async (plan) => {
    const { sheetId, sheetName, uploadType: currentUploadType } = plan;
    
    console.log('[AI Suggest] Starting for:', { sheetId, sheetName, currentUploadType });
    
    try {
      setAiSuggestLoading(prev => ({ ...prev, [sheetId]: true }));
      addNotification(`Generating AI suggestions for "${sheetName}"...`, 'info');

      // Read data from workbook for this sheet
      const sheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      
      // Get headers (first row)
      const headers = sheetData[0] || [];
      
      // Get sample data (max 50 rows, skip header) - don't send all rows for large sheets
      const sampleRows = sheetData.slice(1, 51).map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = row[i] || '';
        });
        return obj;
      });

      console.log(`[AI Suggest] Sheet: ${sheetName}, Headers:`, headers, 'Sample rows:', sampleRows.length);

      // Check if chunk idempotency is supported (affects auto-enable for >1000 rows)
      const { checkIngestKeySupport } = await import('../services/sheetRunsService');
      const hasIngestKeySupport = await checkIngestKeySupport();

      // Call AI Suggest Service (new version has built-in error handling, won't throw)
      const result = await suggestSheetMapping({
        sheetName,
        headers,
        sampleRows,
        currentUploadType: currentUploadType || null,
        hasIngestKeySupport
      });

      console.log('[AI Suggest] Result:', { 
        sheetId,
        suggestedType: result.suggestedUploadType, 
        confidence: result.confidence,
        mappingConfidence: result.mappings?.reduce((sum, m) => sum + m.confidence, 0) / (result.mappings?.length || 1),
        requiredCoverage: result.requiredCoverage,
        autoEnable: result.autoEnable,
        error: result.error
      });

      // If there's an error, show error message but don't interrupt
      if (result.error) {
        console.warn('[AI Suggest] AI returned error result:', result.error);
        addNotification(`AI suggestion failed: ${result.error}`, 'warning');
        
        // Still update sheetPlan to show error reason
        updateSheetPlan(sheetId, {
          reasons: result.reasons,
          aiSuggested: true,
          confidence: 0
        });
        
        return;
      }

      sendAgentLog({location:'EnhancedExternalSystemsView.jsx:handleAiFieldSuggestion',message:'[BEFORE updateSheetPlan] AI Suggest result received',data:{sheetId,sheetName,resultMapping:result.mapping,resultMappingKeys:Object.keys(result.mapping||{}),planHeaders:plan.headers,planHeadersPreview:plan.headers.slice(0,5)},sessionId:'debug-session',hypothesisId:'C'});
      
      // ✅ Fix: write AI mapping to both mapping and mappingDraft
      // UI uses mappingDraft, so this field must be updated
      const updates = {
        uploadType: result.suggestedUploadType,
        confidence: result.confidence,
        reasons: result.reasons,
        mapping: result.mapping,           // ✅ Keep for backward compatibility
        mappingDraft: result.mapping,      // ✅ UI uses this field
        enabled: result.autoEnable,
        aiSuggested: true,
        requiredCoverage: result.requiredCoverage
      };
      // ✅ Sync isComplete / missingRequired to avoid Confirm staying disabled after mappingDraft update
      if (result.suggestedUploadType && plan.headers && result.mapping) {
        const status = getRequiredMappingStatus({
          uploadType: result.suggestedUploadType,
          columns: plan.headers,
          columnMapping: result.mapping
        });
        updates.isComplete = status.isComplete;
        updates.missingRequired = status.missingRequired;
      }
      
      sendAgentLog({location:'EnhancedExternalSystemsView.jsx:handleAiFieldSuggestion',message:'[updateSheetPlan] updates object created with mappingDraft',data:{sheetId,updatesMapping:updates.mapping,updatesMappingDraft:updates.mappingDraft,mappingKeys:Object.keys(updates.mapping||{}),mappingDraftKeys:Object.keys(updates.mappingDraft||{}),hasIsComplete:updates.hasOwnProperty('isComplete'),hasMissingRequired:updates.hasOwnProperty('missingRequired')},runId:'post-fix',sessionId:'debug-session',hypothesisId:'C'});

      // Large file >1000 rows: show warning only, don't default to disabled (let user decide)
      if (plan.rowCount > 1000 && !hasIngestKeySupport) {
        updates.reasons = [
          ...(updates.reasons || []),
          '⚠ Sheet has >1000 rows; chunk-idempotency may not be deployed. You can still enable and import after reviewing.'
        ];
      }

      // If requiredCoverage < 1.0, don't auto-enable (avoid incorrect import)
      if (result.requiredCoverage < 1.0) {
        updates.enabled = false;
        if (!updates.reasons.includes('Required fields coverage < 100%')) {
          updates.reasons = [...updates.reasons, '⚠ Required fields coverage < 100%, please review mapping'];
        }
      }

      console.log('[AI Suggest] Updating sheetPlan:', { sheetId, updates });
      updateSheetPlan(sheetId, updates);
      
      console.log('[AI Suggest] SheetPlans after update:', sheetPlans.map(p => ({ 
        sheetId: p.sheetId, 
        name: p.sheetName, 
        type: p.uploadType, 
        enabled: p.enabled 
      })));

      addNotification(
        `AI suggestion complete: ${result.suggestedUploadType || 'N/A'} (confidence: ${Math.round(result.confidence * 100)}%)`,
        result.suggestedUploadType ? 'success' : 'warning'
      );

    } catch (error) {
      console.error('[AI Suggest] Unexpected error:', error);
      addNotification(`AI suggestion failed: ${error.message}`, 'error');
      
      // Update sheetPlan to show error
      updateSheetPlan(sheetId, {
        reasons: [`Execution error: ${error.message}`],
        aiSuggested: true,
        confidence: 0
      });
    } finally {
      setAiSuggestLoading(prev => ({ ...prev, [sheetId]: false }));
    }
  };

  // Handle AI Suggest All (batch execution)
  const handleAiSuggestAll = async () => {
    console.log('[AI Suggest All] Starting...');
    
    // Filter sheets that need AI
    const needsAiSheets = sheetPlans.filter(plan => {
      // Already Ready with high confidence
      const isAlreadyReady = plan.enabled && 
                             plan.confidence >= 0.85 && 
                             plan.requiredCoverage >= 1.0 &&
                             plan.uploadType;
      
      // If "Include already-ready" is checked, execute all
      if (includeAlreadyReady) {
        return true;
      }
      
      // Otherwise only execute for sheets that need AI
      return !isAlreadyReady;
    });

    if (needsAiSheets.length === 0) {
      addNotification('No sheets need AI suggestions', 'info');
      return;
    }

    console.log(`[AI Suggest All] Found ${needsAiSheets.length} sheets needing AI suggestion`);
    
    // Create AbortController
    const controller = new AbortController();
    setAiSuggestAllAbortController(controller);
    setAiSuggestAllRunning(true);
    setAiSuggestAllProgress({ completed: 0, total: needsAiSheets.length });

    try {
      // Set all target sheets to loading
      const loadingState = {};
      needsAiSheets.forEach(plan => {
        loadingState[plan.sheetId] = true;
      });
      setAiSuggestLoading(prev => ({ ...prev, ...loadingState }));

      addNotification(`Starting batch AI suggestions: ${needsAiSheets.length} sheets`, 'info');

      // Create tasks (each task returns a Promise)
      const tasks = needsAiSheets.map(plan => async () => {
        console.log(`[AI Suggest All] Processing: ${plan.sheetName}`);
        
        // Check abort signal
        if (controller.signal.aborted) {
          throw new Error('Aborted');
        }

        // Read data from workbook for this sheet
        const sheet = workbook.Sheets[plan.sheetName];
        const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
        
        const headers = sheetData[0] || [];
        
        // Large sheet: only send sample (first 50 rows)
        const sampleRows = sheetData.slice(1, 51).map(row => {
          const obj = {};
          headers.forEach((h, i) => {
            obj[h] = row[i] || '';
          });
          return obj;
        });

        // Check ingest key support
        const { checkIngestKeySupport } = await import('../services/sheetRunsService');
        const hasIngestKeySupport = await checkIngestKeySupport();

        // Call AI Suggest Service
        const result = await suggestSheetMapping({
          sheetName: plan.sheetName,
          headers,
          sampleRows,
          currentUploadType: plan.uploadType || null,
          hasIngestKeySupport
        });

        return { sheetId: plan.sheetId, sheetName: plan.sheetName, result, plan };
      });

      // Execute with concurrency control (concurrency = 2)
      const results = await runWithConcurrencyAbortable(
        tasks,
        controller.signal,
        2, // concurrency limit
        (completed, total) => {
          console.log(`[AI Suggest All] Progress: ${completed}/${total}`);
          setAiSuggestAllProgress({ completed, total });
        }
      );

      console.log('[AI Suggest All] All tasks completed:', results.length);

      // Process results: update sheetPlan one by one
      let successCount = 0;
      let failCount = 0;

      results.forEach(settled => {
        if (settled.status === 'fulfilled') {
          const { sheetId, sheetName, result, plan } = settled.value;
          
          console.log(`[AI Suggest All] Success for ${sheetName}:`, result);

          if (result.error) {
            failCount++;
            // Has error but don't throw, show error
            updateSheetPlan(sheetId, {
              reasons: result.reasons,
              aiSuggested: true,
              confidence: 0
            });
          } else {
            successCount++;
            
            // Success: update sheetPlan
            // ✅ Fix: write AI mapping to both mapping and mappingDraft
            const updates = {
              uploadType: result.suggestedUploadType,
              confidence: result.confidence,
              reasons: result.reasons,
              mapping: result.mapping,           // ✅ Keep for backward compatibility
              mappingDraft: result.mapping,      // ✅ UI uses this field
              enabled: result.autoEnable,
              aiSuggested: true,
              requiredCoverage: result.requiredCoverage
            };
            // ✅ Sync isComplete / missingRequired (consistent with single AI Suggest)
            if (result.suggestedUploadType && plan.headers && result.mapping) {
              const status = getRequiredMappingStatus({
                uploadType: result.suggestedUploadType,
                columns: plan.headers,
                columnMapping: result.mapping
              });
              updates.isComplete = status.isComplete;
              updates.missingRequired = status.missingRequired;
            }

            // Large file >1000 rows: warning only, don't default to disabled
            if (plan.rowCount > 1000 && !result.hasIngestKeySupport) {
              updates.reasons = [
                ...(updates.reasons || result.reasons || []),
                '⚠ Sheet has >1000 rows; you can still enable after reviewing.'
              ];
            }

            // If requiredCoverage < 1.0, don't auto-enable
            if (result.requiredCoverage < 1.0) {
              updates.enabled = false;
              if (!updates.reasons.some(r => r.includes('coverage'))) {
                updates.reasons = [...updates.reasons, '⚠ Required fields coverage < 100%'];
              }
            }

            updateSheetPlan(sheetId, updates);
          }
        } else {
          failCount++;
          console.error('[AI Suggest All] Task rejected:', settled.reason);
        }
      });

      // Clear all loading states
      const clearedLoading = {};
      needsAiSheets.forEach(plan => {
        clearedLoading[plan.sheetId] = false;
      });
      setAiSuggestLoading(prev => ({ ...prev, ...clearedLoading }));

      addNotification(
        `Batch AI suggestions complete: ${successCount} succeeded, ${failCount} failed`,
        successCount > 0 ? 'success' : 'warning'
      );

    } catch (error) {
      if (error.message === 'Aborted') {
        console.log('[AI Suggest All] Aborted by user');
        addNotification('Batch AI suggestions cancelled', 'info');
      } else {
        console.error('[AI Suggest All] Unexpected error:', error);
        addNotification(`Batch AI suggestions failed: ${error.message}`, 'error');
      }
      
      // Clear all loading states
      const clearedLoading2 = {};
      needsAiSheets.forEach(plan => {
        clearedLoading2[plan.sheetId] = false;
      });
      setAiSuggestLoading(prev => ({ ...prev, ...clearedLoading2 }));
    } finally {
      setAiSuggestAllRunning(false);
      setAiSuggestAllAbortController(null);
      setAiSuggestAllProgress({ completed: 0, total: 0 });
    }
  };

  // Cancel AI Suggest All
  const handleCancelAiSuggestAll = () => {
    if (aiSuggestAllAbortController) {
      console.log('[AI Suggest All] Cancelling...');
      aiSuggestAllAbortController.abort();
    }
  };

  // Reset workflow
  const resetFlow = () => {
    console.log('[OneShotStep] Resetting to IDLE');
    workflowActions.reset();
    setWorkbook(null);
    setSheetNames([]);
    setSelectedSheet('');
    setOneShotEnabled(false);
    setOneShotStep('IDLE');  // ✅ Reset to IDLE
    setCurrentEditingSheetIndex(0);
    setActiveReviewSheetId(null);
    setSheetPlans([]);
    setImportReport(null);
    setOneShotResult(null);
    setOneShotError('');
    setIsImporting(false);
  };

  // Go back to previous step
  const goBack = () => {
    workflowActions.goBack();
  };

  // ========== Render Section ==========

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-500" />
            Data Upload - {uploadType ? UPLOAD_SCHEMAS[uploadType]?.label : 'Select Type'}
          </h2>
          {fileName && (
            <p className="text-sm text-slate-500 mt-1">File: {fileName}</p>
          )}
        </div>

        {currentStep > 1 && (
          <Button onClick={resetFlow} variant="secondary" icon={X}>
            Cancel
          </Button>
        )}
      </div>

      {/* CTA: Go to Forecasts after uploading demand_fg or bom_edge */}
      {(uploadType === 'demand_fg' || uploadType === 'bom_edge') && currentStep === 1 && (
        <Card className="bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800">
          <div className="flex items-start gap-4">
            <TrendingUp className="w-6 h-6 text-purple-600 flex-shrink-0 mt-1" />
            <div className="flex-1">
              <h3 className="font-semibold text-purple-900 dark:text-purple-100 mb-2">
                📊 Ready to run BOM Explosion?
              </h3>
              <p className="text-sm text-purple-800 dark:text-purple-200 mb-3">
                After uploading demand_fg and bom_edge data, go to the <strong>Forecasts</strong> page to run BOM Explosion
                and generate component demand forecasts.
              </p>
              <Button
                onClick={() => setView && setView('forecasts')}
                variant="primary"
                size="sm"
                icon={TrendingUp}
              >
                Go to Forecasts →
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Progress Steps */}
      {currentStep > 1 && (
        <div className="flex items-center justify-between mb-6">
          {['Select Type', 'Upload File', 'Field Mapping', 'Data Validation', 'Save'].map((step, index) => (
            <div key={step} className="flex items-center">
              <div className={`flex items-center justify-center w-8 h-8 rounded-full ${
                index + 1 < currentStep ? 'bg-green-500 text-white' :
                index + 1 === currentStep ? 'bg-blue-500 text-white' :
                'bg-slate-300 text-slate-600'
              }`}>
                {index + 1 < currentStep ? <Check className="w-5 h-5" /> : index + 1}
              </div>
              {index < 4 && (
                <div className={`w-12 md:w-24 h-1 mx-2 ${
                  index + 1 < currentStep ? 'bg-green-500' : 'bg-slate-300'
                }`} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Step 1 & 2: Select upload type + Upload file (combined into single screen) */}
      {(currentStep === 1 || currentStep === 2) && (
        <Card>
          <div className="space-y-6">
            {/* One-shot Import Toggle */}
            <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={oneShotEnabled}
                  onChange={(e) => {
                    setOneShotEnabled(e.target.checked);
                    if (e.target.checked) {
                      workflowActions.setUploadType(null); // One-shot doesn't need pre-selected type
                      addNotification('One-shot mode enabled: Upload Excel with multiple sheets for auto-classification', 'info');
                    }
                  }}
                  className="w-5 h-5 rounded"
                  disabled={loading || saving}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Layers className="w-5 h-5 text-purple-600" />
                    <span className="font-semibold text-purple-900 dark:text-purple-100">
                      One-shot Import (Auto-import multiple sheets)
                    </span>
                  </div>
                  <p className="text-xs text-purple-700 dark:text-purple-300 mt-1">
                    Upload Excel file (multiple sheets), system auto-detects each sheet's data type, one-click import all sheets
                  </p>
                </div>
              </label>
              
              {/* One-shot Settings (only shown when One-shot enabled) */}
              {oneShotEnabled && (
                <div className="pl-8 pt-2 border-t border-purple-200 dark:border-purple-700 space-y-4">
                  {/* Import Mode */}
                  <div>
                    <label className="block text-sm font-medium text-purple-900 dark:text-purple-100 mb-2">
                      Import Mode
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="oneShotMode"
                          value="best-effort"
                          checked={oneShotMode === 'best-effort'}
                          onChange={(e) => setOneShotMode(e.target.value)}
                          disabled={loading}
                          className="w-4 h-4 text-purple-600 focus:ring-2 focus:ring-purple-500"
                        />
                        <span className="text-sm text-purple-900 dark:text-purple-100">
                          <strong>Best-effort (Recommended)</strong> - Sheet-level isolation, successful sheets will be saved
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="oneShotMode"
                          value="all-or-nothing"
                          checked={oneShotMode === 'all-or-nothing'}
                          onChange={(e) => setOneShotMode(e.target.value)}
                          disabled={loading}
                          className="w-4 h-4 text-purple-600 focus:ring-2 focus:ring-purple-500"
                        />
                        <span className="text-sm text-purple-900 dark:text-purple-100">
                          <strong>All-or-nothing</strong> - Rollback all sheets if any sheet fails
                        </span>
                      </label>
                    </div>
                    <p className="text-xs text-purple-600 dark:text-purple-400 mt-1.5">
                      {oneShotMode === 'all-or-nothing' 
                        ? '⚠ If any sheet fails, all succeeded sheets will be rolled back (requires DB chunk-idempotency deployed)'
                        : '✓ Each sheet is imported independently, failed sheets do not affect other succeeded sheets'}
                    </p>
                  </div>
                  
                  {/* Chunk Size */}
                  <div>
                    <label className="block text-sm font-medium text-purple-900 dark:text-purple-100 mb-2">
                      Chunk Size (rows per batch)
                    </label>
                    <select
                      value={chunkSize}
                      onChange={(e) => setChunkSize(Number(e.target.value))}
                      disabled={loading}
                      className="w-full max-w-xs px-3 py-2 rounded-md border border-purple-300 dark:border-purple-600 bg-white dark:bg-slate-800 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                    >
                      <option value={200}>200 (Safest for RPC)</option>
                      <option value={500}>500 (Recommended)</option>
                      <option value={800}>800 (Faster, near RPC limit)</option>
                      <option value={1000}>1000 (Maximum)</option>
                    </select>
                    <p className="text-xs text-purple-600 dark:text-purple-400 mt-1.5">
                      {chunkSize >= 800 
                        ? '⚠ Large chunk size may fail for goods_receipt/price_history (RPC 1000 limit)'
                        : '✓ Safe chunk size for all upload types'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Upload Type Selection (only shown in non-One-shot mode) */}
            {!oneShotEnabled && (
              <div className="space-y-3">
                <label className="block text-sm font-semibold">
                  <span className="text-red-500">*</span> Select Upload Type
                </label>
                <select
                  value={uploadType ?? ""}
                  onChange={(e) => {
                    workflowActions.setUploadType(e.target.value);
                  }}
                  className="w-full px-4 py-3 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none text-base"
                  disabled={loading || saving}
                >
                  <option value="">-- Please select data type --</option>
                  {Object.entries(UPLOAD_SCHEMAS).map(([key, config]) => (
                    <option key={key} value={key}>
                      {config.icon} {config.label}
                    </option>
                  ))}
                </select>

                {/* Type Description */}
                {uploadType && UPLOAD_SCHEMAS[uploadType] && (
                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                    <div className="flex items-start gap-3">
                      <div className="text-3xl">{UPLOAD_SCHEMAS[uploadType].icon}</div>
                      <div className="flex-1">
                        <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-1">
                          {UPLOAD_SCHEMAS[uploadType].label}
                        </h4>
                        <p className="text-sm text-blue-800 dark:text-blue-200 mb-2">
                          {UPLOAD_SCHEMAS[uploadType].description}
                        </p>
                        <div className="text-xs text-blue-700 dark:text-blue-300">
                          <p className="font-medium mb-1">Required Fields:</p>
                          <div className="flex flex-wrap gap-2">
                            {UPLOAD_SCHEMAS[uploadType].fields
                              .filter(f => f.required)
                              .map(field => (
                                <span key={field.key} className="px-2 py-1 bg-blue-100 dark:bg-blue-800 rounded">
                                  {field.label}
                                </span>
                              ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* File Upload Area */}
            <div className="space-y-4">
              <h3 className="font-semibold flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5" />
                Upload Excel or CSV File
              </h3>

              <div className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                uploadType 
                  ? 'border-blue-300 dark:border-blue-600 bg-blue-50/30 dark:bg-blue-900/10' 
                  : 'border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50'
              }`}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx, .xls, .csv"
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                />
                <Upload className={`w-12 h-12 mx-auto mb-4 ${uploadType ? 'text-blue-500' : 'text-slate-400'}`} />
                
                <Button 
                  onClick={() => {
                    if (!oneShotEnabled && !uploadType) {
                      addNotification("Please select upload type first", "error");
                      return;
                    }
                    fileInputRef.current?.click();
                  }} 
                  disabled={loading || (!oneShotEnabled && !uploadType)}
                  variant={(uploadType || oneShotEnabled) ? "primary" : "secondary"}
                >
                  {loading ? 'Loading...' : (uploadType || oneShotEnabled) ? 'Select File to Upload' : 'Please select upload type first'}
                </Button>
                
                <p className="text-sm text-slate-500 mt-2">
                  Supports .xlsx, .xls, .csv formats, max 10MB
                </p>
                
                {!oneShotEnabled && !uploadType && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-3 flex items-center justify-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Please select data type above first
                  </p>
                )}
                
                {oneShotEnabled && (
                  <p className="text-sm text-purple-600 dark:text-purple-400 mt-3 flex items-center justify-center gap-2">
                    <Layers className="w-4 h-4" />
                    One-shot mode: Upload Excel with multiple sheets
                  </p>
                )}
              </div>

              {uploadProgress > 0 && uploadProgress < 100 && (
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Upload Progress</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Step 3 (One-shot variant): Sheet Classification - Step 1 */}
      {currentStep === 3 && oneShotEnabled && oneShotStep === 'CLASSIFY' && sheetPlans.length > 0 && (
        <Card>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold flex items-center gap-2 text-lg">
                  <Layers className="w-6 h-6 text-purple-600" />
                  Step 1: Sheet Classification
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  Select each sheet's data type. Mapping will be confirmed in the next step.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={resetFlow} variant="secondary" icon={X} size="sm">
                  Cancel
                </Button>
              </div>
            </div>

            {/* AI Suggest All Controls */}
            <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Button
                    onClick={handleAiSuggestAll}
                    disabled={aiSuggestAllRunning || saving || sheetPlans.length === 0}
                    variant="primary"
                    icon={Sparkles}
                    size="sm"
                  >
                    {aiSuggestAllRunning ? 'AI Analyzing...' : 'AI Suggest All'}
                  </Button>
                  
                  {aiSuggestAllRunning && (
                    <Button
                      onClick={handleCancelAiSuggestAll}
                      variant="secondary"
                      icon={X}
                      size="sm"
                    >
                      Cancel
                    </Button>
                  )}

                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeAlreadyReady}
                      onChange={(e) => setIncludeAlreadyReady(e.target.checked)}
                      disabled={aiSuggestAllRunning}
                      className="w-4 h-4 rounded"
                    />
                    <span>Include already-ready sheets</span>
                  </label>
                </div>

                {aiSuggestAllRunning && (
                  <div className="text-sm text-purple-700 dark:text-purple-300 font-medium">
                    Progress: {aiSuggestAllProgress.completed} / {aiSuggestAllProgress.total}
                  </div>
                )}
              </div>

              {aiSuggestAllRunning && (
                <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-purple-600 h-2 rounded-full transition-all"
                    style={{ 
                      width: `${aiSuggestAllProgress.total > 0 
                        ? (aiSuggestAllProgress.completed / aiSuggestAllProgress.total * 100) 
                        : 0}%` 
                    }}
                  />
                </div>
              )}

              <p className="text-xs text-purple-800 dark:text-purple-200">
                <Sparkles className="w-3 h-3 inline mr-1" />
                Batch AI suggestions will automatically suggest Upload Type and field mapping for low-confidence or unclassified sheets.
                {includeAlreadyReady && ' (currently includes all sheets)'}
              </p>
            </div>

            {/* Sheet Plans Table */}
            <div className="border dark:border-slate-700 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-100 dark:bg-slate-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold w-16">Enable</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">Sheet Name</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">Upload Type</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold w-24">Confidence</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">Status</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold w-32">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {sheetPlans.map((plan) => (
                    <tr key={plan.sheetId} className={`${plan.enabled ? 'bg-white dark:bg-slate-900' : 'bg-slate-50 dark:bg-slate-800/50'}`}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={plan.enabled}
                          onChange={(e) => updateSheetPlan(plan.sheetId, { enabled: e.target.checked })}
                          disabled={plan.disabledReason || !plan.uploadType || !UPLOAD_SCHEMAS[plan.uploadType]}
                          className="w-5 h-5 rounded"
                          title={
                            plan.disabledReason ? plan.disabledReason :
                            !plan.uploadType ? 'Please select Upload Type first' :
                            !UPLOAD_SCHEMAS[plan.uploadType] ? 'Schema not found for this upload type' :
                            ''
                          }
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{plan.sheetName}</span>
                          {plan.aiSuggested && (
                            <span className="text-xs text-purple-600 dark:text-purple-400 flex items-center gap-1">
                              <Sparkles className="w-3 h-3" />
                              AI Suggested
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={plan.uploadType || ''}
                          onChange={(e) => updateSheetPlan(plan.sheetId, { uploadType: e.target.value })}
                          className="w-full px-3 py-1.5 rounded border dark:bg-slate-800 dark:border-slate-600 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                        >
                          <option value="">-- Select Type --</option>
                          <option value="bom_edge">🔗 BOM Edge</option>
                          <option value="demand_fg">📊 Demand FG</option>
                          <option value="po_open_lines">📋 PO Open Lines</option>
                          <option value="inventory_snapshots">📦 Inventory Snapshots</option>
                          <option value="fg_financials">💵 FG Financials</option>
                          <option value="supplier_master">🏢 Supplier Master</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          {/* ✅ C) Type Confidence */}
                          <div className="text-xs text-slate-600 dark:text-slate-400">
                            Type: {plan.confidence > 0 ? (
                              <span className={`px-1.5 py-0.5 rounded font-semibold ${
                                plan.confidence >= 0.75 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                                'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                              }`}>
                                {Math.round(plan.confidence * 100)}%
                              </span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </div>
                          {/* ✅ C) Required Coverage */}
                          <div className="text-xs text-slate-600 dark:text-slate-400">
                            Coverage: {plan.requiredCoverage !== undefined ? (
                              <span className={`px-1.5 py-0.5 rounded font-semibold ${
                                plan.requiredCoverage >= 1.0 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                                plan.requiredCoverage >= 0.5 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
                                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                              }`}>
                                {Math.round(plan.requiredCoverage * 100)}%
                              </span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {plan.disabledReason ? (
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                            <span className="text-xs text-amber-600 dark:text-amber-400">{plan.disabledReason}</span>
                          </div>
                        ) : plan.warningMessage ? (
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-yellow-600" />
                            <span className="text-xs text-yellow-600 dark:text-yellow-400">{plan.warningMessage}</span>
                          </div>
                        ) : !plan.uploadType ? (
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                            <span className="text-xs text-amber-600 dark:text-amber-400">Please select type</span>
                          </div>
                        ) : plan.isComplete ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <Check className="w-4 h-4 text-green-600" />
                              <span className="text-xs text-green-600 dark:text-green-400">
                                Ready (coverage: {Math.round(plan.requiredCoverage * 100)}%)
                              </span>
                            </div>
                            <div className="text-xs text-slate-500 ml-6">
                              Type confidence: {Math.round(plan.confidence * 100)}%
                            </div>
                            {plan.reasons && plan.reasons.length > 0 && (
                              <div className="text-xs text-slate-500 ml-6 mt-1">
                                {plan.reasons.slice(0, 2).map((reason, i) => (
                                  <div key={i} className="truncate" title={reason}>
                                    {reason}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-orange-600" />
                              <span className="text-xs text-orange-600 dark:text-orange-400">
                                Needs Review (coverage: {Math.round((plan.requiredCoverage || 0) * 100)}%)
                              </span>
                            </div>
                            {plan.missingRequired && plan.missingRequired.length > 0 && (
                              <span className="text-xs text-red-600 dark:text-red-400 ml-6">
                                Missing: {plan.missingRequired.join(', ')}
                              </span>
                            )}
                            <div className="text-xs text-slate-500 ml-6">
                              Type confidence: {Math.round(plan.confidence * 100)}%
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleAiSuggest(plan)}
                          disabled={aiSuggestLoading[plan.sheetId] || saving}
                          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-100 rounded-md hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {aiSuggestLoading[plan.sheetId] ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>AI Analyzing...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>AI Suggest</span>
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Import Summary */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-blue-600">{sheetPlans.length}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Total Sheets</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-600">{sheetPlans.filter(p => p.enabled).length}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Enabled</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-slate-600">{sheetPlans.filter(p => !p.enabled).length}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Disabled</div>
                </div>
              </div>
            </div>

            {/* Next Button (Step 1 → Step 2) */}
            <div className="flex justify-between items-center pt-4 border-t dark:border-slate-700">
              <Button onClick={resetFlow} variant="secondary" icon={ArrowLeft}>
                Back
              </Button>
              <Button
                onClick={handleNextToMappingReview}
                disabled={sheetPlans.filter(p => p.enabled).length === 0}
                variant="primary"
                icon={ArrowRight}
              >
                Next: Review Mapping ({sheetPlans.filter(p => p.enabled).length} Sheets)
              </Button>
            </div>

            {/* Progress Bar - Global progress + Chunk progress */}
            {saving && oneShotProgress.stage && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg space-y-4">
                <div className="flex items-start gap-3">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                      {oneShotProgress.stage === 'processing' && `Processing sheets... (${oneShotProgress.current} / ${oneShotProgress.total})`}
                      {oneShotProgress.stage === 'ingesting' && `Ingesting chunks...`}
                    </h4>
                    
                    {/* Current sheet name */}
                    {oneShotProgress.sheetName && (
                      <p className="text-sm text-blue-700 dark:text-blue-300 mb-2">
                        Currently: <strong>{oneShotProgress.sheetName}</strong>
                        {oneShotProgress.uploadType && ` (${oneShotProgress.uploadType})`}
                      </p>
                    )}
                    
                    {/* Global progress: which sheet */}
                    {oneShotProgress.total > 0 && (
                      <div>
                        <div className="flex justify-between text-xs text-blue-700 dark:text-blue-300 mb-1">
                          <span>Sheet {oneShotProgress.current} / {oneShotProgress.total}</span>
                          <span>{Math.round((oneShotProgress.current / oneShotProgress.total) * 100)}%</span>
                        </div>
                        <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2">
                          <div
                            className="bg-blue-600 dark:bg-blue-400 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${(oneShotProgress.current / oneShotProgress.total) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                    
                    {/* Chunk progress */}
                    {oneShotProgress.stage === 'ingesting' && oneShotProgress.totalChunks > 0 && (
                      <div className="mt-3">
                        <div className="flex justify-between text-xs text-blue-700 dark:text-blue-300 mb-1">
                          <span>Chunk {oneShotProgress.chunkIndex} / {oneShotProgress.totalChunks}</span>
                          <span>{oneShotProgress.savedSoFar} rows saved</span>
                        </div>
                        <div className="w-full bg-blue-100 dark:bg-blue-900 rounded-full h-1.5">
                          <div
                            className="bg-blue-500 dark:bg-blue-300 h-1.5 rounded-full transition-all duration-200"
                            style={{ width: `${(oneShotProgress.chunkIndex / oneShotProgress.totalChunks) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                    
                    {/* Abort button */}
                    <div className="mt-3">
                      <button
                        onClick={handleAbortImport}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-red-100 rounded-md hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
                      >
                        <X className="w-4 h-4" />
                        Abort Import
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Result Summary */}
            {oneShotResult && (
              <div className={`p-4 border rounded-lg ${
                oneShotResult.needsReviewSheets > 0
                  ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
                  : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              }`}>
                <div className="flex justify-between items-start mb-3">
                  <h4 className={`font-semibold flex items-center gap-2 ${
                    oneShotResult.needsReviewSheets > 0
                      ? 'text-amber-900 dark:text-amber-100'
                      : 'text-green-900 dark:text-green-100'
                  }`}>
                    {oneShotResult.needsReviewSheets > 0 ? (
                      <>
                        <AlertTriangle className="w-5 h-5" />
                        Import Requires Review
                      </>
                    ) : (
                      <>
                        <Check className="w-5 h-5" />
                        Import Completed
                      </>
                    )}
                  </h4>
                  <button
                    onClick={() => {
                      const json = JSON.stringify(oneShotResult, null, 2);
                      const blob = new Blob([json], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `oneshot-import-report-${new Date().toISOString().slice(0,10)}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                      addNotification('Report downloaded', 'success');
                    }}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-100 rounded-md hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download Report (JSON)
                  </button>
                </div>
                
                <div className="grid grid-cols-5 gap-4 mb-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">{oneShotResult.totalSheets}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">Total</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">{oneShotResult.succeededSheets || oneShotResult.importedSheets || 0}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">Succeeded</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-600">{oneShotResult.needsReviewSheets || 0}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">Needs Review</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-amber-600">{oneShotResult.skippedSheets || 0}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">Skipped</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-600">{oneShotResult.failedSheets || 0}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">Failed</div>
                  </div>
                </div>
                
                {/* Rollback warning (All-or-nothing mode) */}
                {oneShotResult.rolledBack && (
                  <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
                    <div className="flex items-center gap-2 font-semibold mb-1">
                      <AlertTriangle className="w-4 h-4" />
                      All-or-nothing Mode: Rollback Triggered
                    </div>
                    <p className="text-xs">
                      Due to some sheet failures, all succeeded sheets have been rolled back. No data will be retained in the database.
                    </p>
                  </div>
                )}
                
                {/* Idempotency support warning */}
                {!oneShotResult.hasIngestKeySupport && (
                  <div className="mb-3 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-300">
                    ⚠ DB has not deployed chunk-idempotency (please run <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 py-0.5 rounded">database/one_shot_chunk_idempotency.sql</code>)
                  </div>
                )}
                
                {/* Mode indicator */}
                {oneShotResult.mode && (
                  <div className="mb-3 p-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-xs text-slate-700 dark:text-slate-300">
                    Import Mode: <strong>{oneShotResult.mode === 'all-or-nothing' ? 'All-or-nothing' : 'Best-effort'}</strong>
                  </div>
                )}

                {/* Detailed Results */}
                <div className="space-y-2">
                  {(oneShotResult.sheetReports || oneShotResult.sheetResults || []).map((result, idx) => (
                    <div key={idx} className={`p-3 rounded border text-sm ${
                      result.status === 'IMPORTED' ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' :
                      result.status === 'NEEDS_REVIEW' ? 'bg-orange-50 border-orange-200 dark:bg-orange-900/20 dark:border-orange-800' :
                      result.status === 'SKIPPED' ? 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800' :
                      'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {result.status === 'IMPORTED' && <Check className="w-4 h-4 text-green-600" />}
                          {result.status === 'NEEDS_REVIEW' && <AlertTriangle className="w-4 h-4 text-orange-600" />}
                          {result.status === 'SKIPPED' && <AlertTriangle className="w-4 h-4 text-amber-600" />}
                          {result.status === 'FAILED' && <X className="w-4 h-4 text-red-600" />}
                          <span className="font-semibold">{result.sheetName}</span>
                          <span className="text-xs text-slate-500">({result.uploadType || 'N/A'})</span>
                        </div>
                        {result.status === 'IMPORTED' && (
                          <span className="text-xs text-green-700 dark:text-green-300">
                            ✓ {result.savedCount} rows saved
                          </span>
                        )}
                      </div>
                      {result.reason && (
                        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 ml-6">{result.reason}</p>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex gap-3">
                  <Button onClick={resetFlow} variant="secondary" icon={RefreshCw} size="sm">
                    Upload Another File
                  </Button>
                  <Button 
                    onClick={() => {
                      const json = JSON.stringify(oneShotResult, null, 2);
                      const blob = new Blob([json], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `oneshot-result-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    variant="secondary"
                    icon={Download}
                    size="sm"
                  >
                    Download Report (JSON)
                  </Button>
                </div>
              </div>
            )}

            {/* Error Display */}
            {oneShotError && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">One-shot Import Failed</h4>
                    <p className="text-sm text-red-800 dark:text-red-200">{oneShotError}</p>
                    <p className="text-xs text-red-700 dark:text-red-300 mt-2">
                      Please use single-sheet import mode instead.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 3 (One-shot variant): Mapping Review - Step 2 */}
      {/* Step 3 (One-shot variant): Mapping Review - Step 2 */}
      {currentStep === 3 && oneShotEnabled && oneShotStep === 'REVIEW' && sheetPlans.length > 0 && (
        <Card>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold flex items-center gap-2 text-lg">
                  <Layers className="w-6 h-6 text-purple-600" />
                  Step 2: Mapping Review
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  Confirm field mapping for each sheet. All enabled sheets must be confirmed before import.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={resetFlow} variant="secondary" icon={X} size="sm">
                  Cancel
                </Button>
              </div>
            </div>

            {/* Two-column layout: Sheet list + Mapping panel */}
            <div className="grid grid-cols-4 gap-4">
              {/* Left: Sheet List */}
              <div className="col-span-1 space-y-2">
                <h4 className="font-semibold text-sm text-slate-700 dark:text-slate-300 mb-3">
                  Enabled Sheets ({sheetPlans.filter(p => p.enabled).length})
                </h4>
                {sheetPlans.filter(p => p.enabled).length === 0 && (
                  <div className="text-center text-slate-500 text-sm py-8">
                    <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-amber-500" />
                    No enabled sheets to import
                  </div>
                )}
                {sheetPlans.filter(p => p.enabled).map((plan, idx) => (
                  <div
                    key={plan.sheetId}
                    className={`p-3 rounded-lg border transition-all ${
                      currentEditingSheetIndex === idx
                        ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-300 dark:border-purple-700'
                        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <div 
                      onClick={() => {
                        setCurrentEditingSheetIndex(idx);
                        setActiveReviewSheetId(plan.sheetId);
                      }}
                      className="cursor-pointer"
                    >
                      <div className="font-medium text-sm mb-1">{plan.sheetName}</div>
                      <div className="text-xs text-slate-500 mb-1">{plan.uploadType}</div>
                      {plan.mappingConfirmed ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-semibold">
                          <Check className="w-3 h-3" /> Confirmed
                        </span>
                      ) : plan.isComplete ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">
                          Ready ({Math.round(plan.requiredCoverage * 100)}%)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">
                          <AlertTriangle className="w-3 h-3" /> Incomplete ({Math.round((plan.requiredCoverage || 0) * 100)}%)
                        </span>
                      )}
                    </div>
                    {/* ✅ A) Disable/Remove from Import Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDisableSheetFromImport(plan.sheetId);
                      }}
                      className="mt-2 w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30 transition-colors"
                    >
                      <X className="w-3 h-3" />
                      Remove from Import
                    </button>
                  </div>
                ))}
              </div>

              {/* Right: Mapping Panel */}
              <div className="col-span-3">
                {(() => {
                  const enabledSheets = sheetPlans.filter(p => p.enabled);
                  const currentPlan = enabledSheets[currentEditingSheetIndex];
                  
                  if (!currentPlan) {
                    return <div className="text-center text-slate-500 py-8">No sheet selected</div>;
                  }

                  const schema = UPLOAD_SCHEMAS[currentPlan.uploadType];
                  const headers = currentPlan.headers || [];
                  const mappingDraft = currentPlan.mappingDraft || {};
                  const recomputed = currentPlan.uploadType ? getRequiredMappingStatus({ uploadType: currentPlan.uploadType, columns: headers, columnMapping: mappingDraft }) : null;
                  const effectiveIsComplete = recomputed ? recomputed.isComplete : currentPlan.isComplete;
                  const effectiveMissingRequired = recomputed ? recomputed.missingRequired : (currentPlan.missingRequired || []);
                  sendAgentLog({location:'EnhancedExternalSystemsView.jsx:renderStep2',message:'[UI Rendering] Step2 Mapping Review',data:{sheetId:currentPlan.sheetId,sheetName:currentPlan.sheetName,uploadType:currentPlan.uploadType,storedIsComplete:currentPlan.isComplete,effectiveIsComplete,recomputedIsComplete:recomputed?recomputed.isComplete:null,mappingDraftKeys:Object.keys(mappingDraft)},runId:'incomplete-debug',sessionId:'debug-session',hypothesisId:'H2_H3'});

                  return (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold text-lg">{currentPlan.sheetName}</h4>
                          <p className="text-sm text-slate-600 dark:text-slate-400">
                            Type: {currentPlan.uploadType} | Coverage: {Math.round((recomputed ? recomputed.coverage : currentPlan.requiredCoverage || 0) * 100)}%
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            onClick={() => handleAiFieldSuggestion(currentPlan.sheetId)}
                            disabled={aiSuggestLoading[currentPlan.sheetId] || currentPlan.mappingConfirmed}
                            variant="secondary"
                            icon={Sparkles}
                            size="sm"
                          >
                            {aiSuggestLoading[currentPlan.sheetId] ? 'AI Analyzing...' : 'AI Field Suggestion'}
                          </Button>
                        </div>
                      </div>

                      {/* Missing Required Fields Warning - uses effectiveMissingRequired (recalculated from mappingDraft) */}
                      {effectiveMissingRequired.length > 0 && (
                        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm">
                          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 font-semibold mb-1">
                            <AlertTriangle className="w-4 h-4" />
                            Missing Required Fields
                          </div>
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            {effectiveMissingRequired.join(', ')}
                          </p>
                        </div>
                      )}

                      {/* Mapping Table */}
                      <div className="border dark:border-slate-700 rounded-lg overflow-hidden max-h-96 overflow-y-auto">
                        <table className="w-full">
                          <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                            <tr>
                              <th className="px-4 py-2 text-left text-sm font-semibold">Excel Column</th>
                              <th className="px-4 py-2 text-left text-sm font-semibold">Target Field</th>
                              <th className="px-4 py-2 text-center text-sm font-semibold w-24">Required</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                            {headers.map((header, idx) => {
                              const targetField = mappingDraft[header] || '';
                              const field = schema.fields.find(f => f.key === targetField);
                              const isRequired = field?.required || false;
                              
                              if (idx === 0) {
                                sendAgentLog({location:'EnhancedExternalSystemsView.jsx:renderStep2',message:'[Dropdown Render] First header',data:{header,targetField,mappingConfirmedStatus:currentPlan.mappingConfirmed,dropdownDisabled:currentPlan.mappingConfirmed,sheetId:currentPlan.sheetId},runId:'manual-mapping',sessionId:'debug-session',hypothesisId:'E'});
                              }
                              
                              return (
                                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                  <td className="px-4 py-2 text-sm font-medium">{header}</td>
                                  <td className="px-4 py-2">
                                    <select
                                      value={targetField}
                                      onChange={(e) => handleMappingChange(currentPlan.sheetId, header, e.target.value)}
                                      disabled={currentPlan.mappingConfirmed}
                                      className="w-full px-3 py-1.5 rounded border dark:bg-slate-800 dark:border-slate-600 text-sm focus:ring-2 focus:ring-purple-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      <option value="">-- Not Mapped --</option>
                                      {schema.fields.map(f => (
                                        <option key={f.key} value={f.key}>
                                          {f.label} {f.required ? '*' : ''}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="px-4 py-2 text-center">
                                    {isRequired && (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-semibold">
                                        Required
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Confirm/Unlock Buttons */}
                      <div className="flex gap-3 justify-end">
                        {currentPlan.mappingConfirmed ? (
                          <Button
                            onClick={() => handleUnlockMapping(currentPlan.sheetId)}
                            variant="secondary"
                            icon={RefreshCw}
                            size="sm"
                          >
                            Unlock & Edit
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleConfirmMapping(currentPlan.sheetId)}
                            disabled={!effectiveIsComplete}
                            variant="success"
                            icon={Check}
                            size="sm"
                          >
                            {effectiveIsComplete ? 'Confirm Mapping' : 'Incomplete - Cannot Confirm'}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Import Summary */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-blue-600">{sheetPlans.filter(p => p.enabled).length}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Enabled Sheets</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-600">
                    {sheetPlans.filter(p => p.enabled && p.mappingConfirmed).length}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Confirmed</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-amber-600">
                    {sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Pending</div>
                </div>
              </div>
            </div>

            {/* Step Navigation */}
            <div className="flex justify-between items-center pt-4 border-t dark:border-slate-700">
              <Button onClick={handleBackToClassification} variant="secondary" icon={ArrowLeft}>
                Back: Classification
              </Button>
              <Button
                onClick={handleOneShotImport}
                disabled={
                  isImporting || 
                  sheetPlans.filter(p => p.enabled).length === 0 ||
                  sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length > 0 ||
                  sheetPlans.filter(p => p.enabled && !p.isComplete).length > 0
                }
                variant="success"
                icon={isImporting ? Loader2 : Upload}
                className={isImporting ? 'animate-pulse' : ''}
              >
                {isImporting 
                  ? 'Importing...' 
                  : sheetPlans.filter(p => p.enabled).length === 0
                    ? 'No enabled sheets to import'
                    : sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length > 0
                      ? `Cannot Import (${sheetPlans.filter(p => p.enabled && !p.mappingConfirmed).length} Unconfirmed)`
                      : sheetPlans.filter(p => p.enabled && !p.isComplete).length > 0
                        ? `Cannot Import (${sheetPlans.filter(p => p.enabled && !p.isComplete).length} Incomplete)`
                        : `Import Confirmed Sheets (${sheetPlans.filter(p => p.enabled && p.mappingConfirmed).length})`
                }
              </Button>
            </div>

          </div>
        </Card>
      )}

      {/* Step 3 (One-shot variant): Import Progress - IMPORTING */}
      {currentStep === 3 && oneShotEnabled && oneShotStep === 'IMPORTING' && (
        <Card>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold flex items-center gap-2 text-lg">
                  <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
                  Importing Sheets...
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  Please wait, importing data...
                </p>
              </div>
            </div>

            {/* Progress Bar */}
            {oneShotProgress.stage && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg space-y-4">
                <div className="flex items-start gap-3">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                      {oneShotProgress.stage === 'processing' && `Processing sheets... (${oneShotProgress.current} / ${oneShotProgress.total})`}
                      {oneShotProgress.stage === 'ingesting' && `Ingesting chunks...`}
                    </h4>
                    {oneShotProgress.sheetName && (
                      <p className="text-sm text-blue-700 dark:text-blue-300 mb-2">
                        Currently: <strong>{oneShotProgress.sheetName}</strong>
                        {oneShotProgress.uploadType && ` (${oneShotProgress.uploadType})`}
                      </p>
                    )}
                    
                    {/* Sheet Progress */}
                    {oneShotProgress.total > 0 && (
                      <div>
                        <div className="flex justify-between text-xs text-blue-700 dark:text-blue-300 mb-1">
                          <span>Sheet {oneShotProgress.current} / {oneShotProgress.total}</span>
                          <span>{Math.round((oneShotProgress.current / oneShotProgress.total) * 100)}%</span>
                        </div>
                        <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2">
                          <div
                            className="bg-blue-600 dark:bg-blue-400 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${(oneShotProgress.current / oneShotProgress.total) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 3 (One-shot variant): Import Result - RESULT */}
      {currentStep === 3 && oneShotEnabled && oneShotStep === 'RESULT' && importReport && (
        <Card>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold flex items-center gap-2 text-lg">
                  <Check className="w-6 h-6 text-green-600" />
                  Import Result
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  Import complete, please review results
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={resetFlow} variant="secondary" icon={RefreshCw} size="sm">
                  Upload Another File
                </Button>
              </div>
            </div>

            {/* D) Result Summary (always shown) */}
            <div className={`p-4 border rounded-lg ${
              importReport.needsReviewSheets > 0
                ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
                : importReport.error
                  ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                  : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
            }`}>
              <div className="flex justify-between items-start mb-3">
                <h4 className={`font-semibold flex items-center gap-2 ${
                  importReport.needsReviewSheets > 0
                    ? 'text-amber-900 dark:text-amber-100'
                    : importReport.error
                      ? 'text-red-900 dark:text-red-100'
                      : 'text-green-900 dark:text-green-100'
                }`}>
                  {importReport.error ? (
                    <>
                      <X className="w-5 h-5" />
                      Import Failed
                    </>
                  ) : importReport.needsReviewSheets > 0 ? (
                    <>
                      <AlertTriangle className="w-5 h-5" />
                      Import Requires Review
                    </>
                  ) : (
                    <>
                      <Check className="w-5 h-5" />
                      Import Completed
                    </>
                  )}
                </h4>
                {/* D) Download Report (JSON) - directly download importReport */}
                <button
                  onClick={() => {
                    const json = JSON.stringify(importReport, null, 2);
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `oneshot-import-report-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    addNotification('Report downloaded', 'success');
                  }}
                  disabled={!importReport}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-100 rounded-md hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Report (JSON)
                </button>
              </div>
              
              {/* Error Display */}
              {importReport.error && (
                <div className="mb-3 p-3 bg-red-100 dark:bg-red-900/30 rounded text-sm">
                  <p className="font-semibold text-red-800 dark:text-red-200 mb-1">Error Message:</p>
                  <p className="text-red-700 dark:text-red-300">{importReport.error}</p>
                </div>
              )}
              
              {/* Summary Stats */}
              <div className="grid grid-cols-5 gap-4 mb-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600">{importReport.totalSheets || 0}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Total</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{importReport.succeededSheets || 0}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Succeeded</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-orange-600">{importReport.needsReviewSheets || 0}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Needs Review</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-amber-600">{importReport.skippedSheets || 0}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Skipped</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-600">{importReport.failedSheets || 0}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-400">Failed</div>
                </div>
              </div>
              
              {/* Detailed Sheet Results */}
              {importReport.sheetReports && importReport.sheetReports.length > 0 && (
                <div className="space-y-2">
                  <h5 className="font-semibold text-sm text-slate-700 dark:text-slate-300 mb-2">Sheet Details:</h5>
                  {importReport.sheetReports.map((result, idx) => (
                    <div key={idx} className={`p-3 rounded border text-sm ${
                      result.status === 'IMPORTED' ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' :
                      result.status === 'NEEDS_REVIEW' ? 'bg-orange-50 border-orange-200 dark:bg-orange-900/20 dark:border-orange-800' :
                      result.status === 'SKIPPED' ? 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800' :
                      'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {result.status === 'IMPORTED' && <Check className="w-4 h-4 text-green-600" />}
                          {result.status === 'NEEDS_REVIEW' && <AlertTriangle className="w-4 h-4 text-orange-600" />}
                          {result.status === 'SKIPPED' && <AlertTriangle className="w-4 h-4 text-amber-600" />}
                          {result.status === 'FAILED' && <X className="w-4 h-4 text-red-600" />}
                          <span className="font-semibold">{result.sheetName}</span>
                          <span className="text-xs text-slate-500">({result.uploadType || 'N/A'})</span>
                        </div>
                        {result.status === 'IMPORTED' && (
                          <span className="text-xs text-green-700 dark:text-green-300">
                            ✓ {result.savedCount} rows saved
                          </span>
                        )}
                      </div>
                      {result.reason && (
                        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 ml-6">{result.reason}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Step 3: Field Mapping (normal mode) */}
      {currentStep === 3 && !oneShotEnabled && rawRows.length > 0 && UPLOAD_SCHEMAS[uploadType] && (
        <Card>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <h3 className="font-semibold flex items-center gap-2">
                  <ArrowRight className="w-5 h-5 text-blue-500" />
                  Field Mapping
                </h3>
                <div className="text-sm text-slate-500">
                  Loaded {columns.length} columns
                </div>
              </div>
              
              {/* AI Field Suggestion Button */}
              <Button
                onClick={runAiMappingSuggestion}
                disabled={mappingAiStatus === 'analyzing'}
                variant="secondary"
                icon={Sparkles}
                className="flex items-center gap-2"
              >
                {mappingAiStatus === 'analyzing' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    AI Analyzing...
                  </>
                ) : (
                  'AI Field Suggestion'
                )}
              </Button>
            </div>

            {/* Sheet Selector (if multiple sheets available) */}
            {sheetNames.length > 1 && (
              <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="w-5 h-5 text-yellow-600" />
                    <span className="font-medium text-yellow-900 dark:text-yellow-100">
                      Multiple sheets detected:
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-yellow-800 dark:text-yellow-200">
                      Select sheet:
                    </label>
                    <select
                      value={selectedSheet}
                      onChange={(e) => handleSheetChange(e.target.value)}
                      disabled={loading}
                      className="px-3 py-1.5 rounded border border-yellow-300 dark:border-yellow-700 bg-white dark:bg-slate-800 text-sm focus:ring-2 focus:ring-yellow-500 outline-none"
                    >
                      {sheetNames.map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-2">
                  Currently showing data from sheet: <strong>{selectedSheet}</strong> ({rawRows.length} rows)
                </p>
              </div>
            )}

            <p className="text-sm text-slate-600 dark:text-slate-400">
              Map Excel columns to system fields. <span className="text-red-500">Required fields</span> must be mapped to continue.
              {mappingAiStatus === 'idle' && (
                <span className="ml-2 text-blue-600 dark:text-blue-400">
                  💡 Try "AI Field Suggestion" for quick mapping
                </span>
              )}
            </p>

            {/* Unmapped Required Fields Warning */}
            {getUnmappedRequiredFields().length > 0 && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">
                      The following required fields are not yet mapped
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {getUnmappedRequiredFields().map(fieldKey => {
                        const schema = UPLOAD_SCHEMAS[uploadType];
                        const field = schema?.fields.find(f => f.key === fieldKey);
                        return (
                          <span key={fieldKey} className="px-2 py-1 bg-red-100 dark:bg-red-800 text-red-800 dark:text-red-100 rounded text-xs">
                            {field?.label || fieldKey}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Mapping List */}
            <div className="space-y-3 max-h-96 overflow-y-auto border dark:border-slate-700 rounded-lg p-4">
              <div className="grid grid-cols-2 gap-3 mb-3 pb-2 border-b dark:border-slate-700">
                <div className="text-xs font-semibold text-slate-500 uppercase">Excel Column</div>
                <div className="text-xs font-semibold text-slate-500 uppercase">System Field</div>
              </div>

              {columns.map(excelColumn => (
                <div key={excelColumn} className="grid grid-cols-2 gap-3 items-center">
                  {/* Left: Excel column name */}
                  <div className="px-3 py-2 bg-slate-100 dark:bg-slate-700 rounded font-mono text-sm truncate" title={excelColumn}>
                    {excelColumn}
                  </div>

                  {/* Right: System field dropdown */}
                  <select
                    value={columnMapping[excelColumn] || ''}
                    onChange={(e) => updateColumnMapping(excelColumn, e.target.value)}
                    className="px-3 py-2 border rounded-lg dark:bg-slate-800 dark:border-slate-600 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="">-- Do not map --</option>
                    
                    {/* Required fields */}
                    <optgroup label="Required Fields">
                      {UPLOAD_SCHEMAS[uploadType]?.fields
                        ?.filter(f => f.required)
                        .map(field => (
                          <option key={field.key} value={field.key}>
                            {field.label} ({field.type})
                          </option>
                        )) || []}
                    </optgroup>

                    {/* Optional fields */}
                    <optgroup label="Optional Fields">
                      {UPLOAD_SCHEMAS[uploadType]?.fields
                        ?.filter(f => !f.required)
                        .map(field => (
                          <option key={field.key} value={field.key}>
                            {field.label} ({field.type})
                          </option>
                        )) || []}
                    </optgroup>
                  </select>
                </div>
              ))}
            </div>

            {/* System Field Descriptions */}
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">
                System Field Descriptions
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                {/* Required fields */}
                <div>
                  <p className="font-medium text-blue-800 dark:text-blue-200 mb-1">Required Fields:</p>
                  <ul className="space-y-1">
                    {UPLOAD_SCHEMAS[uploadType]?.fields
                      ?.filter(f => f.required)
                      .map(field => (
                        <li key={field.key} className="text-blue-700 dark:text-blue-300 flex items-start gap-1">
                          <span className="text-red-500">•</span>
                          <span><strong>{field.label}</strong> - {field.description}</span>
                        </li>
                      )) || []}
                  </ul>
                </div>

                {/* Optional fields */}
                <div>
                  <p className="font-medium text-blue-800 dark:text-blue-200 mb-1">Optional Fields:</p>
                  <ul className="space-y-1">
                    {UPLOAD_SCHEMAS[uploadType]?.fields
                      ?.filter(f => !f.required)
                      .slice(0, 5)
                      .map(field => (
                        <li key={field.key} className="text-blue-700 dark:text-blue-300">
                          <strong>{field.label}</strong> - {field.description}
                        </li>
                      )) || []}
                    {(UPLOAD_SCHEMAS[uploadType]?.fields?.filter(f => !f.required).length || 0) > 5 && (
                      <li className="text-blue-600 dark:text-blue-400 italic">
                        ... and {(UPLOAD_SCHEMAS[uploadType]?.fields?.filter(f => !f.required).length || 0) - 5} more optional fields
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </div>

            {/* Data Preview */}
            <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border dark:border-slate-700">
              <h4 className="text-sm font-medium mb-2">Data Preview (First 3 rows)</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b dark:border-slate-700">
                      {columns.slice(0, 6).map(col => (
                        <th key={col} className="text-left p-2 font-mono">{col}</th>
                      ))}
                      {columns.length > 6 && <th className="text-left p-2">...</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rawRows.slice(0, 3).map((row, idx) => (
                      <tr key={idx} className="border-b dark:border-slate-700">
                        {columns.slice(0, 6).map(col => (
                          <td key={col} className="p-2">{String(row[col]).substring(0, 20)}</td>
                        ))}
                        {columns.length > 6 && <td className="p-2 text-slate-400">...</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mapped Data Preview - show data preview after mapping transformation */}
            {Object.values(columnMapping).some(v => v !== '') && (
              <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-200 dark:border-emerald-800">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-emerald-900 dark:text-emerald-100 flex items-center gap-2">
                    <Check className="w-4 h-4" />
                    Mapped Data Preview
                  </h4>
                  <span className="text-xs text-emerald-700 dark:text-emerald-300">
                    Showing first 5 rows after field mapping
                  </span>
                </div>
                
                <p className="text-xs text-emerald-800 dark:text-emerald-200 mb-3">
                  This is how your data will look after mapping to system fields. Please verify the mapping is correct.
                </p>
                
                <div className="overflow-x-auto bg-white dark:bg-slate-800 rounded border dark:border-slate-700">
                  <table className="w-full text-xs">
                    <thead className="bg-emerald-100 dark:bg-emerald-900/30">
                      <tr className="border-b dark:border-emerald-800">
                        <th className="text-left p-2 font-semibold">#</th>
                        {getMappedSystemFields().map(field => (
                          <th 
                            key={field.key} 
                            className={`text-left p-2 font-semibold ${
                              field.required ? 'text-red-600 dark:text-red-400' : 'text-emerald-900 dark:text-emerald-100'
                            }`}
                            title={field.description}
                          >
                            {field.label}
                            {field.required && <span className="text-red-500 ml-1">*</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {generateMappedPreview().map((mappedRow, idx) => (
                        <tr key={idx} className="border-b dark:border-slate-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/10">
                          <td className="p-2 text-slate-400 font-mono">{mappedRow._rowIndex}</td>
                          {getMappedSystemFields().map(field => (
                            <td key={field.key} className="p-2">
                              {mappedRow[field.key] !== undefined && mappedRow[field.key] !== null && mappedRow[field.key] !== '' ? (
                                <span className="text-slate-900 dark:text-slate-100">
                                  {String(mappedRow[field.key]).substring(0, 30)}
                                  {String(mappedRow[field.key]).length > 30 && '...'}
                                </span>
                              ) : (
                                <span className="text-slate-400 italic text-xs">empty</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  
                  {/* Field statistics */}
                  <div className="p-3 bg-slate-50 dark:bg-slate-800 border-t dark:border-slate-700">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-slate-500">Total Columns:</span>
                        <span className="ml-2 font-semibold text-emerald-600">
                          {getMappedSystemFields().length}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Required:</span>
                        <span className="ml-2 font-semibold text-red-600">
                          {getMappedSystemFields().filter(f => f.required).length}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Optional:</span>
                        <span className="ml-2 font-semibold text-blue-600">
                          {getMappedSystemFields().filter(f => !f.required).length}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Total Rows:</span>
                        <span className="ml-2 font-semibold text-slate-900 dark:text-slate-100">
                          {rawRows.length}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Hint message */}
                <div className="mt-3 flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-200">
                  <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p>
                    <strong>Tip:</strong> If the mapped data looks correct, click "Next: Validate Data" to proceed with data validation. 
                    If you need to adjust the mapping, modify the field assignments above.
                  </p>
                </div>
              </div>
            )}

            {/* Button Area */}
            <div className="flex justify-between items-center pt-2">
              <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                Back
              </Button>
              
              <div className="flex items-center gap-3">
                {(() => {
                  const mappingStatus = getRequiredMappingStatus({
                    uploadType,
                    columns,
                    columnMapping
                  });
                  
                  return mappingStatus.isComplete ? (
                    <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                      <Check className="w-4 h-4" />
                      Mapping Complete ({Math.round(mappingStatus.coverage * 100)}%)
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                        <AlertTriangle className="w-4 h-4" />
                        Required fields must be mapped to continue
                      </span>
                      <span className="text-xs text-red-500 dark:text-red-400">
                        Missing: {mappingStatus.missingRequired.slice(0, 3).join(', ')}
                        {mappingStatus.missingRequired.length > 3 && ` (+${mappingStatus.missingRequired.length - 3} more)`}
                      </span>
                    </div>
                  );
                })()}
                
                <Button
                  onClick={validateData}
                  disabled={!mappingComplete || loading}
                  variant={mappingComplete ? "primary" : "secondary"}
                  icon={ArrowRight}
                >
                  Next: Validate Data
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Step 4: Data Validation Results */}
      {currentStep === 4 && validationResult && (
        <Card>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold flex items-center gap-2">
                <Check className="w-5 h-5 text-green-500" />
                Data Validation and Cleaning Results
              </h3>
              {validationResult.stats.successRate === 100 && (
                <span className="px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full text-sm font-medium">
                  ✓ All Passed
                </span>
              )}
            </div>

            {/* Import Mode Selection + Error Report Download */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border dark:border-slate-700">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <h4 className="text-sm font-semibold mb-2">Import Mode</h4>
                  <div className="flex items-center gap-4">
                    {/* Best-effort mode (default) */}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        checked={!strictMode}
                        onChange={() => workflowActions.setStrictMode(false)}
                        className="w-4 h-4"
                      />
                      <span className={`text-sm ${!strictMode ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`}>
                        Best-effort
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        (Save valid rows, skip errors)
                      </span>
                    </label>

                    {/* Strict mode */}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        checked={strictMode}
                        onChange={() => workflowActions.setStrictMode(true)}
                        className="w-4 h-4"
                      />
                      <span className={`text-sm ${strictMode ? 'font-semibold text-orange-600 dark:text-orange-400' : 'text-slate-600 dark:text-slate-400'}`}>
                        Strict
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        (All rows must be valid)
                      </span>
                    </label>
                  </div>
                  
                  {/* Strict mode description */}
                  {strictMode && validationResult.errorRows && validationResult.errorRows.length > 0 && (
                    <div className="mt-2 text-xs text-orange-700 dark:text-orange-300 flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                      <span>
                        Strict mode: Save will be disabled until all errors are fixed.
                      </span>
                    </div>
                  )}
                </div>

                {/* Download Error Report Button */}
                {validationResult.errorRows && validationResult.errorRows.length > 0 && (
                  <Button
                    onClick={() => downloadErrorReport({
                      errorRows: validationResult.errorRows,
                      rawRows: rawRows,
                      columns: columns,
                      uploadType: uploadType,
                      fileName: fileName
                    })}
                    variant="secondary"
                    icon={Download}
                    size="sm"
                  >
                    Download Error Report (.csv)
                  </Button>
                )}
              </div>
            </div>

            {/* Statistics Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="text-3xl font-bold text-blue-600">{validationResult.stats.total}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">Total Rows</div>
              </div>
              <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                <div className="text-3xl font-bold text-green-600">{validationResult.stats.valid}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">Valid Data</div>
              </div>
              <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                <div className="text-3xl font-bold text-red-600">{validationResult.stats.invalid}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">Error Data</div>
              </div>
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="text-3xl font-bold text-blue-600">{validationResult.stats.merged || 0}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">Merged</div>
              </div>
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                <div className="text-3xl font-bold text-purple-600">{validationResult.stats.successRate}%</div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">Success Rate</div>
              </div>
            </div>

            {/* Merge Info */}
            {validationResult.duplicateGroups && validationResult.duplicateGroups.length > 0 && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="flex items-start gap-3">
                  <Check className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-1">
                      ✓ Intelligently merged {validationResult.stats.duplicates || validationResult.duplicateGroups.length} duplicate records
                    </h4>
                    <p className="text-sm text-blue-800 dark:text-blue-200 mb-3">
                      System has automatically merged duplicate suppliers, preserving the most complete information.
                    </p>
                    
                    <div className="space-y-3">
                      {validationResult.duplicateGroups.slice(0, 5).map((group, idx) => (
                        <div key={idx} className="bg-white dark:bg-slate-800 rounded border border-blue-300 dark:border-blue-700 p-3">
                          <div className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">
                            {group.type === 'merged' && `Merged Supplier: "${group.value}"`}
                            {group.type === 'combined' && `Merged ${group.keys?.join(' + ')}`}
                            <span className="ml-2 text-xs font-normal text-blue-700 dark:text-blue-300">
                              ({group.count} rows merged into 1)
                            </span>
                          </div>
                          <div className="text-xs space-y-1">
                            <div className="text-blue-600 dark:text-blue-400 font-medium">
                              Merged from rows: {group.originalRow}, {group.mergedFromRows?.join(', ')}
                            </div>
                            {group.mergedData && (
                              <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-900/30 rounded text-slate-700 dark:text-slate-300">
                                <div className="font-medium mb-1">Final merged data:</div>
                                <div className="space-y-0.5">
                                  {group.mergedData.supplier_code && (
                                    <div>• Code: {group.mergedData.supplier_code}</div>
                                  )}
                                  {group.mergedData.supplier_name && (
                                    <div>• Name: {group.mergedData.supplier_name}</div>
                                  )}
                                  {group.mergedData.contact_person && (
                                    <div>• Contact: {group.mergedData.contact_person}</div>
                                  )}
                                  {group.mergedData.phone && (
                                    <div>• Phone: {group.mergedData.phone}</div>
                                  )}
                                  {group.mergedData.email && (
                                    <div>• Email: {group.mergedData.email}</div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {validationResult.duplicateGroups.length > 5 && (
                        <p className="text-xs text-blue-700 dark:text-blue-300">
                          ... and {validationResult.duplicateGroups.length - 5} more merged groups
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Success Message */}
            {validationResult.stats.valid > 0 && (
              <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <div className="flex items-start gap-3">
                  <Check className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-green-900 dark:text-green-100 mb-1">
                      {validationResult.stats.valid} rows passed validation
                    </h4>
                    <p className="text-sm text-green-800 dark:text-green-200">
                      These rows have been type-converted and cleaned, and are ready to be safely saved to the database.
                      {validationResult.duplicateGroups && validationResult.duplicateGroups.length > 0 && (
                        <span className="block mt-1 font-semibold">
                          Note: Duplicate records have been intelligently merged.
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Error Details */}
            {validationResult.errorRows && validationResult.errorRows.length > 0 && (
              <div className="border border-red-200 dark:border-red-800 rounded-lg overflow-hidden">
                <div className="bg-red-50 dark:bg-red-900/20 px-4 py-3 border-b border-red-200 dark:border-red-800">
                  <h4 className="font-semibold text-red-900 dark:text-red-100 flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    Error Data Details (Showing first 10)
                  </h4>
                  <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                    The following data has validation errors. Please correct and re-upload
                  </p>
                </div>

                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">Row #</th>
                        <th className="px-4 py-3 text-left font-semibold">Error Field</th>
                        <th className="px-4 py-3 text-left font-semibold">Original Value</th>
                        <th className="px-4 py-3 text-left font-semibold">Error Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                      {validationResult.errorRows.slice(0, 10).map((errorRow, idx) => (
                        <React.Fragment key={idx}>
                          {errorRow.errors.map((error, errIdx) => (
                            <tr 
                              key={`${idx}-${errIdx}`}
                              className="hover:bg-red-50 dark:hover:bg-red-900/10"
                            >
                              {errIdx === 0 && (
                                <td 
                                  className="px-4 py-3 font-mono text-slate-600 dark:text-slate-400 align-top"
                                  rowSpan={errorRow.errors.length}
                                >
                                  Row {errorRow.rowIndex}
                                </td>
                              )}
                              <td className="px-4 py-3">
                                <span className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs font-medium">
                                  {error.fieldLabel}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-600 dark:text-slate-400">
                                {error.originalValue !== null && error.originalValue !== undefined 
                                  ? String(error.originalValue).substring(0, 30) 
                                  : <span className="text-slate-400 italic">(empty)</span>
                                }
                              </td>
                              <td className="px-4 py-3 text-red-700 dark:text-red-300">
                                {error.error}
                              </td>
                            </tr>
                          ))}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>

                {validationResult.errorRows.length > 10 && (
                  <div className="bg-red-50 dark:bg-red-900/20 px-4 py-2 border-t border-red-200 dark:border-red-800 text-center text-sm text-red-700 dark:text-red-300">
                    {validationResult.errorRows.length - 10} more error rows not shown
                  </div>
                )}
              </div>
            )}

            {/* No Valid Data Warning */}
            {validationResult.validRows.length === 0 && (
              <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-amber-900 dark:text-amber-100 mb-1">
                      No valid data to save
                    </h4>
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      All data has validation errors. Please correct and re-upload.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Batch Upload Progress Bar */}
            {saving && saveProgress.stage && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="flex items-start gap-3">
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                      {saveProgress.message}
                    </h4>
                    
                    {/* Progress bar */}
                    {saveProgress.total > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-blue-800 dark:text-blue-200">
                          <span>
                            {saveProgress.stage === 'collecting' && '📊 Analyzing data'}
                            {saveProgress.stage === 'suppliers' && '🏢 Processing suppliers'}
                            {saveProgress.stage === 'materials' && '📦 Processing materials'}
                            {saveProgress.stage === 'receipts' && '✍️ Writing receipt records'}
                          </span>
                          <span className="font-mono">
                            {saveProgress.current} / {saveProgress.total}
                          </span>
                        </div>
                        <div className="w-full bg-blue-200 dark:bg-blue-700 rounded-full h-3">
                          <div
                            className="bg-blue-600 dark:bg-blue-400 h-3 rounded-full transition-all duration-300"
                            style={{ 
                              width: `${saveProgress.total > 0 ? (saveProgress.current / saveProgress.total * 100) : 0}%` 
                            }}
                          />
                        </div>
                      </div>
                    )}
                    
                    <p className="text-xs text-blue-700 dark:text-blue-300 mt-2">
                      Please wait, system is using batch processing for optimized performance...
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Button Area and Instructions */}
            <div className="space-y-3 pt-4 border-t dark:border-slate-700">
              {/* Instruction Text */}
              {validationResult.validRows.length > 0 && validationResult.errorRows.length > 0 && !saving && (
                <>
                  {/* Best-effort mode description */}
                  {!strictMode && (
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                      <div className="flex items-start gap-2">
                        <Check className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="text-blue-900 dark:text-blue-100 font-medium mb-1">
                            Best-effort Mode: Writing Valid Data Only
                          </p>
                          <p className="text-blue-800 dark:text-blue-200">
                            System will save <strong>{validationResult.validRows.length} valid rows</strong> and 
                            skip <strong>{validationResult.errorRows.length} error rows</strong>. 
                            Error data will not be written to the database.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Strict mode description */}
                  {strictMode && (
                    <div className="p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-5 h-5 text-orange-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="text-orange-900 dark:text-orange-100 font-medium mb-1">
                            Strict Mode: Cannot Save with Errors
                          </p>
                          <p className="text-orange-800 dark:text-orange-200">
                            Found <strong>{validationResult.errorRows.length} error rows</strong>. 
                            Please fix all errors before saving, or switch to <strong>Best-effort mode</strong> to save valid data only.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Button Row */}
              <div className="flex justify-between items-center">
                <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                  Back to Edit Mapping
                </Button>
                <div className="flex items-center gap-3 flex-1 justify-end">
                  {/* Save Progress */}
                  {saving && saveProgress.stage && (
                    <div className="flex items-center gap-2 mr-4">
                      <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                      <span className="text-sm text-blue-600 dark:text-blue-400">
                        {saveProgress.message || 'Saving...'}
                      </span>
                      {saveProgress.total > 0 && (
                        <span className="text-xs text-blue-500">
                          ({saveProgress.current}/{saveProgress.total})
                        </span>
                      )}
                    </div>
                  )}
                  
                  {/* All data valid */}
                  {validationResult.validRows.length > 0 && validationResult.errorRows.length === 0 && !saving && (
                    <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                      ✓ All data valid, ready to save {validationResult.validRows.length} rows
                    </span>
                  )}

                  {/* Strict mode with errors */}
                  {strictMode && validationResult.errorRows.length > 0 && !saving && (
                    <span className="text-sm text-orange-600 dark:text-orange-400 font-medium flex items-center gap-1">
                      <AlertTriangle className="w-4 h-4" />
                      Strict mode: Fix errors to enable save
                    </span>
                  )}

                  <Button
                    onClick={handleSave}
                    disabled={
                      saving || 
                      validationResult.validRows.length === 0 ||
                      (strictMode && validationResult.errorRows.length > 0)
                    }
                    variant={
                      validationResult.validRows.length > 0 && 
                      (!strictMode || validationResult.errorRows.length === 0)
                        ? "success" 
                        : "secondary"
                    }
                    icon={Check}
                  >
                    {saving ? 'Saving...' : `Save to Database`}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default EnhancedExternalSystemsView;
