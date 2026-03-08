# Decision Intelligence — 使用說明書

**產品版本：** 0.1.0
**文件版本：** 1.0
**更新日期：** 2026-03-07

---

## 目錄

1. [產品概述](#1-產品概述)
2. [系統需求與安裝](#2-系統需求與安裝)
3. [登入與認證](#3-登入與認證)
4. [指揮中心 (Command Center)](#4-指揮中心-command-center)
5. [計畫工作室 (Plan Studio)](#5-計畫工作室-plan-studio)
6. [預測工作室 (Forecast Studio)](#6-預測工作室-forecast-studio)
7. [風險中心 (Risk Center)](#7-風險中心-risk-center)
8. [數位孿生 (Digital Twin)](#8-數位孿生-digital-twin)
9. [設定 (Settings)](#9-設定-settings)
10. [資料匯入指南](#10-資料匯入指南)
11. [工作流程詳解](#11-工作流程詳解)
12. [風險感知計畫](#12-風險感知計畫)
13. [情境分析 (What-If)](#13-情境分析-what-if)
14. [代理協商 (Agentic Negotiation)](#14-代理協商-agentic-negotiation)
15. [主動警示系統](#15-主動警示系統)
16. [計畫治理與審批](#16-計畫治理與審批)
17. [閉環自動化](#17-閉環自動化)
18. [SAP 整合](#18-sap-整合)
19. [常見問題 (FAQ)](#19-常見問題-faq)

---

## 1. 產品概述

**Decision Intelligence** 是一款以對話驅動的供應鏈決策支援平台，整合 AI 預測、數學最佳化求解器、風險分析與數位孿生模擬，協助供應鏈管理者制定最優補貨計畫。

### 核心價值
- **對話式規劃**：透過自然語言對話上傳資料、啟動規劃流程、獲取分析結果
- **AI 多模型預測**：支援 Prophet、LightGBM、Chronos、ETS、XGBoost 五種預測模型
- **MILP 最佳化求解**：使用 OR-Tools CP-SAT 混合整數線性規劃求解器，最小化總成本
- **風險感知決策**：自動根據供應商風險分數調整規劃參數
- **數位孿生模擬**：以離散時間模擬引擎驗證策略、比較方案
- **端到端治理**：完整的審批流程、稽核追蹤、邏輯版本控制

---

## 2. 系統需求與安裝

### 2.1 系統需求

| 項目 | 最低需求 |
|------|---------|
| 作業系統 | macOS 12+、Windows 10+、Linux (Ubuntu 20.04+) |
| Node.js | v18+ |
| Python | 3.10+ (ML API 後端) |
| 瀏覽器 | Chrome 100+、Firefox 100+、Edge 100+、Safari 16+ |
| 記憶體 | 建議 8 GB 以上 |

### 2.2 前端啟動

```bash
# clone 真實 repo path
git clone https://github.com/a8594755-maker/Decision-Intelligence-.git
cd Decision-Intelligence-

# 安裝依賴
npm ci

# 開發模式啟動
npm run dev

# 生產建置
npm run build
npm run preview
```

### 2.3 ML API 後端啟動

```bash
# 建立虛擬環境
python3.12 -m venv .venv
source .venv/bin/activate  # macOS/Linux
# 或 .venv\Scripts\activate  (Windows)

# 安裝依賴
pip install -r requirements-ml.txt

# 啟動 ML API
python run_ml_api.py
```

### 2.4 環境變數設定

複製 `.env.example` 為 `.env.local`，再填入實際值：

```env
VITE_ENV=development
# Supabase 連線
VITE_SUPABASE_URL=https://decision-intelligence-dev.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dev-anon-key
VITE_ML_API_URL=http://127.0.0.1:8000

# 功能旗標
VITE_DI_RISK_AWARE=false          # 全域啟用風險感知計畫
VITE_DI_PROACTIVE_ALERTS=true     # 啟用主動警示輪詢

# ML API
DI_SOLVER_ENGINE=ortools          # 求解器引擎 (ortools/cplex/gurobi/heuristic)
DI_CHRONOS_ENABLED=false          # 啟用 Chronos 基礎模型
USE_MOCK_ERP=true                 # 使用模擬 ERP 連接器

# 可選：錯誤監控
VITE_SENTRY_DSN=https://PUBLIC_KEY@o000.ingest.sentry.io/0000000
```

AI provider keys 不再建議放在前端環境變數，請改由 Supabase Edge Function secrets 管理：

```bash
supabase secrets set GEMINI_API_KEY=...
supabase secrets set DEEPSEEK_API_KEY=...
supabase secrets set FRONTEND_ORIGIN=http://localhost:5173
```

---

## 3. 登入與認證

### 3.1 登入頁面

啟動應用後，首次訪問會自動導向 `/login` 登入頁面。

**登入方式：**
- 輸入 Email 和密碼
- 點擊「登入」按鈕
- 認證透過 Supabase Auth 服務處理

### 3.2 角色權限

系統內建三種角色：

| 角色 | 權限 |
|------|------|
| **Viewer** (檢視者) | 檢視儀表板、計畫結果、預測資料（僅唯讀） |
| **Admin** (管理員) | Viewer 權限 + 建立計畫、上傳資料、執行模擬 |
| **Approver** (核准者) | Admin 權限 + 核准/駁回補貨計畫、發布邏輯版本 |

### 3.3 登出

點擊頂部導覽列的使用者圖示，選擇「登出」。

---

## 4. 指揮中心 (Command Center)

**路徑：** `/`（首頁）

指揮中心是進入系統後的第一個畫面，提供全局視角的儀表板。

### 4.1 Hero KPI 卡片

顯示最重要的指標：**Fill Rate (服務水準 %)**，與前次計畫執行的趨勢比較。

### 4.2 次要 KPI

| KPI | 說明 |
|-----|------|
| **Stockout Risk** | 處於斷料風險的品項數量 |
| **Total Cost** | 總規劃成本（含訂購成本、持有成本、缺料罰款） |
| **Last Plan Run** | 最近一次計畫執行的時間距離 |

### 4.3 快速操作

提供三個快捷入口：
- **New Plan Run** → 跳轉到計畫工作室開始新的規劃
- **Risk Analysis** → 跳轉到風險中心
- **View Forecasts** → 跳轉到預測工作室

### 4.4 最近活動

顯示最近 8 筆稽核事件，包含：
- 計畫生成 / 核准 / 駁回
- 情境分析執行
- 風險觸發事件

每個事件有時間戳、事件類型標籤與詳細說明。

### 4.5 系統健康狀態

即時顯示三個服務的連線狀態（綠色/紅色指示燈）：
- **Supabase** — 資料庫與認證服務
- **AI Proxy** — AI 大語言模型服務
- **ML API** — Python 機器學習 API 服務

點擊「重新整理」按鈕可手動刷新狀態。

---

## 5. 計畫工作室 (Plan Studio)

**路徑：** `/plan`

計畫工作室是系統的核心功能，透過對話式介面引導使用者完成完整的補貨規劃流程。

### 5.1 對話介面

#### 訊息輸入區
- 底部輸入框可輸入自然語言指令或問題
- 支援拖放上傳 Excel/CSV 檔案
- AI 會回覆結構化卡片或文字回應

#### 對話側邊欄
- 左側顯示歷史對話列表
- 可切換不同對話記錄
- 每個對話保有完整的工作流程狀態

### 5.2 資料上傳

1. 將 Excel (.xlsx) 或 CSV 檔案拖放到對話區域
2. 系統自動進行**資料集分析 (Dataset Profiling)**：
   - 辨識工作表角色（需求、BOM、PO、庫存等）
   - 自動對應欄位名稱
   - 偵測時間範圍
3. 顯示 **DataSummaryCard** 卡片，摘要資料集內容
4. 若系統偵測到相似的歷史資料集，會顯示 **ReuseDecisionCard**，提供複用先前設定的選項

### 5.3 工作流程引擎

上傳資料後，系統自動判斷應執行的工作流程：

- **Workflow A（補貨計畫）**：需求資料 → 完整的補貨規劃流程
- **Workflow B（風險例外分析）**：PO/收貨資料 → 供應商風險評分與例外報告

#### Workflow A 八步驟流程

| 步驟 | 名稱 | 說明 |
|------|------|------|
| 1 | Profile | 資料集指紋比對、欄位對應、記憶體複用檢查 |
| 2 | Contract | 驗證必要欄位已對應，AI 提出釐清問題 |
| 3 | Validate | 資料型別驗證、日期解析、數值檢查 |
| 4 | Forecast | 透過 ML API 執行需求預測 |
| 5 | Optimize | 呼叫 MILP 求解器產出最佳補貨計畫 |
| 6 | Verify | 約束條件檢查 + 庫存回放模擬 |
| 7 | Topology | 生成供應鏈拓撲圖 |
| 8 | Report | AI 決策敘事 + 產出物組裝 + 稽核紀錄 |

每個步驟完成後會顯示 **WorkflowProgressCard** 呈現進度。

### 5.4 阻塞問題 (Blocking Questions)

在工作流程執行期間，AI 可能提出需要使用者回答的關鍵問題：
- 以 **BlockingQuestionsInteractiveCard** 卡片形式呈現
- 使用者必須回答所有問題後，工作流程才會繼續
- 問題類型包含：規劃範圍確認、預設值選擇、資料異常處理等

### 5.5 結果卡片

工作流程完成後，對話區域會依序顯示以下卡片：

| 卡片 | 說明 |
|------|------|
| **ValidationCard** | 資料驗證結果摘要 |
| **ForecastCard** | 需求預測結果（圖表 + 數值） |
| **PlanSummaryCard** | 計畫摘要 KPI（訂購總量、總成本、Fill Rate） |
| **PlanTableCard** | 補貨計畫明細表（SKU、工廠、訂購日、到貨日、數量） |
| **InventoryProjectionCard** | 庫存水位推算圖（有計畫 vs. 無計畫） |
| **PlanExceptionsCard** | 計畫例外/約束違反列表 |
| **BomBottlenecksCard** | BOM 供應瓶頸分析 |
| **DecisionNarrativeCard** | AI 生成的決策敘事（情境/驅動因素/建議） |
| **PlanApprovalCard** | 計畫核准操作區 |
| **DownloadsCard** | 產出物下載區（CSV/JSON） |

### 5.6 拓撲圖分頁 (Topology Tab)

- 使用 ReactFlow 繪製供應鏈有向無環圖 (DAG)
- 節點類型：供應商 → 零件 → 工廠 → 成品 → 出貨節點
- 可縮放、拖曳、選取節點查看詳細資訊
- 邊線標示物料流向與數量

### 5.7 資料分頁 (Data Tab)

- 以表格形式顯示底層資料集
- 支援排序、篩選
- 可使用 **InlineEditCell** 直接在表格中編輯資料

### 5.8 畫布面板 (Canvas Panel)

- 對話區域旁的輔助面板
- 可視化展示工作流程產出物
- 支援多面板並排檢視

---

## 6. 預測工作室 (Forecast Studio)

**路徑：** `/forecast`

預測工作室提供全方位的預測分析功能，涵蓋需求、供給、成本、營收四大面向。

### 6.1 BOM 展開結果 (Results Tab)

- 顯示 BOM 展開後的零件需求分頁結果
- 從成品需求透過 BOM 比率計算零件需求量
- 支援篩選器、分頁瀏覽
- BOM 展開透過 Supabase Edge Function (`bom-explosion`) 執行

### 6.2 追溯分頁 (Trace Tab)

- 展示 BOM 展開追溯性
- 成品 → 零件的關聯鏈路
- 可追蹤特定零件需求來自哪些成品

### 6.3 庫存分頁 (Inventory Tab)

- 庫存水位推算圖表
- 三種模式：
  - **FULL**：完整庫存推算
  - **WARN**：預警模式（標示低水位）
  - **STOP**：停機模式（標示斷料時間點）

### 6.4 需求預測分頁 (Demand Forecast Tab)

#### 模型選擇
透過 **ModelToggle** 元件切換五種預測模型：

| 模型 | 說明 | 適用場景 |
|------|------|---------|
| **Prophet** | Facebook 時間序列模型 | 具有季節性與趨勢的需求 |
| **LightGBM** | 梯度提升機器學習模型 | 多特徵、非線性關係 |
| **Chronos** | Amazon 零樣本基礎模型 | 資料量少、冷啟動 |
| **ETS** | 指數平滑模型 | 穩定、規律的需求模式 |
| **XGBoost** | 極端梯度提升模型 | 高維特徵、大量資料 |

#### 信賴區間圖表

**ConfidenceOverlayChart** 元件顯示分位數預測：
- **P10**：樂觀預測（10%分位數）
- **P50**：中位數預測
- **P90**：保守預測（90%分位數）

#### 共識警告

當不同模型的預測結果差異過大時，**ConsensusWarning** 元件會發出警示，提醒使用者注意模型分歧。

#### 特徵重要性面板

**FeatureImportancePanel** 顯示 ML 模型中各特徵的重要性排序，幫助使用者理解哪些因素驅動預測結果。

#### 漂移監控面板

**DriftMonitorPanel** 偵測資料/特徵分布漂移，當訓練資料與最新資料的分布出現顯著差異時發出警示。

### 6.5 供給預測分頁 (Supply Forecast Tab)

- 供給側預測與 PO 交期延遲機率
- 基於歷史收貨紀錄計算供應商交付機率
- 供應商統計數據（準時率、平均延遲天數）

### 6.6 成本預測分頁 (Cost Forecast Tab)

- 物料成本預測
- 可設定成本計算規則集
- 成本趨勢分析圖表

### 6.7 營收預測分頁 (Revenue Forecast Tab)

- 利潤風險 (Margin-at-Risk) 分析
- 營收條款管理
- 斷料對營收的影響評估

---

## 7. 風險中心 (Risk Center)

**路徑：** `/risk`

風險中心集中管理供應鏈風險，提供從總覽到明細的完整風險視圖。

### 7.1 風險 KPI 卡片

頂部顯示四大風險彙總指標：

| KPI | 說明 |
|-----|------|
| **At-Risk Units** | 處於風險的品項數量 |
| **Coverage Days** | 平均供應覆蓋天數 |
| **P(Stockout)** | 缺料機率 |
| **Profit-at-Risk** | 利潤風險金額 |

### 7.2 篩選列

- **工廠篩選**：依工廠代碼篩選
- **物料搜尋**：依物料代碼搜尋
- **風險等級**：Critical（極高）/ High（高）/ Medium（中）/ Low（低）

### 7.3 三種檢視模式

透過 **ViewToggle** 切換：

| 模式 | 說明 |
|------|------|
| **Table View** | 可排序的表格檢視，欄位包含物料、供應商、風險分數、覆蓋天數等 |
| **Card Grid** | 卡片網格檢視，每張卡片呈現一個物料/供應商組合的風險摘要 |
| **List View** | 精簡列表檢視 |

### 7.4 風險詳情面板

點擊任一物料/供應商，右側展開詳情面板，包含：

| 區塊 | 說明 |
|------|------|
| **Risk Score Section** | 原始風險分數組成 |
| **What-If Section** | 加急/雙源等假設情境分析 |
| **Probabilistic Section** | P(缺料) × 影響程度視覺化 |
| **Revenue Section** | 利潤風險與營收影響 |
| **Cost Section** | 風險情境的成本拆解 |
| **Audit Timeline** | 該物料/供應商的風險事件歷史 |

### 7.5 風險詳情彈窗

點擊「展開詳情」可開啟全螢幕 **RiskDetailModal**，提供更完整的分析視圖。

### 7.6 預測回合選擇器

可選擇不同的預測回合來分析對應的風險狀態。

---

## 8. 數位孿生 (Digital Twin)

**路徑：** `/digital-twin`

數位孿生模組提供供應鏈模擬環境，可在虛擬環境中測試不同策略。

### 8.1 模擬分頁 (Simulation Tab)

#### 混沌等級設定

| 等級 | 說明 |
|------|------|
| **Calm** | 無擾動，理想環境 |
| **Low** | 小幅度隨機擾動 |
| **Medium** | 中度擾動（輕微供應延遲、需求波動） |
| **High** | 大幅擾動（嚴重延遲、需求暴增） |
| **Extreme** | 極端情境（供應商中斷、黑天鵝事件） |

#### 模擬結果

- **庫存時間軸圖表**：顯示模擬期間庫存水位變化
- **成本拆解圖表**：
  - 持有成本 (Holding Cost)
  - 缺料罰款 (Stockout Penalty)
  - 訂購成本 (Ordering Cost)
  - 採購成本 (Purchase Cost)

### 8.2 策略比較分頁 (Strategy Comparison Tab)

並排比較三種補貨策略：

| 策略 | 特性 |
|------|------|
| **Conservative** (保守) | 高安全庫存、低缺料風險、高持有成本 |
| **Balanced** (平衡) | 中等安全庫存、平衡成本與風險 |
| **Aggressive** (積極) | 低安全庫存、低持有成本、高缺料風險 |

每種策略顯示 KPI 比較（Fill Rate、總成本、缺料次數）。

### 8.3 參數最佳化分頁 (Parameter Optimizer Tab)

- 設定要最佳化的參數：
  - **Reorder Point** (再訂購點)
  - **Order Quantity** (訂購量)
- 呼叫 Python `/optimize` 端點執行最佳化
- 顯示最佳化前後的 KPI 比較

### 8.4 策略調整分頁 (Strategy Tuner Tab)

- 以滑桿微調策略權重
- 即時重新最佳化
- 觀察參數變化對結果的影響

---

## 9. 設定 (Settings)

**路徑：** `/settings`

### 9.1 個人檔案與 API 設定 (Profile & API Tab)

- **使用者 Email**：顯示目前登入的帳號
- **AI 設定**：顯示 AI 模型配置資訊（API 金鑰透過 Supabase Secrets 管理）
- **深色/淺色模式切換**：切換應用程式的顯示主題

### 9.2 邏輯控制中心 (Logic Control Center Tab)

管理計畫邏輯版本的進階功能，僅限 Admin 和 Approver 角色使用。

| 子分頁 | 說明 |
|--------|------|
| **Overview** | 已發布的邏輯版本列表，包含版本號、發布時間、狀態 |
| **Edit** | 編輯草稿邏輯版本的規則與參數 |
| **Sandbox & Diff** | 在沙箱中測試邏輯，並檢視草稿與已發布版本的差異 |
| **Release** | 將草稿版本發布為正式版本（需 Approver 權限） |

### 9.3 資料匯入面板 (Data Import Tab)

提供四步驟的資料匯入精靈（詳見[第 10 節](#10-資料匯入指南)）。

---

## 10. 資料匯入指南

### 10.1 匯入精靈四步驟

| 步驟 | 名稱 | 說明 |
|------|------|------|
| 1 | **Upload** | 上傳 Excel 或 CSV 檔案 |
| 2 | **Sheet Planning** | AI 自動辨識各工作表的資料類型，使用者確認對應 |
| 3 | **Validation** | 系統驗證資料格式、必填欄位、資料型別 |
| 4 | **Import** | 匯入資料到系統（可支援分塊匯入大型檔案） |

### 10.2 支援的資料類型

系統支援 10 種標準資料類型：

| 資料類型 | 說明 | 必要欄位 |
|---------|------|---------|
| **goods_receipt** | 供應商交貨記錄 | 供應商、物料、日期、數量 |
| **price_history** | 歷史物料價格 | 物料、日期、單價 |
| **supplier_master** | 供應商主檔 | 供應商代碼、名稱 |
| **quality_incident** | 品質異常記錄 | 供應商、物料、事件日期、類型 |
| **bom_edge** | BOM 表（成品→零件關係） | 母件、子件、用量比率 |
| **demand_fg** | 成品需求（計畫獨立需求） | 物料、工廠、日期、需求量 |
| **po_open_lines** | 未結訂單明細 | PO 編號、物料、數量、預計到貨日 |
| **inventory_snapshots** | 庫存快照 | 物料、工廠、數量、快照日期 |
| **operational_costs** | 營運成本記錄 | 成本類型、金額、日期 |
| **fg_financials** | 成品財務資料 | 物料、營收、毛利 |

### 10.3 AI 輔助欄位對應

- 系統使用 AI 自動建議欄位對應（diModelRouterService → SCHEMA_MAPPING）
- 支援確定性規則對應 (deterministicMapping) 與 AI 輔助對應 (aiMappingHelper) 雙重機制
- 使用者可手動修正自動對應結果

### 10.4 匯入歷史與復原

- 所有匯入批次有完整歷史紀錄 (importHistoryService)
- 支援匯入復原 (undo) 操作

---

## 11. 工作流程詳解

### 11.1 Workflow A — 補貨計畫

**觸發條件：** 資料集包含需求資料 (demand_fg)

**完整流程：**

```
上傳資料 → Profile(指紋比對)
         → Contract(欄位驗證 + AI 釐清問題)
         → Validate(資料型別驗證)
         → Forecast(ML 需求預測)
         → Optimize(MILP 求解器)
         → Verify(約束檢查 + 回放模擬)
         → Topology(供應鏈拓撲圖)
         → Report(AI 決策敘事 + 產出物)
```

**產出物：**
- 補貨計畫表 (plan_table)
- 求解器資訊 (solver_meta)：狀態、KPI、目標函數證明
- 預測序列 (forecast_series)
- 庫存推算 (inventory_projection)
- 約束檢查 (constraint_check)
- 回放指標 (replay_metrics)
- 決策敘事 (decision_narrative)
- 證據包 (evidence_pack)
- 可下載 CSV (plan_csv, forecast_csv)

### 11.2 Workflow B — 風險例外分析

**觸發條件：** 資料集包含 PO/收貨資料

**完整流程：**

```
上傳資料 → Profile(指紋比對)
         → Contract(PO/收貨欄位驗證)
         → Validate(日期/數量檢查)
         → Compute Risk(供應商/物料風險評分)
         → Exceptions(識別極高/高風險例外)
         → Topology(供應鏈圖)
         → Report(AI 風險敘事 + 下載)
```

**產出物：**
- 風險評分 (risk scores)
- PO 延遲警示 (po_delay_alert)
- 主動警示 (proactive_alerts)
- 風險例外報告 (report_json)
- 供應鏈拓撲圖

### 11.3 工作流程恢復

- 暫停的工作流程可隨時恢復
- 完成的工作流程可重新播放結果

---

## 12. 風險感知計畫

### 12.1 啟用方式

風險感知計畫有三種啟用方式：

1. **每次執行啟用**：在對話中傳入 `riskMode='on'`
2. **全域啟用**：設定環境變數 `VITE_DI_RISK_AWARE=true`
3. **設定啟用**：在 Settings 中設定 `settings.plan.risk_mode = 'on'`

### 12.2 風險調整規則

系統根據供應商風險分數自動調整求解器參數：

| 規則 | 觸發條件 | 調整方式 |
|------|---------|---------|
| **R1 前置時間延伸** | P90 延遲 > 5 天或逾期率 > 20% | 增加前置時間緩衝 |
| **R2 缺料罰款加成** | 風險分數 > 60 | 提高缺料罰款乘數 |
| **R3 安全庫存加碼** | 高風險品項 | 以 P90-P50 混合（alpha=0.5）提高安全庫存 |
| **R4 雙源採購** | 風險分數 > 120 | 建議雙源採購 |
| **R5 加急模式** | 風險分數 > 100 + P90 延遲 | 前置時間減 3 天，成本加 25% 溢價 |

### 12.3 比較卡片

啟用風險感知計畫後，系統會產生 **PlanComparisonCard**，並排比較：
- 標準計畫的 KPI
- 風險感知計畫的 KPI
- 差異分析（成本增減、Fill Rate 變化、缺料改善）

---

## 13. 情境分析 (What-If)

### 13.1 情境覆寫

透過 **ScenarioOverridesForm** 可修改以下參數：
- 需求數量（增減百分比）
- 前置時間（增減天數）
- 成本參數（單價調整）
- 供應商可靠性（延遲機率）

### 13.2 情境比較

**ScenarioComparisonView** 提供基準計畫與情境計畫的 KPI 差異比較：
- 成本差異
- Fill Rate 差異
- 庫存天數差異
- 缺料風險差異

### 13.3 情境矩陣

**ScenarioMatrixView** 支援多情境組合分析，以矩陣形式呈現不同參數組合的結果。

### 13.4 風險情境

在風險中心的詳情面板中，**WhatIfSection** 提供：
- **加急 (Expedite)**：模擬加急採購的成本與時間影響
- **雙源 (Dual Source)**：模擬新增備選供應商的效果

---

## 14. 代理協商 (Agentic Negotiation)

### 14.1 協商流程

系統內建 Agentic Negotiation Loop v0：

```
觸發偵測 → 選項生成 → 情境重新求解 → LLM 解釋（證據優先驗證）
```

### 14.2 觸發偵測

自動偵測需要協商的情境：
- 成本超出預算上限
- Fill Rate 低於目標
- 關鍵物料缺料風險過高

### 14.3 選項生成

**NegotiationOptionsGenerator** 以確定性方式生成協商選項：
- 價格協商方案
- 交期調整方案
- 數量調整方案
- 替代供應商方案

### 14.4 評估與排序

**NegotiationEvaluator** 評估各選項的 KPI 影響並排序。

### 14.5 協商面板

在對話中以 **NegotiationPanel** 卡片呈現，顯示：
- 選項列表與推薦排序
- 各選項的預期 KPI 影響
- AI 生成的協商建議與證據支持

---

## 15. 主動警示系統

### 15.1 警示類型

| 類型 | 說明 |
|------|------|
| **stockout_risk** | 品項面臨斷料風險 |
| **supplier_delay** | 供應商交期延遲 |
| **dual_source_rec** | 建議啟用雙源採購 |
| **expedite_rec** | 建議啟用加急採購 |

### 15.2 警示監控

- **AlertMonitorService** 預設每 5 分鐘輪詢一次
- 偵測到新警示時自動推送到對話區域
- 以 **ProactiveAlertCard** 或 **PODelayAlertCard** 卡片呈現

### 15.3 供應商事件連接器

**SupplierEventConnectorService** 接收外部供應商事件：

| 事件類型 | 說明 |
|---------|------|
| **delivery_delay** | 交貨延遲 |
| **quality_alert** | 品質警示 |
| **capacity_change** | 產能變動 |
| **force_majeure** | 不可抗力 |
| **shipment_status** | 出貨狀態更新 |
| **price_change** | 價格變動 |

接收事件後自動：
1. 計算風險分數差異
2. 觸發重規劃評估
3. 在對話中推送警示

---

## 16. 計畫治理與審批

### 16.1 審批流程

1. 計畫完成後顯示 **PlanApprovalCard** 或 **EnhancedPlanApprovalCard**
2. 使用者可以：
   - **核准 (Approve)**：計畫進入執行狀態
   - **駁回 (Reject)**：附註駁回原因
   - **要求修改**：提出修改建議
3. 核准後觸發計畫回寫 (Writeback)，更新為新的基線計畫

### 16.2 期限追蹤

- **ApprovalWorkflowService** 追蹤審批期限
- 接近期限時推送 **ApprovalReminderCard** 提醒
- 支援批次核准/駁回操作

### 16.3 稽核日誌

所有計畫生命週期事件均記錄到 `di_plan_audit_log`：
- `plan_generated` — 計畫生成
- `plan_approved` — 計畫核准
- `plan_rejected` — 計畫駁回
- `scenario_run` — 情境分析執行
- `risk_triggered` — 風險觸發

每筆稽核記錄包含 KPI 快照、操作人員、時間戳。

---

## 17. 閉環自動化

### 17.1 啟用方式

設定環境變數 `VITE_DI_CLOSED_LOOP=true` 啟用閉環管線。

### 17.2 運作模式

| 模式 | 說明 |
|------|------|
| **dry_run** | 僅評估觸發條件，不執行重規劃 |
| **manual_approve** | 評估觸發條件，產生建議，待使用者核准後執行 |
| **auto_run** | 評估觸發條件，自動執行重規劃 |

### 17.3 閉環管線流程

```
評估觸發條件 → 推導參數 → [可選] 自動提交重規劃
```

**觸發條件類型：**
- 預測準確度下降（MAPE 超過閾值）
- 資料漂移偵測
- 風險分數變化
- 供應商事件觸發

**冷卻機制：** 避免過度頻繁觸發，設有冷卻時間間隔。

---

## 18. SAP 整合

### 18.1 資料同步

系統透過五個 Supabase Edge Function 與 SAP S/4HANA 同步：

| 功能 | SAP 服務 | 同步內容 |
|------|---------|---------|
| `sync-materials-from-sap` | API_MATERIAL_DOCUMENT_SRV | 物料主檔 |
| `sync-bom-from-sap` | — | BOM 結構 |
| `sync-inventory-from-sap` | — | 庫存快照 |
| `sync-demand-fg-from-sap` | API_PLND_INDEP_RQMT_SRV | 計畫獨立需求 |
| `sync-po-open-lines-from-sap` | — | 未結訂單 |

### 18.2 排程

- 透過 `etl-scheduler` Edge Function 排程
- 預設：每日 UTC 02:00 執行
- 可透過 `ETL_CRON_SCHEDULE` 環境變數自訂排程
- 同步順序：物料 → BOM → 庫存 → 需求 → PO

---

## 19. 常見問題 (FAQ)

### Q1: 上傳的 Excel 檔案需要什麼格式？
支援 `.xlsx` 和 `.csv` 格式。Excel 可包含多個工作表，系統會自動辨識各工作表的資料類型。欄位名稱不需完全符合標準格式，AI 會自動對應。

### Q2: ML API 未啟動時還能規劃嗎？
可以。當 Python ML API 無法連線時，系統會自動降級使用 JavaScript 啟發式求解器 (runLocalHeuristic)。預測功能則需要 ML API 支持。

### Q3: 求解器執行很久怎麼辦？
MILP 求解器有內建超時機制。若超時，會回傳可行但可能非最優的解。也可在環境變數中切換到啟發式求解器 (`DI_SOLVER_ENGINE=heuristic`) 以獲得更快的回應。

### Q4: 如何匯出計畫結果？
工作流程完成後，**DownloadsCard** 提供 CSV 和 JSON 格式的下載。也可在預測工作室中匯出 Excel 報表。

### Q5: 支援多工廠規劃嗎？
是的。求解器原生支援多工廠、多 SKU 的補貨規劃，包含跨廠的庫存平衡與約束條件。

### Q6: 如何啟用企業級求解器（CPLEX/Gurobi）？
在伺服器環境安裝 CPLEX 或 Gurobi 授權後，設定 `DI_SOLVER_ENGINE=cplex` 或 `DI_SOLVER_ENGINE=gurobi`。系統會自動偵測可用的求解器引擎。

### Q7: 資料安全性如何保障？
- 認證透過 Supabase Auth（行業標準 JWT）
- API 金鑰儲存於 Supabase Secrets（不暴露在前端）
- AI 請求統一透過 AI Proxy Edge Function 代理
- 支援角色型存取控制 (RBAC)

---

*本文件由 Decision Intelligence 團隊維護。如有疑問，請聯繫系統管理員。*
