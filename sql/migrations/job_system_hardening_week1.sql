-- ============================================
-- Job System Hardening - Week 1 Schema Changes
-- ============================================
-- 创建日期: 2026-02-07
-- 说明: 新增 job_key, heartbeat_at, 分片支持, progress 追踪

-- ============================================
-- 1. import_batches 新增字段
-- ============================================
ALTER TABLE import_batches 
  ADD COLUMN IF NOT EXISTS job_key TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES import_batches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS shard_index INTEGER,
  ADD COLUMN IF NOT EXISTS total_shards INTEGER,
  ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'bom_explosion',
  ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  ADD COLUMN IF NOT EXISTS result_summary JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- 扩展 status 约束以支持更多状态
ALTER TABLE import_batches 
  DROP CONSTRAINT IF EXISTS import_batches_status_check,
  ADD CONSTRAINT import_batches_status_check 
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'undone', 'canceled'));

-- ============================================
-- 2. forecast_runs 新增字段
-- ============================================
ALTER TABLE forecast_runs 
  ADD COLUMN IF NOT EXISTS job_key TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- ============================================
-- 3. 关键索引 - 防重复运行 + Zombie 检测
-- ============================================

-- 唯一索引：同一用户、同一 job_key、running/pending 状态只能有一个
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_running_job 
  ON import_batches (user_id, job_key) 
  WHERE status IN ('pending', 'running') AND job_key IS NOT NULL;

-- Zombie 检测索引
CREATE INDEX IF NOT EXISTS idx_zombie_check 
  ON import_batches (status, heartbeat_at) 
  WHERE status = 'running';

-- Job Key 查询索引
CREATE INDEX IF NOT EXISTS idx_job_key_lookup 
  ON import_batches (user_id, job_key, status);

-- 父子 Job 查询索引
CREATE INDEX IF NOT EXISTS idx_parent_job 
  ON import_batches (parent_job_id) 
  WHERE parent_job_id IS NOT NULL;

-- ============================================
-- 4. 新增函数：检测并清理 Zombie Jobs
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_zombie_jobs(
  p_zombie_threshold_minutes INTEGER DEFAULT 2
) RETURNS TABLE (
  cleaned_count INTEGER,
  zombie_ids UUID[]
) AS $$
DECLARE
  v_threshold TIMESTAMPTZ;
  v_count INTEGER := 0;
  v_ids UUID[] := '{}';
BEGIN
  v_threshold := NOW() - (p_zombie_threshold_minutes || ' minutes')::INTERVAL;
  
  -- 找出 Zombie Jobs
  SELECT array_agg(id), COUNT(*) INTO v_ids, v_count
  FROM import_batches
  WHERE status = 'running'
    AND (heartbeat_at IS NULL OR heartbeat_at < v_threshold);
  
  -- 标记为 failed
  IF v_count > 0 THEN
    UPDATE import_batches
    SET status = 'failed',
        error_message = 'Zombie job detected: no heartbeat for ' || p_zombie_threshold_minutes || ' minutes',
        failed_at = NOW(),
        result_summary = jsonb_set(
          COALESCE(result_summary, '{}'::jsonb),
          '{zombie_detected}',
          'true'::jsonb
        )
    WHERE id = ANY(v_ids);
    
    -- 同时更新关联的 forecast_runs
    UPDATE forecast_runs
    SET status = 'failed',
        failed_at = NOW()
    WHERE id IN (
      SELECT (metadata->>'forecast_run_id')::UUID
      FROM import_batches
      WHERE id = ANY(v_ids)
    );
  END IF;
  
  RETURN QUERY SELECT v_count, v_ids;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cleanup_zombie_jobs IS '清理超过指定时间没有心跳的 Zombie Jobs';

