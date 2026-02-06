# Risk–Forecast Linkage 最小規格（Step 1）

本文件定義 **Risk Dashboard 與 Forecast Run / component_demand 連動** 的 Step 1 最小規格，不一次做到完美，僅確保「資料線接上」與「Inventory 指標可顯示」。

---

## 1. 目標

- Risk 的輸入除既有 **po_open_lines、inventory_snapshots、fg_financials** 外，可選用 **component_demand** 作為需求/消耗來源。
- 透過 **forecast_run_id** 指定使用哪一次 BOM Explosion 的結果；未選時預設 **latest run**。
- Risk 輸出除既有 Supply Coverage、Profit at Risk 外，補上 **P(stockout)**、**daysToStockout**（當有 component_demand 時），並保留 **可追溯性**（forecast_run_id + component_demand_trace）。

---

## 2. 輸入規格

| 輸入 | 說明 | 必填 |
|------|------|------|
| **forecast_run_id** | 選用 Run；預設為「Latest run」（即最近一筆 `forecast_runs`） | 否（可選） |
| **component_demand** | 依 `forecast_run_id` 查詢，欄位：`material_code`, `plant_id`, `time_bucket`, `demand_qty` | 當有選 Run 時查詢 |
| **inventory_snapshots** | 既有；用於 on_hand_qty、safety_stock | 否 |
| **po_open_lines** | 既有；Supply Coverage 必需 | 是 |
| **fg_financials** | 既有；Profit at Risk | 否 |

- **查詢語句（component_demand）**  
  `supabase.from('component_demand').select('material_code, plant_id, time_bucket, demand_qty').eq('user_id', userId).eq('forecast_run_id', forecastRunId)`

- **彙總規則**  
  - 依 `(material_code, plant_id)` 彙總：同一 key 之 `demand_qty` 加總（key 正規化：trim + upper）。  
  - **需求→日需求推導規則**（優先從 run 參數推導，避免常數假設）：
    - **time_bucket 定義**：視為 **week bucket**（一 bucket = 7 天）；若未來支援 date bucket 需另訂轉換規則。
    - **horizon 長度（天）** 推導優先順序：
      1. **run 參數**：`forecast_runs.parameters.time_buckets`（陣列）→ `horizonDays = time_buckets.length * 7`
      2. **固定 horizon**：未提供 time_buckets 時使用 Risk 的 `horizonBuckets`（預設 3）→ `horizonDays = horizonBuckets * 7`
      3. **fallback**：從該 run 的 component_demand 實際出現的 **unique time_bucket 數量** 推導 → `horizonDays = bucketCount * 7`（最少 1 天）
    - **日均需求**：`dailyDemand = totalDemandQty / horizonDays`

---

## 3. 輸出規格

| 輸出 | 說明 |
|------|------|
| **P(stockout)** | 斷料機率；當有 component_demand 時由 Inventory domain `calculateStockoutProbability` 計算，否則以 status 推估（CRITICAL/WARNING/OK） |
| **daysToStockout** | 距離斷料天數；當有 component_demand 時由 Inventory domain `calculateDaysToStockout` 計算，否則顯示為「—」 |
| **Profit at Risk** | 既有；不變 |
| **Explainability（Step 1 最小）** | 至少列出 **top drivers**：例如 Risk Table/Details 可顯示該筆對應的 **Forecast Run**、**Next time bucket**、**Gap qty**、**Inbound count**；追溯則透過 forecast_run_id → component_demand_trace（見下節） |

---

## 4. 可追溯性（Traceability）

- **每筆 Risk 結果** 必須能追溯到：
  - **forecast_run_id**：頁面顯示「Risk based on Forecast Run: &lt;scenario_name&gt; (&lt;id 前 8 碼&gt;)」。
  - **component_demand_trace**：同一 run 下，可透過「Planning → Forecasts → 選 BOM Explosion 批次 → Trace tab」查看 FG → Component 的展開；或日後在 Risk Details 提供「查看該料號/該 Run 的 trace」連結。

