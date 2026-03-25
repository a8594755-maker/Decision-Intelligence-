# DI Pipeline 第四輪修正指南

> **基於 2026-03-24 第二次實測 Trace**（Revenue & Sales Trend Analysis）
> **狀態**: A1-A7 架構升級已生效，以下為 trace 中發現的剩餘問題

---

## 總覽

| # | 優先級 | 問題 | 涉及檔案 | 預估工時 |
|---|--------|------|----------|----------|
| 1 | **P0** | Magnitude Mismatch 跨欄位誤判 | `agentResponsePresentationService.js` | 30 min |
| 2 | **P0** | Edge Function timeout 太短，repair 全失敗 | `diModelRouterService.js` | 5 min |
| 3 | **P1** | Gemini Optimizer streaming 空回應 + 不輸出 JSON | 設定調整 + `chatAgentLoop.js` | 20 min |
| 4 | **P1** | metric_pills 數字未格式化 | `chatAgentLoop.js` | 10 min |
| 5 | **P2** | ai_employee_memory 表不存在 | Supabase SQL | 15 min |

---

## Fix #1 — Magnitude Mismatch 跨欄位誤判（P0）

### 問題根因

`detectMagnitudeMismatches`（第 1189-1277 行）的比對邏輯：

1. 從 SQL 結果收集所有欄位的數值，按欄位名分類（monetary vs count）
2. 從 brief 文本提取數字，分為 money numbers（有 `$` 符號）和 plain numbers
3. 用 monetary 欄位 vs money numbers、count 欄位 vs plain numbers 做比對

**bug 在第 1246-1250 行的 fallback**：

```javascript
const relevantBriefNumbers = isMonetary && briefMoneyNumbers.length > 0
  ? briefMoneyNumbers
  : isCount && briefPlainNumbers.length > 0
    ? briefPlainNumbers.filter((n) => !briefMoneyNumbers.includes(n))
    : allBriefNumbers;  // ← 問題在這裡
```

在這次 trace 中：
- brief 裡的 revenue 數字（267.36, 1010271.37）**沒有 `$` 前綴**，所以歸入 `briefPlainNumbers`
- SQL 結果的 `avg_order_count` 欄位匹配 `COUNT_COL` regex
- `isCount = true`，進入第二分支：`briefPlainNumbers.filter((n) => !briefMoneyNumbers.includes(n))`
- 因為 `briefMoneyNumbers` 是空的（沒有 `$` 符號），filter 不排除任何數字
- 結果：revenue 數字 267.36 被拿去跟 `avg_order_count`（min=4111）比較 → **false positive**

### 涉及檔案

`src/services/agentResponsePresentationService.js` — 第 1189-1277 行

### 修改方式

**核心改動：加入上下文感知的欄位匹配，不再依賴 `$` 符號判斷幣種**

```javascript
// ── 替換第 1232-1276 行 ──

// 3. Categorize SQL columns into monetary vs count/quantity
const MONETARY_COL = /revenue|price|value|amount|cost|payment|freight|金額|營收|價格/i;
const COUNT_COL = /order_count|count|quantity|qty|items|num_|total_orders|total_items|筆數|數量/i;
// NEW: columns that are averages/aggregates — should only compare with similar scale
const AVG_COL = /^avg_|^mean_|average/i;

// 4. Build a "column → value range" index for smart matching
const columnRanges = new Map();
for (const [col, valueSet] of sqlValues) {
  const isMonetary = MONETARY_COL.test(col);
  const isCount = COUNT_COL.test(col);
  if (!isMonetary && !isCount) continue;
  const nums = [...valueSet];
  columnRanges.set(col, {
    isMonetary,
    isCount,
    isAvg: AVG_COL.test(col),
    max: Math.max(...nums),
    min: Math.min(...nums.filter(v => v > 0)),
    values: nums,
  });
}

// 5. For each brief number, find the BEST matching column by value proximity
// instead of comparing against ALL columns of a type
for (const briefNum of allBriefNumbers) {
  if (briefNum < 100) continue;

  // Check if this number exists exactly (within 1%) in any SQL column → not a mismatch
  let foundExactMatch = false;
  for (const [, range] of columnRanges) {
    if (range.values.some(v => Math.abs(v - briefNum) / Math.max(Math.abs(v), 1) < 0.01)) {
      foundExactMatch = true;
      break;
    }
  }
  if (foundExactMatch) continue;

  // Check if this number is within tolerance of ANY column's range
  // Only flag if it's wildly outside ALL plausible columns
  let closestCol = null;
  let closestRatio = Infinity;
  for (const [col, range] of columnRanges) {
    // Skip avg columns when brief number is clearly a raw total (> 10x the avg max)
    if (range.isAvg && briefNum > range.max * 10) continue;
    // Skip count columns for numbers that look like monetary values (have decimals)
    if (range.isCount && !range.isMonetary && briefNum % 1 !== 0 && briefNum > 1000) continue;

    const ratio = briefNum / range.max;
    if (Math.abs(Math.log10(ratio)) < Math.abs(Math.log10(closestRatio))) {
      closestRatio = ratio;
      closestCol = col;
    }
  }

  if (!closestCol) continue;
  const range = columnRanges.get(closestCol);

  // Tolerance: 3x for large values, 1.5x for small
  const upperTolerance = range.max < 1000 ? 1.5 : 3;
  const lowerTolerance = range.min < 1000 ? 0.67 : 0.33;
  const minThreshold = range.max < 1000 ? 10 : 100;

  if (briefNum > range.max * upperTolerance && range.max > minThreshold) {
    mismatches.push(
      `Narrative cites ${briefNum.toLocaleString()} but SQL column "${closestCol}" max is ${range.max.toLocaleString()} — possible ${Math.round(briefNum / range.max)}x inflation.`
    );
  }
  if (briefNum > 0 && briefNum < range.min * lowerTolerance && range.min > minThreshold) {
    mismatches.push(
      `Narrative cites ${briefNum.toLocaleString()} but SQL column "${closestCol}" min is ${range.min.toLocaleString()} — possible under-reporting.`
    );
  }
}

return mismatches;
```

