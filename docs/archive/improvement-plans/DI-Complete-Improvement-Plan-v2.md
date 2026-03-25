# Decision Intelligence — 完整改進方案 v2

> 整合 Agent Brief 品質分析 + Console Log 診斷的所有發現，按優先級排列。
> 每項標注：問題根因 → 對應檔案 → 具體修改 → 預期效果。

---

## 第一部分：從 Console Log 發現的基礎設施問題

這些問題在 agent 品質之前，影響的是系統能不能正常運作。

---

### 🔴 Issue #1：CORS 配錯導致 Streaming 全部失敗

**嚴重程度：** P0-Critical — 每次對話額外浪費一次 LLM round trip

**Log 證據：**
```
Access-Control-Allow-Origin header has a value 'http://localhost:5174'
that is not equal to the supplied origin [http://localhost:5173]
```
```
[agentLoop] Stream call failed, trying non-stream fallback: Failed to fetch
```

**根因分析：**

`supabase/functions/ai-proxy/index.ts` 第 36-58 行的 CORS 邏輯本身是正確的——`ALLOWED_ORIGINS` 包含了 5173 和 5174，且有 localhost regex fallback。問題出在 **已部署的 Edge Function 版本與本地原始碼不一致**。已部署版本的 `FRONTEND_ORIGIN` 環境變數被設為 `http://localhost:5174`，而且部署版可能缺少 `ALLOWED_ORIGINS` 動態匹配邏輯（或者 `buildCorsHeaders` 的 `requestOrigin` 參數在 streaming response 路徑上沒有正確傳遞）。

實際結果：所有 `openai_chat_tools_stream` 呼叫先失敗，然後 fallback 到 `openai_chat_tools`（非 streaming）。每輪 agent loop 中的每次 LLM 呼叫都多花一次 round trip，且失去了 streaming 的即時反饋。

**修改方向：**

A. **立即修復（部署層）：** 重新 deploy ai-proxy Edge Function，確保程式碼與本地原始碼一致。同時檢查 Supabase Dashboard 中 `FRONTEND_ORIGIN` 環境變數的值。

B. **防禦性修復（程式碼層）：** 在 `aiProxyService.js` 的 streaming 路徑加入 preflight 檢測，如果 CORS 失敗則直接跳到 non-stream，不等網路 timeout：

```javascript
// 在 invokeAiProxyStream 開頭加入
const streamSupported = await checkStreamCorsSupport(); // 快速 OPTIONS preflight
if (!streamSupported) {
  console.warn('[aiProxy] Stream CORS check failed, using non-stream directly');
  return invokeAiProxyNonStream(payload);
}
```

C. **長期修復：** 考慮將 streaming 的 CORS 處理統一到 Edge Function 入口處（第 3592 行的 `buildCorsHeaders(req.headers.get('origin'))`），確保所有 streaming handler 都繼承同一個 `cors` 物件，而不是在各 handler 內部獨立設定。

**預期效果：** 恢復 streaming → 使用者看到即時打字效果；省掉每次對話 2-4 次無效 round trip。

---

### 🔴 Issue #2：summarizeToolCalls 缺少 Artifact Metrics → 觸發 False Positive Blocker

**嚴重程度：** P0-Critical — 觸發不必要的 repair cycle，浪費 37 秒

**Log 證據：**
```
Cross-review score: 2.0
blockers: ["The brief cites a specific 90th percentile revenue of 'R$9,525.32',
which is not present in the provided tool evidence or artifacts."]
```

但 P90=R$9,525.32 確實由 recipe #13 的 Python code 計算得出。

**根因分析：**

`agentResponsePrompt.js` 第 74-123 行的 `summarizeToolCalls()` 對 `generate_chart` 的結果只摘要了 `analysis_cards=Seller Revenue Distribution (Log Scale)` 這行標題。Cross-reviewer（Gemini）看不到 artifact 裡的 metrics 值（P90、Gini 等），所以判定 brief 引用的數字「無來源」，打了 blocker。

