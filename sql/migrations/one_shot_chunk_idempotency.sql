/**
 * One-shot Chunk Idempotency Support
 * 
 * 功能：
 * 1. 建立 ingest_sheet_runs 表（追蹤每次 sheet 匯入）
 * 2. 為各 facts 表新增 ingest_key 欄位（支援 idempotent delete）
 * 
 * 執行方式：
 * 1. 登入 Supabase Dashboard
 * 2. 前往 SQL Editor
 * 3. 複製此檔案內容
 * 4. 執行（可分段執行，若某些表已有欄位會自動跳過）
 */

-- =====================================================
-- Part 1: 建立 ingest_sheet_runs 表
-- =====================================================

-- Track each sheet ingest run (for idempotency and audit)
CREATE TABLE IF NOT EXISTS public.ingest_sheet_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES public.import_batches(id) ON DELETE CASCADE,
  sheet_name text NOT NULL,
  upload_type text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'running', -- 'running' | 'succeeded' | 'failed' | 'aborted'
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  total_rows integer,
  saved_rows integer,
  error_rows integer,
  chunks_completed integer DEFAULT 0,
  chunks_total integer DEFAULT 0,
  error jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  CONSTRAINT ingest_sheet_runs_idempotency_unique UNIQUE (user_id, idempotency_key)
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_ingest_sheet_runs_user_id ON public.ingest_sheet_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_ingest_sheet_runs_batch_id ON public.ingest_sheet_runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_ingest_sheet_runs_status ON public.ingest_sheet_runs(status);
CREATE INDEX IF NOT EXISTS idx_ingest_sheet_runs_idempotency ON public.ingest_sheet_runs(user_id, idempotency_key);

-- RLS Policies
ALTER TABLE public.ingest_sheet_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own sheet runs" ON public.ingest_sheet_runs;
CREATE POLICY "Users can view their own sheet runs"
  ON public.ingest_sheet_runs
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own sheet runs" ON public.ingest_sheet_runs;
CREATE POLICY "Users can insert their own sheet runs"
  ON public.ingest_sheet_runs
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own sheet runs" ON public.ingest_sheet_runs;
CREATE POLICY "Users can update their own sheet runs"
  ON public.ingest_sheet_runs
  FOR UPDATE
  USING (auth.uid() = user_id);

-- =====================================================
-- Part 2: 為各 facts 表新增 ingest_key 欄位
-- =====================================================

-- Add ingest_key to suppliers (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'suppliers' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.suppliers ADD COLUMN ingest_key text;
    CREATE INDEX idx_suppliers_ingest_key ON public.suppliers(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to materials (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'materials' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.materials ADD COLUMN ingest_key text;
    CREATE INDEX idx_materials_ingest_key ON public.materials(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to goods_receipts (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'goods_receipts' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.goods_receipts ADD COLUMN ingest_key text;
    CREATE INDEX idx_goods_receipts_ingest_key ON public.goods_receipts(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to price_history (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'price_history' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.price_history ADD COLUMN ingest_key text;
    CREATE INDEX idx_price_history_ingest_key ON public.price_history(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to bom_edges (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'bom_edges' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.bom_edges ADD COLUMN ingest_key text;
    CREATE INDEX idx_bom_edges_ingest_key ON public.bom_edges(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to demand_fg (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'demand_fg' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.demand_fg ADD COLUMN ingest_key text;
    CREATE INDEX idx_demand_fg_ingest_key ON public.demand_fg(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to po_open_lines (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'po_open_lines' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.po_open_lines ADD COLUMN ingest_key text;
    CREATE INDEX idx_po_open_lines_ingest_key ON public.po_open_lines(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to inventory_snapshots (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'inventory_snapshots' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.inventory_snapshots ADD COLUMN ingest_key text;
    CREATE INDEX idx_inventory_snapshots_ingest_key ON public.inventory_snapshots(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- Add ingest_key to fg_financials (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'fg_financials' 
    AND column_name = 'ingest_key'
  ) THEN
    ALTER TABLE public.fg_financials ADD COLUMN ingest_key text;
    CREATE INDEX idx_fg_financials_ingest_key ON public.fg_financials(user_id, ingest_key) WHERE ingest_key IS NOT NULL;
  END IF;
END $$;

-- =====================================================
-- Part 3: Helper Functions (Optional)
-- =====================================================

-- Function to check if migration is deployed
CREATE OR REPLACE FUNCTION public.check_ingest_key_support()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Check if ingest_sheet_runs table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = 'ingest_sheet_runs'
  ) THEN
    RETURN false;
  END IF;
  
  -- Check if at least one key table has ingest_key
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'bom_edges' 
    AND column_name = 'ingest_key'
  ) THEN
    RETURN false;
  END IF;
  
  RETURN true;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.check_ingest_key_support() TO authenticated;

-- =====================================================
-- Verification Queries
-- =====================================================

-- Verify ingest_sheet_runs table
-- SELECT * FROM public.ingest_sheet_runs ORDER BY created_at DESC LIMIT 10;

-- Verify ingest_key columns
-- SELECT 
--   table_name,
--   column_name,
--   data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND column_name = 'ingest_key'
-- ORDER BY table_name;

-- Check if migration is deployed
-- SELECT public.check_ingest_key_support();
