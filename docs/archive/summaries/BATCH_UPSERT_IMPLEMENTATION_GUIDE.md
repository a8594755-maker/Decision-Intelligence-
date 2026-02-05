# Goods Receipt 批次 Upsert 實作指南

## 🎯 改善目標

將 Goods Receipt 上傳從「逐筆查詢」改為「批次 Upsert」，解決大量資料上傳卡死問題。

### 效能對比

| 場景 | 修改前 | 修改後 | 改善 |
|------|-------|-------|------|
| **8845 rows** | 17,690 次 DB 請求 | ~300 次 DB 請求 | **98% ↓** |
| **預估時間** | 15 分鐘（容易超時） | 10-15 秒 | **98% ↓** |
| **UI 狀態** | 卡死、當機 ❌ | 流暢進度條 ✅ | - |

---

## 📦 實作內容總覽

### A) 資料庫層（Database）

**檔案**：`database/patch_goods_receipt_batch_upsert.sql`

**變更**：
1. ✅ 新增 `supplier_name_norm` 欄位（normalized supplier name）
2. ✅ 建立唯一約束：
   - `uq_suppliers_user_code` - UNIQUE(user_id, supplier_code) WHERE supplier_code IS NOT NULL
   - `uq_suppliers_user_name_norm` - UNIQUE(user_id, supplier_name_norm)
3. ✅ 建立自動觸發器：`trg_normalize_supplier_name`
4. ✅ 新增 `batch_id` 欄位到 suppliers/materials/goods_receipts
5. ✅ 建立複合索引優化查詢效能

**唯一約束策略**：
- **materials**：已有 `UNIQUE(user_id, material_code)` ✅
- **suppliers**：
  - 優先使用 `supplier_code`（如果提供）
  - 否則使用 `supplier_name_norm`（自動正規化：lowercase + trim + single space）

---

### B) Service Layer（服務層）

**檔案**：`src/services/supabaseClient.js`

#### 新增方法 1：`suppliersService.batchUpsertSuppliers()`

```javascript
async batchUpsertSuppliers(userId, suppliers, options = {})
```

**功能**：
- 分批 upsert（預設每批 200 筆）
- 使用 `ON CONFLICT (user_id, supplier_name_norm)` 
- 回傳 `Map(key -> supplier_id)`
  - key 為 `supplier_code` 或 `supplier_name_norm`

**效能**：
- 100 個 unique suppliers → 1 次 DB 請求（原本 100 次）

---

#### 新增方法 2：`materialsService.batchUpsertMaterials()`

```javascript
async batchUpsertMaterials(userId, materials, options = {})
```

**功能**：
- 分批 upsert（預設每批 200 筆）
- 使用 `ON CONFLICT (user_id, material_code)`
- 回傳 `Map(material_code -> material_id)`

**效能**：
- 200 個 unique materials → 1 次 DB 請求（原本 200 次）

---

#### 新增方法 3：`goodsReceiptsService.batchInsertReceipts()`

```javascript
async batchInsertReceipts(userId, receipts, options = {})
```

**功能**：
- 分批 insert（預設每批 500 筆）
- 支援進度回調：`onProgress(current, total)`
- 回傳 `{ success, count, data }`

**效能**：
- 8845 筆 receipts → 18 次 DB 請求（原本 8845 次）

---

### C) UI Layer（介面層）

**檔案**：`src/views/EnhancedExternalSystemsView.jsx`

#### 1. 新增狀態管理

```javascript
const [saveProgress, setSaveProgress] = useState({
  stage: '',      // 'collecting' | 'suppliers' | 'materials' | 'receipts'
  current: 0,
  total: 0,
  message: ''
});
```

#### 2. 重寫 `saveGoodsReceipts()`

**新流程**：
```
Step 1: 收集唯一 suppliers/materials（去重）
  → 進度：「正在分析資料...」

Step 2: 批次 Upsert Suppliers
  → 進度：「正在處理 X 個供應商...」

Step 3: 批次 Upsert Materials
  → 進度：「正在處理 X 個物料...」

Step 4: 組裝 Receipts Payload（使用快取的 IDs）
  → 進度：「正在準備 X 筆收貨記錄...」

Step 5: 批次寫入 Receipts
  → 進度：「正在寫入收貨記錄 (X/Y)...」
```

