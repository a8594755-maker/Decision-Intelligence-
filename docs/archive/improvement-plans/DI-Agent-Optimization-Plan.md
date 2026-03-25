# Decision Intelligence — Agent 輸出品質優化方案

> **核心原則：不犧牲數據正確性，只提升視覺與敘事品質**
>
> 你的系統已有完整的數據治理機制（SQL 追溯、0-row 保護、answer contract、methodology disclosure）。
> 以下所有優化都在「數據層不動」的前提下進行。

---

## 問題診斷總覽

| 層面 | 你的 Agent 現狀 | claude.ai Artifacts | 差距根源 |
|------|----------------|---------------------|----------|
| 圖表視覺 | 固定 8 色 palette、無動畫、預設 Recharts 樣式 | LLM 直接寫 React，完全自由控制配色/動畫/佈局 | 前端渲染層太基礎 |
| 分析敘事 | 被 JSON schema 限制，summary 是純文字 | 自由 markdown、穿插圖表、段落層次豐富 | prompt 輸出格式太死 |
| 整體排版 | Section 列表式堆疊（findings → implications → caveats） | 像專業報告，有視覺層次和重點突出 | Card 元件設計太單調 |

---

## 優化方案一覽

### Phase 1：快速見效（1-2 週）— 前端視覺升級

#### 1.1 ChartRenderer 配色與樣式升級

**檔案**：`src/components/chat/ChartRenderer.jsx`

**現狀問題**：
- `CHART_COLORS` 只有 8 個固定顏色，且是最基本的 Tailwind 色
- 所有圖表共用同一組顏色，缺乏語義配色
- CartesianGrid 太明顯（`stroke="#e2e8f0"`），喧賓奪主
- Tooltip 樣式過於基礎

**優化方向**：

```jsx
// 改前：
const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

// 改後：語義化配色 + 更豐富的色板
const CHART_PALETTES = {
  // 預設：專業商務風
  default: ['#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0d9488', '#4f46e5', '#ca8a04'],
  // 正/負對比（用於 waterfall、盈虧）
  diverging: ['#059669', '#dc2626'],
  // 漸層（用於 heatmap、排名）
  sequential: ['#dbeafe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8'],
  // 類別對比（高飽和度、可區分性強）
  categorical: ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#ca8a04'],
};

// 根據圖表類型自動選色板
function selectPalette(chartType) {
  if (chartType === 'waterfall') return CHART_PALETTES.diverging;
  if (chartType === 'heatmap') return CHART_PALETTES.sequential;
  return CHART_PALETTES.default;
}
```

**其他樣式升級**：
- CartesianGrid 改用更淡的顏色 `stroke="#f1f5f9"` + `strokeOpacity={0.7}`
- Tooltip 加陰影和圓角：`contentStyle={{ borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', border: 'none', padding: '8px 12px' }}`
- Bar 的 `radius` 加大：`[6, 6, 0, 0]` → 更現代感
- Line 加 `activeDot={{ r: 5, strokeWidth: 2 }}` → 互動反饋更好
- Pie label 改用外部連線 + 百分比，不要擠在扇形內

#### 1.2 AgentBriefCard 版面重設計

**檔案**：`src/components/chat/AgentBriefCard.jsx`

**現狀問題**：
- Headline + Summary 只是純文字堆疊
- metric_pills 格子太小、太擠
- Section（Key Findings / Implications / Caveats / Next Steps）全部用相同的 `<li>` 列表，缺乏視覺層次
- 沒有分隔線、分組或重點標記

**優化方向**：

1. **Headline 區域**：加大字號（`text-xl` → `text-2xl`），加一條左側色條或漸層底色，讓標題區更醒目

2. **Metric Pills**：
   - 加上 trend indicator（↑↓）和顏色語義（正向綠、負向紅）
   - 加上 sparkline mini chart（如果有歷史數據）
   - 調大數值字號，形成「大數字 + 小標籤」的 KPI card 風格

3. **Summary 支援 Markdown 渲染**：
   - 安裝 `react-markdown`
   - summary 欄位改為渲染 markdown，支援 **粗體**、`code`、列表等
   - 這樣 LLM 可以在 summary 裡用更豐富的格式，而不需要改 JSON schema

4. **Section 差異化設計**：
   - Key Findings：左側綠色條 + 加粗重點數字
   - Implications：左側藍色條
   - Caveats：左側橘色條 + warning icon
   - Next Steps：左側紫色條 + checkbox 風格

5. **分隔線**：各 Section 之間加 `<hr>` 或 subtle divider

#### 1.3 chartEnhancementService 自動觸發

**檔案**：`src/services/chartEnhancementService.js` + `src/components/chat/AnalysisResultCard.jsx`

**現狀**：Enhancement 需要使用者手動點 "Enhance" 按鈕才會觸發。

**優化**：改為預設自動 enhance：
- 在 `AnalysisResultCard` mount 時自動呼叫 `enhanceChartSpec`
- 用 skeleton loading 佔位（不阻塞其他內容顯示）
- 保留 "Original / Enhanced" 切換供 debug

```jsx
// AnalysisResultCard 中
useEffect(() => {
  if (chart && !enhancedSpec && !isEnhancing) {
    handleEnhance(); // 自動觸發
  }
}, [chart]);
```

---

### Phase 2：中等投入（2-4 週）— Prompt 與敘事品質

#### 2.1 放寬 Brief Synthesis Prompt 的輸出格式

**檔案**：`src/prompts/agentResponsePrompt.js`

**現狀問題**：
- `summary` 欄位被當成純文字處理
- `clampText` 把 summary 限制在 8000 字元
- LLM 被迫把所有洞察壓縮成簡短句子

**優化方向**：

在 `buildAgentBriefSynthesisPrompt` 中：

