-- ============================================
-- 診斷腳本：檢查 component_demand 當前狀態
-- ============================================
-- 執行日期: 2026-01-30
-- 目的: 診斷為什麼 upsert 操作仍然失敗

-- ============================================
-- Step 1: 檢查約束是否存在且正確
-- ============================================
SELECT 
  '=== 約束檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  conname AS "約束名稱",
  contype AS "類型",
  pg_get_constraintdef(oid) AS "約束定義"
FROM pg_constraint
WHERE conrelid = 'component_demand'::regclass
  AND contype IN ('p', 'u') -- p=PRIMARY KEY, u=UNIQUE
ORDER BY contype, conname;

-- ============================================
-- Step 2: 檢查 RLS 狀態
-- ============================================
SELECT 
  '=== RLS 檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  tablename AS "資料表名稱",
  rowsecurity AS "RLS 是否啟用"
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'component_demand';

-- ============================================
-- Step 3: 檢查 RLS Policies
-- ============================================
SELECT 
  '=== RLS Policies 檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  policyname AS "Policy 名稱",
  cmd AS "操作類型",
  qual AS "USING 條件",
  with_check AS "WITH CHECK 條件"
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'component_demand'
ORDER BY cmd;

-- ============================================
-- Step 4: 檢查資料表欄位定義
-- ============================================
SELECT 
  '=== 欄位定義檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  column_name AS "欄位名稱",
  data_type AS "資料型別",
  is_nullable AS "可為 NULL",
  column_default AS "預設值"
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'component_demand'
  AND column_name IN (
    'user_id', 'material_code', 'plant_id', 'time_bucket', 
    'demand_qty', 'uom', 'batch_id'
  )
ORDER BY ordinal_position;

-- ============================================
-- Step 5: 檢查是否有現有資料
-- ============================================
SELECT 
  '=== 現有資料檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  COUNT(*) AS "總記錄數",
  COUNT(DISTINCT user_id) AS "使用者數",
  COUNT(DISTINCT plant_id) AS "工廠數",
  COUNT(DISTINCT time_bucket) AS "時間桶數",
  COUNT(DISTINCT material_code) AS "料號數"
FROM component_demand;

-- ============================================
-- Step 6: 檢查是否有重複資料
-- ============================================
SELECT 
  '=== 重複資料檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  user_id,
  material_code,
  plant_id,
  time_bucket,
  COUNT(*) as "重複次數",
  array_agg(id ORDER BY created_at DESC) as "所有 ID",
  array_agg(demand_qty ORDER BY created_at DESC) as "所有數量"
FROM component_demand
GROUP BY user_id, material_code, plant_id, time_bucket
HAVING COUNT(*) > 1
LIMIT 10;

-- ============================================
-- Step 7: 測試 upsert 操作（模擬）
-- ============================================
SELECT 
  '=== Upsert 測試準備 ===' AS "診斷項目",
  '' AS "詳情";

-- 顯示測試建議
SELECT 
  '請在執行 BOM Explosion 前，先確認以上檢查都通過' AS "建議",
  '如果約束存在、RLS 正確、無重複資料，則問題可能在應用層' AS "備註";

-- ============================================
-- Step 8: 檢查索引
-- ============================================
SELECT 
  '=== 索引檢查 ===' AS "診斷項目",
  '' AS "詳情";

SELECT 
  indexname AS "索引名稱",
  indexdef AS "索引定義"
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'component_demand'
ORDER BY indexname;

-- ============================================
-- 診斷總結
-- ============================================
SELECT 
  '================================================' AS "診斷完成";
SELECT 
  '如果以上檢查都正常，請嘗試以下操作：' AS "下一步";
SELECT 
  '1. 確認 trace_meta 欄位是否存在（component_demand_trace 表）' AS "步驟 1";
SELECT 
  '2. 檢查前端 Console 是否有更詳細的錯誤訊息' AS "步驟 2";
SELECT 
  '3. 在 Supabase Logs 查看實際的 SQL 錯誤' AS "步驟 3";
