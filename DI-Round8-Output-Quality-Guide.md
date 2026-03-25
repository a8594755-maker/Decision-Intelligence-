# Decision Intelligence — Round 8 產出品質提升指南

> **核心思路**：前 7 輪修的都是 QA 管線的測量 bug，讓分數「不誤判」。
> 本輪的目標是讓產出「真正變好」— 讓 LLM 第一次就產出高品質 brief，而不是靠 repair 事後修補。
> **原則：不動檔案，只提供修改建議。**

---

## 一、問題根源分析

目前 pipeline 流程：

```
用戶問題 → Answer Contract → Primary Agent (GPT-5.4) 生成 raw narrative
    → Tool Calls (SQL/Python/Chart) 產出 evidence
    → Brief Synthesis (LLM) 將 narrative + evidence 合成 JSON brief
    → Deterministic QA 檢查 brief
    → LLM QA Review 評分
    → Repair (如果 score < 5.0)
    → Final Output
```

目前品質問題出在 **Brief Synthesis** 這一步：

| 問題 | 根因 | 影響的 QA 維度 (權重) |
|------|------|----------------------|
| 敘述數字與 SQL 值不一致 (magnitude mismatch) | Synthesis LLM 拿到的是 raw sample rows，自己做心算彙總，算錯 | correctness (0.28) + evidence_alignment (0.13) |
| 百分比 / 乘數混淆 (CAGR 1118% vs 11.18) | Tool result 只傳 raw number，沒標單位，LLM 自行推測 | correctness (0.28) |
| 缺少 proxy/limitation caveat | Prompt 有寫要加 caveat，但規則埋在 30+ 條 rules 裡，LLM 常忽略 | caveat_quality (0.12) |
| Pill 值在 summary 和 findings 重複出現 | Prompt 規則太多，dedup 規則優先級不夠高 | information_density (0.10) |
| Repair 是唯一的品質安全網，但 timeout 了 | DeepSeek repair prompt 太大 | 所有維度 (repair 失敗 = 無法修補) |

**核心洞察**：如果 Synthesis 第一次就做對，repair 就不需要觸發，timeout 也不是問題。

---

## 二、改善方案（依優先級排列）

### 改善 1（P0）：在 tool result 中標註數值的語義單位

**問題**：`summarizeToolCallsForPrompt` (line 2622) 把 SQL 的 sample rows 直接 JSON 序列化傳給 synthesis prompt，像這樣：
```json
{ "cagr": 11.180156730638245, "avg_revenue": 5202955.049999449 }
```

LLM 看到 `11.18` 不知道它是乘數還是百分比，看到 `5202955.049` 不知道這是巴西幣還是美金、是年營收還是月營收。

**檔案**：`src/services/agent-core/agentResponsePresentationService.js`

**修法**：在 `summarizeToolCallsForPrompt` 中（line 2654-2664），對 `sampleRows` 增加 column metadata：

```javascript
// ── 在 return 物件中，新增 columnMeta 欄位 ──
return {
  id: toolCall?.id || null,
  name: toolCall?.name || 'unknown_tool',
  success: Boolean(toolCall?.result?.success),
  error: toolCall?.result?.success ? null : String(toolCall?.result?.error || ''),
  args: toolCall?.args || {},
  rowCount: getRowCount(toolCall),
  sampleRows: rows.map(formatTimestampValues),
  columnMeta: inferColumnMeta(rows, toolCall),   // ← 新增
  analysisPayloads,
  artifactTypes: toolCall?.result?.artifactTypes || toolCall?.result?.result?.artifactTypes || [],
};
```

新增 `inferColumnMeta` 函數（建議放在 `formatTimestampValues` 附近）：

