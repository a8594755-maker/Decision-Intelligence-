# Step 1 Schema - 快速參考

## 🎯 三張新表

### 1. po_open_lines（采購訂單未交貨）
```sql
-- 核心欄位
po_number, po_line, material_code, plant_id, time_bucket, open_qty

-- 唯一約束
UNIQUE(user_id, po_number, po_line, time_bucket)

-- 主要索引
(user_id, plant_id, time_bucket)
(user_id, material_code)
```

### 2. inventory_snapshots（庫存快照）
```sql
-- 核心欄位
material_code, plant_id, snapshot_date, onhand_qty, allocated_qty, safety_stock

-- 唯一約束
UNIQUE(user_id, material_code, plant_id, snapshot_date)

-- 主要索引
(user_id, plant_id, snapshot_date)
(user_id, material_code)
```

### 3. fg_financials（成品財務）
```sql
-- 核心欄位
material_code, unit_margin, plant_id, unit_price, currency, valid_from, valid_to

-- 唯一約束（UNIQUE INDEX with COALESCE）
(user_id, material_code, COALESCE(plant_id,''), currency, 
 COALESCE(valid_from,'1900-01-01'), COALESCE(valid_to,'2999-12-31'))

-- 主要索引
(user_id, material_code)
(valid_from, valid_to)
```

---

## 🚀 快速部署

### 方法 1: Supabase SQL Editor（推薦）
1. 登入 Supabase Dashboard
2. SQL Editor → New Query
3. 複製 `step1_supply_inventory_financials_schema.sql` 全部內容
4. Run（Ctrl+Enter）

### 方法 2: psql 命令列
```bash
psql -h your-project.supabase.co -U postgres -d postgres -f database/step1_supply_inventory_financials_schema.sql
```

---

## ✅ 驗證部署

```sql
-- 檢查表是否創建成功
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('po_open_lines', 'inventory_snapshots', 'fg_financials');

-- 應返回 3 rows
```

---

## 🧪 測試 Upsert

### po_open_lines
```sql
INSERT INTO po_open_lines (
  user_id, po_number, po_line, material_code, plant_id, 
  time_bucket, open_qty, supplier_id
) VALUES (
  auth.uid(), 'PO-10001', '10', 'COMP-3100', 'PLANT-01',
  '2026-W05', 5000, 'SUP-001'
)
ON CONFLICT (user_id, po_number, po_line, time_bucket)
DO UPDATE SET
  open_qty = EXCLUDED.open_qty,
  updated_at = NOW();
```

### inventory_snapshots
```sql
INSERT INTO inventory_snapshots (
  user_id, material_code, plant_id, snapshot_date, onhand_qty
) VALUES (
  auth.uid(), 'COMP-3100', 'PLANT-01', '2026-01-31', 15000
)
ON CONFLICT (user_id, material_code, plant_id, snapshot_date)
DO UPDATE SET
  onhand_qty = EXCLUDED.onhand_qty,
  updated_at = NOW();
```

### fg_financials
```sql
INSERT INTO fg_financials (
  user_id, material_code, plant_id, unit_margin, 
  unit_price, currency, valid_from, valid_to
) VALUES (
  auth.uid(), 'FG-2000', 'PLANT-01', 25.50,
  125.00, 'USD', '2026-01-01', '2026-06-30'
)
ON CONFLICT ON CONSTRAINT idx_fg_financials_unique_key
DO UPDATE SET
  unit_margin = EXCLUDED.unit_margin,
  unit_price = EXCLUDED.unit_price,
  updated_at = NOW();
```

---

## 🔑 重點特性

✅ **RLS 啟用** - 所有表都有 Row Level Security  
✅ **Auto Timestamps** - `updated_at` 自動更新  
✅ **Batch Tracking** - `batch_id` 支援批次追蹤  
✅ **Upsert Ready** - 所有表都有 UNIQUE 約束  
✅ **NULL Handling** - `fg_financials` 支援 NULL 值唯一性  

---

## 📚 相關檔案

| 檔案 | 用途 |
|-----|------|
| `step1_supply_inventory_financials_schema.sql` | 完整 SQL schema |
| `STEP1_SCHEMA_DEPLOYMENT_GUIDE.md` | 詳細部署指南 |
| `STEP1_SCHEMA_QUICK_REFERENCE.md` | 本文件（快速參考） |
| `templates/po_open_lines.xlsx` | Excel 模板 |
| `templates/inventory_snapshots.xlsx` | Excel 模板 |
| `templates/fg_financials.xlsx` | Excel 模板 |

---

**最後更新：** 2026-01-31