### 為什麼有效

三個關鍵改變：

1. **Exact match bypass**：如果 brief 的數字在任何 SQL 欄位中找到精確匹配（1% 容差），直接跳過——不可能是 mismatch
2. **Count vs decimal 過濾**：count 欄位不跟帶小數點的大數比較（revenue 267.36 不會被比對 order count）
3. **Closest column matching**：不再把 brief 數字跟所有同類型欄位比較，而是找最接近的欄位——避免拿 revenue total 去比 avg_order_count

### 驗證方式

跑同樣的 "Revenue & Sales Trend Analysis"：
- Correctness 應從 0.0 恢復到 7-8
- 整體 QA score 應從 3.5 跳到 7+
- Optimizer 不應被觸發（score > 6.5 → no escalation）

---

## Fix #2 — Edge Function Timeout 提升（P0）

### 問題

`EDGE_FN_TIMEOUT_MS = 25000`（第 34 行），但 repair synthesis 需要：
1. Gemini 接收完整 brief + QA issues + tool evidence（大 payload）
2. 生成完整的修復後 JSON brief（4096-8192 tokens）
3. 兩次 JSON parse 嘗試

Trace 中 repair 的第一次 Gemini 呼叫花了 19.8 秒返回，但 JSON 被截斷（maxOutputTokens=4096 不夠），retry 用 8192 tokens 時全部超時。

```
gemini-3.1-pro-preview: timed out 25000ms
gemini-3.1-pro-preview: timed out 25000ms
gemini-2.5-flash: timed out 25000ms
gemini-2.5-flash-lite: contract validation failed
```

### 涉及檔案

`src/services/diModelRouterService.js` — 第 34 行

### 修改方式

```javascript
// ── 修改前（第 34 行）──
const EDGE_FN_TIMEOUT_MS = 25000;

// ── 修改後 ──
const EDGE_FN_TIMEOUT_MS = 55000;
```

### 同步修改：Supabase Edge Function timeout

Supabase Edge Function 本身也有 timeout 設定。在 `supabase/functions/ai-proxy/index.ts` 或 Supabase Dashboard 確認 Edge Function 的 execution timeout 至少 60 秒。如果是免費方案，默認 60s 應該足夠。

### 額外優化：降低 repair 的 maxOutputTokens

repair 不需要完整的 brief——它只需要修改有問題的欄位。在 `repairBrief` 函式中，把初始 maxOutputTokens 從 4096 降到 2048 可以減少截斷機率：

```javascript
// agentResponsePresentationService.js — repairBrief 函式內
maxOutputTokens: 2048,  // 改自 4096，repair 只需修改部分欄位
```

這樣 Gemini 更容易在 timeout 內完成，減少 retry escalation。

### 驗證方式

觸發一次 repair（暫時把 QA 閾值調高），確認 Gemini 在 25 秒內完成，不再出現 timeout cascade。

---

## Fix #3 — Challenger Model 調整（P1）

### 問題

Gemini 3.1 pro preview 作為 Optimizer 表現不佳：

1. **Streaming 返回 0 chars**：第一次 stream 連接 3.4 秒但內容為空
2. **Fallback 到 non-streaming**：拿到 tool call 但非 JSON 格式
3. **最終輸出 889 chars prose**：不遵守 JSON brief 格式
4. **只有 3 筆 chart data**：vs Primary 的 20 筆
5. **`<thought>` tag 洩漏到 UI**：Gemini 用了 `<thought>` 而非 `<thinking>`

### 修改方式

**方案 A — 換 Challenger Model（推薦）**

在設定頁把 Challenger 從 `Gemini / gemini-3.1-pro-preview` 改為：

| 選項 | 優缺點 |
|------|--------|
| **OpenAI / gpt-4o** | JSON 遵守度高、速度快、但跟 Primary 同 provider 缺乏多樣性 |
| **Anthropic / claude-sonnet-4** | 跨 provider 多樣性、JSON 遵守度好、分析深度強 |

