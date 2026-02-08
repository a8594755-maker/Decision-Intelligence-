-- ============================================
-- Logic Control Center - Database Schema
-- Phase 0: Foundation Tables
-- ============================================
-- 创建日期: 2026-02-07
-- 说明: 治理系统核心表结构 - logic_versions, logic_change_log, logic_test_runs

-- ============================================
-- 1. logic_versions 表 - 配置版本治理核心
-- ============================================
CREATE TABLE IF NOT EXISTS logic_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- 逻辑标识与范围
    logic_id TEXT NOT NULL,                              -- 'bom_explosion', 'risk_score'
    scope_level TEXT NOT NULL CHECK (scope_level IN ('GLOBAL', 'PLANT')),
    scope_id TEXT NULL,                                  -- plant_id 当 scope_level='PLANT'
    
    -- 版本生命周期状态
    status TEXT NOT NULL DEFAULT 'draft' 
        CHECK (status IN ('draft', 'pending_approval', 'approved', 'published', 'archived')),
    
    -- 生效时间范围
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to TIMESTAMPTZ NULL,
    
    -- 配置内容 (JSON Schema v1)
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    
    -- 审计字段
    created_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    submitted_by UUID NULL REFERENCES auth.users(id),
    submitted_at TIMESTAMPTZ NULL,
    submit_comment TEXT NULL,
    
    approved_by UUID NULL REFERENCES auth.users(id),
    approved_at TIMESTAMPTZ NULL,
    approval_comment TEXT NULL,
    
    published_by UUID NULL REFERENCES auth.users(id),
    published_at TIMESTAMPTZ NULL,
    publish_comment TEXT NULL,
    
    archived_by UUID NULL REFERENCES auth.users(id),
    archived_at TIMESTAMPTZ NULL,
    archive_reason TEXT NULL
);

-- 注释
COMMENT ON TABLE logic_versions IS '可配置逻辑版本治理表，存储 BOM Explosion 等计算逻辑的配置版本';
COMMENT ON COLUMN logic_versions.logic_id IS '逻辑标识，如 bom_explosion, risk_score';
COMMENT ON COLUMN logic_versions.scope_level IS '范围层级：GLOBAL 全局配置，PLANT 工厂特定配置';
COMMENT ON COLUMN logic_versions.scope_id IS '范围ID，当 scope_level=PLANT 时为 plant_id';
COMMENT ON COLUMN logic_versions.status IS '版本状态：draft/pending_approval/approved/published/archived';
COMMENT ON COLUMN logic_versions.config_json IS '配置内容，遵循 Logic Schema v1 结构';
COMMENT ON COLUMN logic_versions.schema_version IS '配置 schema 版本，用于兼容性检查';

-- ============================================
-- 2. logic_versions 索引
-- ============================================

-- 主查询索引：查找特定逻辑和范围的版本
CREATE INDEX IF NOT EXISTS idx_logic_versions_lookup 
    ON logic_versions (logic_id, scope_level, scope_id, status, effective_from);

-- 已发布版本查询（部分索引）
CREATE INDEX IF NOT EXISTS idx_logic_versions_published 
    ON logic_versions (logic_id, scope_level, scope_id, effective_from)
    WHERE status = 'published';

-- 草稿版本查询
CREATE INDEX IF NOT EXISTS idx_logic_versions_drafts 
    ON logic_versions (logic_id, scope_level, scope_id, created_by)
    WHERE status = 'draft';

-- 待审批版本查询
CREATE INDEX IF NOT EXISTS idx_logic_versions_pending 
    ON logic_versions (logic_id, status, submitted_at)
    WHERE status = 'pending_approval';

-- 创建者索引
CREATE INDEX IF NOT EXISTS idx_logic_versions_creator 
    ON logic_versions (created_by, created_at DESC);

-- ============================================
-- 3. logic_versions 约束
-- ============================================

-- 同一逻辑+范围在同一时间只能有一个 published 版本
-- 注意：不包含时间检查，因为 NOW() 不是 IMMUTABLE
-- 时间冲突检查由应用程序逻辑处理
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_published_logic_version
    ON logic_versions (logic_id, scope_level, COALESCE(scope_id, ''))
    WHERE status = 'published';

-- 工厂级配置必须有 scope_id
ALTER TABLE logic_versions 
    ADD CONSTRAINT chk_plant_scope_requires_id 
    CHECK (scope_level != 'PLANT' OR scope_id IS NOT NULL);

-- 状态转换有效性检查
ALTER TABLE logic_versions
    ADD CONSTRAINT chk_status_transition_valid
    CHECK (
        (status = 'draft' AND submitted_at IS NULL) OR
        (status = 'pending_approval' AND submitted_at IS NOT NULL) OR
        (status = 'approved' AND approved_at IS NOT NULL) OR
        (status = 'published' AND published_at IS NOT NULL) OR
        (status = 'archived')
    );

