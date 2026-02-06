-- ============================================================
-- P0-1: Schema 驗證 SQL (S1~S4)
-- 請在 Supabase Dashboard → SQL Editor 執行這 4 條
-- ============================================================

-- S1: 檢查 demand_forecast 表結構
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='demand_forecast'
order by ordinal_position;

-- S2: 檢查 demand_forecast 約束條件
select conname, pg_get_constraintdef(c.oid) as def
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'demand_forecast' and c.contype in ('u','p')
order by conname;

-- S3: 查看最近的 Demand Forecast runs
select id, created_at, scenario_name, parameters
from forecast_runs
where parameters->>'kind' = 'demand_forecast'
order by created_at desc
limit 5;

-- S4: 查看最近的 demand_forecast 預測結果
select material_code, plant_id, time_bucket, p10, p50, p90, model_version, train_window_buckets
from demand_forecast
order by created_at desc
limit 20;
