-- ============================================
-- Forecast Run 版本化（MVP）
-- ============================================
-- 目的：每次 Forecast/BOM Explosion 產生可追溯的 run，output 表寫入 forecast_run_id
-- 不刪除既有表/欄位，僅新增表與欄位

-- ============================================
-- 1. 建立 forecast_runs 表
-- ============================================
CREATE TABLE IF NOT EXISTS public.forecast_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  scenario_name TEXT NOT NULL DEFAULT 'baseline',
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_batch_ids JSONB NOT NULL DEFAULT '[]'::jsonb
);

COMMENT ON TABLE public.forecast_runs IS 'Forecast/BOM Explosion 執行記錄 - 每次執行產生一筆，用於追溯 inputs 與 outputs';
COMMENT ON COLUMN public.forecast_runs.parameters IS 'time_bucket / horizon 等參數';
COMMENT ON COLUMN public.forecast_runs.input_batch_ids IS 'demand/bom 的 batch_id 或 upload_file_id 陣列';

CREATE INDEX IF NOT EXISTS idx_forecast_runs_created_at ON public.forecast_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_created_by ON public.forecast_runs(created_by);

ALTER TABLE public.forecast_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own forecast runs" ON public.forecast_runs;
CREATE POLICY "Users can view their own forecast runs"
  ON public.forecast_runs FOR SELECT
  USING (auth.uid() = created_by OR created_by IS NULL);

DROP POLICY IF EXISTS "Users can insert their own forecast runs" ON public.forecast_runs;
CREATE POLICY "Users can insert their own forecast runs"
  ON public.forecast_runs FOR INSERT
  WITH CHECK (auth.uid() = created_by);

-- ============================================
-- 2. component_demand 新增 forecast_run_id
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'component_demand' AND column_name = 'forecast_run_id'
  ) THEN
    ALTER TABLE public.component_demand
      ADD COLUMN forecast_run_id UUID REFERENCES public.forecast_runs(id) ON DELETE SET NULL;
    RAISE NOTICE 'Added forecast_run_id to component_demand';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_component_demand_forecast_run_id ON public.component_demand(forecast_run_id) WHERE forecast_run_id IS NOT NULL;

-- ============================================
-- 3. component_demand_trace 新增 forecast_run_id
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'component_demand_trace' AND column_name = 'forecast_run_id'
  ) THEN
    ALTER TABLE public.component_demand_trace
      ADD COLUMN forecast_run_id UUID REFERENCES public.forecast_runs(id) ON DELETE SET NULL;
    RAISE NOTICE 'Added forecast_run_id to component_demand_trace';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_component_demand_trace_forecast_run_id ON public.component_demand_trace(forecast_run_id) WHERE forecast_run_id IS NOT NULL;

-- ============================================
-- 4. 舊資料 backfill：單一 legacy run
-- ============================================
DO $$
DECLARE
  v_legacy_id UUID := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  INSERT INTO public.forecast_runs (id, created_at, scenario_name, parameters, input_batch_ids)
  VALUES (v_legacy_id, NOW(), 'legacy', '{}'::jsonb, '[]'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.component_demand SET forecast_run_id = v_legacy_id WHERE forecast_run_id IS NULL;
  UPDATE public.component_demand_trace SET forecast_run_id = v_legacy_id WHERE forecast_run_id IS NULL;
END $$;

-- 5. 唯一約束：改為 (user_id, forecast_run_id, material_code, plant_id, time_bucket)
--    先刪除舊約束（若存在），再新增
ALTER TABLE public.component_demand DROP CONSTRAINT IF EXISTS uq_component_demand_key;
ALTER TABLE public.component_demand DROP CONSTRAINT IF EXISTS uq_component_demand_run_key;
ALTER TABLE public.component_demand
  ADD CONSTRAINT uq_component_demand_run_key
  UNIQUE (user_id, forecast_run_id, material_code, plant_id, time_bucket);

CREATE INDEX IF NOT EXISTS idx_component_demand_run_material_time
  ON public.component_demand(user_id, forecast_run_id, material_code, plant_id, time_bucket);

-- ============================================
-- 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE 'Forecast runs + forecast_run_id 欄位已就緒。';
  RAISE NOTICE '新 BOM Explosion 請先建立 forecast_runs 一筆，再將 id 寫入 component_demand / component_demand_trace。';
END $$;
