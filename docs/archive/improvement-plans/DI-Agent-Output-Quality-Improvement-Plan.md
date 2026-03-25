# Decision Intelligence — Agent 輸出品質改進方案

> 基於完整程式碼審查後的具體改進建議，每項都標註了對應檔案和修改方向。

---

## 改進一：Brief Synthesis Prompt — 消除重複敘述

### 問題根因

`buildAgentBriefSynthesisPrompt()` 定義了 `headline`、`executive_summary`、`summary`、`metric_pills`、`key_findings` 五個欄位，但 prompt 裡對這些欄位的邊界定義不夠嚴格。LLM 傾向在每個欄位都塞入核心數據，導致同一組數字在畫面上出現 3-4 次。

**對應檔案：** `src/prompts/agentResponsePrompt.js` 第 169-251 行

### 修改方向

在 `## Rules` 區段加入明確的欄位分工約束：

```
- FIELD DEDUPLICATION (MANDATORY):
  • headline: ONE sentence, the single most important conclusion. No numbers unless they ARE the conclusion.
  • executive_summary: ONE sentence with 1-2 key numbers. Must NOT repeat the headline.
  • summary: Narrative interpretation of WHY the numbers matter. Reference metric pills by name ("as shown in the Gini metric above") instead of restating values.
  • metric_pills: The ONLY place for raw KPI values. Summary and findings must NOT restate pill values verbatim.
  • key_findings: Insights that go BEYOND what metric pills show — patterns, comparisons, anomalies, causality. Each finding must contain information not present in any pill label+value pair.
  • If a number already appears in metric_pills, other sections may reference it contextually ("the high Gini coefficient suggests...") but must NOT restate the exact value.
```

同時修改 Repair prompt（第 381-449 行）的 repair rules，加入：

```
- REDUNDANCY REPAIR: If the same numeric value appears verbatim in metric_pills AND (summary OR key_findings), rewrite the narrative reference to provide interpretation instead of repetition.
```

### 預期效果

同一個數字最多出現在 metric pill + 一處解釋性引用，不再有 4x 重複。

---

## 改進二：QA 維度 — 新增 information_density 評分

### 問題根因

現有 8 個 QA 維度（`QA_DIMENSION_KEYS`）不包含「資訊密度」或「冗餘度」檢測。completeness 只檢查「有沒有涵蓋 required dimensions」，不檢查「同一個 insight 是否被重複表達」。

**對應檔案：**
- `src/prompts/agentResponsePrompt.js` 第 19-28 行（`QA_DIMENSION_KEYS`）
- `src/prompts/agentResponsePrompt.js` 第 318-364 行（`buildQaReviewPrompt`）
- `src/services/agentResponsePresentationService.js`（QA weight 計算）

### 修改方向

**Step 1：新增維度定義**

在 `QA_DIMENSION_KEYS` 加入 `information_density`：

```javascript
const QA_DIMENSION_KEYS = Object.freeze([
  'correctness',
  'completeness',
  'evidence_alignment',
  'visualization_fit',
  'caveat_quality',
  'clarity',
  'methodology_transparency',
  'actionability',
  'information_density',  // 新增
]);
```

**Step 2：調整 weights**

從現有維度勻出權重（建議從 completeness 和 clarity 各勻一些）：

```
correctness:              0.33  (was 0.35)
completeness:             0.15  (was 0.18)
evidence_alignment:       0.13
visualization_fit:        0.08
caveat_quality:           0.08
clarity:                  0.04  (was 0.05)
methodology_transparency: 0.07
actionability:            0.06
information_density:      0.06  (新增)
```

**Step 3：在 QA review prompt 加入評分指引**

在 `buildQaReviewPrompt` 的 `## Review rules` 加入：

```
- information_density: Does each section add NEW information not present in other sections?
  Score 10: Every section provides unique value; no metric is repeated verbatim across sections.
  Score 7: Minor repetition (1-2 values restated) but overall concise.
  Score 4: Multiple sections restate the same numbers/conclusions.
  Score 1: Headline, summary, findings, and pills all contain the same information.
  Deduct 2 points for each metric value that appears verbatim in 3+ separate sections.
```

### 預期效果

冗餘的 brief 會在 QA 階段被扣分，觸發 repair 或 optimizer 來精簡。

---

## 改進三：Chart Recipe 配色系統 — 建立一致性語義色彩

### 問題根因

`chartRecipes_distribution.js` 的 recipe #13（seller_revenue_log_histogram）使用硬編碼的 `seg_colors` 陣列：

