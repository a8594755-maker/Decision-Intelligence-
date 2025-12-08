-- upload_mappings 表：儲存使用者的欄位映射模板
-- 用於自動套用之前的 mapping，加速重複上傳流程

CREATE TABLE IF NOT EXISTS upload_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  upload_type TEXT NOT NULL CHECK (upload_type IN ('goods_receipt', 'price_history', 'supplier_master', 'quality_incident')),
  original_columns JSONB NOT NULL,
  mapping_json JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引：快速查詢使用者的特定類型 mapping
CREATE INDEX idx_upload_mappings_user_type ON upload_mappings(user_id, upload_type);
CREATE INDEX idx_upload_mappings_user_id ON upload_mappings(user_id);
CREATE INDEX idx_upload_mappings_created_at ON upload_mappings(created_at DESC);

-- 唯一約束：每個使用者的每種類型只保存最新的一份 mapping
CREATE UNIQUE INDEX idx_upload_mappings_unique ON upload_mappings(user_id, upload_type);

-- 更新時間觸發器
CREATE OR REPLACE FUNCTION update_upload_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_upload_mappings_updated_at
  BEFORE UPDATE ON upload_mappings
  FOR EACH ROW
  EXECUTE FUNCTION update_upload_mappings_updated_at();

-- RLS (Row Level Security) 政策
ALTER TABLE upload_mappings ENABLE ROW LEVEL SECURITY;

-- 使用者只能看到自己的 mapping
CREATE POLICY "Users can view own mappings"
  ON upload_mappings
  FOR SELECT
  USING (auth.uid() = user_id);

-- 使用者只能插入自己的 mapping
CREATE POLICY "Users can insert own mappings"
  ON upload_mappings
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 使用者只能更新自己的 mapping
CREATE POLICY "Users can update own mappings"
  ON upload_mappings
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 使用者只能刪除自己的 mapping
CREATE POLICY "Users can delete own mappings"
  ON upload_mappings
  FOR DELETE
  USING (auth.uid() = user_id);

-- 註釋
COMMENT ON TABLE upload_mappings IS '儲存使用者的欄位映射模板，用於自動套用之前的 mapping';
COMMENT ON COLUMN upload_mappings.user_id IS '使用者 ID';
COMMENT ON COLUMN upload_mappings.upload_type IS '上傳類型：goods_receipt, price_history, supplier_master, quality_incident';
COMMENT ON COLUMN upload_mappings.original_columns IS '原始 Excel 欄位列表（JSON 陣列）';
COMMENT ON COLUMN upload_mappings.mapping_json IS '欄位映射關係（JSON 物件）：{ "excel_column": "system_field_key" }';
COMMENT ON COLUMN upload_mappings.created_at IS '建立時間';
COMMENT ON COLUMN upload_mappings.updated_at IS '最後更新時間';






