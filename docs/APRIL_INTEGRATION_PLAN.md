# April Integration Plan — Tool Testing & Pipeline Wiring

**Goal:** Test every engine independently, then wire them into the General Agent as a connected pipeline.  
**Deadline:** May 1, 2026 (Venture Snapshot submission)  
**Principle:** Test first, then integrate. Don't integrate untested tools.

---

## Phase 1: Independent Tool Testing (Week 1)

Test each engine standalone with sample data. Confirm it runs, output is correct, and we know the input/output format.

### 1.1 Forecast Engine 🔴
- **Endpoint:** `POST /demand-forecast`
- **Input:** time series (date + qty/revenue)
- **Test data:** golden dataset `sales_transactions` sheet (order_date + qty)
- **Expected output:** predictions[], p10[], p50[], p90[], model_used, metrics (MAPE/MAE)
- **Verify:** predictions are non-negative, p10 ≤ p50 ≤ p90, horizon matches request
- **Status:** [ ] Tested independently / [ ] Output verified

### 1.2 Replenishment Solver 🔴
- **Endpoint:** `POST /replenishment-plan`
- **Input:** demand forecast + inventory + constraints (MOQ, lead time, budget)
- **Test data:** golden dataset (inventory_snapshot + forecast output from 1.1)
- **Expected output:** plan_lines[], solver_meta, status (OPTIMAL/FEASIBLE/INFEASIBLE)
- **Verify:** order qty ≥ 0, MOQ respected, budget not exceeded
- **Status:** [ ] Tested independently / [ ] Output verified

### 1.3 Risk Scoring 🔴
- **Endpoint:** via `_execute_tool("risk_score", ...)`
- **Input:** forecast + inventory + supplier data
- **Test data:** golden dataset (supplier_invoices + inventory_snapshot)
- **Expected output:** risk scores per SKU, tier (HIGH/MEDIUM/LOW), coverage days
- **Verify:** scores are numeric, tiers make sense relative to inventory levels
- **Status:** [ ] Tested independently / [ ] Output verified

### 1.4 BOM Explosion 🟡
- **Endpoint:** via `_execute_tool("bom_explosion", ...)`
- **Input:** finished goods demand + BOM edges
- **Test data:** golden dataset (bom_edges + sales_transactions)
- **Expected output:** component-level demand, bottlenecks
- **Verify:** component qty = FG demand × qty_per × (1+scrap) / yield
- **Status:** [ ] Tested independently / [ ] Output verified

### 1.5 Backtest 🟡
- **Endpoint:** `POST /backtest`
- **Input:** historical time series (min 17 points)
- **Test data:** golden dataset sales aggregated by date
- **Expected output:** per-model MAPE/MAE, best model, consensus level
- **Verify:** best model has lowest MAPE, all models attempted
- **Status:** [ ] Tested independently / [ ] Output verified

### 1.6 Simulation (Digital Twin) 🟢
- **Endpoint:** JS `run_digital_twin_simulation` (already verified ✅)
- **Status:** [x] Tested independently / [x] Output verified

### 1.7 CFR Negotiation 🟢
- **Endpoint:** JS `run_negotiation` via orchestrator
- **Input:** plan result + risk scores + supplier context
- **Test data:** need to construct negotiation scenario from golden dataset
- **Expected output:** negotiation options, CFR strategy, recommendation
- **Verify:** options are ranked, strategy makes business sense
- **Status:** [ ] Tested independently / [ ] Output verified

---

## Phase 2: Pipeline Wiring (Week 2)

Wire tested tools into `_execute_tool()` so the General Agent can use them.

### 2.1 Add Forecast to _execute_tool
- Map `run_forecast` catalog ID → Python forecast engine
- Input: sheets_data with date + qty columns
- Output: forecast_series artifact with predictions + p10/p50/p90
- Agent can select this when data has time series

