/**
 * AI Field Mapping Helper Functions
 * Used for generating AI prompts and parsing AI responses
 */

import { buildSchemaContractMappingPrompt } from '../prompts/diJsonContracts';

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const stripMarkdownFence = (value) => String(value || '')
  .replace(/```json\s*/gi, '')
  .replace(/```javascript\s*/gi, '')
  .replace(/```\s*/g, '')
  .trim();

const findJsonStartIndex = (value) => {
  const objectIndex = value.indexOf('{');
  const arrayIndex = value.indexOf('[');
  if (objectIndex === -1) return arrayIndex;
  if (arrayIndex === -1) return objectIndex;
  return Math.min(objectIndex, arrayIndex);
};

const extractBalancedJsonSlice = (value, startIndex) => {
  const stack = [value[startIndex]];
  let inString = false;
  let escaped = false;

  for (let i = startIndex + 1; i < value.length; i++) {
    const char = value[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedOpen = char === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expectedOpen) {
        break;
      }
      stack.pop();
      if (stack.length === 0) {
        return {
          complete: value.slice(startIndex, i + 1),
          partial: '',
          missingClosers: [],
          hasOpenString: false
        };
      }
    }
  }

  return {
    complete: '',
    partial: value.slice(startIndex).trim(),
    missingClosers: stack.reverse().map((openChar) => (openChar === '{' ? '}' : ']')),
    hasOpenString: inString
  };
};

const repairPartialJson = ({ partial, missingClosers, hasOpenString }) => {
  let repaired = String(partial || '').trim();
  if (!repaired) return '';

  if (hasOpenString) {
    if (repaired.endsWith('\\')) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  repaired = repaired.replace(/,\s*$/g, '');
  repaired += (missingClosers || []).join('');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  return repaired;
};

/**
 * Extract JSON from AI response text (enhanced version)
 * @param {string} text - Raw AI response text
 * @returns {Object} Parsed JSON object, returns empty object on failure
 */
export const extractAiJson = (text, options = {}) => {
  if (!text) {
    console.error('Empty AI response');
    return {};
  }

  const strictMode = Boolean(options?.strict);
  const raw = String(text).trim();
  console.log('Extracting JSON from:', raw.substring(0, 200));

  // Strategy 1: Direct parse
  const direct = parseJson(raw);
  if (direct !== null) {
    console.log('Strategy 1 (direct parse) succeeded');
    return direct;
  }

  // Strategy 2: Remove markdown wrapper and parse
  const cleaned = stripMarkdownFence(raw);
  const markdownCleaned = parseJson(cleaned);
  if (markdownCleaned !== null) {
    console.log('Strategy 2 (remove markdown) succeeded');
    return markdownCleaned;
  }

  // Strategy 3: Extract first balanced JSON block
  const startIdx = findJsonStartIndex(cleaned);
  if (startIdx !== -1) {
    const extracted = extractBalancedJsonSlice(cleaned, startIdx);
    if (extracted.complete) {
      const parsed = parseJson(extracted.complete);
      if (parsed !== null) {
        console.log('Strategy 3 (balanced extraction) succeeded');
        return parsed;
      }
    }

    // Strategy 4: Repair truncated JSON (missing braces/quote)
    // Strict mode forbids auto-repair to guarantee structurally valid model output.
    if (!strictMode && extracted.partial) {
      const repaired = repairPartialJson({
        partial: extracted.partial,
        missingClosers: extracted.missingClosers,
        hasOpenString: extracted.hasOpenString
      });
      const parsed = parseJson(repaired);
      if (parsed !== null) {
        console.warn('Strategy 4 (repaired truncated JSON) succeeded');
        return parsed;
      }
    }
  } else {
    console.error('No JSON object/array start token found');
  }

  console.error('All extraction strategies failed');
  console.error('Original text:', raw);
  return {};
};

/**
 * Smart rule-based mapping (fallback when AI fails)
 * @param {Array} originalColumns - Original Excel columns
 * @param {string} uploadType - Upload type
 * @param {Array} schemaFields - Schema field definitions
 * @returns {Array} Mapping suggestions
 */
export const ruleBasedMapping = (originalColumns, uploadType) => {
  const mappings = [];
  
  // Define rules: Excel column pattern -> system field key
  const rules = {
    price_history: {
      supplier_name: [
        /^supplier$/i, /^supplier[-_]?name$/i, /^vendor$/i, /^vendor[-_]?name$/i,
        /^廠商$/i, /^供應商$/i, /^供應商名稱$/i
      ],
      supplier_code: [
        /^supplier[-_]?code$/i, /^vendor[-_]?code$/i, /^supplier[-_]?id$/i,
        /^廠商代碼$/i, /^供應商代碼$/i
      ],
      material_code: [
        /^material[-_]?code$/i, /^part[-_]?no$/i, /^part[-_]?number$/i, /^item[-_]?code$/i,
        /^material$/i, /^料號$/i, /^物料代碼$/i
      ],
      material_name: [
        /^material[-_]?name$/i, /^part[-_]?name$/i, /^item[-_]?name$/i,
        /^料品名稱$/i, /^物料名稱$/i
      ],
      order_date: [
        /^order[-_]?date$/i, /^quote[-_]?date$/i, /^po[-_]?date$/i, /^date$/i,
        /^訂單日期$/i, /^報價日期$/i, /^日期$/i
      ],
      unit_price: [
        /^unit[-_]?price$/i, /^price$/i, /^cost$/i, /^unit[-_]?cost$/i,
        /^單價$/i, /^價格$/i, /^成本$/i
      ],
      currency: [
        /^currency$/i, /^curr$/i, /^currency[-_]?code$/i,
        /^幣別$/i, /^貨幣$/i
      ],
      quantity: [
        /^quantity$/i, /^qty$/i, /^order[-_]?qty$/i, /^amount$/i,
        /^數量$/i, /^訂購數量$/i
      ],
      is_contract_price: [
        /^contract$/i, /^is[-_]?contract$/i, /^contract[-_]?price$/i,
        /^合約價$/i, /^是否合約價$/i
      ]
    },
    goods_receipt: {
      supplier_name: [
        /^supplier[-_]?name$/i, /^vendor[-_]?name$/i, /^supplier$/i, /^vendor$/i,
        /^供應商名稱$/i, /^供應商$/i, /^廠商名稱$/i, /^廠商$/i
      ],
      supplier_code: [
        /^supplier[-_]?code$/i, /^vendor[-_]?code$/i,
        /^供應商代碼$/i, /^廠商代碼$/i
      ],
      material_code: [
        /^material[-_]?code$/i, /^part[-_]?no$/i, /^part[-_]?number$/i, /^item[-_]?code$/i,
        /^material$/i, /^part$/i, /^料號$/i, /^物料代碼$/i, /^料品編號$/i
      ],
      material_name: [
        /^material[-_]?name$/i, /^part[-_]?name$/i, /^item[-_]?name$/i,
        /^料品名稱$/i, /^物料名稱$/i
      ],
      actual_delivery_date: [
        /^actual[-_]?delivery[-_]?date$/i, /^delivery[-_]?date$/i, /^received[-_]?date$/i,
        /^arrival[-_]?date$/i, /^實際交貨日期$/i, /^交貨日期$/i, /^收貨日期$/i
      ],
      planned_delivery_date: [
        /^planned[-_]?delivery[-_]?date$/i, /^planned[-_]?date$/i, /^plan[-_]?date$/i,
        /^計畫交貨日期$/i, /^預計交貨日期$/i
      ],
      receipt_date: [
        /^receipt[-_]?date$/i, /^receiving[-_]?date$/i,
        /^入庫日期$/i, /^收料日期$/i
      ],
      received_qty: [
        /^received[-_]?qty$/i, /^received[-_]?quantity$/i, /^qty$/i, /^quantity$/i,
        /^收貨數量$/i, /^收料數量$/i, /^數量$/i
      ],
      rejected_qty: [
        /^rejected[-_]?qty$/i, /^rejected[-_]?quantity$/i, /^ng[-_]?qty$/i, /^defect[-_]?qty$/i,
        /^拒收數量$/i, /^退貨數量$/i, /^不良數量$/i, /^不良數$/i
      ],
      po_number: [
        /^po[-_]?number$/i, /^po[-_]?no$/i, /^po$/i, /^purchase[-_]?order$/i,
        /^採購單號$/i, /^訂單號$/i
      ],
      receipt_number: [
        /^receipt[-_]?number$/i, /^receipt[-_]?no$/i, /^gr[-_]?number$/i,
        /^收貨單號$/i, /^入庫單號$/i
      ],
      category: [
        /^category$/i, /^type$/i, /^material[-_]?type$/i,
        /^類別$/i, /^物料類別$/i
      ],
      uom: [
        /^uom$/i, /^unit$/i, /^unit[-_]?of[-_]?measure$/i,
        /^單位$/i, /^計量單位$/i
      ]
    },
    supplier_master: {
      supplier_code: [
        /^supplier[-_]?code$/i, /^vendor[-_]?code$/i, /^supplier[-_]?id$/i, /^vendor[-_]?id$/i,
        /^code$/i, /^id$/i, /^供應商代碼$/i, /^廠商代碼$/i, /^供應商編號$/i
      ],
      supplier_name: [
        /^supplier[-_]?name$/i, /^vendor[-_]?name$/i, /^company[-_]?name$/i, 
        /^supplier$/i, /^vendor$/i, /^company$/i, /^name$/i,
        /^供應商名稱$/i, /^供應商$/i, /^廠商$/i, /^公司名稱$/i, /^廠商名稱$/i
      ],
      contact_person: [
        /^contact[-_]?person$/i, /^contact[-_]?name$/i, /^contact$/i,
        /^person$/i, /^rep$/i, /^representative$/i,
        /^聯絡人$/i, /^聯繫人$/i, /^窗口$/i
      ],
      phone: [
        /^phone$/i, /^tel$/i, /^telephone$/i, /^mobile$/i, /^cell$/i,
        /^phone[-_]?number$/i, /^tel[-_]?number$/i,
        /^電話$/i, /^聯絡電話$/i, /^手機$/i
      ],
      email: [
        /^email$/i, /^mail$/i, /^e[-_]?mail$/i, /^email[-_]?address$/i,
        /^電子郵件$/i, /^信箱$/i, /^郵箱$/i, /^email$/i
      ],
      address: [
        /^address$/i, /^location$/i, /^addr$/i, /^address[-_]?line$/i,
        /^地址$/i, /^位置$/i, /^公司地址$/i
      ],
      product_category: [
        /^product[-_]?category$/i, /^category$/i, /^product[-_]?type$/i,
        /^產品類別$/i, /^類別$/i, /^產品分類$/i
      ],
      payment_terms: [
        /^payment[-_]?terms$/i, /^payment$/i, /^terms$/i,
        /^付款條件$/i, /^付款方式$/i, /^帳期$/i
      ],
      delivery_time: [
        /^delivery[-_]?time$/i, /^lead[-_]?time$/i, /^delivery$/i,
        /^交貨時間$/i, /^交期$/i, /^前置時間$/i
      ],
      status: [
        /^status$/i, /^state$/i, /^active$/i,
        /^狀態$/i
      ]
    },
    demand_fg: {
      material_code: [
        /^material$/i, /^material[-_ ]?code$/i, /^item[-_ ]?code$/i, /^item[-_ ]?id$/i, /^sku$/i, /^part[-_ ]?(no|number)$/i,
        /^料號$/i, /^物料(編碼|代碼|编码|代码)$/i, /^品號$/i, /^品号$/i
      ],
      plant_id: [
        /^plant$/i, /^plant[-_ ]?id$/i, /^site$/i, /^site[-_ ]?id$/i, /^factory$/i, /^store$/i, /^store[-_ ]?id$/i, /^store[-_ ]?code$/i, /^dc[-_ ]?id$/i,
        /^工廠$/i, /^工厂$/i, /^廠別$/i, /^厂别$/i
      ],
      demand_qty: [
        /^demand$/i, /^demand[-_ ]?qty$/i, /^demand[-_ ]?quantity$/i, /^units?[-_ ]?sold$/i, /^sales[-_ ]?qty$/i, /^qty$/i, /^quantity$/i, /^forecast$/i,
        /^需求(量|數量|数量)$/i
      ],
      time_bucket: [
        /^time[-_ ]?bucket$/i, /^bucket$/i, /^period$/i, /^week[-_ ]?start$/i,
        /^時間桶$/i, /^时间桶$/i, /^期間$/i
      ],
      week_bucket: [
        /^week$/i, /^week[-_ ]?bucket$/i, /^iso[-_ ]?week$/i, /^wm[-_ ]?yr[-_ ]?wk$/i,
        /^週次$/i, /^周次$/i, /^週桶$/i, /^周桶$/i
      ],
      date: [
        /^date$/i, /^demand[-_ ]?date$/i, /^posting[-_ ]?date$/i,
        /^日期$/i
      ]
    },
    po_open_lines: {
      po_number: [
        /^po$/i, /^po[-_ ]?(no|number)$/i, /^purchase[-_ ]?order$/i,
        /^採購單號$/i, /^采购单号$/i, /^訂單號$/i, /^订单号$/i
      ],
      po_line: [
        /^po[-_ ]?line$/i, /^line$/i, /^line[-_ ]?number$/i, /^item$/i,
        /^行號$/i, /^行号$/i, /^項次$/i, /^项次$/i
      ],
      material_code: [
        /^material$/i, /^material[-_ ]?code$/i, /^item[-_ ]?code$/i, /^sku$/i, /^part[-_ ]?(no|number)$/i,
        /^料號$/i, /^物料(編碼|代碼|编码|代码)$/i
      ],
      plant_id: [
        /^plant$/i, /^plant[-_ ]?id$/i, /^site$/i, /^factory$/i,
        /^工廠$/i, /^工厂$/i, /^廠別$/i, /^厂别$/i
      ],
      open_qty: [
        /^open[-_ ]?qty$/i, /^open[-_ ]?quantity$/i, /^remaining[-_ ]?qty$/i, /^qty$/i, /^quantity$/i,
        /^未交(量|數量|数量)$/i, /^未收(量|數量|数量)$/i
      ],
      time_bucket: [
        /^time[-_ ]?bucket$/i, /^bucket$/i, /^period$/i,
        /^時間桶$/i, /^时间桶$/i, /^期間$/i
      ],
      week_bucket: [
        /^week$/i, /^week[-_ ]?bucket$/i, /^iso[-_ ]?week$/i,
        /^週次$/i, /^周次$/i
      ],
      date: [
        /^date$/i, /^po[-_ ]?date$/i, /^delivery[-_ ]?date$/i, /^promised[-_ ]?date$/i,
        /^日期$/i, /^交期$/i
      ]
    },
    inventory_snapshots: {
      material_code: [
        /^material$/i, /^material[-_ ]?code$/i, /^item[-_ ]?code$/i, /^item[-_ ]?id$/i, /^sku$/i, /^part[-_ ]?(no|number)$/i,
        /^料號$/i, /^物料(編碼|代碼|编码|代码)$/i
      ],
      plant_id: [
        /^plant$/i, /^plant[-_ ]?id$/i, /^site$/i, /^factory$/i, /^store$/i, /^store[-_ ]?id$/i, /^store[-_ ]?code$/i, /^dc[-_ ]?id$/i,
        /^工廠$/i, /^工厂$/i, /^廠別$/i, /^厂别$/i
      ],
      snapshot_date: [
        /^snapshot[-_ ]?date$/i, /^as[-_ ]?of[-_ ]?date$/i, /^date$/i, /^week[-_ ]?start$/i, /^week[-_ ]?end$/i,
        /^快照日期$/i, /^盤點日期$/i, /^盘点日期$/i, /^日期$/i
      ],
      onhand_qty: [
        /^on[-_ ]?hand$/i, /^on[-_ ]?hand[-_ ]?qty$/i, /^on[-_ ]?hand[-_ ]?quantity$/i, /^on[-_ ]?hand[-_ ]?start$/i, /^on[-_ ]?hand[-_ ]?end[-_ ]?units$/i, /^stock$/i, /^stock[-_ ]?qty$/i, /^inventory$/i, /^qty$/i,
        /^現有庫存$/i, /^现有库存$/i, /^在手庫存$/i, /^在手库存$/i
      ],
      allocated_qty: [
        /^allocated[-_ ]?qty$/i, /^allocated[-_ ]?quantity$/i, /^reserved[-_ ]?qty$/i,
        /^已分配(量|數量|数量)$/i, /^預留(量|數量|数量)$/i, /^预留(量|数量)$/i
      ],
      safety_stock: [
        /^safety[-_ ]?stock$/i, /^safety[-_ ]?qty$/i, /^safety[-_ ]?stock[-_ ]?units$/i, /^min[-_ ]?stock$/i,
        /^安全庫存$/i, /^安全库存$/i
      ]
    },
    bom_edge: {
      parent_material: [
        /^parent$/i, /^parent[-_ ]?material$/i, /^parent[-_ ]?item$/i, /^fg$/i, /^assembly$/i,
        /^父件$/i, /^上階料號$/i, /^上阶料号$/i
      ],
      child_material: [
        /^child$/i, /^child[-_ ]?material$/i, /^child[-_ ]?item$/i, /^component$/i, /^item$/i,
        /^子件$/i, /^下階料號$/i, /^下阶料号$/i, /^零件$/i
      ],
      qty_per: [
        /^qty[-_ ]?per$/i, /^quantity[-_ ]?per$/i, /^usage$/i, /^usage[-_ ]?qty$/i, /^bom[-_ ]?qty$/i, /^qty$/i,
        /^用量$/i, /^單位用量$/i, /^单位用量$/i
      ],
      plant_id: [
        /^plant$/i, /^plant[-_ ]?id$/i, /^site$/i, /^factory$/i,
        /^工廠$/i, /^工厂$/i
      ]
    }
  };

  const typeRules = rules[uploadType] || {};
  
  // Find best match for each Excel column
  originalColumns.forEach(col => {
    let bestMatch = null;
    let bestConfidence = 0;

    // Iterate all system field rules
    Object.entries(typeRules).forEach(([systemField, patterns]) => {
      patterns.forEach(pattern => {
        if (pattern.test(col)) {
          // Calculate confidence: exact match > contains match
          const confidence = col.toLowerCase() === systemField.toLowerCase() ? 0.95 : 0.80;
          if (confidence > bestConfidence) {
            bestMatch = systemField;
            bestConfidence = confidence;
          }
        }
      });
    });

    mappings.push({
      source: col,
      target: bestMatch,
      confidence: bestConfidence,
      reason: bestMatch ? 'rule-based match' : 'no match found'
    });
  });

  return mappings;
};


export const generateMappingPrompt = (uploadType, schemaFields, originalColumns, sampleRows) => {
  const fields = Array.isArray(schemaFields) ? schemaFields : [];
  const requiredFields = fields
    .filter((field) => field?.required)
    .map((field) => ({
      name: String(field?.key || ''),
      type: ['string', 'number', 'date', 'boolean'].includes(field?.type) ? field.type : 'string',
      description: String(field?.description || field?.label || field?.key || '')
    }))
    .filter((field) => field.name);

  const optionalFields = fields
    .filter((field) => !field?.required)
    .map((field) => ({
      name: String(field?.key || ''),
      type: ['string', 'number', 'date', 'boolean'].includes(field?.type) ? field.type : 'string',
      description: String(field?.description || field?.label || field?.key || '')
    }))
    .filter((field) => field.name);

  return buildSchemaContractMappingPrompt({
    upload_type: uploadType,
    target_schema: {
      required_fields: requiredFields,
      optional_fields: optionalFields
    },
    input_columns: Array.isArray(originalColumns) ? originalColumns : [],
    sample_rows: Array.isArray(sampleRows) ? sampleRows.slice(0, 8) : []
  });
};

/**
 * Validate AI response mappings format (lenient version)
 * @param {Object} aiResponse - AI response object
 * @returns {boolean} Whether format is valid
 */
export const validateMappingResponse = (aiResponse) => {
  if (!aiResponse || typeof aiResponse !== 'object') {
    console.error('❌ AI response is not an object:', typeof aiResponse);
    return false;
  }

  const mappingArray = Array.isArray(aiResponse.mappings)
    ? aiResponse.mappings
    : (Array.isArray(aiResponse.mapping) ? aiResponse.mapping : null);

  if (!Array.isArray(mappingArray)) {
    console.error('❌ AI response missing "mapping/mappings" array. Keys:', Object.keys(aiResponse));
    return false;
  }

  if (mappingArray.length === 0) {
    console.error('❌ AI response has empty mapping array');
    return false;
  }

  console.log(`Validating ${mappingArray.length} mappings...`);

  // Check each mapping (using lenient validation)
  let validCount = 0;
  let invalidCount = 0;

  const cleanedMappings = mappingArray
    .map((m, index) => {
      // Must be an object
      if (!m || typeof m !== 'object') {
        console.warn(`⚠️ Mapping ${index} is not an object`);
        invalidCount++;
        return null;
      }

      const source = m.source ?? m.source_column;
      const target = m.target ?? m.target_field;

      // Must have source
      if (!source || typeof source !== 'string') {
        console.warn(`⚠️ Mapping ${index} missing valid source:`, m);
        invalidCount++;
        return null;
      }

      // target can be null or string
      if (target !== null && typeof target !== 'string') {
        console.warn(`⚠️ Mapping ${index} has invalid target:`, target);
        invalidCount++;
        return null;
      }

      // If confidence is not a number, use default
      let confidence = m.confidence;
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        console.warn(`⚠️ Mapping ${index} has invalid confidence (${confidence}), using 0.5`);
        confidence = 0.5;
      }

      // reason is optional
      const reason = m.reason || 'AI suggestion';

      validCount++;
      return {
        source: source,
        target: target,
        confidence: confidence,
        reason: reason
      };
    })
    .filter(m => m !== null); // Remove invalid mappings

  console.log(`✅ Valid mappings: ${validCount}, ❌ Invalid: ${invalidCount}`);

  // As long as there's at least one valid mapping, consider it successful
  if (cleanedMappings.length > 0) {
    // Normalize to canonical "mappings" so downstream mergeMappings always works.
    aiResponse.mappings = cleanedMappings;
    aiResponse.mapping = cleanedMappings;
    return true;
  }

  console.error('❌ No valid mappings found');
  return false;
};

/**
 * Merge AI-suggested mappings into existing columnMapping
 * @param {Object} currentMapping - Existing columnMapping
 * @param {Array} aiMappings - AI-suggested mappings
 * @param {number} minConfidence - Minimum confidence threshold (default 0.6)
 * @returns {Object} Merged mapping and statistics
 */
export const mergeMappings = (currentMapping, aiMappings, minConfidence = 0.6) => {
  const newMapping = { ...currentMapping };
  let appliedCount = 0;
  let skippedCount = 0;

  aiMappings.forEach(({ source, target, confidence }) => {
    // Only process suggestions with confidence above threshold and valid target
    if (confidence >= minConfidence && target !== null) {
      // Only update fields not yet manually set (empty or undefined)
      if (!currentMapping[source] || currentMapping[source] === '') {
        newMapping[source] = target;
        appliedCount++;
      } else {
        skippedCount++;
      }
    }
  });

  return {
    mapping: newMapping,
    appliedCount,
    skippedCount,
    totalSuggestions: aiMappings.length
  };
};

export default {
  extractAiJson,
  generateMappingPrompt,
  validateMappingResponse,
  mergeMappings
};
