# Insights Hub（分析洞察儀表板）— 執行計畫

> **定位**：把散落在對話中的一次性 Agent Brief 累積成持續性分析資產。用戶在這裡看到所有歷史分析的全貌，便宜模型 Agent 自動整理跨報告趨勢，點擊任何圖表可回溯原始報告與數據。

---

## 一、架構總覽

```
歷史對話 (conversations table, messages JSONB)
        │
        ▼
  ┌─────────────────────────────────┐
  │  Brief Extraction Pipeline      │  ← 純程式碼，0 LLM cost
  │  從每則 assistant message 中    │
  │  抽取 AgentBrief JSON          │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │  analysis_snapshots table       │  ← 新 Supabase 表
  │  每份報告一行，存結構化摘要     │
  └──────────────┬──────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
  ┌───────────┐    ┌──────────────────┐
  │ Dashboard │    │ Summary Agent    │
  │ 前端 UI   │    │ (DeepSeek/Kimi)  │
  │ 卡片牆    │    │ 跨報告彙整       │
  └───────────┘    └──────────────────┘
```

---

## 二、資料層：`analysis_snapshots` 表

### 為什麼需要新表？

目前報告存在 `conversations.messages` JSONB 陣列裡——要查「過去 30 天所有跟營收有關的分析」就得 full scan 所有對話的所有訊息再 parse JSON，效能和查詢彈性都不夠。獨立一張表讓 dashboard 查詢變成簡單的 SQL WHERE + ORDER BY。

### Migration SQL

```sql
-- supabase/migrations/20260324_analysis_snapshots.sql

CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id),
  conversation_id text NOT NULL,
  message_index  int  NOT NULL,          -- 在 messages[] 中的位置

  -- 從 AgentBrief 抽取的結構化欄位
  headline       text NOT NULL,
  summary        text,
  executive_summary text,
  metric_pills   jsonb DEFAULT '[]',     -- [{label, value, source}]
  chart_specs    jsonb DEFAULT '[]',     -- 完整 chart spec（用於 dashboard 渲染）
  table_specs    jsonb DEFAULT '[]',
  key_findings   jsonb DEFAULT '[]',     -- string[]
  tags           text[] DEFAULT '{}',    -- 用戶自訂 + 自動推斷的標籤

  -- 資料血統
  data_timestamp timestamptz,            -- 數據截至時間
  query_text     text,                   -- 用戶原始問題
  tool_calls_summary text,               -- 使用了哪些工具（SQL/Python/etc）

  -- 中繼資料
  pinned         boolean DEFAULT false,  -- 用戶釘選到 dashboard
  archived       boolean DEFAULT false,
  created_at     timestamptz DEFAULT now(),

  UNIQUE(conversation_id, message_index)
);

-- 索引
CREATE INDEX idx_snapshots_user_created ON analysis_snapshots(user_id, created_at DESC);
CREATE INDEX idx_snapshots_user_pinned  ON analysis_snapshots(user_id, pinned) WHERE pinned = true;
CREATE INDEX idx_snapshots_tags         ON analysis_snapshots USING gin(tags);
CREATE INDEX idx_snapshots_headline_fts ON analysis_snapshots USING gin(to_tsvector('english', headline || ' ' || coalesce(summary, '')));

-- RLS
ALTER TABLE analysis_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own snapshots"
  ON analysis_snapshots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### Snapshot 寫入時機

在 `agentResponsePresentationService.js` 的 brief 產出完成後，同步寫入 snapshot。不需要另開背景任務：

```javascript
// src/services/analysisSnapshotService.js

import { supabase } from '../lib/supabaseClient';

