-- ============================================
-- 檢查 trace_meta 欄位是否存在
-- ============================================
-- 目的: component_demand_trace 需要 trace_meta 欄位（JSONB 型別）

SELECT 
  column_name AS "欄位名稱",
  data_type AS "資料型別",
  is_nullable AS "可為 NULL",
  column_default AS "預設值"
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'component_demand_trace'
ORDER BY ordinal_position;

-- 如果上方結果中沒有看到 trace_meta，請執行以下修補：
-- (已註解，需要手動取消註解執行)

/*
-- 添加 trace_meta 欄位
ALTER TABLE component_demand_trace 
ADD COLUMN IF NOT EXISTS trace_meta JSONB DEFAULT '{}'::jsonb;

-- 創建 GIN 索引以支持 JSONB 查詢
CREATE INDEX IF NOT EXISTS idx_component_demand_trace_meta 
ON component_demand_trace USING GIN (trace_meta);

-- 添加註釋
COMMENT ON COLUMN component_demand_trace.trace_meta IS '追溯元數據 - 包含 path、fg_material_code、component_material_code、source_type、source_id 等追溯信息';

SELECT '✅ trace_meta 欄位已添加' AS status;
*/
