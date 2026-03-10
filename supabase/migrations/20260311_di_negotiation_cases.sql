-- ============================================================
-- di_negotiation_cases + di_negotiation_events
-- Persistent storage for the agentic negotiation loop.
-- Replaces in-memory NegotiationStateTracker singleton with
-- durable Supabase-backed state.
-- ============================================================

-- ── Cases ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.di_negotiation_cases (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_run_id bigint NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('infeasible', 'kpi_shortfall')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved_agreement', 'resolved_walkaway', 'expired')),
  buyer_position jsonb DEFAULT '{}'::jsonb,
  scenario_id text,
  supplier_kpis jsonb DEFAULT '{}'::jsonb,
  cfr_history_key text DEFAULT '',
  current_round int DEFAULT 0,
  current_round_name text DEFAULT 'OPENING',
  outcome jsonb DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_di_neg_cases_user_status
  ON public.di_negotiation_cases(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_di_neg_cases_plan_run
  ON public.di_negotiation_cases(plan_run_id);

ALTER TABLE public.di_negotiation_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own negotiation cases" ON public.di_negotiation_cases;
CREATE POLICY "Users can view own negotiation cases"
  ON public.di_negotiation_cases FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own negotiation cases" ON public.di_negotiation_cases;
CREATE POLICY "Users can insert own negotiation cases"
  ON public.di_negotiation_cases FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own negotiation cases" ON public.di_negotiation_cases;
CREATE POLICY "Users can update own negotiation cases"
  ON public.di_negotiation_cases FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own negotiation cases" ON public.di_negotiation_cases;
CREATE POLICY "Users can delete own negotiation cases"
  ON public.di_negotiation_cases FOR DELETE
  USING (auth.uid() = user_id);

-- ── Events (per-round actions within a case) ────────────────

CREATE TABLE IF NOT EXISTS public.di_negotiation_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES public.di_negotiation_cases(id) ON DELETE CASCADE,
  round int NOT NULL,
  round_name text NOT NULL,
  player text NOT NULL CHECK (player IN ('buyer', 'supplier')),
  action text NOT NULL CHECK (action IN ('accept', 'reject', 'counter')),
  details jsonb DEFAULT '{}'::jsonb,
  cfr_strategy_snapshot jsonb DEFAULT NULL,
  draft_tone text,
  draft_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_di_neg_events_case
  ON public.di_negotiation_events(case_id, created_at ASC);

ALTER TABLE public.di_negotiation_events ENABLE ROW LEVEL SECURITY;

-- Events inherit access from their parent case via a subquery
DROP POLICY IF EXISTS "Users can view own negotiation events" ON public.di_negotiation_events;
CREATE POLICY "Users can view own negotiation events"
  ON public.di_negotiation_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.di_negotiation_cases c
      WHERE c.id = case_id AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own negotiation events" ON public.di_negotiation_events;
CREATE POLICY "Users can insert own negotiation events"
  ON public.di_negotiation_events FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.di_negotiation_cases c
      WHERE c.id = case_id AND c.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
