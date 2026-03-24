# A+C 混合圖表架構 — 執行細節

> **目標**：讓 DI 平台的圖表品質從「Recharts 預設風格」跳升到「Claude Chat Artifact 級」，同時保持即時回應體驗。

---

## 架構總覽

```
用戶提問 → Agent Pipeline → 產出 chart spec (JSON)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              【Original】    【Template (C)】  【Artisan (A)】
            ChartRenderer     預編譯模板元件     LLM 生成完整
            (Recharts API)    (0.3-0.5s 背景)   HTML+JS iframe
              即時渲染         資料驅動選擇       (3-5s 按需)
```

**三層 UX 流程**：
1. **Original** — 現有 `ChartRenderer` Recharts 渲染，0ms，Pipeline 回傳即出現
2. **Template (C)** — 背景非同步套用預編譯高品質模板，0.3-0.5s 後自動切換
3. **Artisan (A)** — 用戶主動點擊「✨ Artisan」按鈕後，LLM 生成完整 React/D3 組件，iframe 沙盒渲染

---

## Layer C：Pre-compiled Templates（預編譯模板）

### C1. 模板設計原則

每個模板是一個**獨立 React 元件**，接收標準化 chart spec 作為 props，內部使用 Recharts 但加入：

- 漸層填色（`<defs><linearGradient>`）
- 圓角 bar（`radius={[8,8,0,0]}`）
- 動畫進場（`<Bar animationDuration={800} animationEasing="ease-out">`）
- 響應式字型（根據容器寬度調整 tick fontSize）
- 智慧 reference line（只顯示 mean/median，自動計算，不依賴 recipe 硬編碼）
- 暗色模式完整適配（grid/tick/tooltip/label 全套）
- 專業 tooltip（帶圓角、陰影、格式化數值）
- 圖例優化（底部水平排列，小圓點 icon）

### C2. 模板清單（Phase 1: 5 個核心模板）

| ID | 模板名稱 | 適用 chart.type | 選擇條件 |
|---|---|---|---|
| `bar-gradient` | 漸層長條圖 | `bar`, `histogram` | data.length ≤ 20 |
| `bar-horizontal-ranked` | 水平排名圖 | `horizontal_bar` | 任何水平 bar |
| `line-area-smooth` | 平滑面積折線 | `line`, `area` | data.length ≥ 5 |
| `pie-donut-modern` | 現代甜甜圈 | `pie`, `donut` | data.length ≤ 12 |
| `stacked-grouped` | 堆疊/分組進階 | `stacked_bar`, `grouped_bar` | 有 series 欄位 |

Phase 2 再加：`scatter-bubble`, `heatmap-grid`, `treemap-nested`, `funnel-modern`, `pareto-combo`

### C3. 模板選擇器 — `chartTemplateSelector.js`

```javascript
// src/services/chartTemplateSelector.js

const TEMPLATE_REGISTRY = [
  {
    id: 'bar-gradient',
    types: ['bar', 'histogram'],
    match: (chart) => (chart.data?.length || 0) <= 20,
    priority: 10,
  },
  {
    id: 'bar-horizontal-ranked',
    types: ['horizontal_bar'],
    match: () => true,
    priority: 10,
  },
  {
    id: 'line-area-smooth',
    types: ['line', 'area'],
    match: (chart) => (chart.data?.length || 0) >= 5,
    priority: 10,
  },
  {
    id: 'pie-donut-modern',
    types: ['pie', 'donut'],
    match: (chart) => (chart.data?.length || 0) <= 12,
    priority: 10,
  },
  {
    id: 'stacked-grouped',
    types: ['stacked_bar', 'grouped_bar'],
    match: (chart) => Array.isArray(chart.series) && chart.series.length > 1,
    priority: 10,
  },
];

export function selectTemplate(chart) {
  if (!chart?.type) return null;
  const candidates = TEMPLATE_REGISTRY
    .filter(t => t.types.includes(chart.type) && t.match(chart))
    .sort((a, b) => b.priority - a.priority);
  return candidates[0]?.id || null;
}
```

