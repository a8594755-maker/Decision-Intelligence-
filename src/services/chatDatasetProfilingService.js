import * as XLSX from 'xlsx';
import { classifySheet } from '../utils/sheetClassifier';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import { ruleBasedMapping, validateMappingResponse } from '../utils/aiMappingHelper';
import { getRequiredMappingStatus, validateColumnMapping } from '../utils/requiredMappingStatus';
import {
  buildExactMatchSourceToTargetMapping,
  mergeAuthoritativeMapping
} from '../utils/deterministicMapping';
import { summarizeDatasetProfileForChat } from './datasetProfilingService';

const MAX_SAMPLE_ROWS = 25;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MIN_MAPPING_CONFIDENCE = 0.7;
const DI_CONTRACT_DEBUG = import.meta.env.VITE_DI_CONTRACT_DEBUG === 'true';

function toBinaryString(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evt) => resolve(evt.target?.result || '');
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

function isSupportedFile(fileName = '') {
  const lower = String(fileName || '').toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.xls');
}

function assertUploadAllowed(file) {
  if (!file) throw new Error('No file selected');
  if (!isSupportedFile(file.name)) {
    throw new Error('Invalid file type. Please upload CSV or Excel files (.csv, .xlsx, .xls)');
  }
  if (Number(file.size || 0) > MAX_UPLOAD_BYTES) {
    throw new Error('Please upload aggregated data (e.g., SKU-store-day/week). Maximum 50MB.');
  }
}

function parseRowsFromSheet(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, { defval: '' });
}

function buildSourceToTargetMapping(headers, uploadType) {
  if (!uploadType || !UPLOAD_SCHEMAS[uploadType]) return {};
  const schema = UPLOAD_SCHEMAS[uploadType];
  const exactMapping = buildExactMatchSourceToTargetMapping({
    uploadType,
    columns: headers,
    includeOptional: true
  });
  const exactStatus = getRequiredMappingStatus({
    uploadType,
    columns: headers,
    columnMapping: exactMapping
  });

  if (exactStatus.isComplete) {
    return exactMapping;
  }

  const suggestions = ruleBasedMapping(headers, uploadType, schema.fields);
  const fallbackMapping = {};
  const usedTargets = new Set();
  suggestions.forEach((item) => {
    if (!item?.source || !item?.target) return;
    if (item.confidence < MIN_MAPPING_CONFIDENCE) return;
    if (usedTargets.has(item.target)) return;
    fallbackMapping[item.source] = item.target;
    usedTargets.add(item.target);
  });

  return mergeAuthoritativeMapping({
    authoritativeMapping: exactMapping,
    fallbackMapping,
    uploadType,
    columns: headers
  });
}

function buildBlockingQuestions(sheetPlans) {
  const lowConfidence = sheetPlans
    .filter((sheet) => (sheet.confidence || 0) < 0.65)
    .map((sheet) => sheet.sheet_name);

  const missingRequired = sheetPlans
    .filter((sheet) => (sheet.mapping_status?.missingRequired || []).length > 0)
    .map((sheet) => sheet.sheet_name);

  const questions = [];
  if (lowConfidence.length > 0) {
    questions.push(`Please confirm inferred upload types for: ${lowConfidence.slice(0, 3).join(', ')}.`);
  }
  if (missingRequired.length > 0) {
    questions.push(`Please map missing required fields for: ${missingRequired.slice(0, 3).join(', ')}.`);
  }

  return questions.slice(0, 2);
}

function guessWorkflowFromType(uploadType) {
  if (!uploadType || uploadType === 'unknown') return 'Unknown workflow';
  const supplyPlanningTypes = new Set([
    'bom_edge',
    'demand_fg',
    'po_open_lines',
    'inventory_snapshots',
    'fg_financials'
  ]);
  const supplierTypes = new Set(['supplier_master', 'goods_receipt', 'price_history']);

  if (supplyPlanningTypes.has(uploadType)) return 'Supply planning / risk workflow';
  if (supplierTypes.has(uploadType)) return 'Supplier management workflow';
  if (uploadType === 'operational_costs') return 'Cost analysis workflow';
  return `Workflow for ${uploadType}`;
}

