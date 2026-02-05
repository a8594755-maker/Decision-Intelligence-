# Upload Optimization - 快速回歸驗收清單

**目標**：今天就能跑完的核心功能驗證  
**時間**：約 30-45 分鐘  
**前置條件**：已登入、可存取 Supabase Console

---

## ✅ Phase 0：資料一致性

### 測試目標
確保 `batch_id`, `upload_file_id`, `user_files.id` 正確寫入

### 快速驗證步驟

#### 0.1 user_files.id 檢查（2 分鐘）
1. 上傳任意類型資料（例如 Goods Receipt，5 筆即可）
2. 在瀏覽器 DevTools Console 搜尋：`fileRecord`
3. **驗收標準**：
   ```javascript
   // Console 應該看到：
   fileRecord: { id: "xxxx-xxxx-xxxx", filename: "...", data: {...} }
   ```
4. 打開 Supabase SQL Editor，執行：
   ```sql
   SELECT id, filename, created_at 
   FROM user_files 
   WHERE user_id = auth.uid()
   ORDER BY created_at DESC 
   LIMIT 1;
   ```
5. **驗收標準**：`id` 欄位非 NULL

**✅ 通過** / **❌ 失敗**：__________

---

#### 0.2 goods_receipts 血緣檢查（3 分鐘）
1. 上傳 Goods Receipt（5-10 筆）
2. 成功儲存後，執行：
   ```sql
   SELECT id, upload_file_id, batch_id, created_at
   FROM goods_receipts
   WHERE user_id = auth.uid()
   ORDER BY created_at DESC
   LIMIT 10;
   ```
3. **驗收標準**：
   - ✅ `upload_file_id` **全部非 NULL**
   - ✅ `batch_id` **全部非 NULL**
   - ✅ 所有記錄的 `batch_id` 相同（同一次上傳）

**✅ 通過** / **❌ 失敗**：__________

---

#### 0.3 price_history 血緣檢查（3 分鐘）
1. 上傳 Price History（5-10 筆）
2. 執行：
   ```sql
   SELECT id, upload_file_id, batch_id, created_at
   FROM price_history
   WHERE user_id = auth.uid()
   ORDER BY created_at DESC
   LIMIT 10;
   ```
3. **驗收標準**：同 0.2（`upload_file_id` 和 `batch_id` 非 NULL）

**✅ 通過** / **❌ 失敗**：__________

---

## ✅ Phase 1：RPC Transaction + Bulk Upsert

### 測試目標
驗證 RPC 高效能路徑、Transaction 回滾、Fallback 機制

### 快速驗證步驟

#### 1.1 RPC 成功路徑（5 分鐘）

**前置檢查**：確認 RPC function 已部署
```sql
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_name IN ('ingest_goods_receipts_v1', 'ingest_price_history_v1');
```
**預期結果**：回傳 2 rows

---

**測試步驟**：
1. 上傳 Goods Receipt（20-50 筆，**務必 < 1000 筆**）
2. 觀察 Console（F12）：
   ```
   [GoodsReceiptStrategy] Attempting RPC path...
   [GoodsReceiptStrategy] ✓ RPC Success: {...}
   ```
3. 觀察 UI 通知：
   ```
   ✓ 使用交易性寫入完成（X 筆，建立 Y 個供應商）
   ```
4. 執行 SQL 驗證：
   ```sql
   -- 取得最新 batch_id
   SELECT batch_id, COUNT(*) as count
   FROM goods_receipts
   WHERE user_id = auth.uid()
   GROUP BY batch_id
   ORDER BY MAX(created_at) DESC
   LIMIT 1;
   ```
5. **驗收標準**：
   - ✅ Console 有 `✓ RPC Success`
   - ✅ UI 顯示「使用交易性寫入完成」
   - ✅ DB 的 count 與上傳筆數一致

**✅ 通過** / **❌ 失敗**：__________

---

