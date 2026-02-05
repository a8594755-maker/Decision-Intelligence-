# Step 1 Supply, Inventory & Financials Schema - 部署指南

## 📋 概述

本文件說明如何部署 `step1_supply_inventory_financials_schema.sql`，為 SmartOps 系統新增 3 張表：

1. **po_open_lines** - 采購訂單未交貨明細（Open PO / Supply Commitments）
2. **inventory_snapshots** - 庫存快照（Inventory Snapshot）
3. **fg_financials** - 成品財務數據（FG Margin / Price Rules）

---

## 🎯 資料表功能

### 1️⃣ po_open_lines（采購訂單未交貨明細）

**用途：** 追蹤采購訂單的未交貨數量，用於供應鏈計劃和物料可用性分析

**核心欄位：**
- `po_number` + `po_line` - 采購訂單號與行號
- `material_code` - 物料代碼
- `plant_id` - 工廠代碼
- `time_bucket` - 時間桶（支援週別 `YYYY-W##` 或日期 `YYYY-MM-DD`）
- `open_qty` - 未交貨數量（>= 0）
- `supplier_id` - 供應商代碼
- `status` - 狀態（open/closed/cancelled）

**唯一性約束：**
```sql
UNIQUE(user_id, po_number, po_line, time_bucket)
```
支援 **upsert** 操作（INSERT ... ON CONFLICT UPDATE）

**索引：**
- `(user_id, plant_id, time_bucket)` - 按工廠和時間查詢
- `(user_id, material_code)` - 按物料查詢

---

### 2️⃣ inventory_snapshots（庫存快照）

**用途：** 記錄特定時間點的庫存狀態，用於庫存管理和計劃

**核心欄位：**
- `material_code` - 物料代碼
- `plant_id` - 工廠代碼
- `snapshot_date` - 快照日期（YYYY-MM-DD）
- `onhand_qty` - 在庫數量（實際庫存，>= 0）
- `allocated_qty` - 已分配數量（已承諾但未出貨，>= 0）
- `safety_stock` - 安全庫存（>= 0）

**唯一性約束：**
```sql
UNIQUE(user_id, material_code, plant_id, snapshot_date)
```
支援 **upsert** 操作

**索引：**
- `(user_id, plant_id, snapshot_date)` - 按工廠和日期查詢
- `(user_id, material_code)` - 按物料查詢

---

### 3️⃣ fg_financials（成品財務數據）

**用途：** 定義成品的財務信息，包含售價、利潤、有效期間

**核心欄位：**
- `material_code` - 成品代碼（FG）
- `unit_margin` - 單位利潤（必填，>= 0）
- `plant_id` - 工廠代碼（**NULL = 全球通用定價**）
- `unit_price` - 單位售價（>= 0）
- `currency` - 幣別（預設 USD）
- `valid_from` / `valid_to` - 有效期間

**唯一性約束：**
```sql
UNIQUE INDEX ON (
  user_id, 
  material_code, 
  COALESCE(plant_id, ''), 
  currency, 
  COALESCE(valid_from, '1900-01-01'), 
  COALESCE(valid_to, '2999-12-31')
)
```
使用 **UNIQUE INDEX with COALESCE** 處理 NULL 值，支援 **upsert** 操作

**索引：**
- `(user_id, material_code)` - 按物料查詢
- `(valid_from, valid_to)` - 按有效期間查詢

---

## 🚀 部署步驟

### Step 1: 備份現有資料（如適用）

如果您的資料庫已有數據，建議先備份：

```sql
-- 在 Supabase SQL Editor 執行
-- 檢查現有表是否存在
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('po_open_lines', 'inventory_snapshots', 'fg_financials');
```

### Step 2: 執行 Schema 腳本

1. **登入 Supabase Dashboard**
   - 前往您的 SmartOps 專案
   - 點擊左側選單的 **SQL Editor**

2. **開啟新查詢**
   - 點擊 **New Query** 按鈕

3. **複製並貼上 SQL 內容**
   - 開啟檔案：`database/step1_supply_inventory_financials_schema.sql`
   - 複製全部內容
   - 貼上到 SQL Editor

4. **執行腳本**
   - 點擊右下角的 **Run** 按鈕（或按 `Ctrl+Enter`）
   - 等待執行完成（約 2-5 秒）

5. **確認成功訊息**
   - 在 Results 視窗應該會看到成功提示：
   ```
   Supply, Inventory & Financials 模块数据库架构创建完成！
   已创建的表:
     1. po_open_lines
     2. inventory_snapshots
     3. fg_financials
   ```

### Step 3: 驗證表結構

執行以下查詢驗證表是否正確創建：

```sql
-- 查看表結構
\d po_open_lines
\d inventory_snapshots
\d fg_financials

-- 或使用 Supabase Table Editor
-- 左側選單 → Table Editor → 應該能看到新表
```

