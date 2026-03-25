# Decision Intelligence — Round 8 Agent Prompt Enhancement Guide

> **前置狀態**：Fix Guide (Fix 4A/4B/5) + Output Quality Guide (Improvement 1-5) 已全部實作，但 synthesis prompt 改進完全被跳過（Direct JSON Brief bypass）。
> **根本發現**：在 `mode === 'analysis'` 下，GPT-5.4 直接輸出 JSON brief，系統跳過 `synthesizeBrief`，所有加在 synthesis prompt 的品質規則（CRITICAL RULES、UNIT FIDELITY、EVIDENCE PRIORITY、MANDATORY CAVEATS）完全無效。
> **唯一有效位置**：`chatAgentLoop.js` 的 agent system prompt（lines 481-571）
> **日期**：2026-03-24

---

## 問題診斷

### 為什麼現有規則沒用？

Agent system prompt 已有以下規則，但 GPT-5.4 仍然違反：

| 規則 | 位置 | 為什麼失效 |
|------|------|-----------|
| NUMBER FIDELITY (line 525) | 有 | 規則太泛，沒有具體 example |
| CAGR Interpretation (lines 527-531) | 有 | 只說「value > 1.0 is a multiplier」但沒有 step-by-step 計算示範 |
| UNIT CONSISTENCY (line 531) | 有 | 沒有 explicit penalty/consequence |
| MANDATORY CAVEATS | **缺少** | agent prompt 只有 LOW-BASE CAVEAT，沒有 proxy/limitation caveat |
| EVIDENCE PRIORITY | **缺少** | agent 不知道該優先用 `analysisPayloads.metrics` |
| PILL-SUMMARY DEDUP | **缺少** | agent 把 pill values 原樣寫進 summary，QA 扣分 |
| columnMeta awareness | **缺少** | `inferColumnMeta` 產出的單位註釋只在 synthesis prompt 裡，agent 看不到 |

### 測試失敗的具體原因（score 4.9）

1. **Correctness = 0**：CAGR 值 `11.18` 被寫成 `1118.0%`，magnitude mismatch
2. **Caveat quality = 0**：缺少 proxy caveat（用 Olist 代理巴西全體賣家）
3. **Pill verbatim restatement**：summary 重複 pill 數值，information density 扣分
4. **Missing methodology note**：沒解釋 CAGR 計算方法

---

## 修改方案

### 修改 1：注入 columnMeta 到 tool result guidance（最關鍵）

**檔案**：`chatAgentLoop.js`
**位置**：line ~1166-1191（Pre-analysis data validation 區塊之後）

目前 `inferColumnMeta` 只在 `agentResponsePresentationService.js` 的 `summarizeToolCallsForPrompt` 裡使用（synthesis prompt 用的），agent 完全看不到。需要在 tool result 回傳後，透過 `deferredGuidance` 注入 columnMeta。

```javascript
// ── 在 line 1191 的 catch 之後，加入以下區塊 ──

// ── Column metadata injection: tell agent about unit types ──
if (toolName === 'query_sap_data' && toolResult.success && toolResult.result?.rows?.length > 0) {
  try {
    const { inferColumnMeta } = await import('../agent-core/agentResponsePresentationService.js');
    const colMeta = inferColumnMeta(toolResult.result.rows, { name: toolName, args: toolArgs });
    const metaEntries = Object.entries(colMeta);
    if (metaEntries.length > 0) {
      const metaLines = metaEntries.map(([col, meta]) => {
        const parts = [`${col}: type=${meta.unitType}`];
        if (meta.aggregationScope) parts.push(`scope=${meta.aggregationScope}`);
        if (meta.hasPrecisionIssue) parts.push('⚠️ has floating-point residuals');
        if (meta.unitType === 'ratio_multiplier') {
          parts.push('⚠️ MULTIPLY BY 100 to get percentage');
        }
        return `  - ${parts.join(', ')}`;
      });
      deferredGuidance.push({
        role: 'user',
        content: `📊 COLUMN METADATA for previous query:\n${metaLines.join('\n')}\nUse these unit types when interpreting values. ratio_multiplier columns must be ×100 before displaying as percentages.`,
      });
    }
  } catch { /* non-critical */ }
}
```