#### 1.2 RPC Transaction 回滾（5 分鐘）

**⚠️ 此測試會暫時破壞 RPC function，測試完務必恢復！**

**步驟**：
1. 打開 Supabase SQL Editor
2. 在 `ingest_goods_receipts_v1` function 的 `BEGIN` 後加入：
   ```sql
   RAISE EXCEPTION 'Test rollback';
   ```
3. 上傳 Goods Receipt（10 筆）
4. 觀察 Console：應該看到 RPC 錯誤
5. 執行 SQL：
   ```sql
   -- 檢查是否有殘留資料（應該是 0）
   SELECT COUNT(*) FROM goods_receipts 
   WHERE user_id = auth.uid() 
   AND created_at > NOW() - INTERVAL '5 minutes';
   
   SELECT COUNT(*) FROM suppliers 
   WHERE user_id = auth.uid() 
   AND created_at > NOW() - INTERVAL '5 minutes';
   ```
6. **驗收標準**：
   - ✅ 兩個 COUNT 都是 **0**（完全回滾，無殘留）
7. **恢復 function**：移除 `RAISE EXCEPTION` 那行

**✅ 通過** / **❌ 失敗**：__________

---

#### 1.3 RPC Fallback 機制（5 分鐘）

**步驟**：
1. 暫時改 RPC function 名稱（例如：`ingest_goods_receipts_v1_backup`）
   ```sql
   -- 或直接 DROP（測試完記得恢復）
   DROP FUNCTION IF EXISTS ingest_goods_receipts_v1;
   ```
2. 上傳 Goods Receipt（10 筆）
3. 觀察 Console：
   ```
   [RPC_FALLBACK] RPC failed, using legacy path: {...}
   [GoodsReceiptStrategy] Using legacy path (fallback)...
   ```
4. 觀察 UI 通知：
   ```
   ⚠️ 高效能模式失敗，已切換到相容模式（原因：...）
   ```
5. 執行 SQL 驗證：
   ```sql
   SELECT COUNT(*) FROM goods_receipts 
   WHERE user_id = auth.uid() 
   AND created_at > NOW() - INTERVAL '2 minutes';
   ```
6. **驗收標準**：
   - ✅ Console 有 `[RPC_FALLBACK]`
   - ✅ UI 顯示「已切換到相容模式」
   - ✅ 資料仍正確寫入（fallback 成功）
7. **恢復 function**：重新執行 `database/ingest_rpc.sql`

**✅ 通過** / **❌ 失敗**：__________

---

#### 1.4 批次大小限制（2 分鐘）

**步驟**：
1. 準備 > 1000 筆資料（或手動建立大 CSV）
2. 嘗試上傳
3. **驗收標準**：
   - ✅ UI 顯示：「批次資料過大：X 筆 (上限 1000 筆)」
   - ✅ DB **無任何新增資料**（BatchSizeError 直接拋出）

**✅ 通過** / **❌ 失敗**：__________

---

## ✅ Phase 2：策略模式 + 狀態集中

### 測試目標
驗證程式碼架構改進、可維護性提升

### 快速驗證步驟

#### 2.1 handleSave 精簡驗證（1 分鐘）

**步驟**：
1. 打開 `src/views/EnhancedExternalSystemsView.jsx`
2. 找到 `const handleSave = async () => {`
3. 數行數（從 `{` 到 `}`，含註解）

**驗收標準**：
- ✅ 總行數 < 100 行（目前約 98 行）
- ✅ **無 if-else 分支**判斷 uploadType（已用策略模式）
- ✅ 核心邏輯：`const strategy = getUploadStrategy(uploadType)`

**✅ 通過** / **❌ 失敗**：__________

---

#### 2.2 策略模式可擴展性（概念驗證）