### Step 4: 測試基本操作

```sql
-- 測試 po_open_lines（應返回 0 rows）
SELECT * FROM po_open_lines LIMIT 1;

-- 測試 inventory_snapshots（應返回 0 rows）
SELECT * FROM inventory_snapshots LIMIT 1;

-- 測試 fg_financials（應返回 0 rows）
SELECT * FROM fg_financials LIMIT 1;

-- 測試 RLS（確認只能看到自己的數據）
-- 這個查詢應該成功，但返回空結果（因為還沒有數據）
SELECT COUNT(*) FROM po_open_lines;
```

---

## 🔐 安全性設計

### Row Level Security (RLS)

所有 3 張表都啟用了 **Row Level Security**，確保：

- ✅ 用戶只能查看自己的數據（`user_id = auth.uid()`）
- ✅ 用戶只能插入自己的數據
- ✅ 用戶只能更新自己的數據
- ✅ 用戶只能刪除自己的數據

### 數據隔離

```sql
-- RLS Policy 範例（自動套用）
CREATE POLICY "Users can view their own po_open_lines"
  ON po_open_lines FOR SELECT
  USING (auth.uid() = user_id);
```

這意味著：
- User A 無法看到 User B 的數據
- 每個用戶擁有獨立的數據空間
- 自動套用於所有查詢

---

## 📊 索引優化

### 查詢效能

所有表都已建立適當的索引，優化常見查詢：

**po_open_lines:**
```sql
-- 快速查詢範例（已優化）
SELECT * FROM po_open_lines 
WHERE user_id = auth.uid() 
  AND plant_id = 'PLANT-01' 
  AND time_bucket = '2026-W05';
```

**inventory_snapshots:**
```sql
-- 快速查詢範例（已優化）
SELECT * FROM inventory_snapshots 
WHERE user_id = auth.uid() 
  AND material_code = 'COMP-3100';
```

**fg_financials:**
```sql
-- 快速查詢範例（已優化）
SELECT * FROM fg_financials 
WHERE user_id = auth.uid() 
  AND material_code = 'FG-2000' 
  AND valid_from <= CURRENT_DATE 
  AND (valid_to IS NULL OR valid_to >= CURRENT_DATE);
```

---

## 🔄 Upsert 支援

所有表都支援 **INSERT ... ON CONFLICT UPDATE** 操作：

### 範例：po_open_lines

```sql
INSERT INTO po_open_lines (
  user_id, po_number, po_line, material_code, 
  plant_id, time_bucket, open_qty, supplier_id
)
VALUES (
  auth.uid(), 'PO-10001', '10', 'COMP-3100',
  'PLANT-01', '2026-W05', 5000, 'SUP-001'
)
ON CONFLICT (user_id, po_number, po_line, time_bucket)
DO UPDATE SET
  open_qty = EXCLUDED.open_qty,
  supplier_id = EXCLUDED.supplier_id,
  updated_at = NOW();
```

### 範例：inventory_snapshots

```sql
INSERT INTO inventory_snapshots (
  user_id, material_code, plant_id, 
  snapshot_date, onhand_qty, safety_stock
)
VALUES (
  auth.uid(), 'COMP-3100', 'PLANT-01',
  '2026-01-31', 15000, 5000
)
ON CONFLICT (user_id, material_code, plant_id, snapshot_date)
DO UPDATE SET
  onhand_qty = EXCLUDED.onhand_qty,
  safety_stock = EXCLUDED.safety_stock,
  updated_at = NOW();
```

### 範例：fg_financials

```sql
-- 注意：fg_financials 使用 UNIQUE INDEX，需要匹配所有欄位
INSERT INTO fg_financials (
  user_id, material_code, plant_id, 
  unit_margin, unit_price, currency, valid_from, valid_to
)
VALUES (
  auth.uid(), 'FG-2000', 'PLANT-01',
  25.50, 125.00, 'USD', '2026-01-01', '2026-06-30'
)
ON CONFLICT ON CONSTRAINT idx_fg_financials_unique_key
DO UPDATE SET
  unit_margin = EXCLUDED.unit_margin,
  unit_price = EXCLUDED.unit_price,
  updated_at = NOW();
```

---

## 🧪 測試數據插入

執行以下測試確認一切正常：