-- ============================================
-- 5. 新增函数：更新 Job 进度
-- ============================================
CREATE OR REPLACE FUNCTION update_job_progress(
  p_batch_id UUID,
  p_progress INTEGER,
  p_result_summary JSONB DEFAULT NULL
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE import_batches
  SET progress = p_progress,
      heartbeat_at = NOW(),
      result_summary = CASE 
        WHEN p_result_summary IS NOT NULL 
        THEN result_summary || p_result_summary
        ELSE result_summary
      END
  WHERE id = p_batch_id;
  
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION update_job_progress IS '更新 Job 进度和心跳时间';

-- ============================================
-- 6. 新增函数：获取或创建 Job (幂等性支持)
-- ============================================
CREATE OR REPLACE FUNCTION get_or_create_job(
  p_user_id UUID,
  p_job_key TEXT,
  p_job_type TEXT,
  p_request_params JSONB,
  p_filename TEXT DEFAULT 'Job',
  p_force_new BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  batch_id UUID,
  forecast_run_id UUID,
  status TEXT,
  is_new BOOLEAN,
  progress INTEGER,
  result_summary JSONB
) AS $$
DECLARE
  v_existing import_batches%ROWTYPE;
  v_new_batch_id UUID := gen_random_uuid();
  v_new_run_id UUID := gen_random_uuid();
BEGIN
  -- 先清理 zombie
  PERFORM cleanup_zombie_jobs(2);
  
  -- 查找同 job_key 的 job
  SELECT * INTO v_existing
  FROM import_batches
  WHERE user_id = p_user_id 
    AND job_key = p_job_key
    AND status IN ('pending', 'running', 'completed')
  ORDER BY 
    CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
    created_at DESC
  LIMIT 1;
  
  -- 如果存在 running/pending，返回 429 信号
  IF v_existing.id IS NOT NULL AND v_existing.status IN ('running', 'pending') THEN
    RETURN QUERY SELECT 
      v_existing.id,
      (v_existing.metadata->>'forecast_run_id')::UUID,
      v_existing.status,
      FALSE,
      v_existing.progress,
      v_existing.result_summary;
    RETURN;
  END IF;
  
  -- 如果存在 completed 且不要求新 run，返回复用信号
  IF v_existing.id IS NOT NULL AND v_existing.status = 'completed' AND NOT p_force_new THEN
    RETURN QUERY SELECT 
      v_existing.id,
      (v_existing.metadata->>'forecast_run_id')::UUID,
      'completed'::TEXT,
      FALSE,
      v_existing.progress,
      v_existing.result_summary;
    RETURN;
  END IF;
  
  -- 创建新的 forecast_run
  INSERT INTO forecast_runs (
    id, user_id, status, job_key, scenario_name, 
    parameters, started_at, heartbeat_at
  ) VALUES (
    v_new_run_id, p_user_id, 'running', p_job_key,
    p_request_params->>'scenario_name',
    p_request_params,
    NOW(),
    NOW()
  );
  
  -- 创建新的 import_batch
  INSERT INTO import_batches (
    id, user_id, job_key, job_type, status, filename,
    upload_type, target_table, progress, started_at, 
    heartbeat_at, metadata
  ) VALUES (
    v_new_batch_id, p_user_id, p_job_key, p_job_type, 'running',
    p_filename, 'bom_explosion', 'component_demand', 5,
    NOW(), NOW(),
    jsonb_build_object(
      'forecast_run_id', v_new_run_id,
      'request_params', p_request_params
    )
  );
  
  RETURN QUERY SELECT 
    v_new_batch_id,
    v_new_run_id,
    'running'::TEXT,
    TRUE,
    5,
    '{}'::JSONB;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION get_or_create_job IS '幂等性 Job 创建：同参数返回现有 Job，避免重复执行';

-- ============================================
-- 7. 注释
-- ============================================
COMMENT ON COLUMN import_batches.job_key IS 'Job 唯一标识，用于幂等性检查';
COMMENT ON COLUMN import_batches.heartbeat_at IS '最后一次心跳时间，用于检测 Zombie Job';
COMMENT ON COLUMN import_batches.parent_job_id IS '父 Job ID，用于分片任务';
COMMENT ON COLUMN import_batches.shard_index IS '当前分片索引';
COMMENT ON COLUMN import_batches.total_shards IS '总分片数';
COMMENT ON COLUMN import_batches.job_type IS 'Job 类型：bom_explosion, risk_calc 等';
COMMENT ON COLUMN import_batches.progress IS '进度 0-100';
COMMENT ON COLUMN import_batches.result_summary IS '执行结果摘要';

-- ============================================
-- 完成
-- ============================================
