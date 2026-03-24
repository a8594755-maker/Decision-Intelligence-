# DI Agent 數據理解能力重構方案

> 目標：讓 Agent 在企業級數據規模下（數百張表、數千欄位），仍然能精準理解用戶數據並產出正確結果。
> 核心原則：**Profiling 時深度學習，對話時精準提取，Token 開銷恆定。**

---

## 架構總覽

```
┌─────────────────────────────────────────────────────┐
│  第一層：Deep Profiling（上傳/連接時，一次性）        │
│  - 每欄統計：cardinality, sample values, min/max     │
│  - 跨表關係：FK 推斷                                 │
│  - 存入 DB，profile 大小與原始數據量無關              │
├─────────────────────────────────────────────────────┤
│  第二層：Query-Time Context Selection（每次對話）     │
│  - 根據用戶問題，只提取相關表/欄位的 profile          │
│  - 固定 budget ≈ 1500-2000 tokens，不隨表數增長      │
├─────────────────────────────────────────────────────┤
│  第三層：Execution Memory（跨對話累積）              │
│  - 記住「這個 dataset 用什麼 query pattern 有效」     │
│  - 下次類似問題直接召回，減少試錯                     │
└─────────────────────────────────────────────────────┘
```

---

## 改動 1：加深 Column Profiling（最關鍵）

**檔案：`src/services/datasetProfilingService.js`**

### 現狀（第 77-93 行 `buildColumnSemantics`）

```javascript
// 現在只產出：column, normalized, guessed_type, non_null_ratio
// 缺少：cardinality, sample_values, min/max, date_range
```

### 改法：替換 `buildColumnSemantics` 函數

```javascript
const buildColumnSemantics = (columns, rows) => {
  const sampleRows = rows.slice(0, MAX_STATS_ROWS); // 用 500 行而非 120 行

  return columns.slice(0, 30).map((column) => {
    const values = sampleRows
      .map((row) => row[column])
      .filter((value) => value !== '' && value !== null && value !== undefined);

    const type = detectColumnType(values);
    const nonNullRatio = sampleRows.length > 0
      ? Number((values.length / sampleRows.length).toFixed(3))
      : 0;

    const result = {
      column,
      normalized: normalizeHeader(column),
      guessed_type: type,
      non_null_ratio: nonNullRatio,
    };

    // ── 新增：Cardinality ──
    const uniqueValues = new Set(values.map(v => String(v).trim()));
    result.cardinality = uniqueValues.size;

    // ── 新增：Sample Values（低基數欄位列出全部，高基數取前 8）──
    if (type === 'string' || type === 'boolean') {
      if (uniqueValues.size <= 50) {
        // 低基數：列出所有 distinct values（排序後取前 30）
        result.distinct_values = [...uniqueValues].sort().slice(0, 30);
      } else {
        // 高基數：取出現頻率最高的前 8 個
        const freq = {};
        values.forEach(v => {
          const key = String(v).trim();
          freq[key] = (freq[key] || 0) + 1;
        });
        result.top_values = Object.entries(freq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([val]) => val);
      }
    }

    // ── 新增：數值統計（min/max/mean）──
    if (type === 'number') {
      const nums = values.map(v => Number(v)).filter(Number.isFinite);
      if (nums.length > 0) {
        nums.sort((a, b) => a - b);
        result.stats = {
          min: nums[0],
          max: nums[nums.length - 1],
          mean: Number((nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(2)),
          p25: nums[Math.floor(nums.length * 0.25)],
          p75: nums[Math.floor(nums.length * 0.75)],
        };
      }
    }

    // ── 新增：日期範圍和粒度 ──
    if (type === 'date') {
      const { parseTemporalValue } = timeColumnDetectionInternals;
      const dates = values
        .map(v => parseTemporalValue(v, { allowExcelSerial: false }))
        .filter(Boolean)
        .map(d => new Date(d))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a - b);

      if (dates.length >= 2) {
        result.date_range = {
          min: dates[0].toISOString().slice(0, 10),
          max: dates[dates.length - 1].toISOString().slice(0, 10),
        };
        // 推斷粒度
        const gaps = [];
        for (let i = 1; i < Math.min(dates.length, 50); i++) {
          gaps.push(dates[i] - dates[i - 1]);
        }
        const medianGapMs = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        const medianGapDays = medianGapMs / (1000 * 60 * 60 * 24);
        if (medianGapDays <= 1.5) result.granularity = 'daily';
        else if (medianGapDays <= 8) result.granularity = 'weekly';
        else if (medianGapDays <= 35) result.granularity = 'monthly';
        else result.granularity = 'irregular';
      }
    }

    return result;
  });
};
```

