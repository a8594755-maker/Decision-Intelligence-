# Agent 分析品質改進計畫 v3

> **背景**：基於 Revenue & Sales Trend Analysis 這次實際 pipeline 輸出的完整 debug trace，逐一拆解問題根源並給出具體修改方向。

---

## Issue #1：Sandbox Library 白名單未告知 Agent（🔴 Critical）

### 現象
- Primary Agent (GPT-5.4-thinking)：`ImportError: Import of 'statsmodels.tsa.seasonal' is not allowed in sandbox`
- Enhanced Agent (DeepSeek Reasoner)：`ImportError: Import of 'calendar' is not allowed in sandbox`
- 兩個 agent 都浪費了一次 tool call + 回應 token 去處理失敗

### 根因
`run_python_analysis` 的 tool description（`builtinToolCatalog.js` line 1158）寫的是：

```
"Advanced statistical analysis with pandas/numpy/scipy."
```

但實際 `_ALLOWED_MODULES`（`tool_executor.py` line 699-712）允許的是：

```python
pandas, numpy, json, re, math, datetime, time,
collections, statistics, itertools, functools,
decimal, fractions, copy, string, textwrap,
operator, numbers, hashlib, base64, uuid,
scipy, scipy.stats, scipy.interpolate, scipy.optimize,
openpyxl 系列, dateutil, pytz, warnings, typing, abc, enum
```

**`statsmodels`、`calendar`、`sklearn`、`matplotlib`、`seaborn`** 全都不在白名單中，但 agent 不知道。

### 修改方向

**檔案**：`src/services/builtinToolCatalog.js` line 1158

**改 description 為**：
```
"Advanced statistical analysis in a restricted Python sandbox. AVAILABLE: pandas, numpy, scipy (scipy.stats, scipy.interpolate, scipy.optimize), statistics, collections, itertools, datetime, dateutil, math, json, re, copy, decimal, uuid, openpyxl. NOT AVAILABLE: statsmodels, sklearn, matplotlib, seaborn, calendar, plotly, os, sys, subprocess. For time series decomposition, use scipy or manual rolling averages instead of statsmodels. For plotting, return structured data — charts are rendered by the frontend."
```

**額外**：在 `chatAgentLoop.js` line 542 附近的 system prompt 規則中加入：
```
- run_python_analysis sandbox: Only pandas, numpy, scipy, statistics, collections, itertools, datetime, math, json, re, copy are available. Do NOT attempt to import statsmodels, sklearn, matplotlib, seaborn, or calendar — they will fail. Use scipy.stats or manual implementations instead.
```

---

## Issue #2：Optimizer Brief Synthesis 格式崩壞（🔴 Critical）

### 現象
Enhanced Agent（DeepSeek Reasoner）的 Agent Brief：
- headline = `"## Revenue & Sales Trend Analysis - Corrected Findings"`
- summary = 整段 markdown raw dump（包含 `##` headers、`**bold**`、tables）
- metric_pills 只有 1 個（`month: 1472688000000`，是 raw timestamp）
- implications、caveats、next_steps 只有各 1 條，且是從 markdown 中隨機截取

### 根因
DeepSeek Reasoner 的 final narrative 是高品質的 markdown 報告，但 `buildAgentBriefSynthesisPrompt` 無法約束它產出乾淨 JSON。Reasoner 模型傾向於把整段 narrative 塞進 summary 欄位而不是重新結構化。

Judge 被迫在 5.4 分的 primary 和格式崩壞的 enhanced 之間選擇，選了較差但至少格式正確的 primary。

### 修改方向

**方案 A（推薦）：分離 narrative 生成和 brief 格式化**

不要讓 DeepSeek Reasoner 同時負責「分析」和「格式化 brief JSON」。改為兩步：

1. DeepSeek Reasoner 只產出 raw narrative（自由格式 markdown）
2. 用 Gemini Flash 或 Claude Haiku 做 brief synthesis（它們對 JSON schema 遵從度高）

**檔案**：`src/services/agentResponsePresentationService.js`

在 `buildDeterministicAgentBrief` 之前加一個判斷：
```javascript
// 如果 optimizer 的 model 是 deepseek-reasoner，用獨立的 brief synthesis call
if (optimizerModel?.includes('deepseek-reasoner') || optimizerModel?.includes('kimi')) {
  const briefJson = await callLLM({
    taskType: 'brief_synthesis',
    systemPrompt: buildAgentBriefSynthesisPrompt({ ... }),
    prompt: optimizerNarrative,
    model: 'gemini-2.0-flash',  // 或 claude-haiku
    jsonMode: true,
  });
  return JSON.parse(briefJson.text);
}
```

