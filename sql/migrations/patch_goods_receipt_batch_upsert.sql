-- ============================================
-- Goods Receipt 批次 Upsert 所需的 DB Patch
-- ============================================
-- 執行日期: 2026-01-31
-- 目標: 為 suppliers 表新增唯一約束，支援批次 upsert
-- 目的: 解決 10,000 rows 上傳卡死問題（從 17,690 次 DB 請求降至 ~300 次）

-- ============================================
-- Part 1: 檢查並報告重複的 supplier 資料
-- ============================================

DO $$
DECLARE
  duplicate_by_code_count INT;
  duplicate_by_name_count INT;
BEGIN
  -- 檢查 supplier_code 重複（排除 NULL）
  SELECT COUNT(*) INTO duplicate_by_code_count
  FROM (
    SELECT user_id, supplier_code, COUNT(*) as cnt
    FROM suppliers
    WHERE supplier_code IS NOT NULL AND supplier_code != ''
    GROUP BY user_id, supplier_code
    HAVING COUNT(*) > 1
  ) AS duplicates;
  
  -- 檢查 supplier_name 重複（忽略大小寫和空格）
  SELECT COUNT(*) INTO duplicate_by_name_count
  FROM (
    SELECT 
      user_id, 
      LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g'))) as normalized_name,
      COUNT(*) as cnt
    FROM suppliers
    GROUP BY user_id, LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
    HAVING COUNT(*) > 1
  ) AS duplicates;
  
  IF duplicate_by_code_count > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  發現 % 組重複的 supplier_code！', duplicate_by_code_count;
    RAISE NOTICE '';
    RAISE NOTICE '=== 重複的 supplier_code 清單 ===';
    RAISE NOTICE '請檢查以下查詢結果：';
    RAISE NOTICE '';
  END IF;
  
  IF duplicate_by_name_count > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  發現 % 組重複的 supplier_name！', duplicate_by_name_count;
    RAISE NOTICE '';
    RAISE NOTICE '=== 重複的 supplier_name 清單 ===';
    RAISE NOTICE '請檢查以下查詢結果：';
    RAISE NOTICE '';
  END IF;
  
  IF duplicate_by_code_count = 0 AND duplicate_by_name_count = 0 THEN
    RAISE NOTICE '✅ 沒有發現重複資料，可以安全地新增唯一約束';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE '⚠️  警告：發現重複資料！';
    RAISE NOTICE '============================================';
    RAISE NOTICE '';
    RAISE NOTICE '請先執行以下查詢來檢視重複資料：';
    RAISE NOTICE '';
  END IF;
END $$;

-- 查詢重複的 supplier_code（如果有）
SELECT 
  user_id,
  supplier_code,
  COUNT(*) as duplicate_count,
  STRING_AGG(id::TEXT, ', ') as supplier_ids,
  STRING_AGG(supplier_name, ' | ') as supplier_names
FROM suppliers
WHERE supplier_code IS NOT NULL AND supplier_code != ''
GROUP BY user_id, supplier_code
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, user_id, supplier_code;

-- 查詢重複的 supplier_name（normalized，如果有）
SELECT 
  user_id,
  LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g'))) as normalized_name,
  COUNT(*) as duplicate_count,
  STRING_AGG(id::TEXT, ', ') as supplier_ids,
  STRING_AGG(supplier_name, ' | ') as original_names,
  STRING_AGG(supplier_code, ' | ') as supplier_codes
FROM suppliers
GROUP BY user_id, LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, user_id;

-- ============================================
-- 手動清理重複資料的範例 SQL（請根據上面的查詢結果調整）
-- ============================================
-- 注意：以下 SQL 被註釋，請根據實際情況取消註釋並執行

/*
-- 範例 1: 保留最新的 supplier（根據 created_at）
DELETE FROM suppliers 
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, supplier_code) id
  FROM suppliers
  WHERE supplier_code IS NOT NULL
  ORDER BY user_id, supplier_code, created_at DESC
);

-- 範例 2: 保留最新的 supplier（根據 normalized name）
DELETE FROM suppliers 
WHERE id NOT IN (
  SELECT DISTINCT ON (
    user_id, 
    LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
  ) id
  FROM suppliers
  ORDER BY 
    user_id, 
    LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g'))),
    created_at DESC
);

-- 範例 3: 手動合併特定的重複記錄
-- 假設要保留 ID='xxx'，刪除 ID='yyy'
UPDATE goods_receipts SET supplier_id = 'xxx' WHERE supplier_id = 'yyy';
UPDATE price_history SET supplier_id = 'xxx' WHERE supplier_id = 'yyy';
DELETE FROM suppliers WHERE id = 'yyy';
*/

-- ============================================
-- Part 2: 新增 supplier_name_norm 欄位
-- ============================================
-- 用途：儲存 normalized 的 supplier_name，供唯一約束使用

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS supplier_name_norm TEXT;

-- 為現有資料填充 supplier_name_norm
UPDATE suppliers
SET supplier_name_norm = LOWER(TRIM(REGEXP_REPLACE(supplier_name, '\s+', ' ', 'g')))
WHERE supplier_name_norm IS NULL;

-- 新增註釋
COMMENT ON COLUMN suppliers.supplier_name_norm IS 'Normalized supplier name (lowercase, trimmed, single spaces) for uniqueness constraint';

-- ============================================
-- Part 3: 建立唯一約束
-- ============================================

-- 策略：優先使用 supplier_code（如果有），否則使用 supplier_name_norm
-- 方案：建立兩個獨立的唯一約束

