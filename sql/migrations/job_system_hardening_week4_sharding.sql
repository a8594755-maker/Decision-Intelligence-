-- ============================================
-- Job System Hardening - Week 4: Sharding Support
-- ============================================
-- 创建日期: 2026-02-07
-- 说明: 分片架构支持，用于处理超大数据集的 BOM Explosion

-- ============================================
-- 1. 分片管理函数
-- ============================================

-- 创建分片任务
CREATE OR REPLACE FUNCTION create_sharded_jobs(
  p_user_id UUID,
  p_job_key TEXT,
  p_total_shards INTEGER,
  p_request_params JSONB,
  p_time_buckets TEXT[]
) RETURNS TABLE (
  parent_job_id UUID,
  shard_jobs JSONB
) AS $$
DECLARE
  v_parent_id UUID := gen_random_uuid();
  v_shard_jobs JSONB := '[]'::JSONB;
  v_shard_id UUID;
  v_shard_buckets TEXT[];
  v_start_idx INTEGER;
  v_end_idx INTEGER;
  v_buckets_per_shard INTEGER;
  i INTEGER;
BEGIN
  -- 创建父 job
  INSERT INTO import_batches (
    id, user_id, job_key, job_type, status, filename,
    upload_type, target_table, total_shards, progress,
    metadata
  ) VALUES (
    v_parent_id, p_user_id, p_job_key || '_parent', 'bom_explosion_parent', 'running',
    'BOM Explosion Parent - ' || p_total_shards || ' shards', 
    'bom_explosion', 'component_demand', p_total_shards, 0,
    jsonb_build_object(
      'total_shards', p_total_shards,
      'request_params', p_request_params,
      'all_time_buckets', p_time_buckets
    )
  );
  
  -- 计算每个分片的 bucket 数量
  v_buckets_per_shard := CEIL(array_length(p_time_buckets, 1)::FLOAT / p_total_shards);
  
  -- 创建子 shards
  FOR i IN 0..(p_total_shards - 1) LOOP
    v_start_idx := i * v_buckets_per_shard + 1;
    v_end_idx := LEAST((i + 1) * v_buckets_per_shard, array_length(p_time_buckets, 1));
    
    -- 获取该 shard 的 buckets
    SELECT array_agg(p_time_buckets[j]) INTO v_shard_buckets
    FROM generate_series(v_start_idx, v_end_idx) AS j;
    
    v_shard_id := gen_random_uuid();
    
    -- 创建 shard job
    INSERT INTO import_batches (
      id, user_id, parent_job_id, shard_index, total_shards, job_key, job_type, status, filename,
      upload_type, target_table, progress, metadata
    ) VALUES (
      v_shard_id, p_user_id, v_parent_id, i, p_total_shards, 
      p_job_key || '_shard_' || i, 'bom_explosion_shard', 'pending',
      'BOM Explosion Shard ' || i || '/' || p_total_shards,
      'bom_explosion', 'component_demand', 0,
      jsonb_build_object(
        'shard_index', i,
        'time_buckets', v_shard_buckets,
        'parent_job_id', v_parent_id,
        'request_params', p_request_params
      )
    );
    
    v_shard_jobs := v_shard_jobs || jsonb_build_object(
      'shard_id', v_shard_id,
      'shard_index', i,
      'time_buckets', v_shard_buckets
    );
  END LOOP;
  
  RETURN QUERY SELECT v_parent_id, v_shard_jobs;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 检查父 job 的所有 shards 是否完成
CREATE OR REPLACE FUNCTION check_parent_job_completion(
  p_parent_job_id UUID
) RETURNS JSON AS $$
DECLARE
  v_total_shards INTEGER;
  v_completed_shards INTEGER;
  v_failed_shards INTEGER;
  v_result JSON;
