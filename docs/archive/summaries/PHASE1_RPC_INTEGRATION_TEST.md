# Phase 1 RPC Integration - 測試驗收指南

## ✅ 完成狀態

**Phase 1（DB + 前端整合）：RPC Transaction + Fallback 機制**

---

## 📋 已完成的修改

### 1. **新增檔案**
- ✅ `database/ingest_rpc.sql` - RPC functions 定義
- ✅ `database/INGEST_RPC_QUICKSTART.md` - RPC 快速入門指南
- ✅ `src/services/ingestRpcService.js` - 前端 RPC 呼叫 service

### 2. **修改檔案**
- ✅ `src/views/EnhancedExternalSystemsView.jsx`
  - `saveGoodsReceipts` - 優先 RPC，失敗則 fallback
  - `savePriceHistory` - 優先 RPC，失敗則 fallback

---

## 🎯 測試計畫

### 測試 1: RPC 主要路徑（Happy Path）

#### **前置條件**
1. 在 Supabase SQL Editor 執行 `database/ingest_rpc.sql`
2. 確認 functions 已建立：
   ```sql
   SELECT routine_name 
   FROM information_schema.routines 
   WHERE routine_name LIKE 'ingest_%_v1';
   ```
   預期看到：`ingest_goods_receipts_v1`, `ingest_price_history_v1`

#### **測試步驟**
1. 啟動開發伺服器：`npm run dev`
2. 登入系統
3. 上傳 `goods_receipt` 資料（< 1000 筆）
4. 完成欄位映射 → 驗證 → 點擊「Save to Database」

#### **預期結果**
- ✅ Console 顯示：`[saveGoodsReceipts] Attempting RPC path...`
- ✅ Console 顯示：`[saveGoodsReceipts] ✓ RPC Success:`
- ✅ UI 顯示通知：`✓ 使用交易性寫入完成（X 筆，建立 Y 個供應商）`
- ✅ **不應該**看到 `[RPC_FALLBACK]` 訊息
- ✅ **不應該**執行 `suppliersService.batchUpsertSuppliers`（檢查 console）

#### **資料庫驗證**
```sql
-- 確認資料已寫入且包含完整欄位
SELECT 
  id, 
  batch_id, 
  upload_file_id, 
  supplier_id, 
  material_id,
  received_qty,
  created_at
FROM goods_receipts 
WHERE batch_id = 'YOUR_BATCH_ID'
ORDER BY created_at DESC 
LIMIT 5;

-- 確認 batch_id 和 upload_file_id 都不為 NULL
SELECT 
  COUNT(*) as total,
  COUNT(batch_id) as has_batch_id,
  COUNT(upload_file_id) as has_upload_file_id
FROM goods_receipts 
WHERE batch_id = 'YOUR_BATCH_ID';
```

預期：`total = has_batch_id = has_upload_file_id`

---

### 測試 2: RPC 主要路徑（Price History）

#### **測試步驟**
1. 上傳 `price_history` 資料（< 1000 筆）
2. 完成欄位映射 → 驗證 → 點擊「Save to Database」

#### **預期結果**
- ✅ Console 顯示：`[savePriceHistory] Attempting RPC path...`
- ✅ Console 顯示：`[savePriceHistory] ✓ RPC Success:`
- ✅ UI 顯示通知：`✓ 使用交易性寫入完成（X 筆，建立 Y 個供應商）`

#### **資料庫驗證**
```sql
SELECT 
  id, 
  batch_id, 
  upload_file_id, 
  supplier_id, 
  material_id,
  unit_price,
  order_date,
  created_at
FROM price_history 
WHERE batch_id = 'YOUR_BATCH_ID'
ORDER BY created_at DESC 
LIMIT 5;
```

---

### 測試 3: 批次過大錯誤（> 1000 rows）

#### **測試步驟**
1. 準備一個 > 1000 rows 的測試檔案
2. 上傳 → 映射 → 驗證 → 保存

#### **預期結果**
- ✅ Console 顯示：`[saveGoodsReceipts] ✗ BatchSizeError:`
- ✅ UI 顯示錯誤通知（紅色）：
  ```
  Save failed: 批次資料過大：1500 筆 (上限 1000 筆)。請分檔上傳或聯繫系統管理員。
  
  💡 建議：請將資料分成多個檔案上傳（每個檔案 ≤ 1000 筆）
  ```
- ✅ **不應該** fallback 到舊邏輯（直接中斷）
- ✅ 資料庫無任何資料寫入

---

### 測試 4: RPC Fallback 機制（Function 不存在）

#### **模擬 RPC 失敗**
**方法 A：暫時修改 function 名稱**
在 Supabase SQL Editor 執行：
```sql
-- 暫時重新命名（模擬 function 不存在）
ALTER FUNCTION ingest_goods_receipts_v1(UUID, UUID, JSONB) 
RENAME TO ingest_goods_receipts_v1_disabled;
```

