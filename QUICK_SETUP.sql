-- ============================================
-- SmartOps 匯入歷史功能 - 快速設定
-- ============================================
-- 請在 Supabase SQL Editor 中執行此檔案

-- 步驟 1: 建立 import_batches 表格
-- ============================================
CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 匯入資訊
  upload_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  target_table TEXT NOT NULL,
  
  -- 統計數據
  total_rows INTEGER DEFAULT 0,
  success_rows INTEGER DEFAULT 0,
  error_rows INTEGER DEFAULT 0,
  
  -- 狀態管理
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'undone')),
  
  -- 時間戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  undone_at TIMESTAMPTZ,
  
  -- 額外資訊
  metadata JSONB DEFAULT '{}'::jsonb
);

-- 步驟 2: 建立索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_import_batches_user ON import_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_upload_type ON import_batches(upload_type);
CREATE INDEX IF NOT EXISTS idx_import_batches_target_table ON import_batches(target_table);

-- 步驟 3: 更新業務表格（新增 batch_id）
-- ============================================
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_batch ON suppliers(batch_id);
CREATE INDEX IF NOT EXISTS idx_materials_batch ON materials(batch_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_batch ON goods_receipts(batch_id);
CREATE INDEX IF NOT EXISTS idx_price_history_batch ON price_history(batch_id);

-- 步驟 4: 啟用 RLS
-- ============================================
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;

-- 步驟 5: 建立 RLS 政策
-- ============================================
DROP POLICY IF EXISTS "Users can view own import batches" ON import_batches;
CREATE POLICY "Users can view own import batches"
  ON import_batches
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own import batches" ON import_batches;
CREATE POLICY "Users can insert own import batches"
  ON import_batches
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own import batches" ON import_batches;
CREATE POLICY "Users can update own import batches"
  ON import_batches
  FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own import batches" ON import_batches;
CREATE POLICY "Users can delete own import batches"
  ON import_batches
  FOR DELETE
  USING (auth.uid() = user_id);

-- 步驟 6: 建立撤銷函數
-- ============================================
CREATE OR REPLACE FUNCTION undo_import_batch(
  p_batch_id UUID,
  p_user_id UUID
) RETURNS JSON AS $$
DECLARE
  v_batch RECORD;
  v_deleted_count INTEGER := 0;
  v_result JSON;
BEGIN
  -- 驗證批次存在且屬於該使用者
  SELECT * INTO v_batch
  FROM import_batches
  WHERE id = p_batch_id AND user_id = p_user_id AND status = 'completed';
  
  IF NOT FOUND THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Batch not found or already undone'
    );
  END IF;
  
  -- 根據 target_table 刪除相應的資料
  CASE v_batch.target_table
    WHEN 'suppliers' THEN
      DELETE FROM suppliers WHERE batch_id = p_batch_id;
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
      
    WHEN 'materials' THEN
      DELETE FROM materials WHERE batch_id = p_batch_id;
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
      
    WHEN 'goods_receipts' THEN
      DELETE FROM goods_receipts WHERE batch_id = p_batch_id;
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
      
    WHEN 'price_history' THEN
      DELETE FROM price_history WHERE batch_id = p_batch_id;
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
      
    ELSE
      RETURN json_build_object(
        'success', false,
        'error', 'Unknown target table: ' || v_batch.target_table
      );
  END CASE;
  
  -- 更新批次狀態為 undone
  UPDATE import_batches
  SET status = 'undone',
      undone_at = NOW()
  WHERE id = p_batch_id;
  
  -- 返回結果
  v_result := json_build_object(
    'success', true,
    'batch_id', p_batch_id,
    'deleted_count', v_deleted_count,
    'target_table', v_batch.target_table
  );
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 步驟 7: 建立批量撤銷函數
-- ============================================
CREATE OR REPLACE FUNCTION undo_multiple_batches(
  p_batch_ids UUID[],
  p_user_id UUID
) RETURNS JSON AS $$
DECLARE
  v_batch_id UUID;
  v_result JSON;
  v_results JSON[] := '{}';
  v_success_count INTEGER := 0;
  v_error_count INTEGER := 0;
BEGIN
  -- 遍歷所有批次 ID
  FOREACH v_batch_id IN ARRAY p_batch_ids
  LOOP
    -- 呼叫單一撤銷函數
    v_result := undo_import_batch(v_batch_id, p_user_id);
    
    -- 累積結果
    v_results := array_append(v_results, v_result);
    
    -- 計算成功和失敗數量
    IF (v_result->>'success')::boolean THEN
      v_success_count := v_success_count + 1;
    ELSE
      v_error_count := v_error_count + 1;
    END IF;
  END LOOP;
  
  -- 返回摘要結果
  RETURN json_build_object(
    'success', true,
    'total', array_length(p_batch_ids, 1),
    'success_count', v_success_count,
    'error_count', v_error_count,
    'details', v_results
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 完成！驗證設定
-- ============================================
-- 執行以下查詢驗證表格已建立：
-- SELECT * FROM import_batches LIMIT 1;

-- 執行以下查詢驗證欄位已新增：
-- SELECT column_name FROM information_schema.columns 
-- WHERE table_name = 'suppliers' AND column_name = 'batch_id';

-- 顯示成功訊息
DO $$
BEGIN
  RAISE NOTICE '✅ 匯入歷史功能已成功設定！';
  RAISE NOTICE '📋 import_batches 表格已建立';
  RAISE NOTICE '🔗 batch_id 欄位已新增到業務表格';
  RAISE NOTICE '🔒 RLS 政策已啟用';
  RAISE NOTICE '⚡ 撤銷函數已建立';
  RAISE NOTICE '';
  RAISE NOTICE '🎉 現在可以使用匯入歷史功能了！';
END $$;



