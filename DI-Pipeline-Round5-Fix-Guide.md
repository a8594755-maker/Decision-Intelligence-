# DI Pipeline 第五輪修正指南 — 雙層修正版

> **基於第四次實測 Trace + 真實資料人工比對結果**
> **範圍**: Layer A（Agent 產出品質）+ Layer B（QA 檢測精準度）

---

## 人工比對發現的真實品質問題

| # | 問題 | 性質 | 目前 QA 是否偵測到 |
|---|------|------|-------------------|
| 1 | 口徑混用 — title 說 "Delivered only" 但引用全量數據 R$13.59M/98,666 | Agent 邏輯錯誤 | ❌ 沒有 |
| 2 | 月份數自相矛盾 — 25/24/23 混用 | Agent 不一致 | ❌ 沒有 |
| 3 | 月均營收算錯 — R$13.59M ÷ 25 = R$543,666，但有數據月份是 24 個 | Agent 計算錯 | ❌ 沒有 |
| 4 | 浮點殘留 — `R$1,010,271.3700000371`、MoM% `1103687.798%` | 格式化不足 | ⚠️ Gemini 模糊提到 |

---

## 總覽

| # | 優先級 | 層 | 問題 | 涉及檔案 | 工時 |
|---|--------|----|------|----------|------|
| A1 | **P0** | Agent | 口徑一致性檢查缺失 | `chatAgentLoop.js` L546 附近 | 10 min |
| A2 | **P0** | Agent | 衍生數值不做自我校驗 | `chatAgentLoop.js` L546 附近 | 10 min |
| A3 | **P1** | Agent | 浮點數 + 極端百分比未清理 | `agentResponsePresentationService.js` normalizeBrief | 20 min |
| B1 | **P0** | QA | `detectMagnitudeMismatches` 把百分比欄位當貨幣 | `agentResponsePresentationService.js` L1252 | 10 min |
| B2 | **P0** | QA | `mergeQaResults` Math.min 太激進 | `agentResponsePresentationService.js` L2188 | 15 min |
| B3 | **P1** | QA | 新增口徑一致性檢測 | `agentResponsePresentationService.js` 新函式 | 25 min |
| B4 | **P1** | QA | 新增衍生數值校驗 | `agentResponsePresentationService.js` 新函式 | 20 min |
| B5 | **P1** | QA | repairBrief validation 過嚴 | `agentResponsePrompt.js` + `diModelRouterService.js` | 10 min |
| C1 | **P1** | Infra | Python fillna(method=) 棄用 | `chatAgentLoop.js` prompt | 5 min |
| C2 | **P2** | Infra | Memory table RLS policy | Supabase SQL | 5 min |

---

## Layer A：Agent 產出品質修正

### Fix A1 — 口徑一致性指令（P0）

**問題：** Agent SQL 用 `WHERE order_status = 'delivered'` 查出 23 個月、R$13.22M，
但引用 `generate_chart` 回傳的全量數據 25 個月、R$13.59M。
兩個數據源的 scope 不同，Agent 沒有察覺矛盾。

**涉及檔案：** `src/services/chatAgentLoop.js` — 第 546 行附近的 prompt 指令區

**修改方式 — 在第 550 行（TABLE DATA ACCURACY 那行）後面新增：**

```javascript
'- SCOPE CONSISTENCY (CRITICAL): When your SQL uses a WHERE filter (e.g., order_status = "delivered"), ALL numbers in the brief must come from the same filtered scope. Do NOT mix filtered SQL results with unfiltered chart/artifact totals. If the chart covers all orders but your SQL filters to delivered-only, you must EITHER: (a) re-query without the filter to match the chart scope, OR (b) explicitly state both scopes with separate numbers (e.g., "R$13.59M total across all orders; R$13.22M for delivered orders only"). Never claim "delivered orders only" while citing all-order totals.',
```

---

### Fix A2 — 衍生數值自我校驗指令（P0）

**問題：** Agent 產出月均 R$543,666 = R$13.59M ÷ 25，但 25 包含了缺失月份。
正確應該用有數據的 24 個月做分母，月均 = R$566,318。
同樣，Agent 在不同段落寫 25 個月、24 個月、23 個月而不自我察覺矛盾。

**涉及檔案：** `src/services/chatAgentLoop.js` — 同上位置

**修改方式 — 接在 A1 的新指令後面再加：**