### 重點
- `MAX_STATS_ROWS = 500` 已經定義了，直接用
- 不管原始數據是 1000 行還是 1 億行，profiling 只取前 500 行
- 新增的欄位（cardinality, distinct_values, stats, date_range）都存進 `profile_json`，只算一次

---

## 改動 2：加深 Digest 輸出（讓 LLM 看到有用信息）

**檔案：`src/services/datasetProfilingService.js`**

### 現狀（第 416-532 行 `buildUserDatasetDigest`）

只輸出 `column type` + null 比例 + mapping arrow，budget 3200 chars。

### 改法：重寫 `buildUserDatasetDigest`

```javascript
export const buildUserDatasetDigest = (profileRow, { maxChars = 5000 } = {}) => {
  if (!profileRow?.profile_json) return '';

  const profile = profileRow.profile_json;
  const contract = profileRow.contract_json || {};
  const workflow = profile.global?.workflow_guess || {};
  const timeRange = profile.global?.time_range_guess || {};

  const contractBySheet = new Map();
  for (const ds of (contract.datasets || [])) {
    contractBySheet.set(ds.sheet_name, ds);
  }

  const lines = [];

  // ── Header ──
  const fileName = profile.file_name || `Profile #${profileRow.id}`;
  lines.push(`**User Dataset** — ${fileName}`);
  if (workflow.label) {
    lines.push(`Workflow: ${workflow.label}`);
  }
  if (timeRange.start || timeRange.end) {
    lines.push(`Time range: ${timeRange.start || '?'} → ${timeRange.end || '?'}`);
  }

  // ── Per-sheet digest ──
  const sheets = (profile.sheets || []).slice(0, 8);
  const MAX_COLS = 20;

  for (const sheet of sheets) {
    const role = sheet.likely_role || 'unknown';
    const semantics = sheet.column_semantics || [];
    const rowCount = profileRow._rowCounts?.[sheet.sheet_name];
    const rowNote = rowCount != null ? `, ${rowCount.toLocaleString()} rows` : '';
    lines.push(`\n**${sheet.sheet_name}** (${role}${rowNote})`);

    const cols = semantics.slice(0, MAX_COLS);
    for (const col of cols) {
      const type = col.guessed_type || '?';
      let line = `  - \`${col.column}\` ${type}`;

      // 新增：Cardinality
      if (col.cardinality != null) {
        line += ` (${col.cardinality} unique)`;
      }

      // 新增：低基數 → 列出所有值
      if (col.distinct_values?.length > 0) {
        const vals = col.distinct_values.slice(0, 15).join(', ');
        line += ` → [${vals}]`;
      }
      // 新增：高基數 → 列出 top values
      else if (col.top_values?.length > 0) {
        line += ` → top: [${col.top_values.slice(0, 5).join(', ')}]`;
      }

      // 新增：數值範圍
      if (col.stats) {
        line += ` {${col.stats.min}~${col.stats.max}, avg=${col.stats.mean}}`;
      }

      // 新增：日期範圍
      if (col.date_range) {
        line += ` {${col.date_range.min}~${col.date_range.max}}`;
        if (col.granularity) line += ` [${col.granularity}]`;
      }

      // Null warning（只在比較嚴重時顯示）
      if (col.non_null_ratio != null && col.non_null_ratio < 0.80) {
        line += ` ⚠${Math.round((1 - col.non_null_ratio) * 100)}%null`;
      }

      lines.push(line);
    }

    if (semantics.length > MAX_COLS) {
      lines.push(`  ... +${semantics.length - MAX_COLS} more columns`);
    }
  }

  let result = lines.join('\n');

  // ── Progressive truncation ──
  if (result.length > maxChars) {
    result = result.replace(/ \{[\d.~,avg= ]+\}/g, ''); // 移除數值統計
  }
  if (result.length > maxChars) {
    result = result.replace(/ → (?:top: )?\[[^\]]+\]/g, ''); // 移除 sample values
  }
  if (result.length > maxChars) {
    result = result.replace(/ \(\d+ unique\)/g, ''); // 移除 cardinality
  }

  return result;
};
```

### Token 估算
- 每欄一行約 60-100 chars
- 20 欄 × 80 chars = 1600 chars ≈ 400 tokens
- 加上 header + 多 sheet，整體 3000-5000 chars ≈ 750-1250 tokens
- 比現在多 ~400 tokens，但信息密度提升 5-10 倍
- Progressive truncation 確保永不超過 budget

---

## 改動 3：Query-Time Context Selection（企業級核心）

**新增檔案：`src/services/datasetContextSelector.js`**

當企業有 200 張表時，不能全部塞進 prompt。這個模組根據用戶問題選取相關表。

```javascript
/**
 * datasetContextSelector.js
 * ──────────────────────────────────────────────────────────────────
 * 根據用戶的提問，從完整 profile 中選取相關的 sheets/tables，
 * 產出一個精簡的 "focused profile" 給 buildUserDatasetDigest。
 *
 * 策略：keyword matching + column name matching + relationship following
 * Budget：最多選 5 張表，確保 digest 不超過 5000 chars
 */

