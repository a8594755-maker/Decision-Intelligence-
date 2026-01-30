-- ============================================
-- 為 Import History 添加複合索引優化
-- ============================================
-- 用途：加速按 user_id + batch_id 查詢該次上傳的資料
-- 日期：2026-01-30
-- 說明：支援 View Data 功能的高效查詢

-- 為 bom_edges 添加 (user_id, batch_id) 複合索引
CREATE INDEX IF NOT EXISTS idx_bom_edges_user_batch
  ON bom_edges(user_id, batch_id);

-- 為 demand_fg 添加 (user_id, batch_id) 複合索引
CREATE INDEX IF NOT EXISTS idx_demand_fg_user_batch
  ON demand_fg(user_id, batch_id);

-- 驗證索引
DO $$
BEGIN
  RAISE NOTICE '✓ 已建立複合索引：idx_bom_edges_user_batch';
  RAISE NOTICE '✓ 已建立複合索引：idx_demand_fg_user_batch';
  RAISE NOTICE '';
  RAISE NOTICE '這些索引將優化 Import History View Data 查詢效能';
  RAISE NOTICE '現在可以快速查詢特定批次的所有資料';
END $$;
