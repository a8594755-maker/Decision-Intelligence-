/**
 * One-shot AI Suggest Service
 * Provides AI-powered suggestions for each sheet in One-shot Import
 */

import { callGeminiAPI } from './geminiAPI';
import { extractAiJson, generateMappingPrompt } from '../utils/aiMappingHelper';
import { classifySheet } from '../utils/sheetClassifier';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import { buildHeaderIndex, alignAiMappings, logHeaderStats, logMappingAlignStats } from '../utils/headerNormalize';
import { sendAgentLog } from '../utils/sendAgentLog';

/**
 * Generate prompt for AI uploadType recommendation
 * @param {Array} headers - Sheet columns
 * @param {Array} sampleRows - Sample data (max 30)
 * @returns {string} Prompt
 */
const generateUploadTypePrompt = (headers, sampleRows) => {
  const availableTypes = [
    'bom_edge', 'demand_fg', 'po_open_lines', 
    'inventory_snapshots', 'fg_financials', 'supplier_master'
  ];

  const typeDescriptions = {
    bom_edge: 'BOM Edge (parent_material, component_material, qty/usage_qty)',
    demand_fg: 'Demand FG (material_code, time_bucket, demand_qty)',
    po_open_lines: 'PO Open Lines (material_code, plant_id, open_qty, po_number)',
    inventory_snapshots: 'Inventory Snapshots (material_code, plant_id, on_hand_qty, available_qty)',
    fg_financials: 'FG Financials (material_code, profit_per_unit, margin_per_unit)',
    supplier_master: 'Supplier Master (supplier_name, supplier_code, contact_person)'
  };

  const firstRow = sampleRows[0] ? JSON.stringify(sampleRows[0]).slice(0, 300) : '{}';

  return `Classify this Excel sheet into ONE of these types: ${availableTypes.join(', ')}.

Headers: ${JSON.stringify(headers)}
Sample: ${firstRow}

Type Definitions:
${Object.entries(typeDescriptions).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Output JSON ONLY: {"suggestedType":"type_name","confidence":0.9,"reasons":["reason1","reason2"]}`;
};

const normalizeConfidence = (value, fallback = 0.5) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
};

const normalizeMappingItem = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const sourceCandidate = item.source_column ?? item.source ?? item.column ?? null;
  const targetCandidate = item.target_field ?? item.target ?? item.field ?? null;

  const source = typeof sourceCandidate === 'string' ? sourceCandidate.trim() : '';
  const target = typeof targetCandidate === 'string' ? targetCandidate.trim() : '';

  if (!source || !target) return null;

  return {
    source,
    target,
    confidence: normalizeConfidence(item.confidence, 0.5),
    reason: typeof item.reason === 'string' ? item.reason.trim() : ''
  };
};

const extractMappingsArray = (parsed) => {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;

  if (Array.isArray(parsed.mapping)) return parsed.mapping;
  if (Array.isArray(parsed.mappings)) return parsed.mappings;
  if (Array.isArray(parsed.columnMappings)) return parsed.columnMappings;
  if (Array.isArray(parsed.columnMapping)) return parsed.columnMapping;
  if (Array.isArray(parsed.fields)) return parsed.fields;

  const keys = Object.keys(parsed);
  if (keys.length === 1 && Array.isArray(parsed[keys[0]])) {
    return parsed[keys[0]];
  }

  return null;
};

/**
 * Robust parser for AI mapping response
 * Supports multiple response formats to avoid entire flow failing due to format issues
 * @param {any} aiResponse - Raw AI response data (could be object/array/string)
 * @returns {object} { ok: boolean, mappings: Array, error?: string }
 */