```javascript
'- DERIVED VALUE AUDIT: Before outputting the final JSON, mentally verify every derived value (averages, percentages, growth rates). Check: (a) numerator and denominator are from the same scope and time range, (b) the denominator matches the count you cite elsewhere (e.g., if you say "24 actual months" then the monthly average must use 24 as divisor, not 25). (c) If you cite X months in one place and Y months in another, explicitly reconcile the discrepancy (e.g., "25 calendar months, 24 with data, 1 missing").',
'- EXTREME VALUE HANDLING: MoM growth from near-zero to large values produces extreme percentages (e.g., +1,103,687%). Either omit these from tables, replace with "N/A (startup period)", or add a footnote explaining the base is near zero. Never present extreme percentages without context.',
```

---

### Fix A3 — 浮點殘留 + 極端百分比清理（P1）

**問題：** Brief 裡出現 `R$1,010,271.3700000371`（浮點精度殘留）和
MoM% `1103687.7981651332`（無意義極端值），但 `normalizeBrief` 只對
`metric_pills` 做了 `formatPillValue`，沒有清理 table cells、key_findings、summary 中的數字。

**涉及檔案：** `src/services/agentResponsePresentationService.js`

**修改方式：**

**Step 1：新增一個通用的數字清理函式（在 `formatPillValue` 旁邊，約第 436 行後）**

```javascript
/**
 * Clean floating point residuals in any string.
 * "1010271.3700000371" → "1,010,271.37"
 * Also caps extreme percentages: "1103687.798%" → ">10,000%"
 */
function cleanFloatingPointInText(text) {
  if (typeof text !== 'string') return text;

  // Fix floating-point residuals: numbers with 5+ decimal places
  let cleaned = text.replace(/(\d+\.\d{2})\d{5,}/g, '$1');

  // Cap extreme percentages (> 10000% or < -10000%)
  cleaned = cleaned.replace(
    /([+-]?\d{5,}(?:\.\d+)?)\s*%/g,
    (match, num) => {
      const val = parseFloat(num);
      if (Math.abs(val) > 10000) return val > 0 ? '>10,000%' : '<-10,000%';
      return match;
    }
  );

  // Format large unformatted numbers in narrative (e.g., 1010271.37 → 1,010,271.37)
  cleaned = cleaned.replace(
    /(?<![.\d])(\d{4,})\.(\d{1,2})(?!\d)/g,
    (match, intPart, decPart) => {
      return Number(intPart).toLocaleString('en-US') + '.' + decPart;
    }
  );

  return cleaned;
}
```

**Step 2：在 `normalizeBrief` 中應用到所有文本欄位（修改第 783-828 行）**

```javascript
// 第 784 行 — headline
headline: normalizeSentence(cleanFloatingPointInText(source.headline || fallback.headline || 'Analysis complete.')),

// 第 785 行 — summary
summary: normalizeSentence(cleanFloatingPointInText(source.summary || fallback.summary || '')),

// 第 797 行 — table rows（在 formatValue 外面再包一層）
rows: table.rows.map((row) => Array.isArray(row)
  ? row.map((value) => typeof value === 'number'
    ? cleanFloatNumber(value)  // 新函式
    : cleanFloatingPointInText(formatValue(value)))
  : []),

// 第 824 行 — key_findings
key_findings: uniqueStrings(Array.isArray(source.key_findings)
  ? source.key_findings.map(cleanFloatingPointInText)
  : fallback.key_findings || []).slice(0, isAnalysis ? 10 : 5),

// 第 825 行 — implications
implications: uniqueStrings(Array.isArray(source.implications)
  ? source.implications.map(cleanFloatingPointInText)
  : fallback.implications || []).slice(0, isAnalysis ? 6 : 4),

// 第 826 行 — caveats
caveats: uniqueStrings(Array.isArray(source.caveats)
  ? source.caveats.map(cleanFloatingPointInText)
  : fallback.caveats || []).slice(0, isAnalysis ? 6 : 4),

// 第 828 行 — methodology_note
methodology_note: typeof source.methodology_note === 'string'
  ? cleanFloatingPointInText(source.methodology_note.trim())
  : (fallback.methodology_note || null),

// 第 829 行 — executive_summary
executive_summary: typeof source.executive_summary === 'string'
  ? cleanFloatingPointInText(source.executive_summary.trim())
  : (fallback.executive_summary || null),
```

**Step 3：新增 table cell 數字清理輔助函式**

```javascript
/** Round float to 2 decimal places; return integer if no fractional part */
function cleanFloatNumber(num) {
  if (!Number.isFinite(num)) return num;
  const rounded = Math.round(num * 100) / 100;
  return rounded % 1 === 0 ? rounded : rounded;
}
```

---

## Layer B：QA 檢測精準度修正

### Fix B1 — 排除百分比欄位（P0）

