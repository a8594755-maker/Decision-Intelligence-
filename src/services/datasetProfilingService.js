import { classifySheet, getClassificationReasons } from '../utils/sheetClassifier';
import UPLOAD_SCHEMAS, { validateFieldType } from '../utils/uploadSchemas';
import { getRequiredMappingStatus } from '../utils/requiredMappingStatus';
import { ruleBasedMapping } from '../utils/aiMappingHelper';
import { buildDatasetFingerprint, buildSheetsPayload, datasetFingerprintInternals } from '../utils/datasetFingerprint';
import { datasetProfilesService } from './datasetProfilesService';
import {
  buildExactMatchSourceToTargetMapping,
  mergeAuthoritativeMapping
} from '../utils/deterministicMapping';
import { detectTimeColumn, timeColumnDetectionInternals } from '../utils/timeColumnDetection';
import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService';

const { normalizeHeader } = datasetFingerprintInternals;
const MAX_STATS_ROWS = 500;
const MAX_MINIMAL_QUESTIONS = 2;

const SUPPLY_TYPES = new Set(['demand_fg', 'bom_edge', 'po_open_lines', 'inventory_snapshots']);
const PROCUREMENT_TYPES = new Set(['goods_receipt', 'price_history', 'supplier_master']);
const FINANCE_TYPES = new Set(['fg_financials', 'operational_costs']);

const normalizeSheetKey = (name) => String(name || '').trim().toLowerCase();

const rowToObject = (row, columns) => {
  if (row && typeof row === 'object' && !Array.isArray(row)) return row;
  if (!Array.isArray(row)) return {};

  const mapped = {};
  columns.forEach((column, index) => {
    mapped[column] = row[index] ?? '';
  });
  return mapped;
};

const materializeRows = (sheet, columns) => {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  return rows.map((row) => rowToObject(row, columns));
};

const asNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const detectColumnType = (values) => {
  if (!values.length) return 'unknown';

  let numberHits = 0;
  let dateHits = 0;
  let booleanHits = 0;

  values.forEach((value) => {
    if (asNumber(value) !== null) numberHits += 1;
    if (timeColumnDetectionInternals.parseTemporalValue(value, { allowExcelSerial: false })) {
      dateHits += 1;
    }

    if (typeof value === 'boolean') {
      booleanHits += 1;
      return;
    }
    const lower = String(value).trim().toLowerCase();
    if (['true', 'false', 'yes', 'no', '0', '1'].includes(lower)) {
      booleanHits += 1;
    }
  });

  const total = values.length;
  if (dateHits / total >= 0.7) return 'date';
  if (numberHits / total >= 0.8) return 'number';
  if (booleanHits / total >= 0.8) return 'boolean';
  return 'string';
};

const buildColumnSemantics = (columns, rows) => {
  return columns.slice(0, 30).map((column) => {
    const values = rows
      .slice(0, 120)
      .map((row) => row[column])
      .filter((value) => value !== '' && value !== null && value !== undefined);

    return {
      column,
      normalized: normalizeHeader(column),
      guessed_type: detectColumnType(values),
      non_null_ratio: rows.length > 0
        ? Number((values.length / rows.slice(0, 120).length).toFixed(3))
        : 0
    };
  });
};