#### **測試步驟**
1. 上傳 `goods_receipt` 資料（< 1000 筆）
2. 完成流程 → 保存

#### **預期結果**
- ✅ Console 顯示：`[saveGoodsReceipts] Attempting RPC path...`
- ✅ Console 顯示：`[ingestGoodsReceiptsRpc] RPC Error:` (code: '42883')
- ✅ Console 顯示：`[RPC_FALLBACK] RPC failed, using legacy path:`
- ✅ Console 顯示：`[saveGoodsReceipts] Using legacy path (fallback)...`
- ✅ Console 顯示：`[saveGoodsReceipts] Found X unique suppliers, Y unique materials`（舊路徑開始執行）
- ✅ UI 顯示黃色通知：`⚠️ 高效能模式失敗，已切換到相容模式（原因：42883）`
- ✅ 最終成功完成上傳（使用舊邏輯）
- ✅ 資料庫有完整資料

#### **資料庫驗證（Fallback 成功）**
```sql
-- 確認資料已寫入（即使 RPC 失敗）
SELECT COUNT(*) as total_count
FROM goods_receipts 
WHERE batch_id = 'YOUR_BATCH_ID';

-- 應該 > 0，表示 fallback 成功
```

#### **恢復 Function 名稱**
測試完成後，記得恢復：
```sql
-- 恢復原名
ALTER FUNCTION ingest_goods_receipts_v1_disabled(UUID, UUID, JSONB) 
RENAME TO ingest_goods_receipts_v1;
```

---

### 測試 5: RPC Transaction 回滾（中途失敗）

#### **模擬 Transaction 失敗**
在 Supabase SQL Editor 暫時修改 function：
```sql
-- 在 ingest_goods_receipts_v1 的 FOR LOOP 中間加入：
-- IF v_inserted_count >= 5 THEN
--   RAISE EXCEPTION 'TEST_ROLLBACK: Simulating transaction failure';
-- END IF;
```

#### **測試步驟**
1. 上傳 10 筆資料的 `goods_receipt`
2. 完成流程 → 保存

#### **預期結果（Transaction 回滾驗證）**
- ✅ Console 顯示：`INGEST_ERROR: TEST_ROLLBACK: Simulating transaction failure`
- ✅ UI 顯示錯誤通知（紅色）
- ✅ 資料庫檢查：
  ```sql
  -- 應該 = 0（整個 transaction 回滾，沒有半套資料）
  SELECT COUNT(*) FROM goods_receipts WHERE batch_id = 'YOUR_BATCH_ID';
  SELECT COUNT(*) FROM suppliers WHERE batch_id = 'YOUR_BATCH_ID';
  SELECT COUNT(*) FROM materials WHERE batch_id = 'YOUR_BATCH_ID';
  ```
  **重點**：確認沒有 5 筆資料殘留（全部回滾）

- ✅ Fallback 機制啟動，使用舊邏輯重新完成

#### **清理測試**
測試完成後，移除測試用的 RAISE EXCEPTION。

---

### 測試 6: Idempotency（重複上傳相同 batch_id）

#### **測試步驟**
1. 上傳 `goods_receipt` 資料（記錄 batch_id）
2. 查看資料庫記錄數：
   ```sql
   SELECT COUNT(*) FROM goods_receipts WHERE batch_id = 'YOUR_BATCH_ID';
   ```
3. **不要**重置流程，直接在 console 手動觸發：
   ```javascript
   // 在瀏覽器 console 執行
   const { data, error } = await supabase.rpc('ingest_goods_receipts_v1', {
     p_batch_id: 'YOUR_BATCH_ID', // 使用相同的 batch_id
     p_upload_file_id: 'YOUR_UPLOAD_FILE_ID',
     p_rows: [{ /* same data */ }]
   });
   ```
4. 再次查看資料庫記錄數

#### **預期結果**
- ✅ 第一次：插入 X 筆
- ✅ 第二次（相同 batch_id）：先刪除舊資料，再插入新資料
- ✅ 資料庫記錄數保持一致（沒有重複）
- ✅ 舊資料被覆蓋（`created_at` 更新）

---

## 🔍 效能驗證

### 比較 RPC vs Legacy 執行時間

#### **測試方法**
1. 上傳相同的 500 筆 `goods_receipt` 資料
2. 記錄 console 的執行時間：
   - RPC 路徑：從 `[saveGoodsReceipts] Attempting RPC path...` 到 `✓ RPC Success`
   - Legacy 路徑：從 `Using legacy path` 到 `完成！`

#### **預期結果**
- RPC 路徑：約 **2-5 秒**（單次 transaction）
- Legacy 路徑：約 **10-20 秒**（多次 API calls）

