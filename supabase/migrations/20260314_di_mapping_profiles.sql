-- Mapping Profile Storage
-- Stores user-confirmed column mapping profiles for reuse on repeated imports.
-- Composite unique key: (user_id, source_fingerprint, upload_type)

CREATE TABLE IF NOT EXISTS di_mapping_profiles (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_fingerprint text NOT NULL,
  upload_type       text NOT NULL,
  column_mapping    jsonb NOT NULL,          -- { sourceCol: canonicalField }
  field_confidence  jsonb,                   -- { sourceCol: { confidence, matchType } }
  header_list       text[] DEFAULT '{}',     -- original headers for display in management UI
  display_name      text,                    -- auto-generated friendly name, e.g. "inventory_snapshots (12 cols)"
  use_count         integer DEFAULT 1,
  created_at        timestamptz DEFAULT now(),
  last_used_at      timestamptz DEFAULT now(),
  UNIQUE(user_id, source_fingerprint, upload_type)
);

CREATE INDEX IF NOT EXISTS idx_mapping_profiles_user
  ON di_mapping_profiles(user_id);

CREATE INDEX IF NOT EXISTS idx_mapping_profiles_lookup
  ON di_mapping_profiles(user_id, source_fingerprint, upload_type);

-- RLS
ALTER TABLE di_mapping_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own mapping profiles"
  ON di_mapping_profiles
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
