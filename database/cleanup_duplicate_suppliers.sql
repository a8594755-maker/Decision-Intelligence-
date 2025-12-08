-- 清理 Supplier 表中的重複資料
-- 只保留每個 supplier_name 的第一筆記錄

-- Step 1: 查看重複的供應商
SELECT 
  supplier_name, 
  COUNT(*) as count,
  STRING_AGG(id::text, ', ') as duplicate_ids
FROM suppliers
GROUP BY supplier_name
HAVING COUNT(*) > 1;

-- Step 2: 刪除重複記錄（保留最早的一筆）
DELETE FROM suppliers
WHERE id NOT IN (
  SELECT MIN(id)
  FROM suppliers
  GROUP BY supplier_name
);

-- Step 3: 添加唯一約束（防止未來再次出現重複）
-- 注意：執行前請確認沒有重複資料
ALTER TABLE suppliers
ADD CONSTRAINT suppliers_supplier_name_unique 
UNIQUE (supplier_name);

-- 可選：如果要按 supplier_code 去重
ALTER TABLE suppliers
ADD CONSTRAINT suppliers_supplier_code_unique 
UNIQUE (supplier_code)
WHERE supplier_code IS NOT NULL;




