-- ============================================================
-- P0-4: Demand Forecast 效能驗證 SQL
-- 跑完 Demand Forecast 後執行這條查看結果
-- ============================================================

-- 查看最近的 Demand Forecast run 與效能數字
select 
  id,
  created_at,
  scenario_name,
  parameters->>'kind' as kind,
  parameters->>'model_version' as model_version,
  (parameters->>'train_window_buckets')::int as train_window_buckets,
  jsonb_array_length(parameters->'time_buckets') as time_buckets_count,
  parameters->>'plant_id' as plant_id
from forecast_runs
where parameters->>'kind' = 'demand_forecast'
order by created_at desc
limit 3;

-- 查看該 run 產生的預測筆數與統計
-- （請替換 <run_id> 為實際的 UUID）
-- select 
--   forecast_run_id,
--   count(*) as total_forecasts,
--   count(distinct material_code) as unique_materials,
--   count(distinct plant_id) as unique_plants,
--   count(distinct time_bucket) as unique_time_buckets,
--   min(created_at) as first_forecast,
--   max(created_at) as last_forecast
-- from demand_forecast
-- where forecast_run_id = '<run_id>'
-- group by forecast_run_id;

-- ============================================================
-- P0-2 驗證：BOM run 的 run-level 追溯
-- ============================================================

-- 查看最近的 BOM Explosion runs 與其 demand_source
select 
  id,
  created_at,
  scenario_name,
  parameters->>'demand_source' as demand_source,
  parameters->>'input_demand_forecast_run_id' as input_demand_forecast_run_id,
  jsonb_array_length(input_batch_ids) as input_batch_count
from forecast_runs
where parameters->>'demand_source' is not null
order by created_at desc
limit 5;

-- ============================================================
-- P0-3 驗證：Row-level trace 追溯
-- ============================================================

-- 查看 trace 記錄的 source_fg_demand_id（確認有正確寫入）
select 
  id,
  component_demand_id,
  fg_demand_id,
  trace_meta->>'source_type' as source_type,
  trace_meta->>'source_id' as source_id,
  trace_meta->>'source_fg_demand_id' as source_fg_demand_id,
  trace_meta->>'fg_material_code' as fg_material_code,
  trace_meta->>'component_material_code' as component_material_code,
  bom_level,
  created_at
from component_demand_trace
order by created_at desc
limit 10;