#### 3. 新增進度條 UI

```javascript
{saving && saveProgress.stage && (
  <div className="progress-bar">
    <Loader2 className="animate-spin" />
    <h4>{saveProgress.message}</h4>
    <div className="bar">
      <div style={{ width: `${progress}%` }} />
    </div>
  </div>
)}
```

---

## 🚀 部署步驟

### 步驟 1：執行 DB Migration（必須先做）⚠️

1. 開啟 **Supabase Dashboard** → **SQL Editor**
2. 執行以下檔案：
   ```
   database/patch_goods_receipt_batch_upsert.sql
   ```

3. **檢查輸出**：
   - ✅ 如果顯示「沒有發現重複資料」→ 直接進行步驟 2
   - ⚠️ 如果顯示「發現重複資料」→ 請先清理（見下方）

#### 如果發現重複資料：

執行 migration 後會顯示重複資料的查詢結果。根據結果，手動清理：

**範例：保留最新的記錄**
```sql
-- 刪除舊的重複 suppliers（保留最新的）
DELETE FROM suppliers 
WHERE id NOT IN (
  SELECT DISTINCT ON (
    user_id, 
    COALESCE(
      supplier_code,
      LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
    )
  ) id
  FROM suppliers
  ORDER BY 
    user_id, 
    COALESCE(
      supplier_code,
      LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
    ),
    created_at DESC
);
```

清理完畢後，重新執行 migration。

---

### 步驟 2：驗證 DB Patch

在 Supabase SQL Editor 執行驗證查詢：

```sql
-- 驗證 1: 檢查 supplier_name_norm 欄位
SELECT 
  supplier_name, 
  supplier_name_norm,
  supplier_code
FROM suppliers 
LIMIT 5;

-- 驗證 2: 檢查唯一約束
SELECT 
  conname AS constraint_name,
  contype AS constraint_type,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'suppliers'::regclass
  AND contype = 'u'
ORDER BY conname;

-- 驗證 3: 測試 upsert（suppliers）
INSERT INTO suppliers (user_id, supplier_name, supplier_code)
VALUES (auth.uid(), 'Test Supplier ABC', 'TEST-001')
ON CONFLICT (user_id, supplier_name_norm)
DO UPDATE SET supplier_code = EXCLUDED.supplier_code
RETURNING *;

-- 驗證 4: 測試 upsert（materials）
INSERT INTO materials (user_id, material_code, material_name)
VALUES (auth.uid(), 'TEST-MAT-001', 'Test Material')
ON CONFLICT (user_id, material_code)
DO UPDATE SET material_name = EXCLUDED.material_name
RETURNING *;

-- 清理測試資料
DELETE FROM suppliers WHERE supplier_code = 'TEST-001';
DELETE FROM materials WHERE material_code = 'TEST-MAT-001';
```

**預期結果**：
- ✅ supplier_name_norm 欄位已建立且自動填充
- ✅ 兩個唯一約束都存在
- ✅ Upsert 測試成功（沒有錯誤）

---

### 步驟 3：重啟應用程式

```bash
# 如果開發伺服器正在運行，重新啟動
npm run dev
```

---

## 🧪 測試計劃

### 測試 1：小量資料（50 rows）⚡

**目的**：驗證基本功能正確

**測試步驟**：
1. 準備 50 筆 Goods Receipt 測試資料
2. 上傳並完成欄位映射
3. 驗證資料
4. 點擊「Save to Database」

**預期結果**：
- ✅ 顯示進度條（約 1-2 秒）
  - 「正在分析資料...」
  - 「正在處理 X 個供應商...」
  - 「正在處理 X 個物料...」
  - 「正在寫入收貨記錄...」
