# BOM Explosion MVP 實作完成報告

## 概述

已完成「Component / BOM-Derived Forecast（BOM 展開需求）」MVP 的 Step A 實作，將文件規格轉換為可上傳、可驗證、可落地的系統功能。

---

## 交付物清單

### 1. 模板文件（4 個文件）

✅ **templates/bom_edge.xlsx** - BOM 關係表 Excel 模板  
✅ **templates/bom_edge.csv** - BOM 關係表 CSV 模板  
✅ **templates/demand_fg.xlsx** - FG 需求表 Excel 模板  
✅ **templates/demand_fg.csv** - FG 需求表 CSV 模板

**模板特點**：
- 包含完整 header（所有欄位名稱，使用 snake_case）
- 包含 5+ 筆示例資料（與 Spec 一致）
- Excel 版本無合併儲存格，日期格式為 YYYY-MM-DD
- CSV 使用 UTF-8 編碼
- 包含替代料範例（bom_edge）
- 包含 week_bucket 和 date 兩種時間格式範例（demand_fg）

---

### 2. 前端 Upload Schema（已更新）

✅ **src/utils/uploadSchemas.js**

新增兩個 Upload Type：
- `bom_edge` - BOM 關係表（16 個欄位，3 個必填）
- `demand_fg` - FG 需求表（13 個欄位，4 個必填）

**欄位定義**：
- 必填欄位標記為 `required: true`
- 資料類型：`string`, `number`, `date`
- 包含驗證規則（min, max, default）
- 包含中英雙語描述

---

### 3. 資料驗證與清理（已更新）

✅ **src/utils/dataValidation.js**

新增驗證邏輯：

**bom_edge 驗證**：
- `parent_material` / `child_material` 不可為空
- `qty_per > 0`（必須大於 0）
- `scrap_rate` 範圍：`0 <= scrap_rate < 1`（可選欄位，有填才驗）
- `yield_rate` 範圍：`0 < yield_rate <= 1`（可選欄位，有填才驗）
- `valid_from <= valid_to`（日期邏輯驗證）

**demand_fg 驗證**：
- `material_code` 不可為空
- `plant_id` 不可為空
- `demand_qty >= 0`
- **時間欄位處理**：
  - 允許 `week_bucket` 或 `date` 其中一個有值
  - 若兩者都有，優先使用 `date`
  - 系統自動生成/填入 `time_bucket`（統一時間鍵）
  - `week_bucket` 格式驗證：`YYYY-W##`（例如：2026-W02）

---

### 4. Supabase Client Services（已更新）

✅ **src/services/supabaseClient.js**

新增服務：

**bomEdgesService**：
- `batchInsert(userId, bomEdges, batchId)` - 批量插入 BOM 關係
- `getBomEdges(userId, options)` - 查詢 BOM 關係

**demandFgService**：
- `batchInsert(userId, demands, batchId)` - 批量插入 FG 需求
- `getDemands(userId, options)` - 查詢 FG 需求

**預留服務（Stub）**：
- `componentDemandService` - Component 需求服務（預留）
- `componentDemandTraceService` - Component 需求追溯服務（預留）

---

### 5. 上傳寫入流程（已更新）

✅ **src/views/EnhancedExternalSystemsView.jsx**

**更新內容**：
1. 在 `targetTableMap` 中新增：
   - `bom_edge -> bom_edges`
   - `demand_fg -> demand_fg`

2. 在 `handleSave` 中新增兩個寫入分支：
   - `saveBomEdges(userId, rowsToSave, batchId)`
   - `saveDemandFg(userId, rowsToSave, batchId)`

3. 導入新服務：
   - `bomEdgesService`
   - `demandFgService`

**寫入流程**：
- 創建 `import_batches` 記錄（批次追溯）
- 保存原始文件到 `user_files` 表
- 批量插入資料到目標表（`bom_edges` 或 `demand_fg`）
- 更新批次狀態為 `completed`
- 保存欄位映射模板（供下次使用）

