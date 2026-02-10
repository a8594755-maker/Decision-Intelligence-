/**
 * Header Normalization Utilities
 * Resolves header string inconsistencies during AI mapping (case, whitespace, underscores, fullwidth, invisible characters, etc.)
 */

/**
 * Normalize a single header string
 * Resolves header string inconsistencies during AI mapping (case, whitespace, underscores, fullwidth, invisible characters, etc.)
 * 
 * @param {string} str - Original header
 * @returns {string} - Normalized header
 * 
 * @example
 * normalizeHeader('Plant ID')         // → 'plant id'
 * normalizeHeader('Plant_ID')         // → 'plant id'
 * normalizeHeader('Plant ID ')        // → 'plant id' (trailing whitespace)
 * normalizeHeader('Plant\nID')        // → 'plant id' (newline)
 * normalizeHeader('Plant\u00A0ID')    // → 'plant id' (NBSP)
 * normalizeHeader('Ｐｌａｎｔ　ＩＤ')  // → 'plant id' (fullwidth)
 */
export function normalizeHeader(str) {
  if (!str || typeof str !== 'string') return '';
  
  let normalized = str;
  
  // 1. Trim (remove leading/trailing whitespace)
  normalized = normalized.trim();
  
  // 2. Remove invisible characters (zero-width spaces, BOM, soft hyphens, etc.)
  normalized = normalized.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  
  // 3. Remove NBSP (Non-Breaking Space, \u00A0)
  normalized = normalized.replace(/\u00A0/g, ' ');
  
  // 4. Remove control characters (newline, tab, carriage return, etc.)
  normalized = normalized.replace(/[\r\n\t\f\v]/g, ' ');
  
  // 5. Fullwidth to halfwidth conversion (fullwidth spaces, fullwidth characters)
  normalized = normalized.replace(/[\uFF01-\uFF5E]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  normalized = normalized.replace(/\u3000/g, ' '); // Fullwidth space
  
  // 6. Convert to lowercase
  normalized = normalized.toLowerCase();
  
  // 7. Convert underscores, hyphens, dots to spaces
  normalized = normalized.replace(/[_\-\.]/g, ' ');
  
  // 8. Collapse consecutive spaces to single space
  normalized = normalized.replace(/\s+/g, ' ');
  
  // 9. Trim again (remove leading/trailing whitespace)
  normalized = normalized.trim();
  
  return normalized;
}

/**
 * Build header index: normalized -> originalHeader
 * @param {string[]} headers - Original headers array
 * @returns {object} - { index: Map<normalized, originalHeader>, duplicates: string[] }
 */
export function buildHeaderIndex(headers) {
  const index = new Map();
  const duplicates = [];
  const seenNormalized = new Map(); // Track original headers for each normalized value
  
  headers.forEach((originalHeader, idx) => {
    const normalized = normalizeHeader(originalHeader);
    
    if (!normalized) {
      console.warn(`[HeaderNormalize] Empty header at index ${idx}:`, originalHeader);
      return;
    }
    
    if (index.has(normalized)) {
      // Duplicate normalized header
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
      // First occurrence, record in index
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
 * Align AI mapping: map AI-returned source to actual originalHeader
 * @param {Array} aiMappings - AI-returned mappings: [{ source, target, confidence }]
 * @param {Map} headerIndex - Index returned by buildHeaderIndex
 * @returns {object} - { alignedMappings: Array, unmatchedSources: Array }
 */
export function alignAiMappings(aiMappings, headerIndex) {
  const alignedMappings = [];
  const unmatchedSources = [];
  
  aiMappings.forEach((mapping) => {
    const { source, target, confidence } = mapping;
    const srcNorm = normalizeHeader(source);
    
    if (headerIndex.has(srcNorm)) {
      // ✅ Successfully aligned: use actual originalHeader
      const originalHeader = headerIndex.get(srcNorm);
      alignedMappings.push({
        source: originalHeader,  // ✅ Replaced with actual header
        target,
        confidence,
        _aiOriginalSource: source  // Keep AI original source (for debug)
      });
    } else {
      // ❌ Unmatched: record unmatchedSource
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
 * Debug output: header normalize statistics
 * @param {string[]} headers - Original headers
 * @param {object} headerIndexResult - Result from buildHeaderIndex
 */
export function logHeaderStats(headers, headerIndexResult) {
  const { stats, duplicates } = headerIndexResult;
  
  console.log(`[MappingAlign] headers=${stats.total} normalizedUnique=${stats.unique} duplicates=${JSON.stringify(duplicates)}`);
  
  if (duplicates.length > 0) {
    console.warn(`[MappingAlign] Found ${duplicates.length} duplicate normalized headers:`, duplicates);
  }
}

/**
 * Debug output: AI mapping alignment statistics
 * @param {object} alignResult - Result from alignAiMappings
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