### 2.2 Add Solver to _execute_tool
- Map `run_plan` catalog ID → Python solver
- Input: forecast output (from prior tool) + inventory data
- Output: plan_lines artifact
- Depends on: forecast must run first (dependency resolver handles this)

### 2.3 Add Risk Score to _execute_tool
- Map `run_risk_score` catalog ID → Python risk scorer
- Input: forecast + inventory + supplier data
- Output: risk scores artifact
- Depends on: forecast

### 2.4 Add BOM to _execute_tool
- Map `run_bom_explosion` → Python BOM exploder
- Input: forecast + bom_edges
- Output: component demand artifact
- Depends on: forecast

### 2.5 Update Tool Selector Prompt
- Add rules for when to select forecast/plan/risk/BOM
- Forecast: when data has date column + numeric demand/qty column + ≥30 rows
- Plan: when forecast exists + inventory data exists
- Risk: when supplier/inventory data exists
- BOM: when bom_edges sheet exists

---

## Phase 3: End-to-End Pipeline Test (Week 3)

### 3.1 Full MBR Pipeline ✅ PASSED (EXP-018)
Upload golden dataset → Agent selected:
clean → forecast → BOM → anomaly → KPI → plan → risk (7 tools)
Verified: all tools run, forecast→plan chaining works, KPI/BOM match hand calc, 41.7s total

### 3.2 Full Planning Pipeline  
Upload data with demand + inventory + suppliers → Agent should select:
clean → forecast → plan → risk → anomaly
Verify: plan uses forecast output, risk uses plan output

### 3.3 EMS/ODM Pipeline
Upload ems_odm_sample.xlsx → Agent should select:
clean → domain-appropriate KPIs → anomaly
Verify: procurement KPIs (not revenue/margin), production KPIs (yield, completion rate)

---

## Phase 4: Venture Snapshot Update (Week 4)

### 4.1 Update Snapshot with honest status
- Mark which layers are verified end-to-end
- Mark which layers are independently tested but not integrated
- Update experiment log with new experiments from Phase 1-3

### 4.2 Record demo video (if needed)
- Full pipeline demo: upload → forecast → plan → risk → report
- Show audit trail at each step

### 4.3 Submit before May 1
- Convert to PDF
- Upload via submission form
- Receive Experiment Log form link

---

## Experiment Log Entries to Create

Each test in Phase 1-3 should generate an experiment log entry:

- [ ] EXP-012: Forecast engine standalone test (accuracy, model selection)
- [ ] EXP-013: Solver standalone test (optimality, constraint satisfaction)
- [ ] EXP-014: Risk scoring standalone test (score distribution, tier accuracy)
- [ ] EXP-015: BOM explosion standalone test (component demand accuracy)
- [ ] EXP-016: Forecast → Solver pipeline integration
- [ ] EXP-017: Full planning pipeline end-to-end
- [ ] EXP-018: EMS/ODM domain detection and KPI calculation
- [ ] EXP-019: Backtest accuracy across 5 models

---

## Tools Already Verified ✅

| Tool | Verified | Evidence |
|------|----------|---------|
| Data Cleaning | ✅ | 5 datasets, golden answer keys |
| KPI Calculation | ✅ | 5 datasets, hand-calculated ground truth |
| Variance Analysis | ✅ | Golden dataset, waterfall decomposition |
| Anomaly Detection | ✅ | IQR + z-score, 89 anomalies in golden data |
| EDA | ✅ | Statistics + correlations + quality score |
| Regression | ✅ | OLS R²=0.95 on test data |
| Format Validation | ✅ | Chinese income statement correctly rejected |
| Domain Detection | ✅ | EMS/ODM procurement data identified |
| SQL Query (DuckDB) | ✅ | Olist data queried successfully |
| Chart Generation | ✅ | Revenue by category chart |
| Digital Twin Simulation | ✅ | 30-day simulation, fill rate 99.13% |

---

*Last updated: 2026-04-04*