Step 1 不強制在 Risk 內嵌 trace 查詢，但 **forecast_run_id** 必須與結果一併顯示，且可從 Import History / Forecasts 頁依 batch ↔ run 對應查到對應的 component_demand 與 component_demand_trace。

---

## 5. UI 行為（最小）

- **Forecast Run 選擇**：下拉選單，選項包含「Latest run」與近期 `forecast_runs` 列表（顯示 scenario_name + created_at）。
- **無 Run / 該 Run 無 component_demand**：不擋住載入；Days to stockout / P(stockout) 顯示「—」或說明「該 Forecast Run 無 component_demand 資料，無法計算」。
- **Risk Table**：欄位含 **Days to stockout**（有值時顯示天數，否則「—」）。
- **Details Panel**：顯示 **Days to stockout**、**Shortage date**（若有）、**Stockout probability**；並可標示資料來源為「Inventory domain (component_demand)」。

---

## 6. 實作對照（檔案／關鍵處）

| 項目 | 檔案／位置 |
|------|------------|
| forecast_run_id 選單與預設 latest | `src/views/RiskDashboardView.jsx`：state `selectedForecastRunId`、`forecastRunsList`；載入時 `forecastRunsService.listRuns`，預設 `runId = selectedForecastRunId \|\| runsList[0]?.id` |
| 查 component_demand 依 run_id | `src/services/supabaseClient.js`：`componentDemandService.getComponentDemandsByForecastRun(userId, forecastRunId)` |
| 彙總 (material, plant) → dailyDemand | `src/utils/componentDemandAggregator.js`：`aggregateComponentDemandToDaily(rows, horizonBuckets)` |
| Risk 管線接上 demand + Inventory 計算 | `src/views/RiskDashboardView.jsx`：載入 component_demand 後彙總，對每筆 domain row 用 `calculateInventoryRisk` 寫入 `daysToStockout`、`stockoutProbability` |
| UI 顯示 daysToStockout / P(stockout) | `src/components/risk/mapDomainToUI.js`：`mapSupplyCoverageToUI` 讀取 `domainResult.daysToStockout`、`domainResult.stockoutProbability`；Table/Details 顯示於 `RiskTable.jsx`、`DetailsPanel.jsx` |
| 顯示「Risk based on Forecast Run」 | `src/views/RiskDashboardView.jsx`：header 副標題依 `activeForecastRun` 顯示 |

---

## 7. Lead time 來源邏輯（A2）

P(stockout) 計算需使用 **leadTimeDays**（補貨提前期，天）。優先順序：

1. **suppliers.lead_time_days**：依 PO 的 `supplier_id` 對應至 `suppliers.id`，取該供應商的 `lead_time_days`（若存在且 ≥ 0）。
2. **fallback**：無 PO、或該 PO 無 supplier_id、或 suppliers 無該筆、或 `lead_time_days` 為空/負值時，使用 **系統預設值**（目前 7 天）。

同一 (material, plant) 若有多筆 PO，以「先出現的 PO」對應之 supplier 為準。UI 須標示本筆使用的 **leadTimeDaysUsed** 與 **leadTimeDaysSource**（`supplier` / `fallback`），Details 顯示「Lead time（本筆 P(stockout) 用）」及「(預設)」當來源為 fallback。

---

## 8. 後續可擴充（非 Step 1）

- 在 Details 內依 `forecast_run_id` + `material_code` / `plant_id` 查詢並顯示 **component_demand_trace** 片段。
- 支援「無 Run」模式時仍顯示 Supply Coverage + PaR，僅 Days to stockout / P(stockout) 為「—」或說明文字（已實作）。
- Explainability：結構化列出 top drivers（例如：缺貨主因 = 無入庫 / 需求大於庫存 等）。
