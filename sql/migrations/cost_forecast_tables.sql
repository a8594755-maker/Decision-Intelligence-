-- ============================================================
-- Milestone 5: Cost Forecast MVP v1
-- Decision Cost / What-if 成本引擎
-- ============================================================

-- 表1: 成本规则集（版本化）
create table if not exists public.cost_rule_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_set_version text not null,
  currency text not null default 'USD',
  
  -- 规则配置 JSONB
  -- {
  --   expedite: { unit_cost_per_qty: number, max_qty_per_action: number },
  --   substitution: { fixed_cost: number, var_cost_per_qty: number, setup_days: number },
  --   disruption: { cost_if_stockout: number, cost_per_bucket: number, min_p_stockout: number }
  -- }
  rules jsonb not null default '{}'::jsonb,
  
  -- 规则描述
  description text,
  
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  
  -- 每个用户版本唯一
  unique(user_id, rule_set_version)
);

-- 表2: 成本预测结果（每 key × action）
create table if not exists public.cost_forecast_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  forecast_run_id uuid not null references public.forecast_runs(id) on delete cascade,
  
  -- Key 信息
  material_code text not null,
  plant_id text not null,
  key text generated always as (material_code || '|' || plant_id) stored,
  
  -- Action 类型
  action_type text not null check (action_type in ('expedite', 'substitution', 'disruption')),
  
  -- 预期成本
  expected_cost numeric not null default 0,
  
  -- 成本明细 JSONB
  -- {
  --   base_cost: number,
  --   quantity: number,
  --   unit_cost: number,
  --   fixed_cost: number,
  --   p_stockout_applied: number,
  --   ...
  -- }
  cost_breakdown jsonb not null default '{}'::jsonb,
  
  -- 输入参数 JSONB（用于追溯和手算验证）
  -- {
  --   shortageQty: number,
  --   pStockout: number,
  --   expectedMinAvailable: number,
  --   stockoutBucketP50: string,
  --   ...
  -- }
  inputs jsonb not null default '{}'::jsonb,
  
  -- 规则版本引用
  rule_set_version text,
  
  -- 引擎版本
  engine_version text default '1.0.0',
  
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  
  -- 每个用户 + run + key + action 唯一
  unique(user_id, forecast_run_id, material_code, plant_id, action_type)
);

-- 索引优化
-- 按 run 查询
CREATE INDEX IF NOT EXISTS idx_cost_results_run_id 
ON public.cost_forecast_results(forecast_run_id);

-- 按 key 查询
CREATE INDEX IF NOT EXISTS idx_cost_results_key 
ON public.cost_forecast_results(material_code, plant_id);

-- 按 action 分组查询
CREATE INDEX IF NOT EXISTS idx_cost_results_action 
ON public.cost_forecast_results(action_type);

-- ============================================================
-- RLS 策略（用户只能访问自己的数据）
-- ============================================================

-- cost_rule_sets RLS
alter table public.cost_rule_sets enable row level security;

DROP POLICY IF EXISTS "Users can view own cost_rule_sets" ON public.cost_rule_sets;
CREATE POLICY "Users can view own cost_rule_sets"
  ON public.cost_rule_sets FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cost_rule_sets" ON public.cost_rule_sets;
CREATE POLICY "Users can insert own cost_rule_sets"
  ON public.cost_rule_sets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cost_rule_sets" ON public.cost_rule_sets;
CREATE POLICY "Users can update own cost_rule_sets"
  ON public.cost_rule_sets FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own cost_rule_sets" ON public.cost_rule_sets;
CREATE POLICY "Users can delete own cost_rule_sets"
  ON public.cost_rule_sets FOR DELETE
  USING (auth.uid() = user_id);

-- cost_forecast_results RLS
alter table public.cost_forecast_results enable row level security;

DROP POLICY IF EXISTS "Users can view own cost_forecast_results" ON public.cost_forecast_results;
CREATE POLICY "Users can view own cost_forecast_results"
  ON public.cost_forecast_results FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cost_forecast_results" ON public.cost_forecast_results;
CREATE POLICY "Users can insert own cost_forecast_results"
  ON public.cost_forecast_results FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cost_forecast_results" ON public.cost_forecast_results;
CREATE POLICY "Users can update own cost_forecast_results"
  ON public.cost_forecast_results FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own cost_forecast_results" ON public.cost_forecast_results;
CREATE POLICY "Users can delete own cost_forecast_results"
  ON public.cost_forecast_results FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- 触发器：自动更新 updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- cost_rule_sets 触发器
DROP TRIGGER IF EXISTS update_cost_rule_sets_updated_at ON public.cost_rule_sets;
CREATE TRIGGER update_cost_rule_sets_updated_at
  BEFORE UPDATE ON public.cost_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- cost_forecast_results 触发器
DROP TRIGGER IF EXISTS update_cost_forecast_results_updated_at ON public.cost_forecast_results;
CREATE TRIGGER update_cost_forecast_results_updated_at
  BEFORE UPDATE ON public.cost_forecast_results
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 默认规则集（MVP 初始数据）
-- ============================================================
-- 注意：需要插入到 Supabase 后手动执行或在应用初始化时执行
-- 
-- INSERT INTO public.cost_rule_sets (
--   user_id, 
--   rule_set_version, 
--   currency, 
--   rules,
--   description
-- ) VALUES (
--   auth.uid(),
--   'v1.0.0-default',
--   'USD',
--   jsonb_build_object(
--     'expedite', jsonb_build_object('unit_cost_per_qty', 5.0, 'max_qty_per_action', 1000),
--     'substitution', jsonb_build_object('fixed_cost', 5000, 'var_cost_per_qty', 2.5, 'setup_days', 7),
--     'disruption', jsonb_build_object('cost_if_stockout', 50000, 'cost_per_bucket', 10000, 'min_p_stockout', 0.1)
--   ),
--   'Default MVP cost rules - linear pricing'
-- );
