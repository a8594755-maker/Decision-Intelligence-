/**
 * Data Insight Service — captures, stores, and retrieves factual insights
 * learned from SQL queries during agent conversations.
 *
 * Insights are stored in localStorage and survive across sessions,
 * enabling the agent to "remember" data facts from previous interactions.
 */

const LOCAL_KEY = 'di_data_insights_v1';
const MAX_INSIGHTS = 200;

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

function _loadInsights() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  } catch {
    return [];
  }
}

function _saveInsights(insights) {
  // Keep most recent MAX_INSIGHTS entries
  const trimmed = insights.slice(-MAX_INSIGHTS);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(trimmed));
}

function _hashFact(table, column, fact) {
  // Simple dedup key
  return `${table}|${column}|${fact.replace(/[\d,.]+/g, '#')}`;
}

/**
 * Record a single data insight.
 */
export function recordInsight({ table, column = '', fact, confidence = 0.9, sourceQuery = '' }) {
  const insights = _loadInsights();
  const hash = _hashFact(table, column, fact);

  // Deduplicate: update existing if same hash
  const existingIdx = insights.findIndex(i => _hashFact(i.table, i.column, i.fact) === hash);
  if (existingIdx >= 0) {
    insights[existingIdx] = { ...insights[existingIdx], fact, confidence, sourceQuery, updatedAt: new Date().toISOString() };
  } else {
    insights.push({
      id: `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      table,
      column,
      fact,
      confidence,
      sourceQuery,
      createdAt: new Date().toISOString(),
    });
  }

  _saveInsights(insights);
}

/**
 * Get all insights, optionally filtered.
 */
export function getInsights(filters = {}) {
  let insights = _loadInsights();
  if (filters.table) insights = insights.filter(i => i.table === filters.table);
  if (filters.column) insights = insights.filter(i => i.column === filters.column);
  if (filters.minConfidence) insights = insights.filter(i => i.confidence >= filters.minConfidence);
  return insights;
}

/**
 * Get insights relevant to the user's current message.
 * Matches by table names and column names found in the message.
 */
export function getRelevantInsights(userMessage, limit = 10) {
  if (!userMessage) return [];
  const lower = userMessage.toLowerCase();
  const insights = _loadInsights();

  // Score each insight by relevance
  const scored = insights.map(i => {
    let score = 0;
    if (i.table && lower.includes(i.table.toLowerCase())) score += 2;
    if (i.column && lower.includes(i.column.toLowerCase())) score += 1;
    // Check for common keywords in the fact
    const factWords = i.fact.toLowerCase().split(/\s+/);
    const msgWords = lower.split(/\s+/);
    for (const w of msgWords) {
      if (w.length > 3 && factWords.includes(w)) score += 0.5;
    }
    return { ...i, _score: score };
  });

  return scored
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score || b.confidence - a.confidence)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Rule-based insight extraction from query results
// ---------------------------------------------------------------------------

/**
 * Extract factual insights from a SQL query result.
 * Uses pattern matching on SQL + result shape — no LLM call needed.
 */
export function extractInsightsFromQueryResult(sql, rows, rowCount) {
  if (!sql || !rows) return;

  const upperSql = sql.toUpperCase();
  const extracted = [];

  try {
    // Extract table names from SQL
    const tableMatches = sql.match(/\bFROM\s+(\w+)/i);
    const table = tableMatches ? tableMatches[1].toLowerCase() : 'unknown';

    // Pattern 1: COUNT(*) with single result
    if (/\bCOUNT\s*\(/i.test(sql) && rows.length === 1) {
      const countVal = Object.values(rows[0])[0];
      if (typeof countVal === 'number') {
        const countKey = Object.keys(rows[0])[0];
        extracted.push({
          table,
          column: '',
          fact: `${table} table has ${countVal.toLocaleString()} ${countKey === 'count(*)' ? 'rows' : countKey}`,
          confidence: 1.0,
        });
      }
    }

    // Pattern 2: GROUP BY + ORDER BY ... DESC LIMIT → ranking
    if (/\bGROUP\s+BY\b/i.test(sql) && /\bORDER\s+BY\b.*\bDESC\b/i.test(sql) && rows.length > 0 && rows.length <= 20) {
      const keys = Object.keys(rows[0]);
      if (keys.length >= 2) {
        const labelKey = keys[0];
        const valueKey = keys[keys.length - 1];
        const groupCol = sql.match(/\bGROUP\s+BY\s+(\w+(?:\.\w+)?)/i)?.[1]?.replace(/.*\./, '') || labelKey;

        // Top entry fact
        const topLabel = rows[0][labelKey];
        const topValue = rows[0][valueKey];
        if (topLabel && topValue != null) {
          const formattedVal = typeof topValue === 'number' ? topValue.toLocaleString() : topValue;
          extracted.push({
            table,
            column: groupCol,
            fact: `Top ${groupCol} in ${table}: "${topLabel}" with ${formattedVal} ${valueKey}`,
            confidence: 0.9,
          });
        }

        // Distribution fact if we have percentages or can compute them
        if (rows.length >= 3 && typeof rows[0][valueKey] === 'number') {
          const total = rows.reduce((s, r) => s + (Number(r[valueKey]) || 0), 0);
          if (total > 0) {
            const topPct = ((Number(rows[0][valueKey]) / total) * 100).toFixed(1);
            if (Number(topPct) > 50) {
              extracted.push({
                table,
                column: groupCol,
                fact: `"${rows[0][labelKey]}" dominates ${table}.${groupCol} at ${topPct}% of total`,
                confidence: 0.9,
              });
            }
          }
        }
      }
    }

    // Pattern 3: AVG/SUM/MAX/MIN aggregates
    const aggMatch = upperSql.match(/\b(AVG|SUM|MAX|MIN)\s*\(\s*(\w+(?:\.\w+)?)\s*\)/i);
    if (aggMatch && rows.length === 1) {
      const aggFunc = aggMatch[1].toUpperCase();
      const aggCol = aggMatch[2].replace(/.*\./, '');
      const aggVal = Object.values(rows[0])[0];
      if (aggVal != null) {
        const formatted = typeof aggVal === 'number' ? aggVal.toLocaleString(undefined, { maximumFractionDigits: 2 }) : aggVal;
        extracted.push({
          table,
          column: aggCol,
          fact: `${aggFunc} of ${table}.${aggCol} = ${formatted}`,
          confidence: 1.0,
        });
      }
    }

    // Pattern 4: SELECT DISTINCT with small result → enumerate values
    if (/\bDISTINCT\b/i.test(sql) && rows.length > 0 && rows.length <= 15) {
      const col = Object.keys(rows[0])[0];
      const values = rows.map(r => r[col]).filter(Boolean).slice(0, 10);
      if (values.length > 0) {
        extracted.push({
          table,
          column: col,
          fact: `${table}.${col} has ${values.length} distinct values: ${values.join(', ')}`,
          confidence: 0.9,
        });
      }
    }

    // Record all extracted insights
    for (const ins of extracted) {
      recordInsight({ ...ins, sourceQuery: sql });
    }
  } catch (err) {
    console.warn('[dataInsight] Extraction error:', err.message);
  }
}

/**
 * Clear all stored insights.
 */
export function clearInsights() {
  localStorage.removeItem(LOCAL_KEY);
}