**注意**：`inferColumnMeta` 目前沒有被 export。需要在 `agentResponsePresentationService.js` 加上 export：

找到 `function inferColumnMeta(rows, toolCall)` 宣告處（line ~190），改為：
```javascript
// 修改前
function inferColumnMeta(rows, toolCall) {

// 修改後
export function inferColumnMeta(rows, toolCall) {
```

---

### 修改 2：強化 CAGR 規則 — 加入 step-by-step 計算示範

**檔案**：`chatAgentLoop.js`
**位置**：lines 527-531（Growth Rate / CAGR Interpretation Rules）

```javascript
// ── 修改前（lines 527-531）──
'Growth Rate / CAGR Interpretation Rules:',
'- SQL expressions like POWER(end/start, 1/periods) - 1 return a MULTIPLIER, not a percentage. A value of 13.22 means 1322% annual growth, NOT 13.22%.',
'- When a SQL column name contains "cagr", "growth", or "rate" and the value > 1.0, it is almost certainly a multiplier. Multiply by 100 to get the percentage representation.',
'- LOW-BASE CAVEAT: If the starting value (denominator) is very small relative to the ending value (>50x growth), add a caveat: "CAGR is inflated due to low base period; use absolute growth for decision-making."',
'- UNIT CONSISTENCY: The same metric MUST use the same unit everywhere in your JSON. If a metric_pill says "1118%", the narrative and key_findings must also say "1118%" or "11.18x" — never the raw SQL value "11.18" without a unit.',

// ── 修改後 ──
'Growth Rate / CAGR Interpretation Rules (CRITICAL — violations cause score = 0):',
'- SQL expressions like POWER(end/start, 1/periods) - 1 return a MULTIPLIER, not a percentage.',
'- STEP-BY-STEP EXAMPLE:',
'  SQL returns cagr_value = 11.18',
'  → This is a MULTIPLIER (11.18×)',
'  → Percentage = 11.18 × 100 = 1118%',
'  → pill value: "1,118%" or "+1,118%"',
'  → narrative: "CAGR 為 1,118%（即 11.18 倍）"',
'  ✗ WRONG: pill = "11.18%", narrative = "年增長率 11.18%"',
'- DETECTION RULE: If a column named *cagr*, *growth*, or *rate* has value > 1.0, it is a multiplier. Apply ×100.',
'- DETECTION RULE: If POWER(...) - 1 returns a value > 1.0, the result is already a multiplier. Apply ×100.',
'- If value < 1.0 (e.g., 0.23), it may already be a decimal rate. 0.23 → 23%. Do NOT multiply again.',
'- LOW-BASE CAVEAT (MANDATORY): If start value is <5% of end value (>20× growth), you MUST add: "CAGR is inflated due to extremely low base period (start = [value]); absolute growth figures are more meaningful for decision-making."',
'- UNIT CONSISTENCY: The same metric MUST use the same unit everywhere in your JSON — pills, summary, key_findings, tables. Mismatch = hard failure.',
```

---

### 修改 3：新增 MANDATORY CAVEATS 規則

**檔案**：`chatAgentLoop.js`
**位置**：在 line 531（UNIT CONSISTENCY）之後，line 532（空行）之前插入

```javascript
// ── 在 Growth Rate 區塊後、Final Answer Rules 前插入 ──
'',
'Mandatory Caveats Rules (CRITICAL — missing caveats cause caveat_quality = 0):',
'- PROXY DATA CAVEAT: If the user asks about a broad category (e.g., "巴西賣家", "全球市場") but the data only covers a subset (e.g., Olist platform data), you MUST add a caveat: "本分析基於 [data source] 平台數據，為 [broad category] 的代理指標（proxy），不代表整體市場。趨勢應作方向性參考而非精確數值。"',
'- SAMPLE SIZE CAVEAT: If any aggregation has fewer than 30 data points, caveat the statistical reliability.',
'- TEMPORAL COVERAGE CAVEAT: If the data covers fewer periods than the user asked for, state the actual coverage and caveat that the trend may not be representative.',
'- METHODOLOGY CAVEAT: When computing derived metrics (CAGR, moving averages, percentiles), briefly state the formula or method in methodology_note.',
'- Place ALL caveats in the "caveats" array of your JSON. Do NOT bury caveats in narrative text only.',
```

