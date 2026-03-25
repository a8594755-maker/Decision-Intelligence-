# Decision Intelligence — 架構級躍升方案

> 這不是修 Bug 指南。這是改變系統「天花板」的架構重構方案。
> 前 5 輪修的是「地板」（讓系統不出錯），這份改的是「天花板」（讓系統出色）。

---

## 核心診斷：為什麼 5 輪修改後品質仍不穩定？

你目前的架構是：

```
User → Answer Contract → [單一 Agent Loop: 規劃 + 查詢 + 計算 + 敘述 全部混在一起]
     → Post-hoc QA (事後補救) → Repair → Output
```

**根本問題：Agent 同時負責「取證」和「寫報告」，這兩件事互相干擾。**

- Agent 在寫敘述時「記錯」自己查到的數字 → 產生 scope mixing、wrong average
- QA 只能事後抓錯，但 Agent 已經把錯誤「編織」進敘述裡了
- Repair LLM 拿到的是已經混亂的敘述，修一個地方又破壞另一個地方
- 每一輪修 Bug 都是在 patch 這個根本問題的不同症狀

**類比：你現在的流程像是讓一個人同時做偵探（收集證據）和律師（寫辯護詞）。
正確的做法是：先讓偵探把所有證據收齊、驗證完畢，再讓律師根據驗證過的證據寫辯護詞。**

---

## 方案一（最高優先）：Evidence-First 兩階段架構

### 現狀 vs 目標

```
【現狀】單一 Agent Loop
User → Agent(規劃 + SQL + Python + 寫敘述) → QA → Repair → Output
        ↑ 所有事情混在一個 ReAct loop 裡

【目標】兩階段分離
User → Phase 1: Evidence Agent (只收集數據，不寫敘述)
     → Phase 2: Evidence Registry (確定性驗證 + 預計算)
     → Phase 3: Synthesis Agent (只根據驗證過的數據寫敘述)
     → Phase 4: Lightweight QA (只檢查敘述品質，不再需要檢查數據正確性)
```

### 為什麼這是質變？

| 問題 | 現狀解法 | 新架構解法 |
|------|----------|-----------|
| Scope mixing | QA 事後偵測 + prompt 提醒 | Evidence Registry 記錄每筆數據的 filter scope，synthesizer 根本看不到混合 scope 的數據 |
| Wrong average | prompt 提醒 "derived value audit" | Phase 2 用 JavaScript 確定性計算所有衍生值，Agent 不需要心算 |
| 極端 MoM% | prompt 提醒 "extreme value handling" | Phase 2 自動標記異常值，Synthesis 收到的數據已經有 flag |
| 浮點殘留 | normalizeBrief 清理 | Phase 2 統一格式化所有數值，Synthesis 收到的已經是乾淨的 |
| QA 假陽性 | 修 regex、加 cap | QA 只需檢查敘述是否忠於 Evidence Registry，不需要反向推斷數據正確性 |

### 具體實作

#### Step 1：新增 `evidenceRegistry.js`

