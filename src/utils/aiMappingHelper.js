/**
 * AI 欄位映射輔助函數
 * 用於生成 AI prompt 和解析 AI 回應
 */

/**
 * 從 AI 回應文字中提取 JSON（增強版）
 * @param {string} text - AI 回應的原始文字
 * @returns {Object} 解析後的 JSON 物件，失敗則返回空物件
 */
export const extractAiJson = (text) => {
  if (!text) {
    console.error('Empty AI response');
    return {};
  }
  
  console.log('Extracting JSON from:', text.substring(0, 200));
  
  // 策略 1: 直接解析
  try {
    const parsed = JSON.parse(text);
    console.log('Strategy 1 (direct parse) succeeded');
    return parsed;
  } catch (_) {
    // 繼續嘗試其他策略
  }
  
  // 策略 2: 移除 markdown
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
    // 繼續嘗試
  }
  
  // 策略 3: 提取 {...} 區塊（更智能）
  try {
    // 找到第一個 { 和對應的 }
    const startIdx = text.indexOf('{');
    if (startIdx === -1) {
      console.error('No opening brace found');
      return {};
    }
    
    // 使用括號配對找到正確的結束位置
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
  
  // 策略 4: 尋找 "mappings" 關鍵字附近的 JSON
  try {
    const mappingsIdx = text.toLowerCase().indexOf('"mappings"');
    if (mappingsIdx !== -1) {
      // 從 mappings 前面找 {
      let searchStart = Math.max(0, mappingsIdx - 50);
      const startIdx = text.lastIndexOf('{', mappingsIdx);
      
      if (startIdx !== -1) {
        // 使用括號配對
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
  
  // 所有策略都失敗
  console.error('All extraction strategies failed');
  console.error('Original text:', text);
  return {};
};

/**
 * 智能規則式映射（AI 失敗時的備選方案）
 * @param {Array} originalColumns - 原始 Excel 欄位
 * @param {string} uploadType - 上傳類型
 * @param {Array} schemaFields - Schema 欄位定義
 * @returns {Array} 映射建議
 */
export const ruleBasedMapping = (originalColumns, uploadType, schemaFields) => {
  const mappings = [];
  
  // 定義規則：Excel 欄位模式 -> 系統欄位 key
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
  
  // 為每個 Excel 欄位找最佳匹配
  originalColumns.forEach(col => {
    let bestMatch = null;
    let bestConfidence = 0;

    // 遍歷所有系統欄位規則
    Object.entries(typeRules).forEach(([systemField, patterns]) => {
      patterns.forEach(pattern => {
        if (pattern.test(col)) {
          // 計算信心度：完全匹配 > 包含匹配
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
 * 生成 AI 欄位映射建議的 prompt（極簡版本）
 * @param {string} uploadType - 上傳類型
 * @param {Array} schemaFields - Schema 欄位定義
 * @param {Array} originalColumns - 原始 Excel 欄位
 * @param {Array} sampleRows - 樣本資料（前 20 筆）
 * @returns {string} 組合好的 prompt
 */
/**
 * 簡化樣本資料 - 只顯示前幾個字元，避免 prompt 過長
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
      // 只保留前 20 個字元
      simplified[key] = strValue.length > 20 ? strValue.substring(0, 20) + '...' : strValue;
    }
  });
  
  return simplified;
};

export const generateMappingPrompt = (uploadType, schemaFields, originalColumns, sampleRows) => {
  const systemKeys = schemaFields.map(f => f.key);
  
  // 單行超極簡 Prompt - 避免 AI 返回解釋文字
  
  // Supplier Master - 單行版本
  if (uploadType === 'supplier_master') {
    return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Rules: supplier_code/vendor_code/code→supplier_code, supplier_name/company_name/company/name→supplier_name, contact/rep→contact_person, phone/tel→phone, email/mail→email. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
  }
  
  // Price History - 單行版本
  if (uploadType === 'price_history') {
    return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Rules: supplier/vendor→supplier_name, material_code/part_no→material_code, order_date/quote_date→order_date, price/unit_price→unit_price, currency/curr→currency. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
  }
  
  // Goods Receipt - 單行版本
  if (uploadType === 'goods_receipt') {
    return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Rules: supplier/vendor→supplier_name, material_code/part_no→material_code, delivery_date/received_date→actual_delivery_date, qty/quantity→received_qty. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
  }
  
  // 其他類型 - 單行通用版本
  const firstRow = simplifyFirstRow(sampleRows[0] || {});
  return `Match columns: EXCEL=${JSON.stringify(originalColumns)} to SYSTEM=${JSON.stringify(systemKeys)}. Sample=${JSON.stringify(firstRow)}. Output JSON only: {"mappings":[{"source":"excel_col","target":"system_key","confidence":0.9}]}`;
};

/**
 * 驗證 AI 回應的 mappings 格式（寬鬆版本）
 * @param {Object} aiResponse - AI 回應的物件
 * @returns {boolean} 是否為有效格式
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

  // 檢查每個 mapping（使用寬鬆驗證）
  let validCount = 0;
  let invalidCount = 0;

  const cleanedMappings = aiResponse.mappings
    .map((m, index) => {
      // 必須是物件
      if (!m || typeof m !== 'object') {
        console.warn(`⚠️ Mapping ${index} is not an object`);
        invalidCount++;
        return null;
      }

      // 必須有 source
      if (!m.source || typeof m.source !== 'string') {
        console.warn(`⚠️ Mapping ${index} missing valid source:`, m);
        invalidCount++;
        return null;
      }

      // target 可以是 null 或 string
      if (m.target !== null && typeof m.target !== 'string') {
        console.warn(`⚠️ Mapping ${index} has invalid target:`, m.target);
        invalidCount++;
        return null;
      }

      // confidence 如果不是數字，給預設值
      let confidence = m.confidence;
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        console.warn(`⚠️ Mapping ${index} has invalid confidence (${confidence}), using 0.5`);
        confidence = 0.5;
      }

      // reason 是可選的
      const reason = m.reason || 'AI suggestion';

      validCount++;
      return {
        source: m.source,
        target: m.target,
        confidence: confidence,
        reason: reason
      };
    })
    .filter(m => m !== null); // 移除無效的 mappings

  console.log(`✅ Valid mappings: ${validCount}, ❌ Invalid: ${invalidCount}`);

  // 只要有至少一個有效的 mapping 就算成功
  if (cleanedMappings.length > 0) {
    // 替換原始 mappings 為清理後的版本
    aiResponse.mappings = cleanedMappings;
    return true;
  }

  console.error('❌ No valid mappings found');
  return false;
};

/**
 * 將 AI 建議的 mappings 合併到現有的 columnMapping
 * @param {Object} currentMapping - 現有的 columnMapping
 * @param {Array} aiMappings - AI 建議的 mappings
 * @param {number} minConfidence - 最低信心度閾值（預設 0.6）
 * @returns {Object} 合併後的 mapping 和統計資訊
 */
export const mergeMappings = (currentMapping, aiMappings, minConfidence = 0.6) => {
  const newMapping = { ...currentMapping };
  let appliedCount = 0;
  let skippedCount = 0;

  aiMappings.forEach(({ source, target, confidence }) => {
    // 只處理信心度達到閾值且有 target 的建議
    if (confidence >= minConfidence && target !== null) {
      // 只更新尚未手動設定的欄位（空的或未定義）
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



