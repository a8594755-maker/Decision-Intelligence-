-- ============================================
-- 綜合修補腳本：一次性修復所有已知問題
-- ============================================
-- 執行日期: 2026-01-30
-- 目的: 確保 component_demand 和 component_demand_trace 完全可用

-- ============================================
-- Part 1: 檢查並添加 component_demand 唯一約束
-- ============================================
DO $$
BEGIN
  -- 嘗試添加約束（如果已存在會被忽略）
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conrelid = 'component_demand'::regclass 
      AND conname = 'uq_component_demand_key'
  ) THEN
    ALTER TABLE component_demand 
    ADD CONSTRAINT uq_component_demand_key 
    UNIQUE (user_id, material_code, plant_id, time_bucket);
    
    RAISE NOTICE '✅ component_demand 唯一約束已添加';
  ELSE
    RAISE NOTICE '✓ component_demand 唯一約束已存在';
  END IF;
END $$;

-- ============================================
-- Part 2: 檢查並添加 trace_meta 欄位
-- ============================================
DO $$
BEGIN
  -- 檢查 trace_meta 欄位是否存在
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'component_demand_trace'
      AND column_name = 'trace_meta'
  ) THEN
    -- 添加 trace_meta 欄位
    ALTER TABLE component_demand_trace 
    ADD COLUMN trace_meta JSONB DEFAULT '{}'::jsonb;
    
    -- 創建 GIN 索引
    CREATE INDEX idx_component_demand_trace_meta 
    ON component_demand_trace USING GIN (trace_meta);
    
    -- 添加註釋
    COMMENT ON COLUMN component_demand_trace.trace_meta IS '追溯元數據 - 包含 path、fg_material_code、component_material_code 等';
    
    RAISE NOTICE '✅ trace_meta 欄位已添加';
  ELSE
    RAISE NOTICE '✓ trace_meta 欄位已存在';
  END IF;
END $$;

-- ============================================
-- Part 3: 確保必要索引存在
-- ============================================
CREATE INDEX IF NOT EXISTS idx_component_demand_upsert_key
ON component_demand(user_id, material_code, plant_id, time_bucket);

CREATE INDEX IF NOT EXISTS idx_component_demand_batch
ON component_demand(batch_id);

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_batch
ON component_demand_trace(batch_id);

DO $$
BEGIN
  RAISE NOTICE '✅ 索引已確認';
END $$;

-- ============================================
-- Part 4: 驗證配置
-- ============================================
DO $$
DECLARE
  constraint_exists BOOLEAN;
  trace_meta_exists BOOLEAN;
  rls_enabled BOOLEAN;
BEGIN
  -- 檢查約束
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conrelid = 'component_demand'::regclass 
      AND conname = 'uq_component_demand_key'
  ) INTO constraint_exists;
  
  -- 檢查 trace_meta
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'component_demand_trace'
      AND column_name = 'trace_meta'
  ) INTO trace_meta_exists;
  
  -- 檢查 RLS
  SELECT rowsecurity INTO rls_enabled
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename = 'component_demand';
  
  -- 顯示結果
  RAISE NOTICE '================================================';
  RAISE NOTICE '配置檢查結果：';
  RAISE NOTICE '  component_demand 唯一約束: %', CASE WHEN constraint_exists THEN '✅' ELSE '❌' END;
  RAISE NOTICE '  trace_meta 欄位: %', CASE WHEN trace_meta_exists THEN '✅' ELSE '❌' END;
  RAISE NOTICE '  component_demand RLS: %', CASE WHEN rls_enabled THEN '✅' ELSE '❌' END;
  RAISE NOTICE '================================================';
  
  IF constraint_exists AND trace_meta_exists AND rls_enabled THEN
    RAISE NOTICE '✅ 所有配置正常！可以執行 BOM Explosion';
  ELSE
    RAISE NOTICE '⚠️  有配置項目缺失，請檢查上方結果';
  END IF;
END $$;

-- ============================================
-- Part 5: 顯示當前狀態統計
-- ============================================
SELECT 
  'component_demand' AS "資料表",
  COUNT(*) AS "記錄數",
  COUNT(DISTINCT user_id) AS "使用者數",
  COUNT(DISTINCT plant_id) AS "工廠數"
FROM component_demand

UNION ALL

SELECT 
  'component_demand_trace' AS "資料表",
  COUNT(*) AS "記錄數",
  COUNT(DISTINCT user_id) AS "使用者數",
  NULL AS "工廠數"
FROM component_demand_trace;

-- ============================================
-- 完成
-- ============================================
SELECT '🎯 綜合修補完成！請回到 UI 重新執行 BOM Explosion' AS "狀態";
