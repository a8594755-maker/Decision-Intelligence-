---
owner: di-core-team
status: active
last_reviewed: 2026-03-24
---

# 資料庫結構與 Payload 格式說明

## 概述

本文檔說明各個上傳類型對應的資料庫表結構和插入資料的 payload 格式。

## 資料庫表結構

### 1. `suppliers` - 供應商主檔

存放供應商基本資料。

```sql
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  supplier_name TEXT NOT NULL,
  supplier_code TEXT,
  contact_info JSONB,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_suppliers_user_id ON suppliers(user_id);
CREATE INDEX idx_suppliers_name ON suppliers(supplier_name);
CREATE INDEX idx_suppliers_code ON suppliers(supplier_code);
```

**Payload 格式：**

```javascript
{
  user_id: "uuid",
  supplier_name: "供應商名稱",
  supplier_code: "SUP001",  // 可選
  contact_info: {
    contact_person: "聯絡人",
    phone: "電話",
    email: "email@example.com",
    address: "地址",
    product_category: "產品類別",
    payment_terms: "月結30天",
    delivery_time: "7天"
  },
  status: "active"  // active | inactive | suspended
}
```

---

### 2. `materials` - 物料主檔

存放物料資料。

```sql
CREATE TABLE materials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  material_code TEXT NOT NULL,
  material_name TEXT NOT NULL,
  category TEXT,
  uom TEXT DEFAULT 'pcs',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_materials_user_id ON materials(user_id);
CREATE INDEX idx_materials_code ON materials(material_code);
CREATE UNIQUE INDEX idx_materials_user_code ON materials(user_id, material_code);
```

**Payload 格式：**

```javascript
{
  user_id: "uuid",
  material_code: "MAT001",
  material_name: "物料名稱",
  category: "原物料",  // 可選
  uom: "pcs"  // 計量單位，預設 pcs
}
```

---

### 3. `goods_receipts` - 收貨記錄

存放收貨資料，用於計算不良率和準時率。

```sql
CREATE TABLE goods_receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  material_id UUID NOT NULL REFERENCES materials(id),
  po_number TEXT,
  receipt_number TEXT,
  planned_delivery_date DATE,
  actual_delivery_date DATE NOT NULL,
  receipt_date DATE,
  received_qty NUMERIC NOT NULL CHECK (received_qty >= 0),
  rejected_qty NUMERIC DEFAULT 0 CHECK (rejected_qty >= 0),
  upload_file_id UUID REFERENCES user_files(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_goods_receipts_user_id ON goods_receipts(user_id);
CREATE INDEX idx_goods_receipts_supplier_id ON goods_receipts(supplier_id);
CREATE INDEX idx_goods_receipts_material_id ON goods_receipts(material_id);
CREATE INDEX idx_goods_receipts_actual_delivery_date ON goods_receipts(actual_delivery_date);
CREATE INDEX idx_goods_receipts_upload_file_id ON goods_receipts(upload_file_id);
```

**Payload 格式：**

```javascript
{
  user_id: "uuid",
  supplier_id: "uuid",  // 從 suppliers 表查詢或創建
  material_id: "uuid",  // 從 materials 表查詢或創建
  po_number: "PO20240115001",  // 可選
  receipt_number: "REC20240115001",  // 可選
  planned_delivery_date: "2024-01-15",  // 可選，ISO 日期格式
  actual_delivery_date: "2024-01-16",  // 必填，ISO 日期格式
  receipt_date: "2024-01-16",  // 可選，預設同 actual_delivery_date
  received_qty: 100,  // 必填，數字
  rejected_qty: 5,  // 可選，預設 0
  upload_file_id: "uuid"  // 對應 user_files 表
}
```

**KPI 計算：**
- **不良率** = `(rejected_qty / received_qty) * 100`
- **準時率** = 如果 `actual_delivery_date <= planned_delivery_date` 則計為準時

---

### 4. `price_history` - 價格歷史

存放價格資料，用於計算價格波動度。

```sql
CREATE TABLE price_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  material_id UUID NOT NULL REFERENCES materials(id),
  order_date DATE NOT NULL,
  unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
  currency TEXT DEFAULT 'USD',
  quantity NUMERIC DEFAULT 0,
  is_contract_price BOOLEAN DEFAULT FALSE,
  upload_file_id UUID REFERENCES user_files(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_price_history_user_id ON price_history(user_id);
CREATE INDEX idx_price_history_supplier_id ON price_history(supplier_id);
CREATE INDEX idx_price_history_material_id ON price_history(material_id);
CREATE INDEX idx_price_history_order_date ON price_history(order_date);
CREATE INDEX idx_price_history_upload_file_id ON price_history(upload_file_id);
```

**Payload 格式：**

```javascript
{
  user_id: "uuid",
  supplier_id: "uuid",  // 從 suppliers 表查詢或創建
  material_id: "uuid",  // 從 materials 表查詢或創建
  order_date: "2024-01-15",  // 必填，ISO 日期格式
  unit_price: 25.50,  // 必填，數字
  currency: "USD",  // 可選，預設 USD
  quantity: 1000,  // 可選，預設 0
  is_contract_price: false,  // 可選，預設 false
  upload_file_id: "uuid"  // 對應 user_files 表
}
```