**資料自動帶入**：
- `user_id` - 從當前登入使用者取得
- `batch_id` - 從 `import_batches` 記錄取得
- `created_at` - 系統自動產生

---

### 6. Supabase Schema SQL

✅ **database/bom_forecast_schema.sql**

**建立的表**：

1. **bom_edges** - BOM 關係表
   - 核心欄位：`parent_material`, `child_material`, `qty_per`
   - 進階欄位：`scrap_rate`, `yield_rate`, `alt_group`, `ecn_number` 等
   - 索引：`user_id`, `batch_id`, `parent_material`, `child_material`
   - RLS：啟用 + policy（`user_id = auth.uid()`）

2. **demand_fg** - FG 需求表
   - 核心欄位：`material_code`, `plant_id`, `time_bucket`, `demand_qty`
   - 時間欄位：`time_bucket`（統一鍵）, `week_bucket`, `date`
   - 索引：`user_id`, `batch_id`, `material_code`, `time_bucket`
   - RLS：啟用 + policy（`user_id = auth.uid()`）

3. **component_demand** - Component 需求表（預留）
   - 用於下一步 BOM explosion 計算結果
   - 已建立表結構，暫不寫入資料

4. **component_demand_trace** - Component 需求追溯表（預留）
   - 用於追溯 Component 需求來源
   - 已建立表結構，暫不寫入資料

**所有表都包含**：
- `id` (UUID, PRIMARY KEY)
- `user_id` (UUID, REFERENCES auth.users)
- `batch_id` (UUID, 用於追溯)
- `created_at` (TIMESTAMPTZ)
- `updated_at` (TIMESTAMPTZ, 自動更新)

---

## 手動驗證步驟

### Step 1: 執行 SQL Schema

1. 登入 Supabase Dashboard
2. 進入 SQL Editor
3. 執行 `database/bom_forecast_schema.sql`
4. 確認 4 張表都已建立

**驗證 SQL**：
```sql
-- 檢查表是否存在
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('bom_edges', 'demand_fg', 'component_demand', 'component_demand_trace');

-- 檢查 RLS 是否啟用
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename IN ('bom_edges', 'demand_fg');
```

---

### Step 2: 上傳 bom_edge 模板

1. 開啟 SmartOps 應用程式
2. 導航到 **Data Upload (External Systems)** 頁面
3. 選擇 Upload Type：**BOM Edge**
4. 上傳 `templates/bom_edge.xlsx` 或 `templates/bom_edge.csv`
5. 完成欄位映射（系統會自動偵測，如欄位名稱一致）
6. 驗證資料：
   - 應該看到 6 筆有效資料（Valid Rows = 6）
   - 檢查是否有錯誤（Error Rows = 0）
7. 點擊 **Save** 按鈕
8. 確認成功訊息：`Successfully saved 6 rows`

**驗證資料庫**：
```sql
-- 檢查資料是否寫入
SELECT * FROM bom_edges 
WHERE user_id = auth.uid() 
ORDER BY created_at DESC 
LIMIT 10;

-- 檢查批次記錄
SELECT * FROM import_batches 
WHERE upload_type = 'bom_edge' 
ORDER BY created_at DESC 
LIMIT 1;
```

---

### Step 3: 上傳 demand_fg 模板

1. 在 **Data Upload** 頁面
2. 選擇 Upload Type：**Demand FG**
3. 上傳 `templates/demand_fg.xlsx` 或 `templates/demand_fg.csv`
4. 完成欄位映射
5. 驗證資料：
   - 應該看到 7 筆有效資料（Valid Rows = 7）
   - 檢查 `time_bucket` 欄位是否正確填入（從 `week_bucket` 或 `date`）
6. 點擊 **Save** 按鈕
7. 確認成功訊息：`Successfully saved 7 rows`