1. **允許 summary 使用 markdown**：
```
- summary: use markdown formatting for emphasis, inline code for formulas,
  and bullet points for multi-point summaries. Keep professional tone.
```

2. **增加 `executive_summary` 欄位**：
```json
{
  "executive_summary": "一句話結論，給高階主管看",
  "summary": "詳細分析（支援 markdown）",
  ...
}
```

3. **增加 `data_lineage` 欄位**（維持數據正確性）：
```json
{
  "data_lineage": [
    { "metric": "平均交付天數", "source": "SQL query #2", "row_count": 1247, "confidence": "high" }
  ]
}
```
   這樣前端可以在每個數字旁邊顯示「數據來源」hover tooltip，這是 claude.ai 做不到的差異化優勢。

#### 2.2 Answer Contract 增加視覺指引

**檔案**：`src/prompts/agentResponsePrompt.js` → `buildAgentAnswerContractPrompt`

**新增欄位**：
```json
{
  "visual_emphasis": "metric_highlight | comparison_matrix | trend_story",
  "chart_preference": "auto | specific_type"
}
```

讓 LLM 在 answer contract 階段就決定「這個回答最適合什麼視覺呈現方式」，而不是等到 brief synthesis 才硬塞圖表。

#### 2.3 chartRecipeCatalog 擴充

**檔案**：`src/services/chartRecipeCatalog.js`

現有的 recipe 是預寫 Python，快但固定。可以新增一批「高品質模板」：
- 帶有 annotation 的趨勢圖（標注轉折點、異常值）
- 帶有 benchmark line 的 bar chart
- 帶有分位標注的 distribution chart
- Combo chart（柱狀 + 折線）

這些模板的 Python code 可以更精緻，因為只需要寫一次。

---

### Phase 3：差異化優勢（4-8 週）— 你比 claude.ai 更好的地方

這些是 claude.ai 做不到、但你可以做到的功能。

#### 3.1 數據溯源 UI

在每個 metric pill 和 key finding 上加 hover tooltip：
- 顯示「來自哪個 SQL query」「基於多少筆資料」
- 點擊可以展開看 raw data sample
- 這是真正的企業級功能，claude.ai 完全沒有

**實作位置**：`AgentBriefCard.jsx` 的 metric_pills 和 Section 元件

#### 3.2 互動式圖表探索

在 `ChartRenderer` 上加：
- Click-to-drill：點擊某個 bar/segment 可以觸發子查詢
- Zoom & Pan：時間序列圖支援滑動縮放
- Export：一鍵匯出 PNG/SVG（用 `html2canvas` 或 Recharts 內建）

#### 3.3 Report 自動排版

在 `reportGeneratorService.js` 上擴充：
- 自動根據 brief 內容生成 PDF/PPTX 報告
- 套用企業 CI 模板
- 包含完整的 methodology disclosure 和 data lineage

#### 3.4 Comparison Mode

新功能：讓使用者可以把兩次分析結果並排比較：
- 參數變化前後的 KPI 對比
- A/B scenario 的視覺差異
- 時間軸上的 before/after overlay

---

## 優先級建議

| 優先級 | 項目 | 預估工時 | 影響力 |
|--------|------|----------|--------|
| P0 | 1.1 ChartRenderer 配色升級 | 2-3 天 | 立刻改善視覺第一印象 |
| P0 | 1.2 AgentBriefCard 版面升級 | 3-5 天 | 整體報告質感大幅提升 |
| P1 | 1.3 自動觸發 chart enhance | 1 天 | 省去手動操作 |
| P1 | 2.1 Summary 支援 markdown | 2-3 天 | 敘事深度立刻提升 |
| P1 | 2.2 Answer contract 視覺指引 | 2 天 | 圖表更切題 |
| P2 | 2.3 chartRecipe 高品質模板 | 1 週 | 特定場景大幅升級 |
| P2 | 3.1 數據溯源 UI | 1 週 | 差異化優勢 |
| P3 | 3.2 互動式圖表 | 2 週 | 體驗升級 |
| P3 | 3.3 Report 自動排版 | 2 週 | 完整產品功能 |
| P3 | 3.4 Comparison Mode | 2 週 | 進階功能 |

---

## 需要修改的檔案清單

### Phase 1（前端視覺）
- `src/components/chat/ChartRenderer.jsx` — 配色、樣式、動畫
- `src/components/chat/AgentBriefCard.jsx` — 版面重設計
- `src/components/chat/AnalysisResultCard.jsx` — 自動 enhance
- `src/services/chartEnhancementService.js` — 擴充 enhancement prompt

### Phase 2（Prompt 與敘事）
- `src/prompts/agentResponsePrompt.js` — 放寬格式、新增欄位
- `src/services/agentResponsePresentationService.js` — 新欄位處理
- `src/services/chartRecipeCatalog.js` — 新增高品質模板

### Phase 3（差異化）
- `src/components/chat/AgentBriefCard.jsx` — 數據溯源 tooltip
- `src/components/chat/ChartRenderer.jsx` — drill-down、export
- `src/services/reportGeneratorService.js` — PDF/PPTX 排版

---

## 關鍵提醒

**不要動的東西**（維持數據正確性）：
- `chartRecipeExecutor.js` 的 Python code 執行流程
- `agentResponsePresentationService.js` 的 answer contract 解析邏輯
- `chatAgentLoop.js` 的 tool call → evidence 收集流程
- `preAnalysisDataValidator.js` 的資料品質檢查
- `agentAnswerCoverageService.js` 的完整度驗證
- Brief review prompt 的 0-row 保護和 caveat 強制邏輯

**這些是你的護城河**，claude.ai 不做這些驗證，你做了。優化方向是讓「正確的內容」呈現得更漂亮，而不是讓「漂亮的內容」變得不正確。