-- ============================================
-- 4. logic_change_log 表 - 变更审计日志
-- ============================================
CREATE TABLE IF NOT EXISTS logic_change_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    logic_version_id UUID NOT NULL REFERENCES logic_versions(id) ON DELETE CASCADE,
    
    actor_id UUID NOT NULL REFERENCES auth.users(id),
    actor_role TEXT NULL,  -- 记录操作时的角色
    
    action TEXT NOT NULL 
        CHECK (action IN ('create', 'edit', 'submit', 'approve', 'reject', 'publish', 'rollback', 'archive')),
    
    diff_json JSONB NULL,  -- 变更内容对比
    comment TEXT NULL,     -- 用户填写的变更说明
    
    -- 变更前后状态
    from_status TEXT NULL,
    to_status TEXT NOT NULL,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE logic_change_log IS '逻辑版本变更审计日志，记录谁何时做了什么变更';
COMMENT ON COLUMN logic_change_log.diff_json IS 'JSON 格式的变更对比，包含修改的字段前后值';

-- 变更日志索引
CREATE INDEX IF NOT EXISTS idx_change_log_version 
    ON logic_change_log (logic_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_change_log_actor 
    ON logic_change_log (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_change_log_action 
    ON logic_change_log (action, created_at DESC);

-- ============================================
-- 5. logic_test_runs 表 - 沙盒测试运行记录
-- ============================================
CREATE TABLE IF NOT EXISTS logic_test_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- 测试配置
    logic_version_id UUID NOT NULL REFERENCES logic_versions(id),
    baseline_logic_version_id UUID NULL REFERENCES logic_versions(id),  -- 对比基准
    
    -- 测试执行者
    user_id UUID NOT NULL REFERENCES auth.users(id),
    
    -- 测试范围参数
    request_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 示例: {"plantId": "PLANT_A", "timeBuckets": ["2025-W01"], "maxFgCount": 100}
    
    -- 执行状态
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    
    -- 结果摘要
    summary JSONB NULL,
    -- 示例: {
    --   "fg_demands_count": 100,
    --   "bom_edges_count": 500,
    --   "component_demand_count": 1200,
    --   "trace_count": 5000,
    --   "errors_count": 0,
    --   "duration_seconds": 45
    -- }
    
    -- 差异报告
    diff_report JSONB NULL,
    -- 示例: {
    --   "total_demand_delta_pct": 2.5,
    --   "top_changes": [...],
    --   "new_components": [...],
    --   "removed_components": [...]
    -- }
    
    -- 错误信息
    error_message TEXT NULL,
    error_details JSONB NULL,
    
    -- 执行时间
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE logic_test_runs IS '沙盒测试运行记录，存储对比测试的结果和差异报告';
COMMENT ON COLUMN logic_test_runs.request_params IS '测试范围参数（plant, timeBuckets, 采样限制等）';
COMMENT ON COLUMN logic_test_runs.summary IS '测试结果统计摘要';
COMMENT ON COLUMN logic_test_runs.diff_report IS '与基准版本的差异分析报告';

-- 测试运行索引
CREATE INDEX IF NOT EXISTS idx_test_runs_version 
    ON logic_test_runs (logic_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_test_runs_user 
    ON logic_test_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_test_runs_status 
    ON logic_test_runs (status, started_at)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_test_runs_baseline 
    ON logic_test_runs (baseline_logic_version_id)
    WHERE baseline_logic_version_id IS NOT NULL;

-- ============================================
-- 6. 扩展现有表 - 添加 logic_version_id
-- ============================================

-- 添加到 forecast_runs
ALTER TABLE forecast_runs 
    ADD COLUMN IF NOT EXISTS logic_version_id UUID REFERENCES logic_versions(id);

COMMENT ON COLUMN forecast_runs.logic_version_id IS '本次运行使用的逻辑配置版本ID';

CREATE INDEX IF NOT EXISTS idx_forecast_runs_logic_version 
    ON forecast_runs (logic_version_id)
    WHERE logic_version_id IS NOT NULL;

-- 添加到 import_batches
ALTER TABLE import_batches 
    ADD COLUMN IF NOT EXISTS logic_version_id UUID REFERENCES logic_versions(id);

COMMENT ON COLUMN import_batches.logic_version_id IS '本次导入使用的逻辑配置版本ID';

CREATE INDEX IF NOT EXISTS idx_import_batches_logic_version 
    ON import_batches (logic_version_id)
    WHERE logic_version_id IS NOT NULL;

-- ============================================
-- 7. 核心辅助函数
-- ============================================

-- 函数：获取当前生效的已发布逻辑版本
CREATE OR REPLACE FUNCTION get_published_logic_version(
    p_logic_id TEXT,
    p_scope_level TEXT,
    p_scope_id TEXT DEFAULT NULL
) RETURNS TABLE (
    version_id UUID,
    config_json JSONB,
    schema_version TEXT,
    published_at TIMESTAMPTZ
) AS $$
BEGIN
    -- 先尝试精确匹配
    RETURN QUERY
    SELECT lv.id, lv.config_json, lv.schema_version, lv.published_at
    FROM logic_versions lv
    WHERE lv.logic_id = p_logic_id
      AND lv.scope_level = p_scope_level
      AND (
          (p_scope_level = 'GLOBAL' AND lv.scope_id IS NULL)
          OR (p_scope_level = 'PLANT' AND lv.scope_id = p_scope_id)
      )
      AND lv.status = 'published'
      AND lv.effective_from <= NOW()
      AND (lv.effective_to IS NULL OR lv.effective_to > NOW())
    ORDER BY lv.effective_from DESC
    LIMIT 1;
    
    -- 如果没找到工厂级配置，回退到全局配置
    IF NOT FOUND AND p_scope_level = 'PLANT' THEN
        RETURN QUERY
        SELECT lv.id, lv.config_json, lv.schema_version, lv.published_at
        FROM logic_versions lv
        WHERE lv.logic_id = p_logic_id
          AND lv.scope_level = 'GLOBAL'
          AND lv.status = 'published'
          AND lv.effective_from <= NOW()
          AND (lv.effective_to IS NULL OR lv.effective_to > NOW())
        ORDER BY lv.effective_from DESC
        LIMIT 1;
    END IF;
    
    RETURN;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_published_logic_version IS 
'获取指定逻辑当前生效的已发布版本。PLANT 级会先查找工厂配置，不存在则回退到 GLOBAL';

-- 函数：验证配置 JSON 结构
CREATE OR REPLACE FUNCTION validate_logic_config(
    p_config_json JSONB,
    p_schema_version TEXT DEFAULT '1.0'
) RETURNS TABLE (
    is_valid BOOLEAN,
    errors TEXT[]
) AS $$
DECLARE
    v_errors TEXT[] := '{}';
    v_limits JSONB;
    v_rules JSONB;
    v_sharding JSONB;
    v_staging JSONB;
BEGIN
    -- 检查 schema_version
    IF p_schema_version != '1.0' THEN
        v_errors := array_append(v_errors, 'Unsupported schema version: ' || p_schema_version);
        RETURN QUERY SELECT FALSE, v_errors;
        RETURN;
    END IF;
    
    -- 检查必需的顶层字段
    IF NOT (p_config_json ? 'limits') THEN
        v_errors := array_append(v_errors, 'Missing required section: limits');
    END IF;
    
    IF NOT (p_config_json ? 'rules') THEN
        v_errors := array_append(v_errors, 'Missing required section: rules');
    END IF;
    
    -- 验证 limits 字段
    v_limits := p_config_json->'limits';
    IF v_limits IS NOT NULL THEN
        -- 数值范围检查
        IF (v_limits->>'MAX_BOM_DEPTH')::INTEGER > 100 THEN
            v_errors := array_append(v_errors, 'MAX_BOM_DEPTH cannot exceed 100');
        END IF;
        IF (v_limits->>'MAX_BOM_DEPTH')::INTEGER < 1 THEN
            v_errors := array_append(v_errors, 'MAX_BOM_DEPTH must be at least 1');
        END IF;
        
        IF (v_limits->>'ZOMBIE_AFTER_SECONDS')::INTEGER < 30 THEN
            v_errors := array_append(v_errors, 'ZOMBIE_AFTER_SECONDS must be at least 30');
        END IF;
    END IF;
    
    -- 验证 rules 字段
    v_rules := p_config_json->'rules';
    IF v_rules IS NOT NULL THEN
        -- cycle_policy 枚举检查
        IF v_rules->>'cycle_policy' NOT IN ('warn_and_cut', 'fail') THEN
            v_errors := array_append(v_errors, 'cycle_policy must be "warn_and_cut" or "fail"');
        END IF;
        
        -- max_depth_policy 枚举检查
        IF v_rules->>'max_depth_policy' NOT IN ('warn_and_cut', 'fail') THEN
            v_errors := array_append(v_errors, 'max_depth_policy must be "warn_and_cut" or "fail"');
        END IF;
    END IF;
    
    -- 验证 sharding 字段
    v_sharding := p_config_json->'sharding';
    IF v_sharding IS NOT NULL THEN
        IF v_sharding->>'strategy' NOT IN ('none', 'by_time_bucket', 'by_fg_batch') THEN
            v_errors := array_append(v_errors, 'sharding.strategy must be "none", "by_time_bucket", or "by_fg_batch"');
        END IF;
    END IF;
    
    -- 验证 staging 字段
    v_staging := p_config_json->'staging';
    IF v_staging IS NOT NULL THEN
        IF v_staging->>'commit_mode' NOT IN ('all_or_nothing', 'best_effort') THEN
            v_errors := array_append(v_errors, 'staging.commit_mode must be "all_or_nothing" or "best_effort"');
        END IF;
    END IF;
    
    RETURN QUERY SELECT (array_length(v_errors, 1) IS NULL OR array_length(v_errors, 1) = 0), v_errors;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION validate_logic_config IS 
'验证 logic config JSON 的结构和值范围，返回是否有效及错误列表';

-- 函数：记录变更日志
CREATE OR REPLACE FUNCTION log_logic_change(
    p_logic_version_id UUID,
    p_actor_id UUID,
    p_action TEXT,
    p_from_status TEXT,
    p_to_status TEXT,
    p_comment TEXT DEFAULT NULL,
    p_diff_json JSONB DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_log_id UUID;
BEGIN
    INSERT INTO logic_change_log (
        logic_version_id, actor_id, action, from_status, to_status,
        comment, diff_json, created_at
    ) VALUES (
        p_logic_version_id, p_actor_id, p_action, p_from_status, p_to_status,
        p_comment, p_diff_json, NOW()
    )
    RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION log_logic_change IS 
'记录逻辑版本的状态变更日志';

-- ============================================
-- 8. 默认配置种子数据
-- ============================================

-- 创建默认的 GLOBAL bom_explosion 配置
-- 注意：需要在有 admin 用户后执行
INSERT INTO logic_versions (
    logic_id, scope_level, scope_id, status,
    effective_from, config_json, schema_version,
    created_by, created_at, published_by, published_at
)
SELECT 
    'bom_explosion', 'GLOBAL', NULL, 'published',
    NOW(),
    '{
        "schema_version": "1.0",
        "limits": {
            "MAX_FG_DEMAND_ROWS": 10000,
            "MAX_BOM_EDGES_ROWS": 50000,
            "MAX_BOM_DEPTH": 50,
            "MAX_TRACE_ROWS_PER_RUN": 500000,
            "INSERT_CHUNK_SIZE_DEMAND": 1000,
            "INSERT_CHUNK_SIZE_TRACE": 5000,
            "ZOMBIE_AFTER_SECONDS": 120,
            "MAX_CONCURRENT_JOBS_PER_USER": 3
        },
        "rules": {
            "edge_selection": {
                "plant_match_strategy": "exact_first_then_null",
                "validity_enforced": true,
                "priority_strategy": "min_priority",
                "tie_breaker": "latest_created_at"
            },
            "scrap_yield": {
                "default_scrap_rate": 0,
                "default_yield_rate": 1,
                "min_scrap_rate": 0,
                "max_scrap_rate": 0.99,
                "min_yield_rate": 0.01,
                "max_yield_rate": 1
            },
            "rounding": {
                "decimal_places": 4
            },
            "cycle_policy": "warn_and_cut",
            "max_depth_policy": "fail"
        },
        "sharding": {
            "strategy": "none",
            "shard_size_weeks": 4,
            "merge_policy": "sum_and_dedupe"
        },
        "staging": {
            "commit_mode": "all_or_nothing",
            "auto_cleanup_on_fail": true
        }
    }'::jsonb,
    '1.0',
    id, NOW(), id, NOW()
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'admin'
    OR email LIKE '%admin%'
LIMIT 1
ON CONFLICT DO NOTHING;

-- ============================================
-- 9. RLS 策略 (可选，基于现有权限系统)
-- ============================================

-- 先创建 user_profiles 表（如果不存在）
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    role TEXT DEFAULT 'viewer',
    accessible_plants TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 启用 RLS
ALTER TABLE logic_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logic_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE logic_test_runs ENABLE ROW LEVEL SECURITY;

-- 所有认证用户可查看 published 版本
CREATE POLICY view_published_logic ON logic_versions
    FOR SELECT
    TO authenticated
    USING (status = 'published');

-- 创建者可查看自己的 draft
CREATE POLICY view_own_drafts ON logic_versions
    FOR SELECT
    TO authenticated
    USING (created_by = auth.uid() AND status = 'draft');

-- 管理员可查看所有
CREATE POLICY admin_all_logic ON logic_versions
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE user_id = auth.uid() 
            AND role IN ('admin', 'system')
        )
    );

-- 变更日志查看策略
CREATE POLICY view_change_log ON logic_change_log
    FOR SELECT
    TO authenticated
    USING (true);

-- 测试运行查看策略
CREATE POLICY view_test_runs ON logic_test_runs
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles 
        WHERE user_id = auth.uid() 
        AND role IN ('admin', 'logic_approver')
    ));

-- ============================================
-- 完成
-- ============================================
