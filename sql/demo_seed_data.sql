-- ============================================================
-- Decision-Intelligence Demo Seed Data
-- ============================================================
-- 執行前請先設定 YOUR_USER_ID:
--   在 Supabase SQL Editor 執行: SELECT id FROM auth.users LIMIT 1;
--   將下方 '291075be-3bee-43ff-a296-17c8eecd26a1' 替換為你的 user UUID
-- ============================================================

-- ============================================================
-- 0. 設定變數（請替換為你的 user id）
-- ============================================================
-- Supabase SQL Editor 不支援 \set，請用 Find & Replace:
--   搜尋:  '291075be-3bee-43ff-a296-17c8eecd26a1'
--   替換為: 你的 auth.users.id（含引號內的 UUID）
-- 例如:  '3fa85f64-5717-4562-b3fc-2c963f66afa6'
-- ============================================================

-- ============================================================
-- 0.1 清除舊 demo 資料（冪等）
-- ============================================================
DELETE FROM risk_score_results       WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM margin_at_risk_results   WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM inventory_forecast_prob_series  WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM inventory_forecast_prob_summary WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM supply_forecast_inbound_trace  WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM supply_forecast_inbound  WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM supply_forecast_po       WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM supplier_supply_stats    WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM component_demand_trace   WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM component_demand         WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM demand_forecast          WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM demand_fg                WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM bom_edges                WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM po_open_lines            WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM material_stock_snapshots WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM inventory_snapshots      WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM fg_financials            WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM revenue_terms            WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM materials                WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM suppliers                WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM forecast_runs            WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM forecast_runs            WHERE id IN ('a0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000002','a0000001-0000-0000-0000-000000000003');
DELETE FROM import_batches           WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
DELETE FROM import_batches           WHERE id IN ('a0000001-0000-0000-0000-000000000009');

-- ============================================================
-- 1. Forecast Runs (baseline BOM run + demand forecast run)
-- ============================================================
INSERT INTO forecast_runs (id, created_at, user_id, scenario_name, parameters, kind, status) VALUES
  ('a0000001-0000-0000-0000-000000000001', NOW() - INTERVAL '2 hours', '291075be-3bee-43ff-a296-17c8eecd26a1',
   'baseline', '{"time_buckets":["2026-W07","2026-W08","2026-W09","2026-W10","2026-W11","2026-W12"],"horizon_buckets":6}'::jsonb,
   'bom_explosion', 'completed'),
  ('a0000001-0000-0000-0000-000000000002', NOW() - INTERVAL '1 hour', '291075be-3bee-43ff-a296-17c8eecd26a1',
   'demand_forecast', '{"kind":"demand_forecast","model_version":"ma_v1","train_window_buckets":8,"time_buckets":["2026-W07","2026-W08","2026-W09","2026-W10","2026-W11","2026-W12"]}'::jsonb,
   'demand_forecast', 'completed'),
  ('a0000001-0000-0000-0000-000000000003', NOW() - INTERVAL '30 minutes', '291075be-3bee-43ff-a296-17c8eecd26a1',
   'revenue_baseline', '{"kind":"revenue_forecast","source_bom_run_id":"a0000001-0000-0000-0000-000000000001"}'::jsonb,
   'revenue_forecast', 'completed');

-- ============================================================
-- 2. Suppliers (3 suppliers, SUP-BETA 可靠度偏低)
-- ============================================================
INSERT INTO suppliers (id, user_id, supplier_name, supplier_code, plant_id, lead_time_days, on_time_rate, status, notes) VALUES
  ('b0000001-0000-0000-0000-000000000001', '291075be-3bee-43ff-a296-17c8eecd26a1',
   'Alpha Electronics Co.', 'SUP-ALPHA', 'PLANT-SZ', 14, 0.95, 'active',
   'Tier-1 IC supplier, Shenzhen. Consistent on-time delivery.'),
  ('b0000001-0000-0000-0000-000000000002', '291075be-3bee-43ff-a296-17c8eecd26a1',
   'Beta Plastics Ltd.', 'SUP-BETA', 'PLANT-SZ', 21, 0.62, 'active',
   'Injection molding supplier. Frequent delays due to capacity constraints.'),
  ('b0000001-0000-0000-0000-000000000003', '291075be-3bee-43ff-a296-17c8eecd26a1',
   'Gamma Metal Works', 'SUP-GAMMA', 'PLANT-SZ', 10, 0.88, 'active',
   'Sheet metal and CNC machining. Reliable but lead times vary with volume.');

-- ============================================================
-- 3. Materials (12 materials: 3 FG, 3 SUB, 6 RM)
-- ============================================================
INSERT INTO materials (user_id, material_code, material_name, category, uom) VALUES
  -- Finished Goods
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500',   'Industrial Controller Unit 500',  'FG',  'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200',   'IoT Sensor Module 200',          'FG',  'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',    'Smart Power Supply 100W',         'FG',  'pcs'),
  -- Sub-Assemblies
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PCB-A1',    'Main PCB Assembly A1',            'SUB', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-HOUSING-B', 'Enclosure Housing B',             'SUB', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PWR-MOD',   'Power Module Sub-Assembly',       'SUB', 'pcs'),
  -- Raw Materials
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32',   'MCU 32-bit ARM Cortex',           'RM',  'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF',  'Capacitor 100uF MLCC',           'RM',  'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K',    'Resistor 10K 0402',              'RM',  'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB',   'USB-C Connector',                'RM',  'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS','ABS Plastic Pellets',            'RM',  'kg'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH',   'Steel Sheet 1.2mm',              'RM',  'pcs');