const parseAiMappingResponse = (aiResponse) => {
  console.log('[Robust Parser] Input type:', typeof aiResponse);
  
  // Strategy 1: Null check
  if (!aiResponse) {
    console.error('[Robust Parser] Empty response');
    return { ok: false, mappings: [], error: 'Empty AI response' };
  }

  let parsed = aiResponse;

  // Strategy 2: If string, try JSON.parse
  if (typeof aiResponse === 'string') {
    try {
      parsed = JSON.parse(aiResponse);
      console.log('[Robust Parser] Parsed from string');
    } catch (e) {
      console.error('[Robust Parser] Failed to parse string as JSON:', e.message);
      return { ok: false, mappings: [], error: 'Invalid JSON string' };
    }
  }

  const rawMappings = extractMappingsArray(parsed);
  if (!Array.isArray(rawMappings)) {
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
    console.error('[Robust Parser] Object format but no recognizable mappings array. Keys:', keys);
    return { ok: false, mappings: [], error: `Unrecognized object keys: ${keys.join(', ')}` };
  }

  const normalizedMappings = rawMappings
    .map(normalizeMappingItem)
    .filter(Boolean);

  console.log('[Robust Parser] Parsed mappings:', rawMappings.length, 'normalized:', normalizedMappings.length);

  if (normalizedMappings.length === 0) {
    return { ok: false, mappings: [], error: 'No valid mapping entries found' };
  }

  return { ok: true, mappings: normalizedMappings };
};

/**
 * Validate mappings array content
 * @param {Array} mappings
 * @returns {boolean}
 */
const validateMappings = (mappings) => {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return false;
  }

  // At least one mapping must have both source and target after normalization
  const hasValidMapping = mappings.some(m => 
    m && typeof m === 'object' && m.source && m.target
  );

  return hasValidMapping;
};

/**
 * Use LLM to suggest uploadType only (Step 1: Classification only)
 * @param {object} params
 * @param {Array<string>} params.headers - Sheet headers
 * @param {Array<object>} params.sampleRows - Sample data (first 30-50 rows)
 * @returns {Promise<object>} { suggestedType, confidence, reasons }
 */
export async function suggestSheetType({ headers, sampleRows }) {
  console.log(`[suggestSheetType] Starting classification`);
  console.log(`[suggestSheetType] Headers:`, headers);

  try {
    const prompt = generateUploadTypePrompt(headers, sampleRows.slice(0, 30));
    
    console.log(`[suggestSheetType] Calling AI for type classification...`);
    const aiResponse = await callGeminiAPI(prompt, '', { temperature: 0.3, maxOutputTokens: 500 });
    
    const extracted = extractAiJson(aiResponse);
    
    // Parse type suggestion
    if (!extracted || !extracted.suggestedType) {
      throw new Error('AI did not return a valid suggestedType');
    }
    
    const result = {
      suggestedType: extracted.suggestedType,
      confidence: extracted.confidence || 0.5,
      reasons: extracted.reasons || []
    };
    
    console.log(`[suggestSheetType] Result:`, result);
    return result;
    
  } catch (error) {
    console.error(`[suggestSheetType] Error:`, error);
    throw error;
  }
}

/**
 * Use LLM to suggest field mapping (mapping only, no uploadType classification)
 * @param {object} params
 * @param {string} params.uploadType - Target uploadType
 * @param {Array<string>} params.headers - Original header names (do not normalize)
 * @param {Array<object>} params.sampleRows - Sample data (first N rows)
 * @param {Array<string>} params.requiredFields - Canonical required fields
 * @param {Array<string>} params.optionalFields - Canonical optional fields
 * @param {Array<object>} params.schemaFields - Optional full schema field definitions
 * @returns {Promise<object>} { mappings, mappingConfidence, reasons }
 */
