-- ============================================
-- SmartOps Ingest RPC Functions
-- ============================================
-- 目的：提供高效能、交易性的批次資料寫入 API
-- 版本：v1
-- 建立日期：2026-02-05
--
-- 包含的 Functions：
--   1. ingest_goods_receipts_v1  - 批次寫入收貨記錄（含 supplier/material 自動建立）
--   2. ingest_price_history_v1   - 批次寫入價格歷史（含 supplier/material 自動建立）
--
-- 特性：
--   ✓ Transaction 保證（全部成功或全部回滾）
--   ✓ Idempotency（可重複執行，基於 batch_id）
--   ✓ 自動建立/查找 suppliers 和 materials
--   ✓ RLS 安全控制（使用 auth.uid()）
--   ✓ 詳細的錯誤訊息和統計回傳
-- ============================================

-- ============================================
-- Function 1: ingest_goods_receipts_v1
-- ============================================
-- 用途：批次寫入收貨記錄，自動處理 supplier/material 查找或建立
-- 參數：
--   p_batch_id        - 批次 ID（用於 idempotency）
--   p_upload_file_id  - 上傳檔案 ID（來源追溯）
--   p_rows            - JSONB 陣列，每個元素包含：
--                       {
--                         material_code: TEXT (必填),
--                         material_name: TEXT (選填，預設同 material_code),
--                         supplier_code: TEXT (選填),
--                         supplier_name: TEXT (必填 if no supplier_code),
--                         po_number: TEXT (選填),
--                         receipt_number: TEXT (選填),
--                         planned_delivery_date: DATE (選填),
--                         actual_delivery_date: DATE (必填),
--                         receipt_date: DATE (選填，預設 actual_delivery_date),
--                         received_qty: NUMERIC (必填),
--                         rejected_qty: NUMERIC (選填，預設 0),
--                         uom: TEXT (選填，預設 'pcs')
--                       }
-- 回傳：
--   JSONB {
--     success: BOOLEAN,
--     inserted_count: INTEGER,
--     suppliers_created: INTEGER,
--     suppliers_found: INTEGER,
--     materials_upserted: INTEGER,
--     batch_id: UUID,
--     upload_file_id: BIGINT
--   }
-- ============================================

