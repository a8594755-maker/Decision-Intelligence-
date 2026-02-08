-- ============================================
-- Logic Regression Test Suite
-- Phase 4: Regression testing infrastructure
-- ============================================

-- Table: logic_regression_tests - Fixed test cases for validation
CREATE TABLE IF NOT EXISTS logic_regression_tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    logic_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NULL,
    
    -- Test parameters (fixed test case definition)
    test_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Example: {"plantId": "PLANT_A", "fgMaterials": ["FG001", "FG002"], "timeBuckets": ["2025-W01"]}
    
    -- Expected results (captured from first "golden" run)
    expected_summary JSONB NULL,
    -- Example: {"total_component_demand": 15000, "total_trace_count": 45000}
    
    -- Component-level expected demands
    expected_demands JSONB NULL,
    -- Example: [{"material": "COMP001", "plant": "PLANT_A", "bucket": "2025-W01", "qty": 5000}]
    
    -- Thresholds for acceptance
    thresholds JSONB NOT NULL DEFAULT '{
        "total_demand_pct": 2.0,
        "component_count_pct": 5.0,
        "trace_count_pct": 10.0
    }'::jsonb,
    
    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,
    
    -- Metadata
    created_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE logic_regression_tests IS 'Regression test cases for logic validation - fixed scenarios that must pass before publishing';

-- Index for querying tests by logic type
CREATE INDEX IF NOT EXISTS idx_regression_tests_logic 
    ON logic_regression_tests (logic_id, is_active);

-- Table: logic_regression_results - Results of regression test runs
CREATE TABLE IF NOT EXISTS logic_regression_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Test run identification
    logic_version_id UUID NOT NULL REFERENCES logic_versions(id),
    batch_run_id UUID NOT NULL, -- Groups multiple test cases run together
    
    -- Individual test case
    regression_test_id UUID NOT NULL REFERENCES logic_regression_tests(id),
    
    -- Execution
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error')),
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    
    -- Actual results
    actual_summary JSONB NULL,
    actual_demands JSONB NULL,
    
    -- Comparison with expected
    comparison JSONB NULL,
    -- Example: {
    --   "total_demand_delta_pct": 1.5,
    --   "component_count_delta_pct": 0,
    --   "trace_count_delta_pct": 3.2,
    --   "violations": []
    -- }
    
    -- Pass/fail determination
    passed BOOLEAN NULL,
    failure_reason TEXT NULL,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE logic_regression_results IS 'Results of regression test executions for specific logic versions';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_regression_results_version 
    ON logic_regression_results (logic_version_id, status);

CREATE INDEX IF NOT EXISTS idx_regression_results_batch 
    ON logic_regression_results (batch_run_id);

-- Function: Run regression tests for a logic version
CREATE OR REPLACE FUNCTION run_regression_tests(
    p_logic_version_id UUID,
    p_batch_run_id UUID DEFAULT gen_random_uuid()
) RETURNS TABLE (
    batch_run_id UUID,
    total_tests INTEGER,
    passed_tests INTEGER,
    failed_tests INTEGER,
    overall_passed BOOLEAN
) AS $$
DECLARE
    v_test RECORD;
    v_total INTEGER := 0;
    v_passed INTEGER := 0;
    v_failed INTEGER := 0;
BEGIN
    -- Create result records for all active tests
    FOR v_test IN 
        SELECT rt.id, rt.test_params, rt.expected_summary, rt.thresholds
        FROM logic_regression_tests rt
        JOIN logic_versions lv ON rt.logic_id = lv.logic_id
        WHERE lv.id = p_logic_version_id
          AND rt.is_active = true
    LOOP
        INSERT INTO logic_regression_results (
            logic_version_id,
            batch_run_id,
            regression_test_id,
            status,
            started_at
        ) VALUES (
            p_logic_version_id,
            p_batch_run_id,
            v_test.id,
            'pending',
            NOW()
        );
        
        v_total := v_total + 1;
    END LOOP;
    
    -- Note: Actual execution happens via Edge Function
    -- This just initializes the records
    
    RETURN QUERY SELECT 
        p_batch_run_id,
        v_total,
        0, -- Will be updated after execution
        0,
        false;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION run_regression_tests IS 