**步驟**：
1. 打開 `src/services/uploadStrategies.js`
2. 檢查是否有 8 個 Strategy class：
   - GoodsReceiptStrategy
   - PriceHistoryStrategy
   - SupplierMasterStrategy
   - BomEdgeStrategy
   - DemandFgStrategy
   - PoOpenLinesStrategy
   - InventorySnapshotsStrategy
   - FgFinancialsStrategy

**驗收標準**：
- ✅ 所有 Strategy 都有統一介面：`async ingest({ userId, rows, batchId, uploadFileId, ... })`
- ✅ 新增 uploadType 只需加新 Strategy，不改 `handleSave`

**✅ 通過** / **❌ 失敗**：__________

---

#### 2.3 狀態集中管理驗證（1 分鐘）

**步驟**：
1. 打開 `src/hooks/useUploadWorkflow.js`
2. 檢查 `initialState` 包含：
   - currentStep, uploadType, file, fileName
   - rawRows, columns, columnMapping, mappingComplete
   - validationResult, strictMode
   - loading, saving, error

**驗收標準**：
- ✅ 使用 `useReducer`（非散落的 useState）
- ✅ 提供統一的 actions（setUploadType, setFile, setValidation, etc.）

**✅ 通過** / **❌ 失敗**：__________

---

#### 2.4 多種 uploadType 整合測試（10 分鐘）

**步驟**：快速測試 3 種主要類型

1. **Goods Receipt**（已測，略過或快測）
2. **Supplier Master**：
   - 上傳 5 筆（含重複供應商）
   - Console 檢查：`[SupplierMasterStrategy] Starting for X rows`
   - SQL 驗證：
     ```sql
     SELECT COUNT(*) FROM suppliers 
     WHERE user_id = auth.uid() 
     AND created_at > NOW() - INTERVAL '2 minutes';
     ```
3. **BOM Edge**：
   - 上傳 5 筆
   - Console 檢查：`[BomEdgeStrategy] Starting for X rows`
   - SQL 驗證：
     ```sql
     SELECT COUNT(*) FROM bom_edges 
     WHERE user_id = auth.uid() 
     AND created_at > NOW() - INTERVAL '2 minutes';
     ```

**驗收標準**：
- ✅ 每種類型都能正常儲存
- ✅ Console 顯示對應 Strategy 名稱
- ✅ DB 資料正確

**✅ 通過** / **❌ 失敗**：__________

---

#### 2.5 Build 驗證（2 分鐘）

**步驟**：
```bash
npm run build
```

**驗收標準**：
- ✅ **無 error**
- ✅ 看到 `✓ built in X.XXs`
- ✅ dist 資料夾生成

**✅ 通過** / **❌ 失敗**：__________

---

## ✅ Phase 3：UX 改進

### 測試目標
驗證 Strict/Best-effort 模式、錯誤報告下載

### 快速驗證步驟

#### 3.1 Best-effort Mode（預設）（5 分鐘）

**步驟**：
1. 準備包含錯誤的資料（例如：10 筆，其中 2 筆 `received_qty` 填 "abc"）
2. 上傳 Goods Receipt
3. Field Mapping → Validate
4. 檢查 Validation step：
   - 顯示「8 valid, 2 errors」
   - **Best-effort** radio 預設選中
   - Instruction Text（藍色）：「System will save 8 valid rows and skip 2 error rows」
5. Save button 應該 **enabled**（綠色）
6. 點 Save
7. 執行 SQL：
   ```sql
   SELECT COUNT(*) FROM goods_receipts 
   WHERE user_id = auth.uid() 
   AND created_at > NOW() - INTERVAL '2 minutes';
   ```

**驗收標準**：
- ✅ 預設 Best-effort
- ✅ Save button enabled
- ✅ DB 儲存 **8 筆**（跳過 2 筆錯誤）
- ✅ UI 顯示：「Successfully saved 8 rows (2 errors skipped)」

**✅ 通過** / **❌ 失敗**：__________

---

#### 3.2 Strict Mode 行為（5 分鐘）

