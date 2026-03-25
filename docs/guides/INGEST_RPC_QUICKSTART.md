---
owner: di-core-team
status: active
last_reviewed: 2026-03-24
---

# Ingest RPC Functions - 快速入門指南

## 📋 概述

Phase 1 已建立兩個高效能、交易性的 RPC functions，用於批次寫入資料到 Supabase。

**檔案位置**: `database/ingest_rpc.sql`

---

## 🎯 Functions

### 1. `ingest_goods_receipts_v1`
批次寫入收貨記錄（Goods Receipts），自動處理 supplier/material 查找或建立。

### 2. `ingest_price_history_v1`
批次寫入價格歷史（Price History），自動處理 supplier/material 查找或建立。

---

## ✨ 特性

- ✅ **Transaction 保證**: 全部成功或全部回滾（ACID）
- ✅ **Idempotency**: 基於 `batch_id` 可重複執行
- ✅ **自動處理**: 自動查找或建立 suppliers 和 materials
- ✅ **RLS 安全**: 使用 `auth.uid()` 確保資料隔離
- ✅ **詳細回傳**: 包含插入數量、建立/找到的 supplier/material 統計

---

## 🚀 如何部署

### 1. 在 Supabase Dashboard 執行

1. 登入 [Supabase Dashboard](https://app.supabase.com)
2. 選擇你的專案
3. 點擊左側選單的 **"SQL Editor"**
4. 點擊 **"New Query"**
5. 複製 `database/ingest_rpc.sql` 的完整內容並貼上
6. 點擊 **"Run"** 執行
7. 確認看到成功訊息：`Ingest RPC Functions 建立完成！`

### 2. 驗證部署

執行以下 SQL 確認 functions 已建立：

```sql
SELECT 
  routine_name, 
  routine_type, 
  security_type
FROM information_schema.routines
WHERE routine_name LIKE 'ingest_%_v1'
  AND routine_schema = 'public';
```

預期結果：
```
routine_name               | routine_type | security_type
---------------------------|--------------|---------------
ingest_goods_receipts_v1   | FUNCTION     | DEFINER
ingest_price_history_v1    | FUNCTION     | DEFINER
```

---

## 💻 前端呼叫範例

### 呼叫 `ingest_goods_receipts_v1`

```javascript
// src/services/supabaseClient.js
export const goodsReceiptsService = {
  async batchInsertViaRPC(userId, receipts, uploadFileId, batchId) {
    const { data, error } = await supabase.rpc('ingest_goods_receipts_v1', {
      p_batch_id: batchId,
      p_upload_file_id: uploadFileId,
      p_rows: receipts.map(r => ({
        material_code: r.material_code,
        material_name: r.material_name || r.material_code,
        supplier_code: r.supplier_code || null,
        supplier_name: r.supplier_name,
        po_number: r.po_number || null,
        receipt_number: r.receipt_number || null,
        planned_delivery_date: r.planned_delivery_date || null,
        actual_delivery_date: r.actual_delivery_date,
        receipt_date: r.receipt_date || r.actual_delivery_date,
        received_qty: r.received_qty,
        rejected_qty: r.rejected_qty || 0,
        uom: r.uom || 'pcs'
      }))
    });

    if (error) {
      console.error('RPC Error:', error);
      throw new Error(`Batch insert failed: ${error.message}`);
    }

    return {
      success: data.success,
      count: data.inserted_count,
      suppliers_created: data.suppliers_created,
      suppliers_found: data.suppliers_found,
      materials_upserted: data.materials_upserted
    };
  }
};
```

### 呼叫 `ingest_price_history_v1`

```javascript
export const priceHistoryService = {
  async batchInsertViaRPC(userId, prices, uploadFileId, batchId) {
    const { data, error } = await supabase.rpc('ingest_price_history_v1', {
      p_batch_id: batchId,
      p_upload_file_id: uploadFileId,
      p_rows: prices.map(p => ({
        material_code: p.material_code,
        material_name: p.material_name || p.material_code,
        supplier_code: p.supplier_code || null,
        supplier_name: p.supplier_name,
        order_date: p.order_date,
        unit_price: p.unit_price,
        currency: p.currency || 'USD',
        quantity: p.quantity || 0,
        is_contract_price: p.is_contract_price || false,
        uom: p.uom || 'pcs'
      }))
    });

    if (error) {
      console.error('RPC Error:', error);
      throw new Error(`Batch insert failed: ${error.message}`);
    }

    return {
      success: data.success,
      count: data.inserted_count,
      suppliers_created: data.suppliers_created,
      suppliers_found: data.suppliers_found,
      materials_upserted: data.materials_upserted
    };
  }
};
```

---

## 📊 回傳格式

兩個 functions 都回傳 JSONB 格式：

```json
{
  "success": true,
  "inserted_count": 150,
  "suppliers_created": 5,
  "suppliers_found": 10,
  "materials_upserted": 25,
  "batch_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "upload_file_id": "11111111-2222-3333-4444-555555555555"
}
```

### 欄位說明

| 欄位 | 型別 | 說明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `inserted_count` | integer | 插入的記錄數量 |
| `suppliers_created` | integer | 新建立的 supplier 數量 |
| `suppliers_found` | integer | 找到的現有 supplier 數量 |
| `materials_upserted` | integer | Upsert 的 material 數量（新建或更新） |
| `batch_id` | UUID | 批次 ID |
| `upload_file_id` | UUID | 上傳檔案 ID |

---

## ⚠️ 重要注意事項

### 1. **upload_file_id 型別問題**

**問題**: `user_files.id` 可能是 `UUID`，但 `goods_receipts.upload_file_id` 是 `BIGINT`

**解決方案**:
- RPC 內部會嘗試型別轉換：`p_upload_file_id::BIGINT`
- 若轉換失敗，請根據實際情況修改：
  - **選項 A**: 修改 `user_files.id` 為 `BIGINT`
  - **選項 B**: 修改 `goods_receipts.upload_file_id` 為 `UUID`
  - **選項 C**: 修改 RPC 參數型別為 `TEXT` 並移除型別轉換

**檢查方式**:
```sql
-- 檢查 user_files.id 型別
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'user_files' 
  AND column_name = 'id';

-- 檢查 goods_receipts.upload_file_id 型別
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'goods_receipts' 
  AND column_name = 'upload_file_id';
```

### 2. **必填欄位**

#### `ingest_goods_receipts_v1`:
- `material_code` (TEXT)
- `actual_delivery_date` (DATE)
- `received_qty` (NUMERIC >= 0)
- `supplier_name` OR `supplier_code` (至少一個)

#### `ingest_price_history_v1`:
- `material_code` (TEXT)
- `order_date` OR `effective_date` (DATE)
- `unit_price` OR `price` (NUMERIC >= 0)
- `supplier_name` OR `supplier_code` (至少一個)

### 3. **Idempotency 行為**

每次呼叫 RPC 時，會先刪除同 `batch_id` 的舊資料：

```sql
DELETE FROM goods_receipts 
WHERE user_id = auth.uid() 
  AND batch_id = p_batch_id;
```

這意味著：
- ✅ 可以安全地重複執行（重新上傳）
- ⚠️ 會覆蓋之前的資料（若 batch_id 相同）
- ✅ 不同 batch_id 的資料不受影響

---

## 🐛 錯誤處理

### 常見錯誤訊息

#### 1. `NOT_AUTHENTICATED`
```
EXCEPTION: NOT_AUTHENTICATED: User must be logged in to ingest data
```
**原因**: 未登入或 session 過期  
**解決**: 確認 `auth.uid()` 有值，重新登入

#### 2. `VALIDATION_ERROR: material_code is required`
```
EXCEPTION: VALIDATION_ERROR: material_code is required
```
**原因**: 缺少必填欄位  
**解決**: 檢查 p_rows 中每個物件是否包含所有必填欄位

#### 3. `VALIDATION_ERROR: received_qty must be >= 0`
```
EXCEPTION: VALIDATION_ERROR: received_qty must be >= 0
```
**原因**: 數量欄位為負數  
**解決**: 確保 `received_qty`、`unit_price` 等數量欄位 >= 0

#### 4. `INGEST_ERROR: ...`
```
EXCEPTION: INGEST_ERROR: duplicate key value violates unique constraint (SQLSTATE: 23505)
```
**原因**: 資料庫約束違反（unique constraint 等）  
**解決**: 檢查資料是否重複，查看 SQLSTATE 碼

---

## 🔍 除錯技巧

### 1. 查看 Supabase Logs

**Dashboard > Logs > Postgres Logs**
- 可以看到 SQL 執行記錄
- 可以看到 EXCEPTION 的完整堆疊

### 2. 手動測試 SQL

在 SQL Editor 中執行（需要登入 context）：

```sql
-- 測試最小範例
SELECT ingest_goods_receipts_v1(
  gen_random_uuid(), -- batch_id
  gen_random_uuid(), -- upload_file_id
  '[{
    "material_code": "TEST-001",
    "supplier_name": "Test Supplier",
    "actual_delivery_date": "2026-02-05",
    "received_qty": 100
  }]'::JSONB
);
```

### 3. 檢查中間結果

修改 RPC 加入 `RAISE NOTICE` 來輸出中間變數：

```sql
RAISE NOTICE 'Supplier ID found: %', v_supplier_id;
RAISE NOTICE 'Material ID: %', v_material_id;
```

---

## 📈 效能建議

### 1. **批次大小**
- 建議每次 RPC 呼叫處理 **500-1000 筆**資料
- 若超過 1000 筆，建議分批呼叫（前端分批）

### 2. **Payload 大小**
- Supabase RPC 預設 payload limit: **1-2 MB**
- 若資料量大，考慮壓縮或分批

### 3. **索引優化**
確保以下索引存在（已在 schema 中建立）：
- `suppliers(user_id, supplier_code)`
- `suppliers(user_id, supplier_name_norm)`
- `materials(user_id, material_code)`
- `goods_receipts(user_id, batch_id)`
- `price_history(user_id, batch_id)`

---

## ✅ 驗收檢查清單

- [x] SQL 檔案已建立：`database/ingest_rpc.sql`
- [x] 兩個 functions 已定義：
  - [x] `ingest_goods_receipts_v1`
  - [x] `ingest_price_history_v1`
- [x] 使用 `auth.uid()` 控制安全性
- [x] 開頭檢查 `auth.uid() IS NULL` 並拋錯
- [x] 使用 `jsonb_to_recordset` 解析資料
- [x] Supplier 查找邏輯：優先 `supplier_code`，否則 `supplier_name_norm`
- [x] Material upsert 使用 `(user_id, material_code)` 約束
- [x] Idempotency: 刪除同 `batch_id` 舊資料
- [x] 插入時包含：`user_id`, `supplier_id`, `material_id`, `upload_file_id`, `batch_id`
- [x] 錯誤時 `RAISE EXCEPTION` 觸發 rollback
- [x] 回傳 JSONB 包含統計資訊
- [x] `GRANT EXECUTE TO authenticated`
- [x] 包含執行說明和測試範例

---

## 📚 相關文件

- **主 SQL 檔案**: `database/ingest_rpc.sql`
- **Schema 定義**: `database/supplier_kpi_schema.sql`
- **Import Batches**: `database/import_batches_schema.sql`
- **前端 Service**: `src/services/supabaseClient.js`

---

## 🆘 需要幫助？

若遇到問題，請檢查：

1. **執行順序**: 確保先執行 schema 檔案，再執行 ingest_rpc.sql
2. **權限設定**: 確認 `authenticated` role 有 EXECUTE 權限
3. **RLS 設定**: 確認表的 RLS policies 正確設定
4. **型別匹配**: 檢查 `upload_file_id` 型別是否一致

---

**Version**: Phase 1 完成  
**Last Updated**: 2026-02-05  
**Status**: ✅ Ready for Testing
