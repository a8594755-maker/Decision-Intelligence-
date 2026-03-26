-- Add tool_type column to ai_employee_runs.
-- This column tracks the executor type for each step (builtin_tool, python_tool, etc.)
-- Previously referenced in code but never created in the schema.

ALTER TABLE public.ai_employee_runs
  ADD COLUMN IF NOT EXISTS tool_type TEXT DEFAULT NULL;

COMMENT ON COLUMN public.ai_employee_runs.tool_type IS 'Executor type: builtin_tool, python_tool, report, llm_call, etc.';
