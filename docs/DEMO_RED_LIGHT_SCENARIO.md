# Step 3 (P0): Red Light Demo Scenario Setup

This document describes how to create a convincing demo scenario where P(stockout) > 20% with visible fan chart divergence.

## Goal

Create a scenario where:
- At least 1 key has P(stockout) > 20% (amber/red zone)
- Deterministic also shows shortage (directional alignment)
- Fan chart shows clear divergence (p10/p50/p90 spread apart)

## Method: "Zero Inventory + High Demand + Delayed Inbound"

### Step 1: Prepare Test Data

Upload these files (or run SQL below):

#### 1.1 inventory_snapshots.csv - ZERO on-hand
```csv
material_code,plant_id,snapshot_date,onhand_qty,available_qty
COMP-001,PLANT-01,2026-02-06,0,0
COMP-002,PLANT-01,2026-02-06,0,0
COMP-003,PLANT-01,2026-02-06,5,5
```

#### 1.2 demand_fg.csv - HIGH demand
```csv
material_code,plant_id,time_bucket,demand_qty,uom
FG-2000,PLANT-01,2026-W05,5000,pcs
FG-2000,PLANT-01,2026-W06,8000,pcs
FG-2000,PLANT-01,2026-W07,6000,pcs
```

#### 1.3 bom_edge.csv (existing should work)
```csv
parent_material,child_material,qty_per,plant_id,uom
FG-2000,COMP-001,1.0,PLANT-01,pcs
FG-2000,COMP-002,1.0,PLANT-01,pcs
FG-2000,COMP-003,0.5,PLANT-01,pcs
```

#### 1.4 po_open_lines.csv - DELAYED inbound
```csv
po_number,po_line,material_code,plant_id,time_bucket,open_qty,supplier_id
PO-001,1,COMP-001,PLANT-01,2026-W07,2000,SUP-001
PO-002,1,COMP-002,PLANT-01,2026-W07,3000,SUP-002
```

### Step 2: Alternative SQL Setup (Direct DB Insert)

Run this SQL in Supabase SQL Editor:

```sql
-- Step 2.1: Clear existing data for clean demo
DELETE FROM inventory_snapshots WHERE user_id = 'YOUR_USER_ID';
DELETE FROM demand_fg WHERE user_id = 'YOUR_USER_ID';
DELETE FROM po_open_lines WHERE user_id = 'YOUR_USER_ID';

-- Step 2.2: Insert ZERO inventory snapshots
INSERT INTO inventory_snapshots (user_id, material_code, plant_id, snapshot_date, onhand_qty, available_qty, batch_id)
VALUES
  ('YOUR_USER_ID', 'COMP-001', 'PLANT-01', '2026-02-06', 0, 0, 'demo-batch'),
  ('YOUR_USER_ID', 'COMP-002', 'PLANT-01', '2026-02-06', 0, 0, 'demo-batch'),
  ('YOUR_USER_ID', 'COMP-003', 'PLANT-01', '2026-02-06', 5, 5, 'demo-batch');

-- Step 2.3: Insert HIGH demand_fg
INSERT INTO demand_fg (user_id, material_code, plant_id, time_bucket, demand_qty, uom, batch_id)
VALUES
  ('YOUR_USER_ID', 'FG-2000', 'PLANT-01', '2026-W05', 5000, 'pcs', 'demo-batch'),
  ('YOUR_USER_ID', 'FG-2000', 'PLANT-01', '2026-W06', 8000, 'pcs', 'demo-batch'),
  ('YOUR_USER_ID', 'FG-2000', 'PLANT-01', '2026-W07', 6000, 'pcs', 'demo-batch');

-- Step 2.4: Insert DELAYED PO lines (arrive late)
INSERT INTO po_open_lines (user_id, po_number, po_line, material_code, plant_id, time_bucket, open_qty, supplier_id, status, batch_id)
VALUES
  ('YOUR_USER_ID', 'PO-001', 1, 'COMP-001', 'PLANT-01', '2026-W07', 2000, 'SUP-001', 'open', 'demo-batch'),
  ('YOUR_USER_ID', 'PO-002', 1, 'COMP-002', 'PLANT-01', '2026-W07', 3000, 'SUP-002', 'open', 'demo-batch');
```