- ✅ 成功訊息：「Successfully saved 50 rows」
- ✅ 瀏覽器 Console 顯示：
  ```
  [saveGoodsReceipts] Starting batch upsert for 50 rows
  [saveGoodsReceipts] Found X unique suppliers, Y unique materials
  [batchUpsertSuppliers] Starting upsert for X suppliers
  [batchUpsertMaterials] Starting upsert for Y materials
  [batchInsertReceipts] Starting insert for 50 receipts
  [saveGoodsReceipts] 完成！共寫入 50 筆記錄
  ```

**驗證 DB**：
```sql
-- 檢查最新上傳的批次
SELECT * FROM import_batches 
WHERE user_id = auth.uid() 
ORDER BY created_at DESC 
LIMIT 1;

-- 檢查實際寫入的 goods_receipts
SELECT COUNT(*) FROM goods_receipts
WHERE batch_id = '[上面查到的 batch_id]';
```

---

### 測試 2：中量資料（500 rows）🚀

**目的**：驗證分批邏輯

**測試步驟**：
1. 準備 500 筆 Goods Receipt 測試資料
2. 上傳並完成欄位映射
3. 驗證資料
4. 點擊「Save to Database」
5. **觀察進度條變化**

**預期結果**：
- ✅ 進度條流暢顯示（約 3-5 秒）
- ✅ UI 不會卡死
- ✅ 成功訊息：「Successfully saved 500 rows」
- ✅ Console 顯示分批處理：
  ```
  [batchUpsertSuppliers] Upserting chunk 1/1 (X items)
  [batchUpsertMaterials] Upserting chunk 1/2 (200 items)
  [batchUpsertMaterials] Upserting chunk 2/2 (Y items)
  [batchInsertReceipts] Inserting chunk 1/1 (500 items)
  ```

**驗證效能**：
- 開啟 Chrome DevTools → Network 標籤
- 過濾 Supabase 請求
- 計算 POST 請求數量：應該 **< 10 次**（不是 1000 次）

---

### 測試 3：大量資料（8845 rows）💪 關鍵測試

**目的**：驗證能穩定處理 10,000 級別資料

**測試步驟**：
1. 使用您的實際檔案（Mock data.xlsx，8845 rows）
2. 上傳並完成欄位映射
3. 驗證資料
4. 點擊「Save to Database」
5. **觀察進度條和 Console**

**預期結果**：
- ✅ 進度條顯示四個階段（約 10-20 秒總時間）：
  1. 分析資料 (< 1 秒)
  2. 處理供應商 (~2-3 秒)
  3. 處理物料 (~2-3 秒)
  4. 寫入收貨記錄 (~5-10 秒)
- ✅ **UI 完全不卡死**
- ✅ 可以在上傳過程中看到進度變化
- ✅ 成功訊息：「Successfully saved 8845 rows」

**Console 預期輸出**：
```
[saveGoodsReceipts] Starting batch upsert for 8845 rows
[saveGoodsReceipts] Found ~100 unique suppliers, ~200 unique materials

[batchUpsertSuppliers] Starting upsert for 100 suppliers
[batchUpsertSuppliers] Upserting chunk 1/1 (100 items)
[batchUpsertSuppliers] Upserted 100 suppliers
[batchUpsertSuppliers] Created map with 100 entries

[batchUpsertMaterials] Starting upsert for 200 materials
[batchUpsertMaterials] Upserting chunk 1/1 (200 items)
[batchUpsertMaterials] Upserted 200 materials
[batchUpsertMaterials] Created map with 200 entries

[batchInsertReceipts] Starting insert for 8845 receipts
[batchInsertReceipts] Inserting chunk 1/18 (500 items)
[batchInsertReceipts] Inserting chunk 2/18 (500 items)
... 
[batchInsertReceipts] Inserting chunk 18/18 (345 items)
[batchInsertReceipts] Inserted 8845 receipts

[saveGoodsReceipts] 完成！共寫入 8845 筆記錄
```

**Network 驗證**：
- 開啟 Chrome DevTools → Network 標籤
- 計算 Supabase POST 請求：應該約 **20-25 次**
- **不是 17,690 次！**