-- ============================================================
-- 4. BOM Edges (FG → SUB → RM)
-- ============================================================
INSERT INTO bom_edges (user_id, parent_material, child_material, qty_per, plant_id, uom) VALUES
  -- FG-CTRL-500 → SUB-PCB-A1 (1), SUB-HOUSING-B (1)
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'SUB-PCB-A1',    1.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'SUB-HOUSING-B',  1.0, 'PLANT-SZ', 'pcs'),
  -- FG-SENS-200 → SUB-PCB-A1 (1), RM-CONN-USB (2)
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'SUB-PCB-A1',    1.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'RM-CONN-USB',   2.0, 'PLANT-SZ', 'pcs'),
  -- FG-PWR-100 → SUB-PWR-MOD (1), SUB-HOUSING-B (1)
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'SUB-PWR-MOD',   1.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'SUB-HOUSING-B',  1.0, 'PLANT-SZ', 'pcs'),
  -- SUB-PCB-A1 → RM-IC-MCU32 (1), RM-CAP-100UF (12), RM-RES-10K (24)
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PCB-A1',  'RM-IC-MCU32',   1.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PCB-A1',  'RM-CAP-100UF', 12.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PCB-A1',  'RM-RES-10K',   24.0, 'PLANT-SZ', 'pcs'),
  -- SUB-HOUSING-B → RM-PLASTIC-ABS (0.35 kg), RM-STEEL-SH (2)
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-HOUSING-B','RM-PLASTIC-ABS',0.35,'PLANT-SZ', 'kg'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-HOUSING-B','RM-STEEL-SH',   2.0, 'PLANT-SZ', 'pcs'),
  -- SUB-PWR-MOD → RM-CAP-100UF (6), RM-IC-MCU32 (1), RM-CONN-USB (1)
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PWR-MOD', 'RM-CAP-100UF',  6.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PWR-MOD', 'RM-IC-MCU32',   1.0, 'PLANT-SZ', 'pcs'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PWR-MOD', 'RM-CONN-USB',   1.0, 'PLANT-SZ', 'pcs');

-- ============================================================
-- 5. Demand FG (歷史 8 週 + 未來 6 週)
-- ============================================================
-- 歷史需求（W51–W06 共 8 週，做為 forecast training window）
INSERT INTO demand_fg (user_id, material_code, plant_id, time_bucket, week_bucket, demand_qty, source_type) VALUES
  -- FG-CTRL-500: 穩定高量
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2025-W51', '2025-W51', 120, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2025-W52', '2025-W52', 130, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2026-W01', '2026-W01', 125, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2026-W02', '2026-W02', 140, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2026-W03', '2026-W03', 135, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2026-W04', '2026-W04', 145, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2026-W05', '2026-W05', 150, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', '2026-W06', '2026-W06', 138, 'forecast'),
  -- FG-SENS-200: 季節性上升
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2025-W51', '2025-W51',  60, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2025-W52', '2025-W52',  65, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2026-W01', '2026-W01',  70, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2026-W02', '2026-W02',  75, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2026-W03', '2026-W03',  80, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2026-W04', '2026-W04',  85, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2026-W05', '2026-W05',  90, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', '2026-W06', '2026-W06',  88, 'forecast'),
  -- FG-PWR-100: 平穩偏低量
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2025-W51', '2025-W51',  40, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2025-W52', '2025-W52',  42, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2026-W01', '2026-W01',  38, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2026-W02', '2026-W02',  45, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2026-W03', '2026-W03',  43, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2026-W04', '2026-W04',  47, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2026-W05', '2026-W05',  50, 'forecast'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', '2026-W06', '2026-W06',  48, 'forecast');