const buildQualityChecks = ({ columns, rows, uploadType, sourceToTargetMap }) => {
  const sampledRows = rows.slice(0, MAX_STATS_ROWS);
  const totalCells = sampledRows.length * Math.max(columns.length, 1);
  let emptyCells = 0;
  const missingnessByColumn = {};

  columns.forEach((column) => {
    let columnEmpty = 0;
    sampledRows.forEach((row) => {
      const value = row[column];
      if (value === null || value === undefined || value === '') {
        emptyCells += 1;
        columnEmpty += 1;
      }
    });
    missingnessByColumn[column] = sampledRows.length > 0
      ? Number((columnEmpty / sampledRows.length).toFixed(4))
      : 0;
  });

  const missingness = totalCells > 0 ? Number((emptyCells / totalCells).toFixed(4)) : 0;

  const rangeAnomalies = [];
  columns.forEach((column) => {
    const normalized = normalizeHeader(column);
    if (!/(qty|quantity|price|cost|amount|rate|margin|hours|output|stock|demand|open)/.test(normalized)) {
      return;
    }
    const negatives = sampledRows
      .map((row) => asNumber(row[column]))
      .filter((v) => v !== null && v < 0).length;
    if (negatives > 0) {
      rangeAnomalies.push({ column, negatives });
    }
  });

  const typeIssues = [];
  if (uploadType && UPLOAD_SCHEMAS[uploadType]) {
    const schemaByKey = new Map(UPLOAD_SCHEMAS[uploadType].fields.map((field) => [field.key, field]));
    Object.entries(sourceToTargetMap || {}).forEach(([sourceColumn, targetField]) => {
      const field = schemaByKey.get(targetField);
      if (!field) return;

      let checked = 0;
      let invalid = 0;
      sampledRows.forEach((row) => {
        const value = row[sourceColumn];
        if (value === null || value === undefined || value === '') return;
        checked += 1;
        const result = validateFieldType(value, field.type);
        if (!result.valid) invalid += 1;
      });

      if (checked > 0 && invalid > 0) {
        typeIssues.push({
          source_column: sourceColumn,
          target_field: targetField,
          invalid_ratio: Number((invalid / checked).toFixed(3))
        });
      }
    });
  }

  const duplicateRisk = (() => {
    if (!uploadType || !UPLOAD_SCHEMAS[uploadType] || sampledRows.length < 2) {
      return { level: 'unknown', key_columns: [], duplicate_ratio: 0 };
    }

    const requiredFields = UPLOAD_SCHEMAS[uploadType].fields
      .filter((field) => field.required)
      .map((field) => field.key);

    const mappedColumns = requiredFields
      .map((targetField) => Object.entries(sourceToTargetMap || {}).find(([, target]) => target === targetField)?.[0])
      .filter(Boolean);

    if (mappedColumns.length === 0) {
      return { level: 'unknown', key_columns: [], duplicate_ratio: 0 };
    }

    const seen = new Set();
    let duplicates = 0;
    sampledRows.forEach((row) => {
      const key = mappedColumns.map((column) => String(row[column] ?? '')).join('|');
      if (seen.has(key)) {
        duplicates += 1;
      } else {
        seen.add(key);
      }
    });

    const duplicateRatio = Number((duplicates / sampledRows.length).toFixed(4));
    let level = 'low';
    if (duplicateRatio > 0.2) level = 'high';
    else if (duplicateRatio > 0.05) level = 'medium';

    return { level, key_columns: mappedColumns, duplicate_ratio: duplicateRatio };
  })();

  return {
    missingness,
    missingness_by_column: missingnessByColumn,
    negative_number_columns: rangeAnomalies.map((item) => item.column),
    type_issues: typeIssues,
    duplicates_risk: duplicateRisk,
    range_anomalies: rangeAnomalies
  };
};

const invertMapping = (sourceToTargetMap = {}) => {
  const targetToSource = {};
  Object.entries(sourceToTargetMap).forEach(([source, target]) => {
    if (target) targetToSource[target] = source;
  });
  return targetToSource;
};