**Trace 證據：**
- Gemini blocker: `"Magnitude mismatch between SQL evidence and narrative (comparing absolute revenue to revenue_mom_pct)"`
- 根因：SQL 回傳 `revenue_mom_pct` 欄位，`/revenue/i` regex 匹配成貨幣欄位（第 1252, 1260 行）

**涉及檔案：** `src/services/agentResponsePresentationService.js` — 第 1252-1272 行

**修改方式 — 在第 1255 行（AVG_COL）後面新增：**

```javascript
// Line ~1256: Columns that are percentages/ratios — must never be compared against absolute values
const PCT_COL = /pct|percent|ratio|_rate$|growth|change|_mom|_yoy|_qoq|delta|diff|_chg/i;
```

**修改第 1259 行的迴圈（加入排除）：**

```javascript
for (const [col, valueSet] of sqlValues) {
  // Skip percentage/ratio columns — their values are % not absolute amounts
  if (PCT_COL.test(col)) continue;

  const isMonetary = MONETARY_COL.test(col);
  const isCount = COUNT_COL.test(col);
  if (!isMonetary && !isCount) continue;
  // ... rest unchanged
}
```

**驗證：** `revenue_mom_pct` 匹配 `/pct/i` + `/_mom/i` → 被跳過。

---

### Fix B2 — mergeQaResults 維度分數 cap（P0）

**Trace 證據：**
- Gemini self-review: `correctness=0`（因為 "543.67 vs 543,666" 假陽性）
- Merged 結果：`Correctness=1.0`（deterministic 可能給了較高分，但被 Math.min 拉到 Gemini 附近）

**涉及檔案：** `src/services/agentResponsePresentationService.js` — 第 2188-2194 行

**修改方式 — 替換第 2188-2194 行：**

```javascript
// LLM reviewers can disagree with deterministic QA by at most CAP_DELTA points per dimension.
// This prevents a single unreliable reviewer from zeroing out a dimension.
const CAP_DELTA = 3;

for (const key of QA_DIMENSION_KEYS) {
  const deterministicVal = deterministicQa?.dimension_scores?.[key];
  const reviewerVals = [
    selfReview?.qa?.dimension_scores?.[key],
    crossReview?.qa?.dimension_scores?.[key],
  ].filter((value) => typeof value === 'number');

  if (typeof deterministicVal === 'number') {
    // Floor: reviewer cannot push below deterministic - CAP_DELTA
    const floor = Math.max(0, deterministicVal - CAP_DELTA);
    const cappedVals = reviewerVals.map(v => Math.max(v, floor));
    dimensionScores[key] = roundScore(
      cappedVals.length > 0 ? Math.min(deterministicVal, ...cappedVals) : deterministicVal
    );
  } else if (reviewerVals.length > 0) {
    dimensionScores[key] = roundScore(Math.min(...reviewerVals));
  }
  // else: keep default 10
}
```

---

### Fix B3 — 新增：口徑一致性 deterministic 檢測（P1）

**目的：** 偵測 Agent 在 brief 中混用不同 scope 的數據（如全量 vs delivered-only）。

**涉及檔案：** `src/services/agentResponsePresentationService.js` — 在 `computeDeterministicQa` 中

**修改方式 — 在 magnitude mismatch 檢查之後（約第 1627 行）新增：**

```javascript
// ── Scope consistency: detect mixed data scopes ──
const scopeMismatch = detectScopeMismatch({ brief, toolCalls });
if (scopeMismatch) {
  const issue = `Scope inconsistency: ${scopeMismatch}`;
  issues.push(issue);
  repairInstructions.push('Ensure all numbers come from the same data scope. If mixing scopes, explicitly label each set of numbers.');
  dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 3);
  dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 2);
}
```

**新函式（放在 `detectMagnitudeMismatches` 附近）：**