這觸發了完整的 repair cycle：repair synthesis 17s → re-self-review 5s → re-cross-review 15s = 37 秒額外延遲。

**對應檔案：** `src/prompts/agentResponsePrompt.js` 第 74-123 行

**修改方向：**

在 `summarizeToolCalls()` 的 analysisCards 處理中，加入 metrics 和 referenceLines 的摘要：

```javascript
if (Array.isArray(analysisCards) && analysisCards.length > 0) {
  base.push(`analysis_cards=${analysisCards.map(card => card?.title || card?.analysisType).filter(Boolean).join(', ')}`);

  // 新增：把 artifact 的 metrics 注入 evidence summary
  for (const card of analysisCards) {
    if (card?.metrics && typeof card.metrics === 'object') {
      const metricsStr = Object.entries(card.metrics)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      base.push(`artifact_metrics={${metricsStr}}`);
    }
    // 如果有 percentile referenceLines，也摘要進來
    const refs = card?.charts?.[0]?.referenceLines;
    if (Array.isArray(refs) && refs.length > 0) {
      const refStr = refs.map(r => `${r.label || ''}=${r.value}`).join(', ');
      base.push(`artifact_reference_lines={${refStr}}`);
    }
  }
}
```

**預期效果：** Cross-reviewer 能看到 artifact 產出的數值，不再誤判為「無來源」。預計減少 50%+ 的 false positive blocker，省掉對應的 repair cycle 時間。

---

### 🟡 Issue #3：Gemini Cross-Review 回傳不完整的 dimension_scores

**嚴重程度：** P1 — QA 分數不可靠

**Log 證據：**
```
[validateAgentQaReview] malformed dimension_scores:
{"correctness":2,"evidence_alignment":2,"information_density":1,
"methodology_transparency":10,"visualization_fit":10}
```
缺少 `completeness`、`caveat_quality`、`clarity`、`actionability` 四個維度。

**根因分析：**

QA review prompt（`buildQaReviewPrompt`）的 output schema 只列出了欄位名和型別，沒有明確強調「ALL dimensions are required」。Gemini 傾向省略它認為「不重要」或「看不出來」的維度。而 `validateAgentQaReview`（第 614 行）對 malformed scores 做了 graceful fallback — 接受了不完整的分數。

問題是：self-review 有 9 個維度的完整加權平均（8.5 分），cross-review 只有 5 個維度（2.0 分），兩個分數的計算基準不同，無法公平比較。

**對應檔案：**
- `src/prompts/agentResponsePrompt.js` 第 318-364 行（`buildQaReviewPrompt`）
- `src/services/agentResponsePresentationService.js`（validation logic）

**修改方向：**

A. **Prompt 強化：** 在 `buildQaReviewPrompt` 的 `## Review rules` 末尾加入：

```
- MANDATORY: You MUST score ALL 9 dimensions in dimension_scores. Do not omit any dimension.
  If you cannot assess a dimension, score it 5.0 (neutral) rather than omitting it.
  Missing dimensions will cause a schema validation failure.
```

B. **Validation 硬化：** 在 `validateAgentQaReview` 中，對缺失維度做 imputation 而非 skip：

```javascript
// 用 self-review 分數或 neutral 5.0 填充缺失維度
const REQUIRED_DIMENSIONS = ['correctness', 'completeness', 'evidence_alignment',
  'visualization_fit', 'caveat_quality', 'clarity', 'methodology_transparency',
  'actionability', 'information_density'];

for (const dim of REQUIRED_DIMENSIONS) {
  if (typeof parsed.dimension_scores[dim] !== 'number') {
    parsed.dimension_scores[dim] = selfReviewScores?.[dim] ?? 5.0;
    // 標記為 imputed，供 debug 使用
    parsed._imputedDimensions = parsed._imputedDimensions || [];
    parsed._imputedDimensions.push(dim);
  }
}
```