export async function saveSnapshot({ userId, conversationId, messageIndex, brief, query }) {
  if (!brief?.headline) return null;

  const row = {
    user_id: userId,
    conversation_id: conversationId,
    message_index: messageIndex,
    headline: brief.headline,
    summary: brief.summary || null,
    executive_summary: brief.executive_summary || null,
    metric_pills: brief.metric_pills || [],
    chart_specs: (brief.charts || []).map(c => ({
      type: c.type,
      data: c.data?.slice(0, 100), // 限制儲存量
      xKey: c.xKey, yKey: c.yKey,
      title: c.title, series: c.series,
      referenceLines: c.referenceLines,
      xAxisLabel: c.xAxisLabel, yAxisLabel: c.yAxisLabel,
    })),
    table_specs: brief.tables || [],
    key_findings: brief.key_findings || [],
    tags: inferTags(brief, query),
    data_timestamp: new Date().toISOString(),
    query_text: query,
  };

  const { data, error } = await supabase
    .from('analysis_snapshots')
    .upsert(row, { onConflict: 'conversation_id,message_index' })
    .select('id')
    .single();

  if (error) console.warn('[snapshot] save failed:', error.message);
  return data?.id || null;
}

/**
 * 自動推斷標籤（不用 LLM）。
 */
function inferTags(brief, query) {
  const tags = new Set();
  const text = `${query} ${brief.headline} ${brief.summary || ''}`.toLowerCase();

  const TAG_PATTERNS = {
    'revenue':    /revenue|營收|receita|faturamento/,
    'cost':       /cost|成本|custo|despesa/,
    'customer':   /customer|客戶|cliente/,
    'churn':      /churn|流失|cancelamento/,
    'inventory':  /inventory|stock|庫存|estoque/,
    'forecast':   /forecast|predict|預測|previsão/,
    'trend':      /trend|趨勢|tendência/,
    'comparison': /compare|比較|comparação|vs\b/,
    'anomaly':    /anomal|異常|outlier/,
    'supplier':   /supplier|vendor|供應商|fornecedor/,
  };

  for (const [tag, pattern] of Object.entries(TAG_PATTERNS)) {
    if (pattern.test(text)) tags.add(tag);
  }

  return [...tags];
}
```

### 歷史資料回填

已有對話中的報告需要一次性回填。寫一個 migration script：

```javascript
// scripts/backfillSnapshots.js (一次性執行)

async function backfill(userId) {
  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, messages')
    .eq('user_id', userId)
    .eq('workspace', 'di');

  for (const conv of conversations) {
    const messages = conv.messages || [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;

      // 尋找嵌入的 AgentBrief
      const brief = extractBriefFromMessage(msg);
      if (!brief) continue;

      // 取得前一則 user message 作為 query
      const query = messages[i - 1]?.role === 'user' ? messages[i - 1].content : '';

      await saveSnapshot({
        userId,
        conversationId: conv.id,
        messageIndex: i,
        brief,
        query,
      });
    }
  }
}
```

---

## 三、Summary Agent（彙整代理）

### 為什麼用便宜模型就夠？

| 任務特性 | 說明 |
|---------|------|
| 輸入已結構化 | metric_pills + headline + tags 都是乾淨 JSON |
| 不需要工具調用 | 不用寫 SQL、不用跑 Python，純文字推理 |
| 容錯高 | 摘要稍有不完美也不會造成決策錯誤 |
| 輸出短 | 200-400 tokens 的趨勢摘要 |

### 模型選擇建議

| 模型 | 價格 (per M tokens) | 適用度 | 備註 |
|------|---------------------|--------|------|
| DeepSeek V3 | $0.27 input / $1.10 output | ★★★★ | 中文能力強，JSON 遵循好 |
| Kimi (Moonshot) | ~$1.0 / $2.0 | ★★★ | 長 context window（128K） |
| Gemini 2.0 Flash | $0.10 / $0.40 | ★★★★★ | 最便宜，速度最快 |
| Claude Haiku 3.5 | $0.80 / $4.00 | ★★★★ | 品質穩定但較貴 |

**建議 primary 用 Gemini Flash，fallback 用 DeepSeek V3。** 彙整 N 份報告大約消耗 1-2K input tokens + 500 output tokens，成本 < $0.001/次。

### Summary Agent 服務

```javascript
// src/services/dashboardSummaryAgent.js