**步驟**：
1. 使用相同錯誤資料（8 valid, 2 errors）
2. 上傳 → Mapping → Validate
3. 在 Validation step，切換到 **Strict** mode radio
4. 檢查 UI 變化：
   - Instruction Text 變為橘色：「Strict Mode: Cannot Save with Errors」
   - Save button 變為 **disabled**（灰色）
   - 按鈕旁顯示：「⚠️ Strict mode: Fix errors to enable save」
5. 嘗試點 Save（如果可點）
6. 檢查 Console：無 DB 寫入相關 log（或看到錯誤訊息）

**驗收標準**：
- ✅ Strict mode 可切換
- ✅ Save button disabled
- ✅ 點 Save **不寫 DB**（立即 return）
- ✅ UI 顯示錯誤：「Strict mode enabled: Cannot save with X error rows...」

**✅ 通過** / **❌ 失敗**：__________

---

#### 3.3 Strict Mode 與全部有效資料（2 分鐘）

**步驟**：
1. 上傳全部有效資料（0 errors）
2. Validate
3. 切換到 **Strict** mode
4. 檢查 Save button：應該仍 **enabled**（綠色）
5. 點 Save：正常儲存

**驗收標準**：
- ✅ Strict mode + 0 errors = Save enabled
- ✅ 正常儲存

**✅ 通過** / **❌ 失敗**：__________

---

#### 3.4 Download Error Report（5 分鐘）

**步驟**：
1. 使用包含錯誤的資料（8 valid, 2 errors）
2. Validate
3. 檢查 Validation step：顯示「Download Error Report (.csv)」按鈕
4. 點擊按鈕
5. 檢查瀏覽器下載：應自動下載 CSV
6. 開啟 CSV（Excel 或文字編輯器）
7. 檢查內容：
   ```csv
   Row Index,Field,Original Value,Error Message,Full Row Data (JSON)
   2,Received Qty,abc,"Must be a number","{""material_code"":""M001"",""received_qty"":""abc"",...}"
   ...
   ```

**驗收標準**：
- ✅ 按鈕只在 `errorRows.length > 0` 時顯示
- ✅ 點擊自動下載 CSV
- ✅ 檔名格式：`error-report_{uploadType}_{fileName}_{timestamp}.csv`
- ✅ CSV 包含 5 個欄位：Row Index, Field, Original Value, Error Message, Full Row Data (JSON)
- ✅ 每個錯誤行的每個欄位錯誤都有一行
- ✅ Excel 可正確開啟（UTF-8 BOM）

**✅ 通過** / **❌ 失敗**：__________

---

## ⚡ 性能觀察

### 測試目標
確認 UI 不會卡死、RPC 效能優勢明顯

### 快速測試步驟

#### P.1 中批次效能（500 筆）（5 分鐘）

**步驟**：
1. 準備 500 筆 Goods Receipt 資料
2. 上傳 → Mapping → Validate
3. 在 Console 執行：
   ```javascript
   console.time('Save_500_rows');
   ```
4. 點 Save
5. 等待完成後，在 Console 執行：
   ```javascript
   console.timeEnd('Save_500_rows');
   ```

**觀察結果**：
- ⏱️ 耗時：________ 秒
- 📊 預期：< 15 秒（RPC 路徑）
- 🖱️ UI 是否流暢：[ ] 是 [ ] 有短暫卡頓 [ ] 長時間凍結

**備註**：如使用 RPC，應明顯快於舊版 N+1 邏輯

---

#### P.2 大批次效能（1000 筆）（5 分鐘）

**步驟**：同 P.1，使用 1000 筆資料

**觀察結果**：
- ⏱️ 耗時：________ 秒
- 📊 預期：< 30 秒（RPC 路徑）
- 🖱️ UI 是否流暢：[ ] 是 [ ] 有短暫卡頓 [ ] 長時間凍結