-- ============================================================
-- 6. Demand Forecast (P10/P50/P90 未來 6 週 — Forecast 頁面用)
-- ============================================================
INSERT INTO demand_forecast (user_id, forecast_run_id, material_code, plant_id, time_bucket, p10, p50, p90, model_version, train_window_buckets, metrics) VALUES
  -- FG-CTRL-500: 穩定趨勢，窄 CI
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-CTRL-500', 'PLANT-SZ', '2026-W07', 128, 142, 158, 'ma_v1', 8, '{"wape":0.06,"std":11.2,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-CTRL-500', 'PLANT-SZ', '2026-W08', 130, 145, 162, 'ma_v1', 8, '{"wape":0.06,"std":12.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-CTRL-500', 'PLANT-SZ', '2026-W09', 125, 140, 157, 'ma_v1', 8, '{"wape":0.07,"std":12.5,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-CTRL-500', 'PLANT-SZ', '2026-W10', 132, 148, 166, 'ma_v1', 8, '{"wape":0.06,"std":13.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-CTRL-500', 'PLANT-SZ', '2026-W11', 127, 143, 161, 'ma_v1', 8, '{"wape":0.07,"std":13.5,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-CTRL-500', 'PLANT-SZ', '2026-W12', 130, 146, 164, 'ma_v1', 8, '{"wape":0.07,"std":13.0,"n":8}'::jsonb),
  -- FG-SENS-200: 上升趨勢，較寬 CI（需求波動大）
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-SENS-200', 'PLANT-SZ', '2026-W07',  72,  92, 118, 'ma_v1', 8, '{"wape":0.12,"std":18.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-SENS-200', 'PLANT-SZ', '2026-W08',  76,  97, 124, 'ma_v1', 8, '{"wape":0.13,"std":19.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-SENS-200', 'PLANT-SZ', '2026-W09',  80, 102, 130, 'ma_v1', 8, '{"wape":0.13,"std":20.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-SENS-200', 'PLANT-SZ', '2026-W10',  84, 108, 138, 'ma_v1', 8, '{"wape":0.14,"std":21.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-SENS-200', 'PLANT-SZ', '2026-W11',  88, 113, 144, 'ma_v1', 8, '{"wape":0.14,"std":22.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-SENS-200', 'PLANT-SZ', '2026-W12',  85, 110, 141, 'ma_v1', 8, '{"wape":0.15,"std":22.5,"n":8}'::jsonb),
  -- FG-PWR-100: 平穩，中等 CI
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-PWR-100',  'PLANT-SZ', '2026-W07',  38,  48,  60, 'ma_v1', 8, '{"wape":0.09,"std":8.5,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-PWR-100',  'PLANT-SZ', '2026-W08',  40,  50,  62, 'ma_v1', 8, '{"wape":0.09,"std":8.8,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-PWR-100',  'PLANT-SZ', '2026-W09',  37,  47,  59, 'ma_v1', 8, '{"wape":0.10,"std":9.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-PWR-100',  'PLANT-SZ', '2026-W10',  41,  52,  65, 'ma_v1', 8, '{"wape":0.09,"std":9.2,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-PWR-100',  'PLANT-SZ', '2026-W11',  39,  49,  61, 'ma_v1', 8, '{"wape":0.10,"std":9.0,"n":8}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000002', 'FG-PWR-100',  'PLANT-SZ', '2026-W12',  40,  51,  64, 'ma_v1', 8, '{"wape":0.10,"std":9.5,"n":8}'::jsonb);

-- ============================================================
-- 6.5 Import Batches (Backfill for Seed Data Visibility)
-- ============================================================
INSERT INTO import_batches (id, user_id, upload_type, target_table, filename, status, progress, total_rows, success_rows, error_rows, created_at) VALUES
  ('a0000001-0000-0000-0000-000000000009', '291075be-3bee-43ff-a296-17c8eecd26a1', 'bom_explosion', 'bom_explosion', 'Seed_Data_BOM_Explosion', 'completed', 100, 72, 72, 0, NOW() - INTERVAL '2 hours')
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  upload_type = EXCLUDED.upload_type,
  target_table = EXCLUDED.target_table,
  filename = EXCLUDED.filename,
  status = EXCLUDED.status,
  progress = EXCLUDED.progress,
  total_rows = EXCLUDED.total_rows,
  success_rows = EXCLUDED.success_rows,
  error_rows = EXCLUDED.error_rows,
  created_at = EXCLUDED.created_at;

-- ============================================================
-- 7. Component Demand (BOM explosion 結果，掛在 baseline run)
-- ============================================================
-- FG-CTRL-500 需求 ~142/wk → RM-IC-MCU32 ×1, RM-CAP-100UF ×12, RM-RES-10K ×24, RM-PLASTIC-ABS ×0.35, RM-STEEL-SH ×2
-- FG-SENS-200 需求 ~92/wk  → RM-IC-MCU32 ×1, RM-CAP-100UF ×12, RM-RES-10K ×24, RM-CONN-USB ×2
-- FG-PWR-100  需求 ~48/wk  → RM-IC-MCU32 ×1, RM-CAP-100UF ×6, RM-CONN-USB ×1, RM-PLASTIC-ABS ×0.35, RM-STEEL-SH ×2
INSERT INTO component_demand (user_id, material_code, plant_id, time_bucket, demand_qty, source_fg_material, bom_level, forecast_run_id, batch_id) VALUES
  -- RM-IC-MCU32: combined from CTRL(142)+SENS(92)+PWR(48) = 282/wk
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W07', 282, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W08', 290, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W09', 278, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W10', 296, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W11', 285, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W12', 288, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  -- RM-CAP-100UF: CTRL 142×12=1704, SENS 92×12=1104, PWR 48×6=288 → ~3096/wk
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W07', 3096, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W08', 3180, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W09', 3020, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W10', 3240, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W11', 3108, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W12', 3144, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  -- RM-RES-10K: (CTRL+SENS)×24 = 234×24 = 5616/wk
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K', 'PLANT-SZ', '2026-W07', 5616, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K', 'PLANT-SZ', '2026-W08', 5808, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K', 'PLANT-SZ', '2026-W09', 5520, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K', 'PLANT-SZ', '2026-W10', 5952, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K', 'PLANT-SZ', '2026-W11', 5712, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K', 'PLANT-SZ', '2026-W12', 5760, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  -- RM-CONN-USB: SENS 92×2=184, PWR 48×1=48 → 232/wk
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB', 'PLANT-SZ', '2026-W07', 232, 'FG-SENS-200', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB', 'PLANT-SZ', '2026-W08', 242, 'FG-SENS-200', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB', 'PLANT-SZ', '2026-W09', 228, 'FG-SENS-200', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB', 'PLANT-SZ', '2026-W10', 252, 'FG-SENS-200', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB', 'PLANT-SZ', '2026-W11', 240, 'FG-SENS-200', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB', 'PLANT-SZ', '2026-W12', 244, 'FG-SENS-200', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  -- RM-PLASTIC-ABS: (CTRL+PWR)×0.35 = 190×0.35 ≈ 66.5 kg/wk
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W07', 66.50, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W08', 68.25, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W09', 65.45, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W10', 70.00, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W11', 67.20, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W12', 68.95, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  -- RM-STEEL-SH: (CTRL+PWR)×2 = 190×2 = 380/wk
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W07', 380, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W08', 390, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W09', 374, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W10', 400, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W11', 384, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W12', 394, 'FG-CTRL-500', 2, 'a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000009');

-- ============================================================
-- 8. Material Stock Snapshots (現在庫存 — Risk Dashboard 用)
-- ============================================================
-- 設計: MCU32 和 PLASTIC-ABS 庫存接近 safety stock → 高風險
--       CONN-USB 庫存剛好 → 中風險（supplier 又不可靠）
--       其他料號庫存充足 → 低風險
INSERT INTO material_stock_snapshots (user_id, material_code, plant_id, storage_location, stock_type, qty, uom, snapshot_at, source) VALUES
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32',    'PLANT-SZ', 'WH01', 'UNRESTRICTED',   320, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF',   'PLANT-SZ', 'WH01', 'UNRESTRICTED', 15000, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K',     'PLANT-SZ', 'WH01', 'UNRESTRICTED', 30000, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB',    'PLANT-SZ', 'WH01', 'UNRESTRICTED',   280, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', 'WH01', 'UNRESTRICTED',    75, 'kg',  NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH',    'PLANT-SZ', 'WH01', 'UNRESTRICTED',  2000, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PCB-A1',     'PLANT-SZ', 'WH02', 'UNRESTRICTED',    80, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-HOUSING-B',  'PLANT-SZ', 'WH02', 'UNRESTRICTED',   100, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PWR-MOD',    'PLANT-SZ', 'WH02', 'UNRESTRICTED',    35, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500',    'PLANT-SZ', 'FG-WH', 'UNRESTRICTED',   60, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200',    'PLANT-SZ', 'FG-WH', 'UNRESTRICTED',   45, 'pcs', NOW(), NULL),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',     'PLANT-SZ', 'FG-WH', 'UNRESTRICTED',   30, 'pcs', NOW(), NULL);

-- ============================================================
-- 9. Inventory Snapshots (legacy 格式, safety_stock 設定)
-- ============================================================
INSERT INTO inventory_snapshots (user_id, material_code, plant_id, snapshot_date, onhand_qty, safety_stock, allocated_qty) VALUES
  -- RM-IC-MCU32: 庫存 320, safety 300 → 接近安全庫存！
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-IC-MCU32',    'PLANT-SZ', CURRENT_DATE,   320,  300, 0),
  -- RM-CAP-100UF: 庫存 15000, safety 5000 → 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CAP-100UF',   'PLANT-SZ', CURRENT_DATE, 15000, 5000, 0),
  -- RM-RES-10K: 庫存 30000, safety 8000 → 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-RES-10K',     'PLANT-SZ', CURRENT_DATE, 30000, 8000, 0),
  -- RM-CONN-USB: 庫存 280, safety 200 → 偏低, supplier 又不可靠
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-CONN-USB',    'PLANT-SZ', CURRENT_DATE,   280,  200, 0),
  -- RM-PLASTIC-ABS: 庫存 75, safety 70 → 極度接近安全庫存！
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-PLASTIC-ABS', 'PLANT-SZ', CURRENT_DATE,    75,   70, 0),
  -- RM-STEEL-SH: 庫存 2000, safety 500 → 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'RM-STEEL-SH',    'PLANT-SZ', CURRENT_DATE,  2000,  500, 0),
  -- SUB/FG: 較低庫存
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PCB-A1',     'PLANT-SZ', CURRENT_DATE,    80,   50, 0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-HOUSING-B',  'PLANT-SZ', CURRENT_DATE,   100,   60, 0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'SUB-PWR-MOD',    'PLANT-SZ', CURRENT_DATE,    35,   30, 0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500',    'PLANT-SZ', CURRENT_DATE,    60,   50, 0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200',    'PLANT-SZ', CURRENT_DATE,    45,   30, 0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',     'PLANT-SZ', CURRENT_DATE,    30,   20, 0);

-- ============================================================
-- 10. Open PO Lines (6 週 horizon, 部分 PO 延遲/短交)
-- ============================================================
-- 設計原則:
--   MCU32: PO 量不足，只夠 2 週 → 後面缺料
--   PLASTIC-ABS: PO 來自 SUP-BETA（延遲率高），promised 在 W08 但可能延到 W10
--   CONN-USB: PO 跨多週但來自 SUP-BETA → 延遲風險
--   其他: 供應充足
INSERT INTO po_open_lines (user_id, po_number, po_line, material_code, plant_id, time_bucket, open_qty, supplier_id, status) VALUES
  -- RM-IC-MCU32: SUP-ALPHA, 只有 W07-W08 有 PO（W09+ 缺 PO → 高風險）
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-001', '10', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W07', 300, 'b0000001-0000-0000-0000-000000000001', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-001', '20', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W08', 280, 'b0000001-0000-0000-0000-000000000001', 'open'),
  -- RM-CAP-100UF: SUP-ALPHA, 充足供應
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-002', '10', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W07', 3200, 'b0000001-0000-0000-0000-000000000001', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-002', '20', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W08', 3200, 'b0000001-0000-0000-0000-000000000001', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-002', '30', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W09', 3200, 'b0000001-0000-0000-0000-000000000001', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-002', '40', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W10', 3200, 'b0000001-0000-0000-0000-000000000001', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-002', '50', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W11', 3200, 'b0000001-0000-0000-0000-000000000001', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-002', '60', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W12', 3200, 'b0000001-0000-0000-0000-000000000001', 'open'),
  -- RM-RES-10K: SUP-GAMMA, 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-003', '10', 'RM-RES-10K', 'PLANT-SZ', '2026-W07', 6000, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-003', '20', 'RM-RES-10K', 'PLANT-SZ', '2026-W08', 6000, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-003', '30', 'RM-RES-10K', 'PLANT-SZ', '2026-W09', 6000, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-003', '40', 'RM-RES-10K', 'PLANT-SZ', '2026-W10', 6000, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-003', '50', 'RM-RES-10K', 'PLANT-SZ', '2026-W11', 6000, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-003', '60', 'RM-RES-10K', 'PLANT-SZ', '2026-W12', 6000, 'b0000001-0000-0000-0000-000000000003', 'open'),
  -- RM-CONN-USB: SUP-BETA（不可靠！），PO 有但延遲機率高
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-004', '10', 'RM-CONN-USB', 'PLANT-SZ', '2026-W07', 250, 'b0000001-0000-0000-0000-000000000002', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-004', '20', 'RM-CONN-USB', 'PLANT-SZ', '2026-W08', 250, 'b0000001-0000-0000-0000-000000000002', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-004', '30', 'RM-CONN-USB', 'PLANT-SZ', '2026-W09', 250, 'b0000001-0000-0000-0000-000000000002', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-004', '40', 'RM-CONN-USB', 'PLANT-SZ', '2026-W10', 250, 'b0000001-0000-0000-0000-000000000002', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-004', '50', 'RM-CONN-USB', 'PLANT-SZ', '2026-W11', 250, 'b0000001-0000-0000-0000-000000000002', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-004', '60', 'RM-CONN-USB', 'PLANT-SZ', '2026-W12', 250, 'b0000001-0000-0000-0000-000000000002', 'open'),
  -- RM-PLASTIC-ABS: SUP-BETA（不可靠！），PO 只有 W08 和 W10 → 缺料風險
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-005', '10', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W08', 130, 'b0000001-0000-0000-0000-000000000002', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-005', '20', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W10', 140, 'b0000001-0000-0000-0000-000000000002', 'open'),
  -- RM-STEEL-SH: SUP-GAMMA, 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-006', '10', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W07', 400, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-006', '20', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W08', 400, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-006', '30', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W09', 400, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-006', '40', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W10', 400, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-006', '50', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W11', 400, 'b0000001-0000-0000-0000-000000000003', 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-006', '60', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W12', 400, 'b0000001-0000-0000-0000-000000000003', 'open'),
  -- SUB-PCB-A1: 內部生產，不經 PO，但這裡放一筆代表內部移轉
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-007', '10', 'SUB-PCB-A1', 'PLANT-SZ', '2026-W07', 200, NULL, 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-007', '20', 'SUB-PCB-A1', 'PLANT-SZ', '2026-W08', 200, NULL, 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-007', '30', 'SUB-PCB-A1', 'PLANT-SZ', '2026-W09', 200, NULL, 'open'),
  -- SUB-HOUSING-B: 內部，來自 PLASTIC-ABS（upstream risk）
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-008', '10', 'SUB-HOUSING-B', 'PLANT-SZ', '2026-W07', 180, NULL, 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-008', '20', 'SUB-HOUSING-B', 'PLANT-SZ', '2026-W08', 180, NULL, 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-008', '30', 'SUB-HOUSING-B', 'PLANT-SZ', '2026-W09', 180, NULL, 'open'),
  -- SUB-PWR-MOD: 低量
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-009', '10', 'SUB-PWR-MOD', 'PLANT-SZ', '2026-W07', 50, NULL, 'open'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PO-2026-009', '20', 'SUB-PWR-MOD', 'PLANT-SZ', '2026-W08', 50, NULL, 'open');

-- ============================================================
-- 11. FG Financials (成品利潤)
-- ============================================================
INSERT INTO fg_financials (user_id, material_code, plant_id, unit_margin, unit_price, currency) VALUES
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-CTRL-500', 'PLANT-SZ', 85.00, 320.00, 'USD'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-SENS-200', 'PLANT-SZ', 42.00, 158.00, 'USD'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'FG-PWR-100',  'PLANT-SZ', 28.00,  99.00, 'USD');

-- ============================================================
-- 12. Revenue Terms (M6 用)
-- ============================================================
INSERT INTO revenue_terms (user_id, plant_id, fg_material_code, currency, margin_per_unit, price_per_unit, penalty_type, penalty_value) VALUES
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PLANT-SZ', 'FG-CTRL-500', 'USD', 85.00, 320.00, 'per_unit', 15.00),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PLANT-SZ', 'FG-SENS-200', 'USD', 42.00, 158.00, 'per_unit',  8.00),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'PLANT-SZ', 'FG-PWR-100',  'USD', 28.00,  99.00, 'none',      0.00);

-- ============================================================
-- 13. Supplier Supply Stats (per-run KPI)
-- ============================================================
INSERT INTO supplier_supply_stats (user_id, forecast_run_id, supplier_id, plant_id, sample_size, lead_time_p50_days, lead_time_p90_days, on_time_rate, short_ship_rate, model_version, metrics) VALUES
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'SUP-ALPHA', 'PLANT-SZ', 48, 12, 16, 0.95, 0.02, 'v1', '{"avg_delay_days":1.2}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'SUP-BETA',  'PLANT-SZ', 35, 24, 38, 0.62, 0.15, 'v1', '{"avg_delay_days":8.5,"quality_reject_rate":0.04}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'SUP-GAMMA', 'PLANT-SZ', 42, 9,  14, 0.88, 0.05, 'v1', '{"avg_delay_days":2.8}'::jsonb);

