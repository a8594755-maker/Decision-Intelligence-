-- =============================================================================
-- Fix suppliers.status constraint violation
-- =============================================================================
-- 問題：suppliers.status 只允許 'active' 或 'inactive'，但程式可能寫入其他值
-- 
-- Constraint 資訊（從 supplier_kpi_schema.sql line 36）：
-- status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
-- 
-- 允許值：['active', 'inactive']
-- 預設值：'active'
-- 
-- 解決方案：
-- 1. 清理現有不合法資料（設為 'active'）
-- 2. 確保 DEFAULT 'active'（已存在，但確保冪等）
-- 3. 程式端使用 normalizeSupplierStatus() 正規化所有變體
-- =============================================================================

-- Step 1: 檢查並清理現有不合法的 status 值
-- 將所有非 'active'/'inactive' 的值更新為 'active'
UPDATE public.suppliers
SET status = 'active'
WHERE status IS NULL 
   OR status NOT IN ('active', 'inactive');

-- Step 2: 確保 status 欄位有 DEFAULT（此行為冪等，如已存在 DEFAULT 則不會報錯）
-- 注意：PostgreSQL 的 ALTER COLUMN SET DEFAULT 是冪等的，重複執行不會報錯
ALTER TABLE public.suppliers
  ALTER COLUMN status SET DEFAULT 'active';

-- Step 3: 確保 status 欄位 NOT NULL（可選，但建議）
-- 如果需要強制 NOT NULL，取消下面這行的註解：
-- ALTER TABLE public.suppliers
--   ALTER COLUMN status SET NOT NULL;

-- Step 4: 驗證（可選）
-- 執行以下查詢檢查是否還有非法值：
-- SELECT id, supplier_name, status 
-- FROM public.suppliers 
-- WHERE status IS NULL OR status NOT IN ('active', 'inactive')
-- LIMIT 10;

-- Step 5: 查看 constraint 定義（可選，僅供參考）
-- SELECT conname, pg_get_constraintdef(oid) 
-- FROM pg_constraint 
-- WHERE conrelid = 'public.suppliers'::regclass 
--   AND conname LIKE '%status%';

-- =============================================================================
-- 執行說明：
-- 1. 在 Supabase SQL Editor 中執行此 SQL
-- 2. 確認 "Success. No rows returned" 或類似訊息
-- 3. 驗證查詢（Step 4）應回傳 0 rows
-- 4. 之後程式端會正規化所有 status 值，確保只寫入 'active' 或 'inactive'
-- =============================================================================
