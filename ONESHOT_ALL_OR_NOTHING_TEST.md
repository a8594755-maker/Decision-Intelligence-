# One-shot All-or-nothing Mode 測試指引

## 功能概述
為 One-shot Import 新增兩種模式：
- **Best-effort（預設）**：Sheet-level 隔離，成功的 sheets 先寫入，失敗的 sheets 不影響其他
- **All-or-nothing**：若任一 sheet 失敗，rollback 所有已成功 sheets（使用 ingest_key delete）

---

## 最小驗收標準
✅ 故意讓某 sheet 失敗，確認成功的 sheets 也被回滾（DB 無殘留資料）

---

## 前置準備

### 1. 確認 DB Migration 已部署
All-or-nothing 模式需要 `ingest_key` 支援。

**執行：**
```sql
-- 在 Supabase SQL Editor 執行
-- 複製 database/one_shot_chunk_idempotency.sql 的完整內容
```

**驗證：**
```sql
SELECT public.check_ingest_key_support();
-- 預期：回傳 true
```

### 2. 準備測試資料

#### 測試檔案：`test_all_or_nothing.xlsx`

建立包含 3 個 sheets 的 Excel 檔案：

**Sheet 1: "Good Suppliers"**
- 欄位：`supplier_name`, `supplier_code`, `contact_person`, `phone`, `email`
- 資料：填入 10 筆**完整且正確**的供應商資料
- 預期：應成功匯入

**Sheet 2: "Good BOM"**
- 欄位：`parent_material`, `component_material`, `qty`, `uom`
- 資料：填入 15 筆**完整且正確**的 BOM 資料
- 預期：應成功匯入

**Sheet 3: "Bad Demand"** （故意製造錯誤）
- 欄位：`material_code`, `time_bucket`, `demand_qty`, `plant_id`
- 資料：
  - 前 5 rows：正確的資料
  - 第 6 row：**故意留空 `material_code`**（必填欄位）
  - 第 7-10 rows：**故意填入非數字的 `demand_qty`**（例如："ABC"）
- 預期：在 strict mode 下應失敗

---

## 測試案例

### Test Case 1: Best-effort Mode（預設）— 失敗不影響成功

**步驟：**
1. 啟動 `npm run dev`
2. 前往 Data Upload 頁面
3. 勾選「One-shot Import（多 sheets 自動匯入）」
4. **確認 Import Mode 選擇為 "Best-effort（推薦）"**
5. 上傳 `test_all_or_nothing.xlsx`
6. 進入 Sheet Plans 頁面
7. 確認 3 個 sheets 都已分類：
   - "Good Suppliers" → `supplier_master`
   - "Good BOM" → `bom_edge`
   - "Bad Demand" → `demand_fg`
8. 全部勾選 Enable（包括 "Bad Demand"）
9. 點擊「Import Enabled Sheets」
10. 觀察進度與結果

**預期結果：**
- ✅ "Good Suppliers" 成功匯入（10 rows）
- ✅ "Good BOM" 成功匯入（15 rows）
- ❌ "Bad Demand" 失敗（validation errors）
- ✅ Summary 顯示：
  - Succeeded: 2
  - Failed: 1
  - Total: 3
- ✅ **No rollback triggered**（`rolledBack = false`）
- ✅ Import Mode 顯示：Best-effort

**驗證資料庫：**
```sql
-- 檢查 suppliers 表
SELECT COUNT(*) FROM public.suppliers WHERE batch_id IN (
  SELECT id FROM public.import_batches WHERE file_name LIKE '%test_all_or_nothing%'
);
-- 預期：10

-- 檢查 bom_edges 表
SELECT COUNT(*) FROM public.bom_edges WHERE batch_id IN (
  SELECT id FROM public.import_batches WHERE file_name LIKE '%test_all_or_nothing%'
);
-- 預期：15

-- 檢查 demand_fg 表
SELECT COUNT(*) FROM public.demand_fg WHERE batch_id IN (
  SELECT id FROM public.import_batches WHERE file_name LIKE '%test_all_or_nothing%'
);
-- 預期：0（因為失敗）
```