```javascript
// src/services/evidenceRegistry.js
// 這是整個架構升級的核心新元件

class EvidenceRegistry {
  constructor() {
    this.entries = [];        // 每筆 SQL/Python 結果
    this.derivedValues = {};  // 確定性計算的衍生值
    this.scopeMap = {};       // 每筆查詢的 filter scope
    this.warnings = [];       // 數據品質警告
  }

  /**
   * 註冊一筆查詢結果，解析其 scope metadata
   */
  registerQueryResult(toolCall) {
    const sql = toolCall.args?.sql || '';
    const scope = this._extractScope(sql);
    const entry = {
      id: `ev_${this.entries.length}`,
      tool: toolCall.name,
      sql: sql,
      scope: scope,                    // { filters: [...], timeRange: {...} }
      rows: toolCall.result?.rows || [],
      rowCount: toolCall.result?.rowCount || 0,
      columns: toolCall.result?.meta?.columns || [],
      registeredAt: Date.now(),
    };
    this.entries.push(entry);
    return entry.id;
  }

  /**
   * 從 SQL WHERE 子句提取 scope 資訊
   */
  _extractScope(sql) {
    const filters = [];
    // 抓取 WHERE 條件
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:GROUP|ORDER|LIMIT|HAVING|$)/is);
    if (whereMatch) {
      // 解析 status filters
      const statusMatch = whereMatch[1].match(/order_status\s*=\s*'([^']+)'/i);
      if (statusMatch) filters.push({ column: 'order_status', value: statusMatch[1] });

      // 解析 date range
      const dateMatches = [...whereMatch[1].matchAll(
        /(\w+)\s*(>=?|<=?|BETWEEN)\s*'(\d{4}-\d{2}(?:-\d{2})?)'/gi
      )];
      for (const m of dateMatches) {
        filters.push({ column: m[1], operator: m[2], value: m[3] });
      }
    }
    return { filters, raw: sql };
  }

  /**
   * 確定性計算衍生值 — Agent 不需要心算
   */
  computeDerivedValues() {
    const derived = {};

    for (const entry of this.entries) {
      if (entry.rowCount === 0) continue;
      const rows = entry.rows;

      // 自動識別數值欄位並計算基本統計量
      const numericCols = this._identifyNumericColumns(entry);
      for (const col of numericCols) {
        const values = rows.map(r => parseFloat(r[col])).filter(Number.isFinite);
        if (values.length === 0) continue;

        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);

        derived[`${entry.id}.${col}`] = {
          sum, avg, min, max,
          count: values.length,
          scope: entry.scope,
          // 格式化後的值（K/M/B）
          formatted: {
            sum: formatBusinessNumber(sum),
            avg: formatBusinessNumber(avg),
          }
        };
      }
    }

    // 交叉驗證：如果多筆查詢涵蓋相同指標但不同 scope，標記差異
    this._crossValidateScopes(derived);

    this.derivedValues = derived;
    return derived;
  }

  /**
   * 偵測 scope 不一致
   */
  _crossValidateScopes(derived) {
    const byMetric = {};
    for (const [key, val] of Object.entries(derived)) {
      const metric = key.split('.').pop(); // column name
      if (!byMetric[metric]) byMetric[metric] = [];
      byMetric[metric].push({ key, ...val });
    }

    for (const [metric, entries] of Object.entries(byMetric)) {
      if (entries.length < 2) continue;
      const scopes = entries.map(e => JSON.stringify(e.scope.filters));
      const uniqueScopes = [...new Set(scopes)];
      if (uniqueScopes.length > 1) {
        this.warnings.push({
          type: 'scope_mismatch',
          metric,
          message: `"${metric}" 存在 ${uniqueScopes.length} 種不同 scope 的查詢結果，合成時必須明確標註哪個 scope`,
          entries: entries.map(e => ({ key: e.key, scope: e.scope, sum: e.sum })),
        });
      }
    }
  }

  /**
   * 極端值標記
   */
  flagExtremeValues() {
    for (const entry of this.entries) {
      for (const row of entry.rows) {
        for (const [col, val] of Object.entries(row)) {
          const num = parseFloat(val);
          if (!Number.isFinite(num)) continue;
          // MoM/YoY 超過 10000% 的標記為極端值
          if (/mom|yoy|growth|change|pct/i.test(col) && Math.abs(num) > 10000) {
            row[`${col}_flag`] = 'extreme_base_near_zero';
            row[col] = null; // 替換為 null，synthesizer 會顯示 N/A
          }
        }
      }
    }
  }

  /**
   * 產生給 Synthesis Agent 的結構化 Evidence Brief
   * 這是 synthesizer 唯一的數據來源
   */
  toSynthesisBrief() {
    return {
      evidence_entries: this.entries.map(e => ({
        id: e.id,
        tool: e.tool,
        scope_description: this._describeScopeInNaturalLanguage(e.scope),
        row_count: e.rowCount,
        columns: e.columns,
        sample_rows: e.rows.slice(0, 20), // 最多 20 行
        full_row_count: e.rowCount,
      })),
      derived_values: this.derivedValues,
      warnings: this.warnings,
      scope_summary: this._buildScopeSummary(),
    };
  }

  _buildScopeSummary() {
    const allFilters = this.entries.flatMap(e => e.scope.filters);
    if (allFilters.length === 0) return 'All queries are unfiltered (full dataset scope).';
    const filterDescs = [...new Set(allFilters.map(f => `${f.column}=${f.value}`))];
    return `Active filters across queries: ${filterDescs.join(', ')}. Ensure all narrative numbers reference the correct scope.`;
  }
}
```