```python
seg_colors = ["#8b5cf6", "#8b5cf6", "#3b82f6", "#3b82f6", "#10b981", "#10b981", "#f59e0b", "#f59e0b", "#ef4444", "#ef4444"]
```

顏色按陣列 index 分配，不是按百分位語義分配。當 bin 數量變化時，顏色對應會錯位。其他 recipe 也各自硬編碼不同的配色，全局沒有統一的色彩語言。

**對應檔案：**
- `src/services/chartRecipes_distribution.js` 第 279 行
- 其他 `chartRecipes_*.js` 檔案中的 `colorMap` 定義

### 修改方向

**Step 1：建立全局色彩常數檔**

新建 `src/services/chartColorSystem.js`：

```javascript
// 語義色彩：每個顏色都有明確含義
export const SEMANTIC_COLORS = {
  // 百分位分段（從冷到暖 = 從低到高）
  percentile: {
    p0_p10:  '#94a3b8',  // slate-400  — 底部，不活躍
    p10_p25: '#8b5cf6',  // violet     — 低段
    p25_p50: '#3b82f6',  // blue       — 中低段
    p50_p75: '#10b981',  // emerald    — 中高段
    p75_p90: '#f59e0b',  // amber      — 高段
    p90_p100:'#ef4444',  // red        — 頂部
  },
  // 排行（金銀銅 + 一般）
  ranking: {
    first:   '#ef4444',
    second:  '#f59e0b',
    third:   '#f59e0b',
    default: '#3b82f6',
  },
  // 參考線
  reference: {
    median:  '#f59e0b',
    mean:    '#94a3b8',
    p90:     '#ef4444',
    target:  '#10b981',
  },
};

// 根據百分位值動態取色
export function getPercentileColor(value, percentiles) {
  if (value <= percentiles.p10) return SEMANTIC_COLORS.percentile.p0_p10;
  if (value <= percentiles.p25) return SEMANTIC_COLORS.percentile.p10_p25;
  if (value <= percentiles.p50) return SEMANTIC_COLORS.percentile.p25_p50;
  if (value <= percentiles.p75) return SEMANTIC_COLORS.percentile.p50_p75;
  if (value <= percentiles.p90) return SEMANTIC_COLORS.percentile.p75_p90;
  return SEMANTIC_COLORS.percentile.p90_p100;
}
```

**Step 2：修改 recipe #13 的 Python code**

改為按百分位值（而非 index）分配顏色：

```python
# 取代固定 seg_colors 陣列
def get_bin_color(bin_midpoint_log, percentile_logs):
    """根據 bin 中點對應的百分位段分配顏色"""
    if bin_midpoint_log <= percentile_logs['p10']:
        return '#94a3b8'
    elif bin_midpoint_log <= percentile_logs['p25']:
        return '#8b5cf6'
    elif bin_midpoint_log <= percentile_logs['p50']:
        return '#3b82f6'
    elif bin_midpoint_log <= percentile_logs['p75']:
        return '#10b981'
    elif bin_midpoint_log <= percentile_logs['p90']:
        return '#f59e0b'
    else:
        return '#ef4444'

percentile_logs = {k: np.log10(v) for k, v in percentile_values.items() if k in ['P10','P25','P50','P75','P90']}
for i in range(len(bins) - 1):
    mid = (bins[i] + bins[i+1]) / 2
    color_map[label] = get_bin_color(mid, percentile_logs)
```

**Step 3：統一所有 recipe 的 colorMap 使用方式**

逐個檢查 `chartRecipes_*.js`，把硬編碼的顏色替換為從 `SEMANTIC_COLORS` 引入。由於 recipe 的 Python code 在 sandbox 裡執行，考慮透過 `input_data` 參數注入色彩配置。

### 預期效果

顏色跟數據語義對應，不再因 bin 數量變化而錯位。全局一致的色彩語言。

---

## 改進四：Reference Line 標註 — 防止重疊和截斷

### 問題根因

Recipe #13 的 referenceLines 定義了 7 條百分位虛線（P10-P99），全部堆在圖表頂部。ChartRenderer 沒有做碰撞檢測，導致 P75/P90 被合併顯示、P95/P99 被截斷。

**對應檔案：**
- `src/services/chartRecipes_distribution.js` 第 300+ 行（referenceLines 定義）
- `src/components/chat/ChartRenderer.jsx`（渲染邏輯）

### 修改方向

**Step 1：減少預設 referenceLines 數量**

Recipe 中只保留最有意義的 3 條參考線（P25、P50、P75 或 P50、P90、mean），其餘放入 evidence table：

