-- Extend source_type constraint to include all intake sources used by the app.
-- Old constraint only allowed: manual, scheduled, question_to_task, chat_decomposed.
-- This adds: chat, schedule, proactive_alert, closed_loop, email, meeting_transcript, api.

ALTER TABLE public.ai_employee_tasks
  DROP CONSTRAINT IF EXISTS ai_employee_tasks_source_type_check;

ALTER TABLE public.ai_employee_tasks
  ADD CONSTRAINT ai_employee_tasks_source_type_check
  CHECK (source_type IN (
    'manual',
    'scheduled',
    'question_to_task',
    'chat_decomposed',
    'chat',
    'schedule',
    'proactive_alert',
    'closed_loop',
    'email',
    'meeting_transcript',
    'api'
  ));

NOTIFY pgrst, 'reload schema';