export async function suggestMappingWithLLM({
  uploadType,
  headers,
  sampleRows,
  requiredFields = [],
  optionalFields = [],
  schemaFields = null
}) {
  console.log(`[suggestMappingWithLLM] Starting for uploadType: ${uploadType}`);
  console.log(`[suggestMappingWithLLM] Headers:`, headers);
  console.log(`[suggestMappingWithLLM] Required fields:`, requiredFields);

  try {
    const schemaFieldList = Array.isArray(schemaFields) && schemaFields.length > 0
      ? schemaFields
      : [
          ...((requiredFields || []).map((name) => ({ key: name, type: 'string', required: true, description: '' }))),
          ...((optionalFields || []).map((name) => ({ key: name, type: 'string', required: false, description: '' })))
        ];

    const targetFields = schemaFieldList
      .map((field) => field?.key)
      .filter(Boolean);

    const prompt = generateMappingPrompt(uploadType, schemaFieldList, headers, sampleRows.slice(0, 8));

    console.log(`[suggestMappingWithLLM] Calling AI...`);
    const aiResponse = await callGeminiAPI(prompt, '', { temperature: 0.2, maxOutputTokens: 2000 });
    
    console.log(`[suggestMappingWithLLM] AI response length:`, aiResponse.length);
    
    // Use robust parser
    const extracted = extractAiJson(aiResponse);
    const parsed = parseAiMappingResponse(extracted);
    
    if (!parsed.ok) {
      throw new Error(`AI mapping format invalid: ${parsed.error}`);
    }

    const mappings = parsed.mappings;
    
    // Strictly validate each mapping
    const validMappings = [];
    const errors = [];
    
    mappings.forEach((m, idx) => {
      // Check required fields
      if (!m.source || !m.target) {
        errors.push(`Mapping ${idx}: missing source or target`);
        return;
      }
      
      // ✅ B) Remove strict headers.includes check
      // Because AI-returned source may have minor differences (case, whitespace, underscores, etc.)
      // Alignment is handled by alignAiMappings in handleAiFieldSuggestion
      // if (!headers.includes(m.source)) {
      //   errors.push(`Mapping ${idx}: source "${m.source}" not in headers`);
      //   return;
      // }
      
      // Check if target is in allowed fields
      if (!targetFields.includes(m.target)) {
        errors.push(`Mapping ${idx}: target "${m.target}" not in allowed fields`);
        return;
      }
      
      // Check confidence
      if (typeof m.confidence !== 'number' || m.confidence < 0 || m.confidence > 1) {
        errors.push(`Mapping ${idx}: invalid confidence ${m.confidence}`);
        return;
      }
      
      validMappings.push(m);
    });

    if (errors.length > 0) {
      console.warn('[suggestMappingWithLLM] Validation errors:', errors);
    }

    // Deduplicate: keep only highest confidence source for each target
    const targetMap = new Map();
    validMappings.forEach(m => {
      const existing = targetMap.get(m.target);
      if (!existing || m.confidence > existing.confidence) {
        targetMap.set(m.target, m);
      }
    });

    const deduplicatedMappings = Array.from(targetMap.values());
    
    console.log(`[suggestMappingWithLLM] Valid mappings: ${deduplicatedMappings.length}/${mappings.length}`);

    // Calculate mapping confidence (based on required fields coverage)
    const mappedRequiredCount = deduplicatedMappings.filter(m => 
      requiredFields.includes(m.target) && m.confidence >= 0.7
    ).length;
    const requiredCoverage = requiredFields.length > 0 
      ? mappedRequiredCount / requiredFields.length 
      : 1.0;

    const avgConfidence = deduplicatedMappings.length > 0
      ? deduplicatedMappings.reduce((sum, m) => sum + m.confidence, 0) / deduplicatedMappings.length
      : 0;

    const mappingConfidence = (requiredCoverage + avgConfidence) / 2;

    const reasons = [];
    if (Array.isArray(extracted?.reasons)) {
      extracted.reasons.forEach((reason) => reasons.push(String(reason)));
    }
    if (Array.isArray(extracted?.assumptions)) {
      extracted.assumptions.slice(0, 2).forEach((item) => reasons.push(`Assumption: ${String(item)}`));
    }
    if (Array.isArray(extracted?.missing_required_fields) && extracted.missing_required_fields.length > 0) {
      reasons.push(`Missing required fields: ${extracted.missing_required_fields.join(', ')}`);
    }
    if (Array.isArray(extracted?.minimal_questions) && extracted.minimal_questions.length > 0) {
      const q = extracted.minimal_questions[0];
      if (q?.question) {
        reasons.push(`Question: ${String(q.question)}`);
      }
    }
    if (reasons.length === 0) {
      reasons.push(
        `Mapped ${deduplicatedMappings.length} fields`,
        `Required coverage: ${Math.round(requiredCoverage * 100)}%`,
        `Average confidence: ${Math.round(avgConfidence * 100)}%`
      );
    }

    return {
      mappings: deduplicatedMappings,
      mappingConfidence,
      reasons
    };

  } catch (error) {
    console.error('[suggestMappingWithLLM] Failed:', error);
    return {
      mappings: [],
      mappingConfidence: 0,
      reasons: [`LLM mapping failed: ${error.message}`]
    };
  }
}

