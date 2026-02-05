-- ============================================
-- SmartOps - 重置所有業務資料（含新模板 / Risk / BOM）
-- ============================================
-- 警告：此腳本會永久刪除所有業務資料！
-- 執行前請確認您真的要清空所有資料
--
-- 此操作會刪除：
-- 【舊架構】
-- - 匯入歷史記錄 (import_batches)
-- - 收貨記錄 (goods_receipts)
-- - 價格歷史 (price_history)
-- - 物料 (materials)
-- - 供應商 (suppliers)
-- 【新架構 - Risk / 供應覆蓋】
-- - 採購訂單未交 (po_open_lines)
-- - 庫存快照 (inventory_snapshots)
-- - 成品財務 (fg_financials)
-- 【新架構 - BOM / 需求】
-- - BOM 關係 (bom_edges)
-- - 成品需求 (demand_fg)
-- - 元件需求 (component_demand)
-- - 元件需求追溯 (component_demand_trace)
--
-- 此操作會保留：
-- - 表格結構、欄位、索引、RLS、使用者帳號

-- ============================================
-- 步驟 1: 顯示當前資料筆數
-- ============================================
DO $$
DECLARE
  v_import_batches_count INTEGER := 0;
  v_goods_receipts_count INTEGER := 0;
  v_price_history_count INTEGER := 0;
  v_materials_count INTEGER := 0;
  v_suppliers_count INTEGER := 0;
  v_po_open_lines_count INTEGER := 0;
  v_inventory_snapshots_count INTEGER := 0;
  v_fg_financials_count INTEGER := 0;
  v_bom_edges_count INTEGER := 0;
  v_demand_fg_count INTEGER := 0;
  v_component_demand_count INTEGER := 0;
  v_component_demand_trace_count INTEGER := 0;
  v_total_count INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO v_suppliers_count FROM suppliers;
  SELECT COUNT(*) INTO v_materials_count FROM materials;
  SELECT COUNT(*) INTO v_goods_receipts_count FROM goods_receipts;
  SELECT COUNT(*) INTO v_price_history_count FROM price_history;
  SELECT COUNT(*) INTO v_import_batches_count FROM import_batches;

  BEGIN SELECT COUNT(*) INTO v_po_open_lines_count FROM po_open_lines; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_inventory_snapshots_count FROM inventory_snapshots; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_fg_financials_count FROM fg_financials; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_bom_edges_count FROM bom_edges; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_demand_fg_count FROM demand_fg; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_component_demand_count FROM component_demand; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_component_demand_trace_count FROM component_demand_trace; EXCEPTION WHEN undefined_table THEN NULL; END;

  v_total_count := v_suppliers_count + v_materials_count + v_goods_receipts_count + v_price_history_count + v_import_batches_count
    + v_po_open_lines_count + v_inventory_snapshots_count + v_fg_financials_count + v_bom_edges_count + v_demand_fg_count
    + v_component_demand_count + v_component_demand_trace_count;

  RAISE NOTICE '========================================';
  RAISE NOTICE '當前資料筆數：';
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE 'import_batches (匯入批次): %', v_import_batches_count;
  RAISE NOTICE 'goods_receipts (收貨記錄): %', v_goods_receipts_count;
  RAISE NOTICE 'price_history (價格歷史): %', v_price_history_count;
  RAISE NOTICE 'materials (物料): %', v_materials_count;
  RAISE NOTICE 'suppliers (供應商): %', v_suppliers_count;
  RAISE NOTICE 'po_open_lines (採購未交): %', v_po_open_lines_count;
  RAISE NOTICE 'inventory_snapshots (庫存快照): %', v_inventory_snapshots_count;
  RAISE NOTICE 'fg_financials (成品財務): %', v_fg_financials_count;
  RAISE NOTICE 'bom_edges (BOM 關係): %', v_bom_edges_count;
  RAISE NOTICE 'demand_fg (成品需求): %', v_demand_fg_count;
  RAISE NOTICE 'component_demand (元件需求): %', v_component_demand_count;
  RAISE NOTICE 'component_demand_trace (元件追溯): %', v_component_demand_trace_count;
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE '總計: % 筆', v_total_count;
  RAISE NOTICE '========================================';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️  準備清空所有資料...';
