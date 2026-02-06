-- ============================================================
-- Milestone 4: Supply Forecast Tables
-- WP1: DB Schema (supplier_supply_stats, supply_forecast_po, 
--      supply_forecast_inbound, supply_forecast_inbound_trace)
-- ============================================================

-- 1. supplier_supply_stats: 每个 run 的 supplier 表现统计
CREATE TABLE IF NOT EXISTS supplier_supply_stats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    forecast_run_id uuid NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    supplier_id text NOT NULL,
    plant_id text NULL,
    sample_size int NOT NULL,
    lead_time_p50_days numeric NULL,
    lead_time_p90_days numeric NULL,
    on_time_rate numeric NULL CHECK (on_time_rate >= 0 AND on_time_rate <= 1),
    short_ship_rate numeric NULL CHECK (short_ship_rate >= 0 AND short_ship_rate <= 1),
    model_version text NOT NULL,
    metrics jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
    
    -- Note: Unique constraint with expression requires a unique index (see below)
);

-- Create unique index for run-scoped supplier stats (instead of constraint with expression)
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_supply_stats_key 
ON supplier_supply_stats (user_id, forecast_run_id, supplier_id, COALESCE(plant_id, ''));

-- 2. supply_forecast_po: 每张 open PO line 的 forecast 结果
CREATE TABLE IF NOT EXISTS supply_forecast_po (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    forecast_run_id uuid NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    po_line_id text NOT NULL,
    po_id text NULL,
    supplier_id text NULL,
    material_code text NOT NULL,
    plant_id text NOT NULL,
    open_qty numeric NOT NULL,
    promised_date date NULL,
    arrival_p50_bucket text NOT NULL,
    arrival_p90_bucket text NULL,
    delay_prob numeric NULL CHECK (delay_prob >= 0 AND delay_prob <= 1),
    short_ship_prob numeric NULL CHECK (short_ship_prob >= 0 AND short_ship_prob <= 1),
    model_version text NOT NULL,
    metrics jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    
    -- Unique constraint: run-scoped
    CONSTRAINT uq_supply_forecast_po_key UNIQUE (user_id, forecast_run_id, po_line_id)
);

-- 3. supply_forecast_inbound: 聚合到 bucket，给 Inventory/Risk 直接吃
CREATE TABLE IF NOT EXISTS supply_forecast_inbound (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    forecast_run_id uuid NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    material_code text NOT NULL,
    plant_id text NOT NULL,
    time_bucket text NOT NULL,
    p50_qty numeric NOT NULL DEFAULT 0,
    p90_qty numeric NULL,
    model_version text NOT NULL,
    metrics jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    
    -- Unique constraint: run-scoped
    CONSTRAINT uq_supply_forecast_inbound_key UNIQUE (user_id, forecast_run_id, material_code, plant_id, time_bucket)
);

-- 4. supply_forecast_inbound_trace: explainability (bucket inbound 是哪几张 PO 贡献的)
CREATE TABLE IF NOT EXISTS supply_forecast_inbound_trace (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    forecast_run_id uuid NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    supply_forecast_inbound_id uuid NOT NULL REFERENCES supply_forecast_inbound(id) ON DELETE CASCADE,
    po_line_id text NOT NULL,
    contrib_qty numeric NOT NULL,
    arrival_p50_bucket text NOT NULL,
    arrival_p90_bucket text NULL,
    delay_prob numeric NULL,
    supplier_stats_id uuid NULL REFERENCES supplier_supply_stats(id) ON DELETE SET NULL,
    trace_meta jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now()
);

-- ============================================================
-- Indexes for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_supplier_supply_stats_run ON supplier_supply_stats(user_id, forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_supplier_supply_stats_supplier ON supplier_supply_stats(user_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_supply_forecast_po_run ON supply_forecast_po(user_id, forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_supply_forecast_po_material ON supply_forecast_po(user_id, material_code, plant_id);
CREATE INDEX IF NOT EXISTS idx_supply_forecast_inbound_run ON supply_forecast_inbound(user_id, forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_supply_forecast_inbound_key ON supply_forecast_inbound(user_id, material_code, plant_id, time_bucket);
CREATE INDEX IF NOT EXISTS idx_supply_forecast_inbound_trace_run ON supply_forecast_inbound_trace(user_id, forecast_run_id);
CREATE INDEX IF NOT EXISTS idx_supply_forecast_inbound_trace_inbound ON supply_forecast_inbound_trace(supply_forecast_inbound_id);

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
ALTER TABLE supplier_supply_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_forecast_po ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_forecast_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_forecast_inbound_trace ENABLE ROW LEVEL SECURITY;

-- RLS Policies for supplier_supply_stats
CREATE POLICY "Users can view own supplier_supply_stats"
    ON supplier_supply_stats FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own supplier_supply_stats"
    ON supplier_supply_stats FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own supplier_supply_stats"
    ON supplier_supply_stats FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own supplier_supply_stats"
    ON supplier_supply_stats FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- RLS Policies for supply_forecast_po
CREATE POLICY "Users can view own supply_forecast_po"
    ON supply_forecast_po FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own supply_forecast_po"
    ON supply_forecast_po FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own supply_forecast_po"
    ON supply_forecast_po FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own supply_forecast_po"
    ON supply_forecast_po FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- RLS Policies for supply_forecast_inbound
CREATE POLICY "Users can view own supply_forecast_inbound"
    ON supply_forecast_inbound FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own supply_forecast_inbound"
    ON supply_forecast_inbound FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own supply_forecast_inbound"
    ON supply_forecast_inbound FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own supply_forecast_inbound"
    ON supply_forecast_inbound FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- RLS Policies for supply_forecast_inbound_trace
CREATE POLICY "Users can view own supply_forecast_inbound_trace"
    ON supply_forecast_inbound_trace FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own supply_forecast_inbound_trace"
    ON supply_forecast_inbound_trace FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own supply_forecast_inbound_trace"
    ON supply_forecast_inbound_trace FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- ============================================================
-- Comments for documentation
-- ============================================================
COMMENT ON TABLE supplier_supply_stats IS 'Milestone 4: 每个 supply forecast run 的 supplier 表现统计（lead time, on-time rate 等）';
COMMENT ON TABLE supply_forecast_po IS 'Milestone 4: 每张 open PO line 的 forecast 结果（arrival bucket, delay prob 等）';
COMMENT ON TABLE supply_forecast_inbound IS 'Milestone 4: 聚合到 material|plant|bucket 的 inbound forecast（p50/p90 qty）';
COMMENT ON TABLE supply_forecast_inbound_trace IS 'Milestone 4: explainability - bucket inbound 是哪几张 PO 贡献的';