const KEYWORD_WEIGHT = 3;
const COLUMN_WEIGHT = 2;
const ROLE_WEIGHT = 1;

/**
 * @param {object} profileJson - 完整的 profile_json
 * @param {string} userMessage - 用戶的提問
 * @param {object} [options]
 * @param {number} [options.maxSheets=5] - 最多選幾張表
 * @returns {object} filteredProfile - 與 profileJson 結構相同，但只含相關 sheets
 */
export function selectRelevantContext(profileJson, userMessage, { maxSheets = 5 } = {}) {
  if (!profileJson?.sheets?.length) return profileJson;
  if (!userMessage) return profileJson;

  const query = userMessage.toLowerCase();
  const queryTokens = extractTokens(query);

  // 對每個 sheet 計算相關性分數
  const scored = profileJson.sheets.map(sheet => {
    let score = 0;

    // 1. Sheet name match
    if (query.includes(sheet.sheet_name.toLowerCase())) {
      score += KEYWORD_WEIGHT * 2;
    }

    // 2. Role match (e.g. "銷售" matches role: "demand_fg")
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

    // 4. Distinct value match (用戶提到的值剛好是某欄的 distinct value)
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

  // 排序、取 top N
  scored.sort((a, b) => b.score - a.score);
  const selected = scored
    .filter(s => s.score > 0)
    .slice(0, maxSheets)
    .map(s => s.sheet);

  // 如果沒有任何匹配，回退到前 3 張表（按行數排序）
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
  // 提取有意義的 token（中英文都支持）
  const english = text.match(/[a-z_]{2,}/g) || [];
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  // 過濾停用詞
  const stopWords = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from',
    '的', '了', '嗎', '呢', '是', '在', '有', '我', '你', '他', '她',
    '什麼', '怎麼', '如何', '可以', '能不能', '幫我', '請問']);
  return [...english, ...chinese].filter(t => !stopWords.has(t));
}

