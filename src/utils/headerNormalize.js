/**
 * Header Normalization Utilities
 * 解決 AI mapping 時 header 字串不一致的問題（大小寫、空白、底線、全形、不可見字元等）
 */

/**
 * 正規化單個 header 字串
 * 解決 AI mapping 時 header 字串不一致的問題（大小寫、空白、底線、全形、不可見字元等）
 * 
 * @param {string} str - 原始 header
 * @returns {string} - 正規化後的 header
 * 
 * @example
 * normalizeHeader('Plant ID')         // → 'plant id'
 * normalizeHeader('Plant_ID')         // → 'plant id'
 * normalizeHeader('Plant ID ')        // → 'plant id' (尾隨空白)
 * normalizeHeader('Plant\nID')        // → 'plant id' (換行)
 * normalizeHeader('Plant\u00A0ID')    // → 'plant id' (NBSP)
 * normalizeHeader('Ｐｌａｎｔ　ＩＤ')  // → 'plant id' (全形)
 */
export function normalizeHeader(str) {
  if (!str || typeof str !== 'string') return '';
  
  let normalized = str;
  
  // 1. Trim（移除前後空白）
  normalized = normalized.trim();
  
  // 2. 移除不可見字元（零寬空格、BOM、軟連字符等）
  normalized = normalized.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  
  // 3. 移除 NBSP (Non-Breaking Space, \u00A0)
  normalized = normalized.replace(/\u00A0/g, ' ');
  
  // 4. 移除控制字元（換行、tab、回車等）
  normalized = normalized.replace(/[\r\n\t\f\v]/g, ' ');
  
  // 5. 全形轉半形（全形空白、全形字符）
  normalized = normalized.replace(/[\uFF01-\uFF5E]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  normalized = normalized.replace(/\u3000/g, ' '); // 全形空白
  
  // 6. 全部轉小寫
  normalized = normalized.toLowerCase();
  
  // 7. 底線、連字符、點 轉成空白
  normalized = normalized.replace(/[_\-\.]/g, ' ');
  
  // 8. 連續空白變單一空白
  normalized = normalized.replace(/\s+/g, ' ');
  
  // 9. 再次 trim（去除前後空白）
  normalized = normalized.trim();
  
  return normalized;
}

/**
 * 建立 header 索引：normalized -> originalHeader
 * @param {string[]} headers - 原始 headers 陣列
 * @returns {object} - { index: Map<normalized, originalHeader>, duplicates: string[] }
 */
export function buildHeaderIndex(headers) {
  const index = new Map();
  const duplicates = [];
  const seenNormalized = new Map(); // 記錄每個 normalized 出現的原始 header
  
  headers.forEach((originalHeader, idx) => {
    const normalized = normalizeHeader(originalHeader);
    
    if (!normalized) {
      console.warn(`[HeaderNormalize] Empty header at index ${idx}:`, originalHeader);
      return;
    }
    
    if (index.has(normalized)) {
      // 重複的 normalized header
      const firstOriginal = index.get(normalized);
      if (!seenNormalized.has(normalized)) {
        duplicates.push(normalized);
        seenNormalized.set(normalized, [firstOriginal]);
      }
      seenNormalized.get(normalized).push(originalHeader);
      console.warn(`[HeaderNormalize] Duplicate normalized header "${normalized}":`, {
        first: firstOriginal,
        duplicate: originalHeader
      });
    } else {
      // 第一次出現，記錄到 index
      index.set(normalized, originalHeader);
    }
  });
  
  return {
    index,
    duplicates,
    stats: {
      total: headers.length,
      unique: index.size,
      duplicateCount: duplicates.length
    }
  };
}

/**
 * 對齊 AI mapping：將 AI 回傳的 source 對應到實際的 originalHeader
 * @param {Array} aiMappings - AI 回傳的 mappings: [{ source, target, confidence }]
 * @param {Map} headerIndex - buildHeaderIndex 回傳的 index
 * @returns {object} - { alignedMappings: Array, unmatchedSources: Array }
 */
export function alignAiMappings(aiMappings, headerIndex) {
  const alignedMappings = [];
  const unmatchedSources = [];
  
  aiMappings.forEach((mapping) => {
    const { source, target, confidence } = mapping;
    const srcNorm = normalizeHeader(source);
    
    if (headerIndex.has(srcNorm)) {
      // ✅ 成功對齊：使用實際的 originalHeader
      const originalHeader = headerIndex.get(srcNorm);
      alignedMappings.push({
        source: originalHeader,  // ✅ 替換成真實的 header
        target,
        confidence,
        _aiOriginalSource: source  // 保留 AI 原始 source（debug 用）
      });
    } else {
      // ❌ 對不上：記錄 unmatchedSource
      unmatchedSources.push({
        aiSource: source,
        normalized: srcNorm
      });
      console.warn(`[MappingAlign] Unmatched AI source: "${source}" (normalized: "${srcNorm}")`);
    }
  });
  
  return {
    alignedMappings,
    unmatchedSources,
    stats: {
      total: aiMappings.length,
      aligned: alignedMappings.length,
      unmatched: unmatchedSources.length
    }
  };
}

/**
 * Debug 輸出：header normalize 統計
 * @param {string[]} headers - 原始 headers
 * @param {object} headerIndexResult - buildHeaderIndex 回傳結果
 */
export function logHeaderStats(headers, headerIndexResult) {
  const { stats, duplicates } = headerIndexResult;
  
  console.log(`[MappingAlign] headers=${stats.total} normalizedUnique=${stats.unique} duplicates=${JSON.stringify(duplicates)}`);
  
  if (duplicates.length > 0) {
    console.warn(`[MappingAlign] Found ${duplicates.length} duplicate normalized headers:`, duplicates);
  }
}

/**
 * Debug 輸出：AI mapping 對齊統計
 * @param {object} alignResult - alignAiMappings 回傳結果
 */
export function logMappingAlignStats(alignResult) {
  const { stats, unmatchedSources } = alignResult;
  
  console.log(
    `[MappingAlign] aiMappings=${stats.total} aligned=${stats.aligned} unmatchedSources=${JSON.stringify(unmatchedSources.map(u => u.aiSource))}`
  );
  
  if (unmatchedSources.length > 0) {
    console.warn(`[MappingAlign] ${unmatchedSources.length} AI mappings could not be aligned:`, unmatchedSources);
  }
}