import { callLLM } from './aiEmployeeLLMService.js';

const SUMMARY_SYSTEM_PROMPT = `You are a business intelligence analyst reviewing a set of past analysis reports.
Your job is to identify patterns, trends, contradictions, and actionable insights across reports.

OUTPUT FORMAT (JSON):
{
  "period_summary": "一句話概括這段期間的分析重點",
  "trends": [
    { "title": "趨勢標題", "description": "描述", "evidence": ["報告A headline", "報告B headline"], "direction": "up|down|stable|mixed" }
  ],
  "contradictions": [
    { "report_a": "headline A", "report_b": "headline B", "description": "矛盾點說明" }
  ],
  "blind_spots": ["尚未分析但可能重要的方向"],
  "suggested_questions": ["建議接下來可以問的問題"],
  "layout_hints": [
    { "snapshot_id": "uuid", "position": "hero|top-left|top-right|bottom", "reason": "為什麼放這裡" }
  ]
}

RULES:
- Use the same language as the majority of report headlines.
- Keep each field concise (1-2 sentences max).
- trends: max 5, sorted by importance.
- contradictions: only flag genuine conflicts, not minor variations.
- suggested_questions: max 3, specific and actionable.
- layout_hints: pick the top 4-6 most important snapshots for dashboard highlight.`;

/**
 * 產生 dashboard 彙整摘要。
 *
 * @param {object[]} snapshots - analysis_snapshots rows (輕量版)
 * @returns {Promise<object>} summary JSON
 */
export async function generateDashboardSummary(snapshots) {
  if (!snapshots?.length) return null;

  // Step 1: 純程式碼壓縮（不用 LLM）
  const digest = snapshots.map((s, i) => ({
    index: i,
    id: s.id,
    date: s.created_at?.slice(0, 10),
    headline: s.headline,
    pills: (s.metric_pills || []).map(p => `${p.label}: ${p.value}`).join(', '),
    tags: (s.tags || []).join(', '),
    findings_count: (s.key_findings || []).length,
    chart_types: (s.chart_specs || []).map(c => c.type).join(', '),
  }));

  // Step 2: 送給便宜模型
  const { text } = await callLLM({
    taskType: 'dashboard_summary',
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    prompt: JSON.stringify(digest),
    temperature: 0.3,
    maxTokens: 1024,
    jsonMode: true,
  });

  return JSON.parse(text);
}
```

### Model Routing 新增

```javascript
// modelRoutingService 加入