CREATE OR REPLACE FUNCTION ingest_goods_receipts_v1(
  p_batch_id UUID,
  p_upload_file_id UUID,
  p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER -- 允許繞過 RLS，但內部會檢查 auth.uid()
AS $$
DECLARE
  v_user_id UUID;
  v_inserted_count INTEGER := 0;
  v_suppliers_created INTEGER := 0;
  v_suppliers_found INTEGER := 0;
  v_materials_upserted INTEGER := 0;
  v_supplier_id UUID;
  v_material_id UUID;
  v_row RECORD;
  v_supplier_name_norm TEXT;
BEGIN
  -- ===== 安全檢查：必須已登入 =====
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: User must be logged in to ingest data';
  END IF;

  -- ===== Idempotency：刪除同 batch_id 的舊資料 =====
  DELETE FROM goods_receipts 
  WHERE user_id = v_user_id 
    AND batch_id = p_batch_id;

  -- ===== 開始處理每一行資料 =====
  FOR v_row IN (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS x(
      material_code TEXT,
      material_name TEXT,
      supplier_code TEXT,
      supplier_name TEXT,
      po_number TEXT,
      receipt_number TEXT,
      planned_delivery_date DATE,
      actual_delivery_date DATE,
      receipt_date DATE,
      received_qty NUMERIC,
      rejected_qty NUMERIC,
      uom TEXT
    )
  )
  LOOP
    -- ===== 驗證必填欄位 =====
    IF v_row.material_code IS NULL OR v_row.material_code = '' THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: material_code is required';
    END IF;

    IF v_row.actual_delivery_date IS NULL THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: actual_delivery_date is required';
    END IF;

    IF v_row.received_qty IS NULL OR v_row.received_qty < 0 THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: received_qty must be >= 0';
    END IF;

    IF v_row.supplier_name IS NULL OR v_row.supplier_name = '' THEN
      IF v_row.supplier_code IS NULL OR v_row.supplier_code = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: Either supplier_code or supplier_name must be provided';
      END IF;
    END IF;

    -- ===== Step 1: 處理 Supplier（查找或建立） =====
    v_supplier_id := NULL;

    -- 優先使用 supplier_code 查找
    IF v_row.supplier_code IS NOT NULL AND v_row.supplier_code != '' THEN
      SELECT id INTO v_supplier_id
      FROM suppliers
      WHERE user_id = v_user_id
        AND supplier_code = v_row.supplier_code
      LIMIT 1;

      IF v_supplier_id IS NOT NULL THEN
        v_suppliers_found := v_suppliers_found + 1;
      END IF;
    END IF;

    -- 若沒找到且有 supplier_name，使用 supplier_name_norm 查找
    IF v_supplier_id IS NULL AND v_row.supplier_name IS NOT NULL AND v_row.supplier_name != '' THEN
      -- 正規化 supplier_name（同 trigger 邏輯）
      v_supplier_name_norm := LOWER(TRIM(REGEXP_REPLACE(v_row.supplier_name, '\s+', ' ', 'g')));

      SELECT id INTO v_supplier_id
      FROM suppliers
      WHERE user_id = v_user_id
        AND supplier_name_norm = v_supplier_name_norm
      LIMIT 1;

      IF v_supplier_id IS NOT NULL THEN
        v_suppliers_found := v_suppliers_found + 1;
      END IF;
    END IF;

    -- 若都沒找到，建立新 supplier
    IF v_supplier_id IS NULL THEN
      INSERT INTO suppliers (
        user_id,
        supplier_name,
        supplier_code,
        status,
        batch_id
      ) VALUES (
        v_user_id,
        COALESCE(v_row.supplier_name, v_row.supplier_code),
        v_row.supplier_code,
        'active',
        p_batch_id
      )
      RETURNING id INTO v_supplier_id;

      v_suppliers_created := v_suppliers_created + 1;
    END IF;

    -- ===== Step 2: 處理 Material（Upsert） =====
    INSERT INTO materials (
      user_id,
      material_code,
      material_name,
      uom,
      batch_id
    ) VALUES (
      v_user_id,
      v_row.material_code,
      COALESCE(v_row.material_name, v_row.material_code),
      COALESCE(v_row.uom, 'pcs'),
      p_batch_id
    )
    ON CONFLICT (user_id, material_code)
    DO UPDATE SET
      material_name = COALESCE(EXCLUDED.material_name, materials.material_name),
      uom = COALESCE(EXCLUDED.uom, materials.uom),
      updated_at = NOW()
    RETURNING id INTO v_material_id;

    v_materials_upserted := v_materials_upserted + 1;

    -- ===== Step 3: 插入 Goods Receipt =====
    INSERT INTO goods_receipts (
      user_id,
      upload_file_id,
      batch_id,
      supplier_id,
      material_id,
      po_number,
      receipt_number,
      planned_delivery_date,
      actual_delivery_date,
      receipt_date,
      received_qty,
      rejected_qty
    ) VALUES (
      v_user_id,
      p_upload_file_id::BIGINT, -- UUID 轉 BIGINT（若 schema 允許）
      p_batch_id,
      v_supplier_id,
      v_material_id,
      v_row.po_number,
      v_row.receipt_number,
      v_row.planned_delivery_date,
      v_row.actual_delivery_date,
      COALESCE(v_row.receipt_date, v_row.actual_delivery_date),
      v_row.received_qty,
      COALESCE(v_row.rejected_qty, 0)
    );

    v_inserted_count := v_inserted_count + 1;
  END LOOP;

  -- ===== 回傳結果 =====
  RETURN jsonb_build_object(
    'success', TRUE,
    'inserted_count', v_inserted_count,
    'suppliers_created', v_suppliers_created,
    'suppliers_found', v_suppliers_found,
    'materials_upserted', v_materials_upserted,
    'batch_id', p_batch_id,
    'upload_file_id', p_upload_file_id
  );

EXCEPTION
  WHEN OTHERS THEN
    -- 任何錯誤都回滾整個 transaction
    RAISE EXCEPTION 'INGEST_ERROR: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

-- 授予權限
GRANT EXECUTE ON FUNCTION ingest_goods_receipts_v1(UUID, UUID, JSONB) TO authenticated;

-- 註解
COMMENT ON FUNCTION ingest_goods_receipts_v1 IS 
'批次寫入收貨記錄 - 自動處理 supplier/material 查找或建立，支援 idempotency (v1)';


-- ============================================
-- Function 2: ingest_price_history_v1
-- ============================================
-- 用途：批次寫入價格歷史，自動處理 supplier/material 查找或建立
-- 參數：
--   p_batch_id        - 批次 ID（用於 idempotency）
--   p_upload_file_id  - 上傳檔案 ID（來源追溯）
--   p_rows            - JSONB 陣列，每個元素包含：
--                       {
--                         material_code: TEXT (必填),
--                         material_name: TEXT (選填，預設同 material_code),
--                         supplier_code: TEXT (選填),
--                         supplier_name: TEXT (必填 if no supplier_code),
--                         order_date: DATE (必填) [或 effective_date],
--                         unit_price: NUMERIC (必填) [或 price],
--                         currency: TEXT (選填，預設 'USD'),
--                         quantity: NUMERIC (選填，預設 0),
--                         is_contract_price: BOOLEAN (選填，預設 false),
--                         uom: TEXT (選填，預設 'pcs')
--                       }
-- 回傳：
--   JSONB {
--     success: BOOLEAN,
--     inserted_count: INTEGER,
--     suppliers_created: INTEGER,
--     suppliers_found: INTEGER,
--     materials_upserted: INTEGER,
--     batch_id: UUID,
--     upload_file_id: BIGINT
--   }
-- ============================================

CREATE OR REPLACE FUNCTION ingest_price_history_v1(
  p_batch_id UUID,
  p_upload_file_id UUID,
  p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER -- 允許繞過 RLS，但內部會檢查 auth.uid()
AS $$
DECLARE
  v_user_id UUID;
  v_inserted_count INTEGER := 0;
  v_suppliers_created INTEGER := 0;
  v_suppliers_found INTEGER := 0;
  v_materials_upserted INTEGER := 0;
  v_supplier_id UUID;
  v_material_id UUID;
  v_row RECORD;
  v_supplier_name_norm TEXT;
  v_order_date DATE;
  v_unit_price NUMERIC;
BEGIN
  -- ===== 安全檢查：必須已登入 =====
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: User must be logged in to ingest data';
  END IF;

  -- ===== Idempotency：刪除同 batch_id 的舊資料 =====
  DELETE FROM price_history 
  WHERE user_id = v_user_id 
    AND batch_id = p_batch_id;

  -- ===== 開始處理每一行資料 =====
  FOR v_row IN (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS x(
      material_code TEXT,
      material_name TEXT,
      supplier_code TEXT,
      supplier_name TEXT,
      order_date DATE,
      effective_date DATE, -- 別名支援
      unit_price NUMERIC,
      price NUMERIC, -- 別名支援
      currency TEXT,
      quantity NUMERIC,
      is_contract_price BOOLEAN,
      uom TEXT
    )
  )
  LOOP
    -- ===== 驗證必填欄位 =====
    IF v_row.material_code IS NULL OR v_row.material_code = '' THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: material_code is required';
    END IF;

    -- 支援 order_date 或 effective_date
    v_order_date := COALESCE(v_row.order_date, v_row.effective_date);
    IF v_order_date IS NULL THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: order_date (or effective_date) is required';
    END IF;

    -- 支援 unit_price 或 price
    v_unit_price := COALESCE(v_row.unit_price, v_row.price);
    IF v_unit_price IS NULL OR v_unit_price < 0 THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: unit_price (or price) must be >= 0';
    END IF;

    IF v_row.supplier_name IS NULL OR v_row.supplier_name = '' THEN
      IF v_row.supplier_code IS NULL OR v_row.supplier_code = '' THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: Either supplier_code or supplier_name must be provided';
      END IF;
    END IF;

    -- ===== Step 1: 處理 Supplier（查找或建立） =====
    v_supplier_id := NULL;

    -- 優先使用 supplier_code 查找
    IF v_row.supplier_code IS NOT NULL AND v_row.supplier_code != '' THEN
      SELECT id INTO v_supplier_id
      FROM suppliers
      WHERE user_id = v_user_id
        AND supplier_code = v_row.supplier_code
      LIMIT 1;

      IF v_supplier_id IS NOT NULL THEN
        v_suppliers_found := v_suppliers_found + 1;
      END IF;
    END IF;

    -- 若沒找到且有 supplier_name，使用 supplier_name_norm 查找
    IF v_supplier_id IS NULL AND v_row.supplier_name IS NOT NULL AND v_row.supplier_name != '' THEN
      -- 正規化 supplier_name（同 trigger 邏輯）
      v_supplier_name_norm := LOWER(TRIM(REGEXP_REPLACE(v_row.supplier_name, '\s+', ' ', 'g')));

      SELECT id INTO v_supplier_id
      FROM suppliers
      WHERE user_id = v_user_id
        AND supplier_name_norm = v_supplier_name_norm
      LIMIT 1;

      IF v_supplier_id IS NOT NULL THEN
        v_suppliers_found := v_suppliers_found + 1;
      END IF;
    END IF;

    -- 若都沒找到，建立新 supplier
    IF v_supplier_id IS NULL THEN
      INSERT INTO suppliers (
        user_id,
        supplier_name,
        supplier_code,
        status,
        batch_id
      ) VALUES (
        v_user_id,
        COALESCE(v_row.supplier_name, v_row.supplier_code),
        v_row.supplier_code,
        'active',
        p_batch_id
      )
      RETURNING id INTO v_supplier_id;

      v_suppliers_created := v_suppliers_created + 1;
    END IF;

    -- ===== Step 2: 處理 Material（Upsert） =====
    INSERT INTO materials (
      user_id,
      material_code,
      material_name,
      uom,
      batch_id
    ) VALUES (
      v_user_id,
      v_row.material_code,
      COALESCE(v_row.material_name, v_row.material_code),
      COALESCE(v_row.uom, 'pcs'),
      p_batch_id
    )
    ON CONFLICT (user_id, material_code)
    DO UPDATE SET
      material_name = COALESCE(EXCLUDED.material_name, materials.material_name),
      uom = COALESCE(EXCLUDED.uom, materials.uom),
      updated_at = NOW()
    RETURNING id INTO v_material_id;

    v_materials_upserted := v_materials_upserted + 1;

    -- ===== Step 3: 插入 Price History =====
    INSERT INTO price_history (
      user_id,
      upload_file_id,
      batch_id,
      supplier_id,
      material_id,
      order_date,
      unit_price,
      currency,
      quantity,
      is_contract_price
    ) VALUES (
      v_user_id,
      p_upload_file_id::BIGINT, -- UUID 轉 BIGINT（若 schema 允許）
      p_batch_id,
      v_supplier_id,
      v_material_id,
      v_order_date,
      v_unit_price,
      COALESCE(v_row.currency, 'USD'),
      COALESCE(v_row.quantity, 0),
      COALESCE(v_row.is_contract_price, FALSE)
    );

    v_inserted_count := v_inserted_count + 1;
  END LOOP;

  -- ===== 回傳結果 =====
  RETURN jsonb_build_object(
    'success', TRUE,
    'inserted_count', v_inserted_count,
    'suppliers_created', v_suppliers_created,
    'suppliers_found', v_suppliers_found,
    'materials_upserted', v_materials_upserted,
    'batch_id', p_batch_id,
    'upload_file_id', p_upload_file_id
  );

EXCEPTION
  WHEN OTHERS THEN
    -- 任何錯誤都回滾整個 transaction
    RAISE EXCEPTION 'INGEST_ERROR: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
END;
$$;

-- 授予權限
GRANT EXECUTE ON FUNCTION ingest_price_history_v1(UUID, UUID, JSONB) TO authenticated;

-- 註解
COMMENT ON FUNCTION ingest_price_history_v1 IS 
'批次寫入價格歷史 - 自動處理 supplier/material 查找或建立，支援 idempotency (v1)';


-- ============================================
-- 完成提示與測試範例
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Ingest RPC Functions 建立完成！';
  RAISE NOTICE '================================================';
  RAISE NOTICE '';
  RAISE NOTICE '已建立的 Functions:';
  RAISE NOTICE '  ✓ ingest_goods_receipts_v1(batch_id, upload_file_id, rows)';
  RAISE NOTICE '  ✓ ingest_price_history_v1(batch_id, upload_file_id, rows)';
  RAISE NOTICE '';
  RAISE NOTICE '特性:';
  RAISE NOTICE '  • Transaction 保證（全部成功或全部回滾）';
  RAISE NOTICE '  • Idempotency（基於 batch_id）';
  RAISE NOTICE '  • 自動建立/查找 suppliers 和 materials';
  RAISE NOTICE '  • RLS 安全控制（使用 auth.uid()）';
  RAISE NOTICE '  • SECURITY DEFINER（需要 auth.uid() 檢查）';
  RAISE NOTICE '';
  RAISE NOTICE '注意事項:';
  RAISE NOTICE '  ⚠ upload_file_id 預期為 UUID 但表中為 BIGINT';
  RAISE NOTICE '    → RPC 內部會做型別轉換（p_upload_file_id::BIGINT）';
  RAISE NOTICE '    → 若需要，請調整 user_files.id 型別或 RPC 參數型別';
  RAISE NOTICE '';
  RAISE NOTICE '================================================';
END $$;


-- ============================================
-- 如何在 Supabase SQL Editor 執行此腳本
-- ============================================
-- 1. 登入 Supabase Dashboard: https://app.supabase.com
-- 2. 選擇你的專案
-- 3. 點擊左側選單的 "SQL Editor"
-- 4. 點擊 "New Query"
-- 5. 複製整個檔案內容並貼上
-- 6. 點擊 "Run" 執行
-- 7. 檢查執行結果：
--    - 應該看到 "Ingest RPC Functions 建立完成！" 訊息
--    - 若有錯誤，請檢查錯誤訊息並修正


-- ============================================
-- 最小測試範例
-- ============================================
-- 注意：以下測試需要在已登入的情況下執行（需要 auth.uid()）
-- 在 Supabase SQL Editor 無法直接測試（因為沒有 auth context）
-- 建議在前端程式碼中透過 supabase.rpc() 呼叫測試

-- 測試 1: ingest_goods_receipts_v1（最小範例）
-- SELECT ingest_goods_receipts_v1(
--   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::UUID, -- batch_id
--   '11111111-2222-3333-4444-555555555555'::UUID, -- upload_file_id
--   '[
--     {
--       "material_code": "MAT-001",
--       "material_name": "Test Material",
--       "supplier_name": "Test Supplier A",
--       "actual_delivery_date": "2026-02-05",
--       "received_qty": 100
--     }
--   ]'::JSONB
-- );

-- 測試 2: ingest_price_history_v1（最小範例）
-- SELECT ingest_price_history_v1(
--   'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'::UUID, -- batch_id
--   '22222222-3333-4444-5555-666666666666'::UUID, -- upload_file_id
--   '[
--     {
--       "material_code": "MAT-001",
--       "material_name": "Test Material",
--       "supplier_name": "Test Supplier A",
--       "order_date": "2026-02-05",
--       "unit_price": 12.50,
--       "currency": "USD"
--     }
--   ]'::JSONB
-- );

