-- Discord Approval Queue
-- Bridges notification → Discord approval → task execution
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.discord_approval_queue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL,
  notification_id   text,                        -- from notificationService (can be local-notif-*)
  user_id           uuid NOT NULL,
  employee_id       uuid,
  title             text NOT NULL,
  description       text,
  priority          text DEFAULT 'medium',
  alert_type        text,
  severity          text,
  status            text NOT NULL DEFAULT 'pending',  -- pending, sent, approved, denied, executed, cancelled, expired
  discord_message_id text,                       -- tracks which Discord message has the buttons
  discord_channel_id text,                       -- which channel it was posted to
  decided_by        text,                        -- Discord user tag who clicked
  decided_at        timestamptz,
  created_at        timestamptz DEFAULT now(),
  expires_at        timestamptz DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_discord_queue_status ON public.discord_approval_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_discord_queue_task   ON public.discord_approval_queue (task_id);

-- RLS: service role bypasses, authenticated users see their own
ALTER TABLE public.discord_approval_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own approvals"
  ON public.discord_approval_queue
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own approvals"
  ON public.discord_approval_queue
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON public.discord_approval_queue
  FOR ALL
  USING (auth.role() = 'service_role');
