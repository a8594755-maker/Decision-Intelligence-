-- ============================================
-- SmartOps 匯入歷史與撤銷功能 - 資料庫架構
-- ============================================
-- 創建日期: 2025-12-06
-- 說明: 追蹤所有資料匯入批次，支援歷史查詢和批次撤銷

-- ============================================
-- 表1: import_batches - 匯入批次主檔
-- ============================================
CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 匯入資訊
  upload_type TEXT NOT NULL,           -- 'suppliers', 'goods_receipts', 'price_history' 等
  filename TEXT NOT NULL,              -- 原始檔案名稱
  target_table TEXT NOT NULL,          -- 目標資料表名稱
  
  -- 統計數據
  total_rows INTEGER DEFAULT 0,        -- 總行數
  success_rows INTEGER DEFAULT 0,      -- 成功匯入行數
  error_rows INTEGER DEFAULT 0,        -- 錯誤行數
  
  -- 狀態管理
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'undone')),
  
  -- 時間戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  undone_at TIMESTAMPTZ,               -- 撤銷時間
  
  -- 額外資訊（JSON 格式可存放其他元數據）
  metadata JSONB DEFAULT '{}'::jsonb
);

-- 索引優化
CREATE INDEX IF NOT EXISTS idx_import_batches_user
  ON import_batches(user_id);

CREATE INDEX IF NOT EXISTS idx_import_batches_status
  ON import_batches(status);

CREATE INDEX IF NOT EXISTS idx_import_batches_created
  ON import_batches(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_batches_upload_type
  ON import_batches(upload_type);

CREATE INDEX IF NOT EXISTS idx_import_batches_target_table
  ON import_batches(target_table);

-- 註解
COMMENT ON TABLE import_batches IS '匯入批次記錄表 - 追蹤所有資料上傳和匯入操作';
COMMENT ON COLUMN import_batches.id IS '批次唯一識別碼';
COMMENT ON COLUMN import_batches.user_id IS '執行匯入的使用者 ID';
COMMENT ON COLUMN import_batches.upload_type IS '匯入類型（對應 UPLOAD_SCHEMAS 的 key）';
COMMENT ON COLUMN import_batches.filename IS '原始上傳的檔案名稱';
COMMENT ON COLUMN import_batches.target_table IS '資料匯入的目標表格名稱';
COMMENT ON COLUMN import_batches.total_rows IS '檔案總行數（包含有效和錯誤）';
COMMENT ON COLUMN import_batches.success_rows IS '成功匯入的行數';
COMMENT ON COLUMN import_batches.error_rows IS '驗證失敗的行數';
COMMENT ON COLUMN import_batches.status IS '批次狀態：pending=處理中, completed=完成, undone=已撤銷';
COMMENT ON COLUMN import_batches.created_at IS '匯入建立時間';
COMMENT ON COLUMN import_batches.undone_at IS '批次撤銷時間';
COMMENT ON COLUMN import_batches.metadata IS '額外的元數據（可存放驗證詳情、錯誤摘要等）';

-- ============================================
-- 更新現有業務表格：加入 batch_id 和 user_id
-- ============================================

-- 更新 suppliers 表格（如果 user_id 已存在則跳過）
-- ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_batch ON suppliers(batch_id);

-- 更新 materials 表格
ALTER TABLE materials ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_materials_batch ON materials(batch_id);

-- 更新 goods_receipts 表格
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_goods_receipts_batch ON goods_receipts(batch_id);

-- 更新 price_history 表格
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_price_history_batch ON price_history(batch_id);

-- ============================================
-- 視圖：匯入歷史摘要
-- ============================================
CREATE OR REPLACE VIEW v_import_history AS
SELECT 
  ib.id,
  ib.user_id,
  au.email as user_email,
  ib.upload_type,
  ib.filename,
  ib.target_table,
  ib.total_rows,
  ib.success_rows,
  ib.error_rows,
  ib.status,
  ib.created_at,
  ib.undone_at,
  ib.metadata,
  -- 計算成功率
  CASE 
    WHEN ib.total_rows > 0 THEN 
      ROUND((ib.success_rows::numeric / ib.total_rows::numeric) * 100, 2)
    ELSE 0
  END as success_rate
FROM import_batches ib
LEFT JOIN auth.users au ON ib.user_id = au.id
ORDER BY ib.created_at DESC;

COMMENT ON VIEW v_import_history IS '匯入歷史摘要視圖 - 包含使用者資訊和成功率計算';

-- ============================================
-- RLS (Row Level Security) 設定
-- ============================================

-- 啟用 RLS
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;

-- 允許使用者查看自己的匯入批次
CREATE POLICY "Users can view own import batches"
  ON import_batches
  FOR SELECT
  USING (auth.uid() = user_id);

-- 允許使用者建立自己的匯入批次
CREATE POLICY "Users can insert own import batches"
  ON import_batches
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 允許使用者更新自己的匯入批次（例如更新狀態為 undone）
CREATE POLICY "Users can update own import batches"
  ON import_batches
  FOR UPDATE
  USING (auth.uid() = user_id);

-- 允許使用者刪除自己的匯入批次
CREATE POLICY "Users can delete own import batches"
  ON import_batches
  FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 清理函數：撤銷指定批次的所有資料
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

COMMENT ON FUNCTION undo_import_batch(UUID, UUID) IS '撤銷指定的匯入批次 - 刪除該批次的所有資料並更新狀態';

-- ============================================
-- 批量撤銷函數：一次撤銷多個批次
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

COMMENT ON FUNCTION undo_multiple_batches(UUID[], UUID) IS '批量撤銷多個匯入批次';

-- ============================================
-- 完成
-- ============================================
-- 執行此檔案後，系統將具備完整的匯入歷史追蹤和撤銷功能