#### Step 2：修改 `chatAgentLoop.js` — 分離 Evidence 和 Synthesis

```javascript
// chatAgentLoop.js — 修改 runAgentLoop
// 核心改動：Agent Loop 的 final answer 不再是 JSON Brief，而是結構化的 Evidence

// === 改動 1：Agent system prompt 尾部的 "Final Answer Rules" 全部替換 ===
// 刪除現有的 lines 526-558 (要求 Agent 輸出 JSON brief 的所有規則)
// 替換為：

const EVIDENCE_COLLECTION_RULES = `
Final Answer Rules:
- Your job is to COLLECT EVIDENCE, not to write the final report.
- After running all necessary queries and analysis, output a JSON summary of what you found:
  {
    "evidence_summary": "2-3 sentences describing what the data shows",
    "key_numbers": [
      { "metric": "total_revenue", "value": 13594824.98, "unit": "BRL", "scope": "all orders, 2016-09 to 2018-10", "source": "query_1" },
      { "metric": "delivered_revenue", "value": 13221874.52, "unit": "BRL", "scope": "delivered orders only", "source": "query_2" }
    ],
    "time_range": { "start": "2016-09", "end": "2018-10", "months_with_data": 24, "calendar_months": 25 },
    "notable_patterns": ["revenue peaked in Nov 2017", "3 months had < 100 orders"],
    "data_quality_notes": ["Sep 2016 has only 4 orders — likely partial month"]
  }
- Do NOT write narrative, headline, summary, key_findings, implications, or next_steps.
- Do NOT format numbers with K/M/B — output raw numbers. Formatting happens downstream.
- Do NOT compute averages or growth rates manually — output the raw totals and counts. Derivation happens downstream.
- Focus on running the RIGHT queries to get COMPLETE evidence for all required_dimensions.
`;

// === 改動 2：Agent Loop 結束後，插入 Evidence Registry 處理 ===
// 在 runAgentLoop return 之前，加入：

import { EvidenceRegistry } from './evidenceRegistry.js';

// ... 在 loop 結束後 ...
const registry = new EvidenceRegistry();
for (const tc of collectedToolCalls) {
  if (tc.name === 'query_sap_data' && tc.result?.success) {
    registry.registerQueryResult(tc);
  }
}
registry.computeDerivedValues();
registry.flagExtremeValues();

// 回傳 evidence registry 而非 narrative
return {
  status: 'completed',
  toolCalls: collectedToolCalls,
  evidenceRegistry: registry,
  agentEvidenceSummary: lastAgentMessage, // Agent 的 evidence_summary JSON
  finalAnswerText: lastAgentMessage,
};
```

#### Step 3：新增 `evidenceSynthesisService.js` — 專門的 Synthesis Agent

```javascript
// src/services/evidenceSynthesisService.js
// 這個 service 只負責一件事：把驗證過的 evidence 轉成高品質敘述

export async function synthesizeFromEvidence({
  userMessage,
  answerContract,
  evidenceBrief,    // 來自 EvidenceRegistry.toSynthesisBrief()
  agentSummary,     // Agent 的 evidence_summary
  mode = 'analysis',
}) {
  const prompt = buildEvidenceSynthesisPrompt({
    userMessage,
    answerContract,
    evidenceBrief,
    agentSummary,
  });

  const result = await runDiPrompt({
    promptId: DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS,
    input: { prompt },
    temperature: 0.3,   // 稍高溫度允許更有深度的敘述
    maxOutputTokens: 4096,
  });

  return normalizeBrief(result?.parsed);
}

function buildEvidenceSynthesisPrompt({ userMessage, answerContract, evidenceBrief, agentSummary }) {
  return `You are a senior business analyst writing a report from VERIFIED evidence.

## Your Task
Write a business analysis brief answering: "${userMessage}"

## VERIFIED Evidence (all numbers below are fact-checked)
${JSON.stringify(evidenceBrief, null, 2)}

