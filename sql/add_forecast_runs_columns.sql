-- 添加 forecast_runs 缺失的列
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'bom_explosion';
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS triggered_by TEXT;
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS parent_run_id UUID;

-- 更新现有数据
UPDATE forecast_runs 
SET kind = 'bom_explosion' 
WHERE kind IS NULL;

-- 确认结构
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'forecast_runs' 
ORDER BY ordinal_position;
