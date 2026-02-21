-- Decision-Intelligence Supabase Database Setup
-- 運行此腳本在 Supabase SQL Editor 中創建所需的資料表

-- 1. 創建 conversations 資料表 (用於 AI 對話紀錄)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Conversation',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 為 user_id 創建索引以加速查詢
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);

-- 啟用 Row Level Security (RLS)
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- 創建 RLS 策略: 用戶只能查看自己的對話
CREATE POLICY "Users can view their own conversations"
  ON conversations FOR SELECT
  USING (auth.uid() = user_id);

-- 創建 RLS 策略: 用戶只能插入自己的對話
CREATE POLICY "Users can insert their own conversations"
  ON conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 創建 RLS 策略: 用戶只能更新自己的對話
CREATE POLICY "Users can update their own conversations"
  ON conversations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 創建 RLS 策略: 用戶只能刪除自己的對話
CREATE POLICY "Users can delete their own conversations"
  ON conversations FOR DELETE
  USING (auth.uid() = user_id);

-- 2. 確保 user_files 資料表存在 (如果還沒創建)
CREATE TABLE IF NOT EXISTS user_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 為 user_files 創建索引
CREATE INDEX IF NOT EXISTS idx_user_files_user_id ON user_files(user_id);
CREATE INDEX IF NOT EXISTS idx_user_files_created_at ON user_files(created_at DESC);

-- 啟用 Row Level Security for user_files
ALTER TABLE user_files ENABLE ROW LEVEL SECURITY;

-- 創建 RLS 策略 for user_files
CREATE POLICY "Users can view their own files"
  ON user_files FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own files"
  ON user_files FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own files"
  ON user_files FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own files"
  ON user_files FOR DELETE
  USING (auth.uid() = user_id);

-- 完成!
-- 執行成功後，你的 Decision-Intelligence 應用程式將能夠:
-- 1. 管理多個 AI 對話
-- 2. 每個用戶的資料完全隔離
-- 3. 自動追蹤創建和更新時間
