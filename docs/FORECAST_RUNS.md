# Forecast Run 版本化（MVP）

每次執行 BOM Explosion / Forecast 會產生一筆 **forecast_run** 記錄，並將 `forecast_run_id` 寫入輸出表，達到全鏈路可追溯。

---

## 1. 資料表：`forecast_runs`

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | UUID (PK) | 本次執行唯一識別 |
| `created_at` | TIMESTAMPTZ | 建立時間 |
| `created_by` | UUID (FK → auth.users) | 執行者 |
| `scenario_name` | TEXT | 情境名稱，預設 `baseline` |
| `parameters` | JSONB | 參數（如 time_bucket、horizon） |
| `input_batch_ids` | JSONB | 使用的 demand/bom 的 batch_id 或 upload_file_id 陣列 |

- 索引：`created_at DESC`、`created_by`。
- RLS：僅能看／建自己的 run。

---

## 2. 輸出表關聯

- **component_demand**：新增欄位 `forecast_run_id` (UUID, FK → forecast_runs.id)。
- **component_demand_trace**：新增欄位 `forecast_run_id`。

唯一約束（component_demand）改為：  
`(user_id, forecast_run_id, material_code, plant_id, time_bucket)`。  
同一份輸入跑兩次會產生不同 `forecast_run_id`，因此可重跑、可比較多個 run。

---

## 3. 寫入流程

1. 執行 BOM Explosion 時，先呼叫 **forecastRunsService.createRun** 建立一筆 `forecast_runs`，取得 `forecast_run_id`。
2. 計算結果寫入 **component_demand**、**component_demand_trace** 時，每筆都帶入該 `forecast_run_id`。
3. `import_batches` 的 metadata 可選寫入 `forecast_run_id`，方便從匯入歷史反查 run。

---

## 4. 追溯鏈

- **forecast_run_id** → **forecast_runs**（parameters、input_batch_ids）  
- **forecast_run_id** → **component_demand** / **component_demand_trace**（該次 run 的輸出）

同一輸入跑兩次 = 兩個 run_id，兩組輸出並存，不覆蓋。

---

## 5. Risk Dashboard 與 run_id

- 目前 Risk 計算使用 **po_open_lines、inventory_snapshots、fg_financials**，未直接讀 **component_demand**。
- **最小實作**：日後若 Risk 改為使用「某次 Forecast 的 component 需求」，可在查詢時加上 **forecast_run_id** 篩選，只取該 run 的結果。
- 實作方式：在 Risk 載入邏輯或 API 增加可選參數 `forecast_run_id`，過濾 component_demand（或相關彙總）即可。

---

## 6. 部署順序

1. 執行 **sql/migrations/forecast_runs_and_run_id.sql**（建立 `forecast_runs`、新增 `forecast_run_id`、backfill 舊資料、更新唯一約束）。
2. 部署應用（bomExplosionService 已會建立 run 並寫入 `forecast_run_id`）。

若尚未執行 migration，`forecast_runs` 表不存在時，服務會 catch 錯誤並繼續執行，該次結果的 `forecast_run_id` 為 null（舊行為）。

---

## 7. 驗收對照

| 項目 | 說明 |
|------|------|
| 任一 forecast 結果可追溯 | forecast_run_id → inputs (parameters + batch ids) → outputs |
| 同一輸入跑兩次產生不同 run_id | 每次 createRun 產生新 id，寫入不同 run 的輸出 |
| 不改動引擎核心正確性 | 僅在服務層加「建 run + 帶 run_id 寫入」，Domain 計算邏輯不變 |