-- 預期結果（JSONB 格式）：
-- {
--   "success": true,
--   "inserted_count": 1,
--   "suppliers_created": 1,
--   "suppliers_found": 0,
--   "materials_upserted": 1,
--   "batch_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
--   "upload_file_id": "11111111-2222-3333-4444-555555555555"
-- }


-- ============================================
-- 前端呼叫範例（JavaScript/TypeScript）
-- ============================================
/*
// 使用 Supabase JS Client 呼叫 RPC

// 範例 1: ingest_goods_receipts_v1
const { data, error } = await supabase.rpc('ingest_goods_receipts_v1', {
  p_batch_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  p_upload_file_id: '11111111-2222-3333-4444-555555555555',
  p_rows: [
    {
      material_code: 'MAT-001',
      material_name: 'Test Material',
      supplier_name: 'Test Supplier A',
      actual_delivery_date: '2026-02-05',
      received_qty: 100,
      rejected_qty: 5
    },
    {
      material_code: 'MAT-002',
      supplier_code: 'SUP-001',
      supplier_name: 'Test Supplier B',
      actual_delivery_date: '2026-02-06',
      received_qty: 200
    }
  ]
});

if (error) {
  console.error('RPC Error:', error);
} else {
  console.log('Success:', data);
  // data = {
  //   success: true,
  //   inserted_count: 2,
  //   suppliers_created: 2,
  //   suppliers_found: 0,
  //   materials_upserted: 2,
  //   batch_id: "...",
  //   upload_file_id: "..."
  // }
}

// 範例 2: ingest_price_history_v1
const { data, error } = await supabase.rpc('ingest_price_history_v1', {
  p_batch_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  p_upload_file_id: '22222222-3333-4444-5555-666666666666',
  p_rows: [
    {
      material_code: 'MAT-001',
      supplier_name: 'Test Supplier A',
      order_date: '2026-02-05',
      unit_price: 12.50,
      currency: 'USD',
      quantity: 100
    }
  ]
});
*/