**預期效果：** Self-review 和 cross-review 的分數在相同基準上計算，judge decision 更可靠。

---

### 🟡 Issue #4：`suggested_deep_dives` 推斷出來但沒注入 Agent Prompt

**嚴重程度：** P1 — 深度分析能力形同虛設

**Log 證據：**
```
Answer contract: {"suggested_deep_dives":["seller revenue × quantiles (distribution a..."]}
```
但 agent 只呼叫了 `generate_chart("seller_revenue_log_histogram")` 然後結束。

**根因分析：**

`suggested_deep_dives` 在 `buildAgentAnswerContractPrompt()` 中被 LLM 推斷出來，存入了 `answerContract` 物件。但 `buildDirectAnalysisAgentPrompt()`（`directAnalysisService.js` 第 61-70 行）完全不讀 `answerContract`——它只接收 `query` 字串，產出一個 5 行的通用指令。Agent 永遠不知道有 deep dive 建議。

**對應檔案：**
- `src/services/directAnalysisService.js` 第 61-70 行
- `src/views/DecisionSupportView/index.jsx` 第 2473 行附近（agent 調用處）

**修改方向：**

A. **修改函數簽名：** 讓 `buildDirectAnalysisAgentPrompt` 接收 `answerContract`：

```javascript
export function buildDirectAnalysisAgentPrompt(query, answerContract = null) {
  const normalized = normalizeQuery(query);
  const deepDives = Array.isArray(answerContract?.suggested_deep_dives)
    ? answerContract.suggested_deep_dives
    : [];

  const parts = [
    'Run a direct business data analysis for the following request.',
    `User request: "${normalized}"`,
    '',
    'Choose the best tool per the Tool Selection Rules in your system prompt.',
    'Return structured analysis with metrics, charts, tables, and concise findings.',
  ];

  if (deepDives.length > 0) {
    parts.push('');
    parts.push('## Suggested Deep Dives (attempt at least one if data supports it)');
    deepDives.forEach((dd, i) => parts.push(`${i + 1}. ${dd}`));
    parts.push('');
    parts.push('After completing the primary analysis, run one additional query or analysis to explore a suggested deep dive. This adds depth beyond surface-level descriptive statistics.');
  }

  return parts.join('\n');
}
```

B. **在調用處傳入 answerContract：**

在 `DecisionSupportView` 中，找到 `buildDirectAnalysisAgentPrompt(query)` 的調用（約第 2473 和 2516 行），改為 `buildDirectAnalysisAgentPrompt(query, answerContract)`。

**預期效果：** Agent 會嘗試至少一個交叉維度分析，洞察從「描述數字」升級為「解釋數字」。

---

## 第二部分：Brief Synthesis 品質問題

這些問題影響的是最終呈現給使用者的內容品質。

---

### 🔴 Issue #5：Brief 各欄位之間的資訊重複

**嚴重程度：** P0 — 使用者最直接感受到的問題

**現象：** 同一組數字（Gini 0.792、3,095 sellers、R$821 median、13.1% top 10 share）在 headline、summary、metric pills、key findings 中出現 3-4 次。

**根因分析：**

你已經在 deterministic QA 中實作了 `information_density` 扣分（第 1368-1419 行），也加了 n-gram overlap 檢測。但問題是：

1. **扣分不夠狠：** 4 個 pill 值全部在 summary 中重複，只扣 3 分（`information_density` 從 10 降到 7）。加上 information_density 的 weight 只有 0.06，對總分影響僅 0.18 分。QA 依然輕鬆過 8.0 門檻。

2. **Synthesis prompt 的去重約束不夠明確：** `buildAgentBriefSynthesisPrompt` 第 235 行有一條相關規則：`If charts or analysis cards already exist, do not repeat every KPI already visible there`。但這只說了不要重複 chart 裡的 KPI，沒有說不要在 summary 和 findings 之間重複。