```python
referenceLines = [
    {"axis": "x", "value": resolve_bin_label(percentile_values["P25"]),
     "label": f"P25", "color": "#8b5cf6", "strokeDasharray": "6 4"},
    {"axis": "x", "value": resolve_bin_label(percentile_values["P50"]),
     "label": f"Median", "color": "#3b82f6", "strokeDasharray": "6 4"},
    {"axis": "x", "value": resolve_bin_label(percentile_values["P75"]),
     "label": f"P75", "color": "#10b981", "strokeDasharray": "6 4"},
]
# P10, P90, P95, P99 放入 metrics 或 evidence table，不畫在圖上
```

**Step 2：在 ChartRenderer 加入碰撞檢測**

如果兩條 referenceLines 的 x 或 y 值差距小於一個 bin 寬度，合併顯示或 offset label：

```javascript
// 在 ChartRenderer 渲染 referenceLines 前
function deconflictReferenceLines(lines, scale, minGapPx = 40) {
  const positioned = lines.map(line => ({
    ...line,
    pixelPos: scale(line.value),
  }));
  positioned.sort((a, b) => a.pixelPos - b.pixelPos);

  for (let i = 1; i < positioned.length; i++) {
    if (positioned[i].pixelPos - positioned[i-1].pixelPos < minGapPx) {
      // 合併：顯示為 "P75/P90" 或 offset label 位置
      positioned[i].labelOffset = -20; // 向上偏移
    }
  }
  return positioned;
}
```

### 預期效果

參考線不再重疊，標籤不被截斷，圖表可讀性大幅提升。

---

## 改進五：Optimizer 策略 — 從「重跑」改為「精準修補」

### 問題根因

`buildOptimizerInstruction()`（`analysisDomainEnrichment.js` 第 692-717 行）雖然寫了「Do NOT start from scratch」，但 optimizer 依然會跑完整的 `runAgentLoop`，拿到所有 tools，可以自由執行任何查詢。實際行為是 optimizer 傾向重新查詢類似數據，產出跟 primary 高度相似的敘述。

### 修改方向

**Step 1：限制 Optimizer 的 tool 呼叫範圍**

在 optimizer 的 `runAgentLoop` 調用中，根據 QA issues 過濾可用 tools：

```javascript
// 在 DecisionSupportView 的 optimizer 調用處
const optimizerToolContext = {
  ...toolContext,
  // 如果 QA issues 不涉及 "missing data" 或 "incorrect query"
  // 就禁用 query_sap_data，只允許 narrative 修補
  disabledTools: qaIssuesAreNarrativeOnly(primaryQa)
    ? ['query_sap_data', 'generate_chart']
    : [],
};
```

**Step 2：強化 Optimizer Instruction 的約束**

在 `buildOptimizerInstruction` 中加入更嚴格的指令：

```
== ANTI-DUPLICATION RULES ==
8. Your output will be compared against A's output by a judge. If you produce a brief that is >70% similar in content to A's brief, you will be scored LOWER than A. Differentiate by:
   - Adding NEW analysis angles A missed (e.g., time trends, category breakdown, cohort analysis)
   - Providing deeper interpretation of A's existing numbers
   - Fixing specific QA issues WITHOUT restating A's correct findings
9. If A's tool calls already returned the correct data, do NOT re-query. Use A's evidence directly.
10. Your key_findings must contain at least 2 findings NOT present in A's findings.
```

**Step 3：在 Judge prompt 加入相似度懲罰**

修改 `buildAgentCandidateJudgePrompt`（第 452-491 行）：

```
- If the optimizer's brief is substantively identical to the primary's brief (same numbers, same structure, similar phrasing), prefer the primary unless the optimizer fixed a specific blocker.
- "More words" ≠ "better answer". A concise primary that covers all dimensions should beat a verbose optimizer that restates the same points.
```

### 預期效果

Optimizer 聚焦於修補 QA 扣分項，而不是重新寫一份幾乎相同的 brief。

---

## 改進六：Answer Contract — 洞察深度的自動偵測

### 問題根因

`buildAgentAnswerContractPrompt()` 推斷出的 `required_dimensions` 是表面層級的（如 "revenue", "sellers", "quantiles"），不包含「因果分析」、「時間趨勢」、「交叉維度」等高階分析方向。Agent 拿到 contract 後只覆蓋字面維度，不主動探索更深的洞察。

**對應檔案：** `src/prompts/agentResponsePrompt.js` 第 126-166 行

### 修改方向

