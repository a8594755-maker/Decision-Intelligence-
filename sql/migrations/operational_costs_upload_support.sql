-- ============================================
-- Operational Costs: Upload Pipeline Support
-- ============================================
-- 說明:
--   1. 確保 (user_id, cost_date) UNIQUE constraint 存在（upsert 需要）
--   2. 新增 batch_id / upload_file_id 欄位（lineage / undo / batch tracking）
--   3. 擴充 upload_mappings.upload_type CHECK 以包含 operational_costs
-- ============================================

-- 1) 確保 upsert onConflict: 'user_id,cost_date' 能正常運作
--    schema 裡雖然有 UNIQUE(user_id, cost_date)，但若是先建表後加的情境需要此行
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operational_costs_user_id_cost_date_key'
       OR conname = 'operational_costs_user_date_uniq'
  ) THEN
    ALTER TABLE public.operational_costs
      ADD CONSTRAINT operational_costs_user_date_uniq UNIQUE (user_id, cost_date);
    RAISE NOTICE 'Added UNIQUE constraint operational_costs_user_date_uniq';
  ELSE
    RAISE NOTICE 'UNIQUE constraint on (user_id, cost_date) already exists, skipping';
  END IF;
END $$;

-- 2) 新增 batch_id / upload_file_id（與其他上傳表一致，做 lineage / undo / batch tracking）
-- 注意：user_files.id 的類型在不同環境可能為 UUID 或 BIGINT，需要動態判斷
ALTER TABLE public.operational_costs
  ADD COLUMN IF NOT EXISTS batch_id UUID;

-- 動態決定 upload_file_id 的類型（與 user_files.id 保持一致）
DO $$
DECLARE
  user_files_id_type TEXT;
BEGIN
  -- 檢查 user_files.id 的實際類型
  SELECT data_type INTO user_files_id_type
  FROM information_schema.columns
  WHERE table_name = 'user_files' AND column_name = 'id';
  
  RAISE NOTICE 'user_files.id type is: %', user_files_id_type;
  
  -- 根據實際類型新增 upload_file_id 欄位
  IF user_files_id_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE public.operational_costs ADD COLUMN IF NOT EXISTS upload_file_id UUID';
  ELSIF user_files_id_type = 'bigint' THEN
    EXECUTE 'ALTER TABLE public.operational_costs ADD COLUMN IF NOT EXISTS upload_file_id BIGINT';
  ELSE
    RAISE EXCEPTION 'Unsupported user_files.id type: %', user_files_id_type;
  END IF;
END $$;

-- FK: batch_id → import_batches(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operational_costs_batch_id_fkey'
  ) THEN
    ALTER TABLE public.operational_costs
      ADD CONSTRAINT operational_costs_batch_id_fkey
      FOREIGN KEY (batch_id) REFERENCES public.import_batches(id) ON DELETE SET NULL;
    RAISE NOTICE 'Added FK operational_costs_batch_id_fkey';
  ELSE
    RAISE NOTICE 'FK operational_costs_batch_id_fkey already exists, skipping';
  END IF;
END $$;

-- FK: upload_file_id → user_files(id)（動態處理類型）
DO $$
DECLARE
  user_files_id_type TEXT;
BEGIN
  -- 檢查是否已存在 constraint
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operational_costs_upload_file_id_fkey'
  ) THEN
    RAISE NOTICE 'FK operational_costs_upload_file_id_fkey already exists, skipping';
    RETURN;
  END IF;
  
  -- 檢查 user_files.id 的實際類型
  SELECT data_type INTO user_files_id_type
  FROM information_schema.columns
  WHERE table_name = 'user_files' AND column_name = 'id';
  
  -- 根據實際類型建立 FK
  IF user_files_id_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE public.operational_costs ADD CONSTRAINT operational_costs_upload_file_id_fkey FOREIGN KEY (upload_file_id) REFERENCES public.user_files(id) ON DELETE SET NULL';
    RAISE NOTICE 'Added FK operational_costs_upload_file_id_fkey (UUID)';
  ELSIF user_files_id_type = 'bigint' THEN
    EXECUTE 'ALTER TABLE public.operational_costs ADD CONSTRAINT operational_costs_upload_file_id_fkey FOREIGN KEY (upload_file_id) REFERENCES public.user_files(id) ON DELETE SET NULL';
    RAISE NOTICE 'Added FK operational_costs_upload_file_id_fkey (BIGINT)';
  END IF;
END $$;

-- 3) 擴充 upload_mappings.upload_type CHECK
--    原始 CHECK 只允許: goods_receipt, price_history, supplier_master, quality_incident
--    需要加入: operational_costs, bom_edge, demand_fg, po_open_lines, inventory_snapshots, fg_financials
ALTER TABLE public.upload_mappings
  DROP CONSTRAINT IF EXISTS upload_mappings_upload_type_check;

ALTER TABLE public.upload_mappings
  ADD CONSTRAINT upload_mappings_upload_type_check
  CHECK (
    upload_type = ANY (ARRAY[
      'goods_receipt',
      'price_history',
      'supplier_master',
      'quality_incident',
      'operational_costs',
      'bom_edge',
      'demand_fg',
      'po_open_lines',
      'inventory_snapshots',
      'fg_financials'
    ])
  );

-- 4) 索引: 加速 batch_id 查詢（undo 功能需要）
CREATE INDEX IF NOT EXISTS idx_operational_costs_batch_id
  ON public.operational_costs(batch_id);

-- ============================================
-- 完成提示
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Operational Costs Upload Support Migration 完成！';
  RAISE NOTICE '================================================';
  RAISE NOTICE '  ✓ UNIQUE(user_id, cost_date) 已確保存在';
  RAISE NOTICE '  ✓ batch_id / upload_file_id 欄位已新增';
  RAISE NOTICE '  ✓ upload_mappings CHECK 已擴充';
  RAISE NOTICE '  ✓ batch_id 索引已建立';
  RAISE NOTICE '================================================';
END $$;