**對應檔案：**
- `src/prompts/agentResponsePrompt.js` 第 228-251 行（synthesis rules）
- `src/services/agentResponsePresentationService.js` 第 1368-1419 行（redundancy detection）

**修改方向：**

A. **在 synthesis prompt 加入明確的欄位分工規則：**

在第 248 行（`## Rules` 區段）加入：

```
- FIELD DEDUPLICATION (MANDATORY — violations will trigger QA failure):
  • headline: ONE sentence, the single most important conclusion. Contains at most 1 number.
  • executive_summary: ONE sentence with the key decision implication. Must NOT repeat headline phrasing.
  • summary: Narrative interpretation of WHY the numbers matter and what patterns they reveal.
    Reference metrics contextually ("the high inequality reflected in the Gini coefficient suggests...")
    rather than restating values ("The Gini coefficient is 0.792").
  • metric_pills: The SOLE authoritative location for raw KPI values. Other sections must NOT
    restate pill values verbatim. If a pill shows "Gini Coefficient: 0.792", the summary should
    interpret it, not repeat "0.792".
  • key_findings: Insights that go BEYOND metric pills — patterns, comparisons, anomalies,
    causality, cross-dimensional observations. Each finding must contain analysis not derivable
    from reading the pills alone.
  • A numeric value from metric_pills may appear in at most ONE other section, and only with
    added interpretive context (e.g., "far above the 0.5 threshold indicating moderate inequality").
```

B. **提高 information_density 的懲罰力度：**

在 `agentResponsePresentationService.js` 第 1378-1403 行，改為更激進的扣分：

```javascript
if (pillsInSummary >= 3) {
  // 改為 blocker 而非 warning
  blockers.push(`Summary restates ${pillsInSummary} of ${pillValues.length} metric pill values verbatim — must interpret, not restate.`);
  dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 5); // was -3
}
if (pillsInFindings >= 3) {
  blockers.push(`Key findings restate ${pillsInFindings} of ${pillValues.length} metric pill values — findings must add new analysis.`);
  dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 5); // was -3
}
```

C. **提高 information_density 的 weight：**

```javascript
// agentResponsePresentationService.js 第 104-113 行
const QA_DIMENSION_WEIGHTS = Object.freeze({
  correctness: 0.30,              // was 0.33
  completeness: 0.15,
  evidence_alignment: 0.13,
  visualization_fit: 0.08,
  caveat_quality: 0.07,           // was 0.08
  clarity: 0.04,
  methodology_transparency: 0.07,
  actionability: 0.06,
  information_density: 0.10,      // was 0.06 — 提高到能影響是否過門檻
});
```

**預期效果：** 嚴重重複直接觸發 blocker → repair cycle，且 repair prompt 會收到明確的去重指令。weight 提高後，information_density = 4 會使總分降低 0.6 分，更容易觸發 escalation。

---

### 🔴 Issue #6：Caveats 自相矛盾 — 「系統不信任自己產出的數據」

**嚴重程度：** P0 — 直接損害使用者對系統的信任

**現象：**
- 上一版：`"Analysis uses pre-computed chart metrics rather than live SQL queries"`
- 這一版：`"The histogram data query returned zero rows, so the chart is a conceptual representation based on narrative data"`

兩個版本都在質疑系統自己產出的圖表。

**根因分析：**

Recipe #13 透過 `generate_chart` 執行 Python code，直接從 `order_items` 表計算百分位和直方圖數據。但在 `summarizeToolCalls` 中，這個 tool call 的 `rowCount` 可能是 undefined（因為 recipe 不走 SQL query 路徑，沒有 rowCount 欄位）。Synthesis LLM 看到 `rowCount` 缺失或為 0，就加了一條「no SQL data available」的 caveat。

**對應檔案：**
- `src/prompts/agentResponsePrompt.js` 第 74-123 行（`summarizeToolCalls`）
- `src/prompts/agentResponsePrompt.js` 第 238-241 行（synthesis caveat rules）