**方案 B（輕量）：Brief Synthesis 後加 post-processing**

在收到 brief JSON 後，加入清洗邏輯：
```javascript
function sanitizeBrief(brief) {
  // Strip markdown headers from headline
  if (brief.headline) {
    brief.headline = brief.headline.replace(/^#{1,4}\s*/, '').replace(/^\*{1,2}|[\*]{1,2}$/g, '').trim();
  }
  // Truncate summary if it contains markdown headers (sign of raw dump)
  if (brief.summary && /^##\s/m.test(brief.summary)) {
    // Extract first paragraph only
    brief.summary = brief.summary.split(/\n##\s/)[0].trim();
  }
  // Fix timestamp-as-value in metric_pills
  brief.metric_pills = (brief.metric_pills || []).filter(p => {
    return !/^\d{10,13}$/.test(String(p.value)); // Remove raw timestamps
  });
  return brief;
}
```

---

## Issue #3：圖表渲染為表格而非視覺化（🔴 Critical）

### 現象
Agent Brief 中的三個 "Chart" 全部顯示為數據表：
```
Chart: Monthly Revenue and Trend
x          total_revenue    trend_revenue
2016-09    134.97           20230.04
2016-10    40325.11         13490.33
...
```

前端沒有渲染出任何視覺化圖表。

### 根因分析

可能的原因鏈：

1. `generate_chart` recipe 返回的 chart spec 缺少 `type` 欄位（ChartRenderer 需要 `type` 才知道渲染哪種圖）
2. Brief synthesis prompt 生成的 `charts[]` 格式不符合 `ChartRenderer` 預期（缺少 `xKey`/`yKey`）
3. 日期欄位作為 xKey 但格式不被 Recharts XAxis 識別

**需要驗證**：在 `AgentBriefCard.jsx` 中 `ChartRenderer` 渲染之前 `console.log(chart)` 看看實際收到的 spec 是什麼。

### 修改方向

**1. Chart spec validation（在 brief synthesis 後）**

**檔案**：`src/services/agentResponsePresentationService.js`

```javascript
function validateChartSpec(chart) {
  if (!chart?.type || !Array.isArray(chart?.data) || chart.data.length === 0) return null;
  if (!chart.xKey && !chart.data[0]) return null;

  // Auto-infer xKey/yKey if missing
  if (!chart.xKey || !chart.yKey) {
    const keys = Object.keys(chart.data[0] || {});
    const numericKeys = keys.filter(k => typeof chart.data[0][k] === 'number');
    const stringKeys = keys.filter(k => typeof chart.data[0][k] === 'string');
    if (!chart.xKey) chart.xKey = stringKeys[0] || keys[0];
    if (!chart.yKey) chart.yKey = numericKeys[0] || keys[1];
  }

  return chart;
}

// Apply after brief synthesis
brief.charts = (brief.charts || []).map(validateChartSpec).filter(Boolean);
```

**2. 日期格式化（在 ChartRenderer 層）**

**檔案**：`src/components/chat/ChartRenderer.jsx`

在 tick formatter 中偵測日期格式的 xKey 值並自動格式化：
```javascript
function autoDateFormatter(value) {
  // Detect YYYY-MM format
  if (/^\d{4}-\d{2}$/.test(value)) return value; // Already short enough
  // Detect ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  // Detect Unix timestamp (ms)
  if (typeof value === 'number' && value > 1e12) {
    return new Date(value).toLocaleDateString(undefined, { year: '2-digit', month: 'short' });
  }
  return value;
}
```

---

## Issue #4：Evidence 表格顯示 Unix Timestamps（🟡 High）

### 現象
Supporting Data 表格中 `month` 欄位顯示 `1472688000000` 而非可讀日期。

### 根因
`query_sap_data` 返回 DuckDB 的 timestamp 型態欄位時，序列化成了 Unix milliseconds（DuckDB 的 TIMESTAMP 會被 JavaScript JSON.stringify 轉成 epoch ms）。`summarizeToolCalls` 和 `AgentBriefCard` 都沒有做格式化。

### 修改方向

**檔案**：`src/prompts/agentResponsePrompt.js` → `summarizeToolCalls()`

在序列化 tool call 結果時，偵測並格式化 timestamp-like 數字：
```javascript
function formatCellValue(value) {
  // Unix ms timestamp (13 digits, in reasonable range 2000-2040)
  if (typeof value === 'number' && value > 9.46e11 && value < 2.21e12) {
    return new Date(value).toISOString().slice(0, 10); // YYYY-MM-DD
  }
  return value;
}
```