dashboard_summary: {
  tier: 'budget',
  temperature: 0.3,
  maxTokens: 1024,
  providers: ['google', 'deepseek'],  // Gemini Flash > DeepSeek V3
  description: 'Cross-report trend synthesis for dashboard',
}
```

---

## 四、前端：Insights Hub 頁面

### 路由

```javascript
// router.jsx 新增
{ path: '/insights', element: <InsightsHub /> }
```

在側邊欄加入入口，icon 用 `LayoutDashboard` (lucide-react)。

### 頁面結構

```
┌─────────────────────────────────────────────────────┐
│  Insights Hub                          [篩選] [搜尋] │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌── AI 彙整區 ──────────────────────────────────┐  │
│  │  📊 近 30 天分析摘要                           │  │
│  │  "營收持續成長但客戶流失率上升，建議關注..."     │  │
│  │                                                │  │
│  │  趨勢: 營收 ↑  流失 ↑  庫存 ↓                  │  │
│  │  矛盾: 報告A說供應商穩定 vs 報告D說交期延長     │  │
│  │  建議追問: "Q1 vs Q2 客戶留存率比較?"           │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌── 釘選區（Hero Cards）───────────────────────┐   │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐       │   │
│  │ │ 營收趨勢  │ │ 客戶分布  │ │ 庫存狀態  │       │   │
│  │ │ [圖表縮圖]│ │ [圖表縮圖]│ │ [圖表縮圖]│       │   │
│  │ │ R$1.2M ↑ │ │ 3,200 ↓  │ │ 45天 →   │       │   │
│  │ └──────────┘ └──────────┘ └──────────┘       │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌── 時間軸（所有報告）─────────────────────────┐   │
│  │                                                │   │
│  │  📅 2026-03-24                                 │   │
│  │  ┌────────────────────────────────────────┐   │   │
│  │  │ 賣家營收分佈分析                         │   │   │
│  │  │ P50: R$2,847 · P90: R$9,525 · Gini: 0.67│   │   │
│  │  │ [histogram 縮圖]        📌 Pin  🔗 Open │   │   │
│  │  └────────────────────────────────────────┘   │   │
│  │                                                │   │
│  │  📅 2026-03-22                                 │   │
│  │  ┌────────────────────────────────────────┐   │   │
│  │  │ Q1 營收預測 vs 實際                       │   │   │
│  │  │ 營收: R$4.2M · 達成率: 94%               │   │   │
│  │  │ [line chart 縮圖]       📌 Pin  🔗 Open │   │   │
│  │  └────────────────────────────────────────┘   │   │
│  │                                                │   │
│  └────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 核心元件

```
src/pages/InsightsHub.jsx              ← 頁面主體
src/components/insights/
├── DashboardSummaryCard.jsx           ← AI 彙整區
├── PinnedChartsGrid.jsx              ← 釘選的 Hero 圖表
├── SnapshotTimeline.jsx              ← 時間軸卡片列表
├── SnapshotCard.jsx                  ← 單張報告卡片（縮圖+pills+操作）
├── InsightsFilterBar.jsx             ← 標籤篩選 + 日期範圍 + 搜尋
└── DrilldownModal.jsx                ← 點擊圖表後的完整報告 modal
```

### 關鍵互動

**1. 圖表點擊 → 回到原始報告**

```jsx
// SnapshotCard.jsx

function SnapshotCard({ snapshot, onDrilldown }) {
  return (
    <div className="border rounded-xl p-4 hover:shadow-md transition-shadow cursor-pointer"
         onClick={() => onDrilldown(snapshot)}>

      {/* 標題 + 時間 */}
      <div className="flex justify-between items-start mb-2">
        <h3 className="font-semibold text-sm">{snapshot.headline}</h3>
        <span className="text-xs text-slate-400">
          {new Date(snapshot.created_at).toLocaleDateString()}
        </span>
      </div>

      {/* Metric pills */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(snapshot.metric_pills || []).slice(0, 3).map((pill, i) => (
          <span key={i} className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs">
            {pill.label}: {pill.value}
          </span>
        ))}
      </div>

      {/* 圖表縮圖（mini ChartRenderer） */}
      {snapshot.chart_specs?.[0] && (
        <div className="h-32 -mx-2">
          <ChartRenderer
            chart={snapshot.chart_specs[0]}
            height={128}
            showSwitcher={false}
            mini={true}  // 新增 mini 模式：隱藏軸標籤、縮小字型
          />
        </div>
      )}

      {/* 操作列 */}
      <div className="flex items-center gap-2 mt-2 pt-2 border-t">
        <button onClick={(e) => { e.stopPropagation(); togglePin(snapshot.id); }}
                className="text-xs text-slate-500 hover:text-blue-600">
          {snapshot.pinned ? '📌 Unpin' : '📌 Pin'}
        </button>
        <div className="flex-1" />
        {(snapshot.tags || []).map(tag => (
          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}
```

**2. Drilldown Modal → 導航到原始對話**

