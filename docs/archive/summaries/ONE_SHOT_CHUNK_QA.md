# One-shot Import with Chunking: 最小驗收指令

## 目標
驗證 One-shot Import 能處理 >1000 rows、支援 chunk 分批寫入、具備 idempotency、可 abort、並能下載報告。

---

## A) 靜態驗收

### 1. Build 檢查
```bash
npm run build
```
**預期結果：** build 成功，無編譯錯誤

### 2. Linter 檢查（如果有 eslint script）
```bash
npm run lint
```
**預期結果：** 無 critical errors（警告可忽略）

---

## B) 手動功能驗收

### 1. 準備測試資料

#### 1.1 建立 >1000 rows 的測試 sheet
- **檔案名稱：** `test_demand_fg_2000rows.xlsx`
- **Sheet name:** `Demand FG`
- **欄位：** material_code, time_bucket, demand_qty, plant_id, uom
- **行數：** 至少 2000 rows

範例（使用 Excel 或 Python 生成）：
```python
import pandas as pd

data = {
    'material_code': [f'MAT{i:04d}' for i in range(1, 2001)],
    'time_bucket': ['2026-W10'] * 2000,
    'demand_qty': [100 + i for i in range(2000)],
    'plant_id': ['P001'] * 2000,
    'uom': ['EA'] * 2000
}

df = pd.DataFrame(data)
df.to_excel('test_demand_fg_2000rows.xlsx', sheet_name='Demand FG', index=False)
```

#### 1.2 建立混合成功/失敗的測試檔案
- **檔案名稱：** `test_mixed_sheets.xlsx`
- **Sheet 1 (正常):** `BOM Edge` with valid data (500 rows)
- **Sheet 2 (正常):** `Demand FG` with valid data (300 rows)
- **Sheet 3 (故意錯誤):** `PO Open Lines` with missing required fields (應被 skipped)

---

### 2. 部署 DB Migration（必做！）

前往 Supabase Dashboard → SQL Editor，執行：
```sql
-- 複製並執行 database/one_shot_chunk_idempotency.sql 的完整內容
```

**驗證 migration 成功：**
```sql
-- 檢查 ingest_sheet_runs 表是否建立
SELECT * FROM public.ingest_sheet_runs LIMIT 1;

-- 檢查 RPC function 是否可用
SELECT public.check_ingest_key_support();
```
預期：`check_ingest_key_support()` 回傳 `true`

---

### 3. 啟動開發環境
```bash
npm run dev
```

---

### 4. 測試案例

#### Test Case 1: >1000 rows chunk ingest（正常流程）

**步驟：**
1. 前往 Data Upload 頁面
2. 勾選 "One-shot Import（多 sheets）"
3. 上傳 `test_demand_fg_2000rows.xlsx`
4. 確認 Sheet Plans 顯示：
   - Sheet name: `Demand FG`
   - Suggested type: `demand_fg`
   - Confidence: >75%
   - Enabled: ✓
5. 選擇 Chunk Size: `500`
6. 點擊 `Import Enabled Sheets`
7. 觀察進度條：
   - 應顯示 "Sheet 1 / 1"
   - 應顯示 "Chunk 1/4", "Chunk 2/4", ... "Chunk 4/4"
   - 應顯示 "X rows saved" 遞增
8. 匯入完成後：
   - Summary 顯示：Succeeded: 1, Total: 1
   - 點擊 "Download Report (JSON)"，下載並檢查報告內容

**預期結果：**
- ✅ 全部 2000 rows 成功寫入
- ✅ 分為 4 chunks（500 rows each）
- ✅ 無錯誤、無遺漏
- ✅ 報告內包含 `chunks` 陣列，每個 chunk status 為 'success'

**驗證資料庫：**
```sql
SELECT COUNT(*) FROM public.demand_fg WHERE batch_id = '<剛才的 batch_id>';
-- 預期：2000

SELECT * FROM public.ingest_sheet_runs WHERE idempotency_key LIKE '%Demand FG%' ORDER BY created_at DESC LIMIT 1;
-- 預期：status = 'succeeded', saved_rows = 2000
```

---

#### Test Case 2: Abort 中途取消

