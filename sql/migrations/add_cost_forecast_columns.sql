-- ============================================================
-- Migration: Add cost_forecast support columns to forecast_runs
-- ============================================================
-- Adds columns needed for cost_forecast runs tracking

-- Add kind column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'kind'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN kind TEXT;
    RAISE NOTICE 'Added kind column to forecast_runs';
  END IF;
END $$;

-- Add status column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'status'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN status TEXT DEFAULT 'pending';
    RAISE NOTICE 'Added status column to forecast_runs';
  END IF;
END $$;

-- Add triggered_by column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'triggered_by'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN triggered_by TEXT;
    RAISE NOTICE 'Added triggered_by column to forecast_runs';
  END IF;
END $$;

-- Add started_at column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'started_at'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN started_at TIMESTAMPTZ;
    RAISE NOTICE 'Added started_at column to forecast_runs';
  END IF;
END $$;

-- Add completed_at column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN completed_at TIMESTAMPTZ;
    RAISE NOTICE 'Added completed_at column to forecast_runs';
  END IF;
END $$;

-- Add result_summary column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'result_summary'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN result_summary JSONB DEFAULT '{}'::jsonb;
    RAISE NOTICE 'Added result_summary column to forecast_runs';
  END IF;
END $$;

-- Add error_message column (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'forecast_runs' AND column_name = 'error_message'
  ) THEN
    ALTER TABLE public.forecast_runs ADD COLUMN error_message TEXT;
    RAISE NOTICE 'Added error_message column to forecast_runs';
  END IF;
END $$;

-- Create index on kind column for filtering
CREATE INDEX IF NOT EXISTS idx_forecast_runs_kind ON public.forecast_runs(kind);

-- Create index on status column
CREATE INDEX IF NOT EXISTS idx_forecast_runs_status ON public.forecast_runs(status);

-- ============================================================
-- Insert default cost rule set for current user
-- (Run this manually after authentication or in Supabase SQL Editor)
-- ============================================================
-- Note: This needs user_id which must be obtained from auth.users
-- 
-- INSERT INTO public.cost_rule_sets (
--   user_id, 
--   rule_set_version, 
--   currency, 
--   rules,
--   description
-- ) 
-- SELECT 
--   id as user_id,
--   'v1.0.0-default',
--   'USD',
--   jsonb_build_object(
--     'expedite', jsonb_build_object('unit_cost_per_qty', 5.0, 'max_qty_per_action', 1000),
--     'substitution', jsonb_build_object('fixed_cost', 5000, 'var_cost_per_qty', 2.5, 'setup_days', 7),
--     'disruption', jsonb_build_object('cost_if_stockout', 50000, 'cost_per_bucket', 10000, 'min_p_stockout', 0.1)
--   ),
--   'Default MVP cost rules - linear pricing'
-- FROM auth.users
-- WHERE NOT EXISTS (
--   SELECT 1 FROM public.cost_rule_sets WHERE rule_set_version = 'v1.0.0-default'
-- );