**修改方向：**

A. **在 `summarizeToolCalls` 中標記 generate_chart 的資料來源：**

```javascript
if (toolCall?.name === 'generate_chart') {
  base.push('source_type=deterministic_recipe');
  base.push('data_origin=computed_from_raw_dataset_tables_at_query_time');
  // 明確標記：這不是 pre-computed 或 cached 數據
}
```

B. **在 synthesis prompt 的 caveat rules 中加入：**

```
- CAVEATS — SOURCE TRUST HIERARCHY:
  1. generate_chart (deterministic recipe): Computed from raw dataset tables at query time.
     This is AUTHORITATIVE evidence. Do NOT add caveats questioning recipe-generated data
     reliability, accuracy, or completeness. Do NOT describe recipe outputs as "pre-computed",
     "conceptual", "narrative-based", or "cached".
  2. query_sap_data (SQL query): Direct database evidence. Add caveats only for 0-row results
     or known data quality issues.
  3. run_python_analysis: Custom analysis. Add methodology caveats if assumptions are made.
  • Self-contradictory caveats (questioning data your own tools generated) MUST be avoided.
    They erode user trust and will be flagged as a QA blocker.
```

C. **在 deterministic QA 中檢測自相矛盾的 caveat：**

```javascript
// 檢測 caveat 是否質疑 generate_chart 的結果
const chartToolSucceeded = toolCalls.some(tc =>
  tc.name === 'generate_chart' && tc.success !== false
);
if (chartToolSucceeded) {
  const suspiciousCaveats = (brief?.caveats || []).filter(c =>
    /pre-computed|conceptual|narrative.based|chart metrics|zero rows.*chart/i.test(c)
  );
  if (suspiciousCaveats.length > 0) {
    blockers.push('Caveat contradicts tool evidence: a successful generate_chart recipe is authoritative, not "conceptual" or "pre-computed".');
    repairInstructions.push('Remove caveats that question the reliability of successfully executed chart recipes.');
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 5);
  }
}
```

**預期效果：** 消除「我不信任自己」的矛盾表述。Caveats 只出現在真正有不確定性的地方。

---

### 🟡 Issue #7：Repair 後重複問題依然未解決

**嚴重程度：** P1 — repair cycle 浪費時間但不改善品質

**Log 證據：**

第一輪 self-review 的 information_density = 6/10，repair 後 re-self-review 的 information_density = 4/10。**Repair 反而讓重複更嚴重了。**

**根因分析：**

`buildAgentQaRepairSynthesisPrompt`（第 381-449 行）的 repair rules 沒有包含去重指令。第 435 行只說了 `Fix missing dimensions, contradictions, caveats, evidence-table problems, chart-fit framing, and duplicate text`——「duplicate text」只是一個籠統的提及，沒有具體到「不要在 summary 中重複 pill values」。

而且 repair instructions 是從 deterministic QA 傳入的（第 197 行 `repairInstructions`），但 QA 產出的 repair 指令是：`Reference metric pill values contextually in the summary instead of restating them verbatim`——這對 LLM 來說太抽象了，它不知道具體要改哪些句子。

**對應檔案：** `src/prompts/agentResponsePrompt.js` 第 433-449 行（repair rules）

**修改方向：**

在 repair prompt 的 `## Repair rules` 中加入具體的去重操作指引：

```
- REDUNDANCY REPAIR (high priority — this is a QA blocker):
  When repair instructions mention "verbatim restatement" or "information density":
  1. Identify which metric pill values appear in the summary or key_findings.
  2. For each repeated value in summary: replace "The Gini coefficient is 0.792" with
     interpretive phrasing like "The Gini coefficient indicates severe inequality, comparable
     to the most unequal national economies."
  3. For each repeated value in key_findings: replace the finding with a DERIVED insight.
     Instead of "Gini coefficient of 0.792 reflects inequality", write
     "The bottom 50% of sellers collectively earn less than the top 10 sellers individually."
  4. After repair, NO metric pill value should appear verbatim in more than one other section.
```