**KPI 計算：**
- **價格波動度** = `(MAX(unit_price) - MIN(unit_price)) / AVG(unit_price) * 100`

---

### 5. `user_files` - 上傳檔案記錄

存放使用者上傳的原始檔案資訊。

```sql
CREATE TABLE user_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  filename TEXT NOT NULL,
  data JSONB NOT NULL,
  upload_type TEXT,  -- 'goods_receipt' | 'price_history' | 'supplier_master'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_user_files_user_id ON user_files(user_id);
CREATE INDEX idx_user_files_created_at ON user_files(created_at DESC);
```

**Payload 格式：**

```javascript
{
  user_id: "uuid",
  filename: "goods_receipt_2024-01-15.xlsx",
  data: [...],  // 原始 JSON 資料
  upload_type: "goods_receipt"
}
```

---

## 資料寫入流程

### 收貨記錄 (Goods Receipt)

1. **查詢或創建供應商**
   ```javascript
   const supplier = await suppliersService.findOrCreate(userId, {
     supplier_name: row.supplier_name,
     supplier_code: row.supplier_code || null
   });
   ```

2. **查詢或創建物料**
   ```javascript
   const material = await materialsService.findOrCreate(userId, {
     material_code: row.material_code,
     material_name: row.material_name || row.material_code,
     category: row.category || null,
     uom: row.uom || 'pcs'
   });
   ```

3. **構建收貨記錄並批量插入**
   ```javascript
   await goodsReceiptsService.batchInsert(userId, receipts, uploadFileId);
   ```

### 價格歷史 (Price History)

流程與收貨記錄類似：
1. 查詢或創建供應商
2. 查詢或創建物料
3. 構建價格記錄並批量插入

### 供應商主檔 (Supplier Master)

直接批量插入供應商資料：
```javascript
await suppliersService.insertSuppliers(suppliers);
```

---

## Service API 介面

### suppliersService

```javascript
// 查詢或創建供應商
findOrCreate(userId, { supplier_name, supplier_code })

// 批量插入供應商
insertSuppliers(suppliers)
```

### materialsService

```javascript
// 查詢或創建物料
findOrCreate(userId, { material_code, material_name, category, uom })
```

### goodsReceiptsService

```javascript
// 批量插入收貨記錄
batchInsert(userId, receipts, uploadFileId)
```

### priceHistoryService

```javascript
// 批量插入價格歷史
batchInsert(userId, prices, uploadFileId)
```

### userFilesService

```javascript
// 保存上傳檔案記錄
saveFile(userId, filename, data)
```

---

## 資料一致性與關聯

### 外鍵關聯

```
user_files
    ↓ upload_file_id
goods_receipts / price_history
    ↓ supplier_id, material_id
suppliers, materials
    ↓ user_id
auth.users
```

### 級聯刪除規則

建議設定：
- 刪除 user → 級聯刪除所有相關資料
- 刪除 supplier → 保留收貨記錄（設為 NULL 或限制刪除）
- 刪除 material → 保留收貨記錄（設為 NULL 或限制刪除）

---

## 重要注意事項

1. **只寫入有效資料**：驗證失敗的資料 (errorRows) 不會被寫入資料庫
2. **批量操作**：使用批量插入提高效能
3. **關聯資料**：供應商和物料會自動創建或查詢已存在的記錄
4. **user_id**：所有資料都會記錄所屬的使用者
5. **upload_file_id**：關聯到原始上傳檔案，便於追溯
6. **日期格式**：所有日期都轉換為 ISO 格式（YYYY-MM-DD）
7. **數值驗證**：數量和價格都必須 >= 0

---

## 範例完整流程

```javascript
// 1. 上傳檔案
const file = uploadExcelFile();

// 2. 解析資料
const rawRows = parseExcel(file);

// 3. 欄位映射
const columnMapping = {
  "供應商": "supplier_name",
  "料號": "material_code",
  "收貨日期": "actual_delivery_date",
  "數量": "received_qty"
};

// 4. 驗證與清洗
const { validRows, errorRows, stats } = validateAndCleanData(
  rawRows, 
  'goods_receipt', 
  columnMapping
);

// 5. 只寫入有效資料
if (validRows.length > 0) {
  const fileRecord = await userFilesService.saveFile(userId, fileName, rawRows);
  await saveGoodsReceipts(userId, validRows, fileRecord.id);
  
  console.log(`成功儲存 ${validRows.length} 筆資料`);
  console.log(`略過 ${errorRows.length} 筆錯誤資料`);
}
```

---

## 檔案位置

- 資料驗證：`src/utils/dataValidation.js`
- Schema 定義：`src/utils/uploadSchemas.js`
- 保存邏輯：`src/views/EnhancedExternalSystemsView.jsx`
- Supabase 服務：`src/services/supabaseClient.js`
