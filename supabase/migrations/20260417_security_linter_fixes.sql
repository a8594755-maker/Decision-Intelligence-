-- ============================================================================
-- Migration: Security Linter Fixes
-- Date: 2026-03-24
-- Description: Fix all Supabase linter ERROR-level security findings
--
-- Fixes:
--   1. v_import_history exposes auth.users to anon role
--   2. what_if_results / what_if_runs have RLS policies but RLS not enabled
--   3. user_profiles, live_tables, material_stock_snapshots,
--      logic_regression_tests, logic_regression_results — RLS not enabled
--   4. 7 views with SECURITY DEFINER → recreate with security_invoker = on
-- ============================================================================

-- ============================================================================
-- PART 1: Enable RLS on tables that are missing it
-- ============================================================================

-- what_if_results & what_if_runs already have policies, just need RLS enabled
ALTER TABLE IF EXISTS public.what_if_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.what_if_runs    ENABLE ROW LEVEL SECURITY;

-- user_profiles — needs RLS + policies
ALTER TABLE IF EXISTS public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.user_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.user_profiles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON public.user_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- live_tables — may not exist in all environments, and may lack user_id column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_tables' AND column_name = 'user_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.live_tables ENABLE ROW LEVEL SECURITY';

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_tables' AND policyname = 'Users can view own live_tables') THEN
      EXECUTE $p$
        CREATE POLICY "Users can view own live_tables"
          ON public.live_tables FOR SELECT
          USING (auth.uid() = user_id)
      $p$;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_tables' AND policyname = 'Users can insert own live_tables') THEN
      EXECUTE $p$
        CREATE POLICY "Users can insert own live_tables"
          ON public.live_tables FOR INSERT
          WITH CHECK (auth.uid() = user_id)
      $p$;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_tables' AND policyname = 'Users can update own live_tables') THEN
      EXECUTE $p$
        CREATE POLICY "Users can update own live_tables"
          ON public.live_tables FOR UPDATE
          USING (auth.uid() = user_id)
          WITH CHECK (auth.uid() = user_id)
      $p$;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_tables' AND policyname = 'Users can delete own live_tables') THEN
      EXECUTE $p$
        CREATE POLICY "Users can delete own live_tables"
          ON public.live_tables FOR DELETE
          USING (auth.uid() = user_id)
      $p$;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'live_tables'
  ) THEN
    -- Table exists but has no user_id — just enable RLS without user-scoped policies
    EXECUTE 'ALTER TABLE public.live_tables ENABLE ROW LEVEL SECURITY';
  END IF;
END
$$;

-- material_stock_snapshots — needs RLS + policies
ALTER TABLE IF EXISTS public.material_stock_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own stock snapshots"
  ON public.material_stock_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own stock snapshots"
  ON public.material_stock_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own stock snapshots"
  ON public.material_stock_snapshots FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own stock snapshots"
  ON public.material_stock_snapshots FOR DELETE
  USING (auth.uid() = user_id);

-- logic_regression_tests — needs RLS + policies
ALTER TABLE IF EXISTS public.logic_regression_tests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own regression tests"
  ON public.logic_regression_tests FOR SELECT
  USING (auth.uid() = created_by);

CREATE POLICY "Users can insert own regression tests"
  ON public.logic_regression_tests FOR INSERT
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own regression tests"
  ON public.logic_regression_tests FOR UPDATE
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can delete own regression tests"
  ON public.logic_regression_tests FOR DELETE
  USING (auth.uid() = created_by);

-- logic_regression_results — needs RLS + policies
-- This table has no direct user_id, so scope via the test's created_by
ALTER TABLE IF EXISTS public.logic_regression_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view regression results for own tests"
  ON public.logic_regression_results FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.logic_regression_tests t
      WHERE t.id = regression_test_id AND t.created_by = auth.uid()
    )
  );

CREATE POLICY "Users can insert regression results for own tests"
  ON public.logic_regression_results FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.logic_regression_tests t
      WHERE t.id = regression_test_id AND t.created_by = auth.uid()
    )
  );

-- ============================================================================
-- PART 2: Fix v_import_history — remove auth.users reference
-- Replace email with user_id (already present); if you need email, join
-- user_profiles or use a server-side function instead.
-- Also convert to SECURITY INVOKER.
-- ============================================================================

DROP VIEW IF EXISTS public.v_import_history;
CREATE VIEW public.v_import_history
  WITH (security_invoker = on)
AS
SELECT
  ib.id,
  ib.user_id,
  ib.upload_type,
  ib.filename,
  ib.target_table,
  ib.total_rows,
  ib.success_rows,
  ib.error_rows,
  ib.status,
  ib.created_at,
  ib.undone_at,
  ib.metadata,
  CASE
    WHEN ib.total_rows > 0 THEN
      ROUND((ib.success_rows::numeric / ib.total_rows::numeric) * 100, 2)
    ELSE 0
  END AS success_rate
