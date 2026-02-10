-- 添加 forecast_runs 缺少的 kind 列
ALTER TABLE forecast_runs ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'bom_explosion';

-- 更新现有数据
UPDATE forecast_runs 
SET kind = 'bom_explosion' 
WHERE kind IS NULL;

-- 确认结构
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'forecast_runs' 
ORDER BY ordinal_position;
