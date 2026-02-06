-- ============================================
-- Fix import_batches.status CHECK constraint
-- ============================================
-- 目的：允許 status = 'failed'（及可選 'processing'），與前端/服務端一致
-- 約束名稱：PostgreSQL 對 CREATE TABLE 內聯 CHECK 預設命名為 {table}_{column}_check
--          （見官方文件 DDL Constraints；可於 DB 查詢：
--           SELECT conname FROM pg_constraint WHERE conrelid = 'import_batches'::regclass AND contype = 'c';）
-- ============================================

-- 刪除舊約束（若名稱不同，請依 pg_constraint 查詢結果替換）
ALTER TABLE import_batches
  DROP CONSTRAINT IF EXISTS import_batches_status_check;

-- 新增約束：至少 pending, completed, failed, undone；加入 processing 供未來使用
ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'undone'));

-- 更新註解
COMMENT ON COLUMN import_batches.status IS '批次狀態：pending=待處理, processing=寫入中, completed=完成, failed=失敗, undone=已撤銷';