END $$;

-- ============================================
-- 步驟 2: 清空所有表格資料
-- ============================================
-- 僅清空「存在」的表格，未執行的 migration 不會導致腳本失敗
DO $$
DECLARE
  tbl text;
  tables_to_truncate text[] := ARRAY[
    'component_demand_trace', 'component_demand',
    'goods_receipts', 'price_history',
    'po_open_lines', 'inventory_snapshots', 'fg_financials',
    'bom_edges', 'demand_fg',
    'materials', 'suppliers',
    'import_batches'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_truncate
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('TRUNCATE TABLE %I CASCADE', tbl);
      RAISE NOTICE '  已清空: %', tbl;
    END IF;
  END LOOP;
END $$;

-- ============================================
-- 步驟 3: 驗證清理結果
-- ============================================
DO $$
DECLARE
  v_import_batches_count INTEGER := 0;
  v_goods_receipts_count INTEGER := 0;
  v_price_history_count INTEGER := 0;
  v_materials_count INTEGER := 0;
  v_suppliers_count INTEGER := 0;
  v_po_open_lines_count INTEGER := 0;
  v_inventory_snapshots_count INTEGER := 0;
  v_fg_financials_count INTEGER := 0;
  v_bom_edges_count INTEGER := 0;
  v_demand_fg_count INTEGER := 0;
  v_component_demand_count INTEGER := 0;
  v_component_demand_trace_count INTEGER := 0;
  v_total_count INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO v_suppliers_count FROM suppliers;
  SELECT COUNT(*) INTO v_materials_count FROM materials;
  SELECT COUNT(*) INTO v_goods_receipts_count FROM goods_receipts;
  SELECT COUNT(*) INTO v_price_history_count FROM price_history;
  SELECT COUNT(*) INTO v_import_batches_count FROM import_batches;

  BEGIN SELECT COUNT(*) INTO v_po_open_lines_count FROM po_open_lines; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_inventory_snapshots_count FROM inventory_snapshots; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_fg_financials_count FROM fg_financials; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_bom_edges_count FROM bom_edges; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_demand_fg_count FROM demand_fg; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_component_demand_count FROM component_demand; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN SELECT COUNT(*) INTO v_component_demand_trace_count FROM component_demand_trace; EXCEPTION WHEN undefined_table THEN NULL; END;

  v_total_count := v_suppliers_count + v_materials_count + v_goods_receipts_count + v_price_history_count + v_import_batches_count
    + v_po_open_lines_count + v_inventory_snapshots_count + v_fg_financials_count + v_bom_edges_count + v_demand_fg_count
    + v_component_demand_count + v_component_demand_trace_count;

  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ 清理完成！';
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE '清理後筆數：';
  RAISE NOTICE 'import_batches: %, goods_receipts: %, price_history: %', v_import_batches_count, v_goods_receipts_count, v_price_history_count;
  RAISE NOTICE 'materials: %, suppliers: %', v_materials_count, v_suppliers_count;
  RAISE NOTICE 'po_open_lines: %, inventory_snapshots: %, fg_financials: %', v_po_open_lines_count, v_inventory_snapshots_count, v_fg_financials_count;
  RAISE NOTICE 'bom_edges: %, demand_fg: %', v_bom_edges_count, v_demand_fg_count;
  RAISE NOTICE 'component_demand: %, component_demand_trace: %', v_component_demand_count, v_component_demand_trace_count;
  RAISE NOTICE '----------------------------------------';
  RAISE NOTICE '總計: % 筆', v_total_count;
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
-- 執行說明
-- ============================================
-- 1. 複製此整個 SQL 腳本
-- 2. 前往 Supabase Dashboard → SQL Editor
-- 3. 建立新查詢並貼上此腳本，點擊 Run
-- 4. 僅會清空「已存在」的表格，未建的表會自動略過
-- 5. 重新整理應用程式（Risk、BOM Data 等畫面應為空）

-- ============================================
-- 注意事項
-- ============================================
-- ⚠️  此操作無法復原！建議先備份重要資料
-- ✅ 使用者帳號、表格結構、RLS 會保留