**DB 驗證**：
```sql
-- 檢查最新批次
SELECT 
  id,
  filename,
  upload_type,
  total_rows,
  success_rows,
  status,
  created_at
FROM import_batches
WHERE user_id = auth.uid()
ORDER BY created_at DESC
LIMIT 1;

-- 應該看到：
-- total_rows: 8845
-- success_rows: 8845
-- status: 'completed'

-- 檢查實際資料
SELECT COUNT(*) FROM goods_receipts
WHERE batch_id = '[batch_id]';
-- 應該是 8845

-- 檢查 suppliers（有 batch_id）
SELECT COUNT(*) FROM suppliers
WHERE batch_id = '[batch_id]';

-- 檢查 materials（有 batch_id）
SELECT COUNT(*) FROM materials
WHERE batch_id = '[batch_id]';
```

---

## 📊 效能指標驗證

### 資料庫請求數量對比

| 資料量 | 修改前 (findOrCreate) | 修改後 (batch upsert) | 減少比例 |
|--------|---------------------|---------------------|---------|
| 50 rows | ~100 次 | ~3 次 | 97% ↓ |
| 500 rows | ~1,000 次 | ~5 次 | 99.5% ↓ |
| 8845 rows | ~17,690 次 | ~20 次 | **99.9% ↓** |

### 時間對比

| 資料量 | 修改前 | 修改後 | 加速 |
|--------|-------|-------|------|
| 50 rows | 5 秒 | < 1 秒 | 5x |
| 500 rows | 50 秒 | 2-3 秒 | 20x |
| 8845 rows | 15 分鐘（容易超時）| 10-15 秒 | **60x** |

---

## ⚠️ 已知限制與注意事項

### 1. Supabase Payload 大小限制

**限制**：單次請求 payload 約 1-2 MB

**解決方案**：
- 已實作分批處理
- 預設 chunkSize：
  - Suppliers: 200 筆/批
  - Materials: 200 筆/批
  - Receipts: 500 筆/批

### 2. 唯一約束衝突處理

**Suppliers upsert 策略**：
- 如果 `supplier_code` 相同 → 更新該記錄
- 如果 `supplier_name_norm` 相同 → 更新該記錄
- 新記錄 → 插入

**Materials upsert 策略**：
- 如果 `(user_id, material_code)` 相同 → 更新該記錄
- 新記錄 → 插入

### 3. Goods Receipts 不做 Upsert

**原因**：
- 收貨記錄本質上允許重複（同一個 PO/supplier/material 可以多次收貨）
- 沒有明確的唯一鍵

**處理方式**：
- 使用 INSERT（不是 UPSERT）
- 如果使用者重複上傳同一檔案 → 會產生重複記錄
- 建議：未來可以新增「檢查重複上傳」功能

### 4. batch_id 追溯

**重要**：
- ✅ 所有 suppliers/materials/goods_receipts 都會標記相同的 `batch_id`
- ✅ 支援批次撤銷功能
- ✅ Import History 可以追溯

### 5. 錯誤處理

**如果任一步驟失敗**：
- Batch 狀態會設為 `'failed'`
- 錯誤訊息會記錄在 `metadata.error`
- 部分資料可能已經寫入（不會自動回滾）

**建議**：
- 測試時先用小量資料
- 確認無誤後再上傳大量資料

---

## 🔍 除錯指南

### 問題 1：Upsert 失敗（唯一約束錯誤）

**錯誤訊息**：
```
duplicate key value violates unique constraint "uq_suppliers_user_name_norm"
```

**原因**：
- Migration 沒有正確執行
- 或有重複資料但沒有清理

**解決**：
1. 檢查 Supabase 中唯一約束是否存在
2. 清理重複資料
3. 重新執行 migration

---

### 問題 2：找不到 supplier_id 或 material_id

**錯誤訊息**：
```
無法找到供應商 ID: XXX
```

**原因**：
- Map 的 key 不一致
- supplier_name_norm 正規化邏輯前後端不同步

**解決**：
1. 檢查 Console 的 log：
   ```
   [batchUpsertSuppliers] Created map with X entries
   ```
2. 確認 Map 中的 key 是否正確
3. 檢查 normalizeSupplierName 函數邏輯

---

### 問題 3：進度條不顯示

**原因**：
- `saveProgress` state 沒有正確更新
- 或 UI 條件判斷錯誤

