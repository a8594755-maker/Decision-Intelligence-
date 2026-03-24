-- analysis_snapshots: persists structured extracts of each AgentBrief for the Insights Hub dashboard.
-- One row per agent analysis response, linked back to the originating conversation + message.

CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  conversation_id text NOT NULL,
  message_index   int  NOT NULL,

  -- Structured fields extracted from AgentBrief
  headline        text NOT NULL,
  summary         text,
  executive_summary text,
  metric_pills    jsonb DEFAULT '[]',
  chart_specs     jsonb DEFAULT '[]',
  table_specs     jsonb DEFAULT '[]',
  key_findings    jsonb DEFAULT '[]',
  implications    jsonb DEFAULT '[]',
  caveats         jsonb DEFAULT '[]',
  next_steps      jsonb DEFAULT '[]',
  tags            text[] DEFAULT '{}',

  -- Data lineage
  data_timestamp  timestamptz,
  query_text      text,
  tool_calls_summary text,

  -- Dashboard state
  pinned          boolean DEFAULT false,
  archived        boolean DEFAULT false,
  created_at      timestamptz DEFAULT now(),

  UNIQUE(conversation_id, message_index)
);

-- Query: recent snapshots for a user (dashboard default view)
CREATE INDEX idx_snapshots_user_created ON analysis_snapshots(user_id, created_at DESC);

-- Query: pinned snapshots only
CREATE INDEX idx_snapshots_user_pinned  ON analysis_snapshots(user_id, pinned) WHERE pinned = true;

-- Query: filter by tag
CREATE INDEX idx_snapshots_tags         ON analysis_snapshots USING gin(tags);

-- Query: full-text search on headline + summary
CREATE INDEX idx_snapshots_headline_fts ON analysis_snapshots
  USING gin(to_tsvector('english', headline || ' ' || coalesce(summary, '')));

-- RLS: users can only see/modify their own snapshots
ALTER TABLE analysis_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own snapshots"
  ON analysis_snapshots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