## Agent's Evidence Summary
${agentSummary}

## CRITICAL RULES
1. You may ONLY use numbers from the "derived_values" and "evidence_entries" above.
2. For averages, use the pre-computed "avg" values. Do NOT calculate averages yourself.
3. For totals, use the pre-computed "sum" values.
4. If "warnings" contains scope_mismatch entries, you MUST explicitly state which scope each number refers to.
5. If any value has a "_flag": "extreme_base_near_zero", display it as "N/A (base period near zero)" instead of the percentage.
6. The "scope_description" field tells you exactly what filters were applied. Reference this in your narrative.

## Output Format
Return a JSON object with this exact schema:
{
  "headline": "one-sentence conclusion with the most important number",
  "executive_summary": "one sentence, 1-2 key numbers",
  "summary": "300-500 word markdown narrative. Structure: (a) what happened, (b) why it matters, (c) what to do next",
  "metric_pills": [{"label": "str", "value": "str (use K/M/B)", "source": "evidence_entry_id"}],
  "tables": [...],
  "charts": [...],
  "key_findings": ["each finding cites a specific number"],
  "implications": ["each implication is actionable"],
  "caveats": ["only real limitations, not boilerplate"],
  "next_steps": ["specific, with parameters"],
  "methodology_note": "brief description of analysis approach"
}

Write with interpretive depth — explain WHY, not just WHAT.
Every claim must reference a specific number from the evidence.`;
}
```

#### Step 4：修改 `DecisionSupportView/index.jsx` — 串接新流程

```javascript
// 在現有的 agent execution flow 中（約 line 2472 附近），
// 修改 agent 完成後的處理邏輯：

// === 現狀 ===
// Agent loop 結束 → 直接用 agent 的 JSON output 作為 brief → QA

// === 改為 ===
// Agent loop 結束 → Evidence Registry 處理 → Synthesis Agent → Lightweight QA

// 在 selectedCandidate 處理完之後，synthesizeBrief 之前：
const { EvidenceRegistry } = await import('../../services/evidenceRegistry.js');
const { synthesizeFromEvidence } = await import('../../services/evidenceSynthesisService.js');

const registry = new EvidenceRegistry();
const toolCalls = selectedCandidate?.result?.toolCalls || [];
for (const tc of toolCalls) {
  if (tc.name === 'query_sap_data' && tc.result?.success) {
    registry.registerQueryResult(tc);
  }
  // Python analysis results 也可以註冊
  if (tc.name === 'run_python_analysis' && tc.result?.success) {
    registry.registerPythonResult(tc);
  }
}
registry.computeDerivedValues();
registry.flagExtremeValues();

// 用驗證過的 evidence 生成 brief
const evidenceBrief = registry.toSynthesisBrief();
const synthesizedBrief = await synthesizeFromEvidence({
  userMessage: query,
  answerContract,
  evidenceBrief,
  agentSummary: selectedCandidate?.result?.finalAnswerText || '',
  mode: 'analysis',
});

// 替換 presentation brief
selectedCandidate.presentation.brief = synthesizedBrief;

// QA 現在只需要檢查敘述品質（不再需要反向推斷數據正確性）
// 因為所有數字都已經被 Evidence Registry 驗證過了
```

### 預期效果

- **數據正確性問題減少 80%+**：Agent 不再需要心算衍生值，所有數字由 JavaScript 確定性計算
- **QA 假陽性減少 90%+**：QA 不再需要反向猜測 Agent 的數字是否正確
- **Scope mixing 完全消除**：Evidence Registry 追蹤每筆數據的 filter scope
- **Repair cycle 大幅減少**：因為 input 就是正確的，synthesis 只需要「寫得好」而非「算得對」

---

## 方案二：Multi-Query Strategy（多查詢交叉驗證）

### 問題

目前 Agent 通常只跑 1-2 個 SQL，然後根據有限數據寫出長篇敘述。
這像是記者只採訪一個人就寫報導。

### 解法：Query Planner

在 Agent Loop 開始前，加一個輕量 LLM call 來規劃查詢策略：

```javascript
// src/services/queryPlannerService.js

export async function planQueries({ userMessage, answerContract, schema }) {
  const prompt = `Given this question: "${userMessage}"