FROM public.import_batches ib
ORDER BY ib.created_at DESC;

-- ============================================================================
-- PART 3: Convert remaining SECURITY DEFINER views → SECURITY INVOKER
-- ============================================================================

-- supplier_defect_stats
CREATE OR REPLACE VIEW public.supplier_defect_stats
  WITH (security_invoker = on)
AS
SELECT
  gr.user_id,
  gr.supplier_id,
  s.supplier_name,
  s.supplier_code,
  COUNT(*)                              AS total_receipts,
  SUM(gr.received_qty)                  AS total_received_qty,
  SUM(gr.rejected_qty)                  AS total_rejected_qty,
  SUM(gr.accepted_qty)                  AS total_accepted_qty,
  CASE
    WHEN SUM(gr.received_qty) > 0
    THEN ROUND((SUM(gr.rejected_qty) / SUM(gr.received_qty) * 100)::numeric, 2)
    ELSE 0
  END                                   AS defect_rate_percent,
  MIN(gr.actual_delivery_date)          AS first_receipt_date,
  MAX(gr.actual_delivery_date)          AS last_receipt_date
FROM public.goods_receipts gr
LEFT JOIN public.suppliers s ON gr.supplier_id = s.id
GROUP BY gr.user_id, gr.supplier_id, s.supplier_name, s.supplier_code;

-- supplier_delivery_stats
CREATE OR REPLACE VIEW public.supplier_delivery_stats
  WITH (security_invoker = on)
AS
SELECT
  gr.user_id,
  gr.supplier_id,
  s.supplier_name,
  s.supplier_code,
  COUNT(*)                                                          AS total_shipments,
  COUNT(*) FILTER (WHERE gr.is_on_time = true)                      AS on_time_shipments,
  COUNT(*) FILTER (WHERE gr.is_on_time = false)                     AS late_shipments,
  CASE
    WHEN COUNT(*) > 0
    THEN ROUND((COUNT(*) FILTER (WHERE gr.is_on_time = true)::numeric / COUNT(*) * 100), 2)
    ELSE 0
  END                                                                AS on_time_rate_percent,
  ROUND(AVG(CASE WHEN gr.delay_days > 0 THEN gr.delay_days ELSE NULL END)::numeric, 1)
                                                                     AS avg_delay_days,
  MAX(gr.delay_days)                                                 AS max_delay_days,
  MIN(gr.actual_delivery_date)                                       AS first_delivery_date,
  MAX(gr.actual_delivery_date)                                       AS last_delivery_date
FROM public.goods_receipts gr
LEFT JOIN public.suppliers s ON gr.supplier_id = s.id
WHERE gr.planned_delivery_date IS NOT NULL
GROUP BY gr.user_id, gr.supplier_id, s.supplier_name, s.supplier_code;

-- supplier_price_volatility
CREATE OR REPLACE VIEW public.supplier_price_volatility
  WITH (security_invoker = on)
AS
SELECT
  ph.user_id,
  ph.supplier_id,
  s.supplier_name,
  s.supplier_code,
  ph.material_id,
  m.material_code,
  m.material_name,
  COUNT(*)                              AS price_records,
  ROUND(AVG(ph.unit_price)::numeric, 4) AS avg_price,
  ROUND(MIN(ph.unit_price)::numeric, 4) AS min_price,
  ROUND(MAX(ph.unit_price)::numeric, 4) AS max_price,
  CASE
    WHEN AVG(ph.unit_price) > 0
    THEN ROUND(((MAX(ph.unit_price) - MIN(ph.unit_price)) / AVG(ph.unit_price) * 100)::numeric, 2)
    ELSE 0
  END                                   AS volatility_percent,
  ph.currency,
  MIN(ph.order_date)                    AS first_order_date,
  MAX(ph.order_date)                    AS last_order_date
FROM public.price_history ph
LEFT JOIN public.suppliers s ON ph.supplier_id = s.id
LEFT JOIN public.materials m ON ph.material_id = m.id
GROUP BY ph.user_id, ph.supplier_id, s.supplier_name, s.supplier_code,
         ph.material_id, m.material_code, m.material_name, ph.currency;

-- supplier_kpi_summary (depends on the 3 views above)
CREATE OR REPLACE VIEW public.supplier_kpi_summary
  WITH (security_invoker = on)