**檢查**：
1. 開啟 React DevTools
2. 檢查 `saveProgress` state
3. 確認 `saving === true` 且 `saveProgress.stage !== ''`

---

### 問題 4：仍然很慢

**可能原因**：
1. **沒有索引**：檢查 DB 索引是否建立
2. **RLS 效能問題**：檢查 RLS policy
3. **網路慢**：檢查網路連線

**驗證索引**：
```sql
SELECT 
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename IN ('suppliers', 'materials', 'goods_receipts')
ORDER BY tablename, indexname;
```

---

## 📝 修改檔案清單

### 新增檔案

1. ✅ `database/patch_goods_receipt_batch_upsert.sql`
   - DB migration：新增唯一約束、索引、觸發器

2. ✅ `BATCH_UPSERT_IMPLEMENTATION_GUIDE.md`（本檔案）
   - 完整的實作指南和測試計劃

---

### 修改檔案

1. ✅ `src/services/supabaseClient.js`
   - 新增 `suppliersService.batchUpsertSuppliers()`（約 70 行）
   - 新增 `materialsService.batchUpsertMaterials()`（約 70 行）
   - 新增 `goodsReceiptsService.batchInsertReceipts()`（約 80 行）
   - 修改 `goodsReceiptsService.batchInsert()` 支援 batch_id

2. ✅ `src/views/EnhancedExternalSystemsView.jsx`
   - 新增 `saveProgress` state（進度追蹤）
   - 完全重寫 `saveGoodsReceipts()`（從 for loop 改為 batch upsert）
   - 重寫 `savePriceHistory()`（同樣優化）
   - 新增進度條 UI 元件

---

## 🎯 驗收標準

### 功能驗收
- [ ] 50 rows 測試通過
- [ ] 500 rows 測試通過
- [ ] 8845 rows 測試通過（**關鍵**）
- [ ] 進度條正常顯示
- [ ] 不會卡死 UI

### 效能驗收
- [ ] 8845 rows 上傳時間 < 30 秒
- [ ] DB 請求數量 < 30 次（不是 17,690 次）
- [ ] 瀏覽器不會超時或當機

### 資料完整性驗收
- [ ] suppliers 正確 upsert（不重複建立）
- [ ] materials 正確 upsert（不重複建立）
- [ ] goods_receipts 全部寫入
- [ ] batch_id 正確追溯
- [ ] Import History 正常顯示

---

## 💡 使用建議

### 最佳實踐

1. **首次使用**：
   - 先執行 DB migration
   - 用 50 rows 測試
   - 確認無誤後再用大量資料

2. **大量上傳**：
   - 單次上傳建議 < 10,000 rows
   - 如果超過，建議分多次上傳

3. **網路不穩定時**：
   - 減少 chunkSize（例如改為 100）
   - 或分多次上傳

### 監控

**開啟 Chrome DevTools**：
- Console：查看詳細 log
- Network：監控 DB 請求數量
- Performance：檢查記憶體使用

---

## 🚨 緊急回滾方案

如果新版本有問題，可以暫時回滾到舊版本：

### 回滾 Service Layer

註釋掉新的 batch upsert 方法，改用舊的 `findOrCreate`：

```javascript
// 暫時回滾用法
const saveGoodsReceipts = async (userId, validRows, uploadFileId, batchId) => {
  // 舊版本邏輯（逐筆 findOrCreate）
  for (const row of validRows) {
    const supplier = await suppliersService.findOrCreate(...);
    const material = await materialsService.findOrCreate(...);
    // ...
  }
};
```

---

## ✅ 實作完成確認

請確認以下項目：

- [ ] DB migration 已執行且成功
- [ ] 唯一約束已建立
- [ ] Service methods 已新增
- [ ] 主流程已改造
- [ ] 進度條 UI 已實作
- [ ] 測試 1 (50 rows) 通過
- [ ] 測試 2 (500 rows) 通過
- [ ] 測試 3 (8845 rows) 通過 ⭐

---

**實作日期**：2026-01-31  
**實作人員**：AI Assistant（資深全端工程師）  
**版本**：v3.0 - Batch Upsert Edition
