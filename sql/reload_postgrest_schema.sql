-- Fix 406 error: Force PostgREST to reload schema cache
-- ============================================
-- When tables are created after PostgREST starts,
-- the REST API doesn't know about them until the cache is refreshed.
-- This is the root cause of the 406 "Not Acceptable" error.
-- ============================================

NOTIFY pgrst, 'reload schema';