const inferWorkflowGuess = (sheetSummaries) => {
  let supplyCount = 0;
  let procurementCount = 0;
  let financeCount = 0;
  let confidenceSum = 0;
  const roles = new Set();

  sheetSummaries.forEach((sheet) => {
    confidenceSum += Number(sheet.confidence || 0);
    roles.add(String(sheet.likely_role || '').toLowerCase());
    if (SUPPLY_TYPES.has(sheet.likely_role)) supplyCount += 1;
    if (PROCUREMENT_TYPES.has(sheet.likely_role)) procurementCount += 1;
    if (FINANCE_TYPES.has(sheet.likely_role)) financeCount += 1;
  });

  const totalSheets = Math.max(1, sheetSummaries.length);
  const avgConfidence = confidenceSum / totalSheets;

  if (roles.has('po_open_lines') && roles.has('goods_receipt')) {
    return {
      label: 'B',
      confidence: Number(Math.min(0.98, (avgConfidence * 0.55) + 0.35).toFixed(3)),
      reason: 'PO open lines and goods receipt pattern indicates risk/delay workflow'
    };
  }

  const maxCount = Math.max(supplyCount, procurementCount, financeCount);

  if (maxCount === 0) {
    return {
      label: 'unknown',
      confidence: Number(Math.min(0.6, avgConfidence).toFixed(3)),
      reason: 'No dominant known upload type family detected'
    };
  }

  const ratio = maxCount / totalSheets;
  const confidence = Number(Math.min(0.98, (ratio * 0.7) + (avgConfidence * 0.3)).toFixed(3));
  const label = supplyCount === maxCount ? 'A' : procurementCount === maxCount ? 'B' : 'C';
  const reason = label === 'A'
    ? 'Supply planning sheets are dominant'
    : label === 'B'
      ? 'Supplier/procurement sheets are dominant'
      : 'Financial/cost sheets are dominant';

  return { label, confidence, reason };
};

const validateLlmProfile = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return null;

  const safe = {
    workflow_guess: null,
    minimal_questions: [],
    sheet_notes: []
  };

  const wf = candidate?.global?.workflow_guess || candidate?.workflow_guess;
  const workflowLabel = wf?.workflow || wf?.label;
  if (wf && typeof wf === 'object' && ['A', 'B', 'C', 'unknown'].includes(workflowLabel)) {
    const conf = Number(wf.confidence);
    safe.workflow_guess = {
      label: workflowLabel,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      reason: String(wf.reason || '').slice(0, 240)
    };
  }

  const minimalQuestions = candidate?.global?.minimal_questions || candidate?.minimal_questions;
  if (Array.isArray(minimalQuestions)) {
    safe.minimal_questions = minimalQuestions
      .map((q) => {
        if (typeof q === 'string') return q.trim();
        if (q && typeof q === 'object' && q.question) return String(q.question).trim();
        return '';
      })
      .filter(Boolean)
      .slice(0, MAX_MINIMAL_QUESTIONS);
  }

  const sheetCandidates = Array.isArray(candidate?.sheets)
    ? candidate.sheets
    : (Array.isArray(candidate?.sheet_notes) ? candidate.sheet_notes : []);

  if (Array.isArray(sheetCandidates)) {
    safe.sheet_notes = sheetCandidates
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const notesValue = Array.isArray(item.notes) ? item.notes.join('; ') : item.notes;
        return {
          sheet_name: String(item.sheet_name || '').trim(),
          likely_role: String(item.likely_role || 'unknown').trim(),
          notes: String(notesValue || '').trim().slice(0, 300)
        };
      })
      .filter((item) => item.sheet_name)
      .slice(0, 20);
  }

  return safe;
};

const buildSchemaMappingPromptInput = ({ uploadType, columns, sampleRows }) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) return null;

  const toFieldContract = (field) => ({
    name: String(field?.key || ''),
    type: ['string', 'number', 'date', 'boolean'].includes(field?.type) ? field.type : 'string',
    description: String(field?.description || field?.label || field?.key || '')
  });

  const requiredFields = schema.fields
    .filter((field) => field.required)
    .map(toFieldContract)
    .filter((field) => field.name);

  const optionalFields = schema.fields
    .filter((field) => !field.required)
    .map(toFieldContract)
    .filter((field) => field.name);

  return {
    upload_type: uploadType,
    target_schema: {
      required_fields: requiredFields,
      optional_fields: optionalFields
    },
    input_columns: Array.isArray(columns) ? columns : [],
    sample_rows: Array.isArray(sampleRows) ? sampleRows.slice(0, 8) : []
  };
};

