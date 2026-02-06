-- ============================================
-- Rollback: 移除 Ingest RPC（一鍵還原）
-- ============================================
-- 執行後前端會自動 fallback 到舊寫入路徑（uploadStrategies.js）
-- 如需重新上線，再執行 sql/migrations/ingest_rpc.sql 與 release_ingest_rpc_permissions.sql

DROP FUNCTION IF EXISTS public.ingest_goods_receipts_v1(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.ingest_price_history_v1(UUID, UUID, JSONB);

-- 完成提示
DO $$
BEGIN
  RAISE NOTICE 'Ingest RPC 已移除。前端將使用舊寫入路徑。';
END $$;
