/**
 * One-shot AI Suggest Service
 * 為 One-shot Import 的每個 sheet 提供 AI 智能建議
 */

import { callGeminiAPI } from './geminiAPI';
import { extractAiJson, generateMappingPrompt } from '../utils/aiMappingHelper';
import { classifySheet } from '../utils/sheetClassifier';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import { normalizeHeader, buildHeaderIndex, alignAiMappings, logHeaderStats, logMappingAlignStats } from '../utils/headerNormalize';

/**
 * 生成 AI uploadType 推薦的 prompt
 * @param {Array} headers - Sheet 欄位
 * @param {Array} sampleRows - 樣本資料（最多30）
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

/**
 * Robust parser for AI mapping response
 * 支援多種回傳格式，避免因格式問題導致整個流程失敗
 * @param {any} aiResponse - AI 回傳的原始資料（可能是 object/array/string）
 * @returns {object} { ok: boolean, mappings: Array, error?: string }
 */
const parseAiMappingResponse = (aiResponse) => {
  console.log('[Robust Parser] Input type:', typeof aiResponse);
  
  // 策略 1: 空值檢查
  if (!aiResponse) {
    console.error('[Robust Parser] Empty response');
    return { ok: false, mappings: [], error: 'Empty AI response' };
  }

  let parsed = aiResponse;

  // 策略 2: 若是字串，嘗試 JSON.parse
  if (typeof aiResponse === 'string') {
    try {
      parsed = JSON.parse(aiResponse);
      console.log('[Robust Parser] Parsed from string');
    } catch (e) {
      console.error('[Robust Parser] Failed to parse string as JSON:', e.message);
      return { ok: false, mappings: [], error: 'Invalid JSON string' };
    }
  }

  // 策略 3: 若直接是陣列 → 視為 mappings
  if (Array.isArray(parsed)) {
    console.log('[Robust Parser] Direct array format (length:', parsed.length, ')');
    return { ok: true, mappings: parsed };
  }

  // 策略 4: 若是物件，檢查多種可能的 key
  if (typeof parsed === 'object' && parsed !== null) {
    // 4a) mappings (標準格式)
    if (Array.isArray(parsed.mappings)) {
      console.log('[Robust Parser] Found "mappings" array (length:', parsed.mappings.length, ')');
      return { ok: true, mappings: parsed.mappings };
    }

    // 4b) mapping (單數形式)
    if (Array.isArray(parsed.mapping)) {
      console.log('[Robust Parser] Found "mapping" array (length:', parsed.mapping.length, ')');
      return { ok: true, mappings: parsed.mapping };
    }

    // 4c) columnMappings
    if (Array.isArray(parsed.columnMappings)) {
      console.log('[Robust Parser] Found "columnMappings" array (length:', parsed.columnMappings.length, ')');
      return { ok: true, mappings: parsed.columnMappings };
    }

    // 4d) columnMapping
    if (Array.isArray(parsed.columnMapping)) {
      console.log('[Robust Parser] Found "columnMapping" array (length:', parsed.columnMapping.length, ')');
      return { ok: true, mappings: parsed.columnMapping };
    }

    // 4e) fields (某些 AI 可能用這個 key)
    if (Array.isArray(parsed.fields)) {
      console.log('[Robust Parser] Found "fields" array (length:', parsed.fields.length, ')');
      return { ok: true, mappings: parsed.fields };
    }

    // 4f) 若物件只有一個 key 且該 key 是陣列
    const keys = Object.keys(parsed);
    if (keys.length === 1 && Array.isArray(parsed[keys[0]])) {
      console.log('[Robust Parser] Single key with array (key:', keys[0], ', length:', parsed[keys[0]].length, ')');
      return { ok: true, mappings: parsed[keys[0]] };
    }

    console.error('[Robust Parser] Object format but no recognizable mappings array. Keys:', keys);
    return { ok: false, mappings: [], error: `Unrecognized object keys: ${keys.join(', ')}` };
  }

  // 策略 5: 其他類型（無法解析）
  console.error('[Robust Parser] Unrecognized type:', typeof parsed);
  return { ok: false, mappings: [], error: 'Unrecognized response type' };
};