BEGIN
  SELECT total_shards INTO v_total_shards
  FROM import_batches
  WHERE id = p_parent_job_id;
  
  SELECT 
    COUNT(*) FILTER (WHERE status = 'completed'),
    COUNT(*) FILTER (WHERE status = 'failed')
  INTO v_completed_shards, v_failed_shards
  FROM import_batches
  WHERE parent_job_id = p_parent_job_id;
  
  v_result := json_build_object(
    'parent_job_id', p_parent_job_id,
    'total_shards', v_total_shards,
    'completed_shards', v_completed_shards,
    'failed_shards', v_failed_shards,
    'all_completed', v_completed_shards = v_total_shards,
    'has_failures', v_failed_shards > 0
  );
  
  -- 如果所有 shards 完成，更新父 job
  IF v_completed_shards = v_total_shards THEN
    UPDATE import_batches
    SET status = 'completed',
        progress = 100,
        completed_at = NOW(),
        result_summary = jsonb_build_object(
          'all_shards_completed', true,
          'completed_shards', v_completed_shards
        )
    WHERE id = p_parent_job_id;
  END IF;
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 合并分片结果
CREATE OR REPLACE FUNCTION merge_shard_results(
  p_parent_job_id UUID,
  p_user_id UUID
) RETURNS JSON AS $$
DECLARE
  v_total_demand INTEGER := 0;
  v_total_trace INTEGER := 0;
  v_shard_summaries JSONB := '[]'::JSONB;
BEGIN
  -- 收集所有 shard 的结果
  SELECT 
    COALESCE(SUM((result_summary->>'component_demand_count')::INTEGER), 0),
    COALESCE(SUM((result_summary->>'component_demand_trace_count')::INTEGER), 0),
    jsonb_agg(result_summary)
  INTO v_total_demand, v_total_trace, v_shard_summaries
  FROM import_batches
  WHERE parent_job_id = p_parent_job_id AND user_id = p_user_id;
  
  -- 更新父 job 的汇总结果
  UPDATE import_batches
  SET result_summary = jsonb_build_object(
    'merged', true,
    'total_component_demand', v_total_demand,
    'total_trace_count', v_total_trace,
    'shard_summaries', v_shard_summaries
  )
  WHERE id = p_parent_job_id;
  
  RETURN json_build_object(
    'success', true,
    'parent_job_id', p_parent_job_id,
    'total_component_demand', v_total_demand,
    'total_trace_count', v_total_trace
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION create_sharded_jobs IS '创建分片的 BOM Explosion jobs，按 time_bucket 分片';
COMMENT ON FUNCTION check_parent_job_completion IS '检查父 job 的所有 shards 是否完成';
COMMENT ON FUNCTION merge_shard_results IS '合并所有分片的结果到父 job';

-- ============================================
-- 2. 分片查询视图
-- ============================================
CREATE OR REPLACE VIEW v_sharded_job_status AS
SELECT 
  p.id as parent_job_id,
  p.user_id,
  p.job_key as parent_job_key,
  p.total_shards,
  p.status as parent_status,
  p.progress as parent_progress,
  jsonb_agg(
    jsonb_build_object(
      'shard_id', s.id,
      'shard_index', s.shard_index,
      'status', s.status,
      'progress', s.progress,
      'time_buckets', s.metadata->'time_buckets'
    )
  ) as shards,
  COUNT(*) FILTER (WHERE s.status = 'completed') as completed_count,
  COUNT(*) FILTER (WHERE s.status = 'failed') as failed_count,
  COUNT(*) FILTER (WHERE s.status = 'running') as running_count
FROM import_batches p
LEFT JOIN import_batches s ON s.parent_job_id = p.id
WHERE p.job_type = 'bom_explosion_parent'
GROUP BY p.id, p.user_id, p.job_key, p.total_shards, p.status, p.progress;

COMMENT ON VIEW v_sharded_job_status IS '分片 job 状态汇总视图';

-- ============================================
-- 完成
-- ============================================