-- ============================================================
-- 14. Supply Forecast Inbound (聚合到 bucket)
-- ============================================================
INSERT INTO supply_forecast_inbound (user_id, forecast_run_id, material_code, plant_id, time_bucket, p50_qty, p90_qty, model_version) VALUES
  -- RM-IC-MCU32: 只有 W07-W08 有 inbound
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W07', 300, 285, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W08', 280, 260, 'v1'),
  -- RM-CAP-100UF: 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W07', 3200, 3100, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W08', 3200, 3100, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W09', 3200, 3100, 'v1'),
  -- RM-CONN-USB: 量夠但來自 SUP-BETA，delay 機率高 → p90 明顯低於 p50
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W07', 250, 155, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W08', 250, 155, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W09', 250, 155, 'v1'),
  -- RM-PLASTIC-ABS: 來自 SUP-BETA，只有 W08 和 W10 有 PO
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W08', 130, 80, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W10', 140, 85, 'v1'),
  -- RM-STEEL-SH: 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W07', 400, 380, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W08', 400, 380, 'v1'),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-STEEL-SH', 'PLANT-SZ', '2026-W09', 400, 380, 'v1');

-- ============================================================
-- 15. Margin at Risk Results (M6)
-- ============================================================
INSERT INTO margin_at_risk_results (user_id, forecast_run_id, source_bom_run_id, risk_input_mode, fg_material_code, plant_id, time_bucket, demand_qty, shortage_qty, p_stockout, margin_per_unit, price_per_unit, penalty_type, penalty_value, impacted_qty, expected_margin_at_risk, expected_penalty_at_risk, inputs) VALUES
  -- FG-CTRL-500: W09+ MCU32 缺料導致停產，shortage 約 142 units
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001',
   'probabilistic', 'FG-CTRL-500', 'PLANT-SZ', '2026-W09', 140, 85, 0.72,
   85.00, 320.00, 'per_unit', 15.00, 85, 7225.00, 1275.00,
   '{"demand_source":"demand_forecast","allocation_rule":"fg_only"}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001',
   'probabilistic', 'FG-CTRL-500', 'PLANT-SZ', '2026-W10', 148, 148, 0.88,
   85.00, 320.00, 'per_unit', 15.00, 148, 12580.00, 2220.00,
   '{"demand_source":"demand_forecast","allocation_rule":"fg_only"}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001',
   'probabilistic', 'FG-CTRL-500', 'PLANT-SZ', '2026-W11', 143, 143, 0.92,
   85.00, 320.00, 'per_unit', 15.00, 143, 12155.00, 2145.00,
   '{"demand_source":"demand_forecast","allocation_rule":"fg_only"}'::jsonb),
  -- FG-SENS-200: CONN-USB delay 可能造成部分停產
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001',
   'probabilistic', 'FG-SENS-200', 'PLANT-SZ', '2026-W08', 97, 22, 0.38,
   42.00, 158.00, 'per_unit', 8.00, 22, 924.00, 176.00,
   '{"demand_source":"demand_forecast","allocation_rule":"fg_only"}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001',
   'probabilistic', 'FG-SENS-200', 'PLANT-SZ', '2026-W09', 102, 35, 0.45,
   42.00, 158.00, 'per_unit', 8.00, 35, 1470.00, 280.00,
   '{"demand_source":"demand_forecast","allocation_rule":"fg_only"}'::jsonb),
  -- FG-PWR-100: PLASTIC-ABS 缺料 → PWR 也受影響
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000001',
   'probabilistic', 'FG-PWR-100', 'PLANT-SZ', '2026-W09', 47, 18, 0.35,
   28.00, 99.00, 'none', 0.00, 18, 504.00, 0.00,
   '{"demand_source":"demand_forecast","allocation_rule":"fg_only"}'::jsonb);