```jsx
// DrilldownModal.jsx

function DrilldownModal({ snapshot, onClose }) {
  const navigate = useNavigate();

  const goToOriginal = () => {
    // 導航到 workspace 頁面並定位到特定對話和訊息
    navigate(`/workspace?conversation=${snapshot.conversation_id}&msg=${snapshot.message_index}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-[90vw] max-w-4xl max-h-[85vh] overflow-auto p-6">

        {/* 完整 AgentBrief 渲染 */}
        <AgentBriefCard brief={reconstructBrief(snapshot)} />

        {/* 資料血統 */}
        <div className="mt-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-800 text-xs text-slate-500">
          <p>📅 分析時間：{new Date(snapshot.data_timestamp).toLocaleString()}</p>
          <p>❓ 原始問題：{snapshot.query_text}</p>
        </div>

        {/* 操作按鈕 */}
        <div className="flex gap-3 mt-4">
          <button onClick={goToOriginal}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm">
            🔗 查看原始報告與數據
          </button>
          <button onClick={onClose}
                  className="px-4 py-2 rounded-lg bg-slate-200 text-sm">
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
```

**3. AI 彙整觸發時機**

不需要即時觸發。兩種觸發方式：

- **進入 Insights Hub 時**：檢查上次彙整時間，如果超過 24 小時或有新報告，背景呼叫 `generateDashboardSummary()`
- **用戶手動點「重新整理分析」按鈕**：強制重新生成

彙整結果快取在 Supabase 或 localStorage，避免重複生成：

```javascript
// src/services/dashboardSummaryCache.js

const CACHE_KEY = 'di_dashboard_summary';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function getCachedSummary() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  const { summary, timestamp, snapshotCount } = JSON.parse(raw);
  if (Date.now() - timestamp > CACHE_TTL_MS) return null;
  return { summary, snapshotCount };
}

export function setCachedSummary(summary, snapshotCount) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({
    summary, snapshotCount, timestamp: Date.now(),
  }));
}
```

---

## 五、ChartRenderer mini 模式

為了讓 dashboard 卡片中的圖表縮圖看起來乾淨，在 `ChartRenderer` 加入 `mini` prop：

```javascript
// ChartRenderer.jsx 修改

export default function ChartRenderer({ chart, height = 300, showSwitcher = true, mini = false }) {
  // ...
  const TICK_STYLE_ACTUAL = mini
    ? { fontSize: 0, fill: 'transparent' }  // 隱藏 tick labels
    : TICK_STYLE;

  const GRID_PROPS_ACTUAL = mini
    ? { ...GRID_PROPS, stroke: '#e2e8f020' }  // 極淡 grid
    : GRID_PROPS;

  const MARGIN_ACTUAL = mini
    ? { top: 5, right: 5, bottom: 5, left: 5 }
    : MARGIN;

  // 在 mini 模式下隱藏 legend、referenceLines、axis labels
  // ...
}
```

---

## 六、檔案結構

```
新增/修改的檔案：

supabase/migrations/
└── 20260324_analysis_snapshots.sql       ← NEW: 資料表

src/services/
├── analysisSnapshotService.js            ← NEW: snapshot CRUD + 自動標籤
├── dashboardSummaryAgent.js              ← NEW: 便宜模型彙整
├── dashboardSummaryCache.js              ← NEW: 彙整快取
└── modelRoutingService.js                ← 修改: 加 dashboard_summary 路由

src/pages/
└── InsightsHub.jsx                       ← NEW: 主頁面

src/components/insights/
├── DashboardSummaryCard.jsx              ← NEW: AI 彙整卡
├── PinnedChartsGrid.jsx                  ← NEW: 釘選圖表區
├── SnapshotTimeline.jsx                  ← NEW: 時間軸
├── SnapshotCard.jsx                      ← NEW: 報告卡片
├── InsightsFilterBar.jsx                 ← NEW: 篩選列
└── DrilldownModal.jsx                    ← NEW: 鑽取 modal

