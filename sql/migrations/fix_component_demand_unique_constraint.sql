-- ============================================
-- 修補：component_demand 缺少 UNIQUE constraint
-- ============================================
-- 執行日期: 2026-01-30
-- 問題: upsert 操作失敗，因為 DB 沒有定義 onConflict 所需的唯一約束
-- 解決: 添加 UNIQUE(user_id, material_code, plant_id, time_bucket)

-- ============================================
-- Step 1: 檢查是否有重複資料
-- ============================================
DO $$
DECLARE
  duplicate_count INT;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT user_id, material_code, plant_id, time_bucket, COUNT(*) as cnt
    FROM component_demand
    GROUP BY user_id, material_code, plant_id, time_bucket
    HAVING COUNT(*) > 1
  ) AS duplicates;
  
  IF duplicate_count > 0 THEN
    RAISE NOTICE '⚠️  警告：發現 % 組重複資料', duplicate_count;
    RAISE NOTICE '建議先清理重複資料：';
    RAISE NOTICE '  DELETE FROM component_demand WHERE id NOT IN (';
    RAISE NOTICE '    SELECT DISTINCT ON (user_id, material_code, plant_id, time_bucket) id';
    RAISE NOTICE '    FROM component_demand';
    RAISE NOTICE '  );';
    -- 不中止，繼續顯示重複資料
  ELSE
    RAISE NOTICE '✅ 無重複資料，可安全添加唯一約束';
  END IF;
END $$;

-- ============================================
-- Step 2: 清理重複資料（如果有）
-- ============================================
-- 保留每組重複中的第一筆（按 created_at 最新）
-- 如果上方檢查發現重複，請取消下方註解執行清理：
/*
DELETE FROM component_demand 
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, material_code, plant_id, time_bucket) id
  FROM component_demand
  ORDER BY user_id, material_code, plant_id, time_bucket, created_at DESC
);
*/

-- ============================================
-- Step 3: 添加唯一約束
-- ============================================
ALTER TABLE component_demand 
ADD CONSTRAINT uq_component_demand_key 
UNIQUE (user_id, material_code, plant_id, time_bucket);

-- ============================================
-- Step 4: 添加複合索引（優化查詢效能）
-- ============================================
CREATE INDEX IF NOT EXISTS idx_component_demand_upsert_key
ON component_demand(user_id, material_code, plant_id, time_bucket);

-- ============================================
-- Step 5: 添加註釋
-- ============================================
COMMENT ON CONSTRAINT uq_component_demand_key ON component_demand 
IS '唯一約束 - 用於 upsert 操作（同一用戶、料號、工廠、時間桶的組合唯一）';

-- ============================================
-- Step 6: 驗證約束是否成功添加
-- ============================================
DO $$
DECLARE
  constraint_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 
    FROM pg_constraint 
    WHERE conrelid = 'component_demand'::regclass 
      AND conname = 'uq_component_demand_key'
  ) INTO constraint_exists;
  
  IF constraint_exists THEN
    RAISE NOTICE '================================================';
    RAISE NOTICE '✅ 修補成功！component_demand 唯一約束已添加';
    RAISE NOTICE '================================================';
    RAISE NOTICE '';
    RAISE NOTICE '約束名稱: uq_component_demand_key';
    RAISE NOTICE '約束欄位: (user_id, material_code, plant_id, time_bucket)';
    RAISE NOTICE '';
    RAISE NOTICE '下一步：';
    RAISE NOTICE '  1. 回到 UI 重新執行 BOM Explosion';
    RAISE NOTICE '  2. Plant ID: PLANT-01';
    RAISE NOTICE '  3. Time Buckets: 2026-W02';
    RAISE NOTICE '  4. 應該能看到 Component 需求和追溯記錄';
    RAISE NOTICE '================================================';
  ELSE
    RAISE EXCEPTION '❌ 約束添加失敗，請檢查錯誤訊息';
  END IF;
END $$;

-- ============================================
-- Step 7: 顯示當前約束資訊
-- ============================================
SELECT 
  conname AS "約束名稱",
  contype AS "類型",
  pg_get_constraintdef(oid) AS "約束定義"
FROM pg_constraint
WHERE conrelid = 'component_demand'::regclass
  AND conname = 'uq_component_demand_key';
