-- 清理 Supplier 表中的重複資料
-- 只保留每個 user_id + supplier_name 的第一筆記錄（最早 created_at）

-- Step 1: 查看重複的供應商
SELECT 
  user_id,
  supplier_name, 
  COUNT(*) as count,
  STRING_AGG(id::text, ', ') as duplicate_ids
FROM suppliers
GROUP BY user_id, supplier_name
HAVING COUNT(*) > 1;

-- Step 2: 刪除重複記錄（保留最早的一筆）
WITH ranked_suppliers AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, supplier_name
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM suppliers
)
DELETE FROM suppliers s
USING ranked_suppliers r
WHERE s.id = r.id
  AND r.rn > 1;

-- Step 3: 添加唯一約束（防止未來再次出現重複）
-- 注意：執行前請確認沒有重複資料
ALTER TABLE suppliers
DROP CONSTRAINT IF EXISTS suppliers_supplier_name_unique;

ALTER TABLE suppliers
ADD CONSTRAINT suppliers_supplier_name_unique
UNIQUE (user_id, supplier_name);

-- 可選：如果要按 supplier_code 去重（PostgreSQL 需使用部分唯一索引）
DROP INDEX IF EXISTS suppliers_supplier_code_unique;
CREATE UNIQUE INDEX suppliers_supplier_code_unique
ON suppliers (user_id, supplier_code)
WHERE supplier_code IS NOT NULL
  AND BTRIM(supplier_code) <> '';