---

### 修改 4：新增 PILL-SUMMARY DEDUP 規則

**檔案**：`chatAgentLoop.js`
**位置**：在 line 552（metric_pills 規則）之後插入

```javascript
// ── 在 metric_pills 規則後插入 ──
'- PILL-SUMMARY DEDUP: The "summary" narrative must NOT simply restate pill values. Pills are already displayed as cards above the narrative. Instead, the summary should provide CONTEXT and INTERPRETATION: why the number matters, what drove it, how it compares to benchmarks. Example:',
'  ✗ BAD: "營收 CAGR 為 1,118%，訂單中位數為 R$120。" (just restating pills)',
'  ✓ GOOD: "營收在三年間呈爆發式增長（主因為 2017 年平台快速擴張），但極高的 CAGR 主要受低基期影響，2018 年增速已明顯放緩至 45%。" (interpretation + context)',
```

---

### 修改 5：新增 EVIDENCE PRIORITY 規則

**檔案**：`chatAgentLoop.js`
**位置**：在 Data Provenance Rules 區塊（line 521-524）之後插入

```javascript
// ── 在 Data Provenance Rules 後插入 ──
'- EVIDENCE PRIORITY: When a tool result contains both `analysisPayloads.metrics` (pre-computed KPIs) and raw `sampleRows`, prefer metrics values. They are pre-validated. Only fall back to sampleRows when the needed metric is not in analysisPayloads.',
'- CROSS-CHECK: If you compute a value from raw rows that differs >5% from the same metric in analysisPayloads, flag the discrepancy and use the analysisPayloads value.',
```

---

### 修改 6：強化 Final Answer 的品質門檻

**檔案**：`chatAgentLoop.js`
**位置**：在 line 565（Focus on concise interpretation）之後、line 566（空行）之前插入

```javascript
// ── 在 Final Answer Rules 末尾插入 ──
'- SELF-AUDIT BEFORE OUTPUT: Before writing the final JSON, verify these 5 checks:',
'  1. Every pill value matches a tool result number (exact or correctly converted)',
'  2. Summary does not merely restate pill values — it adds interpretation',
'  3. caveats[] has at least 1 entry if data is proxy/sampled/limited-period',
'  4. methodology_note explains how derived metrics were computed',
'  5. No number appears in the JSON that cannot be traced to a tool result or stated assumption',
'- If any check fails, fix it before outputting. Quality > speed.',
```

---

## 可選修改：cleanFloatsInRow 注入到 summarizeToolResult

目前 `summarizeToolResult`（line 1725）把 raw tool result 原樣傳回 agent。如果 SQL result 有浮點殘差（如 `120.00000000000001`），agent 會直接複製這些殘差值。

**檔案**：`chatAgentLoop.js`
**位置**：line 1226-1228

```javascript
// ── 修改前 ──
const resultContent = toolResult.success
  ? JSON.stringify(summarizeToolResult(toolResult.result), null, 2)
  : JSON.stringify({ error: toolResult.error });

// ── 修改後 ──
const resultContent = toolResult.success
  ? JSON.stringify(
      cleanToolResultFloats(summarizeToolResult(toolResult.result)),
      null, 2
    )
  : JSON.stringify({ error: toolResult.error });
```

在 `summarizeToolResult` 函數附近（line ~1748）新增：

