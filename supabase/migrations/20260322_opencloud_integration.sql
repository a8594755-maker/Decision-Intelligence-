-- ─────────────────────────────────────────────────────────────────────────────
-- OpenCloud EU Integration
-- ─────────────────────────────────────────────────────────────────────────────
-- Stores per-user OpenCloud connection settings and tracks synced files
-- for deduplication and cross-reference.

-- ── OpenCloud connection settings (per user) ────────────────────────────────

CREATE TABLE IF NOT EXISTS opencloud_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  opencloud_url TEXT NOT NULL,
  default_drive_id TEXT,
  root_folder_path TEXT DEFAULT '/Decision-Intelligence',
  auto_sync_enabled BOOLEAN DEFAULT false,
  watch_folders JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- ── Synced file tracking (deduplication + cross-reference) ──────────────────

CREATE TABLE IF NOT EXISTS opencloud_synced_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  task_id TEXT,
  artifact_type TEXT,
  drive_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  web_url TEXT,
  sharing_link TEXT,
  synced_at TIMESTAMPTZ DEFAULT now(),
  file_size_bytes BIGINT,
  content_hash TEXT
);

-- ── Row Level Security ──────────────────────────────────────────────────────

ALTER TABLE opencloud_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE opencloud_synced_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own OpenCloud connections"
  ON opencloud_connections FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users manage their own synced files"
  ON opencloud_synced_files FOR ALL USING (auth.uid() = user_id);

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_opencloud_synced_files_task
  ON opencloud_synced_files(task_id);

CREATE INDEX IF NOT EXISTS idx_opencloud_synced_files_user
  ON opencloud_synced_files(user_id, synced_at DESC);
