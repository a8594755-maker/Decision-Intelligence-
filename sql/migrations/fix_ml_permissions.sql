-- Fix ML API Permissions
-- The ML API currently runs with the ANON key (if Service Key is not set), 
-- so it needs permissions to INSERT/SELECT from these tables.

-- 1. Update ml_prediction_cache policies
DROP POLICY IF EXISTS "Users can manage prediction cache" ON ml_prediction_cache;
DROP POLICY IF EXISTS "Allow anon manage prediction cache" ON ml_prediction_cache;

CREATE POLICY "Allow anon manage prediction cache" 
ON ml_prediction_cache 
FOR ALL 
TO anon, authenticated 
USING (true);

-- 2. Update ml_model_history policies
DROP POLICY IF EXISTS "Users can view model history" ON ml_model_history;
DROP POLICY IF EXISTS "Allow anon view/insert model history" ON ml_model_history;

CREATE POLICY "Allow anon view/insert model history" 
ON ml_model_history 
FOR ALL 
TO anon, authenticated 
USING (true);