### C4. 模板元件範例 — `BarGradientTemplate.jsx`

```jsx
// src/components/charts/templates/BarGradientTemplate.jsx

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Rectangle,
} from 'recharts';

const GRADIENT_PAIRS = [
  ['#3b82f6', '#1d4ed8'],  // blue
  ['#8b5cf6', '#6d28d9'],  // violet
  ['#06b6d4', '#0891b2'],  // cyan
  ['#10b981', '#059669'],  // emerald
  ['#f59e0b', '#d97706'],  // amber
];

function SmartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white dark:bg-slate-800 shadow-lg border
                    border-slate-200 dark:border-slate-700 px-4 py-3 text-sm">
      <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-slate-600 dark:text-slate-300">
          <span style={{ color: entry.color }}>●</span>{' '}
          {entry.name}: <strong>{Number(entry.value).toLocaleString()}</strong>
        </p>
      ))}
    </div>
  );
}

export default function BarGradientTemplate({ chart, height = 300 }) {
  const { data, xKey, yKey, label, referenceLines, xAxisLabel, yAxisLabel } = chart;
  const gradientId = 'bar-grad-0';

  // Auto-compute mean reference line if none provided
  const autoRef = useMemo(() => {
    if (referenceLines?.length > 0) return referenceLines.slice(0, 3);
    const values = data.map(d => Number(d[yKey])).filter(v => !isNaN(v));
    if (values.length === 0) return [];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return [{ value: Math.round(mean * 100) / 100, label: 'Average', color: '#94a3b8', strokeDasharray: '6 4' }];
  }, [data, yKey, referenceLines]);

  // Responsive tick font
  const tickStyle = { fontSize: 11, fill: '#64748b' };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 20, right: 20, bottom: 40, left: 20 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GRADIENT_PAIRS[0][0]} stopOpacity={0.9} />
            <stop offset="100%" stopColor={GRADIENT_PAIRS[0][1]} stopOpacity={0.7} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis
          dataKey={xKey}
          tick={tickStyle}
          angle={data.length > 10 ? -35 : 0}
          textAnchor={data.length > 10 ? 'end' : 'middle'}
          height={data.length > 10 ? 60 : 40}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -10, style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <YAxis
          tick={tickStyle}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <Tooltip content={<SmartTooltip />} cursor={{ fill: 'rgba(59,130,246,0.06)' }} />
        <Bar
          dataKey={yKey}
          fill={`url(#${gradientId})`}
          radius={[8, 8, 0, 0]}
          name={label || yKey}
          animationDuration={800}
          animationEasing="ease-out"
        />
        {autoRef.map((ref, i) => (
          <ReferenceLine
            key={`ref-${i}`}
            y={ref.value}
            stroke={ref.color || '#94a3b8'}
            strokeDasharray={ref.strokeDasharray || '6 4'}
            label={{ value: `${ref.label}: ${ref.value}`, position: 'right', fill: '#94a3b8', fontSize: 10 }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
```

### C5. 模板載入器 — `chartTemplateLoader.js`

使用 `React.lazy` 實現按需載入，不增加初始 bundle 大小：

```javascript
// src/services/chartTemplateLoader.js

import { lazy } from 'react';

const TEMPLATE_LOADERS = {
  'bar-gradient':          lazy(() => import('../components/charts/templates/BarGradientTemplate.jsx')),
  'bar-horizontal-ranked': lazy(() => import('../components/charts/templates/BarHorizontalRankedTemplate.jsx')),
  'line-area-smooth':      lazy(() => import('../components/charts/templates/LineAreaSmoothTemplate.jsx')),
  'pie-donut-modern':      lazy(() => import('../components/charts/templates/PieDonutModernTemplate.jsx')),
  'stacked-grouped':       lazy(() => import('../components/charts/templates/StackedGroupedTemplate.jsx')),
};

export function getTemplateComponent(templateId) {
  return TEMPLATE_LOADERS[templateId] || null;
}
```

---

## Layer A：LLM-Generated Artisan Charts（LLM 生成工匠圖）

### A1. 核心概念

LLM 生成一個**完整的獨立 HTML 文件**（含 inline CSS + JS），使用 CDN 載入的 Chart.js 或 D3.js，渲染在 `<iframe srcdoc>` 中，完全隔離於主應用。

**為什麼用 iframe 而非動態 React 元件？**
- 安全性：`sandbox` 屬性限制能力，無法存取主應用 DOM/state/cookie
- 穩定性：LLM 生成的程式碼即使報錯也不會 crash 主應用
- 靈活性：可用任何 JS 繪圖庫（D3、Chart.js、ECharts），不受現有 bundle 限制
- 先例：Claude Chat Artifacts 本身就是用 sandboxed iframe 實現的

### A2. Artisan 生成服務 — `chartArtisanService.js`

```javascript
// src/services/chartArtisanService.js

import { callLLM } from './aiEmployeeLLMService.js';

const ARTISAN_SYSTEM_PROMPT = `You are an elite data visualization engineer.
Given a chart specification (JSON), produce a SINGLE self-contained HTML file
that renders a beautiful, publication-quality interactive chart.

REQUIREMENTS:
1. Use Chart.js v4 via CDN: https://cdn.jsdelivr.net/npm/chart.js@4
   OR D3.js v7 via CDN: https://cdn.jsdelivr.net/npm/d3@7
   Choose whichever is best suited for the chart type.
2. The HTML must be fully self-contained (inline <style> and <script>).
3. The chart must be responsive — fill its container 100% width and height.
4. Include smooth entrance animations.
5. Use a professional color palette (accessible, colorblind-friendly).
6. Dark mode: check window.matchMedia('(prefers-color-scheme: dark)').matches
   and also listen for message events: window.addEventListener('message', e => {
     if (e.data?.type === 'theme-change') { /* update colors */ }
   });
7. Dynamic height: after rendering, post the content height back:
   window.parent.postMessage({ type: 'chart-height', height: document.body.scrollHeight }, '*');
8. Interactive tooltips with formatted numbers.
9. Subtle grid lines, rounded corners where applicable.
10. Axis labels in the language matching the chart title.

OUTPUT: Return ONLY the complete HTML string. No markdown, no code fences, no explanation.

DESIGN PRINCIPLES:
- The chart should look like it belongs in a premium analytics dashboard.
- Use gradients, shadows, and rounded shapes tastefully.
- Animate data points sequentially for storytelling effect.
- Typography: system-ui font stack, clear hierarchy.
- Whitespace: generous padding, no cramped labels.`;

/**
 * Generate an Artisan chart (full HTML) from a chart spec.
 *
 * @param {object} chart - Standard chart spec { type, data, xKey, yKey, ... }
 * @param {object} [context] - { title, summary }
 * @returns {Promise<{ html: string, provider: string, model: string }>}
 */
export async function generateArtisanChart(chart, { title, summary } = {}) {
  if (!chart?.type || !Array.isArray(chart?.data)) {
    throw new Error('Invalid chart spec for artisan generation');
  }

  // Limit data to 50 rows for token budget
  const compactChart = {
    ...chart,
    data: chart.data.slice(0, 50),
  };

  const prompt = JSON.stringify({
    chart: compactChart,
    title,
    summary,
    totalDataPoints: chart.data.length,
  });

  const { text, provider, model } = await callLLM({
    taskType: 'chart_artisan',
    systemPrompt: ARTISAN_SYSTEM_PROMPT,
    prompt,
    temperature: 0.4,
    maxTokens: 4096,
    jsonMode: false, // We want raw HTML, not JSON
  });

  // Strip any accidental markdown fences
  let html = text.trim();
  if (html.startsWith('```')) {
    html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
  }

  // Inject full data if we truncated (replace the truncated data in the script)
  if (chart.data.length > 50) {
    html = injectFullData(html, chart.data);
  }

  return { html, provider, model };
}

/**
 * Replace truncated data placeholder with full dataset.
 */
function injectFullData(html, fullData) {
  // Strategy: inject a <script> tag that overrides the data variable
  // before the chart renders
  const dataScript = `<script>window.__CHART_FULL_DATA__ = ${JSON.stringify(fullData)};</script>`;
  return html.replace('</head>', `${dataScript}\n</head>`);
}
```

### A3. iframe 沙盒元件 — `ChartIframeSandbox.jsx`

```jsx
// src/components/charts/ChartIframeSandbox.jsx

import React, { useRef, useState, useEffect, useCallback } from 'react';

/**
 * Renders LLM-generated HTML in a sandboxed iframe.
 *
 * Security: sandbox="allow-scripts" only — no forms, no popups,
 * no same-origin (cannot access parent DOM/cookies/localStorage).
 *
 * Communication: postMessage for height sync and theme changes.
 */
export default function ChartIframeSandbox({
  html,
  minHeight = 300,
  maxHeight = 600,
  className = '',
}) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(minHeight);

  // Listen for height messages from iframe
  useEffect(() => {
    function handleMessage(event) {
      if (event.data?.type === 'chart-height' && typeof event.data.height === 'number') {
        const clamped = Math.min(Math.max(event.data.height, minHeight), maxHeight);
        setHeight(clamped);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [minHeight, maxHeight]);

  // Sync dark mode to iframe
  const syncTheme = useCallback(() => {
    if (iframeRef.current?.contentWindow) {
      const isDark = document.documentElement.classList.contains('dark');
      iframeRef.current.contentWindow.postMessage(
        { type: 'theme-change', dark: isDark },
        '*'
      );
    }
  }, []);

  // Watch for dark mode changes on host
  useEffect(() => {
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, [syncTheme]);

  // Sync theme after iframe loads
  const handleLoad = useCallback(() => {
    syncTheme();
  }, [syncTheme]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      sandbox="allow-scripts"
      className={`w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 ${className}`}
      style={{ height, transition: 'height 0.3s ease' }}
      title="Artisan Chart"
      onLoad={handleLoad}
    />
  );
}
```

### A4. Model Routing 設定

在 `modelRoutingService` 的路由策略中新增 `chart_artisan` task type：

```javascript
// 加入 modelRoutingService 的 TASK_ROUTING_POLICIES

chart_artisan: {
  tier: 'premium',       // 使用高品質模型（Claude Sonnet 或 GPT-4o）
  temperature: 0.4,
  maxTokens: 4096,
  providers: ['anthropic', 'openai'],  // 這兩家的程式碼生成品質最好
  description: 'Generate publication-quality chart HTML',
}
```

---

## 整合：三層切換 UI

### 修改 `EnhanceableChart` 元件

現有的 `EnhanceableChart`（在 `AnalysisResultCard.jsx` 中）已經有 Original/Enhanced toggle。改為三態：

```jsx
// 修改 src/components/chat/AnalysisResultCard.jsx 中的 EnhanceableChart

import { Suspense } from 'react';
import { selectTemplate } from '../../services/chartTemplateSelector.js';
import { getTemplateComponent } from '../../services/chartTemplateLoader.js';
import { generateArtisanChart } from '../../services/chartArtisanService.js';
import ChartIframeSandbox from '../charts/ChartIframeSandbox.jsx';

function EnhanceableChart({ chart, height = 280, context = {} }) {
  const [view, setView] = useState('original'); // 'original' | 'template' | 'artisan'

  // --- Layer C: Template (auto-triggered) ---
  const templateId = useMemo(() => selectTemplate(chart), [chart]);
  const TemplateComponent = templateId ? getTemplateComponent(templateId) : null;

  // Auto-switch to template view once available
  useEffect(() => {
    if (TemplateComponent && view === 'original') {
      // Small delay so user sees the transition
      const timer = setTimeout(() => setView('template'), 300);
      return () => clearTimeout(timer);
    }
  }, [TemplateComponent]);

  // --- Layer A: Artisan (on-demand) ---
  const [artisanHtml, setArtisanHtml] = useState(null);
  const [artisanLoading, setArtisanLoading] = useState(false);
  const [artisanError, setArtisanError] = useState(null);

  const requestArtisan = useCallback(async () => {
    if (artisanHtml) { setView('artisan'); return; }
    setArtisanLoading(true);
    setArtisanError(null);
    try {
      const { html } = await generateArtisanChart(chart, context);
      setArtisanHtml(html);
      setView('artisan');
    } catch (err) {
      setArtisanError(err.message);
    } finally {
      setArtisanLoading(false);
    }
  }, [chart, context, artisanHtml]);

  // --- Toggle Pills ---
  const pills = [
    { key: 'original', label: 'Original' },
    ...(TemplateComponent ? [{ key: 'template', label: 'Enhanced' }] : []),
    { key: 'artisan', label: '✨ Artisan', loading: artisanLoading },
  ];

  return (
    <div>
      {/* Toggle bar */}
      <div className="flex items-center gap-1.5 mb-2">
        {pills.map((pill) => (
          <button
            key={pill.key}
            onClick={() => pill.key === 'artisan' ? requestArtisan() : setView(pill.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
              ${view === pill.key
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              }`}
            disabled={pill.loading}
          >
            {pill.loading ? (
              <span className="flex items-center gap-1">
                <span className="animate-spin w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full" />
                Generating…
              </span>
            ) : pill.label}
          </button>
        ))}
      </div>

      {/* Render area */}
      {view === 'original' && (
        <ChartRenderer chart={chart} height={height} showSwitcher={false} />
      )}

      {view === 'template' && TemplateComponent && (
        <Suspense fallback={<ChartRenderer chart={chart} height={height} showSwitcher={false} />}>
          <TemplateComponent chart={chart} height={height} />
        </Suspense>
      )}

      {view === 'artisan' && artisanHtml && (
        <ChartIframeSandbox html={artisanHtml} minHeight={height} maxHeight={600} />
      )}

      {artisanError && (
        <p className="text-xs text-red-500 mt-1">Artisan generation failed: {artisanError}</p>
      )}
    </div>
  );
}
```

### 在 `AgentBriefCard.jsx` 中啟用

目前 `AgentBriefCard` 的圖表用的是裸 `ChartRenderer`（line 208）。改為用 `EnhanceableChart` 包裹：

```jsx
// AgentBriefCard.jsx line 200-211 修改前：
<ChartRenderer chart={primaryChart} height={240} showSwitcher={false} />

// 修改後：
<EnhanceableChart chart={primaryChart} height={240} context={{ title: brief.headline, summary: brief.summary }} />
```

---

## 檔案結構

```
src/
├── components/
│   └── charts/
│       ├── ChartIframeSandbox.jsx          ← NEW: iframe 沙盒元件
│       └── templates/
│           ├── BarGradientTemplate.jsx      ← NEW: Layer C 模板
│           ├── BarHorizontalRankedTemplate.jsx
│           ├── LineAreaSmoothTemplate.jsx
│           ├── PieDonutModernTemplate.jsx
│           └── StackedGroupedTemplate.jsx
├── services/
│   ├── chartArtisanService.js              ← NEW: Layer A LLM 生成
│   ├── chartTemplateSelector.js            ← NEW: Layer C 選擇邏輯
│   ├── chartTemplateLoader.js              ← NEW: React.lazy 載入器
│   ├── chartEnhancementService.js          ← 保留（作為 Layer C 的 fallback 增強）
│   └── modelRoutingService.js              ← 修改：加入 chart_artisan 路由
└── components/chat/
    ├── AnalysisResultCard.jsx              ← 修改：EnhanceableChart 三態切換
    ├── AgentBriefCard.jsx                  ← 修改：用 EnhanceableChart 包裹圖表
    └── ChartRenderer.jsx                  ← 不改（保持為 Original 層）
```

---

## 實施順序

### Phase 1（1-2 天）：Layer C 基礎

1. 建立 `src/components/charts/templates/` 目錄
2. 實作 `BarGradientTemplate.jsx`（最常用的圖表類型）
3. 實作 `chartTemplateSelector.js` + `chartTemplateLoader.js`
4. 修改 `EnhanceableChart` 支援三態（先只有 original + template）
5. 修改 `AgentBriefCard.jsx` 使用 `EnhanceableChart`
6. **驗證**：同一筆資料在 Original 和 Template 之間切換，視覺品質明顯提升

### Phase 2（1-2 天）：Layer C 完整模板集

7. 實作其餘 4 個 Phase 1 模板（horizontal bar, line/area, pie/donut, stacked/grouped）
8. 每個模板都測試暗色模式、不同資料量、長標籤、reference lines
9. 調整動畫時長和漸層配色

### Phase 3（1 天）：Layer A 基礎

10. 建立 `chartArtisanService.js`
11. 建立 `ChartIframeSandbox.jsx`
12. 在 `modelRoutingService` 加入 `chart_artisan` 路由
13. 在 `EnhanceableChart` 啟用 Artisan 按鈕
14. **驗證**：點擊 Artisan → 3-5s 後出現 iframe 渲染的高品質互動圖表

### Phase 4（1 天）：強化與邊緣案例

15. Artisan 錯誤恢復：如果 LLM 生成的 HTML 有語法錯誤，iframe 會白屏 → 加入 `onerror` fallback 回 Template 視圖
16. Artisan 快取：同一 chart spec 的 artisan HTML 快取在 React state 中（已包含在設計中）
17. CSP 安全審查：確保 iframe sandbox 屬性足夠嚴格
18. 效能測試：確認 template lazy loading 不影響首屏渲染

---

## 安全考量

| 風險 | 緩解措施 |
|---|---|
| LLM 生成惡意 JS | `sandbox="allow-scripts"` 阻止存取父窗口 DOM、cookie、localStorage |
| XSS 透過 postMessage | 只接受 `type: 'chart-height'` 和 `type: 'theme-change'` 的訊息，忽略其他 |
| CDN 載入失敗 | iframe 內的 Chart.js/D3 如果 CDN 失敗，圖表不渲染但主應用不受影響 |
| 巨大 HTML 輸出 | `maxTokens: 4096` 限制 + HTML 大小檢查（超過 100KB 拒絕渲染） |
| 無限迴圈 | iframe 中的 JS 如果卡死，不影響主應用；用戶可切換回 Original/Template |

---

## 成本估算

| 層 | LLM 調用 | 預估 token | 延遲 | 備註 |
|---|---|---|---|---|
| Original | 0 | 0 | 0ms | 純前端 Recharts |
| Template (C) | 0 | 0 | 300ms | 純前端模板選擇 + lazy load |
| Artisan (A) | 1 | ~2000 input + ~2000 output | 3-5s | 按需觸發，不自動 |

每次 Artisan 生成約消耗 4K tokens。以 Claude Sonnet 定價（$3/$15 per M tokens），每次約 $0.036。用戶主動點擊才觸發，不會產生無意義的開銷。

---

## 與現有改進計畫的關係

這個 A+C 架構是獨立於 `DI-Complete-Improvement-Plan-v2.md` 中 13 個改進項目的。但它與以下項目有交集：

- **Issue #12 (chartEnhancementService 限制)**：Layer C 的預編譯模板直接取代了現有的 styling-only 增強。原有的 `enhanceChartSpec()` 可以作為「沒有匹配模板時」的 fallback。
- **Issue #5 (Recipe 硬編碼 reference lines)**：Layer C 模板中的 auto-compute mean/median 解決了 recipe 過度硬編碼的問題。
- **Issue #6 (ChartRenderer 美觀度)**：Layer C 模板直接提升了基礎美觀度，不需要修改共用的 `ChartRenderer.jsx`。