-- 唯一約束 1: user_id + supplier_code（排除 NULL）
DO $$
BEGIN
  -- 檢查約束是否已存在
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'uq_suppliers_user_code'
  ) THEN
    -- 建立部分唯一索引（只對非 NULL 的 supplier_code）
    CREATE UNIQUE INDEX uq_suppliers_user_code
      ON suppliers(user_id, supplier_code)
      WHERE supplier_code IS NOT NULL AND supplier_code != '';
    
    RAISE NOTICE '✅ 已建立唯一約束: uq_suppliers_user_code';
  ELSE
    RAISE NOTICE '✓ 唯一約束 uq_suppliers_user_code 已存在';
  END IF;
END $$;

-- 唯一約束 2: user_id + supplier_name_norm
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'uq_suppliers_user_name_norm'
  ) THEN
    ALTER TABLE suppliers
      ADD CONSTRAINT uq_suppliers_user_name_norm
      UNIQUE (user_id, supplier_name_norm);
    
    RAISE NOTICE '✅ 已建立唯一約束: uq_suppliers_user_name_norm';
  ELSE
    RAISE NOTICE '✓ 唯一約束 uq_suppliers_user_name_norm 已存在';
  END IF;
END $$;

-- ============================================
-- Part 4: 建立複合索引（優化查詢效能）
-- ============================================

CREATE INDEX IF NOT EXISTS idx_suppliers_user_name_norm
  ON suppliers(user_id, supplier_name_norm);

CREATE INDEX IF NOT EXISTS idx_suppliers_user_code_not_null
  ON suppliers(user_id, supplier_code)
  WHERE supplier_code IS NOT NULL;

-- ============================================
-- Part 5: 建立觸發器（自動維護 supplier_name_norm）
-- ============================================

CREATE OR REPLACE FUNCTION normalize_supplier_name()
RETURNS TRIGGER AS $$
BEGIN
  NEW.supplier_name_norm = LOWER(TRIM(REGEXP_REPLACE(NEW.supplier_name, '\s+', ' ', 'g')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_supplier_name ON suppliers;
CREATE TRIGGER trg_normalize_supplier_name
  BEFORE INSERT OR UPDATE OF supplier_name ON suppliers
  FOR EACH ROW
  EXECUTE FUNCTION normalize_supplier_name();

COMMENT ON FUNCTION normalize_supplier_name() IS 'Trigger function: auto-normalize supplier_name to supplier_name_norm';

-- ============================================
-- Part 6: 為 goods_receipts 新增 batch_id 支援（如果還沒有）
-- ============================================

ALTER TABLE goods_receipts
  ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_goods_receipts_batch_id
  ON goods_receipts(batch_id);

COMMENT ON COLUMN goods_receipts.batch_id IS '批次 ID - 用於追溯匯入來源和批次撤銷';

-- 同樣為 suppliers 和 materials 新增 batch_id
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS batch_id UUID;

ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_suppliers_batch_id
  ON suppliers(batch_id);

CREATE INDEX IF NOT EXISTS idx_materials_batch_id
  ON materials(batch_id);

-- ============================================
-- Part 7: 驗證結果
-- ============================================

DO $$
DECLARE
  supplier_code_constraint_exists BOOLEAN;
  supplier_name_constraint_exists BOOLEAN;
  material_constraint_exists BOOLEAN;
BEGIN
  -- 檢查 suppliers 唯一約束
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'uq_suppliers_user_code'
  ) INTO supplier_code_constraint_exists;
  
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'uq_suppliers_user_name_norm'
  ) INTO supplier_name_constraint_exists;
  
  -- 檢查 materials 唯一約束
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conrelid = 'materials'::regclass 
    AND contype = 'u'
    AND conkey = ARRAY[
      (SELECT attnum FROM pg_attribute 
       WHERE attrelid = 'materials'::regclass AND attname = 'user_id'),
      (SELECT attnum FROM pg_attribute 
       WHERE attrelid = 'materials'::regclass AND attname = 'material_code')
    ]
  ) INTO material_constraint_exists;
  
  RAISE NOTICE '';
  RAISE NOTICE '============================================';
  RAISE NOTICE '✅ Patch 執行完成！';
  RAISE NOTICE '============================================';
  RAISE NOTICE '';
  RAISE NOTICE '驗證結果：';
  RAISE NOTICE '  suppliers (code):      %', CASE WHEN supplier_code_constraint_exists THEN '✅' ELSE '❌' END;
  RAISE NOTICE '  suppliers (name):      %', CASE WHEN supplier_name_constraint_exists THEN '✅' ELSE '❌' END;
  RAISE NOTICE '  materials:             %', CASE WHEN material_constraint_exists THEN '✅' ELSE '❌' END;
  RAISE NOTICE '';
  RAISE NOTICE '現在可以使用批次 upsert！';
  RAISE NOTICE '';
  RAISE NOTICE '測試 upsert（suppliers）：';
  RAISE NOTICE '  INSERT INTO suppliers (user_id, supplier_name, supplier_code)';
  RAISE NOTICE '  VALUES (auth.uid(), ''Test Supplier'', ''TEST-001'')';
  RAISE NOTICE '  ON CONFLICT ON CONSTRAINT uq_suppliers_user_name_norm';
  RAISE NOTICE '  DO UPDATE SET supplier_code = EXCLUDED.supplier_code;';
  RAISE NOTICE '';
  RAISE NOTICE '測試 upsert（materials）：';
  RAISE NOTICE '  INSERT INTO materials (user_id, material_code, material_name)';
  RAISE NOTICE '  VALUES (auth.uid(), ''MAT-001'', ''Test Material'')';
  RAISE NOTICE '  ON CONFLICT (user_id, material_code)';
  RAISE NOTICE '  DO UPDATE SET material_name = EXCLUDED.material_name;';
  RAISE NOTICE '';
  RAISE NOTICE '============================================';
END $$;
