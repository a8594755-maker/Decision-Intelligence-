-- ============================================
-- Job System Hardening - Week 3: Staging Tables
-- ============================================
-- 创建日期: 2026-02-07
-- 说明: Staging 表用于数据一致性保证和流式写入

-- ============================================
-- 1. Component Demand Staging Table
-- ============================================
CREATE TABLE IF NOT EXISTS component_demand_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  forecast_run_id UUID NOT NULL,
  material_code TEXT NOT NULL,
  plant_id TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  demand_qty NUMERIC NOT NULL,
  uom TEXT DEFAULT 'pcs',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_cd_staging_user 
  ON component_demand_staging(user_id);
CREATE INDEX IF NOT EXISTS idx_cd_staging_batch 
  ON component_demand_staging(batch_id);
CREATE INDEX IF NOT EXISTS idx_cd_staging_run 
  ON component_demand_staging(forecast_run_id);

-- RLS 启用
ALTER TABLE component_demand_staging ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own staging data"
  ON component_demand_staging
  FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================
-- 2. Component Demand Trace Staging Table
-- ============================================
CREATE TABLE IF NOT EXISTS component_demand_trace_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  forecast_run_id UUID NOT NULL,
  fg_demand_id UUID,
  bom_edge_id UUID,
  qty_multiplier NUMERIC,
  bom_level INTEGER,
  trace_meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_cdt_staging_user 
  ON component_demand_trace_staging(user_id);
CREATE INDEX IF NOT EXISTS idx_cdt_staging_batch 
  ON component_demand_trace_staging(batch_id);
CREATE INDEX IF NOT EXISTS idx_cdt_staging_run 
  ON component_demand_trace_staging(forecast_run_id);

-- RLS 启用
ALTER TABLE component_demand_trace_staging ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own trace staging data"
  ON component_demand_trace_staging
  FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================
-- 3. Staging Management Functions
-- ============================================

-- 清理旧 staging 数据
CREATE OR REPLACE FUNCTION cleanup_staging_data(
  p_batch_id UUID,
  p_user_id UUID
) RETURNS INTEGER AS $$
DECLARE
  v_deleted_demand INTEGER := 0;
  v_deleted_trace INTEGER := 0;
BEGIN
  DELETE FROM component_demand_staging
  WHERE batch_id = p_batch_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted_demand = ROW_COUNT;
  
  DELETE FROM component_demand_trace_staging
  WHERE batch_id = p_batch_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted_trace = ROW_COUNT;
  
  RETURN v_deleted_demand + v_deleted_trace;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 从 staging 移动到正式表（事务性）
CREATE OR REPLACE FUNCTION commit_staging_to_production(
  p_batch_id UUID,
  p_user_id UUID,
  p_forecast_run_id UUID
) RETURNS JSON AS $$
DECLARE
  v_demand_count INTEGER := 0;
  v_trace_count INTEGER := 0;
BEGIN
  -- 先清理 production 中的旧数据（幂等性）
  DELETE FROM component_demand_trace
  WHERE forecast_run_id = p_forecast_run_id AND user_id = p_user_id;
  
  DELETE FROM component_demand
  WHERE forecast_run_id = p_forecast_run_id AND user_id = p_user_id;
  
  -- 插入 component_demand
  INSERT INTO component_demand (
    id, user_id, batch_id, forecast_run_id, 
    material_code, plant_id, time_bucket, demand_qty, uom
  )
  SELECT 
    gen_random_uuid(), user_id, batch_id, forecast_run_id,
    material_code, plant_id, time_bucket, demand_qty, uom
  FROM component_demand_staging
  WHERE batch_id = p_batch_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_demand_count = ROW_COUNT;
  
  -- 插入 component_demand_trace
  INSERT INTO component_demand_trace (
    id, user_id, batch_id, forecast_run_id,
    component_demand_id, fg_demand_id, bom_edge_id,
    qty_multiplier, bom_level, trace_meta
  )
  SELECT 
    gen_random_uuid(), 
    s.user_id, 
    s.batch_id, 
    s.forecast_run_id,
    cd.id, -- 关联到刚插入的 component_demand
    s.fg_demand_id,
    s.bom_edge_id,
    s.qty_multiplier,
    s.bom_level,
    s.trace_meta
  FROM component_demand_trace_staging s
  JOIN component_demand cd ON (
    cd.forecast_run_id = s.forecast_run_id 
    AND cd.material_code = s.trace_meta->>'component_material_code'
    AND cd.plant_id = s.trace_meta->>'plant_id'
    AND cd.time_bucket = s.trace_meta->>'time_bucket'
  )
  WHERE s.batch_id = p_batch_id 
    AND s.user_id = p_user_id
    AND cd.user_id = p_user_id;
  GET DIAGNOSTICS v_trace_count = ROW_COUNT;
  
  -- 清理 staging 数据
  PERFORM cleanup_staging_data(p_batch_id, p_user_id);
  
  RETURN json_build_object(
    'success', true,
    'demand_count', v_demand_count,
    'trace_count', v_trace_count,
    'batch_id', p_batch_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 流式插入 staging（供 Edge Function 使用）
CREATE OR REPLACE FUNCTION insert_staging_trace_chunk(
  p_traces JSONB
) RETURNS INTEGER AS $$
DECLARE
  v_trace JSONB;
  v_inserted INTEGER := 0;
BEGIN
  FOR v_trace IN SELECT * FROM jsonb_array_elements(p_traces)
  LOOP
    INSERT INTO component_demand_trace_staging (
      user_id, batch_id, forecast_run_id,
      fg_demand_id, bom_edge_id, qty_multiplier, bom_level, trace_meta
    ) VALUES (
      (v_trace->>'user_id')::UUID,
      (v_trace->>'batch_id')::UUID,
      (v_trace->>'forecast_run_id')::UUID,
      (v_trace->>'fg_demand_id')::UUID,
      (v_trace->>'bom_edge_id')::UUID,
      (v_trace->>'qty_multiplier')::NUMERIC,
      (v_trace->>'bom_level')::INTEGER,
      v_trace->'trace_meta'
    );
    v_inserted := v_inserted + 1;
  END LOOP;
  
  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE component_demand_staging IS 'Component demand staging table - for stream processing and data consistency';
COMMENT ON TABLE component_demand_trace_staging IS 'Component demand trace staging table - for stream processing';
COMMENT ON FUNCTION cleanup_staging_data IS '清理指定 batch 的 staging 数据';
COMMENT ON FUNCTION commit_staging_to_production IS '将 staging 数据原子性提交到生产表';
COMMENT ON FUNCTION insert_staging_trace_chunk IS '批量插入 trace 到 staging（流式写入）';

-- ============================================
-- 完成
-- ============================================