**預期效果：** Repair LLM 收到具體的操作步驟而非抽象指令，去重效果大幅提升。

---

## 第三部分：圖表視覺品質

---

### 🟡 Issue #8：配色無語義邏輯

**嚴重程度：** P1

**現象：** Recipe #13 的直方圖使用紫→藍→綠→橘四色，按 array index 分配，與百分位區間無固定對應。

**對應檔案：** `src/services/chartRecipes_distribution.js` 第 279 行

**修改方向：**

改為按百分位值（而非 index）分配顏色。建立全局 `chartColorSystem.js`，定義語義色彩常數（percentile 分段、ranking 排行、reference line），所有 recipe 統一引用。

具體方案見前一份文件「改進三」的完整 code。

---

### 🟡 Issue #9：Reference Lines 過多且重疊

**嚴重程度：** P1

**現象：** 7 條百分位虛線堆在圖表頂部，P75/P90 被合併顯示，P95/P99 被截斷。

**修改方向：**

A. Recipe 中預設只保留 3 條（P25、P50、P75），其餘放入 evidence table。
B. ChartRenderer 加入碰撞檢測：兩條 referenceLines 的像素距離 < 40px 時，合併或 offset label。

具體方案見前一份文件「改進四」的完整 code。

---

## 第四部分：架構層改進

---

### 🟡 Issue #10：Optimizer 策略 — 限制無效重跑

**嚴重程度：** P2

**現象：** Optimizer 拿到所有 tools，傾向重新查詢相似數據，產出與 Primary 高度相似的 brief。

**修改方向：**

A. 根據 QA issues 類型限制 Optimizer 的 tool 可用範圍。如果 issues 只涉及 narrative 品質（去重、caveat），禁用 `query_sap_data` 和 `generate_chart`。
B. 在 `buildOptimizerInstruction` 加入反重複約束和差異化要求。
C. 在 Judge prompt 加入相似度懲罰。

具體方案見前一份文件「改進五」。

---

### 🟡 Issue #11：Brief Card UI — 分層資訊呈現

**嚴重程度：** P2

**現象：** 所有內容在一個平面線性展示，沒有資訊層次。

**修改方向：**

將 `AgentBriefCard.jsx` 分為「核心結論層」（始終顯示：headline + summary + 4 pills + primary chart）和「展開分析層」（預設折疊：additional pills/charts + evidence + findings/implications/caveats/next steps）。

---

### 🟢 Issue #12：隱藏技術實作細節

**嚴重程度：** P3

**現象：** 使用者看到 "Primary Agent · openai · gpt-5.4-thinking"、QA score 等內部資訊。

**修改方向：** Agent label 改為功能描述（"Analysis" / "Enhanced Analysis"），provider/model/QA score 移到 debug panel。

---

## 第五部分：Pipeline 效能優化

---

### 🟡 Issue #13：Sequential API Calls 的延遲累積

**嚴重程度：** P2

**從 Log 觀察到的時間線：**

```
Contract inference:   6s
Agent LLM call:      2s (stream fail) + 2s (fallback) = 4s
Tool execution:      ~1s (generate_chart)
Agent LLM call #2:   4s (stream fail) + 4s (fallback) = 8s
Brief synthesis:     20s
Self-review:         6s
Cross-review:        16s
─── 首輪判定 ──────────────────────
                     共 ~61s

Repair synthesis:    17s  ← 因 false positive blocker 觸發
Re-self-review:      5s
Re-cross-review:     15s
─── 修復後重新判定 ─────────────────
                     共 ~98s
```

**快速能省的時間：**

