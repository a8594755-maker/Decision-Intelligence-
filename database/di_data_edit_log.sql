-- ============================================================
-- di_data_edit_log: field-level audit trail for Plan Studio edits
-- ============================================================

CREATE TABLE IF NOT EXISTS public.di_data_edit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,

  table_name text NOT NULL,
  record_id text NOT NULL,
  field_name text NOT NULL,
  old_value text,
  new_value text,

  source text DEFAULT 'plan_studio',
  run_id bigint,
  conversation_id text,
  note text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_di_data_edit_log_user
  ON public.di_data_edit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_di_data_edit_log_table_record
  ON public.di_data_edit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_di_data_edit_log_created_at
  ON public.di_data_edit_log(created_at DESC);

ALTER TABLE public.di_data_edit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own edit logs" ON public.di_data_edit_log;
CREATE POLICY "Users can view their own edit logs"
  ON public.di_data_edit_log FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own edit logs" ON public.di_data_edit_log;
CREATE POLICY "Users can insert their own edit logs"
  ON public.di_data_edit_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.di_data_edit_log IS
  'Field-level audit trail for inline edits made through Plan Studio Data tab.';
COMMENT ON COLUMN public.di_data_edit_log.source IS
  'Edit source: plan_studio, api, or import';