在 Answer Contract 的 output schema 中新增 `suggested_deep_dives` 欄位：

```json
{
  "task_type": "...",
  "required_dimensions": ["..."],
  "required_outputs": ["..."],
  "suggested_deep_dives": [
    "seller_revenue × product_category (交叉分析：頂部賣家集中在哪些品類？)",
    "revenue_distribution × time (趨勢分析：不平等程度隨時間如何變化？)",
    "low_revenue_sellers × tenure (成因分析：低收入賣家是新進的還是長期不活躍？)"
  ],
  "audience_language": "...",
  "brevity": "..."
}
```

在 Rules 中加入：

```
- suggested_deep_dives: 2-3 analysis angles that would deepen the answer beyond surface-level descriptive statistics. Each should combine two dimensions or introduce a causal/temporal lens. Format: "dimension_a × dimension_b (purpose)". These are suggestions for the agent, not requirements — the agent should attempt at least one if data supports it.
```

然後在 `buildDirectAnalysisAgentPrompt` 或 agent system prompt 中，注入這些 deep dive 建議，讓 agent 在完成基本分析後嘗試探索。

### 預期效果

Agent 的洞察從「描述數字」升級為「解釋數字」，回答不再停留在教科書層級。

---

## 改進七：Brief Card UI — 分層資訊呈現

### 問題根因

`AgentBriefCard.jsx` 把所有內容在一個平面上展示：headline → summary → metric pills → charts → tables → findings → implications → caveats → next steps。使用者被迫從頭到尾線性閱讀，沒有資訊層次感。

**對應檔案：** `src/components/chat/AgentBriefCard.jsx`

### 修改方向

**Step 1：將 Brief Card 分為「核心結論層」和「展開分析層」**

```jsx
// 核心結論層（始終顯示）
<div className="core-layer">
  <Headline />
  <ExecutiveSummary />
  <MetricPills limit={4} />  {/* 最多 4 個，其餘折疊 */}
  <PrimaryChart />  {/* 只顯示第一張圖 */}
</div>

// 展開分析層（預設折疊，點擊展開）
<Collapsible label="Detailed Analysis">
  <AdditionalMetricPills />
  <AdditionalCharts />
  <EvidenceTables />
  <Section key="findings" />
  <Section key="implications" />
  <Section key="caveats" />
  <Section key="next_steps" />
  <MethodologyNote />
</Collapsible>
```

**Step 2：Metric Pills 數量控制**

在 synthesis prompt 中加入規則：

```
- metric_pills: Maximum 4 pills for brevity="short", maximum 6 for brevity="analysis".
  Pick the 4-6 most decision-relevant metrics. Move supporting metrics to evidence tables.
  NEVER duplicate a metric that already appears as a chart reference line or table column.
```

### 預期效果

使用者 3 秒內看到核心結論，想深入再展開。資訊負載降低 50%。

---

## 改進八：Deterministic QA — 新增重複檢測

### 問題根因

`computeDeterministicQa()` 做了 magnitude mismatch、contradictory claims、invented tool failure 等檢測，但沒有檢測「brief 內部的資訊重複」。

**對應檔案：** `src/services/agentResponsePresentationService.js`

### 修改方向

在 `computeDeterministicQa()` 中新增 `detectContentRedundancy()` 檢測：

```javascript
function detectContentRedundancy(brief) {
  const warnings = [];
  const pillValues = (brief.metric_pills || []).map(p => p.value);

  // 檢查 summary 中是否逐字重複了 pill values
  const summary = brief.summary || '';
  const repeatCount = pillValues.filter(v =>
    summary.includes(v) && v.length > 3  // 忽略太短的值
  ).length;

  if (repeatCount >= 3) {
    warnings.push({
      type: 'content_redundancy',
      severity: 'warning',
      message: `Summary restates ${repeatCount} of ${pillValues.length} metric pill values verbatim. Consider referencing them contextually instead.`,
    });
  }

  // 檢查 findings 是否跟 summary 高度重疊
  const findings = (brief.key_findings || []).join(' ');
  const overlapTokens = countSharedNgrams(summary, findings, 4); // 4-gram overlap
  if (overlapTokens > 0.5) { // 超過 50% 重疊
    warnings.push({
      type: 'content_redundancy',
      severity: 'warning',
      message: 'key_findings share >50% content with summary. Findings should provide additional analysis beyond the summary.',
    });
  }

  return warnings;
}
```

### 預期效果

重複的 brief 在 deterministic QA 階段就被標記，不用等 LLM review。加速反饋循環。

