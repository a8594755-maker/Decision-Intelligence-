/**
 * AI Field Mapping Helper Functions
 * Used for generating AI prompts and parsing AI responses
 */

/**
 * Extract JSON from AI response text (enhanced version)
 * @param {string} text - Raw AI response text
 * @returns {Object} Parsed JSON object, returns empty object on failure
 */
export const extractAiJson = (text) => {
  if (!text) {
    console.error('Empty AI response');
    return {};
  }
  
  console.log('Extracting JSON from:', text.substring(0, 200));
  
  // Strategy 1: Direct parse
  try {
    const parsed = JSON.parse(text);
    console.log('Strategy 1 (direct parse) succeeded');
    return parsed;
  } catch (_) {
    // Continue trying other strategies
  }
  
  // Strategy 2: Remove markdown
  try {
    let cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```javascript\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    
    const parsed = JSON.parse(cleaned);
    console.log('Strategy 2 (remove markdown) succeeded');
    return parsed;
  } catch (_) {
    // Continue trying
  }
  
  // Strategy 3: Extract {...} block (smarter)
  try {
    // Find the first { and its matching }
    const startIdx = text.indexOf('{');
    if (startIdx === -1) {
      console.error('No opening brace found');
      return {};
    }
    
    // Use brace matching to find correct end position
    let braceCount = 0;
    let endIdx = -1;
    
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') braceCount++;
      if (text[i] === '}') braceCount--;
      if (braceCount === 0) {
        endIdx = i;
        break;
      }
    }
    
    if (endIdx === -1) {
      console.error('No matching closing brace found');
      return {};
    }
    
    const jsonStr = text.substring(startIdx, endIdx + 1);
    const parsed = JSON.parse(jsonStr);
    console.log('Strategy 3 (extract braces) succeeded');
    return parsed;
  } catch (e) {
    console.error('Strategy 3 failed:', e);
  }
  
  // Strategy 4: Find JSON near "mappings" keyword
  try {
    const mappingsIdx = text.toLowerCase().indexOf('"mappings"');
    if (mappingsIdx !== -1) {
      // Find { before mappings
      let searchStart = Math.max(0, mappingsIdx - 50);
      const startIdx = text.lastIndexOf('{', mappingsIdx);
      
      if (startIdx !== -1) {
        // Use brace matching
        let braceCount = 0;
        let endIdx = -1;
        
        for (let i = startIdx; i < text.length; i++) {
          if (text[i] === '{') braceCount++;
          if (text[i] === '}') braceCount--;
          if (braceCount === 0) {
            endIdx = i;
            break;
          }
        }
        
        if (endIdx !== -1) {
          const jsonStr = text.substring(startIdx, endIdx + 1);
          const parsed = JSON.parse(jsonStr);
          console.log('Strategy 4 (find mappings) succeeded');
          return parsed;
        }
      }
    }
  } catch (e) {
    console.error('Strategy 4 failed:', e);
  }
  
  // All strategies failed
  console.error('All extraction strategies failed');
  console.error('Original text:', text);
  return {};
};

/**
 * Smart rule-based mapping (fallback when AI fails)
 * @param {Array} originalColumns - Original Excel columns
 * @param {string} uploadType - Upload type
 * @param {Array} schemaFields - Schema field definitions
 * @returns {Array} Mapping suggestions
 */
export const ruleBasedMapping = (originalColumns, uploadType, schemaFields) => {
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


/**
 * Generate AI field mapping suggestion prompt (minimal version)
 * @param {string} uploadType - Upload type
 * @param {Array} schemaFields - Schema field definitions
 * @param {Array} originalColumns - Original Excel columns
 * @param {Array} sampleRows - Sample data (first 20 rows)
 * @returns {string} Composed prompt
 */
/**
 * Simplify sample data - only show first few characters to avoid overly long prompt
 */
const simplifyFirstRow = (row) => {
  if (!row || typeof row !== 'object') return {};
  
  const simplified = {};
  Object.keys(row).forEach(key => {
    const value = row[key];
    if (!value) {
      simplified[key] = '';
    } else {
      const strValue = String(value);
      // Keep only first 20 characters
      simplified[key] = strValue.length > 20 ? strValue.substring(0, 20) + '...' : strValue;
    }
  });
  
  return simplified;
};

export const generateMappingPrompt = (uploadType, schemaFields, originalColumns, sampleRows) => {
  const systemKeys = schemaFields.map(f => f.key);
  
  // Single-line ultra-minimal Prompt - avoid AI returning explanatory text
  
  // Supplier Master - single-line version
  if (uploadType === 'supplier_master') {
    return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Rules: supplier_code/vendor_code/code→supplier_code, supplier_name/company_name/company/name→supplier_name, contact/rep→contact_person, phone/tel→phone, email/mail→email. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
  }
  
  // Price History - single-line version
  if (uploadType === 'price_history') {
    return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Rules: supplier/vendor→supplier_name, material_code/part_no→material_code, order_date/quote_date→order_date, price/unit_price→unit_price, currency/curr→currency. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
  }
  
  // Goods Receipt - single-line version
  if (uploadType === 'goods_receipt') {
    return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Rules: supplier/vendor→supplier_name, material_code/part_no→material_code, delivery_date/received_date→actual_delivery_date, qty/quantity→received_qty. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
  }
  
  // Other types - single-line generic version
  const firstRow = simplifyFirstRow(sampleRows[0] || {});
  return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Sample=${JSON.stringify(firstRow)}. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
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

  if (!Array.isArray(aiResponse.mappings)) {
    console.error('❌ AI response missing "mappings" array. Keys:', Object.keys(aiResponse));
    return false;
  }

  if (aiResponse.mappings.length === 0) {
    console.error('❌ AI response has empty mappings array');
    return false;
  }

  console.log(`Validating ${aiResponse.mappings.length} mappings...`);

  // Check each mapping (using lenient validation)
  let validCount = 0;
  let invalidCount = 0;

  const cleanedMappings = aiResponse.mappings
    .map((m, index) => {
      // Must be an object
      if (!m || typeof m !== 'object') {
        console.warn(`⚠️ Mapping ${index} is not an object`);
        invalidCount++;
        return null;
      }

      // Must have source
      if (!m.source || typeof m.source !== 'string') {
        console.warn(`⚠️ Mapping ${index} missing valid source:`, m);
        invalidCount++;
        return null;
      }

      // target can be null or string
      if (m.target !== null && typeof m.target !== 'string') {
        console.warn(`⚠️ Mapping ${index} has invalid target:`, m.target);
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
        source: m.source,
        target: m.target,
        confidence: confidence,
        reason: reason
      };
    })
    .filter(m => m !== null); // Remove invalid mappings

  console.log(`✅ Valid mappings: ${validCount}, ❌ Invalid: ${invalidCount}`);

  // As long as there's at least one valid mapping, consider it successful
  if (cleanedMappings.length > 0) {
    // Replace original mappings with cleaned version
    aiResponse.mappings = cleanedMappings;
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