AS
SELECT
  s.id                                    AS supplier_id,
  s.user_id,
  s.supplier_name,
  s.supplier_code,
  s.contact_info,
  s.status,
  COALESCE(def.defect_rate_percent, 0)    AS defect_rate,
  COALESCE(def.total_receipts, 0)         AS total_receipts,
  COALESCE(def.total_received_qty, 0)     AS total_received_qty,
  COALESCE(def.total_rejected_qty, 0)     AS total_rejected_qty,
  COALESCE(del.on_time_rate_percent, 0)   AS on_time_rate,
  COALESCE(del.total_shipments, 0)        AS total_shipments_with_plan,
  COALESCE(del.on_time_shipments, 0)      AS on_time_shipments,
  COALESCE(del.late_shipments, 0)         AS late_shipments,
  COALESCE(del.avg_delay_days, 0)         AS avg_delay_days,
  COALESCE(MAX(pv.volatility_percent), 0) AS max_price_volatility,
  COUNT(DISTINCT pv.material_id)          AS materials_count,
  ROUND(
    (
      COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
      COALESCE(del.on_time_rate_percent, 100) * 0.4 +
      COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
    )::numeric, 2
  )                                       AS overall_score,
  CASE
    WHEN ROUND(
      (
        COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
        COALESCE(del.on_time_rate_percent, 100) * 0.4 +
        COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
      )::numeric, 2
    ) >= 90 THEN 'low'
    WHEN ROUND(
      (
        COALESCE(100 - def.defect_rate_percent, 100) * 0.4 +
        COALESCE(del.on_time_rate_percent, 100) * 0.4 +
        COALESCE(100 - LEAST(MAX(pv.volatility_percent), 100), 100) * 0.2
      )::numeric, 2
    ) >= 70 THEN 'medium'
    ELSE 'high'
  END                                     AS risk_level
FROM public.suppliers s
LEFT JOIN public.supplier_defect_stats def
  ON s.id = def.supplier_id AND s.user_id = def.user_id
LEFT JOIN public.supplier_delivery_stats del
  ON s.id = del.supplier_id AND s.user_id = del.user_id
LEFT JOIN public.supplier_price_volatility pv
  ON s.id = pv.supplier_id AND s.user_id = pv.user_id
GROUP BY s.id, s.user_id, s.supplier_name, s.supplier_code, s.contact_info, s.status,
         def.defect_rate_percent, def.total_receipts, def.total_received_qty, def.total_rejected_qty,
         del.on_time_rate_percent, del.total_shipments, del.on_time_shipments, del.late_shipments,
         del.avg_delay_days;

-- ai_employee_kpis
CREATE OR REPLACE VIEW public.ai_employee_kpis
  WITH (security_invoker = on)
AS
SELECT
  e.id                                                          AS employee_id,
  e.name,
  COUNT(t.id) FILTER (WHERE t.status = 'done')                 AS tasks_completed,
  COUNT(t.id) FILTER (WHERE t.status != 'done')                AS tasks_open,
  COUNT(t.id) FILTER (WHERE t.due_at < now() AND t.status != 'done')
                                                                AS tasks_overdue,
  ROUND(
    100.0 * COUNT(t.id) FILTER (WHERE t.status = 'done' AND (t.due_at IS NULL OR t.updated_at <= t.due_at))
    / NULLIF(COUNT(t.id) FILTER (WHERE t.status = 'done'), 0),
    1
  )                                                             AS on_time_rate_pct,
  COUNT(r.id) FILTER (WHERE r.decision = 'approved')           AS reviews_approved,
  COUNT(r.id) FILTER (WHERE r.decision = 'needs_revision')     AS reviews_revised,
  ROUND(
    100.0 * COUNT(r.id) FILTER (WHERE r.decision = 'approved')
    / NULLIF(COUNT(r.id), 0),
    1
  )                                                             AS review_pass_rate_pct
FROM public.ai_employees e
LEFT JOIN public.ai_employee_tasks t ON t.employee_id = e.id
LEFT JOIN public.ai_employee_reviews r ON r.task_id = t.id AND r.reviewer_type = 'human_manager'
GROUP BY e.id, e.name;

-- llm_usage_daily_summary
CREATE OR REPLACE VIEW public.llm_usage_daily_summary
  WITH (security_invoker = on)
AS
SELECT
  user_id,
  DATE_TRUNC('day', created_at)::DATE AS usage_date,
  provider,
  COUNT(*)                             AS call_count,
  SUM(total_tokens)                    AS total_tokens,
  SUM(estimated_cost_usd)              AS total_cost_usd
FROM public.llm_usage_events
WHERE status = 'success'
GROUP BY user_id, DATE_TRUNC('day', created_at), provider;

-- ============================================================================
-- PART 4: Revoke anon access from v_import_history (belt-and-suspenders)
-- ============================================================================

REVOKE ALL ON public.v_import_history FROM anon;
