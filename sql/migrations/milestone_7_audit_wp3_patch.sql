-- ============================================================
-- Milestone 7.3 WP3: Audit Events Hardening Patch
-- ============================================================
-- Non-breaking patch to enhance audit_events table
-- Adds columns for correlation, entity tracking, and indexes
-- ============================================================

-- WP3 patch: audit_events hardening
ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS bom_run_id uuid,
  ADD COLUMN IF NOT EXISTS key text; -- e.g. MATERIAL|PLANT

-- Ensure payload is jsonb (should already exist from M7.1)
ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb;

-- Performance indexes for timeline queries
CREATE INDEX IF NOT EXISTS idx_audit_events_user_time
  ON public.audit_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_bom_time
  ON public.audit_events(user_id, bom_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_entity_time
  ON public.audit_events(user_id, entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_key_time
  ON public.audit_events(user_id, key, created_at DESC);

-- Optional: GIN index on payload for JSON queries (if needed later)
-- CREATE INDEX IF NOT EXISTS idx_audit_events_payload_gin 
--   ON public.audit_events USING GIN (payload);