/**
 * Provide AI-powered suggestions for a single sheet (includes uploadType classification + mapping)
 * @param {object} params
 * @param {string} params.sheetName - Sheet name
 * @param {Array} params.headers - Column names
 * @param {Array} params.sampleRows - Sample data (max 30)
 * @param {string} params.currentUploadType - Currently selected uploadType (optional)
 * @param {boolean} params.hasIngestKeySupport - Whether DB supports chunk idempotency
 * @returns {Promise<object>} { suggestedUploadType, mapping, confidence, reasons, autoEnable }
 */
export async function suggestSheetMapping({
  sheetName,
  headers,
  sampleRows,
  currentUploadType = null,
  _hasIngestKeySupport = false
}) {
  try {
    console.log(`[AI Suggest] Starting for sheet: ${sheetName}`);
    console.log(`[AI Suggest] Headers:`, headers);
    console.log(`[AI Suggest] Sample rows:`, sampleRows.length);
    
    sendAgentLog({location:'oneShotAiSuggestService.js:suggestSheetMapping',message:'[Entry] suggestSheetMapping called',data:{sheetName,headers,headersCount:headers.length,currentUploadType},sessionId:'debug-session',hypothesisId:'A,B,D'});

    // Step 1: If no uploadType specified, use AI to recommend
    let uploadType = currentUploadType;
    let typeConfidence = 0;
    let typeReasons = [];

    if (!uploadType) {
      console.log('[AI Suggest] No uploadType specified, asking AI for suggestion...');
      
      // First use local classifier for quick screening
      const classifyResult = classifySheet({ sheetName, headers, sampleRows: sampleRows.slice(0, 20) });
      console.log('[AI Suggest] Local classifier result:', classifyResult);

      if (classifyResult.confidence >= 0.6) {
        // Local classifier is confident, use directly
        uploadType = classifyResult.suggestedType;
        typeConfidence = classifyResult.confidence;
        typeReasons = classifyResult.candidates
          .slice(0, 3)
          .map(c => `${c.uploadType} (${Math.round(c.confidence * 100)}%): ${c.reasons?.slice(0, 2).join(', ') || 'matched'}`);
        
        console.log('[AI Suggest] Using local classifier result:', uploadType);
      } else {
        // Local classifier confidence too low, call AI
        console.log('[AI Suggest] Local classifier confidence too low, calling AI...');
        
        const typePrompt = generateUploadTypePrompt(headers, sampleRows);
        const aiTypeResponse = await callGeminiAPI(typePrompt, '', { temperature: 0.3, maxOutputTokens: 500 });
        
        console.log('[AI Suggest] AI type response:', aiTypeResponse);
        
        const parsedType = extractAiJson(aiTypeResponse);
        console.log('[AI Suggest] Parsed type:', parsedType);
        
        if (parsedType.suggestedType && parsedType.confidence) {
          uploadType = parsedType.suggestedType;
          typeConfidence = parsedType.confidence;
          typeReasons = parsedType.reasons || ['AI suggested based on headers and sample data'];
        } else {
          throw new Error('AI failed to suggest uploadType with sufficient confidence');
        }
      }
    } else {
      // uploadType already specified, use directly
      typeConfidence = 1.0;
      typeReasons = ['User specified'];
      console.log('[AI Suggest] Using user-specified uploadType:', uploadType);
    }

    // Step 2: Get schema
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) {
      throw new Error(`Unknown uploadType: ${uploadType}`);
    }

    console.log('[AI Suggest] Schema fields:', schema.fields.length);

    // Step 3: Call AI to generate mapping
    const limitedSampleRows = sampleRows.slice(0, 30);
    const mappingPrompt = generateMappingPrompt(uploadType, schema.fields, headers, limitedSampleRows);
    
    console.log('[AI Suggest] Mapping prompt:', mappingPrompt.slice(0, 300) + '...');
    
    const aiMappingResponse = await callGeminiAPI(mappingPrompt, '', { temperature: 0.3, maxOutputTokens: 2000 });
    
    console.log('[AI Suggest] AI mapping response length:', aiMappingResponse.length);
    
    const extractedJson = extractAiJson(aiMappingResponse);
    console.log('[AI Suggest] Extracted JSON:', extractedJson);

    // Step 4: Use robust parser to parse mapping
    const parseResult = parseAiMappingResponse(extractedJson);
    
    if (!parseResult.ok) {
      console.error('[AI Suggest] Failed to parse mappings:', parseResult.error);
      // Don't throw, return failure result instead
      return {
        suggestedUploadType: uploadType,
        mapping: {},
        mappings: [],
        confidence: 0,
        reasons: [
          `AI response format incorrect: ${parseResult.error}`,
          'Please manually select Upload Type and adjust mapping'
        ],
        autoEnable: false,
        requiredCoverage: 0,
        error: parseResult.error
      };
    }

    const mappings = parseResult.mappings;
    console.log('[AI Suggest] Valid mappings:', mappings.length);
    
    sendAgentLog({location:'oneShotAiSuggestService.js:suggestSheetMapping',message:'[BEFORE alignment] AI mappings from LLM',data:{mappingsCount:mappings.length,aiMappings:mappings.slice(0,5).map(m=>({source:m.source,target:m.target,confidence:m.confidence})),allAiSources:mappings.map(m=>m.source)},sessionId:'debug-session',hypothesisId:'A,D'});

    // Step 4b: Validate mappings content
    if (!validateMappings(mappings)) {
      console.error('[AI Suggest] Mappings validation failed');
      return {
        suggestedUploadType: uploadType,
        mapping: {},
        mappings: [],
        confidence: 0,
        reasons: [
          'AI returned mappings content is invalid',
          'Please manually select Upload Type and adjust mapping'
        ],
        autoEnable: false,
        requiredCoverage: 0,
        error: 'Invalid mappings content'
      };
    }

    // Step 5: Calculate required fields coverage
    const requiredFields = schema.fields.filter(f => f.required).map(f => f.key);
    const mappedFields = mappings
      .filter(m => m.target && m.confidence >= 0.6)
      .map(m => m.target);
    
    const requiredCoverage = requiredFields.filter(rf => mappedFields.includes(rf)).length / requiredFields.length;
    
    console.log('[AI Suggest] Required fields:', requiredFields);
    console.log('[AI Suggest] Mapped fields (conf >= 0.6):', mappedFields);
    console.log('[AI Suggest] Required coverage:', requiredCoverage);

    // Step 6: Calculate overall confidence (combining type confidence and mapping confidence)
    const avgMappingConfidence = mappings.reduce((sum, m) => sum + (m.confidence || 0), 0) / mappings.length;
    const overallConfidence = (typeConfidence + avgMappingConfidence) / 2;

    console.log('[AI Suggest] Type confidence:', typeConfidence);
    console.log('[AI Suggest] Avg mapping confidence:', avgMappingConfidence);
    console.log('[AI Suggest] Overall confidence:', overallConfidence);

    // Step 7: Decide whether to auto-enable
    // Rule: confidence >= 0.75 AND required coverage >= 1.0 (both must be met)
    // Fix: requiredCoverage < 1.0 must not auto-enable (avoid incorrect import)
    let autoEnable = overallConfidence >= 0.75 && requiredCoverage >= 1.0;

    // Cannot determine row count here (caller needs to pass it), so assume caller will handle
    // But we can hint in reasons
    const reasons = [
      ...typeReasons,
      `Mapping confidence: ${Math.round(avgMappingConfidence * 100)}%`,
      `Required fields coverage: ${Math.round(requiredCoverage * 100)}%`,
      `Overall confidence: ${Math.round(overallConfidence * 100)}%`
    ];

    // Step 8: Use header normalization to align AI mappings to actual headers
    sendAgentLog({location:'oneShotAiSuggestService.js:suggestSheetMapping',message:'[BEFORE alignment] About to align AI mappings',data:{originalHeaders:headers,aiMappings:mappings.map(m=>({source:m.source,target:m.target,conf:m.confidence}))},sessionId:'debug-session',hypothesisId:'A,C'});
    
    // ✅ Use headerNormalize utility to align AI mappings
    const headerIndexResult = buildHeaderIndex(headers);
    logHeaderStats(headers, headerIndexResult);
    
    const alignResult = alignAiMappings(mappings, headerIndexResult.index);
    logMappingAlignStats(alignResult);
    
    // ✅ Use aligned mappings (source is now the actual originalHeader)
    const alignedMappings = alignResult.alignedMappings;
    
    const columnMapping = {};
    alignedMappings.forEach(m => {
      if (m.target && m.confidence >= 0.6) {
        // ✅ m.source is now the actual Excel header (from headerIndex)
        columnMapping[m.source] = m.target;
      }
    });
    
    sendAgentLog({location:'oneShotAiSuggestService.js:suggestSheetMapping',message:'[AFTER alignment] columnMapping built with aligned headers',data:{columnMapping,columnMappingKeys:Object.keys(columnMapping),alignedCount:alignedMappings.length,unmatchedCount:alignResult.unmatchedSources.length,unmatchedSources:alignResult.unmatchedSources,keysMatch:Object.keys(columnMapping).every(k=>headers.includes(k))},sessionId:'debug-session',hypothesisId:'A,C'});
    
    // ⚠️ Warning: if there are unmatched sources, log detailed info
    if (alignResult.unmatchedSources.length > 0) {
      console.warn('[AI Suggest] Some AI mappings could not be aligned to actual headers:');
      alignResult.unmatchedSources.forEach(unmatched => {
        console.warn(`  - AI source: "${unmatched.aiSource}" (normalized: "${unmatched.normalized}")`);
      });
      console.warn('Available headers (normalized):', Array.from(headerIndexResult.index.keys()));
    }

    console.log('[AI Suggest] Final result:', {
      suggestedUploadType: uploadType,
      confidence: overallConfidence,
      autoEnable,
      mappingCount: Object.keys(columnMapping).length
    });

    sendAgentLog({location:'oneShotAiSuggestService.js:suggestSheetMapping',message:'[Exit] suggestSheetMapping returning result',data:{uploadType,mappingKeysCount:Object.keys(columnMapping).length,requiredCoverage,confidence:overallConfidence,autoEnable,columnMappingSample:Object.entries(columnMapping).slice(0,3)},sessionId:'debug-session',hypothesisId:'A,E'});
    
    return {
      suggestedUploadType: uploadType,
      mapping: columnMapping,
      mappings: mappings, // Keep full mappings (with confidence)
      confidence: overallConfidence,
      reasons,
      autoEnable,
      requiredCoverage
    };

  } catch (error) {
    console.error('[AI Suggest] Failed:', error);
    
    // Don't throw directly, return error result instead (let caller decide how to handle)
    return {
      suggestedUploadType: null,
      mapping: {},
      mappings: [],
      confidence: 0,
      reasons: [
        `AI Suggest failed: ${error.message}`,
        'Please manually select Upload Type'
      ],
      autoEnable: false,
      requiredCoverage: 0,
      error: error.message
    };
  }
}

export default {
  suggestSheetMapping,
  suggestMappingWithLLM
};
