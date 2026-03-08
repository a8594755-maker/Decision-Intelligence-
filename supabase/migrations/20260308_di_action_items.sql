-- ============================================================
-- di_action_items: action tracking for risk-driven recommendations
-- Used by actionTrackingService.js
-- ============================================================

CREATE TABLE IF NOT EXISTS public.di_action_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id text,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sku text,
  plant_id text,
  action_type text,
  title text NOT NULL,
  description text,
  urgency text CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
  priority_score numeric DEFAULT 0,
  reason_code text,
  expected_impact_usd numeric DEFAULT 0,
  owner text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
  due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_di_action_items_user_status
  ON public.di_action_items(user_id, status);

CREATE INDEX IF NOT EXISTS idx_di_action_items_run
  ON public.di_action_items(run_id);

ALTER TABLE public.di_action_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own action items" ON public.di_action_items;
CREATE POLICY "Users can view own action items"
  ON public.di_action_items FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own action items" ON public.di_action_items;
CREATE POLICY "Users can insert own action items"
  ON public.di_action_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own action items" ON public.di_action_items;
CREATE POLICY "Users can update own action items"
  ON public.di_action_items FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own action items" ON public.di_action_items;
CREATE POLICY "Users can delete own action items"
  ON public.di_action_items FOR DELETE
  USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