-- ============================================================
-- 16. Risk Score Results (M7)
-- ============================================================
INSERT INTO risk_score_results (user_id, forecast_run_id, material_code, plant_id, p_stockout, impact_usd, earliest_stockout_bucket, urgency_weight, score, breakdown_json, version, score_algorithm) VALUES
  -- RM-IC-MCU32: 高風險 — W09 缺料, 影響 CTRL+SENS+PWR
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ',
   0.85, 31960.00, '2026-W09', 1.0, 27166.00,
   '{"p_stockout_source":"probabilistic","impact_source":"margin_at_risk","urgency_calculation":"W+2=1.0","formula":"0.85 * 31960 * 1.0 = 27166"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- RM-PLASTIC-ABS: 高風險 — 庫存幾乎耗盡, supplier 不可靠
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ',
   0.78, 12659.00, '2026-W08', 1.2, 11849.26,
   '{"p_stockout_source":"probabilistic","impact_source":"margin_at_risk","urgency_calculation":"W+1=1.2","formula":"0.78 * 12659 * 1.2 = 11849.26"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- RM-CONN-USB: 中風險 — supplier delay 造成間歇性缺料
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ',
   0.42, 2394.00, '2026-W08', 1.2, 1206.58,
   '{"p_stockout_source":"probabilistic","impact_source":"margin_at_risk","urgency_calculation":"W+1=1.2","formula":"0.42 * 2394 * 1.2 = 1206.58"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- RM-CAP-100UF: 低風險
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ',
   0.05, 0, NULL, 0.5, 0,
   '{"p_stockout_source":"probabilistic","impact_source":"no_revenue_data","urgency_calculation":"no_risk=0.5","formula":"0.05 * 0 * 0.5 = 0"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- RM-RES-10K: 低風險
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-RES-10K', 'PLANT-SZ',
   0.03, 0, NULL, 0.5, 0,
   '{"p_stockout_source":"probabilistic","impact_source":"no_revenue_data","urgency_calculation":"no_risk=0.5","formula":"0.03 * 0 * 0.5 = 0"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- RM-STEEL-SH: 低風險
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-STEEL-SH', 'PLANT-SZ',
   0.04, 0, NULL, 0.5, 0,
   '{"p_stockout_source":"probabilistic","impact_source":"no_revenue_data","urgency_calculation":"no_risk=0.5","formula":"0.04 * 0 * 0.5 = 0"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- SUB-PCB-A1: 中風險（受 MCU32 upstream）
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'SUB-PCB-A1', 'PLANT-SZ',
   0.55, 15000.00, '2026-W09', 1.0, 8250.00,
   '{"p_stockout_source":"deterministic","impact_source":"margin_at_risk","urgency_calculation":"W+2=1.0","formula":"0.55 * 15000 * 1.0 = 8250"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- SUB-HOUSING-B: 中風險（受 PLASTIC-ABS upstream）
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'SUB-HOUSING-B', 'PLANT-SZ',
   0.48, 8500.00, '2026-W08', 1.2, 4896.00,
   '{"p_stockout_source":"deterministic","impact_source":"margin_at_risk","urgency_calculation":"W+1=1.2","formula":"0.48 * 8500 * 1.2 = 4896"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- SUB-PWR-MOD: 中低風險
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'SUB-PWR-MOD', 'PLANT-SZ',
   0.30, 2500.00, '2026-W09', 1.0, 750.00,
   '{"p_stockout_source":"deterministic","impact_source":"margin_at_risk","urgency_calculation":"W+2=1.0","formula":"0.30 * 2500 * 1.0 = 750"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- FG-CTRL-500: 高風險 — MCU32 缺料導致 FG 停產
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'FG-CTRL-500', 'PLANT-SZ',
   0.72, 31960.00, '2026-W09', 1.0, 23011.20,
   '{"p_stockout_source":"probabilistic","impact_source":"margin_at_risk","urgency_calculation":"W+2=1.0","formula":"0.72 * 31960 * 1.0 = 23011.20"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- FG-SENS-200: 中風險 — CONN-USB delay 風險
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'FG-SENS-200', 'PLANT-SZ',
   0.38, 2394.00, '2026-W08', 1.2, 1091.66,
   '{"p_stockout_source":"probabilistic","impact_source":"margin_at_risk","urgency_calculation":"W+1=1.2","formula":"0.38 * 2394 * 1.2 = 1091.66"}'::jsonb,
   '1.0.0', 'mvp_v1'),
  -- FG-PWR-100: 中風險 — PLASTIC-ABS 缺料影響
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'FG-PWR-100', 'PLANT-SZ',
   0.35, 504.00, '2026-W09', 1.0, 176.40,
   '{"p_stockout_source":"probabilistic","impact_source":"margin_at_risk","urgency_calculation":"W+2=1.0","formula":"0.35 * 504 * 1.0 = 176.40"}'::jsonb,
   '1.0.0', 'mvp_v1');