在 `buildEvidenceTables` 或 brief synthesis 的 table rows 中 apply 這個 formatter。

**同時在前端**：`AgentBriefCard.jsx` 的 table 渲染中加入同樣的偵測邏輯作為防線。

---

## Issue #5：QA 標記 Blocker 但未有效阻止輸出（🟡 High）

### 現象
QA 正確識別了：
- 「Conflicting std revenue values: 33,273.7 vs 245.9」（一個是 revenue std，一個是 orders std，被標為 "conflicting revenue values"）
- 「Missing caveat despite failed evidence」
- Caveats score = 0

但最終輸出仍然帶著這些問題。

### 根因
1. 「Conflicting std values」其實是 **誤判**——33,273.7 BRL 是 revenue 的 std，245.9 是 orders 的 std，兩者本來就不一樣。但 QA deterministic checker 用正則匹配到兩個 pill 都包含 "std" + 不同數字，就標記為 conflicting。
2. Caveats = 0 但 overall score 仍然 5.4 而非被 block——因為 `caveat_quality` 的 weight 只有 0.07，即使得 0 分也只拉下 0.7 分。
3. Optimizer 跑了但產出更差，judge 只能選 primary。

### 修改方向

**A. Deterministic QA 的 "conflicting values" 偵測太粗糙**

**檔案**：`src/services/agentResponsePresentationService.js` → `computeDeterministicQa()`

目前的 conflicting values 檢測只看 pill label 是否都包含某個關鍵字（如 "std"）且值不同。需要改為：
```javascript
// 只在兩個 pill 的 label 完全相同（或一個是另一個的子串）且值不同時才標記 conflict
// "Revenue Residual Volatility (Std Dev)" vs "Sales Volume Residual Volatility (Std Dev)"
// → label 不同，不是 conflict
```

**B. Caveats = 0 + 有 failed tool call → 自動注入 caveat**

在 deterministic QA 階段：
```javascript
const failedTools = toolCalls.filter(tc => !tc.success);
if (failedTools.length > 0 && (brief.caveats || []).length === 0) {
  // Auto-inject caveat instead of just flagging
  brief.caveats = brief.caveats || [];
  brief.caveats.push(
    `Analysis used alternative methods due to sandbox limitations (${failedTools.map(t => t.name).join(', ')} failed). Results may be less precise than intended.`
  );
}
```

**C. 將 caveat_quality weight 從 0.07 提高到 0.12**

當 caveats 應該存在卻缺失時（有 failed tool calls、有 proxy metrics、有 0-row queries），這是一個嚴重的信任問題，不應該只佔 7% 權重。

---

## Issue #6：Optimizer 效率極低——8 次 query + 10 步推理（🟡 High）

### 現象
DeepSeek Reasoner 作為 optimizer 執行了：
- 10 步 thinking（Thinking 1-10）
- 1 次失敗的 `run_python_analysis`（calendar import）
- 6 次 `query_sap_data`（大量重複的 SQL）
- 2 次 `generate_chart`

它在不斷嘗試不同的 workaround 來取代 `statsmodels`，重複跑相似的 SQL 取同樣的資料。

### 根因
`buildOptimizerInstruction()`（`analysisDomainEnrichment.js` line 661-737）提供的資訊不夠：

1. **沒有告訴 optimizer primary 的 tool calls 為什麼失敗**。它只給了 `❌ failed` 但沒有 error message 的具體內容（如 "Import of 'statsmodels' is not allowed"）
2. **沒有告訴 optimizer sandbox 的限制**。optimizer 不知道 `calendar` 也不能用
3. **沒有告訴 optimizer primary 已經成功產出了什麼資料**。optimizer 重新跑了 6 次 SQL 取基本上相同的月度資料

### 修改方向

**檔案**：`src/services/analysisDomainEnrichment.js` → `buildOptimizerInstruction()`

**改進 tool summary 的格式**，包含完整 error message：
```javascript
const toolSummary = Array.isArray(primaryToolSummary)
  ? primaryToolSummary.map((tc) => {
    const status = tc.success
      ? `✅ ${tc.rowCount ?? '?'} rows`
      : `❌ FAILED: ${tc.error || 'unknown error'}`;  // 加入完整 error
    return `- ${tc.name}(${JSON.stringify(tc.args).slice(0, 120)}): ${status}`;
  }).join('\n')
  : 'No tool calls recorded.';
```

