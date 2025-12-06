/**
 * AI 欄位映射輔助函數
 * 用於生成 AI prompt 和解析 AI 回應
 */

/**
 * 從 AI 回應文字中提取 JSON
 * @param {string} text - AI 回應的原始文字
 * @returns {Object} 解析後的 JSON 物件，失敗則返回空物件
 */
export const extractAiJson = (text) => {
  if (!text) return {};
  
  // 先嘗試直接解析
  try {
    return JSON.parse(text);
  } catch (_) {
    // 失敗則嘗試提取第一個 {...} 區塊
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_err) {
        return {};
      }
    }
    return {};
  }
};

/**
 * 生成 AI 欄位映射建議的 prompt
 * @param {string} uploadType - 上傳類型
 * @param {Array} schemaFields - Schema 欄位定義
 * @param {Array} originalColumns - 原始 Excel 欄位
 * @param {Array} sampleRows - 樣本資料（前 20 筆）
 * @returns {string} 組合好的 prompt
 */
export const generateMappingPrompt = (uploadType, schemaFields, originalColumns, sampleRows) => {
  // 簡化 schema fields，只保留必要資訊
  const simplifiedSchema = schemaFields.map(f => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required
  }));

  const prompt = `你是一個資料映射專家。請幫我分析 Excel 欄位並建議對應的系統欄位。

**上傳類型**: ${uploadType}

**系統欄位定義**:
${JSON.stringify(simplifiedSchema, null, 2)}

**原始 Excel 欄位**:
${JSON.stringify(originalColumns, null, 2)}

**樣本資料 (前 20 筆)**:
${JSON.stringify(sampleRows.slice(0, 5), null, 2)}
${sampleRows.length > 5 ? `... 還有 ${sampleRows.length - 5} 筆資料` : ''}

**任務**:
請根據欄位名稱的語意和樣本資料的內容，推測每個原始欄位應該對應到哪個系統欄位。

**要求**:
1. 仔細比對欄位名稱的中英文含義
2. 參考樣本資料的內容和格式
3. 如果無法確定對應關係，target 設為 null
4. confidence 為信心度（0.0 到 1.0）：
   - 0.9-1.0: 非常確定（欄位名稱完全匹配）
   - 0.7-0.9: 很有信心（語意明確對應）
   - 0.5-0.7: 中等信心（可能對應）
   - 0.0-0.5: 低信心（不確定）

**只回傳 JSON 格式**，不要有其他說明文字：
{
  "mappings": [
    {
      "source": "原始欄位名",
      "target": "system_field_key 或 null",
      "confidence": 0.95,
      "reason": "簡短說明為什麼這樣對應"
    }
  ]
}

請開始分析並回傳 JSON：`;

  return prompt;
};

/**
 * 驗證 AI 回應的 mappings 格式
 * @param {Object} aiResponse - AI 回應的物件
 * @returns {boolean} 是否為有效格式
 */
export const validateMappingResponse = (aiResponse) => {
  if (!aiResponse || typeof aiResponse !== 'object') {
    return false;
  }

  if (!Array.isArray(aiResponse.mappings)) {
    return false;
  }

  // 檢查每個 mapping 是否有必要的欄位
  return aiResponse.mappings.every(m => 
    typeof m === 'object' &&
    typeof m.source === 'string' &&
    (m.target === null || typeof m.target === 'string') &&
    typeof m.confidence === 'number' &&
    m.confidence >= 0 &&
    m.confidence <= 1
  );
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