-- ============================================================
-- 17. Inventory Forecast Prob Summary (Monte Carlo 結果)
-- ============================================================
INSERT INTO inventory_forecast_prob_summary (user_id, forecast_run_id, material_code, plant_id, trials, p_stockout, stockout_bucket_p50, stockout_bucket_p90, expected_shortage_qty, expected_min_available, metrics) VALUES
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32',    'PLANT-SZ', 500, 0.85, '2026-W09', '2026-W08', 420, -98,  '{"compute_ms":45}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', 500, 0.78, '2026-W08', '2026-W07', 185,  -8,  '{"compute_ms":38}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB',    'PLANT-SZ', 500, 0.42, '2026-W08', '2026-W07', 65,   15,  '{"compute_ms":32}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF',   'PLANT-SZ', 500, 0.05, NULL,        NULL,        0, 4200,  '{"compute_ms":35}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-RES-10K',     'PLANT-SZ', 500, 0.03, NULL,        NULL,        0, 12000, '{"compute_ms":30}'::jsonb),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-STEEL-SH',    'PLANT-SZ', 500, 0.04, NULL,        NULL,        0,  800,  '{"compute_ms":28}'::jsonb);

-- ============================================================
-- 18. Inventory Forecast Prob Series (Fan Chart 用)
-- ============================================================
INSERT INTO inventory_forecast_prob_series (user_id, forecast_run_id, material_code, plant_id, time_bucket, inv_p10, inv_p50, inv_p90, p_stockout_bucket) VALUES
  -- RM-IC-MCU32: 庫存快速下降，W09 跌破 0
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W07', 305, 338, 360, 0.02),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W08', 250, 328, 352, 0.08),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W09', -45,  50, 120, 0.65),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W10',-330,-228, -80, 0.92),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W11',-620,-513,-340, 0.97),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-IC-MCU32', 'PLANT-SZ', '2026-W12',-910,-801,-600, 0.99),
  -- RM-PLASTIC-ABS: 庫存迅速耗盡，W08 partial, W09 stockout
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W07', -2,  8.5,  20, 0.18),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W08', 30,  72, 105, 0.05),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W09',-40,   3,  42, 0.58),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W10',  5,  73, 110, 0.12),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W11',-62,   3,  45, 0.55),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-PLASTIC-ABS', 'PLANT-SZ', '2026-W12',-130, -65,  -5, 0.85),
  -- RM-CONN-USB: 波動（supplier delay 造成間歇性缺料）
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W07',  10,  48, 120, 0.10),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W08', -25,  56, 145, 0.22),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W09', -10,  78, 160, 0.15),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W10',  -5,  86, 175, 0.12),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W11',  15, 104, 195, 0.08),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CONN-USB', 'PLANT-SZ', '2026-W12',  20, 110, 210, 0.06),
  -- RM-CAP-100UF: 充足
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W07', 14800, 15104, 15400, 0.0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W08', 14600, 15024, 15350, 0.0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W09', 14500, 15200, 15600, 0.0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W10', 14200, 14960, 15400, 0.0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W11', 14000, 15052, 15500, 0.0),
  ('291075be-3bee-43ff-a296-17c8eecd26a1', 'a0000001-0000-0000-0000-000000000001', 'RM-CAP-100UF', 'PLANT-SZ', '2026-W12', 13800, 15108, 15600, 0.0);

-- ============================================================
-- Done! 驗證查詢
-- ============================================================
-- SELECT 'materials' AS tbl, COUNT(*) FROM materials WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'suppliers', COUNT(*) FROM suppliers WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'po_open_lines', COUNT(*) FROM po_open_lines WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'material_stock_snapshots', COUNT(*) FROM material_stock_snapshots WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'inventory_snapshots', COUNT(*) FROM inventory_snapshots WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'demand_fg', COUNT(*) FROM demand_fg WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'demand_forecast', COUNT(*) FROM demand_forecast WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'component_demand', COUNT(*) FROM component_demand WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'bom_edges', COUNT(*) FROM bom_edges WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'fg_financials', COUNT(*) FROM fg_financials WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'risk_score_results', COUNT(*) FROM risk_score_results WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'margin_at_risk_results', COUNT(*) FROM margin_at_risk_results WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
-- UNION ALL SELECT 'forecast_runs', COUNT(*) FROM forecast_runs WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';