推薦 **claude-sonnet-4**——跨 provider 的多樣性是 Optimizer 的核心價值。

**方案 B — 修復 Gemini 的 JSON 遵守度**

如果想繼續用 Gemini，需要在 `chatAgentLoop.js` 的 Optimizer 路徑加入更強的 JSON 格式指引：

```javascript
// 在 optimizer 的 system prompt 中加入：
'CRITICAL FORMAT REQUIREMENT: Your final answer MUST be a single valid JSON object matching the schema above. Do NOT output prose, markdown, or any text outside the JSON. Start your response with { and end with }. No exceptions.',
```

同時在 `stripThinkingTags` 中加入 `<thought>` tag 的處理（目前已支援——確認第 181 行 regex 包含 `thought`）。

### 驗證方式

切換 Challenger model 後，觸發一次 full optimizer（`forceOptimizer=true`），確認：
- Optimizer 輸出完整 JSON brief
- `[Presentation] Using direct JSON brief from agent` 出現（而非 synthesis fallback）
- Chart data 筆數 ≥ 15

---

## Fix #4 — Metric Pills 數字格式化（P1）

### 問題

Self-review 指出：

> Numbers are not formatted for business readability (e.g., 1010271.3700000371 instead of ~1.01M)

metric_pills 顯示原始浮點數，13 位小數，完全不適合商業呈現。

### 涉及檔案

`src/services/chatAgentLoop.js` — system prompt 的 metric_pills 規則

### 修改方式

在 system prompt 的 metric_pills 規則（約第 541 行附近）加入格式化指引：

```javascript
// ── 找到這行 ──
'- CRITICAL: metric_pills are NUMERIC KPIs only. Max 6 pills. Every pill value MUST be traceable to a tool call result.',

// ── 在其後加入 ──
'- FORMATTING: Format numbers for business readability. Use K/M/B suffixes for large numbers (e.g., "R$1.01M" not "1010271.37"). Round to at most 2 decimal places. Order counts should be integers (e.g., "7,451" not "7451.00"). Percentages should show 1 decimal (e.g., "+23.5%").',
```

### 同步修改：normalizeBrief 的 formatValue

如果 Agent 仍然輸出原始數字，可以在 `normalizeBrief`（第 756 行）的 metric_pills 處理中加入格式化：

```javascript
// 在 agentResponsePresentationService.js 的 normalizeBrief 函式中
// 找到 metric_pills 的 .map 處理（約第 766 行）
.map((item) => ({
  label: String(item.label),
  value: formatPillValue(item.value),  // ← 改用新的格式化函式
  ...(item.source ? { source: String(item.source) } : {}),
}))
```

新增 helper 函式：

```javascript
function formatPillValue(raw) {
  const str = String(raw || '').trim();
  const num = parseFloat(str.replace(/,/g, ''));
  if (!Number.isFinite(num)) return str;
  // Already formatted (has K/M/B suffix or % sign)
  if (/[KMB%]$/i.test(str)) return str;
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  if (abs >= 100) return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return str;
}
```

### 驗證方式

跑一次分析，確認 metric pills 顯示為 `R$1.01M`、`7,451`、`94.7K` 等格式，而非 `1010271.3700000371`。

---

## Fix #5 — 建立 ai_employee_memory 表（P2）

### 問題

Console 持續出現：

```
column ai_employee_memory.type does not exist
```

Memory service 用 `?type=eq.failure_pattern` 查詢，但表的欄位名是 `memory_type`（不是 `type`）。

### 修改方式

**兩處都需要改：**

**A. Supabase — 建表**（如果還沒建）

SQL 見之前的 `DI-Pipeline-Quality-Fix-Guide.md` Fix #4。

**B. aiEmployeeMemoryService.js — 修正欄位名**

```javascript
// 搜尋所有 ?type=eq.failure_pattern 或 .eq('type', ...)
// 改為 ?memory_type=eq.failure_pattern 或 .eq('memory_type', ...)
```

或者反過來——如果建表時欄位叫 `type`，就把 SQL 改成 `type` 而非 `memory_type`。核心是保持一致。

### 驗證方式

Console 不再出現 `column does not exist` 錯誤，且 Supabase 中能看到 failure pattern 記錄。

---

## 執行順序

```
Step 1 (30 min) → Fix #1: Magnitude Mismatch 誤判
                   這是最重要的——修完後 QA score 直接跳到 7+，
                   optimizer 不再被觸發，整個流程快 60 秒
Step 2 (5 min)  → Fix #2: Timeout 提升
Step 3 (10 min) → Fix #4: 數字格式化
Step 4 (20 min) → Fix #3: Challenger model 調整
Step 5 (15 min) → Fix #5: Memory 表
                   ─────────────
                   Total: ~80 min
```

**修完 Fix #1 之後立刻測試。** 如果 QA score 確實跳到 6.5 以上，那 Fix #2 和 Fix #3 的緊迫性會大幅降低（因為 repair 和 optimizer 根本不會被觸發），可以留到後面慢慢做。