function buildValidation(sheets) {
  const nonEmptySheets = sheets.filter(sheet => sheet.rowCount > 0);
  const reasons = [];

  if (nonEmptySheets.length === 0) {
    return {
      passed: false,
      status: 'fail',
      reasons: ['No non-empty sheets were found in the uploaded file']
    };
  }

  nonEmptySheets.forEach((sheet) => {
    if (!sheet.suggestedType) {
      reasons.push(`${sheet.sheetName}: unable to classify sheet type`);
      return;
    }
    if (!sheet.mappingStatus?.isComplete) {
      reasons.push(
        `${sheet.sheetName}: missing required fields (${sheet.mappingStatus?.missingRequired?.join(', ') || 'unknown'})`
      );
    }
    if (!sheet.mappingValidation?.valid) {
      reasons.push(`${sheet.sheetName}: invalid schema mapping`);
    }
  });

  if (reasons.length === 0) {
    reasons.push('All classified sheets have complete required-field coverage');
  }

  return {
    passed: reasons.length === 1 && reasons[0].startsWith('All classified sheets'),
    status: reasons.length === 1 && reasons[0].startsWith('All classified sheets') ? 'pass' : 'fail',
    reasons
  };
}

/**
 * Parse chat-uploaded CSV/XLSX and build deterministic sheet payload + mapping plans.
 */
export async function prepareChatUploadFromFile(file) {
  assertUploadAllowed(file);

  const binary = await toBinaryString(file);
  const workbook = XLSX.read(binary, { type: 'binary' });

  const sheetsRaw = [];
  const mappingPlans = [];
  const rawRowsForStorage = [];
  const sheetPlans = [];

  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = parseRowsFromSheet(worksheet);
    const headers = Object.keys(rows[0] || {});
    const sampleRows = rows.slice(0, MAX_SAMPLE_ROWS);
    const classification = rows.length > 0
      ? classifySheet({ sheetName, headers, sampleRows })
      : { suggestedType: null, confidence: 0, candidates: [] };

    const uploadType = classification.suggestedType || 'unknown';
    const mapping = buildSourceToTargetMapping(headers, classification.suggestedType);
    const mappingStatus = classification.suggestedType
      ? getRequiredMappingStatus({
          uploadType: classification.suggestedType,
          columns: headers,
          columnMapping: mapping
        })
      : {
          missingRequired: [],
          isComplete: false,
          coverage: 0,
          mappedRequired: []
        };

    sheetsRaw.push({
      sheet_name: sheetName,
      columns: headers,
      rows,
      row_count_estimate: rows.length
    });

    mappingPlans.push({
      sheet_name: sheetName,
      upload_type: uploadType,
      confidence: classification.confidence || 0,
      mapping,
      candidates: (classification.candidates || [])
        .slice(0, 5)
        .map((candidate) => ({
          upload_type: candidate.uploadType || 'unknown',
          confidence: Number(candidate.confidence || 0),
          evidence: candidate.evidence || null
        }))
    });

    if (DI_CONTRACT_DEBUG && classification.suggestedType && UPLOAD_SCHEMAS[classification.suggestedType]) {
      const requiredFields = UPLOAD_SCHEMAS[classification.suggestedType].fields
        .filter((field) => field.required)
        .map((field) => field.key);
      // Temporary contract-mapping instrumentation.
      console.info('[DI contract debug]', {
        sheet: sheetName,
        upload_type: classification.suggestedType,
        input_columns: headers,
        normalized_columns: headers.map((col) => String(col || '').trim().toLowerCase()),
        required_fields: requiredFields,
        final_mapping: mapping,
        requiredCoverage: Number((mappingStatus.coverage || 0).toFixed(4))
      });
    }

    sheetPlans.push({
      sheet_name: sheetName,
      upload_type: uploadType,
      confidence: classification.confidence || 0,
      mapping_status: mappingStatus
    });

    rows.forEach((row) => {
      rawRowsForStorage.push({ __sheet_name: sheetName, ...row });
    });
  });

  return {
    sheetsRaw,
    mappingPlans,
    rawRowsForStorage,
    blockingQuestions: buildBlockingQuestions(sheetPlans)
  };
}