#### **效能改善驗證**
```
RPC 路徑節省時間 = (Legacy 時間 - RPC 時間) / Legacy 時間 * 100%
預期節省：60-75%
```

---

## 🚨 錯誤情境測試

### 情境 A: 未登入狀態

**測試**：登出後嘗試上傳

**預期**：
- ✅ RPC 拋錯：`NOT_AUTHENTICATED`
- ✅ Fallback 機制啟動（若 fallback 也需要 auth，則完全失敗）

---

### 情境 B: 必填欄位缺失

**測試**：手動構造缺少 `material_code` 的資料

**預期**：
- ✅ RPC 拋錯：`VALIDATION_ERROR: material_code is required`
- ✅ Transaction 回滾（沒有半套資料）
- ✅ 前端顯示明確錯誤訊息

---

### 情境 C: 資料型別錯誤

**測試**：傳送 `received_qty: "abc"` 或負數

**預期**：
- ✅ RPC 拋錯：`VALIDATION_ERROR: received_qty must be >= 0`
- ✅ Transaction 回滾

---

### 情境 D: RPC 權限問題

**測試**：
1. 在 Supabase 暫時移除權限：
   ```sql
   REVOKE EXECUTE ON FUNCTION ingest_goods_receipts_v1(UUID, UUID, JSONB) FROM authenticated;
   ```
2. 嘗試上傳

**預期**：
- ✅ RPC 拋錯（permission denied）
- ✅ Fallback 機制啟動
- ✅ 使用舊邏輯成功完成

**恢復權限**：
```sql
GRANT EXECUTE ON FUNCTION ingest_goods_receipts_v1(UUID, UUID, JSONB) TO authenticated;
```

---

## ✅ 最小驗收清單

### A) Build 測試
- [x] `npm run build` 成功（Exit code: 0）
- [x] 無語法錯誤
- [x] 新增的 `ingestRpcService.js` 正確打包

### B) RPC 主要路徑（需要 Supabase RPC 已部署）
- [ ] Console 顯示 `[saveGoodsReceipts] Attempting RPC path...`
- [ ] Console 顯示 `✓ RPC Success`
- [ ] **不應該**看到 `[saveGoodsReceipts] Found X unique suppliers`（這是舊路徑的 log）
- [ ] UI 顯示：`✓ 使用交易性寫入完成`
- [ ] 資料庫驗證：`batch_id` 和 `upload_file_id` 都不為 NULL

### C) Fallback 機制（RPC 不存在/報錯）
- [ ] Console 顯示 `[RPC_FALLBACK] RPC failed, using legacy path`
- [ ] Console 顯示 `[saveGoodsReceipts] Using legacy path (fallback)...`
- [ ] Console 顯示 `[saveGoodsReceipts] Found X unique suppliers`（舊路徑開始執行）
- [ ] UI 顯示黃色通知：`⚠️ 高效能模式失敗，已切換到相容模式`
- [ ] 最終成功完成上傳（使用舊邏輯）

### D) Transaction 回滾驗證
- [ ] 手動讓 RPC 在中途失敗（見測試 5）
- [ ] 資料庫確認：**完全沒有**半套資料（COUNT = 0）
- [ ] Fallback 機制啟動並成功完成

### E) Batch Size 限制
- [ ] 上傳 > 1000 筆資料
- [ ] UI 顯示錯誤：`批次資料過大：X 筆 (上限 1000 筆)`
- [ ] 建議訊息：`請將資料分成多個檔案上傳`

---

## 🔧 測試工具

### Console 快速測試 RPC

在瀏覽器 Console 執行（需先登入）：

```javascript
// 測試 ingest_goods_receipts_v1
const testRpc = async () => {
  const { data, error } = await supabase.rpc('ingest_goods_receipts_v1', {
    p_batch_id: crypto.randomUUID(),
    p_upload_file_id: crypto.randomUUID(),
    p_rows: [{
      material_code: 'TEST-001',
      material_name: 'Test Material',
      supplier_name: 'Test Supplier',
      actual_delivery_date: '2026-02-05',
      received_qty: 100,
      rejected_qty: 5
    }]
  });
  
  if (error) {
    console.error('RPC Error:', error);
  } else {
    console.log('RPC Success:', data);
  }
};

testRpc();
```

---

## 📊 Console Log 樣本

### RPC 主要路徑（成功）
```
[saveGoodsReceipts] Starting for 150 rows
[saveGoodsReceipts] Attempting RPC path...
[ingestGoodsReceiptsRpc] Starting RPC call for 150 rows
[ingestGoodsReceiptsRpc] batchId: aaaaa-..., uploadFileId: bbbbb-...
[ingestGoodsReceiptsRpc] Success: {
  inserted: 150,
  suppliersCreated: 5,
  suppliersFound: 10,
  materialsUpserted: 25
}
[saveGoodsReceipts] ✓ RPC Success: { inserted: 150, ... }
[saveGoodsReceipts] 完成！共寫入 150 筆記錄
```