/**
 * 驗證 mappings 陣列內容
 * @param {Array} mappings
 * @returns {boolean}
 */
const validateMappings = (mappings) => {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return false;
  }

  // 至少要有一個 mapping 有 source 或 target
  const hasValidMapping = mappings.some(m => 
    m && typeof m === 'object' && (m.source || m.target || m.column || m.field)
  );

  return hasValidMapping;
};

/**
 * 使用 LLM 只建議 uploadType（Step 1: Classification only）
 * @param {object} params
 * @param {Array<string>} params.headers - Sheet headers
 * @param {Array<object>} params.sampleRows - Sample data (前 30-50 筆)
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
 * 使用 LLM 建議 field mapping（純 mapping，不判斷 uploadType）
 * @param {object} params
 * @param {string} params.uploadType - 目標 uploadType
 * @param {Array<string>} params.headers - 原始 header 名稱（不要 normalize）
 * @param {Array<object>} params.sampleRows - 樣本資料（前 N 筆）
 * @param {Array<string>} params.requiredFields - Canonical required fields
 * @param {Array<string>} params.optionalFields - Canonical optional fields
 * @returns {Promise<object>} { mappings, mappingConfidence, reasons }
 */
export async function suggestMappingWithLLM({
  uploadType,
  headers,
  sampleRows,
  requiredFields,
  optionalFields
}) {
  console.log(`[suggestMappingWithLLM] Starting for uploadType: ${uploadType}`);
  console.log(`[suggestMappingWithLLM] Headers:`, headers);
  console.log(`[suggestMappingWithLLM] Required fields:`, requiredFields);

  try {
    // 建立 prompt
    const targetFields = [...requiredFields, ...optionalFields];
    const sampleData = sampleRows.slice(0, 5).map(row => {
      const sample = {};
      headers.forEach(h => {
        sample[h] = row[h];
      });
      return sample;
    });

    const prompt = `You are a data mapping expert. Map Excel column headers to target database fields.

TASK: Map the source headers to target fields for uploadType: "${uploadType}"

SOURCE HEADERS:
${headers.map((h, i) => `${i + 1}. "${h}"`).join('\n')}

TARGET FIELDS:
Required: ${requiredFields.join(', ')}
Optional: ${optionalFields.join(', ')}

SAMPLE DATA (first 5 rows):
${JSON.stringify(sampleData, null, 2)}

RULES:
1. Each source header can map to at most ONE target field
2. Target fields must be from the list above (required or optional)
3. Use sample data to understand the semantic meaning
4. Confidence: 0.0-1.0 (1.0 = very confident, 0.0 = no match)
5. Prioritize mapping ALL required fields first

OUTPUT FORMAT (JSON only, no markdown):
{
  "mappings": [
    { "source": "original header", "target": "target_field", "confidence": 0.95 }
  ],
  "mappingConfidence": 0.85,
  "reasons": ["Mapped X to Y based on...", "..."]
}

Return JSON only. No explanation outside JSON.`;

    console.log(`[suggestMappingWithLLM] Calling AI...`);
    const aiResponse = await callGeminiAPI(prompt, '', { temperature: 0.2, maxOutputTokens: 2000 });
    
    console.log(`[suggestMappingWithLLM] AI response length:`, aiResponse.length);
    
    // 使用 robust parser
    const extracted = extractAiJson(aiResponse);
    const parsed = parseAiMappingResponse(extracted);
    
    if (!parsed.ok) {
      throw new Error(`AI mapping format invalid: ${parsed.error}`);
    }

    const mappings = parsed.mappings;
    
    // 嚴格驗證每個 mapping
    const validMappings = [];
    const errors = [];
    
    mappings.forEach((m, idx) => {
      // 檢查必要欄位
      if (!m.source || !m.target) {
        errors.push(`Mapping ${idx}: missing source or target`);
        return;
      }
      
      // ✅ B) 移除嚴格的 headers.includes 檢查
      // 因為 AI 回傳的 source 可能有微小差異（大小寫、空白、底線等）
      // 對齊工作由 handleAiFieldSuggestion 中的 alignAiMappings 處理
      // if (!headers.includes(m.source)) {
      //   errors.push(`Mapping ${idx}: source "${m.source}" not in headers`);
      //   return;
      // }
      
      // 檢查 target 是否在允許的 fields 中
      if (!targetFields.includes(m.target)) {
        errors.push(`Mapping ${idx}: target "${m.target}" not in allowed fields`);
        return;
      }
      
      // 檢查 confidence
      if (typeof m.confidence !== 'number' || m.confidence < 0 || m.confidence > 1) {
        errors.push(`Mapping ${idx}: invalid confidence ${m.confidence}`);
        return;
      }
      
      validMappings.push(m);
    });

    if (errors.length > 0) {
      console.warn('[suggestMappingWithLLM] Validation errors:', errors);
    }

    // 去重：同一 target 只保留最高 confidence 的 source
    const targetMap = new Map();
    validMappings.forEach(m => {
      const existing = targetMap.get(m.target);
      if (!existing || m.confidence > existing.confidence) {
        targetMap.set(m.target, m);
      }
    });

    const deduplicatedMappings = Array.from(targetMap.values());
    
    console.log(`[suggestMappingWithLLM] Valid mappings: ${deduplicatedMappings.length}/${mappings.length}`);

    // 計算 mapping confidence（基於 required fields coverage）
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

    const reasons = extracted.reasons || [
      `Mapped ${deduplicatedMappings.length} fields`,
      `Required coverage: ${Math.round(requiredCoverage * 100)}%`,
      `Average confidence: ${Math.round(avgConfidence * 100)}%`
    ];

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
 * 為單個 sheet 提供 AI 智能建議（包含 uploadType 判斷 + mapping）
 * @param {object} params
 * @param {string} params.sheetName - Sheet 名稱
 * @param {Array} params.headers - 欄位名稱
 * @param {Array} params.sampleRows - 樣本資料（最多30）
 * @param {string} params.currentUploadType - 當前選擇的 uploadType（可選）
 * @param {boolean} params.hasIngestKeySupport - DB 是否支援 chunk idempotency
 * @returns {Promise<object>} { suggestedUploadType, mapping, confidence, reasons, autoEnable }
 */
export async function suggestSheetMapping({
  sheetName,
  headers,
  sampleRows,
  currentUploadType = null,
  hasIngestKeySupport = false
}) {
  try {
    console.log(`[AI Suggest] Starting for sheet: ${sheetName}`);
    console.log(`[AI Suggest] Headers:`, headers);
    console.log(`[AI Suggest] Sample rows:`, sampleRows.length);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'oneShotAiSuggestService.js:367',message:'[Entry] suggestSheetMapping called',data:{sheetName,headers,headersCount:headers.length,currentUploadType},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,D'})}).catch(()=>{});
    // #endregion

    // Step 1: 若沒有指定 uploadType，先用 AI 推薦
    let uploadType = currentUploadType;
    let typeConfidence = 0;
    let typeReasons = [];

    if (!uploadType) {
      console.log('[AI Suggest] No uploadType specified, asking AI for suggestion...');
      
      // 先用本地 classifier 快速篩選
      const classifyResult = classifySheet({ sheetName, headers, sampleRows: sampleRows.slice(0, 20) });
      console.log('[AI Suggest] Local classifier result:', classifyResult);

      if (classifyResult.confidence >= 0.6) {
        // 本地分類器有信心，直接使用
        uploadType = classifyResult.suggestedType;
        typeConfidence = classifyResult.confidence;
        typeReasons = classifyResult.candidates
          .slice(0, 3)
          .map(c => `${c.uploadType} (${Math.round(c.confidence * 100)}%): ${c.reasons?.slice(0, 2).join(', ') || 'matched'}`);
        
        console.log('[AI Suggest] Using local classifier result:', uploadType);
      } else {
        // 本地分類器信心不足，呼叫 AI
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
      // 已指定 uploadType，直接使用
      typeConfidence = 1.0;
      typeReasons = ['User specified'];
      console.log('[AI Suggest] Using user-specified uploadType:', uploadType);
    }

    // Step 2: 取得 schema
    const schema = UPLOAD_SCHEMAS[uploadType];
    if (!schema) {
      throw new Error(`Unknown uploadType: ${uploadType}`);
    }

    console.log('[AI Suggest] Schema fields:', schema.fields.length);

    // Step 3: 呼叫 AI 生成 mapping
    const limitedSampleRows = sampleRows.slice(0, 30);
    const mappingPrompt = generateMappingPrompt(uploadType, schema.fields, headers, limitedSampleRows);
    
    console.log('[AI Suggest] Mapping prompt:', mappingPrompt.slice(0, 300) + '...');
    
    const aiMappingResponse = await callGeminiAPI(mappingPrompt, '', { temperature: 0.3, maxOutputTokens: 2000 });
    
    console.log('[AI Suggest] AI mapping response length:', aiMappingResponse.length);
    
    const extractedJson = extractAiJson(aiMappingResponse);
    console.log('[AI Suggest] Extracted JSON:', extractedJson);

    // Step 4: 使用 robust parser 解析 mapping
    const parseResult = parseAiMappingResponse(extractedJson);
    
    if (!parseResult.ok) {
      console.error('[AI Suggest] Failed to parse mappings:', parseResult.error);
      // 不 throw，而是回傳失敗結果
      return {
        suggestedUploadType: uploadType,
        mapping: {},
        mappings: [],
        confidence: 0,
        reasons: [
          `AI 回傳格式不正確: ${parseResult.error}`,
          '請手動選擇 Upload Type 並調整 mapping'
        ],
        autoEnable: false,
        requiredCoverage: 0,
        error: parseResult.error
      };
    }

    const mappings = parseResult.mappings;
    console.log('[AI Suggest] Valid mappings:', mappings.length);
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'oneShotAiSuggestService.js:462',message:'[BEFORE alignment] AI mappings from LLM',data:{mappingsCount:mappings.length,aiMappings:mappings.slice(0,5).map(m=>({source:m.source,target:m.target,confidence:m.confidence})),allAiSources:mappings.map(m=>m.source)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,D'})}).catch(()=>{});
    // #endregion

    // Step 4b: 驗證 mappings 內容
    if (!validateMappings(mappings)) {
      console.error('[AI Suggest] Mappings validation failed');
      return {
        suggestedUploadType: uploadType,
        mapping: {},
        mappings: [],
        confidence: 0,
        reasons: [
          'AI 回傳的 mappings 內容無效',
          '請手動選擇 Upload Type 並調整 mapping'
        ],
        autoEnable: false,
        requiredCoverage: 0,
        error: 'Invalid mappings content'
      };
    }

    // Step 5: 計算 required fields 覆蓋率
    const requiredFields = schema.fields.filter(f => f.required).map(f => f.key);
    const mappedFields = mappings
      .filter(m => m.target && m.confidence >= 0.6)
      .map(m => m.target);
    
    const requiredCoverage = requiredFields.filter(rf => mappedFields.includes(rf)).length / requiredFields.length;
    
    console.log('[AI Suggest] Required fields:', requiredFields);
    console.log('[AI Suggest] Mapped fields (conf >= 0.6):', mappedFields);
    console.log('[AI Suggest] Required coverage:', requiredCoverage);

    // Step 6: 計算 overall confidence（綜合 type confidence 和 mapping confidence）
    const avgMappingConfidence = mappings.reduce((sum, m) => sum + (m.confidence || 0), 0) / mappings.length;
    const overallConfidence = (typeConfidence + avgMappingConfidence) / 2;

    console.log('[AI Suggest] Type confidence:', typeConfidence);
    console.log('[AI Suggest] Avg mapping confidence:', avgMappingConfidence);
    console.log('[AI Suggest] Overall confidence:', overallConfidence);

    // Step 7: 決定是否 auto-enable
    // 規則：confidence >= 0.75 且 required coverage >= 1.0（必須兩者都達標）
    // 修正：requiredCoverage < 1.0 不得 auto-enable（避免錯誤匯入）
    let autoEnable = overallConfidence >= 0.75 && requiredCoverage >= 1.0;

    // 這裡無法判斷 row count（需要 caller 傳入），所以假設 caller 會處理
    // 但我們可以在 reasons 中提示
    const reasons = [
      ...typeReasons,
      `Mapping confidence: ${Math.round(avgMappingConfidence * 100)}%`,
      `Required fields coverage: ${Math.round(requiredCoverage * 100)}%`,
      `Overall confidence: ${Math.round(overallConfidence * 100)}%`
    ];

    // Step 8: 使用 header normalization 對齊 AI mappings 到實際 headers
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'oneShotAiSuggestService.js:518',message:'[BEFORE alignment] About to align AI mappings',data:{originalHeaders:headers,aiMappings:mappings.map(m=>({source:m.source,target:m.target,conf:m.confidence}))},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,C'})}).catch(()=>{});
    // #endregion
    
    // ✅ 使用 headerNormalize 工具對齊 AI mappings
    const headerIndexResult = buildHeaderIndex(headers);
    logHeaderStats(headers, headerIndexResult);
    
    const alignResult = alignAiMappings(mappings, headerIndexResult.index);
    logMappingAlignStats(alignResult);
    
    // ✅ 使用對齊後的 mappings（source 已經是實際的 originalHeader）
    const alignedMappings = alignResult.alignedMappings;
    
    const columnMapping = {};
    alignedMappings.forEach(m => {
      if (m.target && m.confidence >= 0.6) {
        // ✅ m.source 現在已經是實際的 Excel header（來自 headerIndex）
        columnMapping[m.source] = m.target;
      }
    });
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'oneShotAiSuggestService.js:540',message:'[AFTER alignment] columnMapping built with aligned headers',data:{columnMapping,columnMappingKeys:Object.keys(columnMapping),alignedCount:alignedMappings.length,unmatchedCount:alignResult.unmatchedSources.length,unmatchedSources:alignResult.unmatchedSources,keysMatch:Object.keys(columnMapping).every(k=>headers.includes(k))},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,C'})}).catch(()=>{});
    // #endregion
    
    // ⚠️ 警告：若有 unmatched sources，記錄詳細資訊
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

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/35d967fa-aaea-4f36-8ecf-97e2f2e17afa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'oneShotAiSuggestService.js:532',message:'[Exit] suggestSheetMapping returning result',data:{uploadType,mappingKeysCount:Object.keys(columnMapping).length,requiredCoverage,confidence:overallConfidence,autoEnable,columnMappingSample:Object.entries(columnMapping).slice(0,3)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,E'})}).catch(()=>{});
    // #endregion
    
    return {
      suggestedUploadType: uploadType,
      mapping: columnMapping,
      mappings: mappings, // 保留完整 mappings（含 confidence）
      confidence: overallConfidence,
      reasons,
      autoEnable,
      requiredCoverage
    };

  } catch (error) {
    console.error('[AI Suggest] Failed:', error);
    
    // 不要直接 throw，改為回傳錯誤結果（讓 caller 可以決定如何處理）
    return {
      suggestedUploadType: null,
      mapping: {},
      mappings: [],
      confidence: 0,
      reasons: [
        `AI Suggest 執行失敗: ${error.message}`,
        '請手動選擇 Upload Type'
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