/**
 * Parse multiple chat-uploaded files and merge into a single combined result.
 * Sheet names are prefixed with filename when multiple files to avoid collisions.
 * @param {File[]} files
 */
export async function prepareChatUploadFromFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files selected');
  }
  if (files.length === 1) return prepareChatUploadFromFile(files[0]);

  const totalSize = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  if (totalSize > MAX_UPLOAD_BYTES) {
    throw new Error(`Total file size (${Math.round(totalSize / 1024 / 1024)}MB) exceeds 50MB limit.`);
  }

  const results = await Promise.all(files.map((f) => prepareChatUploadFromFile(f)));

  const prefixSheet = (entry, fileName) => ({
    ...entry,
    sheet_name: `${fileName}::${entry.sheet_name}`
  });

  return {
    sheetsRaw: results.flatMap((r, i) =>
      r.sheetsRaw.map((s) => prefixSheet(s, files[i].name))
    ),
    mappingPlans: results.flatMap((r, i) =>
      r.mappingPlans.map((p) => prefixSheet(p, files[i].name))
    ),
    rawRowsForStorage: results.flatMap((r, i) =>
      r.rawRowsForStorage.map((row) => ({
        ...row,
        __sheet_name: `${files[i].name}::${row.__sheet_name || 'Sheet1'}`
      }))
    ),
    blockingQuestions: [...new Set(results.flatMap((r) => r.blockingQuestions))]
  };
}