```javascript
/**
 * Infer semantic metadata for each column in SQL results.
 * Helps the synthesis LLM interpret raw numbers correctly.
 */
function inferColumnMeta(rows, toolCall) {
  if (!Array.isArray(rows) || rows.length === 0) return {};
  const meta = {};
  const sqlText = String(toolCall?.args?.sql || toolCall?.args?.query || '').toLowerCase();
  const firstRow = rows[0];

  for (const [col, val] of Object.entries(firstRow || {})) {
    if (typeof val !== 'number') continue;
    const colLower = col.toLowerCase();
    const entry = {};

    // Detect unit type from column name
    if (/revenue|price|value|amount|cost|payment|freight|金額|營收|價格/.test(colLower)) {
      entry.unit = 'currency';
      entry.likely_currency = /brl|brazil|reais|r\$/.test(sqlText) ? 'BRL' : 'USD';
    } else if (/count|qty|quantity|orders|items|筆數|數量/.test(colLower)) {
      entry.unit = 'count';
    } else if (/pct|percent|ratio|rate|growth|cagr|change/.test(colLower)) {
      // Critical: distinguish ratio (0.xx) from percentage (xx%)
      if (Math.abs(val) < 50) {
        entry.unit = 'ratio_multiplier';
        entry.display_hint = 'multiply by 100 to get percentage, or keep as Nx multiplier';
      } else {
        entry.unit = 'percentage';
      }
    } else if (/avg_|mean_|average|平均/.test(colLower)) {
      entry.unit = 'average';
      entry.aggregation = 'mean';
    }

    // Detect aggregation scope from SQL
    if (/group\s+by\s+.*year|按.*年/.test(sqlText)) {
      entry.scope = 'per_year';
    } else if (/group\s+by\s+.*month|按.*月/.test(sqlText)) {
      entry.scope = 'per_month';
    }

    // Flag floating-point precision issues
    if (typeof val === 'number' && String(val).includes('.') && String(val).split('.')[1]?.length > 4) {
      entry.precision_note = 'raw floating-point; round to 2 decimals for display';
    }

    if (Object.keys(entry).length > 0) {
      meta[col] = entry;
    }
  }
  return meta;
}
```

**預期效果**：Synthesis prompt 收到的 evidence 變成：
```json
{
  "sampleRows": [{ "cagr": 11.18, "avg_revenue": 5202955.05 }],
  "columnMeta": {
    "cagr": { "unit": "ratio_multiplier", "display_hint": "multiply by 100 to get percentage" },
    "avg_revenue": { "unit": "currency", "likely_currency": "BRL", "scope": "per_year", "precision_note": "round to 2 decimals" }
  }
}
```

LLM 看到 `ratio_multiplier` 就知道 11.18 是「11.18 倍」而不是「11.18%」，magnitude mismatch 和 CAGR 問題同時解決。

---

### 改善 2（P0）：在 Synthesis Prompt 中加入「數值忠實度」硬規則

**問題**：目前 `buildAgentBriefSynthesisPrompt` (line 214-316) 有 30+ 條 rules，每條都是平等的。LLM 在 context 長的情況下容易忽略中間的規則。

**檔案**：`src/prompts/agentResponsePrompt.js`

**修法**：在 prompt 的 `## Rules` 區段最前面（line 273 之後），插入一個高優先級的 `## CRITICAL RULES (must follow)` 區段：

```javascript
// ── 在 line 273 "## Rules" 之前插入 ──

## ⚠ CRITICAL RULES — violation of any of these is a hard failure

1. NUMERIC FIDELITY: Every number in metric_pills, tables, summary, and key_findings
   MUST be directly traceable to a value in the tool evidence. You may NOT:
   - Round a value differently than the source (e.g., 5,202,955 → "5.2M" is OK; → "5M" is NOT)
   - Perform mental arithmetic on source values (e.g., summing rows, computing averages)
   - Convert units without explicit column metadata (e.g., ratio → percentage)
   If you need a derived value (sum, average, growth rate), it MUST already exist in the
   tool evidence or analysis payload. If it doesn't exist, state "data not available" rather
   than computing it yourself.

2. UNIT FIDELITY: When columnMeta provides a "unit" field, obey it:
   - "ratio_multiplier" → display as "Nx" (e.g., 11.18x) or convert to % explicitly (1,118%)
   - "currency" + "likely_currency" → use the indicated currency symbol
   - "percentage" → display with % sign, do not divide by 100
   - "count" → display as integer, no decimal places

3. MANDATORY CAVEATS: You MUST include at least one caveat if ANY of the following is true:
   - Any tool call has success=false
   - You are using a SQL moving average or proxy instead of exact statistical decomposition
   - The data covers less than 12 months or fewer than 100 rows
   Do NOT produce an empty caveats array when these conditions apply.

## Rules
```

**為什麼有效**：LLM 對 prompt 開頭和結尾的注意力最高。把最關鍵的 3 條規則放在所有其他 rules 之前，用「violation = hard failure」的語氣強調，可以大幅提升遵守率。

---

### 改善 3（P1）：讓 Synthesis 直接引用 analysis payload 的 metrics 而非 raw rows