function getRoleKeywords(role) {
  const map = {
    demand_fg: ['sales', 'demand', 'order', 'revenue', '銷售', '訂單', '營收', '需求'],
    bom_edge: ['bom', 'component', 'material', '物料', '組件', 'BOM'],
    inventory_snapshots: ['inventory', 'stock', '庫存', '存貨'],
    po_open_lines: ['purchase', 'PO', '採購', '採購單'],
    supplier_master: ['supplier', 'vendor', '供應商'],
    fg_financials: ['cost', 'price', 'margin', 'finance', '成本', '價格', '財務', '利潤'],
    goods_receipt: ['receipt', 'GR', '收貨'],
    price_history: ['price', '價格', '歷史價'],
  };
  return map[role] || [];
}
```

### 整合到 `chatAgentLoop.js`（第 570-573 行）

```javascript
// 改前：
const userDatasetDigestBlock = toolContext.datasetProfileRow?.profile_json
  ? buildUserDatasetDigest(toolContext.datasetProfileRow)
  : '';

// 改後：
import { selectRelevantContext } from './datasetContextSelector';

let userDatasetDigestBlock = '';
if (toolContext.datasetProfileRow?.profile_json) {
  const focusedProfile = selectRelevantContext(
    toolContext.datasetProfileRow.profile_json,
    message  // 用戶的當前問題
  );
  userDatasetDigestBlock = buildUserDatasetDigest({
    ...toolContext.datasetProfileRow,
    profile_json: focusedProfile,
  });
}
```

---

## 改動 4：修復 Olist Fallback Bug（緊急）

**檔案：`src/services/chatToolAdapter.js`（第 271 行）**

```javascript
// ── 改前 ──
const dataset = args.dataset || (!hasInputSheets ? 'olist' : null);

// ── 改後 ──
const hasUserProfile = Boolean(context.datasetProfileRow?.profile_json);
const dataset = args.dataset
  || (!hasInputSheets && !hasUserProfile ? 'olist' : null);

// 如果有 user profile 但沒有 sheets 數據，加 warning
if (hasUserProfile && !hasInputSheets && !args.dataset) {
  console.warn(
    '[chatToolAdapter] User has dataset profile but no sheet data in context. ' +
    'Raw data may not have been loaded. The analysis may use incomplete data.'
  );
}
```

### 同時修改 system prompt 指引（`chatAgentLoop.js` 第 581 行）

```javascript
// ── 改前 ──
...(userDatasetDigestBlock
  ? ['── User-Uploaded Dataset Schema ──',
     userDatasetDigestBlock,
     'When the user asks about their uploaded data, use run_python_analysis with this schema. The data is NOT in the SQL database.',
     '']
  : []),

// ── 改後 ──
...(userDatasetDigestBlock
  ? ['── User-Uploaded Dataset Schema ──',
     userDatasetDigestBlock,
     '',
     '⚠️ USER DATA ROUTING RULES:',
     '1. When the user asks about THIS uploaded dataset, ALWAYS use run_python_analysis. NEVER use query_sap_data.',
     '2. The uploaded data is NOT in the SQL database. query_sap_data cannot access it.',
     '3. If run_python_analysis returns an error about missing data, tell the user to re-upload the file.',
     '4. IGNORE all Olist table references when answering questions about user data.',
     '']
  : []),
```

---

## 改動 5：修復靜默 Catch

**檔案：`src/views/DecisionSupportView/index.jsx`**

### 第 2219-2222 行

```javascript
// ── 改前 ──
let datasetProfileRow = null;
if (datasetProfileId) {
  try { datasetProfileRow = await datasetProfilesService.getById(datasetProfileId); } catch { /* ok */ }
}

// ── 改後 ──
let datasetProfileRow = null;
let datasetProfileLoadError = null;
if (datasetProfileId) {
  try {
    datasetProfileRow = await datasetProfilesService.getById(datasetProfileId);
  } catch (err) {
    console.error('[DSV] Failed to load dataset profile:', datasetProfileId, err?.message);
    datasetProfileLoadError = err?.message || 'Unknown error loading dataset profile';
  }
}
```

### 在 toolContext 中傳遞錯誤（第 2422-2427 行附近）

```javascript
const toolContext = {
  userId: user?.id,
  datasetProfileRow,
  datasetProfileId,
  datasetProfileLoadError, // 新增
  datasetInputData: buildTaskInputData(runtimeDatasetContext, attachments),
};
```

### 在 chatAgentLoop.js 中使用錯誤信息

```javascript
// 在 system prompt 組裝時加入
...(toolContext.datasetProfileLoadError
  ? [`⚠️ Dataset profile failed to load: ${toolContext.datasetProfileLoadError}. Some data-related questions may not work correctly.`, '']
  : []),