**結論：** Best-effort 模式下，成功的 sheets 保留，失敗的 sheet 不影響其他。

---

### Test Case 2: All-or-nothing Mode — 任一失敗則全部回滾

**步驟：**
1. 前往 Data Upload 頁面（或 reset flow）
2. 勾選「One-shot Import（多 sheets 自動匯入）」
3. **切換 Import Mode 為 "All-or-nothing"**
4. 上傳同一個 `test_all_or_nothing.xlsx`
5. 進入 Sheet Plans 頁面
6. 全部勾選 Enable（包括 "Bad Demand"）
7. 點擊「Import Enabled Sheets」
8. 觀察進度

**預期結果：**
- ✅ "Good Suppliers" 先成功匯入（10 rows）
- ✅ "Good BOM" 接著成功匯入（15 rows）
- ❌ "Bad Demand" 失敗（validation errors）
- 🔄 **系統偵測到失敗，觸發 rollback**
- ✅ Console 顯示：
  ```
  [One-shot] All-or-nothing mode: Rolling back succeeded sheets due to failure
  [One-shot] Rolling back 2 succeeded sheets...
  [One-shot] Rolling back "Good Suppliers" (supplier_master), ingest_key: ...
  [One-shot] Rolled back "Good Suppliers": 10 rows deleted
  [One-shot] Rolling back "Good BOM" (bom_edge), ingest_key: ...
  [One-shot] Rolled back "Good BOM": 15 rows deleted
  [One-shot] Rollback completed
  ```
- ✅ Summary 顯示：
  - **Rollback warning 紅色框**：「All-or-nothing Mode: Rollback Triggered」
  - Succeeded: 2（原本成功，但被回滾）
  - Failed: 1
  - Total: 3
  - **rolledBack: true**
- ✅ Import Mode 顯示：All-or-nothing

**驗證資料庫（最重要！）：**
```sql
-- 檢查 suppliers 表（應該是空的，已被回滾）
SELECT COUNT(*) FROM public.suppliers WHERE batch_id IN (
  SELECT id FROM public.import_batches WHERE file_name LIKE '%test_all_or_nothing%' ORDER BY created_at DESC LIMIT 3
);
-- 預期：0（已回滾）

-- 檢查 bom_edges 表（應該是空的，已被回滾）
SELECT COUNT(*) FROM public.bom_edges WHERE batch_id IN (
  SELECT id FROM public.import_batches WHERE file_name LIKE '%test_all_or_nothing%' ORDER BY created_at DESC LIMIT 3
);
-- 預期：0（已回滾）

-- 檢查 demand_fg 表（本來就失敗，沒寫入）
SELECT COUNT(*) FROM public.demand_fg WHERE batch_id IN (
  SELECT id FROM public.import_batches WHERE file_name LIKE '%test_all_or_nothing%' ORDER BY created_at DESC LIMIT 3
);
-- 預期：0
```

**結論：** ✅ **All-or-nothing 模式下，由於某個 sheet 失敗，所有已成功的 sheets 都被回滾，DB 無殘留資料。**

---

### Test Case 3: All-or-nothing Mode — 全部成功則全部保留

**步驟：**
1. 修改 `test_all_or_nothing.xlsx` 的 "Bad Demand" sheet：
   - 移除所有錯誤資料
   - 只保留 10 筆**完整且正確**的資料
2. 重新上傳（All-or-nothing mode）
3. 全部勾選 Enable
4. 點擊「Import Enabled Sheets」

**預期結果：**
- ✅ "Good Suppliers" 成功（10 rows）
- ✅ "Good BOM" 成功（15 rows）
- ✅ "Good Demand" 成功（10 rows）
- ✅ Summary 顯示：
  - Succeeded: 3
  - Failed: 0
  - Total: 3
  - **rolledBack: false**（無需回滾）
