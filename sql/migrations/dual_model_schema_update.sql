-- Dual Model Architecture Schema Update
-- =====================================

-- 1. Update existing tables to support chronos model
ALTER TABLE ml_model_history 
ALTER COLUMN model_type DROP CHECK,
ADD CONSTRAINT model_type_check CHECK (model_type IN ('prophet', 'lightgbm', 'chronos'));

-- 2. Create model comparison results table
CREATE TABLE IF NOT EXISTS ml_model_comparison (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    primary_model TEXT NOT NULL,
    secondary_model TEXT NOT NULL,
    primary_prediction JSONB NOT NULL,
    secondary_prediction JSONB NOT NULL,
    deviation_percentage DECIMAL(5,2) NOT NULL,
    agreement_level TEXT NOT NULL CHECK (agreement_level IN ('high', 'medium', 'low')),
    consensus_warning BOOLEAN DEFAULT FALSE,
    warning_level TEXT CHECK (warning_level IN ('high', 'medium')),
    warning_message TEXT,
    recommendation TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- 3. Create SKU analysis cache table
CREATE TABLE IF NOT EXISTS ml_sku_analysis_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT NOT NULL UNIQUE,
    analysis JSONB NOT NULL,
    recommended_model TEXT NOT NULL,
    chronos_suitability JSONB NOT NULL,
    data_points INTEGER NOT NULL,
    last_analyzed TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- 4. Create model performance metrics table
CREATE TABLE IF NOT EXISTS ml_model_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT NOT NULL,
    model_type TEXT NOT NULL,
    prediction_date DATE NOT NULL,
    actual_value DECIMAL(10,2),
    predicted_value DECIMAL(10,2),
    mae DECIMAL(10,2),
    mape DECIMAL(5,2),
    rmse DECIMAL(10,2),
    confidence_interval_lower DECIMAL(10,2),
    confidence_interval_upper DECIMAL(10,2),
    interval_accuracy BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create consensus warning configuration table
CREATE TABLE IF NOT EXISTS ml_consensus_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    deviation_threshold DECIMAL(5,2) DEFAULT 15.0,
    enable_high_warnings BOOLEAN DEFAULT TRUE,
    enable_medium_warnings BOOLEAN DEFAULT TRUE,
    auto_recommend BOOLEAN DEFAULT TRUE,
    preferred_model TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Enhanced prediction cache with dual-model support
ALTER TABLE ml_prediction_cache 
ADD COLUMN IF NOT EXISTS comparison_data JSONB,
ADD COLUMN IF NOT EXISTS consensus_warning JSONB,
ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS attempted_models TEXT[];

-- 7. Indexes for performance optimization
CREATE INDEX idx_ml_comparison_lookup ON ml_model_comparison(sku, horizon_days, created_at DESC);
CREATE INDEX idx_ml_comparison_expires ON ml_model_comparison(expires_at);
CREATE INDEX idx_ml_analysis_cache_sku ON ml_sku_analysis_cache(sku);
CREATE INDEX idx_ml_analysis_cache_expires ON ml_sku_analysis_cache(expires_at);
CREATE INDEX idx_ml_performance_sku_model ON ml_model_performance(sku, model_type);
CREATE INDEX idx_ml_performance_date ON ml_model_performance(prediction_date DESC);

-- 8. RLS Policies for new tables
ALTER TABLE ml_model_comparison ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_sku_analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_model_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_consensus_config ENABLE ROW LEVEL SECURITY;

-- Model comparison - 所有认证用户可读
CREATE POLICY "Users can view model comparisons" ON ml_model_comparison FOR SELECT TO authenticated USING (true);

-- SKU analysis cache - 所有认证用户可读写
CREATE POLICY "Users can manage SKU analysis cache" ON ml_sku_analysis_cache FOR ALL TO authenticated USING (true);

-- Model performance - 所有认证用户可读写
CREATE POLICY "Users can manage model performance" ON ml_model_performance FOR ALL TO authenticated USING (true);

-- Consensus config - 仅用户本人可读写
CREATE POLICY "Users can manage own consensus config" ON ml_consensus_config FOR ALL TO authenticated USING (auth.uid() = user_id);

-- 9. Functions for dual-model operations

-- Function to clean up expired comparison data
CREATE OR REPLACE FUNCTION cleanup_expired_comparisons()
RETURNS void AS $$
BEGIN
    DELETE FROM ml_model_comparison WHERE expires_at < NOW();
    DELETE FROM ml_sku_analysis_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get model recommendation with caching
CREATE OR REPLACE FUNCTION get_model_recommendation(p_sku TEXT)
RETURNS TABLE(
    recommended_model TEXT,
    analysis JSONB,
    chronos_suitability JSONB,
    cached BOOLEAN
) AS $$
DECLARE
    cached_analysis RECORD;
BEGIN
    -- Check cache first
    SELECT * INTO cached_analysis 
    FROM ml_sku_analysis_cache 
    WHERE sku = p_sku AND expires_at > NOW();
    
    IF FOUND THEN
        RETURN QUERY
        SELECT 
            cached_analysis.recommended_model,
            cached_analysis.analysis,
            cached_analysis.chronos_suitability,
            true::BOOLEAN;
    ELSE
        -- Return empty result (application logic will handle)
        RETURN QUERY
        SELECT 
            NULL::TEXT,
            '{}'::JSONB,
            '{}'::JSONB,
            false::BOOLEAN
        LIMIT 0;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to save model comparison results
CREATE OR REPLACE FUNCTION save_model_comparison(
    p_sku TEXT,
    p_horizon_days INTEGER,
    p_primary_model TEXT,
    p_secondary_model TEXT,
    p_primary_prediction JSONB,
    p_secondary_prediction JSONB,
    p_deviation_pct DECIMAL,
    p_agreement_level TEXT,
    p_consensus_warning BOOLEAN DEFAULT FALSE,
    p_warning_level TEXT DEFAULT NULL,
    p_warning_message TEXT DEFAULT NULL,
    p_recommendation TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    comparison_id UUID;
BEGIN
    INSERT INTO ml_model_comparison (
        sku,
        horizon_days,
        primary_model,
        secondary_model,
        primary_prediction,
        secondary_prediction,
        deviation_percentage,
        agreement_level,
        consensus_warning,
        warning_level,
        warning_message,
        recommendation,
        expires_at
    ) VALUES (
        p_sku,
        p_horizon_days,
        p_primary_model,
        p_secondary_model,
        p_primary_prediction,
        p_secondary_prediction,
        p_deviation_pct,
        p_agreement_level,
        p_consensus_warning,
        p_warning_level,
        p_warning_message,
        p_recommendation,
        NOW() + INTERVAL '7 days'  -- Cache for 7 days
    ) RETURNING id INTO comparison_id;
    
    RETURN comparison_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to cache SKU analysis
CREATE OR REPLACE FUNCTION cache_sku_analysis(
    p_sku TEXT,
    p_analysis JSONB,
    p_recommended_model TEXT,
    p_chronos_suitability JSONB,
    p_data_points INTEGER
)
RETURNS UUID AS $$
DECLARE
    analysis_id UUID;
BEGIN
    INSERT INTO ml_sku_analysis_cache (
        sku,
        analysis,
        recommended_model,
        chronos_suitability,
        data_points,
        expires_at
    ) VALUES (
        p_sku,
        p_analysis,
        p_recommended_model,
        p_chronos_suitability,
        p_data_points,
        NOW() + INTERVAL '24 hours'  -- Cache for 24 hours
    ) ON CONFLICT (sku) DO UPDATE SET
        analysis = EXCLUDED.analysis,
        recommended_model = EXCLUDED.recommended_model,
        chronos_suitability = EXCLUDED.chronos_suitability,
        data_points = EXCLUDED.data_points,
        last_analyzed = NOW(),
        expires_at = EXCLUDED.expires_at
    RETURNING id INTO analysis_id;
    
    RETURN analysis_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. Views for common queries

-- View for recent model comparisons
CREATE OR REPLACE VIEW v_recent_model_comparisons AS
SELECT 
    sku,
    horizon_days,
    primary_model,
    secondary_model,
    deviation_percentage,
    agreement_level,
    consensus_warning,
    warning_level,
    created_at
FROM ml_model_comparison 
WHERE created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;

-- View for model performance summary
CREATE OR REPLACE VIEW v_model_performance_summary AS
SELECT 
    sku,
    model_type,
    COUNT(*) as prediction_count,
    AVG(mae) as avg_mae,
    AVG(mape) as avg_mape,
    AVG(rmse) as avg_rmse,
    SUM(CASE WHEN interval_accuracy THEN 1 ELSE 0 END)::DECIMAL / COUNT(*) * 100 as interval_accuracy_pct
FROM ml_model_performance 
WHERE prediction_date > NOW() - INTERVAL '90 days'
GROUP BY sku, model_type;

-- 11. Trigger to update user preferences timestamp
CREATE OR REPLACE FUNCTION update_consensus_config_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_consensus_config_timestamp
    BEFORE UPDATE ON ml_consensus_config
    FOR EACH ROW
    EXECUTE FUNCTION update_consensus_config_timestamp();

-- 12. Sample data insertion (for development)
-- This would be removed in production

-- Insert default consensus config for existing users
INSERT INTO ml_consensus_config (user_id, deviation_threshold, auto_recommend)
SELECT id, 15.0, true 
FROM auth.users 
WHERE id NOT IN (SELECT user_id FROM ml_consensus_config);

-- 13. Comments for documentation
COMMENT ON TABLE ml_model_comparison IS 'Stores comparison results between different forecasting models';
COMMENT ON TABLE ml_sku_analysis_cache IS 'Caches SKU data analysis and model recommendations';
COMMENT ON TABLE ml_model_performance IS 'Tracks actual vs predicted performance metrics';
COMMENT ON TABLE ml_consensus_config IS 'User preferences for consensus warnings and model selection';

COMMENT ON COLUMN ml_model_comparison.deviation_percentage IS 'Percentage deviation between primary and secondary model predictions';
COMMENT ON COLUMN ml_model_comparison.agreement_level IS 'High (<10%), Medium (10-20%), Low (>20%) agreement between models';
COMMENT ON COLUMN ml_consensus_config.deviation_threshold IS 'Threshold for triggering consensus warnings (default 15%)';