---

## 改進九：Caveats 策略 — 消除自相矛盾的不信任感

### 問題根因

在你展示的例子中，caveat 寫了「Analysis uses pre-computed chart metrics rather than live SQL queries, which may limit granularity」。但圖表本身就是系統從 `order_items` 資料表跑 Python 產出的——這個 caveat 在說「我不信任我自己產出的數據」，對使用者來說是自相矛盾的。

根因在 `buildAgentBriefSynthesisPrompt` 的規則：

> If the evidence is partial or proxy-based, add a caveat.

Agent 把「來自 recipe 的 pre-computed artifact」誤判為「proxy-based evidence」。

### 修改方向

**Step 1：在 tool evidence summary 中區分資料來源**

修改 `summarizeToolCalls()`，為 `generate_chart` 呼叫加入來源標記：

```javascript
if (toolCall.name === 'generate_chart') {
  base.push('source=deterministic_recipe (computed from raw dataset, not pre-cached)');
}
```

**Step 2：在 synthesis prompt 中加入規則**

```
- CAVEATS — SOURCE TRUST:
  • Evidence from generate_chart recipes is computed from raw dataset tables at query time. This is NOT "pre-computed" or "cached" data. Do NOT add caveats questioning the reliability of recipe-generated artifacts.
  • Only add data-source caveats when: (a) using proxy metrics, (b) SQL returned 0 rows, (c) data has known quality issues, or (d) the dataset has limited time coverage.
  • Self-contradictory caveats (questioning data you yourself generated) MUST be avoided — they erode user trust.
```

### 預期效果

Caveats 只出現在真正有不確定性的地方，不再出現「我不信任自己」的矛盾表述。

---

## 改進十：Execution Trace UI — 對使用者隱藏實作細節

### 問題根因

使用者可以看到 "Primary Agent · openai · gpt-5.4-thinking"、"Optimizer Agent · anthropic · claude-opus-4-6"、"QA score 7.3/8.0" 等內部資訊。這些對技術人員有用，但對商業使用者來說是噪音，且暴露了系統架構。

### 修改方向

**Step 1：預設隱藏技術 metadata**

在 AgentBriefCard 中，把 provider/model attribution 和 QA score 移到 developer/debug panel（需要點擊才能看到），不在預設視圖中顯示。

**Step 2：把 Agent label 改為功能描述**

```javascript
// Before
candidateId: 'primary', label: 'Primary Agent'
candidateId: 'secondary', label: 'Optimizer Agent'

// After (user-facing)
candidateId: 'primary', label: 'Analysis'
candidateId: 'secondary', label: 'Enhanced Analysis'
// 內部仍保留 provider/model 資訊用於 debug
```

### 預期效果

使用者看到的是乾淨的分析報告，不是 AI agent 的內部運作日誌。

---

## 優先級排序

| 優先級 | 改進項 | 預期影響 | 工作量 |
|--------|--------|----------|--------|
| P0 | 改進一（Prompt 去重約束） | 立即改善重複問題 | 小（改 prompt 文字） |
| P0 | 改進九（Caveats 自相矛盾） | 立即改善信任感 | 小（改 prompt 文字 + summarizeToolCalls） |
| P1 | 改進四（Reference Line 碰撞） | 圖表可讀性大幅提升 | 中（改 recipe + ChartRenderer） |
| P1 | 改進三（配色系統） | 視覺一致性 | 中（新建 module + 改所有 recipe） |
| P1 | 改進七（Brief Card 分層） | 使用體驗提升 | 中（改 JSX component） |
| P2 | 改進二（QA 新增維度） | 長期品質保障 | 中（改 prompt + weight + validation） |
| P2 | 改進八（Deterministic 重複檢測） | 加速 QA 反饋 | 中（新增檢測函數） |
| P2 | 改進五（Optimizer 約束） | 減少無效 optimizer 調用 | 中（改 instruction + tool filtering） |
| P3 | 改進六（Deep Dive 建議） | 洞察深度提升 | 中（改 contract prompt + agent prompt） |
| P3 | 改進十（隱藏技術細節） | 商業使用者體驗 | 小（改 UI component） |

---

## 備註

所有改進都向後相容，可以逐項實施。建議從 P0 開始，因為只需修改 prompt 文字就能立竿見影。P1 改進圖表視覺，P2 加固 QA 機制，P3 提升洞察深度。

每項改進實施後，應在 `evaluation/` 目錄下加入對應的回歸測試 case，確保 QA 分數和 brief 品質不因後續變更退化。