src/components/chat/
├── ChartRenderer.jsx                     ← 修改: 加 mini 模式
└── AgentBriefCard.jsx                    ← (不改)

src/views/DecisionSupportView/
└── useConversationManager.js             ← 修改: 支援 ?conversation=&msg= 定位

src/router.jsx                            ← 修改: 加 /insights 路由

scripts/
└── backfillSnapshots.js                  ← NEW: 歷史資料回填
```

---

## 七、實施順序

### Phase 1（2 天）：資料管線

1. 建立 `analysis_snapshots` migration，部署到 Supabase
2. 實作 `analysisSnapshotService.js`（saveSnapshot + inferTags）
3. 在 `agentResponsePresentationService.js` 中每次 brief 產出後呼叫 `saveSnapshot()`
4. 寫 `backfillSnapshots.js` 回填既有對話
5. **驗證**：新對話產出後，`analysis_snapshots` 表有正確的行

### Phase 2（2 天）：Dashboard UI 基礎

6. 建立 `InsightsHub.jsx` + 路由 + 側邊欄入口
7. 實作 `SnapshotTimeline` + `SnapshotCard`（先不含圖表縮圖）
8. 實作 `InsightsFilterBar`（標籤篩選 + 日期範圍 + 全文搜尋）
9. 實作 `DrilldownModal` + 導航回原始對話
10. `ChartRenderer` 加入 `mini` 模式
11. **驗證**：進入 /insights 能看到歷史報告卡片列表，點擊能展開詳情並跳回原始對話

### Phase 3（1 天）：AI 彙整

12. 實作 `dashboardSummaryAgent.js`
13. `modelRoutingService` 加入 `dashboard_summary` 路由（指向 Gemini Flash / DeepSeek）
14. 實作 `DashboardSummaryCard.jsx` + 快取邏輯
15. **驗證**：進入 dashboard 看到 AI 生成的跨報告趨勢摘要

### Phase 4（1 天）：釘選與 Hero 區

16. 實作 pin/unpin 功能（更新 `analysis_snapshots.pinned`）
17. 實作 `PinnedChartsGrid`（釘選的圖表用正常大小渲染）
18. AI 彙整的 `layout_hints` 作為「建議釘選」提示
19. **驗證**：釘選圖表出現在頂部 Hero 區，可拖拉排序

### Phase 5（可選，1 天）：「重新整理」功能

20. 每張 snapshot 卡片加「🔄 用最新資料重跑」按鈕
21. 點擊後把 `query_text` 送回 agent pipeline，產出新 brief，新增 snapshot 並標記為同一 query 的更新版本
22. 時間軸上同一 query 的多次結果可以展開比較

---

## 八、成本估算

| 項目 | 頻率 | Token 消耗 | 成本 |
|------|------|-----------|------|
| Snapshot 寫入 | 每次分析 | 0（純程式碼） | $0 |
| Dashboard 彙整 | 每天 1 次或手動 | ~2K tokens | < $0.001 |
| 重跑分析 | 用戶手動 | 與原分析相同 | 同原分析 |

**幾乎零額外 LLM 成本。** 唯一的 LLM 調用是便宜模型的彙整摘要，每次不到 $0.001。

---

## 九、與既有架構的關係

| 既有元件 | 影響 |
|---------|------|
| `conversations` 表 | 不改。snapshot 透過 `conversation_id` + `message_index` 連結 |
| `AgentBriefCard` | 不改。DrilldownModal 復用它來渲染完整報告 |
| `ChartRenderer` | 小改：加 `mini` prop |
| `useConversationManager` | 小改：支援 URL 參數跳轉到特定訊息 |
| A+C 圖表架構 | 互相獨立。Dashboard 卡片用 mini ChartRenderer，Drilldown 用 EnhanceableChart |
| `ROIDashboard` | 不衝突。ROI 追蹤 AI Employee 的價值事件，Insights Hub 追蹤分析報告 |
