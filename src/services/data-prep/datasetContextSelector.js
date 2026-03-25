/**
 * datasetContextSelector.js
 * ──────────────────────────────────────────────────────────────────
 * Query-time context selection: given a user question, pick the most
 * relevant sheets/tables from a full dataset profile so the digest
 * stays within a fixed token budget regardless of how many tables exist.
 *
 * Strategy: keyword matching + column name matching + distinct value matching
 * Budget: max 5 sheets selected per query
 */

const KEYWORD_WEIGHT = 3;
const COLUMN_WEIGHT = 2;
const ROLE_WEIGHT = 1;

/**
 * @param {object} profileJson - Full profile_json from dataset_profiles row
 * @param {string} userMessage - The user's current question
 * @param {object} [options]
 * @param {number} [options.maxSheets=5] - Maximum sheets to select
 * @returns {object} filteredProfile - Same structure as profileJson but with only relevant sheets
 */
export function selectRelevantContext(profileJson, userMessage, { maxSheets = 5 } = {}) {
  if (!profileJson?.sheets?.length) return profileJson;
  if (!userMessage) return profileJson;

  const query = userMessage.toLowerCase();
  const queryTokens = extractTokens(query);

  // Score each sheet by relevance to the user's question
  const scored = profileJson.sheets.map(sheet => {
    let score = 0;

    // 1. Sheet name match
    if (query.includes(sheet.sheet_name.toLowerCase())) {
      score += KEYWORD_WEIGHT * 2;
    }

    // 2. Role keyword match
    const roleKeywords = getRoleKeywords(sheet.likely_role);
    for (const rk of roleKeywords) {
      if (query.includes(rk)) score += ROLE_WEIGHT;
    }

    // 3. Column name match
    const semantics = sheet.column_semantics || [];
    for (const col of semantics) {
      const colLower = col.column.toLowerCase();
      const normalLower = (col.normalized || '').toLowerCase();

      for (const token of queryTokens) {
        if (colLower.includes(token) || normalLower.includes(token)) {
          score += COLUMN_WEIGHT;
        }
      }
    }

    // 4. Distinct value match (user mentions a value that exists in a column)
    for (const col of semantics) {
      if (col.distinct_values) {
        for (const val of col.distinct_values) {
          if (query.includes(String(val).toLowerCase())) {
            score += KEYWORD_WEIGHT;
          }
        }
      }
    }

    return { sheet, score };
  });

  // Sort by score descending, take top N with score > 0
  scored.sort((a, b) => b.score - a.score);
  const selected = scored
    .filter(s => s.score > 0)
    .slice(0, maxSheets)
    .map(s => s.sheet);

  // Fallback: if nothing matched, take first 3 sheets
  const finalSheets = selected.length > 0
    ? selected
    : profileJson.sheets.slice(0, 3);

  return {
    ...profileJson,
    sheets: finalSheets,
    _contextSelection: {
      totalSheets: profileJson.sheets.length,
      selectedSheets: finalSheets.map(s => s.sheet_name),
      method: selected.length > 0 ? 'relevance' : 'fallback',
    },
  };
}

function extractTokens(text) {
  const english = text.match(/[a-z_]{2,}/g) || [];
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const stopWords = new Set([
    'the', 'and', 'for', 'this', 'that', 'with', 'from', 'are', 'was', 'will', 'can',
    'the', 'how', 'what', 'which', 'show', 'tell', 'give', 'want', 'need', 'please',
    '的', '了', '嗎', '呢', '是', '在', '有', '我', '你', '他', '她',
    '什麼', '怎麼', '如何', '可以', '能不能', '幫我', '請問',
  ]);
  return [...english, ...chinese].filter(t => !stopWords.has(t));
}

function getRoleKeywords(role) {
  const map = {
    demand_fg: ['sales', 'demand', 'order', 'revenue', '銷售', '訂單', '營收', '需求'],
    bom_edge: ['bom', 'component', 'material', '物料', '組件'],
    inventory_snapshots: ['inventory', 'stock', '庫存', '存貨'],
    po_open_lines: ['purchase', '採購', '採購單'],
    supplier_master: ['supplier', 'vendor', '供應商'],
    fg_financials: ['cost', 'price', 'margin', 'finance', '成本', '價格', '財務', '利潤'],
    goods_receipt: ['receipt', '收貨'],
    price_history: ['price', '價格', '歷史價'],
  };
  return map[role] || [];
}
