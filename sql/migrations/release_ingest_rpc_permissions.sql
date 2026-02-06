-- ============================================
-- Ingest RPC 權限正式上線
-- ============================================
-- 執行時機：在 sql/migrations/ingest_rpc.sql 之後執行
-- 目的：明確 GRANT/REVOKE，確保僅 authenticated（及可選 service_role）可執行
-- RLS：函式為 SECURITY DEFINER，內部使用 auth.uid()，不會被 RLS 阻擋合法寫入

-- ============================================
-- 1. 授予執行權限
-- ============================================
GRANT EXECUTE ON FUNCTION public.ingest_goods_receipts_v1(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_price_history_v1(UUID, UUID, JSONB) TO authenticated;

-- 可選：後端或 cron 需代為寫入時再開啟
-- GRANT EXECUTE ON FUNCTION public.ingest_goods_receipts_v1(UUID, UUID, JSONB) TO service_role;
-- GRANT EXECUTE ON FUNCTION public.ingest_price_history_v1(UUID, UUID, JSONB) TO service_role;

-- ============================================
-- 2. 確保 anon 無法執行（避免未登入寫入）
-- ============================================
REVOKE EXECUTE ON FUNCTION public.ingest_goods_receipts_v1(UUID, UUID, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.ingest_price_history_v1(UUID, UUID, JSONB) FROM anon;

-- ============================================
-- 驗證（可選，於 SQL Editor 手動執行）
-- ============================================
-- SELECT routine_name, grantee FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public' AND routine_name LIKE 'ingest_%';