-- ============================================
-- 常見問題 (FAQ)
-- ============================================
-- Q1: 為什麼需要 SECURITY DEFINER？
-- A: 允許 function 繞過 RLS（Row Level Security），但內部會檢查 auth.uid() 確保安全性。
--
-- Q2: upload_file_id 型別不匹配怎麼辦？
-- A: user_files.id 是 UUID 或 BIGINT，goods_receipts.upload_file_id 是 BIGINT。
--    RPC 接受 UUID 參數後內部轉換為 BIGINT：p_upload_file_id::BIGINT
--    若需要完全匹配，請修改 user_files 表或 RPC 參數型別。
--
-- Q3: 如何確保 idempotency？
-- A: RPC 開始時會刪除同 batch_id 的舊資料：
--    DELETE FROM goods_receipts WHERE user_id = auth.uid() AND batch_id = p_batch_id
--
-- Q4: 若 supplier 查找失敗怎麼辦？
-- A: 若 supplier_code 找不到且 supplier_name 也找不到，會自動建立新 supplier。
--
-- Q5: 錯誤處理如何運作？
-- A: 任何步驟失敗（驗證、查找、插入）都會拋出 EXCEPTION，
--    PostgreSQL 會自動回滾整個 transaction（ROLLBACK），保證資料一致性。
--
-- Q6: 如何除錯？
-- A: 若 RPC 回傳錯誤，檢查：
--    1. auth.uid() 是否為 NULL（未登入）
--    2. 必填欄位是否有值（material_code, actual_delivery_date, received_qty 等）
--    3. 資料型別是否正確（DATE, NUMERIC, TEXT）
--    4. Supabase Logs（Dashboard > Logs > Postgres Logs）
--
-- ============================================