**步驟：**
1. 重新上傳 `test_demand_fg_2000rows.xlsx`（或更大的檔案，例如 5000 rows）
2. 選擇 Chunk Size: `500`（這樣會有多個 chunk）
3. 點擊 `Import Enabled Sheets`
4. **在進度顯示 "Chunk 1/10" 或 "Chunk 2/10" 時立即點擊 "Abort Import"**
5. 等待系統回應

**預期結果：**
- ✅ UI 顯示 "Import aborted"
- ✅ 進度停止更新
- ✅ Summary 顯示部分 sheet 為 `ABORTED` 或 `FAILED`
- ✅ 資料庫內只有部分 chunk 的資料（例如第 1 chunk 成功、第 2 chunk 開始時被 abort）

**驗證資料庫：**
```sql
SELECT * FROM public.ingest_sheet_runs WHERE status = 'aborted' ORDER BY created_at DESC LIMIT 1;
-- 預期：status = 'aborted', saved_rows < total_rows
```

---

#### Test Case 3: Idempotency（重送同一 sheet 不疊資料）

**步驟：**
1. 上傳 `test_demand_fg_2000rows.xlsx`（第一次）
2. 等待匯入完成，記錄 Summary 中的 `savedCount`（應為 2000）
3. **不要 reset flow，直接重新上傳同一個檔案（同 sheet name、同 uploadType）**
4. 再次點擊 `Import Enabled Sheets`
5. 觀察進度與結果

**預期結果：**
- **A) 若 DB 已部署 idempotency（`check_ingest_key_support = true`）：**
  - ✅ UI 可能顯示 "Sheet already imported, skipping"（若 service 有此邏輯）
  - ✅ 或：系統先刪除舊資料，再重新 insert
  - ✅ 資料庫內該 sheet 的 row count 保持 2000（不會變成 4000）
  
- **B) 若 DB 未部署 idempotency（`check_ingest_key_support = false`）：**
  - ⚠ UI 顯示警告：「DB 未部署 chunk-idempotency，已降級」
  - ⚠ 資料可能重複（row count 變成 4000），但不會 crash

**驗證資料庫：**
```sql
-- 檢查 demand_fg 表內同一 batch 的資料
SELECT COUNT(*) FROM public.demand_fg WHERE batch_id = '<第一次的 batch_id>';
-- 預期（idempotency 開啟）：仍為 2000

-- 檢查 ingest_sheet_runs 記錄
SELECT * FROM public.ingest_sheet_runs WHERE idempotency_key = '<sheet的idempotencyKey>' ORDER BY created_at DESC;
-- 預期：兩筆記錄（第一次、第二次），但第二次可能 skipped 或 succeeded（取決於實作）
```

---

#### Test Case 4: 混合成功/失敗 sheets（錯誤隔離）

**步驟：**
1. 上傳 `test_mixed_sheets.xlsx`（包含 3 sheets：2 正常 + 1 缺欄位）
2. Sheet Plans 應顯示：
   - Sheet 1 (BOM Edge): enabled
   - Sheet 2 (Demand FG): enabled
   - Sheet 3 (PO Open Lines): disabled 或 low confidence（缺必填欄位）
3. 勾選 Sheet 3 但故意不補充欄位（測試錯誤處理）
4. 點擊 `Import Enabled Sheets`
5. 觀察匯入結果

**預期結果：**
- ✅ Sheet 1 (BOM Edge): Succeeded, 500 rows saved
- ✅ Sheet 2 (Demand FG): Succeeded, 300 rows saved
- ❌ Sheet 3 (PO Open Lines): Failed（validation error: missing required fields）
- ✅ Summary 顯示：Succeeded: 2, Failed: 1, Total: 3
- ✅ 報告中包含 Sheet 3 的錯誤原因（例如：`reason: "Missing required field: delivery_date"`）

**驗證資料庫：**
```sql
-- 檢查成功 sheets 的資料是否正常寫入
SELECT COUNT(*) FROM public.bom_edges WHERE batch_id IN (SELECT id FROM public.import_batches WHERE file_name LIKE '%test_mixed_sheets%');
-- 預期：500

SELECT COUNT(*) FROM public.demand_fg WHERE batch_id IN (SELECT id FROM public.import_batches WHERE file_name LIKE '%test_mixed_sheets%');
-- 預期：300

-- 檢查失敗 sheet 的 run 狀態
SELECT * FROM public.ingest_sheet_runs WHERE status = 'failed' AND sheet_name = 'PO Open Lines' ORDER BY created_at DESC LIMIT 1;
-- 預期：status = 'failed', error 包含詳細錯誤訊息（JSON 格式）
```