**⚠️ 注意**：若超過 30 秒，檢查：
- RPC 是否正常執行（Console 有 `✓ RPC Success`）
- 是否 fallback 到 legacy path（會較慢）
- 網路連線是否穩定

---

#### P.3 RPC vs Legacy 對比（可選，10 分鐘）

**步驟**：
1. 上傳 500 筆（RPC 路徑），記錄時間 T1
2. 暫時停用 RPC（改名或 DROP）
3. 重新上傳相同 500 筆（Legacy 路徑），記錄時間 T2
4. 比較：T1 vs T2

**觀察結果**：
- ⏱️ RPC (T1)：________ 秒
- ⏱️ Legacy (T2)：________ 秒
- 📊 加速比：T2 / T1 = ________x

**預期**：RPC 應快 3-10 倍

---

## 🚨 風險點與注意事項

### 1. Supabase RPC Function 權限

**風險**：RPC function 未部署或權限不足

**檢查方式**：
```sql
-- 檢查 function 存在
SELECT routine_name, routine_schema
FROM information_schema.routines 
WHERE routine_name IN ('ingest_goods_receipts_v1', 'ingest_price_history_v1');

-- 檢查權限（需在 Supabase SQL Editor 執行 GRANT 語句）
-- 應該已包含在 database/ingest_rpc.sql 最後
```

**解決方式**：
- 執行 `database/ingest_rpc.sql`（完整檔案）
- 確認最後有 `GRANT EXECUTE ON FUNCTION ... TO authenticated;`

**症狀**：
- Console 顯示 `[RPC_FALLBACK]`
- UI 顯示「已切換到相容模式」
- 錯誤訊息包含「permission denied」或「function does not exist」

---

### 2. RLS (Row Level Security) 問題

**風險**：RLS 政策未正確設定，導致 RPC 內的 INSERT 失敗

**檢查方式**：
```sql
-- 檢查 goods_receipts 的 RLS 政策
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename IN ('goods_receipts', 'price_history', 'suppliers', 'materials');
```

**注意**：
- RPC function 使用 `SECURITY DEFINER`，但內部 INSERT 仍受 RLS 限制
- 確保有 INSERT policy 允許 `auth.uid()` 寫入

**症狀**：
- Console 顯示 RPC 錯誤
- 錯誤訊息包含「new row violates row-level security policy」

---

### 3. Payload Size 限制

**風險**：單次 RPC 呼叫的 JSONB payload 過大（> 1000 rows）

**檢查方式**：
- 前端已實作 `MAX_ROWS_PER_BATCH = 1000` 限制
- 超過會拋出 `BatchSizeError`

**解決方式**：
- 告知使用者分檔上傳（每檔 ≤ 1000 筆）
- 未來可實作 staging + finalize 機制（Phase 3+ TODO）

**症狀**：
- UI 顯示：「批次資料過大：X 筆 (上限 1000 筆)」

---

### 4. Schema 差異（upload_file_id 型別）

**風險**：`user_files.id` 是 UUID，但 `goods_receipts.upload_file_id` 是 BIGINT

**檢查方式**：
```sql
SELECT 
  table_name, 
  column_name, 
  data_type 
FROM information_schema.columns 
WHERE table_name IN ('user_files', 'goods_receipts', 'price_history')
  AND column_name IN ('id', 'upload_file_id');
```

**現況**：
- RPC 內部使用 `p_upload_file_id::BIGINT` 強制轉型
- 暫時可運作，但長期應統一型別

**症狀**：
- RPC 執行時可能出現型別轉換錯誤
- 如出現，需修改 RPC function 或 schema

---

### 5. Batch ID 衝突（Idempotency）

**風險**：相同 `batch_id` 重複上傳，導致舊資料被覆蓋

**設計**：
- 這是**預期行為**（Idempotency）
- RPC 會先 `DELETE` 相同 `batch_id` 的資料，再 INSERT