'Initialize regression test runs for a logic version. Actual execution happens via Edge Function.';

-- Function: Check if version can be published (gate check)
CREATE OR REPLACE FUNCTION can_publish_version(
    p_logic_version_id UUID,
    p_threshold_overrides JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE (
    can_publish BOOLEAN,
    reason TEXT,
    total_tests INTEGER,
    passed_tests INTEGER,
    failed_tests INTEGER,
    violations JSONB
) AS $$
DECLARE
    v_total INTEGER;
    v_passed INTEGER;
    v_failed INTEGER;
    v_violations JSONB := '[]'::jsonb;
    v_result RECORD;
BEGIN
    -- Check if any regression tests exist for this logic type
    SELECT COUNT(*) INTO v_total
    FROM logic_regression_tests rt
    JOIN logic_versions lv ON rt.logic_id = lv.logic_id
    WHERE lv.id = p_logic_version_id
      AND rt.is_active = true;
    
    -- If no tests configured, allow publish but warn
    IF v_total = 0 THEN
        RETURN QUERY SELECT 
            true,
            'WARNING: No regression tests configured. Publishing without validation.',
            0, 0, 0, '[]'::jsonb;
        RETURN;
    END IF;
    
    -- Check if all tests have been run
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'passed'),
        COUNT(*) FILTER (WHERE status IN ('failed', 'error'))
    INTO v_total, v_passed, v_failed
    FROM logic_regression_results
    WHERE logic_version_id = p_logic_version_id
      AND status IN ('passed', 'failed', 'error');
    
    -- If no results yet, cannot publish
    IF v_total = 0 THEN
        RETURN QUERY SELECT 
            false,
            'Regression tests not run. Execute tests before publishing.',
            0, 0, 0, '[]'::jsonb;
        RETURN;
    END IF;
    
    -- Check for failures
    IF v_failed > 0 THEN
        -- Collect violations
        SELECT jsonb_agg(
            jsonb_build_object(
                'test_id', rr.regression_test_id,
                'test_name', rt.name,
                'failure_reason', rr.failure_reason,
                'comparison', rr.comparison
            )
        ) INTO v_violations
        FROM logic_regression_results rr
        JOIN logic_regression_tests rt ON rr.regression_test_id = rt.id
        WHERE rr.logic_version_id = p_logic_version_id
          AND rr.status IN ('failed', 'error');
        
        RETURN QUERY SELECT 
            false,
            format('%s of %s regression tests failed. Review failures before publishing.', v_failed, v_total),
            v_total, v_passed, v_failed, v_violations;
        RETURN;
    END IF;
    
    -- Check threshold violations
    FOR v_result IN
        SELECT 
            rt.id,
            rt.name,
            rt.thresholds,
            rr.comparison
        FROM logic_regression_results rr
        JOIN logic_regression_tests rt ON rr.regression_test_id = rt.id
        WHERE rr.logic_version_id = p_logic_version_id
          AND rr.status = 'passed'
    LOOP
        -- Check if comparison exceeds thresholds
        IF (v_result.comparison->>'total_demand_delta_pct')::numeric > 
           COALESCE((p_threshold_overrides->>'total_demand_pct')::numeric, 
                    (v_result.thresholds->>'total_demand_pct')::numeric, 2.0) THEN
            
            v_violations := v_violations || jsonb_build_object(
                'test_id', v_result.id,
                'test_name', v_result.name,
                'violation_type', 'total_demand_threshold_exceeded',
                'actual', v_result.comparison->>'total_demand_delta_pct',
                'threshold', COALESCE(
                    (p_threshold_overrides->>'total_demand_pct')::numeric,
                    (v_result.thresholds->>'total_demand_pct')::numeric, 2.0
                )
            );
        END IF;
    END LOOP;
    
    -- If there are threshold warnings, allow publish with override but flag them
    IF jsonb_array_length(v_violations) > 0 THEN
        RETURN QUERY SELECT 
            true, -- Allow with override
            format('WARNING: %s threshold violations detected. Review recommended.', jsonb_array_length(v_violations)),
            v_total, v_passed, v_failed, v_violations;
        RETURN;
    END IF;
    
    -- All clear
    RETURN QUERY SELECT 
        true,
        format('All %s regression tests passed.', v_total),
        v_total, v_passed, v_failed, '[]'::jsonb;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION can_publish_version IS 
