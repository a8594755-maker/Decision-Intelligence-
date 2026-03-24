-- Failure Memory table for AI Employee learning
CREATE TABLE IF NOT EXISTS public.ai_employee_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Memory classification
  memory_type TEXT NOT NULL DEFAULT 'failure_pattern',
  category TEXT,

  -- Pattern details
  pattern_key TEXT NOT NULL,
  tool_name TEXT,
  error_message TEXT,
  error_context JSONB,

  -- Resolution
  resolution TEXT,
  resolved_at TIMESTAMPTZ,

  -- Frequency tracking
  occurrence_count INTEGER DEFAULT 1,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),

  -- Standard timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate patterns per project
  UNIQUE(project_id, pattern_key)
);

-- Index for fast recall during agent loops
CREATE INDEX idx_ai_employee_memory_project
  ON public.ai_employee_memory(project_id, memory_type, last_seen_at DESC);

CREATE INDEX idx_ai_employee_memory_pattern
  ON public.ai_employee_memory(pattern_key);

-- RLS policies
ALTER TABLE public.ai_employee_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project memories"
  ON public.ai_employee_memory FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project memories"
  ON public.ai_employee_memory FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project memories"
  ON public.ai_employee_memory FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own project memories"
  ON public.ai_employee_memory FOR DELETE
  USING (auth.uid() = user_id);