export async function buildDatasetArtifactsFromFile(file) {
  assertUploadAllowed(file);

  const binary = await toBinaryString(file);
  const workbook = XLSX.read(binary, { type: 'binary' });
  const sheets = [];
  const rawRowsForStorage = [];

  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = parseRowsFromSheet(worksheet);
    const headers = Object.keys(rows[0] || {});
    const sampleRows = rows.slice(0, MAX_SAMPLE_ROWS);
    const classification = rows.length > 0
      ? classifySheet({ sheetName, headers, sampleRows })
      : { suggestedType: null, confidence: 0, candidates: [] };

    const suggestedType = classification.suggestedType;
    const mapping = buildSourceToTargetMapping(headers, suggestedType);
    const mappingStatus = suggestedType
      ? getRequiredMappingStatus({
          uploadType: suggestedType,
          columns: headers,
          columnMapping: mapping
        })
      : { missingRequired: [], isComplete: false, coverage: 0, mappedRequired: [] };
    const mappingValidation = suggestedType
      ? validateColumnMapping(suggestedType, mapping)
      : { valid: false, errors: ['Unknown or missing upload type'] };

    const mappingCandidates = suggestedType && UPLOAD_SCHEMAS[suggestedType]
      ? ruleBasedMapping(headers, suggestedType, UPLOAD_SCHEMAS[suggestedType].fields)
      : [];
    const mappingFormatPayload = { mappings: mappingCandidates };
    const mappingFormatValid = validateMappingResponse(mappingFormatPayload);

    sheets.push({
      sheetName,
      rowCount: rows.length,
      headers,
      sampleRows,
      suggestedType,
      confidence: classification.confidence || 0,
      mapping,
      mappingStatus,
      mappingValidation,
      mappingFormatValid
    });

    rows.forEach((row) => {
      rawRowsForStorage.push({ __sheet_name: sheetName, ...row });
    });
  });

  const ranked = [...sheets]
    .filter(sheet => sheet.suggestedType)
    .sort((a, b) => b.confidence - a.confidence);
  const workflowGuess = guessWorkflowFromType(ranked[0]?.suggestedType || 'unknown');
  const validation = buildValidation(sheets);

  const datasetProfile = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    file: {
      name: file.name,
      size: file.size,
      type: file.type
    },
    summary: {
      workflowGuess,
      totalSheets: sheets.length,
      nonEmptySheets: sheets.filter(sheet => sheet.rowCount > 0).length,
      totalRows: sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0)
    },
    sheets: sheets.map((sheet) => ({
      sheetName: sheet.sheetName,
      rowCount: sheet.rowCount,
      headers: sheet.headers,
      sampleRows: sheet.sampleRows,
      suggestedType: sheet.suggestedType,
      confidence: Number((sheet.confidence || 0).toFixed(4)),
      mapping: sheet.mapping,
      requiredCoverage: Number((sheet.mappingStatus?.coverage || 0).toFixed(4)),
      missingRequired: sheet.mappingStatus?.missingRequired || []
    }))
  };

  const schemaContract = {
    version: '1.0',
    generatedAt: datasetProfile.generatedAt,
    workflowGuess,
    fileName: file.name,
    sheets: sheets.map((sheet) => {
      const schema = sheet.suggestedType ? UPLOAD_SCHEMAS[sheet.suggestedType] : null;
      return {
        sheetName: sheet.sheetName,
        role: sheet.suggestedType,
        confidence: Number((sheet.confidence || 0).toFixed(4)),
        requiredFields: schema ? schema.fields.filter(field => field.required).map(field => field.key) : [],
        optionalFields: schema ? schema.fields.filter(field => !field.required).map(field => field.key) : [],
        mapping: sheet.mapping,
        missingRequired: sheet.mappingStatus?.missingRequired || [],
        requiredCoverage: Number((sheet.mappingStatus?.coverage || 0).toFixed(4))
      };
    })
  };

  return {
    workflowGuess,
    sheets,
    validation,
    datasetProfile,
    schemaContract,
    rawRowsForStorage
  };
}

/**
 * Convert persisted dataset profile row to chat card payload.
 */
export function buildDataSummaryCardPayload(profileRow) {
  const profile = profileRow?.profile_json || {};
  const contract = profileRow?.contract_json || {};
  const workflow = profile.global?.workflow_guess || {};
  const timeRange = profile.global?.time_range_guess || {};
  const contractBySheet = new Map(
    (contract.datasets || []).map((dataset) => [String(dataset.sheet_name || ''), dataset])
  );

  const sheets = (profile.sheets || []).map((sheet) => {
    const contractSheet = contractBySheet.get(String(sheet.sheet_name || '')) || {};
    return {
      sheet_name: sheet.sheet_name,
      upload_type: contractSheet.upload_type || sheet.likely_role || 'unknown',
      confidence: Number(sheet.confidence || 0),
      missing_required_fields: contractSheet.missing_required_fields || [],
      validation_status: contractSheet.validation?.status || 'fail',
      validation_reasons: contractSheet.validation?.reasons || []
    };
  });

  return {
    dataset_profile_id: profileRow?.id || null,
    user_file_id: profileRow?.user_file_id || null,
    fingerprint: profileRow?.fingerprint || null,
    workflow_guess: {
      label: workflow.label || 'unknown',
      confidence: Number(workflow.confidence || 0),
      reason: workflow.reason || ''
    },
    time_range_guess: {
      start: timeRange.start || null,
      end: timeRange.end || null
    },
    sheets,
    minimal_questions: (profile.global?.minimal_questions || []).slice(0, 2),
    profile_json: profile,
    contract_json: contract,
    context_summary: summarizeDatasetProfileForChat(profileRow)
  };
}

export default {
  prepareChatUploadFromFile,
  buildDataSummaryCardPayload,
  buildDatasetArtifactsFromFile
};