**問題**：目前 `summarizeToolCallsForPrompt` 把 analysis payload 的 `metrics` 欄位傳進去了（line 2637-2638），但 synthesis prompt 沒有特別指示 LLM 優先使用 `metrics` 而非 `sampleRows`。

結果 LLM 常常忽略 analysis payload 裡已經計算好的 metrics（如 `{ "cagr": 11.18, "median_revenue": 821 }`），反而從 sampleRows 自己心算，算出錯誤的值。

**檔案**：`src/prompts/agentResponsePrompt.js`

**修法**：在 `buildAgentBriefSynthesisPrompt` 的 rules 中加入：

```
- EVIDENCE PRIORITY: When a tool call has both sampleRows and analysisPayloads.metrics,
  ALWAYS prefer the metrics values. These are pre-computed by Python/SQL and are
  authoritative. sampleRows are just a preview of raw data — do NOT aggregate them yourself.
  Example: if metrics says {"avg_revenue": 52030}, use 52,030 — do NOT sum the sampleRows
  and divide by row count to get your own average.
```

---

### 改善 4（P1）：Pre-synthesis 數值清洗 — 在傳給 LLM 之前就處理浮點殘留

**問題**：SQL 回傳 `5202955.049999449`，synthesis LLM 把這個 raw number 直接放進 brief。然後 `normalizeBrief` 在 post-processing 才清掉浮點尾巴。但 deterministic QA 是在 normalizeBrief 之前跑的？

讓我確認一下...

實際上看 code，`synthesizeBrief` (line 2595) 確實在 return 前就 call `normalizeBrief`：
```javascript
const brief = normalizeBrief(result?.parsed, fallbackBrief, { brevity: ... });
```

所以 deterministic QA 拿到的 brief 應該已經被清洗過了。但問題是 **magnitude mismatch 檢測比較的是 brief 數字 vs SQL 數字**。如果 normalizeBrief 把 `5202955.05` 格式化為 `5.20M`，然後 deterministic QA 的 `detectMagnitudeMismatches` 從 brief 的 `5.20M` 解析出... 等一下，magnitude mismatch 是從 brief narrative 文字中 extract 數字，不是從 metric_pills。

真正的問題是：LLM 在 synthesis 時看到 `5202955.049999449` 這個 ugly number，可能會做不精確的 rounding（如寫成 "約 520 萬" 而 SQL max 是 5,202,955），導致 magnitude mismatch。

**修法**：在 `summarizeToolCallsForPrompt` 的 `sampleRows` 處理中，先清掉浮點殘留：

```javascript
// 在 line 2661，修改 sampleRows 的處理：
sampleRows: rows.map(formatTimestampValues).map(cleanFloatsInRow),
```

新增：
```javascript
function cleanFloatsInRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'number' && !Number.isInteger(val)) {
      // Round to 2 decimal places to avoid floating-point display artifacts
      out[key] = Math.round(val * 100) / 100;
    } else {
      out[key] = val;
    }
  }
  return out;
}
```

**預期效果**：LLM 看到 `5202955.05` 而非 `5202955.049999449`，產出的文字更乾淨，magnitude mismatch 也更少。

---

### 改善 5（P1）：Answer Contract 自動加入 caveat 要求

**問題**：`buildAgentAnswerContractPrompt` (line 169-211) 的 `analysis_depth` 欄位會為 `recommendation / diagnostic` 自動包含 `methodology_disclosure`，但沒有為 **trend** 類型自動要求 caveat（例如數據範圍限制、proxy metric 使用）。

測試題「分析巴西賣家過去三年的年營收趨勢」屬於 `trend` 類型，但 `analysis_depth` 只加了 `relative_metrics` 和 `trend_context`，沒有 `methodology_disclosure`。

**檔案**：`src/prompts/agentResponsePrompt.js`

**修法**：在 line 207-210 的 `analysis_depth` auto-select 規則中，擴大 `methodology_disclosure` 的觸發條件：

```javascript
// ── 修改前（line 207-210）──
- analysis_depth: auto-select:
  - recommendation or diagnostic → always include "methodology_disclosure", "actionable_parameters", "sensitivity_range".
  - comparison or trend → always include "relative_metrics", "trend_context".
  - brevity "analysis" → always include "relative_metrics".
  - lookup or ranking with brevity "short" → empty array.

// ── 修改後 ──
- analysis_depth: auto-select:
  - recommendation or diagnostic → always include "methodology_disclosure", "actionable_parameters", "sensitivity_range".
  - comparison or trend → always include "relative_metrics", "trend_context", "methodology_disclosure".
  - mixed → always include "methodology_disclosure", "relative_metrics".
  - brevity "analysis" → always include "relative_metrics", "methodology_disclosure".
  - lookup or ranking with brevity "short" → empty array.
```

