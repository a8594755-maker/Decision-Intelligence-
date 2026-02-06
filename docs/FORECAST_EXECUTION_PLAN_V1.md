# Forecast 完成計畫書（Execution Plan v1）

## 0. 目標與完成定義

### 0.1 專案目標

把目前已完成的 **BOM-Derived Forecast（#2）+ Forecast Runs**，擴展成「能驅動 Risk 的決策閉環」，並逐步補齊六個 Forecast Suite。

### 0.2 「Forecast 完成」定義（對外說法）

每個 Forecast 類型要達成三層才算 **Done**：

| 層級 | 內容 |
|------|------|
| **Engine 層** | 計算正確、可重跑 |
| **Traceability 層** | 可追溯輸入與版本（run / 參數 / 來源） |
| **Product 層** | UI 能用、可比較、可驗收（含錯誤 / 空態 / 效能） |

---

## 1. 現況基線（目前已完成的）

Step 1（Forecast → Risk linkage 第一版）已完成，包含：

- Risk Dashboard 可選 `forecast_run_id`，載入 `component_demand`
- `componentDemandAggregator` 產出 `dailyDemand`（目前以 `horizonBuckets × 7`）
- Risk pipeline 接上 inventory domain 的 **daysToStockout / P(stockout)** 並顯示到 Table / Details
- Spec 文件（`docs/RISK_FORECAST_LINKAGE.md`）與 8-step acceptance（`docs/RISK_FORECAST_ACCEPTANCE.md`）
- Aggregator unit test（`src/utils/componentDemandAggregator.test.js`）

**結論：** 閉環雛形已打通；下一步為「正確性 / 一致性 / 效能 / 可維運」補齊，再進入下一個 Forecast（Supply / Demand / Inventory dynamics）。

---

## 2. Milestone 一覽

| 代號 | 名稱 | 目標 |
|------|------|------|
| **A** | Step 1 穩定化（Correctness + Consistency） | 從「能跑」提升到「可信 / 可稽核 / 不會算歪」 |
| **B** | Step 1 可靠性（Performance + UX + Failure Modes） | 資料量大不炸、空態不誤導、run 語意清楚 |
| **C** | Forecast #4 Inventory Forecast 升級 | 靜態 daysToStockout → 按 bucket 推演 Inv(t+1) |
| **D** | Forecast #3 Supply Forecast 最小化 | lead time / delay probability（rule-based） |
| **E** | Demand Forecast MVP | #1 從上傳資料 → baseline forecast 產出 |

---

## 3. Milestone A：Step 1 穩定化

### A1. 需求彙總規則改成「從 run 參數推導」

| 項目 | 內容 |
|------|------|
| **要做什麼** | 目前 `dailyDemand = totalQty / (horizonBuckets*7)` 假設 bucket=週。改為從 `forecast_runs.parameters.time_buckets` 或實際 component_demand 的 bucket 數推導 horizon 長度；明確定義 time_bucket 為 week bucket（或 date bucket 轉換規則）。 |
| **交付物** | ① 文件：更新 `docs/RISK_FORECAST_LINKAGE.md` 的「需求→日需求推導規則」<br>② Code：aggregator 支援 `timeBuckets`（run.parameters.time_buckets）或 unique time_bucket count（從 rows 算）<br>③ Test：2–3 組（不同 bucket 數、缺 timeBuckets fallback） |
| **驗收標準** | ① 同一份 component_demand，改 horizon bucket 數，dailyDemand 等比變化且可預期<br>② UI 顯示的 daysToStockout 能手算抽查通過（抽 3 筆） |

### A2. leadTimeDays 來源正規化（不再硬寫 7）

| 項目 | 內容 |
|------|------|
| **要做什麼** | 實作 leadTimeDays 優先順序：① suppliers.lead_time_days（若存在且能 join 到 material/supplier）② 從 PO 推估（promised/confirmed 或 time_bucket）③ fallback 系統預設（可設定）。UI 顯示本筆使用的 leadTimeDays（Explainability）。 |
| **交付物** | ① Code：Risk pipeline 產出 `leadTimeDaysUsed`（row/details）<br>② UI：DetailsPanel 顯示 leadTimeDaysUsed<br>③ 文件：spec 補上 lead time 來源邏輯 |
| **驗收標準** | ① Details 能回答「這筆 P(stockout) 用幾天 lead time」<br>② supplier lead time 缺失時，系統清楚標示 fallback 值 |

### A3. Key 對齊與正規化（material_code / plant_id）

| 項目 | 內容 |
|------|------|
| **要做什麼** | Risk pipeline 所有 key 正規化統一（trim + upper）；material_code / plant_id 一致；若有 material_id 需落回 material_code 或 mapping。 |
| **交付物** | ① util：集中 `normalizeKey(material, plant)`（或等價）<br>② component_demand / inventory_snapshot / po_open_lines 讀取後都用同一 normalize<br>③ debug 模式：列出「找不到對應 demand 的 inventory rows」count、「找不到對應 inventory 的 demand keys」count |
| **驗收標準** | ① 同一 plant 下 ≥90% keys 能匹配（實際資料抽樣）<br>② mismatch 有可追蹤數字，不會默默算成 Infinity/— |

---

## 4. Milestone B：Step 1 可靠性

### B1. component_demand 查詢收斂（避免全表拉回）