### RPC Fallback 路徑
```
[saveGoodsReceipts] Starting for 150 rows
[saveGoodsReceipts] Attempting RPC path...
[ingestGoodsReceiptsRpc] RPC Error: { code: '42883', message: 'function ingest_goods_receipts_v1 does not exist' }
[RPC_FALLBACK] RPC failed, using legacy path: { code: '42883', ... }
[saveGoodsReceipts] Using legacy path (fallback)...
[saveGoodsReceipts] Found 15 unique suppliers, 25 unique materials
[batchUpsertSuppliers] Starting upsert for 15 suppliers
[batchUpsertSuppliers] Upserting chunk 1/1 (15 items)
[batchUpsertSuppliers] Upserted 15 suppliers
[saveGoodsReceipts] Supplier upsert完成，取得 15 個 ID
... (材料 upsert)
... (收貨記錄寫入)
[saveGoodsReceipts] 完成！共寫入 150 筆記錄
```

---

## 🛟 失敗 Fallback 處理

### 若 RPC 權限/RLS 卡住

**症狀**：
- Console 顯示 permission denied 或 RLS policy violation
- Fallback 機制啟動
- 使用舊邏輯成功完成

**處理**：
- ✅ 功能不中斷（已有 fallback）
- ⚠️ 記錄 `console.warn` 訊息，方便後續除錯
- 📋 在 issue tracker 記錄權限問題，稍後修正

### 若 upload_file_id 型別不匹配

**症狀**：
- RPC 拋錯：`cannot cast type uuid to bigint`

**暫時解決方案**：
1. 修改 `database/ingest_rpc.sql`：
   ```sql
   -- 移除型別轉換
   p_upload_file_id::BIGINT
   -- 改為
   p_upload_file_id
   ```
2. 或修改 RPC 參數型別：
   ```sql
   CREATE OR REPLACE FUNCTION ingest_goods_receipts_v1(
     p_batch_id UUID,
     p_upload_file_id BIGINT, -- 改為 BIGINT
     p_rows JSONB
   )
   ```

---

## 🎯 驗收標準

### ✅ 通過標準

1. **Build 測試**：✅ `npm run build` 成功
2. **RPC 主要路徑**：✅ Console 無 fallback 訊息，資料完整
3. **Fallback 機制**：✅ RPC 失敗時能自動切換並完成
4. **Transaction 回滾**：✅ 中途失敗時無半套資料
5. **UI 通知清楚**：✅ 使用者知道走了哪條路徑

### ❌ 未通過情境（需修正）

- RPC 失敗且 fallback 也失敗 → 檢查舊邏輯是否正常
- 資料有半套（部分 supplier 寫入但 receipts 失敗）→ 檢查 transaction
- Console 沒有 fallback 訊息但 UI 顯示 warning → 檢查通知邏輯

---

## 📝 已知限制與 TODO

### 限制 1: 批次大小 ≤ 1000 rows
**原因**：Supabase RPC payload limit (~1-2 MB)  
**TODO**：Phase 3 實作 Staging + Finalize 機制

### 限制 2: upload_file_id 型別可能不匹配
**原因**：`user_files.id` 可能是 UUID，但 `goods_receipts.upload_file_id` 是 BIGINT  
**TODO**：統一型別或調整 RPC 參數

### 限制 3: 其他 upload types 尚未整合 RPC
**現況**：只有 `goods_receipt` 和 `price_history` 使用 RPC  
**TODO**：Phase 2-3 逐步整合其他類型（bom_edge, demand_fg 等）

---

## 🚀 下一步：Phase 2

**準備進入 Phase 2：策略模式模組化**

**目標**：
- 簡化 `handleSave` 到 < 50 行
- 建立策略模式架構
- 集中管理上傳狀態

**前置條件**：
- ✅ Phase 0: 資料一致性完成
- ✅ Phase 1: RPC 整合 + Fallback 完成
- ⏭️ Phase 2: 等待驗收通過

---

## 📞 回報方式

測試完成後，請回報：

### ✅ 成功情境
```
Phase 1 RPC 測試通過：
- ✓ RPC 主要路徑正常（150 筆，2.3 秒）
- ✓ Fallback 機制正常（Function 不存在時自動切換）
- ✓ Transaction 回滾正確（無半套資料）
- ✓ 準備進入 Phase 2
```

### ❌ 失敗情境
```
Phase 1 RPC 測試失敗：
- ✗ RPC 報錯：[具體錯誤訊息]
- ✗ Fallback 失敗：[具體錯誤訊息]
- 附上 Console log 和錯誤截圖
```

---

**Status**: ✅ **Ready for Testing**  
**Version**: Phase 1 Complete  
**Last Updated**: 2026-02-05