**預期效果**：trend 類型的回答也會被 synthesis prompt 要求披露方法論限制，自然產生 proxy caveat。

---

### 改善 6（P2）：Synthesis Prompt 的 rules 精簡與重構

**問題**：目前 `buildAgentBriefSynthesisPrompt` 有 **40+ 條 rules**（line 273-316），總長度約 4000 chars。研究表明 LLM 對超過 20 條的 instruction list 遵守率會急劇下降，尤其是中間的規則。

**修法方向**（不需要改 code，純 prompt engineering）：

1. **合併同類規則**：目前 METRIC PILLS QUALITY、METRIC PILL LIMITS、FIELD DEDUPLICATION 是三條分開的規則，可以合成一條：
   ```
   METRIC PILLS: Max 4 pills (short) or 6 pills (analysis). Each pill must be numeric KPI.
   No time periods, trend labels, or metadata as pills. Pill values must NOT be restated
   verbatim in summary or key_findings — reference contextually instead.
   ```

2. **分層：MUST vs SHOULD**：把 rules 分成 `## MUST` (10 條以內) 和 `## SHOULD` (其餘)。這樣 LLM 至少會遵守 MUST 裡的。

3. **移除已不再觸發的規則**：例如 line 295-297 的「0-row SQL lookup」規則和 line 298-299 的「existing chart artifacts」規則，在正常流程中很少觸發，可以移到 repair prompt 裡，不需要在 synthesis 時佔 attention。

---

## 三、預期效果與分數提升估算

| 改善 | 影響維度 | 預期分數提升 | 改動範圍 |
|------|---------|-------------|---------|
| 1. Column metadata | correctness, evidence_alignment | +0.8~1.2 | `agentResponsePresentationService.js` |
| 2. CRITICAL RULES | correctness, caveat_quality | +0.5~0.8 | `agentResponsePrompt.js` |
| 3. Evidence priority | correctness, evidence_alignment | +0.3~0.5 | `agentResponsePrompt.js` |
| 4. Float cleaning | correctness | +0.2~0.3 | `agentResponsePresentationService.js` |
| 5. Contract caveat | caveat_quality | +0.2~0.4 | `agentResponsePrompt.js` |
| 6. Prompt 精簡 | information_density, clarity | +0.2~0.3 | `agentResponsePrompt.js` |

**保守估算**：改善 1-3 就能把分數從 6.5 推到 **7.5-8.0**。

**原因**：magnitude mismatch 觸發 correctness -5 和 evidence_alignment -4（合計扣掉加權 0.28×5 + 0.13×4 = 1.92 的 raw score）。如果 synthesis 第一次就用正確的數字，這 1.92 分直接加回來，加上 caveat 改善，整體就超過 7.0。

---

## 四、實作順序建議

```
第一批（快速見效）：
  改善 2 → 加 CRITICAL RULES（純文字修改，5 分鐘）
  改善 3 → 加 evidence priority rule（純文字修改，2 分鐘）
  改善 5 → 擴大 methodology_disclosure（改一行 prompt，2 分鐘）

第二批（核心改進）：
  改善 1 → inferColumnMeta 函數（新增 ~50 行 code）
  改善 4 → cleanFloatsInRow（新增 ~15 行 code）

第三批（長期優化）：
  改善 6 → prompt 重構（不改 code，重寫 prompt 文字）
```

第一批只改 prompt 文字，不動任何邏輯，風險最低、見效最快。

---

## 五、測試驗證

同樣用標準測試題：

> **問題**：「分析巴西賣家過去三年的年營收趨勢，包括 CAGR 計算、營收分佈（中位數與四分位距），以及影響營收波動的主要風險因子。請用繁體中文回答。」

**新增驗證項目**（除了之前的 checklist）：

- [ ] Brief 中的數字與 SQL evidence 完全一致（zero magnitude mismatch）
- [ ] CAGR 顯示為 "11.18x" 或 "1,118%" 且有 evidence 支撐
- [ ] metric_pills 的值沒有在 summary 和 key_findings 中逐字重複
- [ ] caveats 非空，包含方法論或數據範圍說明
- [ ] summary 是分析解讀，不是數字複述
- [ ] Overall score ≥ 7.5
- [ ] Repair 不被觸發（score ≥ 5.0 且無 blockers）