- ✅ Import Mode 顯示：All-or-nothing

**驗證資料庫：**
```sql
-- 全部表都應有資料
SELECT COUNT(*) FROM public.suppliers WHERE batch_id IN (...);  -- 預期：10
SELECT COUNT(*) FROM public.bom_edges WHERE batch_id IN (...);  -- 預期：15
SELECT COUNT(*) FROM public.demand_fg WHERE batch_id IN (...);  -- 預期：10
```

**結論：** All-or-nothing 模式下，若全部成功，則全部保留。

---

### Test Case 4: All-or-nothing Mode — Abort 中途取消

**步驟：**
1. 準備一個包含 5 個 sheets 的大檔案（每個 sheet 500+ rows）
2. 切換為 All-or-nothing mode
3. 上傳並開始匯入
4. **在第 2-3 個 sheet 匯入時，立即點擊「Abort Import」**

**預期結果：**
- ✅ 第 1 個 sheet 成功匯入
- ⏸ 第 2-3 個 sheet 可能部分完成或被 abort
- 🔄 **系統偵測到 abort，觸發 rollback**
- ✅ Console 顯示：
  ```
  [One-shot] Aborted by user
  [One-shot] All-or-nothing mode: Rolling back succeeded sheets due to abort
  [One-shot] Rolling back 1 succeeded sheets...
  [One-shot] Rollback completed
  ```
- ✅ Summary 顯示 rollback warning

**驗證資料庫：**
```sql
-- 所有表都應該是空的（已回滾）
SELECT COUNT(*) FROM public.suppliers WHERE batch_id IN (...);  -- 預期：0
SELECT COUNT(*) FROM public.bom_edges WHERE batch_id IN (...);  -- 預期：0
-- ... etc
```

**結論：** Abort 時，All-or-nothing 模式也會觸發 rollback。

---

### Test Case 5: All-or-nothing Mode without DB Support（Fallback）

**模擬步驟：**
1. 暫時停用 `check_ingest_key_support` RPC：
```sql
DROP FUNCTION IF EXISTS public.check_ingest_key_support();
```
2. 重新整理頁面
3. 上傳檔案，切換為 All-or-nothing mode
4. 嘗試匯入

**預期結果：**
- ⚠ Console 警告：
  ```
  [One-shot] Ingest key support not deployed, using fallback mode
  [One-shot] All-or-nothing mode requires ingest_key support, falling back to best-effort
  ```
- ⚠ 系統自動降級為 Best-effort 模式（即使選擇 All-or-nothing）
- ✅ 匯入仍可正常執行（不會 crash）
- ⚠ Summary 可能顯示警告：「DB 未部署 chunk-idempotency」

**還原環境：**
```sql
-- 重新執行 one_shot_chunk_idempotency.sql
```

**結論：** 無 DB 支援時，系統自動降級為 Best-effort，確保功能可用。

---

## 驗收清單

### 功能驗收
- [ ] UI 顯示 Import Mode radio 選擇（Best-effort / All-or-nothing）
- [ ] Best-effort 模式：失敗的 sheet 不影響成功的 sheets
- [ ] All-or-nothing 模式：任一 sheet 失敗，所有已成功的 sheets 被回滾
- [ ] All-or-nothing 模式：全部成功，則全部保留
- [ ] All-or-nothing 模式：Abort 時觸發 rollback
- [ ] Rollback 時 Console 顯示詳細 log（每個 sheet 回滾多少 rows）
- [ ] Summary 顯示 rollback warning（紅色框）
- [ ] Summary 顯示 Import Mode 標籤

