-- ============================================
-- 為 component_demand_trace 添加 trace_meta JSONB 欄位
-- ============================================
-- 檔案位置: database/add_trace_meta_column.sql
-- 執行日期: 2026-01-26
-- 說明: 添加 trace_meta 欄位用於存儲追溯的額外元數據（path_json、material codes 等）

-- 添加 trace_meta 欄位
ALTER TABLE component_demand_trace 
ADD COLUMN IF NOT EXISTS trace_meta JSONB DEFAULT '{}'::jsonb;

-- 創建 GIN 索引以支持 JSONB 查詢
CREATE INDEX IF NOT EXISTS idx_component_demand_trace_meta 
ON component_demand_trace USING GIN (trace_meta);

-- 添加註釋
COMMENT ON COLUMN component_demand_trace.trace_meta IS '追溯元數據 - 包含 path_json（完整路徑）、fg_material_code、component_material_code、source_type、source_id 等額外追溯信息';

-- 範例 trace_meta 結構：
-- {
--   "path": ["FG-001", "SA-01", "COMP-10"],
--   "fg_material_code": "FG-001",
--   "component_material_code": "COMP-10",
--   "plant_id": "P001",
--   "time_bucket": "2026-W01",
--   "fg_qty": 1000,
--   "component_qty": 2210.5263,
--   "source_type": "SO",
--   "source_id": "SO-12345"
-- }

SELECT 'trace_meta column added successfully!' as status;