**驗證資料庫**：
```sql
-- 檢查資料是否寫入
SELECT * FROM demand_fg 
WHERE user_id = auth.uid() 
ORDER BY created_at DESC 
LIMIT 10;

-- 檢查 time_bucket 是否正確填入
SELECT material_code, time_bucket, week_bucket, date, demand_qty 
FROM demand_fg 
WHERE user_id = auth.uid() 
ORDER BY time_bucket;
```

---

### Step 4: 驗證 Import History

1. 導航到 **Import History** 頁面
2. 應該看到兩筆新的批次記錄：
   - `bom_edge` - 6 rows
   - `demand_fg` - 7 rows
3. 點擊批次記錄，確認可以查看詳細資訊

---

## 常見問題排查

### Q1: 上傳時顯示 "Unsupported upload type"

**原因**：前端未正確載入新的 schema  
**解決**：
1. 確認 `src/utils/uploadSchemas.js` 已更新
2. 重新啟動開發伺服器：`npm run dev`
3. 清除瀏覽器快取

---

### Q2: 驗證時 time_bucket 為空

**原因**：`week_bucket` 和 `date` 都為空，或格式不正確  
**解決**：
1. 確認至少填寫 `week_bucket` 或 `date` 其中一個
2. `week_bucket` 格式必須為 `YYYY-W##`（例如：2026-W02）
3. `date` 格式必須為 `YYYY-MM-DD`（例如：2026-01-08）

---

### Q3: 寫入資料庫時出現 RLS 錯誤

**原因**：Row Level Security policy 未正確設定  
**解決**：
1. 確認已執行 `database/bom_forecast_schema.sql`
2. 確認使用者已登入（`auth.uid()` 不為 null）
3. 檢查 RLS policy 是否正確建立：
```sql
SELECT * FROM pg_policies 
WHERE tablename IN ('bom_edges', 'demand_fg');
```

---

### Q4: qty_per 驗證失敗

**原因**：`qty_per` 必須 > 0  
**解決**：
1. 確認 `qty_per` 欄位值大於 0
2. 檢查是否有負數或 0 值
3. 確認欄位映射正確（Excel 欄位對應到 `qty_per`）

---

## 下一步（預留功能）

以下功能已預留表結構，待後續實作：

1. **BOM Explosion 計算**：
   - 使用 `bom_edges` 和 `demand_fg` 計算 `component_demand`
   - 支援多層 BOM 展開
   - 考慮 `scrap_rate` 和 `yield_rate`

2. **需求追溯**：
   - 使用 `component_demand_trace` 追溯 Component 需求來源
   - 支援從 Component 追溯到 FG 需求

3. **替代料分配**：
   - 使用 `alt_group`, `priority`, `mix_ratio` 進行替代料分配

---

## 檔案修改清單

### 新增檔案
- `templates/bom_edge.xlsx`
- `templates/bom_edge.csv`
- `templates/demand_fg.xlsx`
- `templates/demand_fg.csv`
- `scripts/generate_templates.js`
- `database/bom_forecast_schema.sql`
- `BOM_EXPLOSION_IMPLEMENTATION.md`

### 修改檔案
- `src/utils/uploadSchemas.js` - 新增兩個 Upload Type
- `src/utils/dataValidation.js` - 新增驗證邏輯（含 time_bucket 處理）
- `src/services/supabaseClient.js` - 新增服務（bomEdgesService, demandFgService）
- `src/views/EnhancedExternalSystemsView.jsx` - 新增寫入邏輯

---

## 完成狀態

✅ **所有任務已完成**

- [x] 模板文件（Excel + CSV）
- [x] Upload Schema 定義
- [x] 資料驗證邏輯
- [x] Supabase 服務
- [x] 上傳寫入流程
- [x] 資料庫 Schema SQL

---

**實作日期**：2026-01-08  
**版本**：v1.0 MVP  
**狀態**：✅ 完成，可進行測試驗證