const parseSchemaMappingFromLlm = ({ candidate, uploadType, columns }) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema || !candidate || typeof candidate !== 'object') {
    return { mapping: {}, minimal_questions: [] };
  }

  const allowedTargets = new Set(schema.fields.map((field) => String(field.key || '')));
  const columnList = Array.isArray(columns) ? columns : [];
  const columnSet = new Set(columnList);
  const normalizedColumnLookup = new Map(
    columnList.map((column) => [normalizeHeader(column), column])
  );

  const bestByTarget = new Map();
  const mappingArray = Array.isArray(candidate.mapping) ? candidate.mapping : [];

  mappingArray.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const targetRaw = item.target_field ?? item.target;
    const sourceRaw = item.source_column ?? item.source;

    const target = typeof targetRaw === 'string' ? targetRaw.trim() : '';
    if (!target || !allowedTargets.has(target)) return;

    const rawSource = typeof sourceRaw === 'string' ? sourceRaw.trim() : '';
    if (!rawSource) return;

    const source = columnSet.has(rawSource)
      ? rawSource
      : (normalizedColumnLookup.get(normalizeHeader(rawSource)) || '');
    if (!source) return;

    const confidence = Number(item.confidence);
    const boundedConfidence = Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.5;

    const previous = bestByTarget.get(target);
    if (!previous || boundedConfidence > previous.confidence) {
      bestByTarget.set(target, { source, confidence: boundedConfidence });
    }
  });

  const mapping = {};
  bestByTarget.forEach((entry, target) => {
    mapping[entry.source] = target;
  });

  const minimalQuestions = Array.isArray(candidate.minimal_questions)
    ? candidate.minimal_questions
        .map((item) => (typeof item === 'string' ? item : item?.question))
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .slice(0, MAX_MINIMAL_QUESTIONS)
    : [];

  return {
    mapping,
    minimal_questions: minimalQuestions
  };
};

const toIsoDay = (dateObj) => dateObj ? dateObj.toISOString().slice(0, 10) : null;

export const summarizeDatasetProfileForChat = (profileRow) => {
  if (!profileRow?.profile_json) return '';

  const profile = profileRow.profile_json;
  const contract = profileRow.contract_json || {};
  const workflow = profile.global?.workflow_guess || {};
  const timeRange = profile.global?.time_range_guess || {};
  const sheetLines = (profile.sheets || [])
    .slice(0, 5)
    .map((sheet) => `${sheet.sheet_name}: role=${sheet.likely_role || 'unknown'} (${Math.round((sheet.confidence || 0) * 100)}%)`)
    .join('; ');

  const missing = (contract.datasets || [])
    .filter((dataset) => Array.isArray(dataset.missing_required_fields) && dataset.missing_required_fields.length > 0)
    .map((dataset) => `${dataset.sheet_name}: ${dataset.missing_required_fields.join(', ')}`)
    .join('; ');

  return [
    `Dataset Profile #${profileRow.id}`,
    `Workflow guess: ${workflow.label || 'unknown'} (${Math.round((workflow.confidence || 0) * 100)}%)`,
    `Time range: ${timeRange.start || 'unknown'} to ${timeRange.end || 'unknown'}`,
    `Sheets: ${sheetLines || 'none'}`,
    missing ? `Missing required fields: ${missing}` : 'Required fields: complete or not applicable'
  ].join('\n');
};

/**
 * Build + persist dataset profile row.
 * Does not throw on LLM parse errors; deterministic profile is always kept.
 */