**加入 sandbox 限制提醒**：
```
== SANDBOX CONSTRAINTS ==
run_python_analysis: Only pandas, numpy, scipy, statistics, collections, itertools, datetime, math, json, re available.
statsmodels, sklearn, matplotlib, seaborn, calendar are NOT available.
```

**加入 primary 的成功資料摘要**：
```
== PRIMARY AGENT SUCCESSFUL DATA (do NOT re-query) ==
- query_sap_data: 23 rows monthly data (month, total_orders, total_revenue, total_items)
- generate_chart: revenue trend line chart spec generated
Use this data directly. Only run NEW queries for dimensions A did NOT cover.
```

---

## Issue #7：Primary Agent 的圖表 recipe 成功但品質差（🟠 Medium）

### 現象
`generate_chart` 標記為 "Completed successfully" 兩次，但：
1. Chart spec 可能缺少必要欄位（type、xKey、yKey）
2. 產出的三個 chart 都只有 data table，沒有被 ChartRenderer 正確渲染

### 修改方向

**檔案**：`src/services/chartRecipeExecutor.js`（或等價的 recipe 執行層）

在 recipe 執行完成後加入 spec validation：
```javascript
function validateRecipeOutput(spec) {
  const required = ['type', 'data'];
  for (const key of required) {
    if (!spec[key]) {
      console.warn(`[recipe] missing required field: ${key}`);
      return { ...spec, _valid: false };
    }
  }
  if (!Array.isArray(spec.data) || spec.data.length === 0) {
    return { ...spec, _valid: false };
  }
  // Auto-infer xKey/yKey from data if missing
  if (!spec.xKey || !spec.yKey) {
    const sample = spec.data[0];
    const keys = Object.keys(sample);
    const numKeys = keys.filter(k => typeof sample[k] === 'number');
    const strKeys = keys.filter(k => typeof sample[k] === 'string');
    spec.xKey = spec.xKey || strKeys[0] || keys[0];
    spec.yKey = spec.yKey || numKeys[0] || keys[1];
  }
  spec._valid = true;
  return spec;
}
```

---

## Issue #8：run_python_analysis tool description 誤導（🟠 Medium）

### 現象
Tool description 寫 "pandas/numpy/scipy"，但 agent 會嘗試 import `statsmodels.tsa.seasonal`（因為它知道 time series decomposition 需要 statsmodels）。Tool description 沒有提到**不能用什麼**。

### 修改方向
見 Issue #1。核心就是在 tool description 中明確列出 NOT AVAILABLE 清單。

---

## Issue #9：Metric Pills 包含不恰當指標（🟠 Medium）

### 現象
Primary 的 metric pills：
- `Time Period: September 2016 to October 2018 (23 months)` — 不是 KPI，是元資料
- `Revenue Trend Direction: Upward` — 不是數字，是描述
- `Sales Volume Trend Direction: Upward` — 同上
- `Seasonal Period: 12 months` — 不是 KPI
- `Revenue Residual Volatility (Std Dev): 33,273.68 BRL` — OK
- `Sales Volume Residual Volatility (Std Dev): 245.90 orders` — OK

6 個 pills 中只有 2 個是真正的 KPI。

### 修改方向

**檔案**：`src/prompts/agentResponsePrompt.js` → `buildAgentBriefSynthesisPrompt()`

在 rules 區塊加入：
```
- METRIC PILLS QUALITY: Each metric pill must contain a NUMERIC KPI value that aids decision-making.
  Do NOT use pills for: time periods, trend directions (up/down), categorical labels, or metadata.
  Good: "Revenue Growth: +2,349%" / "Peak Month Orders: 7,289" / "Avg Order Value: R$119.98"
  Bad: "Time Period: Sep 2016 - Oct 2018" / "Trend Direction: Upward" / "Seasonal Period: 12 months"
```

---

## Issue #10：Brief Synthesis 的 Caveats 規則自相矛盾（🟠 Medium）

### 現象
Brief synthesis prompt 的 Rules 區塊（line 259-262）說：

> "Evidence from generate_chart recipes is computed from raw dataset tables at query time. This is NOT pre-computed or cached data. Do NOT add caveats questioning the reliability of recipe-generated artifacts."

但同時（line 263-264）說：

> "If the evidence is partial or proxy-based, add a caveat."

在這次案例中，`run_python_analysis` 失敗了，agent 用 SQL rolling average 做了 proxy decomposition，但 caveats 陣列是空的。因為第一條規則讓 agent 猶豫要不要加 caveat。

### 修改方向

