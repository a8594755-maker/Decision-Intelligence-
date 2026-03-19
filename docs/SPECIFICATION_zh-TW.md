# Decision Intelligence — 產品規格書

**產品版本：** 0.1.0
**文件版本：** 1.0
**更新日期：** 2026-03-07

---

## 目錄

1. [產品基本規格](#1-產品基本規格)
2. [系統架構](#2-系統架構)
3. [前端技術規格](#3-前端技術規格)
4. [後端技術規格](#4-後端技術規格)
5. [AI 模型規格](#5-ai-模型規格)
6. [預測引擎規格](#6-預測引擎規格)
7. [最佳化求解器規格](#7-最佳化求解器規格)
8. [模擬引擎規格](#8-模擬引擎規格)
9. [風險運算規格](#9-風險運算規格)
10. [資料契約規格](#10-資料契約規格)
11. [API 端點規格](#11-api-端點規格)
12. [Supabase Edge Function 規格](#12-supabase-edge-function-規格)
13. [資料匯入規格](#13-資料匯入規格)
14. [認證與授權規格](#14-認證與授權規格)
15. [可觀測性與監控規格](#15-可觀測性與監控規格)
16. [效能規格](#16-效能規格)
17. [整合介面規格](#17-整合介面規格)
18. [頁面與路由規格](#18-頁面與路由規格)
19. [產出物 (Artifact) 規格](#19-產出物-artifact-規格)
20. [功能旗標規格](#20-功能旗標規格)

---

## 1. 產品基本規格

| 項目 | 規格 |
|------|------|
| 產品名稱 | Decision Intelligence |
| 版本號 | 0.1.0 |
| 產品類型 | SaaS Web Application |
| 產品定位 | Analytics Digital Worker — 企業營運與分析數位工作者平台 |
| 授權類型 | Private (非開源) |
| 應用領域 | 供應鏈管理、補貨計畫最佳化、需求預測、風險管理 |

### 1.1 核心功能模組

| 模組 | 功能概述 |
|------|---------|
| Command Center | 全局儀表板、KPI 監控、系統健康、快速操作 |
| Plan Studio | 對話式補貨計畫引擎（Workflow A/B） |
| Forecast Studio | 多模型需求預測、BOM 展開、供給/成本/營收預測 |
| Risk Center | 供應風險分析、風險評分、What-If 情境 |
| Digital Twin | 庫存模擬、策略比較、參數最佳化 |
| Settings | 使用者設定、邏輯版本控制、資料匯入 |
| Governance | 計畫審批、稽核日誌、RBAC |
| Closed Loop | 閉環自動重規劃管線 |
| Agentic Negotiation | AI 驅動的協商建議引擎 |
| Proactive Alerts | 主動預警、供應商事件即時處理 |

---

## 2. 系統架構

### 2.1 整體架構

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React + Vite)               │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐│
│  │Cmd   │ │Plan  │ │Fore- │ │Risk  │ │Digi- │ │Sett- ││
│  │Center│ │Studio│ │cast  │ │Center│ │Twin  │ │ings  ││
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘│
│  ┌────────────────────────────────────────────────────┐ │
│  │       Services Layer (JS Business Logic)           │ │
│  └────────────────────────────────────────────────────┘ │
└───────────────┬────────────────────┬────────────────────┘
                │                    │
       ┌────────▼────────┐  ┌───────▼────────┐
       │  Supabase Cloud  │  │ Python ML API  │
       │  ┌────────────┐  │  │  (FastAPI)     │
       │  │ PostgreSQL  │  │  │ ┌───────────┐ │
       │  │ Auth        │  │  │ │ Forecaster│ │
       │  │ Edge Funcs  │  │  │ │ Solver    │ │
       │  │ - ai-proxy  │  │  │ │ Simulator │ │
       │  │ - bom-explo │  │  │ │ Registry  │ │
       │  │ - etl-sched │  │  │ └───────────┘ │
       │  │ - SAP sync  │  │  └───────────────┘
       │  └────────────┘  │
       └──────────────────┘
```

### 2.2 技術棧

| 層級 | 技術 | 版本 |
|------|------|------|
| Frontend Framework | React | 19.2.0 |
| Build Tool | Vite | 7.2.4 |
| CSS Framework | Tailwind CSS | 4.1.17 |
| Routing | React Router DOM | 6.22.3 |
| Charts | Recharts | 3.7.0 |
| Flow Diagrams | ReactFlow | 11.11.4 |
| HTTP Client | Axios | 1.13.4 |
| Date Handling | date-fns | 3.6.0 |
| Excel Processing | SheetJS (xlsx) | 0.18.5 |
| Markdown Rendering | react-markdown + remark-gfm | 10.1.0 / 4.0.1 |
| Error Monitoring | Sentry React | 10.42.0 |
| Icons | Lucide React | 0.555.0 |
| BaaS | Supabase JS | 2.86.0 |
| Virtual Scrolling | TanStack React Virtual | 3.13.20 |
| Backend Framework | Python FastAPI | — |
| Test Framework (JS) | Vitest | 4.0.18 |
| Test Framework (Python) | pytest | — |

---

## 3. 前端技術規格

### 3.1 頁面元件

| 元件 | 檔案路徑 | 功能 |
|------|---------|------|
| CommandCenter | `src/pages/CommandCenter.jsx` | 首頁儀表板 |
| PlanStudio | `src/pages/PlanStudio.jsx` | 計畫工作室入口 |
| ForecastStudio | `src/pages/ForecastStudio.jsx` | 預測工作室入口 |
| RiskCenter | `src/pages/RiskCenter.jsx` | 風險中心入口 |
| DigitalTwin | `src/pages/DigitalTwin.jsx` | 數位孿生入口 |
| SettingsPage | `src/pages/SettingsPage.jsx` | 設定頁面 |
| LoginPage | `src/pages/LoginPage.jsx` | 登入頁面 |

### 3.2 核心 View 元件

| View | 檔案路徑 | 功能 |
|------|---------|------|
| DecisionSupportView | `src/views/DecisionSupportView/index.jsx` | 對話式規劃主視圖 |
| ForecastsView | `src/views/ForecastsView.jsx` | 預測分析視圖 |
| RiskDashboardView | `src/views/RiskDashboardView.jsx` | 風險儀表板視圖 |
| DigitalTwinView | `src/views/DigitalTwinView.jsx` | 數位孿生視圖 |

### 3.3 對話卡片元件清單

| 元件 | 功能 | 資料綁定 |
|------|------|---------|
| DataSummaryCard | 資料集分析摘要 | Dataset Profile |
| ForecastCard | 預測結果呈現 | forecast_series |
| ForecastErrorCard | 預測錯誤顯示 | Error object |
| PlanSummaryCard | 計畫 KPI 摘要 | solver_meta |
| PlanTableCard | 補貨計畫明細表 | plan_table |
| PlanErrorCard | 計畫錯誤顯示 | Error object |
| PlanExceptionsCard | 約束違反列表 | constraint_check |
| InventoryProjectionCard | 庫存推算圖 | inventory_projection |
| BomBottlenecksCard | BOM 瓶頸分析 | bottlenecks |
| DecisionNarrativeCard | AI 決策敘事 | decision_narrative |
| PlanApprovalCard | 計畫審批卡 | Plan metadata |
| EnhancedPlanApprovalCard | 進階審批卡 | Plan + deadline |
| PlanComparisonCard | 風險/標準計畫比較 | plan_comparison |
| DownloadsCard | 下載產出物 | Artifact URLs |
| ValidationCard | 資料驗證結果 | Validation result |
| WorkflowProgressCard | 工作流程進度 | Step status array |
| WorkflowErrorCard | 工作流程錯誤 | Error object |
| WorkflowReportCard | 工作流程報告 | report_json |
| ReuseDecisionCard | 設定複用選項 | Reuse memory |
| ContractConfirmationCard | 欄位對應確認 | Field mappings |
| BlockingQuestionsCard | 阻塞問題 (唯讀) | Question list |
| BlockingQuestionsInteractiveCard | 阻塞問題 (互動) | Question list + callbacks |
| NegotiationPanel | 協商建議面板 | negotiation_options |
| RiskSummaryCard | 風險摘要 | Risk scores |
| RiskExceptionsCard | 風險例外 | Risk exceptions |
| RiskDrilldownCard | 風險下鑽 | Risk detail |
| PODelayAlertCard | PO 延遲警示 | PO delay data |
| ProactiveAlertCard | 主動警示 | proactive_alerts |
| AIErrorCard | AI 錯誤 | Error object |
| ApprovalReminderCard | 審批提醒 | Deadline info |
| DigitalTwinSimulationCard | 模擬結果卡 | Simulation result |
| TopologyTab | 供應鏈拓撲圖 | Topology graph |
| DataTab | 資料表格 | Raw dataset |

### 3.4 風險元件

| 元件 | 功能 |
|------|------|
| KPICards | 風險 KPI 摘要卡片 |
| FilterBar | 工廠/物料/風險等級篩選 |
| RiskTable | 可排序風險表格 |
| RiskCardGrid | 風險卡片網格 |
| RiskListView | 精簡列表檢視 |
| RiskCard | 單一風險卡片 |
| RiskReplanCard | 風險重規劃建議卡 |
| DetailsPanel | 右側詳情面板 |
| RiskDetailModal | 全螢幕風險詳情 |
| AuditTimeline | 稽核時間軸 |
| ViewToggle | 檢視模式切換 |
| WhatIfSection | 假設情境分析區 |
| ProbabilisticSection | 機率分析區 |
| RevenueSection | 營收影響區 |
| CostSection | 成本拆解區 |
| RiskScoreSection | 風險分數區 |

### 3.5 What-If 元件

| 元件 | 功能 |
|------|------|
| WhatIfPanel | 主控面板 |
| RiskWhatIfView | 風險情境分析 |
| ScenarioComparisonView | 情境 vs. 基準比較 |
| ScenarioMatrixView | 多情境矩陣 |
| ScenarioOverridesForm | 參數覆寫表單 |
| BasePlanEmptyState | 空狀態提示 |
| RecentPlansSelector | 近期計畫選擇器 |
| StaleBaselineWarning | 過期基線警告 |

### 3.6 預測元件

| 元件 | 功能 |
|------|------|
| ConfidenceOverlayChart | P10/P50/P90 分位數圖 |
| ConsensusWarning | 模型共識警告 |
| DriftMonitorPanel | 漂移監控面板 |
| FeatureImportancePanel | 特徵重要性面板 |
| ModelToggle | 預測模型切換 |

### 3.7 Context 與 Hooks

**Context：**

| Context | 功能 |
|---------|------|
| AuthContext | 認證狀態管理（使用者、登入/登出、通知） |
| AppContext | 應用全域狀態（深色模式、全域資料來源） |

**Hooks：**

| Hook | 功能 |
|------|------|
| useSystemHealth | 系統健康狀態輪詢 |
| useSessionContext | Session 上下文存取 |
| usePermissions | 角色權限檢查 |
| useUploadWorkflow | 多步驟上傳工作流程狀態管理 |
| useUrlTabState | URL 查詢參數同步分頁 |
| useLiveTableData | 記憶體內表格資料存取 |
| useBasePlanResolver | 活動基線計畫解析 |

---

## 4. 後端技術規格

### 4.1 Python ML API

| 項目 | 規格 |
|------|------|
| Framework | FastAPI |
| 進入點 | `run_ml_api.py` → `src/ml/api/main.py` |
| 預設埠號 | 8000 |
| API 格式 | RESTful JSON |
| 非同步支援 | 支援（async job submit / poll / SSE events） |

### 4.2 模組結構

```
src/ml/
├── api/                    # FastAPI 路由與端點
│   ├── main.py             # 應用進入點、路由註冊
│   ├── replenishment_solver.py        # OR-Tools CP-SAT 求解器
│   ├── replenishment_heuristic.py     # 啟發式回退求解器
│   ├── replenishment_solver_cplex.py  # CPLEX 適配器
│   ├── replenishment_solver_gurobi.py # Gurobi 適配器
│   ├── replenishment_solver_common.py # 求解器共用工具
│   ├── solver_engines.py             # 引擎選擇策略
│   ├── solver_availability.py        # 引擎可用性偵測
│   ├── solver_telemetry.py           # 求解器遙測
│   ├── planning_contract.py          # 規劃 API 契約
│   ├── forecast_contract.py          # 預測 API 契約
│   ├── async_runs.py                 # 非同步任務基礎設施
│   ├── excel_export.py               # Excel 匯出
│   └── job_worker.py                 # 背景任務工作者
├── demand_forecasting/     # 預測模型
│   ├── prophet_trainer.py
│   ├── lightgbm_trainer.py
│   ├── chronos_trainer.py
│   ├── ets_trainer.py
│   ├── xgboost_trainer.py
│   ├── forecaster_factory.py
│   ├── feature_engineer.py
│   ├── model_registry.py
│   ├── data_contract.py
│   └── data_validation.py
├── simulation/             # 數位孿生模擬
│   ├── chaos_engine.py
│   ├── inventory_sim.py
│   ├── optimizer.py
│   ├── orchestrator.py
│   └── scenarios.py
├── registry/               # 模型註冊表
│   ├── model_registry.py
│   ├── promotion_gates.py
│   ├── release_gate.py
│   └── action_guardrails.py
├── monitoring/             # 監控
│   ├── drift_monitor.py
│   ├── retrain_triggers.py
│   ├── solver_health.py
│   └── closed_loop_store.py
├── governance/             # 治理
│   ├── rbac.py
│   └── store.py
├── uncertainty/            # 不確定性量化
│   ├── quantile_engine.py
│   ├── calibration_metrics.py
│   └── quality_gates.py
└── training/               # 訓練管線
    ├── orchestrator.py
    ├── artifact_manager.py
    ├── runner.py
    └── hpo.py
```

---

## 5. AI 模型規格

### 5.1 LLM 模型路由

| Prompt ID | 用途 | 目標模型 |
|-----------|------|---------|
| DATA_PROFILER (1) | 資料集分析 | Google Gemini 3.1 Pro |
| SCHEMA_MAPPING (2) | 欄位對應建議 | Google Gemini 3.1 Pro |
| WORKFLOW_A_READINESS (3) | 工作流程就緒評估 | Google Gemini 3.1 Pro |
| REPORT_SUMMARY (4) | 報告摘要生成 | DeepSeek Chat |
| BLOCKING_QUESTIONS (5) | 阻塞問題生成 | DeepSeek Chat |
| INTENT_PARSER (6) | 使用者意圖解析 | DeepSeek Chat |
| 一般對話 | 自由對話 | DeepSeek Chat |

### 5.2 AI 代理路由

所有 AI 請求透過 Supabase Edge Function `ai-proxy` 中央路由：
- 處理認證與 CORS
- API 金鑰以 Supabase Secrets 管理
- 不暴露金鑰於前端

---

## 6. 預測引擎規格

### 6.1 需求預測模型

| 模型 | 類型 | 特徵工程 | 分位數預測 | 說明 |
|------|------|---------|-----------|------|
| Prophet | 時間序列 (加法/乘法) | 自動 | 支援 | Facebook 開發，處理趨勢、季節性、假期效應 |
| LightGBM | 梯度提升 | 手動 (feature_engineer.py) | 支援 (分位數回歸) | 高效能、支援類別特徵 |
| Chronos | 基礎模型 (零樣本) | 無需 | 支援 | Amazon 開發，適合資料量少的冷啟動 |
| ETS | 指數平滑 | 無 | 有限 | 經典方法，適合穩定需求 |
| XGBoost | 梯度提升 | 手動 (feature_engineer.py) | 支援 (分位數回歸) | 高精度、強正則化 |

### 6.2 預測分位數

| 分位數 | 用途 |
|--------|------|
| P10 | 樂觀預測（下界） |
| P50 | 中位數預測（基準） |
| P90 | 保守預測（上界，用於安全庫存計算） |

### 6.3 模型管理

| 功能 | 端點 | 說明 |
|------|------|------|
| 模型訓練 | POST `/train-model` | 訓練/重訓練指定模型 |
| 模型切換 | POST `/auto-model-switch` | 根據效能自動切換最佳模型 |
| 回測 | POST `/backtest` | 歷史回測評估模型準確度 |
| 漂移檢測 | POST `/drift-check` | 偵測資料/特徵漂移 |
| 特徵重要性 | POST `/feature-importance` | 取得 ML 模型特徵重要性 |

### 6.4 模型註冊表生命週期

```
訓練 → staged (暫存)
       → 評估 promotion gates (準確度閾值、漂移檢查)
       → promote (升級為 prod)
       → 或 rollback (回退)
```

### 6.5 其他預測類型

| 預測 | 服務 | 說明 |
|------|------|------|
| 供給預測 | supplyForecastService.js | PO 交期延遲機率、供應商統計 |
| 成本預測 | costForecastService.js | 物料成本趨勢預測 |
| 營收預測 | revenueForecastService.js | 營收風險、利潤影響 |
| BOM 展開 | bomExplosionService.js | 成品需求 × BOM 比率 → 零件需求 |
| 庫存推算 | inventoryProjectionService.js | 未來庫存水位模擬 |
| 機率庫存預測 | inventoryProbForecastService.js | 含不確定性的庫存預測 |

---

## 7. 最佳化求解器規格

### 7.1 求解器引擎優先順序

```
OR-Tools CP-SAT (預設)
  → CPLEX (可選企業級)
    → Gurobi (可選企業級)
      → JavaScript Heuristic (永遠可用的回退)
```

### 7.2 數學模型

**目標函數：**

```
最小化 Σ [ ordering_cost + stockout_penalty × backlog + holding_cost × inventory ]
```

**約束條件：**

| 約束 | 說明 |
|------|------|
| MOQ (最小訂購量) | 每次訂購不低於最小訂購量 |
| Pack-size 倍數 | 訂購量必須為包裝單位的倍數 |
| 每 SKU 訂購上限 | 單一品項訂購量不超過上限 |
| 全域預算上限 | 總成本不超過預算限制 |
| 庫存平衡 | 期末庫存 = 期初庫存 + 到貨 - 需求 - 缺料 |

### 7.3 求解器規格

| 項目 | 規格 |
|------|------|
| 求解類型 | MILP (Mixed-Integer Linear Programming) |
| 預設引擎 | Google OR-Tools CP-SAT |
| 支援模式 | 單階層 (Single-Echelon) / 多階層 (Multi-Echelon BOM) |
| 超時設定 | 可配置 |
| 結果狀態 | OPTIMAL / FEASIBLE / INFEASIBLE / TIMEOUT |
| 輸出 | 補貨計畫表、目標函數值、KPI 快照、約束狀態 |

### 7.4 啟發式求解器

當 MILP 求解器不可用時，JavaScript 端啟發式求解器提供：
- 基於安全庫存的 ROP (Reorder Point) 計算
- 考量前置時間的訂購時間點決策
- 保證可行解（非最優但快速）

### 7.5 求解器健康監控

| 端點 | 說明 |
|------|------|
| GET `/ops/solver-health` | 求解器健康指標與閾值 |
| GET `/ops/solver-telemetry` | 求解器遙測事件（求解時間、引擎、目標值、終止原因） |

---

## 8. 模擬引擎規格

### 8.1 離散時間庫存模擬

| 項目 | 規格 |
|------|------|
| 模擬類型 | 離散時間 (Discrete-Time) |
| 時間步長 | 每日 |
| 混沌引擎 | 5 級混沌等級 (calm/low/medium/high/extreme) |
| 模擬參數 | 再訂購點、訂購量、前置時間、需求分佈 |

### 8.2 混沌引擎規格

| 等級 | 供應擾動 | 需求擾動 |
|------|---------|---------|
| Calm | 無 | 無 |
| Low | ±5% 延遲 | ±10% 波動 |
| Medium | ±15% 延遲 | ±25% 波動 |
| High | ±30% 延遲 + 偶發中斷 | ±50% 波動 |
| Extreme | 供應商完全中斷 | 需求暴增 200%+ |

### 8.3 策略比較

三種內建策略：

| 策略 | 安全庫存倍數 | 再訂購點 | 特性 |
|------|------------|---------|------|
| Conservative | 高 (2.0σ) | 高 | 低缺料風險、高持有成本 |
| Balanced | 中 (1.5σ) | 中 | 平衡成本與服務水準 |
| Aggressive | 低 (1.0σ) | 低 | 低持有成本、高缺料風險 |

### 8.4 參數最佳化

| 項目 | 規格 |
|------|------|
| 最佳化方法 | 貝葉斯最佳化 / 網格搜尋 |
| 目標 | 最小化總成本（含缺料罰款 + 持有成本 + 訂購成本） |
| 可調參數 | Reorder Point, Order Quantity |

---

## 9. 風險運算規格

### 9.1 風險分數結構

```json
{
  "entity_type": "supplier | material",
  "entity_id": "string",
  "material_code": "string",
  "plant_id": "string",
  "risk_score": "number (0-200)",
  "metrics": {
    "p90_delay_days": "number",
    "overdue_ratio": "number (0-1)",
    "on_time_rate": "number (0-1)",
    "avg_delay_days": "number"
  }
}
```

### 9.2 風險等級分類

| 等級 | 風險分數範圍 | 標示顏色 |
|------|------------|---------|
| Critical | > 120 | 紅色 |
| High | 80 - 120 | 橙色 |
| Medium | 40 - 80 | 黃色 |
| Low | 0 - 40 | 綠色 |

### 9.3 風險調整規則

| 規則 ID | 名稱 | 觸發條件 | 調整行為 |
|---------|------|---------|---------|
| R1 | Lead Time Extension | p90_delay_days > 5 OR overdue_ratio > 0.20 | 延伸前置時間緩衝 |
| R2 | Stockout Penalty Uplift | risk_score > 60 | 提高缺料罰款乘數 |
| R3 | Safety Stock Uplift | 高風險品項 | P90-P50 混合 (alpha=0.5) 加碼安全庫存 |
| R4 | Dual Sourcing | risk_score > 120 | 啟用雙源採購偏好 |
| R5 | Expedite Mode | risk_score > 100 + P90 延遲 | 前置時間 -3 天，成本 +25% |

### 9.4 供給覆蓋風險計算

| 指標 | 計算方式 |
|------|---------|
| Days-to-Stockout | (在手庫存 + 在途 PO) ÷ 日均需求 |
| Coverage Buckets | 依覆蓋天數分群 (0-7, 7-14, 14-30, 30+) |
| P(Stockout) | 基於庫存推算的缺料機率 |
| Profit-at-Risk | 缺料數量 × 單位毛利 |

### 9.5 供應商事件類型

| 事件 | 說明 | 風險影響 |
|------|------|---------|
| delivery_delay | 交貨延遲 | 提高延遲指標 |
| quality_alert | 品質警示 | 提高品質風險 |
| capacity_change | 產能變動 | 影響供應穩定性 |
| force_majeure | 不可抗力 | 最高風險影響 |
| shipment_status | 出貨狀態 | 更新在途狀態 |
| price_change | 價格變動 | 影響成本規劃 |

---

## 10. 資料契約規格

### 10.1 產出物契約 (Artifact Contract V1)

定義於 `src/contracts/diArtifactContractV1.js`。

**已註冊產出物類型：**

| 類型 | 說明 | 格式 |
|------|------|------|
| forecast_series | 需求預測序列 | JSON (groups + points, P50/P90) |
| metrics | 預測準確度指標 | JSON (MAPE, MAE, model) |
| report_json | 工作流程報告 | JSON (summary, exceptions, actions) |
| forecast_csv | 預測 CSV 匯出 | CSV |
| plan_csv | 計畫 CSV 匯出 | CSV |
| solver_meta | 求解器結果 | JSON (status, KPIs, objective, constraints) |
| constraint_check | 約束檢查結果 | JSON (violations list) |
| plan_table | 補貨計畫表 | JSON (rows: SKU, plant, dates, qty) |
| replay_metrics | 回放模擬指標 | JSON (with/without plan comparison) |
| inventory_projection | 庫存推算 | JSON (time series with/without plan) |
| evidence_pack | 稽核證據包 | JSON (artifact refs bundle) |
| scenario_comparison | 情境比較 | JSON (KPI deltas) |
| negotiation_options | 協商選項 | JSON (option list) |
| negotiation_evaluation | 協商評估 | JSON (ranked options + KPIs) |
| negotiation_report | 協商報告 | JSON (recommendation + evidence) |
| bom_explosion | BOM 展開結果 | JSON (FG→component requirements) |
| component_plan_table | 零件補貨計畫 | JSON |
| component_plan_csv | 零件計畫 CSV | CSV |
| component_inventory_projection | 零件庫存推算 | JSON |
| bottlenecks | BOM 瓶頸 | JSON (missing qty, affected FGs) |
| decision_narrative | AI 決策敘事 | JSON (situation/driver/recommendation) |
| supplier_event_log | 供應商事件日誌 | JSON |
| proactive_alerts | 主動警示列表 | JSON (prioritized alerts + impact) |
| risk_delta_summary | 風險分數差異 | JSON |
| plan_baseline_comparison | 基線比較 | JSON |
| risk_adjustments | 風險調整參數 | JSON |
| risk_plan_table | 風險感知計畫表 | JSON |
| risk_plan_csv | 風險計畫 CSV | CSV |
| risk_replay_metrics | 風險回放指標 | JSON |
| risk_inventory_projection | 風險庫存推算 | JSON |
| risk_solver_meta | 風險求解器資訊 | JSON |
| plan_comparison | 標準 vs. 風險計畫比較 | JSON |

### 10.2 規劃 API 契約

定義於 `src/contracts/planningApiContractV1.js`。
規範 Python `/replenishment-plan` 端點的請求/回應 Schema。

### 10.3 供應商事件契約

定義於 `src/contracts/supplierEventContractV1.js`。
規範供應商事件的輸入 Schema。

---

## 11. API 端點規格

### 11.1 預測端點

| 方法 | 端點 | 請求 | 回應 | 說明 |
|------|------|------|------|------|
| POST | `/demand-forecast` | { data, model_type, horizon } | { forecast, metrics } | 多模型需求預測 |
| POST | `/analyze-sku` | { sku_data } | { characteristics, recommended_model } | SKU 分析 |
| POST | `/model-status` | { model_type } | { available, current } | 模型狀態 |
| POST | `/backtest` | { data, model_type, splits } | { fold_metrics } | 歷史回測 |
| POST | `/feature-importance` | { model_type } | { importances } | 特徵重要性 |
| POST | `/drift-check` | { reference, current } | { drift_detected, details } | 漂移檢測 |
| POST | `/train-model` | { data, model_type, params } | { model_id, metrics } | 模型訓練 |
| POST | `/auto-model-switch` | { performance_data } | { selected_model, reason } | 自動切換 |

### 11.2 求解器端點

| 方法 | 端點 | 請求 | 回應 | 說明 |
|------|------|------|------|------|
| POST | `/replenishment-plan` | PlanningContract | SolverResult | MILP 求解 |
| POST | `/replenishment-plan/commit` | { plan_id } | { status } | 確認計畫 |
| POST | `/stress-test` | { load_config } | { results } | 壓力測試 |

### 11.3 模擬端點

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/scenarios` | 列出可用模擬情境 |
| POST | `/run-simulation` | 執行庫存模擬 |
| POST | `/optimize` | 最佳化模擬參數 |
| POST | `/generate-data` | 生成合成資料 |
| POST | `/simulation-comparison` | 多策略比較 |
| POST | `/simulation/reoptimize` | 模擬內重新最佳化 |

### 11.4 非同步任務端點

| 方法 | 端點 | 說明 |
|------|------|------|
| POST | `/jobs` | 提交非同步任務 |
| POST | `/runs` | 提交非同步回合 |
| GET | `/jobs/{job_id}` | 查詢任務狀態 |
| POST | `/jobs/{job_id}/cancel` | 取消任務 |
| GET | `/jobs/{job_id}/events` | SSE 事件串流 |
| GET | `/runs/{run_id}/steps` | 回合步驟詳情 |
| GET | `/runs/{run_id}/artifacts` | 回合產出物 |

### 11.5 閉環端點

| 方法 | 端點 | 說明 |
|------|------|------|
| POST | `/closed-loop/evaluate` | 評估重訓/重規劃觸發條件 |
| POST | `/closed-loop/run` | 執行閉環管線 |

### 11.6 供應商事件端點

| 方法 | 端點 | 說明 |
|------|------|------|
| POST | `/supplier-events` | 匯入單一供應商事件 |
| POST | `/supplier-events/batch` | 批次匯入供應商事件 |

### 11.7 ML 註冊表端點

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/ml/registry/prod` | 取得目前生產模型 |
| GET | `/ml/registry/artifacts` | 列出模型產出物 |
| POST | `/ml/registry/promote` | 升級模型至生產 |
| POST | `/ml/registry/rollback` | 回退模型 |
| POST | `/ml/drift/analyze` | 執行漂移分析 |
| GET | `/ml/drift/reports` | 列出漂移報告 |
| POST | `/ml/retrain/evaluate` | 評估重訓觸發 |
| POST | `/ml/retrain/run` | 啟動重訓任務 |

### 11.8 系統端點

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/health` | 健康檢查 |
| GET | `/ops/solver-health` | 求解器健康 |
| GET | `/ops/solver-telemetry` | 求解器遙測 |

---

## 12. Supabase Edge Function 規格

| 函式 | 觸發方式 | 說明 |
|------|---------|------|
| `ai-proxy` | HTTP 請求 | AI 模型中央代理（Gemini / DeepSeek）、認證、CORS |
| `bom-explosion` | HTTP 請求 | BOM 展開任務（輪詢式） |
| `etl-scheduler` | Deno.cron (UTC 02:00) | 每日排程，依序呼叫 5 個 SAP 同步函式 |
| `logic-test-run` | HTTP 請求 | 邏輯版本沙箱執行測試 |
| `sync-materials-from-sap` | HTTP 請求 (由 scheduler 呼叫) | 同步物料主檔 |
| `sync-bom-from-sap` | HTTP 請求 | 同步 BOM 結構 |
| `sync-inventory-from-sap` | HTTP 請求 | 同步庫存快照 |
| `sync-demand-fg-from-sap` | HTTP 請求 | 同步計畫獨立需求 |
| `sync-po-open-lines-from-sap` | HTTP 請求 | 同步未結訂單 |

---

## 13. 資料匯入規格

### 13.1 支援格式

| 格式 | 副檔名 | 多工作表 |
|------|--------|---------|
| Excel | .xlsx | 支援 |
| CSV | .csv | 不適用 |

### 13.2 資料類型 Schema

| 資料類型 | 必要欄位 | 可選欄位 |
|---------|---------|---------|
| goods_receipt | supplier, material, date, qty | defect_qty, lead_time |
| price_history | material, date, unit_price | currency, supplier |
| supplier_master | supplier_id, name | contact, region, rating |
| quality_incident | supplier, material, date, type | severity, resolution |
| bom_edge | parent_material, child_material, ratio | plant, uom |
| demand_fg | material_code, plant_id, date, demand_qty | uom, priority, status |
| po_open_lines | po_number, material, qty, expected_date | supplier, plant, price |
| inventory_snapshots | material, plant, qty, snapshot_date | location, uom |
| operational_costs | cost_type, amount, date | category, plant |
| fg_financials | material, revenue, margin | period, currency |

### 13.3 匯入能力

| 項目 | 規格 |
|------|------|
| AI 欄位辨識 | 支援（Gemini + 確定性規則雙重） |
| 分塊匯入 | 支援（大型檔案分塊處理） |
| 匯入復原 | 支援（undo 最近批次） |
| 匯入歷史 | 完整記錄 |
| 資料驗證 | Worker Thread 並行驗證 |
| 資料清洗 | 自動清洗工具 |
| 自動補值 | 支援 (dataAutoFill) |

---

## 14. 認證與授權規格

### 14.1 認證

| 項目 | 規格 |
|------|------|
| 認證服務 | Supabase Auth |
| Token 類型 | JWT |
| Session 管理 | Supabase 自動管理 |

### 14.2 角色型存取控制 (RBAC)

| 角色 | 描述 | 權限 |
|------|------|------|
| viewer | 檢視者 | 檢視所有頁面資料（唯讀） |
| admin | 管理員 | viewer + 建立計畫、上傳、模擬、編輯邏輯 |
| approver | 核准者 | admin + 核准/駁回計畫、發布邏輯版本 |

### 14.3 治理動作控制

| 動作 | 說明 |
|------|------|
| request | 提交審批請求（附 canonical hash） |
| approve | 核准（需 approver 角色） |
| reject | 駁回（需 approver 角色） |

---

## 15. 可觀測性與監控規格

### 15.1 錯誤監控

| 項目 | 規格 |
|------|------|
| 前端 | Sentry React SDK (`@sentry/react`) |
| 後端 | Sentry Python SDK (`sentry-sdk`) |
| 啟用方式 | 設定 `SENTRY_DSN` 環境變數 |

### 15.2 求解器遙測

| 指標 | 說明 |
|------|------|
| solve_time_ms | 求解耗時（毫秒） |
| engine | 使用的求解器引擎 |
| objective_value | 目標函數值 |
| termination_reason | 終止原因 (OPTIMAL/FEASIBLE/TIMEOUT/INFEASIBLE) |
| num_variables | 變數數量 |
| num_constraints | 約束數量 |
| 儲存 | 生產環境：PostgreSQL；開發環境：記憶體 |

### 15.3 LLM 使用追蹤

| 指標 | 說明 |
|------|------|
| call_count | LLM 呼叫次數 |
| total_tokens | 總 Token 數 |
| per_model_usage | 各模型使用量 |
| 範圍 | 每 Session 追蹤 |

### 15.4 系統健康

| 服務 | 檢查方式 | 間隔 |
|------|---------|------|
| Supabase | HTTP health check | 可配置 |
| AI Proxy | HTTP ping | 可配置 |
| ML API | GET `/health` | 可配置 |

### 15.5 漂移監控

| 項目 | 規格 |
|------|------|
| 類型 | 特徵漂移 + 資料漂移 |
| 方法 | 參考分布 vs. 當前分布統計檢定 |
| 報告 | 漂移報告列表（GET `/ml/drift/reports`） |
| 觸發 | 可配置閾值，觸發重訓評估 |

---

## 16. 效能規格

### 16.1 速率限制

| 項目 | 規格 |
|------|------|
| 啟用 | `DI_RATE_LIMIT_ENABLED=true` |
| 範圍 | 每 IP |
| 適用 | 重量級端點（預測、求解器） |
| 前端 | 客戶端速率限制器 (rateLimiter.js) |

### 16.2 並行處理

| 項目 | 規格 |
|------|------|
| 資料驗證 | Worker Thread 並行 |
| 分塊匯入 | 大型檔案分塊處理 |
| 非同步任務 | 支援 submit / poll / cancel |
| SSE 串流 | 非同步任務事件即時串流 |
| 虛擬捲動 | TanStack Virtual 大量列表渲染 |

---

## 17. 整合介面規格

### 17.1 SAP S/4HANA

| 項目 | 規格 |
|------|------|
| 協議 | OData REST API |
| 認證 | SAP API Key (Supabase Secrets) |
| 同步方向 | SAP → Decision Intelligence (單向讀取) |
| 排程 | Deno.cron (預設 UTC 02:00) |
| 模式 | 生產：真實 SAP 連接；開發：模擬 ERP 連接 |

### 17.2 AI 服務

| 服務 | 用途 | 路由 |
|------|------|------|
| Google Gemini 3.1 Pro | 資料分析、欄位對應、就緒評估 | Prompt 1-3 |
| DeepSeek Chat | 報告摘要、問題生成、意圖解析、對話 | Prompt 4-6 + 一般 |

### 17.3 外部事件

| 介面 | 端點 | 格式 |
|------|------|------|
| 供應商事件 (單筆) | POST `/supplier-events` | SupplierEventContract JSON |
| 供應商事件 (批次) | POST `/supplier-events/batch` | SupplierEventContract JSON[] |

---

## 18. 頁面與路由規格

| 路由 | 頁面元件 | 需要認證 | 說明 |
|------|---------|---------|------|
| `/` | CommandCenter | 是 | 首頁儀表板 |
| `/plan` | PlanStudio | 是 | 對話式計畫工作室 |
| `/forecast` | ForecastStudio | 是 | 預測分析工作室 |
| `/risk` | RiskCenter | 是 | 風險管理中心 |
| `/digital-twin` | DigitalTwin | 是 | 數位孿生模擬 |
| `/settings` | SettingsPage | 是 | 系統設定 |
| `/login` | LoginPage | 否 | 登入頁面 |

---

## 19. 產出物 (Artifact) 規格

### 19.1 儲存

| 項目 | 規格 |
|------|------|
| 儲存方式 | Supabase Storage (生產) / 本地記憶體 (開發) |
| 格式 | JSON / CSV |
| API | `saveJsonArtifact()` / `saveCsvArtifact()` (artifactStore.js) |

### 19.2 計畫產出物

| Artifact | 欄位 | 說明 |
|----------|------|------|
| plan_table | sku, plant, order_date, arrival_date, qty, supplier | 補貨訂單明細 |
| solver_meta | status, objective, kpis, engine, solve_time | 求解器摘要 |
| constraint_check | violations[] | 約束違反清單 |
| replay_metrics | with_plan, without_plan, delta | 有/無計畫比較 |
| inventory_projection | dates[], on_hand[], planned[], stockout_units | 庫存推算時序 |
| evidence_pack | artifact_refs[] | 完整證據包 |
| decision_narrative | situation, drivers, recommendation | AI 決策敘事 |

### 19.3 預測產出物

| Artifact | 欄位 | 說明 |
|----------|------|------|
| forecast_series | groups[].points[], P50, P90 | 預測時序 |
| metrics | mape, mae, model, accuracy | 準確度指標 |

### 19.4 風險產出物

| Artifact | 欄位 | 說明 |
|----------|------|------|
| risk_adjustments | rules[], params_before, params_after | 風險參數調整 |
| risk_plan_table | (同 plan_table，風險調整版) | 風險計畫表 |
| plan_comparison | standard_kpis, risk_kpis, delta | 標準 vs. 風險比較 |
| proactive_alerts | alerts[], priority, impact_score | 主動警示 |
| risk_delta_summary | entity, score_before, score_after | 風險變化 |

### 19.5 協商產出物

| Artifact | 說明 |
|----------|------|
| negotiation_options | 協商選項集 |
| negotiation_evaluation | 排序後的選項與 KPI |
| negotiation_report | 最終協商建議 |

---

## 20. 功能旗標規格

| 旗標 | 預設值 | 影響範圍 | 說明 |
|------|--------|---------|------|
| `VITE_DI_RISK_AWARE` | `false` | Plan Studio | 全域啟用風險感知計畫模式 |
| `VITE_DI_PROACTIVE_ALERTS` | `true` | Plan Studio | 啟用主動警示輪詢監控 |
| `VITE_DI_CLOSED_LOOP` | `false` | Plan Studio + ML API | 啟用閉環自動重規劃管線 |
| `VITE_DI_ALLOW_PLAN_DEFAULTS` | `true` | Plan Studio | 允許使用預設前置時間/安全庫存值 |
| `DI_CHRONOS_ENABLED` | `false` | ML API | 啟用 Chronos 基礎模型 |
| `DI_SOLVER_ENGINE` | `ortools` | ML API | 預設求解器引擎選擇 |
| `DI_RATE_LIMIT_ENABLED` | `true` | ML API | 啟用每 IP 速率限制 |
| `USE_MOCK_ERP` | `true` | ML API | 使用模擬 ERP 連接器 |
| `ETL_CRON_SCHEDULE` | `0 2 * * *` | Edge Functions | ETL 排程 (cron 格式) |
| `SENTRY_DSN` | (空) | Frontend + Backend | Sentry 錯誤追蹤 DSN |

---

*本文件由 Decision Intelligence 團隊維護。規格如有變更，請同步更新本文件。*