```sql
-- 測試 1: 插入 PO Open Line
INSERT INTO po_open_lines (
  user_id, po_number, po_line, material_code, plant_id, 
  time_bucket, open_qty, uom, supplier_id, status
) VALUES (
  auth.uid(), 'PO-TEST-001', '10', 'COMP-3100', 'PLANT-01',
  '2026-W05', 1000, 'pcs', 'SUP-001', 'open'
);

-- 測試 2: 插入 Inventory Snapshot
INSERT INTO inventory_snapshots (
  user_id, material_code, plant_id, snapshot_date, 
  onhand_qty, allocated_qty, safety_stock
) VALUES (
  auth.uid(), 'COMP-3100', 'PLANT-01', '2026-01-31',
  5000, 2000, 1000
);

-- 測試 3: 插入 FG Financial
INSERT INTO fg_financials (
  user_id, material_code, plant_id, unit_margin, 
  unit_price, currency, valid_from, valid_to
) VALUES (
  auth.uid(), 'FG-2000', 'PLANT-01', 25.50,
  125.00, 'USD', '2026-01-01', '2026-12-31'
);

-- 驗證插入成功
SELECT COUNT(*) as po_count FROM po_open_lines;
SELECT COUNT(*) as inv_count FROM inventory_snapshots;
SELECT COUNT(*) as fg_count FROM fg_financials;

-- 清理測試數據（可選）
DELETE FROM po_open_lines WHERE po_number = 'PO-TEST-001';
DELETE FROM inventory_snapshots WHERE material_code = 'COMP-3100';
DELETE FROM fg_financials WHERE material_code = 'FG-2000';
```

---

## 📦 批次追蹤功能

所有表都包含 `batch_id` 欄位，用於追蹤數據來源：

```sql
-- 範例：使用 batch_id 追蹤上傳批次
-- Step 1: 創建批次記錄（如果使用 import_batches 表）
-- Step 2: 插入數據時設定 batch_id
INSERT INTO po_open_lines (user_id, batch_id, po_number, ...)
VALUES (auth.uid(), 'some-uuid', 'PO-10001', ...);

-- Step 3: 查詢特定批次的數據
SELECT * FROM po_open_lines 
WHERE batch_id = 'some-uuid';

-- Step 4: 刪除整個批次（如需要）
DELETE FROM po_open_lines 
WHERE batch_id = 'some-uuid' AND user_id = auth.uid();
```

---

## 🛠️ 常見問題排解

### 問題 1: 執行腳本時出現 "function update_updated_at_column() does not exist"

**原因：** 函數未定義

**解決：** 腳本中已包含函數定義，請確保執行完整的腳本

---

### 問題 2: 插入數據時出現 "violates foreign key constraint"

**原因：** `user_id` 不存在於 `auth.users` 表

**解決：** 確保使用 `auth.uid()` 函數取得當前用戶 ID：
```sql
INSERT INTO po_open_lines (user_id, ...)
VALUES (auth.uid(), ...); -- 正確
```

---

### 問題 3: 查詢時看不到數據

**原因：** RLS 阻擋了查詢（可能是 user_id 不匹配）

**解決：** 確認查詢條件正確：
```sql
-- 正確：會自動套用 RLS
SELECT * FROM po_open_lines;

-- 錯誤：不要手動過濾 user_id（除非你知道在做什麼）
SELECT * FROM po_open_lines WHERE user_id = 'some-uuid';
```

---

### 問題 4: Upsert 失敗

**原因：** UNIQUE 約束欄位不匹配

**解決：** 確保 ON CONFLICT 子句包含所有 UNIQUE 約束欄位：

```sql
-- po_open_lines: 必須包含 (user_id, po_number, po_line, time_bucket)
ON CONFLICT (user_id, po_number, po_line, time_bucket)

-- inventory_snapshots: 必須包含 (user_id, material_code, plant_id, snapshot_date)
ON CONFLICT (user_id, material_code, plant_id, snapshot_date)

-- fg_financials: 使用 unique index name
ON CONFLICT ON CONSTRAINT idx_fg_financials_unique_key
```

---

## 📚 相關文件

- **模板文件：** `templates/po_open_lines.xlsx`, `inventory_snapshots.xlsx`, `fg_financials.xlsx`
- **模板說明：** `NEW_TEMPLATES_GUIDE.md`
- **生成腳本：** `scripts/generate_new_templates.js`
- **Schema 文件：** `database/step1_supply_inventory_financials_schema.sql`

---

## ✅ 部署檢查清單

完成以下檢查以確保部署成功：

- [ ] 在 Supabase SQL Editor 執行完整腳本
- [ ] 確認看到成功提示訊息
- [ ] 在 Table Editor 中看到 3 張新表
- [ ] 測試基本 SELECT 查詢（返回空結果）
- [ ] 測試插入測試數據
- [ ] 測試 RLS 功能（只能看到自己的數據）
- [ ] 測試 Upsert 功能
- [ ] （可選）清理測試數據

---

## 📧 技術支援

如有問題或需要協助，請聯繫開發團隊。

---

**文件版本：** 1.0  
**創建日期：** 2026-01-31  
**最後更新：** 2026-01-31