| 項目 | 內容 |
|------|------|
| **要做什麼** | 只選必要欄位；依 `parameters.time_buckets` 限制 `time_bucket in (...)` 或依 plant/material 篩選；可選：彙總搬到 DB（view/RPC 回 aggregated daily demand per material+plant）。 |
| **交付物** | ① 量測：fetch rows count、fetch time、aggregate time（console.time 或 log）<br>② 若改 DB：migration + view/rpc + service 改呼叫新端點 |
| **驗收標準** | ① 大 run（≥10 萬 component_demand row）合理時間載入、不白屏/崩潰<br>② UI 有 loading 與超時提示（可顯示「資料過大，請縮小範圍」） |

### B2. UI 語意一致（run / supply-only / no-demand）

| 項目 | 內容 |
|------|------|
| **要做什麼** | 三種狀態清楚：① 有 run 且有 component_demand → 顯示 daysToStockout/P(stockout) ② 有 run 但 component_demand=0 → 提示，risk 只顯示 supply coverage ③ 沒有任何 run → supply coverage only，引導去 Forecasts 跑 BOM Explosion。 |
| **交付物** | ① RiskDashboard 顯示「Demand source: component_demand (N rows)」等 demand 狀態<br>② DetailsPanel 顯示 run、leadTimeDaysUsed、dailyDemandUsed（可選） |
| **驗收標準** | ① 使用者不會把 supply-only 誤認為含 demand<br>② 空態提示無矛盾文案 |

### B3. 最小整合測試（防回歸）

| 項目 | 內容 |
|------|------|
| **要做什麼** | 「Risk linkage」整合測試（可 mock）：mock component_demand + inventory + fg_financials；assert Risk row 有 daysToStockout、P(stockout)、PaR；至少覆蓋有 demand / 無 demand。 |
| **交付物** | ① 一個 test file（或既有測試框架等價）<br>② CI 可跑 |
| **驗收標準** | 改 mapping 或 calculator 不會把 daysToStockout 默默打回「—」而沒人發現 |

---

## 5. Milestone C：Forecast #4 Inventory Forecast 升級

### C1. 建立 Inventory Projection Engine（按 bucket）

| 項目 | 內容 |
|------|------|
| **要做什麼** | 輸入：初始庫存（inventory_snapshots）、inbound（po_open_lines）、demand（component_demand 按 bucket）。輸出：每 bucket projected_on_hand、stockout_bucket/stockout_date、shortage_qty（可選）。先 deterministic，不做 Monte Carlo。 |
| **交付物** | ① domain module：inventoryProjection（純函式）<br>② 測試：3–5 組（正常、提前入庫、需求暴增、無入庫） |
| **驗收標準** | ① Risk Details 能展示「未來每週庫存曲線」或至少 stockout bucket/shortage date 為推演結果<br>② 與原 daysToStockout 公式不矛盾（同情境大致一致） |

---

## 6. Milestone D：Forecast #3 Supply Forecast 最小化

### D1. 延遲機率 MVP（rule-based）

| 項目 | 內容 |
|------|------|
| **要做什麼** | rule-based：依 supplier lead_time_days、過去 on-time 表現（無則常數）產生 P(delay)。Supply forecast 輸出：expected inbound bucket（或 distribution）、delay probability。 |
| **交付物** | ① supply risk module：delayProbabilityCalculator<br>② UI：Risk Details 顯示供應延遲風險來源（supplier lead time / fallback） |
| **驗收標準** | 至少能回答「為什麼這筆 inbound 不可靠」 |

---

## 7. Milestone E：Demand Forecast MVP

### E1. Baseline demand forecast（最簡）

| 項目 | 內容 |
|------|------|
| **要做什麼** | 方法：moving average / ETS（簡單可解釋）。表：demand_forecast（fg, plant, time_bucket, p50, p90/p10 可選, model_version）。UI：Forecasts 頁新增 Demand Forecast tab（可比較 demand_fg vs demand_forecast）。 |
| **驗收標準** | 同一 FG/plant 能看到 forecast 曲線，且可追溯到模型版本/輸入區間 |

---

## 8. 管控與回報格式（Gate 判定用）

每完成一個 **Milestone 的任務**，回報以下 **6 樣**（可逐項回報）：

| # | 項目 | 說明 |
|---|------|------|
| 1 | **變更檔案清單** | 路徑列舉 |
| 2 | **關鍵 diff 摘要** | 貼 10–30 行片段即可 |
| 3 | **驗收結果** | 照文件逐條打勾，至少列出失敗項 |
| 4 | **SQL/查詢結果** | 若有 DB 變更，貼 1–3 個關鍵查詢輸出 |
| 5 | **效能數字** | 載入 ms、rows count、aggregate ms |
| 6 | **已知限制/風險** | 可能出事的點 |

**Gate 回覆格式：**

- ✅ **可合併 / 可上線**
- ⚠️ **Conditional**（列 P0 必修）
- ❌ **不可上線**（列 blocking reasons）

---

## 9. 依賴與邊界

### 9.1 依賴

- `forecast_runs.parameters` 必須可靠（time_buckets / plant_id）
- `component_demand` 粒度清楚（time_bucket 是否為週）
- `suppliers.lead_time_days` 欄位可用性（不行就明確 fallback）

### 9.2 Out of scope（先不要碰）

- Monte Carlo、完整 ML
- 完整 Revenue/Price forecasting（先做 Margin-at-Risk 時間序列再說）
- 全面 observability（可另立 Milestone）

---

## 10. 與既有文件對照

| 文件 | 用途 |
|------|------|
| `docs/RISK_FORECAST_LINKAGE.md` | Risk–Forecast linkage Step 1 規格（需隨 A1/A2 更新） |
| `docs/RISK_FORECAST_ACCEPTANCE.md` | 8 步驗收腳本（demo 用） |
| 本文件 `FORECAST_EXECUTION_PLAN_V1.md` | 執行計畫與 Gate 回報依據 |