```javascript
/**
 * Detect when the brief mixes numbers from different data scopes.
 * E.g., SQL filters to delivered-only but brief cites unfiltered chart totals.
 */
function detectScopeMismatch({ brief, toolCalls = [] }) {
  const sqlCalls = (Array.isArray(toolCalls) ? toolCalls : [])
    .filter(tc => tc?.name === 'query_sap_data' && tc?.result?.success);
  const chartCalls = (Array.isArray(toolCalls) ? toolCalls : [])
    .filter(tc => tc?.name === 'generate_chart' && tc?.result?.success);

  if (sqlCalls.length === 0 || chartCalls.length === 0) return null;

  // Check if SQL uses a scope filter that the chart doesn't
  const sqlFilters = sqlCalls.map(tc => {
    const sql = String(tc?.input?.sql || tc?.input?.query || '').toLowerCase();
    const scopeMatch = sql.match(/where\s+.*?(?:order_status|status)\s*=\s*'(\w+)'/i);
    return scopeMatch ? scopeMatch[1] : null;
  }).filter(Boolean);

  if (sqlFilters.length === 0) return null;

  // If SQL filters to a specific scope, check if brief claims that scope
  // but uses numbers that look like they're from the unfiltered set
  const briefText = [brief?.headline, brief?.summary, ...(brief?.key_findings || [])].filter(Boolean).join(' ');
  const claimsDeliveredOnly = /delivered.only|已交付|僅.*delivered/i.test(briefText);

  if (claimsDeliveredOnly && sqlFilters.includes('delivered')) {
    // Check if any metric pills cite generate_chart source (which is unfiltered)
    const pillsFromChart = (brief?.metric_pills || []).filter(p =>
      /generate_chart|chart/i.test(String(p?.source || ''))
    );
    if (pillsFromChart.length > 0) {
      return 'Brief claims "delivered orders only" but metric pills cite chart artifact data which includes all order statuses. Use consistent data scope.';
    }
  }

  return null;
}
```

---

### Fix B4 — 新增：衍生數值交叉校驗（P1）

**目的：** 偵測 Agent 在 brief 中的月份數、平均值等衍生數值是否自洽。

**涉及檔案：** `src/services/agentResponsePresentationService.js`

**修改方式 — 在 scope mismatch 檢查之後新增：**

```javascript
// ── Derived value consistency: check if averages match totals/counts ──
const derivedIssues = checkDerivedValueConsistency({ brief });
for (const issue of derivedIssues) {
  issues.push(issue);
  repairInstructions.push('Verify and correct the derived value calculation.');
  dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 2);
}
```

**新函式：**

```javascript
/**
 * Check internal consistency of derived values in the brief.
 * E.g., if brief says "24 months" and "average R$543K", verify 543K * 24 ≈ total.
 */
function checkDerivedValueConsistency({ brief }) {
  const issues = [];
  const pills = brief?.metric_pills || [];
  const text = [brief?.summary, ...(brief?.key_findings || [])].filter(Boolean).join(' ');

  // Extract total and average from pills
  const totalRevenuePill = pills.find(p => /total.*revenue|revenue.*total/i.test(p?.label));
  const avgRevenuePill = pills.find(p => /avg|average|mean/i.test(p?.label) && /revenue/i.test(p?.label));
  const monthsPill = pills.find(p => /month/i.test(p?.label) && !/missing/i.test(p?.label));

  if (totalRevenuePill && avgRevenuePill && monthsPill) {
    const total = parsePillNumber(totalRevenuePill.value);
    const avg = parsePillNumber(avgRevenuePill.value);
    const months = parsePillNumber(monthsPill.value);

    if (total > 0 && avg > 0 && months > 0) {
      const expectedAvg = total / months;
      const ratio = avg / expectedAvg;
      if (ratio < 0.9 || ratio > 1.1) {
        issues.push(
          `Monthly average (${avgRevenuePill.value}) does not match total (${totalRevenuePill.value}) ÷ months (${monthsPill.value}). Expected ≈${formatPillValue(String(Math.round(expectedAvg)))}.`
        );
      }
    }
  }

  // Check for contradictory month counts in text
  const monthCounts = [...text.matchAll(/(\d{1,2})\s*(?:months?|個月)/gi)].map(m => parseInt(m[1]));
  const uniqueMonthCounts = [...new Set(monthCounts)].filter(n => n >= 12 && n <= 36);
  if (uniqueMonthCounts.length > 2) {
    issues.push(
      `Multiple contradictory month counts found in narrative: ${uniqueMonthCounts.join(', ')}. Reconcile with explicit explanation.`
    );
  }

  return issues;
}

/** Parse a pill value string like "R$13.59M" or "543,666" into a number */
function parsePillNumber(str) {
  if (typeof str !== 'string') return 0;
  const cleaned = str.replace(/[R$€¥£,\s]/g, '');
  const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s*([KMBkmb])?/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return num;
}
```

---

### Fix B5 — repairBrief Validation 寬鬆化（P1）

**Trace 證據：**
```
[diModelRouter] Truncated JSON detected for prompt_12_agent_qa_repair_synthesis
(gemini/gemini-3.1-pro-preview, maxOutputTokens=4096). Retrying with 8192 tokens.
```

第一次 4096 tokens 截斷，retry 8192 成功。但如果 Gemini 只輸出 headline + summary，
`validateAgentBrief` 要求 `key_findings` 是 Array → 驗證失敗。

**涉及檔案：**
- `src/prompts/agentResponsePrompt.js` — 第 597 行後
- `src/services/diModelRouterService.js` — 第 215-216 行