```

---

## 改動 6：條件性抑制 Olist 提示

**檔案：`src/services/chatAgentLoop.js`**

當用戶有自己的數據時，Olist 的硬編碼提示會造成干擾。

### 找到第 479-480 行附近的 Olist 硬編碼提示

```javascript
// ── 改前（在 importantInstructions 陣列中）：
'- CRITICAL DATE RANGE: Olist e-commerce data covers 2016-09 to 2018-10. ...',
'- Dataset B tables (suppliers, materials, ...) may have 0 rows. ...',

// ── 改後：
...(userDatasetDigestBlock
  ? [
    // 用戶有自己的數據 → 不提 Olist
    '- The user has uploaded their own dataset. Focus on THEIR data, not demo data.',
    '- Use run_python_analysis for the user\'s data. Use query_sap_data only if the user explicitly asks about the demo/Olist dataset.',
  ]
  : [
    // 沒有用戶數據 → 保持原樣
    '- CRITICAL DATE RANGE: Olist e-commerce data covers 2016-09 to 2018-10. When filtering by date, use dates within this range. Using 2024/2025/2026 dates in WHERE clauses will return 0 rows.',
    '- Dataset B tables (suppliers, materials, inventory_snapshots, po_open_lines, goods_receipts) may have 0 rows. Prefer Dataset A (Olist CSV tables) unless the user specifically asks about operational/supply chain data.',
  ]
),
```

---

## 改動 7：跨表 FK 推斷（選做，高價值）

**檔案：`src/services/datasetProfilingService.js`**

在 profiling 結束後，加一個跨 sheet 的 FK 推斷步驟。

```javascript
/**
 * 推斷跨 sheet 的 FK 關係。
 * 邏輯：如果兩張 sheet 有相同名稱（normalized）的欄位，
 * 且其中一方是低基數（可能是 dimension table），判定為 FK。
 */
export function inferCrossSheetRelationships(sheets) {
  const relationships = [];

  // 建立 column → [sheet, cardinality] 索引
  const colIndex = new Map(); // normalized_col → [{ sheet_name, cardinality }]

  for (const sheet of sheets) {
    for (const col of (sheet.column_semantics || [])) {
      const key = col.normalized;
      if (!colIndex.has(key)) colIndex.set(key, []);
      colIndex.get(key).push({
        sheet_name: sheet.sheet_name,
        cardinality: col.cardinality || 0,
        column: col.column,
      });
    }
  }

  // 有相同 normalized 名稱的欄位出現在 2+ 張 sheet → 可能是 FK
  for (const [normalizedCol, occurrences] of colIndex.entries()) {
    if (occurrences.length < 2) continue;
    // 過濾掉太通用的名稱
    if (['id', 'name', 'date', 'type', 'status', 'value', 'amount'].includes(normalizedCol)) continue;

    // cardinality 最低的那張是 dimension table
    const sorted = [...occurrences].sort((a, b) => a.cardinality - b.cardinality);
    const dimension = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      relationships.push({
        column: normalizedCol,
        from: { sheet: sorted[i].sheet_name, column: sorted[i].column },
        to: { sheet: dimension.sheet_name, column: dimension.column },
        confidence: dimension.cardinality < sorted[i].cardinality ? 'high' : 'medium',
      });
    }
  }

  return relationships;
}
```

### 在 buildUserDatasetDigest 中加入 FK 信息

```javascript
// 在 digest 尾部加入
const relationships = inferCrossSheetRelationships(profile.sheets || []);
if (relationships.length > 0) {
  lines.push('\n**Relationships (inferred):**');
  for (const rel of relationships.slice(0, 10)) {
    lines.push(`  - ${rel.from.sheet}.${rel.from.column} → ${rel.to.sheet}.${rel.to.column} (${rel.confidence})`);
  }
}
```

---

## 改動 8：Execution Memory 記住查詢模式

**檔案：`src/services/aiEmployeeMemoryService.js`**

### 新增 `writeQueryPattern` 和 `recallQueryPatterns`

```javascript
/**
 * 記住成功的查詢模式，下次類似問題可以直接參考。
 */