---

#### Test Case 5: Chunk Size 對 RPC 類型的影響

**步驟：**
1. 準備一個 `goods_receipt` 或 `price_history` 類型的 sheet（這些走 RPC，有 1000 limit）
2. 上傳檔案，選擇 Chunk Size: `1000`（超過 RPC safe limit）
3. 匯入並觀察

**預期結果：**
- ✅ 系統自動 cap chunk size 到 800（console 應有 log：`Chunk size capped to 800 for RPC`）
- ✅ 匯入成功，無 RPC payload too large error

**驗證 Console 輸出：**
```
[ChunkIngest] Sheet "Price History" (price_history): 1500 rows → 2 chunks (size: 800)
```

---

## C) Fallback 驗證

### Fallback 1: DB 未部署 idempotency migration

**模擬步驟：**
1. 在 Supabase SQL Editor 執行：
```sql
-- 暫時停用 check_ingest_key_support（模擬 migration 未部署）
DROP FUNCTION IF EXISTS public.check_ingest_key_support();
```
2. 重新整理 Data Upload 頁面
3. 上傳一個 >1000 rows 的檔案
4. 嘗試匯入

**預期結果：**
- ⚠ UI 顯示警告：「DB 未部署 chunk-idempotency，已降級」
- ⚠ 系統仍可運行，但：
  - chunk size 可能被限制為 <1000（視 fallback 邏輯）
  - 重複上傳會疊資料（無 idempotency）
- ✅ **不會 crash**

**還原環境：**
```sql
-- 重新建立 function（執行 one_shot_chunk_idempotency.sql）
```

---

### Fallback 2: Chunk 全部失敗

**模擬步驟：**
1. 上傳一個資料格式完全錯誤的 sheet（例如：所有欄位都是空的、type 不符）
2. 嘗試匯入

**預期結果：**
- ❌ Summary 顯示：Failed: 1, Succeeded: 0
- ✅ UI 顯示錯誤訊息：「All 4 chunks failed. Check chunk errors for details.」
- ✅ 報告中包含每個 chunk 的錯誤詳情
- ✅ **不會 crash**

---

## D) 最終檢查清單

- [ ] `npm run build` 成功
- [ ] 上傳 >1000 rows sheet 能自動分 chunk 且全部成功
- [ ] Abort 功能可正常中止匯入
- [ ] 重送同一 sheet 不會疊資料（DB 部署 idempotency 時）
- [ ] 混合成功/失敗 sheets 時，錯誤隔離正常運作
- [ ] RPC 類型的 chunk size 自動 cap 到 800
- [ ] 下載報告（JSON）包含完整資訊（chunks, warnings, status）
- [ ] DB 未部署 idempotency 時，系統顯示警告但不 crash
- [ ] 進度條正確顯示 sheet 與 chunk 進度
- [ ] Console 無未處理例外（除了預期的 validation errors）

---

## E) 常見問題排查

### 問題 1: Chunk 一直失敗，報 "RPC payload too large"
**原因：** Chunk size 過大（>800 for RPC）  
**解決：** 降低 Chunk Size 到 500 或 200

### 問題 2: 重送 sheet 資料疊加（變成 4000 rows）
**原因：** DB 未部署 `ingest_key` migration  
**解決：** 執行 `database/one_shot_chunk_idempotency.sql`

### 問題 3: Abort 後無法再次匯入
**原因：** `AbortController` 未正確 reset  
**解決：** 檢查 `finally` block 是否有 `setAbortController(null)`

### 問題 4: Progress bar 不更新
**原因：** `onProgress` callback 未正確傳遞  
**解決：** 檢查 `ingestInChunks` 的 `onProgress` 是否有呼叫 `setOneShotProgress`

---

## F) 成功驗收標準

✅ **所有 Test Cases 通過**  
✅ **Build 無錯誤**  
✅ **Fallback 情境不 crash**  
✅ **報告完整且可下載**  

驗收完成後，可進入生產環境部署。