**注意**：
- 確保每次上傳都產生新的 `batch_id`（UUID）
- 前端使用 `crypto.randomUUID()` 或 Supabase 自動產生

---

### 6. 前端 State 管理

**風險**：部分 state 未搬入 reducer，可能不同步

**現況**：
- 核心 workflow state 已用 `useReducer` 管理
- 以下 state 仍使用 `useState`（設計決策）：
  - `workbook`, `sheetNames`, `selectedSheet`（Excel multi-sheet）
  - `mappingAiStatus`, `mappingAiError`（AI mapping）
  - `uploadProgress`, `saveProgress`（UI 進度）

**風險評估**：低（這些 state 與核心 workflow 解耦）

---

## 📊 驗收結果總覽

### Phase 0: 資料一致性
- [ ] 0.1 user_files.id 檢查
- [ ] 0.2 goods_receipts 血緣檢查
- [ ] 0.3 price_history 血緣檢查

**通過率**：___ / 3

---

### Phase 1: RPC Transaction
- [ ] 1.1 RPC 成功路徑
- [ ] 1.2 RPC Transaction 回滾
- [ ] 1.3 RPC Fallback 機制
- [ ] 1.4 批次大小限制

**通過率**：___ / 4

---

### Phase 2: 策略模式
- [ ] 2.1 handleSave 精簡驗證
- [ ] 2.2 策略模式可擴展性
- [ ] 2.3 狀態集中管理驗證
- [ ] 2.4 多種 uploadType 整合測試
- [ ] 2.5 Build 驗證

**通過率**：___ / 5

---

### Phase 3: UX 改進
- [ ] 3.1 Best-effort Mode（預設）
- [ ] 3.2 Strict Mode 行為
- [ ] 3.3 Strict Mode 與全部有效資料
- [ ] 3.4 Download Error Report

**通過率**：___ / 4

---

### 性能觀察
- [ ] P.1 中批次效能（500 筆）
- [ ] P.2 大批次效能（1000 筆）
- [ ] P.3 RPC vs Legacy 對比（可選）

**觀察完成**：___ / 3

---

## ✅ 最終簽核

**測試者**：______________  
**測試日期**：______________  
**總通過率**：___ / 16（核心項目）

**整體評估**：
- [ ] ✅ 完全通過（所有項目 PASS）
- [ ] ⚠️ 部分通過（< 2 項 FAIL，且為非阻斷性問題）
- [ ] ❌ 未通過（≥ 2 項 FAIL，或有阻斷性問題）

**備註**：
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________

---

## 📋 Quick Reference

### 常用 SQL 查詢

```sql
-- 檢查最新上傳
SELECT id, upload_type, filename, total_rows, status, created_at
FROM import_batches
WHERE user_id = auth.uid()
ORDER BY created_at DESC
LIMIT 5;

-- 檢查最新 goods_receipts
SELECT gr.id, gr.batch_id, gr.upload_file_id, gr.received_qty, 
       s.supplier_name, m.material_code
FROM goods_receipts gr
LEFT JOIN suppliers s ON gr.supplier_id = s.id
LEFT JOIN materials m ON gr.material_id = m.id
WHERE gr.user_id = auth.uid()
ORDER BY gr.created_at DESC
LIMIT 10;

-- 檢查 RPC function
SELECT routine_name, routine_schema, data_type
FROM information_schema.routines 
WHERE routine_schema = 'public' 
  AND routine_name LIKE 'ingest%';

-- 清理測試資料（⚠️ 謹慎使用）
DELETE FROM goods_receipts WHERE user_id = auth.uid() AND created_at > NOW() - INTERVAL '1 hour';
DELETE FROM price_history WHERE user_id = auth.uid() AND created_at > NOW() - INTERVAL '1 hour';
DELETE FROM import_batches WHERE user_id = auth.uid() AND created_at > NOW() - INTERVAL '1 hour';
```

---

**QA 完成後，請保留此文檔作為回歸測試基線！**