| 修復項 | 預計節省 |
|--------|----------|
| 修 CORS → 恢復 streaming（省掉每次 fallback） | -8s |
| 修 summarizeToolCalls → 消除 false positive repair | -37s |
| Self-review + Cross-review 並行 | -6s（重疊執行） |
| **合計** | **-51s（從 98s 降至 ~47s）** |

**修改方向：**

A. 修 CORS + summarizeToolCalls（已在上面 Issue #1 和 #2 描述）。

B. **Self-review 和 Cross-review 並行執行：**

目前 `buildAgentPresentationPayload` 中，self-review 和 cross-review 是串行的（先 self-review，再判斷是否需要 cross-review）。如果 `forceCrossReview = true` 或 complexity 是 `complex`，可以直接並行發出兩個 review：

```javascript
// 目前（串行）
const selfReview = await requestQaReview('self', ...);
const shouldCross = shouldEscalateQa({ selfReview, ... });
const crossReview = shouldCross ? await requestQaReview('cross', ...) : null;

// 改為（並行，如果已知需要 cross-review）
if (forceCrossReview || complexityTier === 'complex') {
  const [selfReview, crossReview] = await Promise.all([
    requestQaReview('self', ...),
    requestQaReview('cross', ...),
  ]);
} else {
  const selfReview = await requestQaReview('self', ...);
  // ...
}
```

---

## 優先級總覽

| 等級 | Issue # | 標題 | 預期影響 | 工作量 |
|------|---------|------|----------|--------|
| **P0** | #1 | CORS 修復 → 恢復 streaming | 省 8s/次 + UX 即時反饋 | 極小（重新部署） |
| **P0** | #2 | summarizeToolCalls 加 artifact metrics | 消除 false positive → 省 37s | 小（加 10 行） |
| **P0** | #5 | Brief 去重：prompt + QA 強化 | 解決最核心的品質問題 | 中（改 prompt + weights） |
| **P0** | #6 | Caveat 自相矛盾修復 | 恢復使用者信任 | 小（改 prompt + 加檢測） |
| **P1** | #3 | Gemini cross-review 維度缺失 | QA 分數可靠性 | 小（改 prompt + imputation） |
| **P1** | #4 | deep_dives 注入 agent prompt | 洞察深度提升 | 小（改函數簽名 + 傳參） |
| **P1** | #7 | Repair prompt 加具體去重步驟 | repair cycle 效果提升 | 小（改 prompt） |
| **P1** | #8 | 配色語義化 | 圖表可讀性 | 中（新建 module + 改 recipe） |
| **P1** | #9 | Reference line 碰撞檢測 | 圖表可讀性 | 中（改 recipe + renderer） |
| **P2** | #10 | Optimizer tool 限制 | 減少無效重跑 | 中 |
| **P2** | #11 | Brief Card 分層 | 資訊層次感 | 中（改 JSX） |
| **P2** | #13 | Review 並行化 | 省 6s/次 | 小 |
| **P3** | #12 | 隱藏技術細節 | 商業使用者體驗 | 小（改 UI） |

---

## 建議實施順序

**第一批（1-2 天，立竿見影）：**
- Issue #1：重新部署 ai-proxy Edge Function 修 CORS
- Issue #2：`summarizeToolCalls` 加 artifact metrics（10 行代碼）
- Issue #5A：synthesis prompt 加去重規則（改 prompt 文字）
- Issue #6：synthesis prompt 加 source trust 規則 + deterministic QA 加矛盾 caveat 檢測

**第二批（3-5 天，品質提升）：**
- Issue #5B+C：information_density weight 提高 + 扣分力度加大
- Issue #7：repair prompt 加具體去重步驟
- Issue #3：cross-review prompt 強化 + dimension imputation
- Issue #4：deep_dives 注入 agent prompt

**第三批（1-2 週，視覺和架構）：**
- Issue #8+#9：配色系統 + reference line 碰撞檢測
- Issue #10+#11：Optimizer 限制 + Brief Card 分層
- Issue #12+#13：隱藏技術細節 + review 並行化