**修改方式：**

```javascript
// agentResponsePrompt.js — 在 validateAgentBrief 後面新增
export function validateAgentBriefRepair(parsed) {
  return (
    isPlainObject(parsed)
    && typeof parsed.headline === 'string'
    && parsed.headline.trim().length > 0
    && typeof parsed.summary === 'string'
    && parsed.summary.trim().length > 0
  );
}
```

```javascript
// diModelRouterService.js 第 215-216 行
// 舊：return validateAgentBrief(parsed);
// 新：return validateAgentBriefRepair(parsed);
// 記得 import validateAgentBriefRepair
```

---

## Layer C：基礎設施修正

### Fix C1 — Python pandas 棄用 API 提示（P1）

**Trace 證據：**
```
run_python_analysis: failed
TypeError: NDFrame.fillna() got an unexpected keyword argument 'method'
```

**修改方式 — `chatAgentLoop.js` 第 552 行已有 pandas frequency 提示，確認以下也存在：**

```javascript
// 第 552 行（如果尚未加入）：
'- PANDAS FILLNA: Use df.ffill() instead of df.fillna(method="ffill"), and df.bfill() instead of df.fillna(method="bfill"). The method parameter was removed in pandas >= 2.2.',
```

> ✅ 根據程式碼，第 552 行已經有這個指令。但 trace 顯示 Agent 仍然用了 `fillna(method=...)`。
> 這說明 **Agent 沒有遵守 prompt 指令** — 可能是因為指令太多，被淹沒了。
>
> **增強方式：把 pandas 棄用提示移到更靠前的位置，或加 CRITICAL 標記：**

```javascript
'- CRITICAL PANDAS COMPAT: df.fillna(method="ffill") WILL FAIL. Use df.ffill() instead. df.fillna(method="bfill") WILL FAIL. Use df.bfill() instead. resample("M") WILL FAIL. Use resample("ME") instead.',
```

### Fix C2 — Memory Table RLS Policy（P2）

**Trace 證據：**
```
POST .../ai_employee_memory?on_conflict=project_id,pattern_key 403 (Forbidden)
new row violates row-level security policy
```

**修改方式：** Supabase SQL Editor：
```sql
CREATE POLICY "Users can manage own memory" ON public.ai_employee_memory
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

---

## 執行順序

```
Phase 1 (25 min) — 止血：修 QA 假陽性
├── B1: 排除 PCT 欄位 (10 min)
└── B2: mergeQaResults cap (15 min)
→ 重跑測試，確認分數回到 6.5+

Phase 2 (20 min) — Agent 品質提升
├── A1: 口徑一致性指令 (10 min)
└── A2: 衍生數值校驗指令 (10 min)
→ 重跑測試，確認口徑不再混用

Phase 3 (45 min) — QA 增強 + 格式化
├── A3: 浮點殘留清理 (20 min)
├── B3: 口徑一致性 deterministic 檢測 (15 min)
└── B4: 衍生數值交叉校驗 (10 min)
→ 重跑測試，確認新 QA 能偵測到之前漏掉的問題

Phase 4 (15 min) — 收尾
├── B5: repairBrief validation (10 min)
└── C1 + C2: pandas + RLS (5 min)
```

---

## 預估效果

### Phase 1 後（止血）

| 維度 | 現在 | 預估 | 原因 |
|------|------|------|------|
| correctness | 1.0 | **~7** | pct 欄位排除 + cap 機制 |
| caveats | 0.0 | **~5** | cap 機制保護 |
| **加權總分** | **5.1** | **~6.5+** | 不觸發 optimizer |

### Phase 2 後（Agent 品質）

| 問題 | 現在 | 預估 |
|------|------|------|
| 口徑混用 | all-orders 數據標成 delivered-only | Agent 會偵測到 scope 不一致並修正 |
| 月份數矛盾 | 25/24/23 亂用 | Agent 會明確區分 expected/actual/missing |
| 月均算錯 | R$543,666 (÷25) | R$566,318 (÷24) |
| 極端 MoM% | 1103687.798% 無說明 | ">10,000% (startup period)" 或 N/A |

### Phase 3 後（QA 增強）

| 品質問題 | QA 現在是否偵測 | Phase 3 後 |
|----------|----------------|-----------|
| 口徑混用 | ❌ | ✅ `detectScopeMismatch` |
| 月均算錯 | ❌ | ✅ `checkDerivedValueConsistency` |
| 浮點殘留 | ❌ | ✅ `cleanFloatingPointInText` 直接清理 |
| pct vs 金額比較 | 假陽性 | ✅ 正確排除 |