把規則改為更清晰的分類：
```
- CAVEATS DECISION TREE:
  1. Any tool call FAILED? → MUST add caveat about alternative methodology used
  2. Using proxy metric (e.g., SQL moving average instead of statsmodels decomposition)? → MUST add caveat
  3. Data has known limitations (time range, coverage, sampling)? → MUST add caveat
  4. Recipe-generated chart from full dataset tables? → Do NOT add caveat questioning its reliability
  Never produce an empty caveats array when conditions 1-3 apply.
```

---

## Issue #11：Judge 選擇邏輯在 optimizer 格式崩壞時無能為力（🟠 Medium）

### 現象
Judge verdict = `deterministic · qa_delta_comparison`，選了 primary（5.4 分）。因為 enhanced 的 brief 格式崩壞，deterministic 比較必然選 primary。

### 修改方向

在 judge 之前加入 **brief format gate**：
```javascript
// 如果 optimizer 的 brief headline 包含 markdown headers 或 summary > 2000 chars，
// 直接判定 optimizer brief 無效，不送入 judge，改為用 primary + deterministic repair
if (optimizerBrief?.headline?.startsWith('#') ||
    (optimizerBrief?.summary?.length || 0) > 2000 ||
    /^##\s/m.test(optimizerBrief?.summary || '')) {
  console.warn('[judge] optimizer brief format invalid, falling back to primary');
  // 跳過 judge，直接用 primary + auto-repair
}
```

---

## Issue #12：cross-reviewer（Gemini）返回不完整 dimension_scores（🟠 Medium）

### 現象
Cross-model reviewer（Gemini 3.1 Pro）只返回了 5 個 dimension scores 而非 9 個，觸發 `[validateAgentQaReview] malformed dimension_scores`。

### 根因
`buildQaReviewPrompt` 已經在 line 400 寫了：
```
"MANDATORY: You MUST score ALL 9 dimensions. Do not omit any dimension."
```

但 Gemini 仍然忽略了這條指令。

### 修改方向

**A. Post-processing 填補缺失 dimensions**：
```javascript
function imputeMissingDimensions(scores) {
  for (const dim of QA_DIMENSION_KEYS) {
    if (scores[dim] == null || isNaN(scores[dim])) {
      scores[dim] = 5.0; // neutral score
    }
  }
  return scores;
}
```

**B. 在 prompt 中用 JSON schema 硬約束**：
```
"dimension_scores": {
  "correctness": <required, 0-10>,
  "completeness": <required, 0-10>,
  ... (列出全部 9 個)
}
```

---

## 優先級排序

| 優先級 | Issue | 預估改動量 | 影響 |
|--------|-------|-----------|------|
| P0 | #1 Sandbox 白名單寫進 tool description | 改 2 個字串 | 防止 agent 浪費 tool call |
| P0 | #2 Optimizer brief synthesis 格式崩壞 | 加 sanitize 函數 or 分離 synthesis 步驟 | 防止 enhanced 永遠被 judge 丟棄 |
| P0 | #3 圖表渲染為表格 | 加 chart spec validation + debug log | 用戶能看到圖表 |
| P1 | #4 Timestamp 格式化 | 加 formatter | 用戶能讀懂表格 |
| P1 | #5 QA blocker 無效 + 自動注入 caveat | 改 deterministic QA + weight | QA 系統能真正 block |
| P1 | #6 Optimizer 效率低 | 改 optimizer instruction | 減少 token 浪費和延遲 |
| P2 | #7 Chart recipe output validation | 加 validation | 確保 recipe 產出可渲染 |
| P2 | #9 Metric pills 品質 | 改 prompt rules | 用戶看到有意義的 KPI |
| P2 | #10 Caveats 規則矛盾 | 改 prompt rules | caveats 不再漏 |
| P2 | #11 Judge format gate | 加 pre-judge check | 避免格式崩壞影響選擇 |
| P2 | #12 Cross-reviewer dimension imputation | 加 post-processing | QA 分數穩定 |

---

## 快速見效的三個改動（建議今天就做）

### 1. `builtinToolCatalog.js` line 1158 — 改 tool description（5 分鐘）
把 `run_python_analysis` 的 description 改為包含 NOT AVAILABLE 清單。

### 2. `agentResponsePresentationService.js` — 加 `sanitizeBrief()`（15 分鐘）
Strip markdown headers from headline, truncate over-long summary, filter timestamp pills.

### 3. `agentResponsePresentationService.js` — 加 auto-inject caveat（10 分鐘）
如果有 failed tool calls 且 caveats 為空，自動注入一條。

這三個改動合計 30 分鐘，能解決最嚴重的三個問題（agent 不撞 sandbox、brief 格式不崩、caveats 不漏）。