### Step 3: Execute BOM Explosion

1. Go to **Forecasts → BOM Explosion**
2. Set:
   - Demand Source: `Uploaded demand_fg`
   - Inbound Source: `Raw PO Open Lines`
   - Plant ID: `PLANT-01`
   - Time Buckets: `2026-W05, 2026-W06, 2026-W07`
3. Click **"Run BOM Explosion"**
4. Note the new **Run ID**

### Step 4: Run Monte Carlo

1. Go to **Inventory (Projection)** tab
2. Select the new Run from Step 3
3. Switch to **"Probabilistic (Monte Carlo)"**
4. Set:
   - Trials: `500` (higher for smoother distribution)
   - Seed: `12345`
5. Click **"Run Monte Carlo"**

### Step 5: Verify Red Light in Risk Dashboard

1. Go to **Risk Dashboard**
2. Select the same Forecast Run
3. Look for:
   - **COMP-001|PLANT-01**: Should show P(Stockout) > 50% (red)
   - **COMP-002|PLANT-01**: Should show P(Stockout) > 30% (amber/red)
   - **COMP-003|PLANT-01**: Lower risk (some inventory buffer)

### Expected Results

| Key | On-Hand | Demand (BOM) | Inbound | Expected P(Stockout) | Color |
|-----|---------|--------------|---------|---------------------|-------|
| COMP-001\|PLANT-01 | 0 | 5000+8000+6000 | 2000 (W07) | ~80% | 🔴 Red |
| COMP-002\|PLANT-01 | 0 | 5000+8000+6000 | 3000 (W07) | ~60% | 🔴 Red |
| COMP-003\|PLANT-01 | 5 | 2500+4000+3000 | 0 | ~40% | 🟠 Amber |

### Fan Chart Divergence

For COMP-001, expect to see:

| Bucket | inv_p10 | inv_p50 | inv_p90 | P(Stockout) |
|--------|---------|---------|---------|-------------|
| 2026-W05 | -6000 | -5000 | -4000 | 100% |
| 2026-W06 | -14000 | -13000 | -12000 | 100% |
| 2026-W07 | -16000 | -15000 | -8000 | 90% |

Note: Negative inventory = shortage. P10 more negative than P90 shows uncertainty range.

### Demo Script for PM/Customer

**Setup**: "We have a critical component COMP-001 with zero inventory, but FG demand requires 5000-8000 units per week. The only inbound PO is 2000 units arriving in W07 - way too late."

**Deterministic View**: "Classic view shows shortage of 16,000 units - critical red."

**Probabilistic View**: "But reality has uncertainty. Let's run Monte Carlo with 500 trials..."

**Results**: "P(stockout) = 80% - almost certain. But look at the fan chart - the P10 worst case is -20,000 shortage, while P90 best case is still -8,000. Even in the best scenario, we're short."

**Action**: "This tells us expediting the W07 PO won't help - we need emergency sourcing or demand reduction."

---

## Quick SQL Verification

```sql
-- Check P(stockout) results
SELECT 
  material_code, 
  plant_id, 
  p_stockout,
  stockout_bucket_p50,
  stockout_bucket_p90,
  expected_shortage_qty
FROM inventory_forecast_prob_summary 
WHERE forecast_run_id = 'YOUR_RUN_ID'
ORDER BY p_stockout DESC;

-- Check series divergence
SELECT 
  material_code,
  time_bucket,
  inv_p10,
  inv_p50,
  inv_p90,
  p_stockout_bucket
FROM inventory_forecast_prob_series
WHERE forecast_run_id = 'YOUR_RUN_ID'
  AND material_code = 'COMP-001'
ORDER BY time_bucket;
```
