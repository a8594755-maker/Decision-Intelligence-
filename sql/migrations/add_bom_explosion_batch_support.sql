-- ============================================
-- BOM Explosion 批次支援 - SQL Patch
-- ============================================
-- 檔案位置: database/add_bom_explosion_batch_support.sql
-- 執行日期: 2026-01-26
-- 說明: 為 BOM Explosion 加入 import_batches 和 undo 支援

-- ============================================
-- Step 1: 更新 undo_import_batch 函數
-- ============================================
CREATE OR REPLACE FUNCTION undo_import_batch(
  p_batch_id UUID,
  p_user_id UUID
) RETURNS JSON AS $$
DECLARE
  v_batch RECORD;
  v_deleted_count INTEGER := 0;
  v_trace_count INTEGER := 0;
  v_demand_count INTEGER := 0;
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
      
    WHEN 'bom_explosion' THEN
      -- Step 1: 先刪除 component_demand_trace（因為有 foreign key 約束）
      DELETE FROM component_demand_trace WHERE batch_id = p_batch_id;
      GET DIAGNOSTICS v_trace_count = ROW_COUNT;
      
      -- Step 2: 再刪除 component_demand
      DELETE FROM component_demand WHERE batch_id = p_batch_id;
      GET DIAGNOSTICS v_demand_count = ROW_COUNT;
      
      -- 設定總刪除數量
      v_deleted_count := v_trace_count + v_demand_count;
      
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
  
  -- 返回結果（BOM explosion 返回詳細統計）
  IF v_batch.target_table = 'bom_explosion' THEN
    v_result := json_build_object(
      'success', true,
      'batch_id', p_batch_id,
      'deleted_count', v_deleted_count,
      'target_table', v_batch.target_table,
      'details', json_build_object(
        'component_demand_count', v_demand_count,
        'component_demand_trace_count', v_trace_count
      )
    );
  ELSE
    v_result := json_build_object(
      'success', true,
      'batch_id', p_batch_id,
      'deleted_count', v_deleted_count,
      'target_table', v_batch.target_table
    );
  END IF;
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION undo_import_batch(UUID, UUID) IS '撤銷指定的匯入批次 - 刪除該批次的所有資料並更新狀態（支援 BOM Explosion）';

-- ============================================
-- Step 2: 確認 component_demand 和 component_demand_trace 有 batch_id 欄位
-- ============================================
-- 檢查並添加 batch_id 欄位（如果不存在）

-- component_demand 表格
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'component_demand' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE component_demand ADD COLUMN batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
    CREATE INDEX idx_component_demand_batch ON component_demand(batch_id);
    RAISE NOTICE 'Added batch_id column to component_demand table';
  ELSE
    RAISE NOTICE 'batch_id column already exists in component_demand table';
  END IF;
END $$;

-- component_demand_trace 表格
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'component_demand_trace' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE component_demand_trace ADD COLUMN batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL;
    CREATE INDEX idx_component_demand_trace_batch ON component_demand_trace(batch_id);
    RAISE NOTICE 'Added batch_id column to component_demand_trace table';
  ELSE
    RAISE NOTICE 'batch_id column already exists in component_demand_trace table';
  END IF;
END $$;

-- ============================================
-- Step 3: 更新 importHistoryService 的 getBatchData 支援
-- ============================================
-- 此步驟已在前端代碼中完成（importHistoryService.js）

-- ============================================
-- 完成
-- ============================================
-- 執行此檔案後，BOM Explosion 將完整整合到匯入歷史和撤銷機制中

SELECT 'BOM Explosion batch support installation completed!' as status;