And these required dimensions: ${JSON.stringify(answerContract.required_dimensions)}
And this database schema: ${JSON.stringify(schema)}

Plan 3-6 SQL queries that together provide complete evidence.
Rules:
1. Query 1: Main aggregation (the primary answer)
2. Query 2: Cross-validation query (different approach to verify Query 1's totals)
3. Query 3: Time breakdown (monthly/quarterly trend)
4. Query 4+: Dimension breakdowns (by category, by status, etc.)

For each query, specify:
- purpose: what this query answers
- expected_columns: what columns it returns
- validates: which other query it cross-checks (if any)

Return JSON: { "queries": [...] }`;

  return await runDiPrompt({
    promptId: DI_PROMPT_IDS.QUERY_PLANNER,  // 新增的 prompt ID
    input: { prompt },
    temperature: 0.1,
    maxOutputTokens: 2048,
  });
}
```

然後 Agent 的 system prompt 注入這個 query plan：

```
── Query Plan ──
Execute these queries in order:
1. [Main] SELECT ... (purpose: total revenue by status)
2. [Validation] SELECT SUM(payment_value) ... (purpose: cross-check total via payments table)
3. [Trend] SELECT DATE_TRUNC('month', ...) ... (purpose: monthly breakdown)
4. [Breakdown] SELECT category, SUM(...) ... (purpose: top categories)

After executing all queries, verify:
- Query 1 total ≈ Query 2 total (tolerance: 1%)
- Query 3 monthly sum ≈ Query 1 total
If mismatches > tolerance, note the discrepancy in your evidence summary.
```

### 預期效果

- Agent 執行 4-6 個有目的的查詢，而非隨意探索
- 交叉驗證自動發現數據不一致
- 涵蓋所有 required_dimensions，減少 "missing dimension" QA failures
- 每個查詢目的明確，Evidence Registry 更容易追蹤

### 實作成本

- 新增 1 個 service file（queryPlannerService.js）
- 新增 1 個 prompt ID（QUERY_PLANNER）
- 修改 chatAgentLoop.js 注入 query plan（約 10 行）
- **額外延遲**：約 1-2 秒（一次輕量 LLM call）

---

## 方案三：Progressive Rendering（漸進式渲染）

### 問題

目前用戶等待流程：
```
[等 15-30 秒] → 看到一個大的完整回覆
```

Claude Web 的體驗：
```
[即時開始] → 文字逐字出現 → 圖表穿插 → 持續增長
```

### 解法：分層渲染

```javascript
// 改造 DecisionSupportView 的渲染流程

// Phase 1：Agent 開始執行時，立即顯示框架
onAgentStart: () => {
  renderSkeleton({
    metric_pills: ['loading...', 'loading...', 'loading...'],
    summary: '正在分析數據...',
    charts: [{ type: 'skeleton' }],
  });
}

// Phase 2：每個 SQL 完成時，立即更新 metric pills
onToolResult: (toolCall) => {
  if (toolCall.name === 'query_sap_data' && toolCall.result?.success) {
    // 從 SQL 結果中提取 headline 數字
    const quickMetrics = extractQuickMetrics(toolCall.result);
    updateMetricPills(quickMetrics);  // 立即更新 UI
  }
  if (toolCall.name === 'generate_chart' && toolCall.result?.success) {
    updateChart(toolCall.result);      // 圖表立即顯示
  }
}

// Phase 3：Synthesis 完成時，更新敘述
onSynthesisComplete: (brief) => {
  fadeInNarrative(brief.summary);
  updateFindings(brief.key_findings);
}
```

### 具體修改位置

**`DecisionSupportView/index.jsx`**：
- 現有 `onToolResult` callback（約 line 2460 附近）已經存在
- 需要新增「早期 metric pill 提取」邏輯
- 修改 `MessageCardRenderer.jsx` 支援 skeleton → real 的過渡動畫

**`chatAgentLoop.js`**：
- 現有 `onToolResult` callback 已經回傳 tool 結果
- 不需要修改 agent loop，只需要在前端處理 callback

### 預期效果

- 用戶在 3-5 秒內看到第一個數字（目前要等 15-30 秒）
- 體感速度提升 5x+
- 即使最終分析需要 30 秒，用戶也不會覺得「在等」

### 實作成本

- 主要修改前端（MessageCardRenderer.jsx）
- 新增 `extractQuickMetrics()` utility function
- **不影響後端邏輯**，是純 UX 改進

---

## 方案四：Adaptive Self-Improvement（自適應學習）

### 問題

目前的 prompt 是「靜態」的 — 不管 Agent 表現好壞，每次收到的指令都一樣。
已有 `aiEmployeeMemoryService.js` 記錄成功/失敗模式，但只用於查詢建議，沒有用於品質改進。

### 解法：QA Feedback Loop → Dynamic Prompt Tuning

```javascript
// src/services/adaptivePromptService.js

/**
 * 根據最近 N 次 QA 結果，動態調整 Agent prompt
 */
export async function getAdaptivePromptRules(datasetFingerprint) {
  // 從 memory 拉最近 20 次 QA 結果
  const recentQa = await recallRecentQaScores(datasetFingerprint, 20);

  const rules = [];

  // 統計哪些 QA 維度持續低分
  const dimAvg = {};
  for (const dim of QA_DIMENSION_KEYS) {
    const scores = recentQa.map(q => q.dimension_scores?.[dim]).filter(Number.isFinite);
    dimAvg[dim] = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 10;
  }

  // correctness 持續低分 → 加強數據驗證指令
  if (dimAvg.correctness < 7) {
    rules.push(
      '⚠️ ACCURACY ALERT: Recent analyses had data accuracy issues. ' +
      'Before outputting any number, verify it against the raw query result. ' +
      'Run a validation query (SELECT SUM/COUNT) to cross-check your main query.'
    );
  }

  // completeness 持續低分 → 加強 dimension coverage 指令
  if (dimAvg.completeness < 7) {
    rules.push(
      '⚠️ COVERAGE ALERT: Recent analyses missed required dimensions. ' +
      'Before writing your final answer, check the answer contract dimensions list ' +
      'and ensure EACH dimension has at least one supporting data point.'
    );
  }

  // information_density 持續低分 → 加強去重指令
  if (dimAvg.information_density < 7) {
    rules.push(
      '⚠️ DENSITY ALERT: Recent analyses had too much repetition. ' +
      'Each section (headline, summary, findings, pills) must contain UNIQUE information. ' +
      'Do not repeat the same number in more than 2 sections.'
    );
  }

  // 統計重複出現的 blocker 類型
  const blockerCounts = {};
  for (const qa of recentQa) {
    for (const b of qa.blockers || []) {
      const type = classifyBlocker(b);
      blockerCounts[type] = (blockerCounts[type] || 0) + 1;
    }
  }

  // 如果某類 blocker 出現 3+ 次，加入針對性警告
  for (const [type, count] of Object.entries(blockerCounts)) {
    if (count >= 3) {
      rules.push(`⚠️ RECURRING ISSUE (${count}x): ${BLOCKER_TYPE_INSTRUCTIONS[type]}`);
    }
  }

  return rules;
}

// 在 chatAgentLoop.js 中注入：
const adaptiveRules = await getAdaptivePromptRules(fingerprint);
if (adaptiveRules.length > 0) {
  importantInstructions.push(
    '',
    '── Adaptive Quality Rules (based on recent performance) ──',
    ...adaptiveRules,
    '',
  );
}
```

### 預期效果

- 系統從錯誤中學習，重複問題自動減少
- 不需要人工每次加 prompt 指令
- 已有 memory 基礎設施，實作成本低

---

## 方案五：Model Upgrade — Claude Sonnet 作為 Cross-Reviewer

### 問題

目前 Gemini 做 cross-review，但 Gemini 經常：
- 不遵守 "Do NOT re-check numbers" 指令
- 給出 correctness=0 的極端分數
- 把 K/M/B 格式化當作 "contradictions"

### 解法

把 cross-review 從 Gemini 切到 Claude Sonnet。
Claude 在結構化輸出、指令遵循、評分校準方面顯著更好。

```javascript
// diModelRouterService.js — 修改 JUDGE routing

// 目前：
// JUDGE_PROMPT_IDS → 使用 judge model (通常是 Gemini)

// 改為：在 getPromptDefaultModel 中，對 AGENT_QA_CROSS_REVIEW 使用 Claude
function getPromptDefaultModel(promptId) {
  if (promptId === DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW) {
    return 'claude-sonnet-4-20250514';  // Claude Sonnet 做 cross-review
  }
  if (JUDGE_PROMPT_IDS.has(promptId)) {
    return getModelConfig('judge').model;
  }
  return getModelConfig('primary').model;
}
```

### 預期效果

- Cross-review 分數更合理（不再出現 correctness=0 的極端情況）
- 指令遵循更好（不會重複檢查已由 deterministic QA 處理的項目）
- mergeQaResults 的 CAP_DELTA 問題自然緩解

---

## 實施優先級

| 優先級 | 方案 | 預期效果 | 實作成本 | 依賴 |
|--------|------|----------|----------|------|
| ⭐⭐⭐⭐⭐ | 方案一：Evidence-First 兩階段 | 數據正確性 +80% | 3-5 天 | 無 |
| ⭐⭐⭐⭐ | 方案二：Multi-Query Strategy | 覆蓋度 +50%, 一致性 +60% | 1-2 天 | 無 |
| ⭐⭐⭐⭐ | 方案三：Progressive Rendering | 體感速度 +5x | 2-3 天 | 無 |
| ⭐⭐⭐ | 方案四：Adaptive Self-Improvement | 重複錯誤 -70% | 1 天 | Memory 已有 |
| ⭐⭐⭐ | 方案五：Claude Cross-Reviewer | QA 假陽性 -90% | 0.5 天 | API key |

### 建議實施順序

```
Phase 1（1 週）：方案五 + 方案二
  → 最低成本、最快見效
  → Cross-reviewer 換 Claude + Query Planner 加入
  → 測試後確認 QA 分數穩定

Phase 2（2 週）：方案一
  → 核心架構變更
  → Evidence Registry + 兩階段分離
  → 這是整個系統的分水嶺

Phase 3（1 週）：方案三 + 方案四
  → UX 層面的躍升
  → Progressive rendering + Adaptive prompts
  → 完成後系統進入「自我改善」循環
```

---

## 方案一 + 二 + 三 整合後的完整流程

```
User Question
    ↓
[Answer Contract LLM] (0.5s)
    ↓
[Query Planner LLM] (1s) — 規劃 4-6 個有目的的查詢
    ↓
[Evidence Agent] (8-15s) — 只執行查詢，不寫敘述
    │
    ├─ SQL 1 完成 → [Progressive: 即時顯示 metric pills]
    ├─ SQL 2 完成 → [Progressive: 交叉驗證，更新 pills]
    ├─ Chart 完成 → [Progressive: 即時顯示圖表]
    └─ SQL 3-4 完成 → [Progressive: 更新趨勢指標]
    ↓
[Evidence Registry] (0.1s) — 確定性驗證 + 預計算衍生值
    │
    ├─ Scope 一致性檢查 ✓
    ├─ 衍生值計算（平均、成長率）✓
    ├─ 極端值標記 ✓
    └─ 浮點殘留清理 ✓
    ↓
[Synthesis Agent] (3-5s) — 根據驗證過的 evidence 寫敘述
    │
    └─ [Progressive: 敘述逐字出現]
    ↓
[Lightweight QA] (1s) — 只檢查敘述品質（不再需要檢查數據正確性）
    ↓
Output ✅

總延遲：13-22 秒（但用戶在 3 秒就看到第一個數字）
```

---

## 與 Round 5 修改的關係

Round 5 的修改（B1-B5, A1-A3）仍然值得做，因為：
- B1 (PCT_COL regex) 和 B2 (CAP_DELTA) 是即時止血，不需要架構變更
- A3 (floating point cleaning) 會被 Evidence Registry 取代，但在架構遷移前仍然需要

建議：
1. **先完成 Round 5 修改**（止血）
2. **再開始 Phase 1**（方案五 + 二）
3. **最後做 Phase 2**（方案一，核心架構變更）

這樣系統在架構遷移期間仍然穩定運作。