```javascript
/**
 * Clean floating-point residuals in tool results before feeding back to LLM.
 * Prevents the agent from copying values like 120.00000000000001 into the brief.
 */
function cleanToolResultFloats(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number' && !Number.isInteger(obj)) {
    return Math.round(obj * 100) / 100;
  }
  if (Array.isArray(obj)) {
    return obj.map(cleanToolResultFloats);
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = cleanToolResultFloats(v);
    }
    return out;
  }
  return obj;
}
```

---

## 優先級總覽

| # | 修改 | 優先級 | 預期影響 | 改動範圍 |
|---|------|--------|---------|---------|
| 1 | columnMeta injection via deferredGuidance | P0 | agent 看到 unit type，正確轉換 CAGR | `chatAgentLoop.js` ~line 1191 + export `inferColumnMeta` |
| 2 | 強化 CAGR 規則 + step-by-step example | P0 | 消除 CAGR magnitude mismatch → correctness ↑ | `chatAgentLoop.js` lines 527-531 |
| 3 | MANDATORY CAVEATS 規則 | P0 | 補 proxy/limitation caveat → caveat_quality ↑ | `chatAgentLoop.js` 插入 line ~532 |
| 4 | PILL-SUMMARY DEDUP 規則 | P1 | 消除 verbatim restatement → info density ↑ | `chatAgentLoop.js` 插入 line ~553 |
| 5 | EVIDENCE PRIORITY 規則 | P1 | 減少 raw row 計算錯誤 → correctness ↑ | `chatAgentLoop.js` 插入 line ~525 |
| 6 | SELF-AUDIT checklist | P1 | 整體品質防線 → 所有維度 ↑ | `chatAgentLoop.js` 插入 line ~566 |
| 7 | cleanToolResultFloats | P2 | 消除浮點殘差 → correctness 邊界案例 ↑ | `chatAgentLoop.js` line 1226 + 新函數 |

**預期效果**：

| 維度 | 當前 | 修改後預期 | 改善來源 |
|------|------|-----------|---------|
| Correctness | 0 → 2 (enhanced) | 5-7 | Fix 2 (CAGR example) + Fix 1 (columnMeta) |
| Caveat quality | 0 → 8 (enhanced) | 6-8 | Fix 3 (mandatory caveats) |
| Evidence alignment | ~5.5 | 6-7 | Fix 5 (evidence priority) + Fix 1 |
| Information density | ~5 | 6-7 | Fix 4 (pill dedup) |
| Methodology transparency | ~4 | 6-7 | Fix 3 (methodology caveat) + Fix 6 |
| **Overall** | **4.9-5.9** | **7.0-7.5** | |

---

## 測試驗證

修完後用同一題測試：

> **問題**：「分析巴西賣家過去三年的年營收趨勢，包括 CAGR 計算、營收分佈（中位數與四分位距），以及影響營收波動的主要風險因子。請用繁體中文回答。」

**驗證 checklist**：

- [ ] CAGR pill 顯示為百分比格式（如 `1,118%` 而非 `11.18%`）
- [ ] Console 有 `📊 COLUMN METADATA` guidance 輸出
- [ ] caveats[] 包含 proxy data caveat（提及 Olist / 代理指標）
- [ ] caveats[] 包含 low-base caveat（提及低基期）
- [ ] summary 不是 pill values 的重複，而是有解讀和上下文
- [ ] methodology_note 解釋了 CAGR 計算方法
- [ ] 所有數值可追溯到 tool result
- [ ] Overall score ≥ 7.0
- [ ] Correctness ≥ 5.0
- [ ] Caveat quality ≥ 5.0

---

## 注意事項

1. **不要改 synthesis prompt**：它在 analysis mode 下被 bypass，改了也沒用
2. **agent system prompt 長度**：新增規則約 +1500 chars，對 GPT-5.4 context window 影響極小
3. **deferredGuidance 是 user role**：agent 會把它當成「系統提示」處理，比 system prompt 裡的靜態規則更有效果（因為是 contextual，針對具體的 tool result）
4. **修改 1（columnMeta injection）是最關鍵的**：因為它在 agent 看到具體數據後才注入 unit type 資訊，等於「告訴 agent：這個欄位是 multiplier，要 ×100」
