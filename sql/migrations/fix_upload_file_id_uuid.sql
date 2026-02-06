-- ============================================
-- Fix upload_file_id: 統一為 UUID（與 user_files.id 一致）
-- ============================================
-- 背景：
--   - supabase-setup.sql 定義 user_files.id 為 UUID
--   - supplier_kpi_schema 定義 goods_receipts/price_history.upload_file_id 為 BIGINT
--   - 前端 saveFile 回傳 id 為 UUID，RPC 參數為 UUID，但 RPC 內寫入時用 ::BIGINT 會型別錯誤
-- 方案：將 goods_receipts.upload_file_id、price_history.upload_file_id 改為 UUID，FK 指向 user_files(id)
-- 向下相容：既有 BIGINT 資料無法對應到 UUID，改為 NULL（僅影響追溯，不影響業務查詢）
-- 前置條件：user_files.id 必須為 UUID（如 supabase-setup.sql）。若為 BIGINT 請勿執行本 migration。
-- ============================================

-- 1. goods_receipts.upload_file_id → UUID
ALTER TABLE goods_receipts
  DROP CONSTRAINT IF EXISTS goods_receipts_upload_file_id_fkey;

ALTER TABLE goods_receipts
  ALTER COLUMN upload_file_id TYPE UUID USING NULL;

ALTER TABLE goods_receipts
  ADD CONSTRAINT goods_receipts_upload_file_id_fkey
  FOREIGN KEY (upload_file_id) REFERENCES user_files(id) ON DELETE SET NULL;

COMMENT ON COLUMN goods_receipts.upload_file_id IS '上傳檔案 ID（user_files.id，UUID）';

-- 2. price_history.upload_file_id → UUID
ALTER TABLE price_history
  DROP CONSTRAINT IF EXISTS price_history_upload_file_id_fkey;

ALTER TABLE price_history
  ALTER COLUMN upload_file_id TYPE UUID USING NULL;

ALTER TABLE price_history
  ADD CONSTRAINT price_history_upload_file_id_fkey
  FOREIGN KEY (upload_file_id) REFERENCES user_files(id) ON DELETE SET NULL;

COMMENT ON COLUMN price_history.upload_file_id IS '上傳檔案 ID（user_files.id，UUID）';
