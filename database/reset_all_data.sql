-- ============================================
-- SmartOps - 重置所有業務資料
-- ============================================
-- 警告：此腳本會永久刪除所有業務資料！
-- 執行前請確認您真的要清空所有資料
-- 
-- 此操作會刪除：
-- - 所有供應商資料 (suppliers)
-- - 所有物料資料 (materials)
-- - 所有收貨記錄 (goods_receipts)
-- - 所有價格歷史 (price_history)
-- - 所有匯入歷史記錄 (import_batches)
--
-- 此操作會保留：
-- - 表格結構
-- - 欄位（包括 batch_id）
-- - 索引
-- - RLS 政策
-- - 撤銷函數
-- - 使用者帳號

-- ============================================
-- 步驟 1: 顯示當前資料筆數
-- ============================================
DO $$
DECLARE
  v_suppliers_count INTEGER;
  v_materials_count INTEGER;
  v_goods_receipts_count INTEGER;
  v_price_history_count INTEGER;
  v_import_batches_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_suppliers_count FROM suppliers;
  SELECT COUNT(*) INTO v_materials_count FROM materials;
  SELECT COUNT(*) INTO v_goods_receipts_count FROM goods_receipts;
  SELECT COUNT(*) INTO v_price_history_count FROM price_history;
  SELECT COUNT(*) INTO v_import_batches_count FROM import_batches;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE '當前資料筆數：';
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE 'suppliers (供應商): %', v_suppliers_count;
  RAISE NOTICE 'materials (物料): %', v_materials_count;
  RAISE NOTICE 'goods_receipts (收貨記錄): %', v_goods_receipts_count;
  RAISE NOTICE 'price_history (價格歷史): %', v_price_history_count;
  RAISE NOTICE 'import_batches (匯入批次): %', v_import_batches_count;
  RAISE NOTICE '========================================';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️  準備清空所有資料...';
END $$;

-- ============================================
-- 步驟 2: 清空所有表格資料
-- ============================================
-- 注意：使用 TRUNCATE CASCADE 會自動處理外鍵關聯

-- 清空匯入歷史（最上層，沒有被其他表格參照）
TRUNCATE TABLE import_batches CASCADE;

-- 清空業務資料（按照相依性順序）
-- goods_receipts 和 price_history 參照 suppliers 和 materials
TRUNCATE TABLE goods_receipts CASCADE;
TRUNCATE TABLE price_history CASCADE;

-- materials 和 suppliers 是基礎表格
TRUNCATE TABLE materials CASCADE;
TRUNCATE TABLE suppliers CASCADE;

-- 如果有其他相關表格，也一併清空
-- 例如：user_files (如果您想清空上傳記錄)
-- TRUNCATE TABLE user_files CASCADE;

-- ============================================
-- 步驟 3: 重置序列（如果有使用 SERIAL）
-- ============================================
-- PostgreSQL 的 UUID 不需要重置序列
-- 如果您的表格使用 SERIAL/BIGSERIAL，請取消以下註解：
-- ALTER SEQUENCE suppliers_id_seq RESTART WITH 1;
-- ALTER SEQUENCE materials_id_seq RESTART WITH 1;

-- ============================================
-- 步驟 4: 驗證清理結果
-- ============================================
DO $$
DECLARE
  v_suppliers_count INTEGER;
  v_materials_count INTEGER;
  v_goods_receipts_count INTEGER;
  v_price_history_count INTEGER;
  v_import_batches_count INTEGER;
  v_total_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_suppliers_count FROM suppliers;
  SELECT COUNT(*) INTO v_materials_count FROM materials;
  SELECT COUNT(*) INTO v_goods_receipts_count FROM goods_receipts;
  SELECT COUNT(*) INTO v_price_history_count FROM price_history;
  SELECT COUNT(*) INTO v_import_batches_count FROM import_batches;
  
  v_total_count := v_suppliers_count + v_materials_count + v_goods_receipts_count + v_price_history_count + v_import_batches_count;
  
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ 清理完成！';
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE '清理後資料筆數：';
  RAISE NOTICE 'suppliers (供應商): %', v_suppliers_count;
  RAISE NOTICE 'materials (物料): %', v_materials_count;
  RAISE NOTICE 'goods_receipts (收貨記錄): %', v_goods_receipts_count;
  RAISE NOTICE 'price_history (價格歷史): %', v_price_history_count;
  RAISE NOTICE 'import_batches (匯入批次): %', v_import_batches_count;
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE '總計: % 筆資料', v_total_count;
  RAISE NOTICE '========================================';
  RAISE NOTICE '';
  
  IF v_total_count = 0 THEN
    RAISE NOTICE '🎉 所有資料已成功清空！';
    RAISE NOTICE '📝 表格結構和功能完好保留';
    RAISE NOTICE '🚀 現在可以重新開始上傳測試資料';
  ELSE
    RAISE WARNING '⚠️  警告：仍有 % 筆資料未清空', v_total_count;
  END IF;
END $$;

-- ============================================
-- 可選：驗證表格結構仍然完整
-- ============================================
-- 執行以下查詢確認表格和欄位都還在：

-- SELECT table_name, column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
-- AND table_name IN ('suppliers', 'materials', 'goods_receipts', 'price_history', 'import_batches')
-- ORDER BY table_name, ordinal_position;

-- ============================================
-- 執行說明
-- ============================================
-- 1. 複製此整個 SQL 腳本
-- 2. 前往 Supabase Dashboard → SQL Editor
-- 3. 建立新查詢並貼上此腳本
-- 4. 點擊 "Run" 執行
-- 5. 查看執行結果和訊息
-- 6. 重新整理您的應用程式

-- ============================================
-- 注意事項
-- ============================================
-- ⚠️  此操作無法復原！
-- ⚠️  建議先備份重要資料
-- ⚠️  執行前請確認您真的要清空所有資料
-- ✅ 使用者帳號不會受影響
-- ✅ 表格結構和功能會保留
-- ✅ 匯入歷史功能會繼續正常運作