'Check if a logic version passes regression tests and can be published. Returns detailed status.';

-- Trigger: Auto-run regression tests when version is approved
CREATE OR REPLACE FUNCTION trigger_regression_on_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
        -- Initialize regression tests
        PERFORM run_regression_tests(NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_regression_on_approval ON logic_versions;
CREATE TRIGGER trg_regression_on_approval
    AFTER UPDATE ON logic_versions
    FOR EACH ROW
    WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION trigger_regression_on_approval();

-- Seed data: Default regression test cases for BOM Explosion
INSERT INTO logic_regression_tests (
    logic_id, name, description, test_params, thresholds, created_by
)
SELECT 
    'bom_explosion',
    'Standard Linear BOM Test',
    'Tests simple linear BOM with 3 levels of depth',
    '{"maxFgCount": 10, "validateStructure": true}'::jsonb,
    '{"total_demand_pct": 2.0, "component_count_pct": 5.0}'::jsonb,
    id
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'admin' OR email LIKE '%admin%'
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO logic_regression_tests (
    logic_id, name, description, test_params, thresholds, created_by
)
SELECT 
    'bom_explosion',
    'Diamond BOM Structure Test',
    'Tests diamond-shaped BOM where components are shared across multiple parents',
    '{"maxFgCount": 5, "validateStructure": true}'::jsonb,
    '{"total_demand_pct": 2.0, "component_count_pct": 5.0}'::jsonb,
    id
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'admin' OR email LIKE '%admin%'
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO logic_regression_tests (
    logic_id, name, description, test_params, thresholds, created_by
)
SELECT 
    'bom_explosion',
    'Deep Nesting BOM Test',
    'Tests BOM with 10+ levels of depth to validate max_depth handling',
    '{"maxFgCount": 3, "validateStructure": true}'::jsonb,
    '{"total_demand_pct": 2.0, "component_count_pct": 5.0}'::jsonb,
    id
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'admin' OR email LIKE '%admin%'
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO logic_regression_tests (
    logic_id, name, description, test_params, thresholds, created_by
)
SELECT 
    'bom_explosion',
    'Multi-Plant BOM Test',
    'Tests plant-specific vs generic BOM edge selection',
    '{"maxFgCount": 5, "validateStructure": true}'::jsonb,
    '{"total_demand_pct": 2.0, "component_count_pct": 5.0}'::jsonb,
    id
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'admin' OR email LIKE '%admin%'
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO logic_regression_tests (
    logic_id, name, description, test_params, thresholds, created_by
)
SELECT 
    'bom_explosion',
    'Scrap/Yield Calculation Test',
    'Tests scrap rate and yield rate calculations are applied correctly',
    '{"maxFgCount": 5, "validateCalculations": true}'::jsonb,
    '{"total_demand_pct": 1.0, "component_count_pct": 5.0}'::jsonb,
    id
FROM auth.users 
WHERE raw_user_meta_data->>'role' = 'admin' OR email LIKE '%admin%'
LIMIT 1
ON CONFLICT DO NOTHING;

-- ============================================
-- Complete
-- ============================================