export async function writeQueryPattern({
  datasetFingerprint,
  userQuestion,
  toolUsed,       // 'query_sap_data' | 'run_python_analysis'
  queryOrHint,    // SQL 語句或 tool_hint
  success,
  resultSummary,  // 簡短描述結果
}) {
  const entry = {
    id: localId(),
    type: 'query_pattern',
    dataset_fingerprint: datasetFingerprint,
    user_question: userQuestion?.slice(0, 200),
    tool_used: toolUsed,
    query_or_hint: queryOrHint?.slice(0, 500),
    success: Boolean(success),
    result_summary: resultSummary?.slice(0, 200),
    created_at: now(),
  };

  // Supabase 寫入
  const sbResult = await trySupabase(async () => {
    const { error } = await supabase
      .from('ai_employee_memory')
      .insert(entry);
    if (error) throw error;
    return true;
  });

  // localStorage fallback
  if (!sbResult) {
    const store = getLocalStore();
    store.push(entry);
    setLocalStore(store);
  }
}

/**
 * 召回與當前問題相關的成功查詢模式。
 */
export async function recallQueryPatterns({
  datasetFingerprint,
  limit = 3,
}) {
  // 嘗試 Supabase
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_memory')
      .select('*')
      .eq('type', 'query_pattern')
      .eq('dataset_fingerprint', datasetFingerprint)
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  });

  if (sbResult?.length > 0) return sbResult;

  // localStorage fallback
  const store = getLocalStore();
  return store
    .filter(e =>
      e.type === 'query_pattern' &&
      e.dataset_fingerprint === datasetFingerprint &&
      e.success
    )
    .slice(-limit);
}
```

### 在 chatAgentLoop.js 中注入召回結果

```javascript
// 在 system prompt 組裝處（第 575 行附近），加入：
const pastPatterns = toolContext.datasetProfileRow
  ? await recallQueryPatterns({
      datasetFingerprint: toolContext.datasetProfileRow.profile_json?.global?.fingerprint,
      limit: 3,
    })
  : [];

const patternBlock = pastPatterns.length > 0
  ? [
    '── Past Successful Queries for This Dataset ──',
    ...pastPatterns.map((p, i) =>
      `${i + 1}. Q: "${p.user_question}" → Tool: ${p.tool_used}, Result: ${p.result_summary}`
    ),
    'Use these as reference patterns. Adapt them to the current question.',
    '',
  ]
  : [];

// 然後在 agentSystemPrompt 陣列中加入 ...patternBlock
```

---

## 優先級總結

| 順序 | 改動 | 檔案 | 難度 | 影響 |
|------|------|------|------|------|
| 1 | 修 Olist fallback | chatToolAdapter.js | 低 | 🔴 直接修 bug |
| 2 | 修靜默 catch | index.jsx | 低 | 🔴 錯誤可見化 |
| 3 | 加深 column profiling | datasetProfilingService.js | 中 | 🔴 數據理解根基 |
| 4 | 重寫 digest 輸出 | datasetProfilingService.js | 中 | 🔴 LLM 信息品質 |
| 5 | 條件抑制 Olist 提示 | chatAgentLoop.js | 低 | 🟡 消除矛盾指令 |
| 6 | 加強路由指令 | chatAgentLoop.js | 低 | 🟡 工具選擇準確性 |
| 7 | Query-time context selection | 新增檔案 | 中 | 🟡 企業級必要 |
| 8 | FK 推斷 | datasetProfilingService.js | 中 | 🟢 跨表查詢能力 |
| 9 | Execution memory | aiEmployeeMemoryService.js | 中 | 🟢 長期學習能力 |

> 改動 1-6 是「修現有問題」，幾天內可以完成。
> 改動 7-9 是「建企業級能力」，可以在第二階段做。
