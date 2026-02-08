-- ML Integration Schema for Supabase
-- ============================================

-- 1. 模型训练历史表
CREATE TABLE IF NOT EXISTS ml_model_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_type TEXT NOT NULL CHECK (model_type IN ('prophet', 'lightgbm')),
    sku TEXT NOT NULL,
    version TEXT NOT NULL,
    training_date TIMESTAMPTZ DEFAULT NOW(),
    metrics JSONB NOT NULL, -- MAPE, RMSE, etc.
    model_path TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 预测结果缓存表
CREATE TABLE IF NOT EXISTS ml_prediction_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    model_type TEXT NOT NULL,
    prediction JSONB NOT NULL, -- predicted_demand, confidence_interval
    cache_key TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(sku, horizon_days, model_type)
);

-- 3. 用户预测偏好表
CREATE TABLE IF NOT EXISTS ml_user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    default_model_type TEXT NOT NULL DEFAULT 'prophet',
    default_horizon_days INTEGER NOT NULL DEFAULT 30,
    auto_refresh BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 索引优化
CREATE INDEX idx_ml_prediction_cache_lookup ON ml_prediction_cache(sku, horizon_days, model_type);
CREATE INDEX idx_ml_prediction_cache_expires ON ml_prediction_cache(expires_at);
CREATE INDEX idx_ml_model_history_sku ON ml_model_history(sku, model_type);

-- 5. RLS Policies
ALTER TABLE ml_model_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_prediction_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_user_preferences ENABLE ROW LEVEL SECURITY;

-- 模型历史 - 所有认证用户可读
CREATE POLICY "Users can view model history" ON ml_model_history FOR SELECT TO authenticated USING (true);

-- 预测缓存 - 所有认证用户可读写
CREATE POLICY "Users can manage prediction cache" ON ml_prediction_cache FOR ALL TO authenticated USING (true);

-- 用户偏好 - 仅用户本人可读写
CREATE POLICY "Users can manage own preferences" ON ml_user_preferences FOR ALL TO authenticated USING (auth.uid() = user_id);

-- 6. 清理过期缓存的函数
CREATE OR REPLACE FUNCTION cleanup_expired_predictions()
RETURNS void AS $$
BEGIN
    DELETE FROM ml_prediction_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. 自动清理任务（需要 pg_cron 扩展）
-- SELECT cron.schedule('cleanup-ml-cache', '0 2 * * *', 'SELECT cleanup_expired_predictions();');
