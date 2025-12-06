/**
 * Enhanced External Systems View
 * Enhanced external system data upload - Supports multiple upload types, field mapping, and data validation
 */

import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Database, Upload, Download, X, RefreshCw, Sparkles,
  Check, AlertTriangle, ArrowRight, ArrowLeft, FileSpreadsheet, Loader2
} from 'lucide-react';
import { Card, Button } from '../components/ui';
import { callGeminiAPI } from '../services/geminiAPI';
import {
  suppliersService,
  materialsService,
  goodsReceiptsService,
  priceHistoryService,
  userFilesService,
  uploadMappingsService
} from '../services/supabaseClient';
import { importBatchesService } from '../services/importHistoryService';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import { validateAndCleanData } from '../utils/dataValidation';
import {
  extractAiJson,
  generateMappingPrompt,
  validateMappingResponse,
  mergeMappings
} from '../utils/aiMappingHelper';

// Note: Upload type configuration has been moved to src/utils/uploadSchemas.js
// Kept here for compatibility, but UPLOAD_SCHEMAS should be used

const EnhancedExternalSystemsView = ({ addNotification, user }) => {
  // Multi-step workflow state
  const [currentStep, setCurrentStep] = useState(1); // 1: select type, 2: upload, 3: mapping, 4: validation, 5: save

  // Data type - default to empty string
  const [uploadType, setUploadType] = useState('');

  // File and data
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [rawRows, setRawRows] = useState([]);
  const [columns, setColumns] = useState([]);

  // Field mapping - format: { [excelColumn]: systemFieldKey }
  const [columnMapping, setColumnMapping] = useState({});
  const [mappingComplete, setMappingComplete] = useState(false);

  // AI mapping suggestion status
  const [mappingAiStatus, setMappingAiStatus] = useState('idle'); // 'idle' | 'analyzing' | 'ready' | 'error'
  const [mappingAiError, setMappingAiError] = useState('');

  // Validation results
  const [validationResult, setValidationResult] = useState(null);

  // UI state
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef(null);

  // Step 1: Select upload type
  const handleTypeSelect = (type) => {
    setUploadType(type);
    setCurrentStep(2);
    // Reset other states
    setFile(null);
    setFileName('');
    setRawRows([]);
    setColumns([]);
    setColumnMapping({});
    setValidationResult(null);
  };

  // Step 2: Upload file
  const handleFileChange = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    // Check if upload type is selected
    if (!uploadType) {
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

    if (selectedFile.size > 10 * 1024 * 1024) {
      addNotification("File too large. Maximum size is 10MB", "error");
      return;
    }

    setFile(selectedFile);
    setFileName(selectedFile.name);
    setUploadProgress(10);
    setLoading(true);

    try {
      const rows = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const bstr = evt.target.result;
            const wb = XLSX.read(bstr, { type: 'binary' });
            const wsname = wb.SheetNames[0];
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname], { defval: '' });
            resolve(data);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsBinaryString(selectedFile);
      });

      if (rows.length === 0) {
        throw new Error('File is empty');
      }

      const cols = Object.keys(rows[0]);
      setRawRows(rows);
      setColumns(cols);
      setUploadProgress(100);

      addNotification(`Loaded ${rows.length} rows`, "success");

      // Automatically proceed to field mapping step and load previous mapping
      setTimeout(async () => {
        setCurrentStep(3);
        
        // Try to load and apply previously saved mapping template
        try {
          if (user?.id) {
            const smartMapping = await uploadMappingsService.smartMapping(
              user.id,
              uploadType,
              cols
            );

            if (Object.keys(smartMapping).length > 0) {
              setColumnMapping(smartMapping);
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
              setColumnMapping(initialMapping);
            }
          } else {
            // Not logged in, initialize empty mapping
            const initialMapping = {};
            cols.forEach(col => {
              initialMapping[col] = '';
            });
            setColumnMapping(initialMapping);
          }
        } catch (error) {
          console.error('Failed to load mapping template:', error);
          // On failure, initialize empty mapping
          const initialMapping = {};
          cols.forEach(col => {
            initialMapping[col] = '';
          });
          setColumnMapping(initialMapping);
        }
      }, 500);

    } catch (error) {
      addNotification(`Upload failed: ${error.message}`, "error");
      setFile(null);
      setFileName('');
      setRawRows([]);
    } finally {
      setLoading(false);
      setTimeout(() => setUploadProgress(0), 1000);
    }
  };

  // Update column mapping - from Excel column -> system field
  const updateColumnMapping = (excelColumn, systemFieldKey) => {
    const updated = { ...columnMapping, [excelColumn]: systemFieldKey };
    setColumnMapping(updated);
    checkMappingComplete(updated);
  };

  // Check if mapping is complete (all required fields are mapped)
  const checkMappingComplete = (mapping) => {
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) {
      setMappingComplete(false);
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

    setMappingComplete(allRequiredMapped);
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

    try {
      // Get schema
      const schema = UPLOAD_SCHEMAS[uploadType];
      if (!schema) {
        throw new Error(`Unknown upload type: ${uploadType}`);
      }

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
      const aiResponse = await callGeminiAPI(prompt);

      // Parse AI response
      const parsedResponse = extractAiJson(aiResponse);

      // Validate response format
      if (!validateMappingResponse(parsedResponse)) {
        throw new Error('AI response format is incorrect');
      }

      // Merge mapping suggestions into existing columnMapping
      const { mapping: newMapping, appliedCount, skippedCount } = mergeMappings(
        columnMapping,
        parsedResponse.mappings,
        0.6 // Minimum confidence threshold
      );

      // Update columnMapping
      setColumnMapping(newMapping);
      
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
      setMappingAiStatus('error');
      setMappingAiError(error.message || 'AI analysis failed');
      addNotification(
        `AI field suggestion failed: ${error.message}. Please use manual mapping.`,
        "error"
      );
    }
  };

  // Step 4: Validate and clean data
  const validateData = () => {
    if (!mappingComplete) {
      addNotification("Please complete required field mapping first", "error");
      return;
    }

    setLoading(true);

    try {
      // Use new validation function: transform -> validate -> clean
      const result = validateAndCleanData(rawRows, uploadType, columnMapping);
      setValidationResult(result);
      setCurrentStep(4);

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
    } finally {
      setLoading(false);
    }
  };

  // Step 5: Save to database
  const handleSave = async () => {
    // Check if there's valid data
    if (!validationResult || validationResult.validRows.length === 0) {
      addNotification("No valid data to save", "error");
      return;
    }

    // Check if user understands only valid data will be written
    const hasErrors = validationResult.errorRows && validationResult.errorRows.length > 0;
    if (hasErrors) {
      // Could add confirmation dialog here, currently proceeding directly
      console.log(`Note: ${validationResult.errorRows.length} error rows will not be saved`);
    }

    setSaving(true);

    let batchId = null;

    try {
      const userId = user?.id;
      if (!userId) {
        throw new Error('User not logged in, cannot save data');
      }

      // 1. Create import batch record
      const targetTableMap = {
        'goods_receipt': 'goods_receipts',
        'price_history': 'price_history',
        'supplier_master': 'suppliers'
      };
      
      const targetTable = targetTableMap[uploadType] || uploadType;
      
      const batchRecord = await importBatchesService.createBatch(userId, {
        uploadType: uploadType,
        filename: fileName,
        targetTable: targetTable,
        totalRows: rawRows.length,
        metadata: {
          validRows: validationResult.validRows.length,
          errorRows: validationResult.errorRows.length,
          columns: columns
        }
      });
      
      batchId = batchRecord.id;
      console.log('Import batch created:', batchId);

      // 2. Save original file record to user_files table
      const fileRecord = await userFilesService.saveFile(userId, fileName, rawRows);
      const uploadFileId = fileRecord.id;

      // 3. Process data based on upload type (with batch_id)
      let savedCount = 0;
      if (uploadType === 'goods_receipt') {
        savedCount = await saveGoodsReceipts(userId, validationResult.validRows, uploadFileId, batchId);
      } else if (uploadType === 'price_history') {
        savedCount = await savePriceHistory(userId, validationResult.validRows, uploadFileId, batchId);
      } else if (uploadType === 'supplier_master') {
        savedCount = await saveSuppliers(userId, validationResult.validRows, batchId);
      } else {
        throw new Error(`Unsupported upload type: ${uploadType}`);
      }

      // 4. Update import batch with success/error counts and mark as completed
      await importBatchesService.updateBatch(batchId, {
        successRows: validationResult.validRows.length,
        errorRows: validationResult.errorRows.length,
        status: 'completed'
      });
      console.log('Import batch updated to completed');

      // 5. Save mapping template for next time
      try {
        await uploadMappingsService.saveMapping(
          userId,
          uploadType,
          columns,
          columnMapping
        );
        console.log('Field mapping template saved');
      } catch (mappingError) {
        console.error('Failed to save mapping template:', mappingError);
        // Does not affect main flow, just log error
      }

      // 6. Show success message
      const successMsg = hasErrors 
        ? `Successfully saved ${savedCount} valid rows, ${validationResult.errorRows.length} error rows skipped`
        : `Successfully saved all ${savedCount} rows`;
      
      addNotification(successMsg, "success");

      // 7. Reset flow (delayed so user can see success message)
      setTimeout(() => {
        resetFlow();
      }, 2000);

    } catch (error) {
      console.error('Error saving data:', error);
      addNotification(`Save failed: ${error.message}`, "error");
      
      // If batch was created but save failed, update its status to error
      if (batchId) {
        try {
          await importBatchesService.updateBatch(batchId, {
            status: 'pending',
            metadata: { error: error.message }
          });
        } catch (updateError) {
          console.error('Failed to update batch status:', updateError);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * Save goods receipt records to database
   * @param {string} userId - User ID
   * @param {Array} validRows - Validated valid data
   * @param {string} uploadFileId - Upload file ID
   * @param {string} batchId - Import batch ID
   * @returns {number} Number of records successfully saved
   */
  const saveGoodsReceipts = async (userId, validRows, uploadFileId, batchId) => {
    const receipts = [];

    for (const row of validRows) {
      try {
        // 1. Create or get supplier
        const supplier = await suppliersService.findOrCreate(userId, {
          supplier_name: row.supplier_name,
          supplier_code: row.supplier_code || null
        });

        // 2. Create or get material
        const material = await materialsService.findOrCreate(userId, {
          material_code: row.material_code,
          material_name: row.material_name || row.material_code,
          category: row.category || null,
          uom: row.uom || 'pcs'
        });

        // 3. Build goods receipt payload
        receipts.push({
          user_id: userId,
          supplier_id: supplier.id,
          material_id: material.id,
          po_number: row.po_number || null,
          receipt_number: row.receipt_number || null,
          planned_delivery_date: row.planned_delivery_date || null,
          actual_delivery_date: row.actual_delivery_date,
          receipt_date: row.receipt_date || row.actual_delivery_date,
          received_qty: row.received_qty,
          rejected_qty: row.rejected_qty || 0,
          upload_file_id: uploadFileId,
          batch_id: batchId
        });
      } catch (error) {
        console.error(`Error processing goods receipt (supplier: ${row.supplier_name}):`, error);
        throw error;
      }
    }

    // Batch insert goods receipts
    await goodsReceiptsService.batchInsert(userId, receipts, uploadFileId);
    
    return receipts.length;
  };

  /**
   * Save price history to database
   * @param {string} userId - User ID
   * @param {Array} validRows - Validated valid data
   * @param {string} uploadFileId - Upload file ID
   * @param {string} batchId - Import batch ID
   * @returns {number} Number of records successfully saved
   */
  const savePriceHistory = async (userId, validRows, uploadFileId, batchId) => {
    const prices = [];

    for (const row of validRows) {
      try {
        // 1. Create or get supplier
        const supplier = await suppliersService.findOrCreate(userId, {
          supplier_name: row.supplier_name,
          supplier_code: row.supplier_code || null
        });

        // 2. Create or get material
        const material = await materialsService.findOrCreate(userId, {
          material_code: row.material_code,
          material_name: row.material_name || row.material_code
        });

        // 3. Build price history payload
        prices.push({
          user_id: userId,
          supplier_id: supplier.id,
          material_id: material.id,
          order_date: row.order_date,
          unit_price: row.unit_price,
          currency: row.currency || 'USD',
          quantity: row.quantity || 0,
          is_contract_price: row.is_contract_price || false,
          upload_file_id: uploadFileId,
          batch_id: batchId
        });
      } catch (error) {
        console.error(`Error processing price history (supplier: ${row.supplier_name}, material: ${row.material_code}):`, error);
        throw error;
      }
    }

    // Batch insert price history
    await priceHistoryService.batchInsert(userId, prices, uploadFileId);
    
    return prices.length;
  };

  /**
   * Save supplier master data to database
   * @param {string} userId - User ID
   * @param {Array} validRows - Validated valid data
   * @param {string} batchId - Import batch ID
   * @returns {number} Number of records successfully saved
   */
  const saveSuppliers = async (userId, validRows, batchId) => {
    const suppliers = validRows.map(row => ({
      user_id: userId,
      supplier_name: row.supplier_name,
      supplier_code: row.supplier_code || null,
      contact_info: {
        contact_person: row.contact_person || null,
        phone: row.phone || null,
        email: row.email || null,
        address: row.address || null,
        product_category: row.product_category || null,
        payment_terms: row.payment_terms || null,
        delivery_time: row.delivery_time || null
      },
      status: row.status || 'active',
      batch_id: batchId
    }));

    // Batch insert suppliers
    await suppliersService.insertSuppliers(suppliers);
    
    return suppliers.length;
  };

  // Reset workflow
  const resetFlow = () => {
    setCurrentStep(1);
    setUploadType('');
    setFile(null);
    setFileName('');
    setRawRows([]);
    setColumns([]);
    setColumnMapping({});
    setValidationResult(null);
    setMappingComplete(false);
  };

  // Go back to previous step
  const goBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
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

      {/* Step 1 & 2: 選擇上傳類型 + 上傳檔案 (合併為單一畫面) */}
      {(currentStep === 1 || currentStep === 2) && (
        <Card>
          <div className="space-y-6">
            {/* Upload Type Selection */}
            <div className="space-y-3">
              <label className="block text-sm font-semibold">
                <span className="text-red-500">*</span> Select Upload Type
              </label>
              <select
                value={uploadType}
                onChange={(e) => {
                  setUploadType(e.target.value);
                  // Auto proceed to step 2 after selecting type
                  if (e.target.value && currentStep === 1) {
                    setCurrentStep(2);
                  }
                }}
                className="w-full px-4 py-3 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none text-base"
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
                  className="hidden"
                  disabled={!uploadType}
                />
                <Upload className={`w-12 h-12 mx-auto mb-4 ${uploadType ? 'text-blue-500' : 'text-slate-400'}`} />
                
                <Button 
                  onClick={() => {
                    if (!uploadType) {
                      addNotification("Please select upload type first", "error");
                      return;
                    }
                    fileInputRef.current?.click();
                  }} 
                  disabled={loading || !uploadType}
                  variant={uploadType ? "primary" : "secondary"}
                >
                  {loading ? 'Loading...' : uploadType ? 'Select File to Upload' : 'Please select upload type first'}
                </Button>
                
                <p className="text-sm text-slate-500 mt-2">
                  Supports .xlsx, .xls, .csv formats, max 10MB
                </p>
                
                {!uploadType && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-3 flex items-center justify-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Please select data type above first
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

      {/* Step 3: Field Mapping */}
      {currentStep === 3 && rawRows.length > 0 && UPLOAD_SCHEMAS[uploadType] && (
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
                        const field = UPLOAD_SCHEMAS[uploadType].fields.find(f => f.key === fieldKey);
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
                      {UPLOAD_SCHEMAS[uploadType].fields
                        .filter(f => f.required)
                        .map(field => (
                          <option key={field.key} value={field.key}>
                            {field.label} ({field.type})
                          </option>
                        ))}
                    </optgroup>

                    {/* Optional fields */}
                    <optgroup label="Optional Fields">
                      {UPLOAD_SCHEMAS[uploadType].fields
                        .filter(f => !f.required)
                        .map(field => (
                          <option key={field.key} value={field.key}>
                            {field.label} ({field.type})
                          </option>
                        ))}
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
                    {UPLOAD_SCHEMAS[uploadType].fields
                      .filter(f => f.required)
                      .map(field => (
                        <li key={field.key} className="text-blue-700 dark:text-blue-300 flex items-start gap-1">
                          <span className="text-red-500">•</span>
                          <span><strong>{field.label}</strong> - {field.description}</span>
                        </li>
                      ))}
                  </ul>
                </div>

                {/* Optional fields */}
                <div>
                  <p className="font-medium text-blue-800 dark:text-blue-200 mb-1">Optional Fields:</p>
                  <ul className="space-y-1">
                    {UPLOAD_SCHEMAS[uploadType].fields
                      .filter(f => !f.required)
                      .slice(0, 5)
                      .map(field => (
                        <li key={field.key} className="text-blue-700 dark:text-blue-300">
                          <strong>{field.label}</strong> - {field.description}
                        </li>
                      ))}
                    {UPLOAD_SCHEMAS[uploadType].fields.filter(f => !f.required).length > 5 && (
                      <li className="text-blue-600 dark:text-blue-400 italic">
                        ... and {UPLOAD_SCHEMAS[uploadType].fields.filter(f => !f.required).length - 5} more optional fields
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

            {/* Button Area */}
            <div className="flex justify-between items-center pt-2">
              <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                Back
              </Button>
              
              <div className="flex items-center gap-3">
                {mappingComplete ? (
                  <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Check className="w-4 h-4" />
                    Mapping Complete
                  </span>
                ) : (
                  <span className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-4 h-4" />
                    Please complete required field mapping
                  </span>
                )}
                
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

            {/* Statistics Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                <div className="text-3xl font-bold text-purple-600">{validationResult.stats.successRate}%</div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">Success Rate</div>
              </div>
            </div>

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

            {/* Button Area and Instructions */}
            <div className="space-y-3 pt-4 border-t dark:border-slate-700">
              {/* Instruction Text */}
              {validationResult.validRows.length > 0 && validationResult.errorRows.length > 0 && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <div className="flex items-start gap-2">
                    <Check className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="text-blue-900 dark:text-blue-100 font-medium mb-1">
                        Writing Valid Data Only
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

              {/* Button Row */}
              <div className="flex justify-between items-center">
                <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                  Back to Edit Mapping
                </Button>
                <div className="flex items-center gap-3">
                  {validationResult.validRows.length > 0 && validationResult.errorRows.length === 0 && (
                    <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                      ✓ All data valid, ready to save {validationResult.validRows.length} rows
                    </span>
                  )}
                  <Button
                    onClick={handleSave}
                    disabled={saving || validationResult.validRows.length === 0}
                    variant={validationResult.validRows.length > 0 ? "success" : "secondary"}
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