export const createDatasetProfileFromSheets = async ({
  userId,
  userFileId = null,
  fileName = '',
  sheetsRaw = [],
  mappingPlans = [],
  allowLLM = true
}) => {
  if (!userId) throw new Error('userId is required');
  const payloadSheets = buildSheetsPayload(sheetsRaw);
  if (payloadSheets.length === 0) throw new Error('No sheets to profile');

  const rawSheetMap = new Map(
    (Array.isArray(sheetsRaw) ? sheetsRaw : []).map((sheet, index) => [
      normalizeSheetKey(sheet.sheet_name || sheet.sheetName || `Sheet${index + 1}`),
      sheet
    ])
  );
  const mappingMap = new Map(
    (Array.isArray(mappingPlans) ? mappingPlans : []).map((plan) => [
      normalizeSheetKey(plan.sheet_name || plan.sheetName),
      plan
    ])
  );

  const sheetSummaries = [];
  const contractDatasets = [];
  const globalTimeRanges = [];
  const llmPromptQuestions = [];

  for (const sheetPayload of payloadSheets) {
    const sheetName = sheetPayload.sheet_name;
    const columns = Array.isArray(sheetPayload.columns) ? sheetPayload.columns : [];
    const rawSheet = rawSheetMap.get(normalizeSheetKey(sheetName)) || {};
    const rows = materializeRows(rawSheet, columns);
    const sampleRows = rows.length > 0 ? rows.slice(0, 50) : sheetPayload.sample_rows;
    const classification = classifySheet({ sheetName, headers: columns, sampleRows });
    const mappingPlan = mappingMap.get(normalizeSheetKey(sheetName)) || {};

    const likelyRole = mappingPlan.upload_type || classification.suggestedType || 'unknown';
    const confidence = Number.isFinite(mappingPlan.confidence)
      ? Math.max(0, Math.min(1, mappingPlan.confidence))
      : Number(classification.confidence || 0);
    const sourceToTargetMap = mappingPlan.mapping || mappingPlan.mappingDraft || mappingPlan.mappingFinal || {};
    const exactMatchMapping = buildExactMatchSourceToTargetMapping({
      uploadType: likelyRole,
      columns,
      includeOptional: true
    });
    const mergedPlanMapping = mergeAuthoritativeMapping({
      authoritativeMapping: exactMatchMapping,
      fallbackMapping: sourceToTargetMap,
      uploadType: likelyRole,
      columns
    });

    let finalSourceToTargetMap = mergedPlanMapping;
    const exactStatus = getRequiredMappingStatus({
      uploadType: likelyRole,
      columns,
      columnMapping: exactMatchMapping
    });
    if (likelyRole && UPLOAD_SCHEMAS[likelyRole] && !exactStatus.isComplete) {
      const suggestions = ruleBasedMapping(columns, likelyRole, UPLOAD_SCHEMAS[likelyRole].fields)
        .filter((item) => item?.source && item?.target && Number(item.confidence || 0) >= 0.7);
      const fallbackFromRules = suggestions.reduce((acc, item) => {
        if (!item.source || !item.target) return acc;
        acc[item.source] = item.target;
        return acc;
      }, {});
      finalSourceToTargetMap = mergeAuthoritativeMapping({
        authoritativeMapping: mergedPlanMapping,
        fallbackMapping: fallbackFromRules,
        uploadType: likelyRole,
        columns
      });
    }

    if (allowLLM && likelyRole && UPLOAD_SCHEMAS[likelyRole]) {
      const mappingStatusBeforeLlm = getRequiredMappingStatus({
        uploadType: likelyRole,
        columns,
        columnMapping: finalSourceToTargetMap
      });

      if (!mappingStatusBeforeLlm.isComplete) {
        try {
          const mappingPromptInput = buildSchemaMappingPromptInput({
            uploadType: likelyRole,
            columns,
            sampleRows
          });
          if (mappingPromptInput) {
            const llmMappingResult = await runDiPrompt({
              promptId: DI_PROMPT_IDS.SCHEMA_MAPPING,
              input: mappingPromptInput,
              temperature: 0.1,
              maxOutputTokens: 1800
            });

            const safeLlmMapping = parseSchemaMappingFromLlm({
              candidate: llmMappingResult.parsed,
              uploadType: likelyRole,
              columns
            });

            if (Object.keys(safeLlmMapping.mapping).length > 0) {
              finalSourceToTargetMap = mergeAuthoritativeMapping({
                authoritativeMapping: finalSourceToTargetMap,
                fallbackMapping: safeLlmMapping.mapping,
                uploadType: likelyRole,
                columns
              });
            }

            if (safeLlmMapping.minimal_questions.length > 0) {
              llmPromptQuestions.push(...safeLlmMapping.minimal_questions);
            }
          }
        } catch (error) {
          console.warn(`[datasetProfilingService] Prompt 2 mapping skipped for "${sheetName}":`, error.message);
        }
      }
    }

    const timeInfo = detectTimeColumn({ columns, rows, maxRows: MAX_STATS_ROWS });
    if (timeInfo.start || timeInfo.end) {
      globalTimeRanges.push(timeInfo);
    }

    const qualityChecks = buildQualityChecks({
      columns,
      rows,
      uploadType: likelyRole,
      sourceToTargetMap: finalSourceToTargetMap
    });
    const reasons = classification.reasons?.length
      ? classification.reasons
      : getClassificationReasons(classification);

    const sheetSummary = {
      sheet_name: sheetName,
      likely_role: likelyRole,
      confidence: Number(confidence.toFixed(3)),
      original_headers: columns,
      normalized_headers: columns.map(normalizeHeader),
      grain_guess: {
        keys: Object.keys(invertMapping(finalSourceToTargetMap)).slice(0, 4),
        time_column: timeInfo.name || null,
        granularity: timeInfo.granularity || 'unknown'
      },
      column_semantics: buildColumnSemantics(columns, rows),
      quality_checks: qualityChecks,
      notes: reasons.slice(0, 4)
    };
    sheetSummaries.push(sheetSummary);

    let requiredCoverage = 0;
    let missingRequired = [];
    let validationStatus = 'fail';
    const validationReasons = [];

    if (likelyRole && UPLOAD_SCHEMAS[likelyRole]) {
      const mappingStatus = getRequiredMappingStatus({
        uploadType: likelyRole,
        columns,
        columnMapping: finalSourceToTargetMap
      });
      requiredCoverage = Number((mappingStatus.coverage || 0).toFixed(3));
      missingRequired = mappingStatus.missingRequired || [];
      validationStatus = mappingStatus.isComplete ? 'pass' : 'fail';
      if (!mappingStatus.isComplete) {
        validationReasons.push(`Missing required fields: ${missingRequired.join(', ')}`);
      }
    } else {
      validationReasons.push('Unknown upload type for schema contract validation');
    }

    if (qualityChecks.type_issues.length > 0) {
      validationReasons.push(`Type issues detected in ${qualityChecks.type_issues.length} mapped fields`);
    }

    contractDatasets.push({
      sheet_name: sheetName,
      upload_type: likelyRole,
      mapping: invertMapping(finalSourceToTargetMap),
      requiredCoverage,
      missing_required_fields: missingRequired,
      validation: {
        status: validationStatus,
        reasons: validationReasons
      }
    });

    if (likelyRole && UPLOAD_SCHEMAS[likelyRole]) {
      const requiredFields = UPLOAD_SCHEMAS[likelyRole].fields
        .filter((field) => field.required)
        .map((field) => field.key);
      // Temporary contract-mapping instrumentation.
      console.info('[DI contract debug]', {
        sheet: sheetName,
        upload_type: likelyRole,
        input_columns: columns,
        normalized_columns: columns.map((col) => normalizeHeader(col)),
        required_fields: requiredFields,
        final_mapping: finalSourceToTargetMap,
        requiredCoverage
      });
    }
  }

  const workflowGuess = inferWorkflowGuess(sheetSummaries);
  const startDate = globalTimeRanges
    .map((item) => item.start)
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  const endDate = globalTimeRanges
    .map((item) => item.end)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  const profileJson = {
    file_name: fileName || null,
    global: {
      workflow_guess: workflowGuess,
      time_range_guess: {
        start: toIsoDay(startDate),
        end: toIsoDay(endDate)
      },
      minimal_questions: []
    },
    sheets: sheetSummaries
  };

  const contractStatusPass = contractDatasets.length > 0 && contractDatasets.every((item) => item.validation.status === 'pass');
  const coverageValues = contractDatasets.map((item) => item.requiredCoverage).filter((value) => Number.isFinite(value));
  const requiredCoverage = coverageValues.length > 0
    ? Number((coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length).toFixed(3))
    : 0;

  const contractJson = {
    datasets: contractDatasets,
    requiredCoverage,
    missing_required_fields: contractDatasets
      .filter((item) => item.missing_required_fields.length > 0)
      .map((item) => ({
        sheet_name: item.sheet_name,
        fields: item.missing_required_fields
      })),
    validation: {
      status: contractStatusPass ? 'pass' : 'fail',
      reasons: contractStatusPass ? [] : ['One or more sheets failed required field coverage']
    }
  };

  if (!contractStatusPass) {
    profileJson.global.minimal_questions.push('Please confirm mappings for sheets with missing required fields.');
  }
  if (workflowGuess.label === 'unknown') {
    profileJson.global.minimal_questions.push('What business workflow should this dataset support (A/B/C)?');
  }
  if (llmPromptQuestions.length > 0) {
    profileJson.global.minimal_questions.push(...llmPromptQuestions);
  }

  const lowConfidence = sheetSummaries.every((sheet) => (sheet.confidence || 0) < 0.65) || workflowGuess.label === 'unknown';
  if (allowLLM && lowConfidence) {
    try {
      const llmProfileResult = await runDiPrompt({
        promptId: DI_PROMPT_IDS.DATA_PROFILER,
        input: { sheets: payloadSheets },
        temperature: 0.1,
        maxOutputTokens: 2600
      });
      const safe = validateLlmProfile(llmProfileResult.parsed);

      if (safe?.workflow_guess && (profileJson.global.workflow_guess.label === 'unknown' || profileJson.global.workflow_guess.confidence < 0.6)) {
        profileJson.global.workflow_guess = safe.workflow_guess;
      }

      if (safe?.minimal_questions?.length > 0) {
        const mergedQuestions = new Set([
          ...(profileJson.global.minimal_questions || []),
          ...safe.minimal_questions
        ]);
        profileJson.global.minimal_questions = Array.from(mergedQuestions).slice(0, MAX_MINIMAL_QUESTIONS);
      }

      if (safe?.sheet_notes?.length > 0) {
        safe.sheet_notes.forEach((note) => {
          const sheet = profileJson.sheets.find((item) => normalizeSheetKey(item.sheet_name) === normalizeSheetKey(note.sheet_name));
          if (sheet && note.notes) {
            sheet.notes = [...(sheet.notes || []), note.notes].slice(0, 6);
          }
        });
      }
    } catch (error) {
      console.warn('[datasetProfilingService] LLM enrichment skipped:', error.message);
    }
  }

  profileJson.global.minimal_questions = Array.from(
    new Set(profileJson.global.minimal_questions || [])
  ).slice(0, MAX_MINIMAL_QUESTIONS);

  const fingerprint = buildDatasetFingerprint({
    sheets: profileJson.sheets.map((sheet) => ({
      sheet_name: sheet.sheet_name,
      columns: sheet.original_headers,
      inferred_type: sheet.likely_role,
      time_column_guess: sheet.grain_guess.time_column,
      time_granularity_guess: sheet.grain_guess.granularity
    }))
  });

  return datasetProfilesService.createDatasetProfile({
    user_id: userId,
    user_file_id: userFileId,
    fingerprint,
    profile_json: profileJson,
    contract_json: contractJson
  });
};

export default {
  createDatasetProfileFromSheets,
  summarizeDatasetProfileForChat
};