### 資料庫驗收（最重要！）
- [ ] Best-effort 模式：成功的 sheets 資料保留在 DB
- [ ] All-or-nothing 模式（有失敗）：**DB 中無任何殘留資料**
- [ ] All-or-nothing 模式（全成功）：DB 中保留所有資料
- [ ] Rollback 後，`ingest_sheet_runs` 表中 status 仍為 'succeeded'（但資料已刪除）

### 邊界條件驗收
- [ ] 無 DB ingest_key 支援時，All-or-nothing 自動降級為 Best-effort
- [ ] Rollback 失敗不中斷（繼續回滾其他 sheets）
- [ ] Console 無未處理例外

### UI/UX 驗收
- [ ] Radio 選擇清晰（推薦 Best-effort）
- [ ] All-or-nothing 提示警告清楚（需 DB 支援）
- [ ] Rollback warning 明顯（紅色）
- [ ] Import Mode 標籤顯示正確

---

## 常見問題排查

### 問題 1: All-or-nothing 模式下沒有觸發 rollback
**可能原因：**
- DB 未部署 `ingest_key` migration
- `check_ingest_key_support()` 回傳 false

**解決方式：**
1. 執行 `database/one_shot_chunk_idempotency.sql`
2. 驗證：`SELECT public.check_ingest_key_support();` 回傳 true

---

### 問題 2: Rollback 後資料仍殘留
**可能原因：**
- `ingest_key` 欄位未正確寫入（為 null）
- `deletePreviousDataByIngestKey` 函式邏輯錯誤

**檢查方式：**
```sql
-- 檢查 ingest_key 是否有值
SELECT ingest_key, COUNT(*) 
FROM public.suppliers 
WHERE ingest_key IS NOT NULL 
GROUP BY ingest_key;

-- 若為空，表示 uploadStrategies 未正確傳遞 idempotencyKey
```

**解決方式：**
1. 檢查 `uploadStrategies.js` 中 `ingest` 方法是否包含 `ingest_key: options.idempotencyKey || null`
2. 檢查 `oneShotImportService.js` 中 `ingestInChunks` 是否傳遞 `options.idempotencyKey`

---

### 問題 3: Console 顯示 "Rolled back X rows" 但實際未刪除
**可能原因：**
- RLS policies 阻擋 delete 操作
- `user_id` 不匹配

**檢查方式：**
```sql
-- 檢查 RLS policy
SELECT * FROM pg_policies WHERE tablename = 'suppliers';

-- 手動測試 delete
DELETE FROM public.suppliers 
WHERE user_id = auth.uid() 
AND ingest_key = 'test_key';
```

**解決方式：**
1. 確認 suppliers 表的 RLS policy 允許 DELETE
2. 確認 `deletePreviousDataByIngestKey` 使用的 `userId` 與資料中的 `user_id` 一致

---

## 成功標準

✅ **Test Case 2 必須通過**：All-or-nothing 模式下，故意失敗某 sheet，確認 DB 無殘留資料  
✅ **所有 Test Cases 通過**  
✅ **`npm run build` 成功**  

驗收完成後，功能可投入生產使用。

---

## 相關檔案

### 修改檔案
- `src/services/oneShotImportService.js` - 新增 rollback 邏輯
- `src/views/EnhancedExternalSystemsView.jsx` - 新增 mode radio 與 rollback 顯示

### 新增檔案
- `ONESHOT_ALL_OR_NOTHING_TEST.md` - 本測試指引

---

## 後續優化建議

1. **Rollback 進度顯示**：回滾時顯示進度（"Rolling back sheet 1/3..."）
2. **Rollback 報告**：在 Summary 中顯示回滾的詳細資訊（每個 sheet 刪除多少 rows）
3. **Partial Rollback**：允許使用者選擇性回滾某些 sheets（而非全部）
4. **Rollback Confirmation**：失敗時彈出確認對話框，讓使用者決定是否回滾
5. **Rollback History**：記錄 rollback 操作到 `ingest_sheet_runs` 表（新增 `rolled_back_at` 欄位）
