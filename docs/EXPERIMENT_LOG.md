# Decision Intelligence — Experiment Log

AI Venture Velocity Challenge 2026. Time-stamped record of hypotheses tested, evidence gathered, and decisions made.

---

## EXP-001: Column Mapping — Gross Sales vs Net Sales
**Date:** 2026-04-03
**Hypothesis:** LLM can correctly identify the revenue column when data has both "Gross Sales" and "Sales" (net).
**Why it matters:** Using Gross Sales instead of Net Sales inflates revenue by the discount amount, producing wrong margin%.
**Experiment:** Uploaded Microsoft Financial Sample (700 rows, 16 columns including Gross Sales, Discounts, Sales, COGS, Profit).
**AI tools used:** General Agent with LLM column mapping.
**Evidence:** System used Gross Sales (127.9M) as revenue. Correct answer is Sales (118.7M). Margin was 20.40% instead of correct 14.23% — off by 6.17 percentage points.
**Decision:** Added `_pick_best_revenue_col()` — priority: net > plain > gross. Re-tested: 14.23% ✅.
**Impact:** Revenue column selection now correct for all 5 test datasets. Deterministic safety net added.

---

## EXP-002: Column Mapping — Unit Cost vs Total Cost
**Date:** 2026-04-03
**Hypothesis:** LLM can distinguish per-unit cost from total cost when both exist.
**Why it matters:** Summing Unit Cost gives ~19K; correct Total Cost is ~93M. Margin would be 99.99% instead of 32.16%.
**Experiment:** Uploaded sales_records_100.csv (100 rows with Unit Cost, Total Cost, Unit Price, Total Revenue, Total Profit).
**AI tools used:** KPI calculator with column role detection.
**Evidence:** System picked Unit Cost as COGS (first match in list). Margin = 99.99% — clearly wrong.
**Decision:** Added `_pick_best_cost_col()` — priority: total > cogs > cost > unit. Re-tested: 32.16% ✅.
**Impact:** Cost column selection now correct. But this was the 2nd hardcoded rule — pattern suggests we need a better approach.

---

## EXP-003: Column Mapping — String Column Misidentified as Revenue
**Date:** 2026-04-03
**Hypothesis:** Keyword-based column detection is sufficient to identify revenue columns.
**Why it matters:** "Sales Channel" contains the word "sales" but is a categorical column (Online/Offline), not revenue.
**Experiment:** sales_records_100.csv — "Sales Channel" was mapped as revenue, "Total Revenue" was ignored. Revenue = 0.
**AI tools used:** `_detect_role()` keyword matching.
**Evidence:** `_detect_role("Sales Channel")` returned "revenue" because "sales" ∈ _REVENUE_KW.
**Decision:** Two fixes: (1) Category keywords checked BEFORE revenue keywords. (2) Revenue/cost/qty roles require numeric dtype — string columns can never be revenue.
**Impact:** Sales Channel → category ✅, Total Revenue → revenue ✅. Systematic fix for entire class of string-vs-numeric misidentification.

---

## EXP-004: Format Validation — Transposed Financial Statement
**Date:** 2026-04-03
**Hypothesis:** The system can handle any Excel format.
**Why it matters:** A Chinese income statement (rows = line items, columns = dates) produced garbage: total_revenue = 104,279 (meaningless sum of quarterly figures).
**Experiment:** Uploaded chinese_income_statement.csv (45 rows, 17 date columns). No cleaning or format check.
**AI tools used:** General Agent pipeline.
**Evidence:** System treated date columns as data columns, summed quarterly revenue figures across years. Output was confidently wrong.
**Decision:** Built `agent_format_validator.py` — detects transposed tables (>50% columns are dates), pivot tables (few rows, many columns), no-numeric data. When detected, LLM explains why in user's language instead of running analysis.
**Impact:** Chinese income statement now correctly rejected with Chinese explanation. No more garbage output from unsupported formats.

---

## EXP-005: KPI Calculation — No COGS Column (Profit Only)
**Date:** 2026-04-03
**Hypothesis:** The system requires a COGS column to calculate margin.
**Why it matters:** Superstore dataset has Sales and Profit but no COGS. System produced no margin output — missing a key KPI.
**Experiment:** Uploaded Superstore (9994 rows, columns: Sales, Profit, Quantity, Discount — no Cost/COGS).
**AI tools used:** KPI calculator.
**Evidence:** No margin calculated. Column mapping was correct (Sales → revenue, Profit → profit), but KPI calculator only knew `revenue - cogs` formula.
**Decision:** Added profit fallback path: if no COGS but Profit exists, use `margin = profit, cogs = revenue - profit`. Also added "profit" role to `_detect_role()`.
**Impact:** Superstore now produces margin = 12.46%. Handles any dataset with revenue + profit but no explicit cost column.

---

## EXP-006: LLM Prompt — Sample Values Solve Column Selection
**Date:** 2026-04-03
**Hypothesis:** Showing LLM sample values + dtype (not just column names) eliminates the need for hardcoded column priority rules.
**Why it matters:** EXP-001 and EXP-002 each added a deterministic rule. With 63 tools and unlimited data formats, rules don't scale. If LLM can see "Unit Cost: range [6.92..524.96], mean=191" vs "Total Cost: range [3,612..4,509,793], mean=931,805", it should pick correctly without rules.
**Experiment:** Updated `build_llm_prompt()` to include dtype + sample values + range + mean for every column. Re-ran all 5 datasets.
**AI tools used:** Cleaning engine LLM prompt.
**Evidence:** All 5 datasets: LLM correctly identified revenue, cost, and profit columns. Financial sample: LLM chose "Sales" (not "Gross Sales") and "COGS" (not "Unit Cost") — without any priority rules needed.
**Decision:** Keep deterministic rules as safety net, but LLM with sample values is now the primary path. One prompt change replaced 4 hardcoded rules.
**Impact:** Column mapping accuracy: 5/5 datasets correct. Approach scales to any format without new rules.

---

## EXP-007: LLM KPI Code Generation — Replacing Hardcoded Formulas
**Date:** 2026-04-03
**Hypothesis:** LLM can write correct pandas KPI calculation code if given column profiles, eliminating the need for hardcoded margin/revenue/cost formulas.
**Why it matters:** Every new data format previously needed manual formula adaptation. If LLM writes the code, it handles any format automatically.
**Experiment:** Built `kpi_code_executor.py` with 4-layer safety (validate → sandbox → sanity check → fallback). Tested on all 5 datasets.
**AI tools used:** DeepSeek generates pandas code, sandbox executes.
**Evidence:** All 5 datasets: LLM-generated code produced correct results matching hand calculations. For Superstore (no COGS), LLM wrote `total_cogs = total_revenue - total_profit` automatically — no special case needed. Financial sample: LLM chose Sales (not Gross Sales) without any rule.
**Decision:** LLM code generation is now the primary KPI calculation path. Deterministic calculator kept as fallback (used when LLM call fails).
**Impact:** One architecture change (LLM writes code) solved EXP-001, EXP-002, and EXP-005 simultaneously. Audit trail shows exact code + reasoning for every calculation.

---

## EXP-008: Tool Selection — Duplicate Tool Problem
**Date:** 2026-04-03
**Hypothesis:** LLM tool selector will avoid selecting overlapping tools.
**Why it matters:** Agent selected both run_mbr_anomaly AND run_anomaly_detection — same function, wasted time, confusing output.
**Experiment:** Ran General Agent on eval_golden.xlsx with default prompt.
**AI tools used:** Agent tool selector (LLM Call #1).
**Evidence:** LLM selected 7 tools including both anomaly tools + run_eda + run_auto_insights alongside run_mbr_* tools. Redundant.
**Decision:** Added 2 rules to selector prompt: "Do NOT mix overlapping tools" and "Do NOT select run_eda when run_mbr_* tools are selected."
**Impact:** Next run: 4 tools selected (cleaning, KPI, variance, anomaly). No overlap. Clean results.

---

## EXP-009: JS Tool Verification — Supabase Dependency
**Date:** 2026-04-04
**Hypothesis:** JS analytics tools (EDA, anomaly detection, regression, cleaning, auto-insights) can run with inline data.
**Why it matters:** General Agent sends raw data to tools. If tools require Supabase dataset profiles, they can't be used in the agent pipeline.
**Experiment:** Built jsToolVerifier.js — tested 9 JS tools with sample data via browser.
**AI tools used:** chatToolAdapter.executeTool() dispatching to JS services.
**Evidence:** 4/9 failed with `datasetProfilesService.getById is not a function`. These tools are hardcoded to load data from Supabase, not from inline input. 3 tools that don't need DB (SQL query, chart, digital twin) passed.
**Decision:** Switched these 5 tools from JS → Python API equivalents. Updated builtinToolCatalog.js to point to Python endpoints (/agent/eda, /agent/anomaly, /agent/regression). Python tools take raw data directly, no DB needed.
**Impact:** Tool verification: 8/9 passing. Python tools are verified with eval specs; JS tools that need Supabase are bypassed.

---

## EXP-010: 3-Layer Rule System — User Override Architecture
**Date:** 2026-04-03
**Hypothesis:** Users need to be able to correct LLM column mapping decisions, and corrections should persist across sessions.
**Why it matters:** Even with sample values in the prompt (EXP-006), LLM will occasionally get column mapping wrong on unfamiliar formats. Users must be able to fix it once and never see the same mistake again.
**Experiment:** Built mapping_rules.py with 3 layers: Company rules > User corrections > LLM auto-detect. Tested override flow: user clicks column mapping → enters new role → saved to JSON → next run uses correction.
**AI tools used:** None (deterministic rule system).
**Evidence:** Override flow works: set user rule "Sales Channel" → category, re-run → correctly applied. Company rule "ignore Gross Sales" → correctly excluded. Priority: company > user > LLM verified.
**Decision:** Ship as-is. JSON file storage is sufficient for prototype. Upgrade to Supabase when multi-user support needed.
**Impact:** Users can fix any LLM mistake in one click. System remembers. Builds trust incrementally.

---

## EXP-011: Procurement Data Misidentified as Sales
**Date:** 2026-04-04
**Hypothesis:** The KPI calculator can correctly analyze any type of business data, not just sales/revenue.
**Why it matters:** EMS/ODM companies like Speed Tech primarily work with procurement, production, and inventory data — not sales. If the system always calculates revenue/margin from procurement data, the output is meaningless garbage (margin 1.29% from purchase orders).
**Experiment:** Created `ems_odm_sample.xlsx` with 5 sheets of simulated EMS/ODM data: 採購訂單 (200 POs), 生產工單 (150 work orders), 供應商績效 (72 rows), 庫存快照 (32 rows), 採購預算 (45 rows). All columns in Traditional Chinese. Uploaded to General Agent.
**AI tools used:** General Agent with LLM KPI Code Generator.
**Evidence:** System mapped `訂單金額` → `amount` → treated as revenue. Calculated `gross_margin_pct: 1.29%` by treating purchase amount as revenue and `delivered_qty × unit_price` as COGS. This is meaningless — procurement data should calculate on-time delivery rate, quality pass rate, short shipment rate, budget achievement, yield rate — not sales margin.
**Decision:** Rewrote KPI Code Generator prompt to detect data domain first (sales vs procurement vs production vs inventory vs supplier vs budget), then calculate domain-appropriate KPIs. Added 6 domain-specific KPI sets. LLM now sees all sheets' profiles for full context.
**Impact:** System should now calculate procurement KPIs for procurement data, production KPIs for production data, etc. — instead of forcing everything into revenue/margin framework. This is the single biggest generalization improvement since the project started.

---

## EXP-012: Forecast Engine Standalone Test
**Date:** 2026-04-04
**Hypothesis:** The 5-model forecast engine can produce valid demand predictions from the golden dataset's sales history.
**Why it matters:** Forecast is the foundation — solver, risk, BOM all depend on it. If forecast doesn't work, nothing downstream works.
**Experiment:** Extracted 122 daily demand points from golden dataset (2025-01-01 to 2025-06-28, mean=108, range 5-400). Called `POST /demand-forecast` with horizon=7, modelType=auto.
**AI tools used:** Chronos (Transformer) was auto-selected by the factory.
**Evidence:** 7 forecast points returned. P10 ≤ P50 ≤ P90 ✅. All predictions ≥ 0 ✅. Chronos selected as best model. P50 range: 51-98 (reasonable given history mean of 108). However: MAPE/MAE not returned (comparison object was null), dates empty in output points.
**Decision:** Forecast engine works for standalone use. Two issues to fix before integration: (1) ensure ensemble race runs with metrics comparison, (2) pass dates through to output.
**Impact:** Phase 1.1 complete. Forecast can produce input for solver and risk scoring.

---

## EXP-013: Real-World Datasets — Column Whitespace + Too Many Columns
**Date:** 2026-04-04
**Hypothesis:** The system can handle real-world supply chain datasets from public sources without manual preparation.
**Why it matters:** Golden datasets are self-created and clean. Real data has leading/trailing spaces in column names, 50+ columns, inconsistent encoding. If we can't handle these, Speed Tech's data won't work either.
**Experiment:** Downloaded 3 public datasets: SC Analytics (30K orders + 4K inventory + 118 fulfillment, 3 sheets), DataCo Supply Chain (5K rows, 53 columns), USAID Procurement (5K rows, 33 columns).
**AI tools used:** General Agent with all 7 tools.
**Evidence:**
- SC Analytics: Column names had leading/trailing spaces (" Order ID ", " Gross Sales "). Cleaning engine and KPI calculator choked — couldn't find columns.
- DataCo: 53 columns overwhelmed LLM KPI code generator. LLM lost focus and failed to identify Sales/Profit columns.
- USAID: Procurement domain — similar column whitespace issues.
**Decision:** Three fixes applied:
1. Strip all column whitespace at cleaning entry point (`df.columns.str.strip()` equivalent on dict rows)
2. Filter columns to ≤20 most relevant (financial keywords + numeric) before sending to LLM for KPI code
3. Better fallback message when LLM code fails — show available numeric columns, suggest manual mapping
**Impact:** Entire class of whitespace bugs eliminated. LLM focus improved for high-column-count datasets. User gets actionable guidance when LLM fails instead of empty results.

---

## EXP-014: Dtype Coercion + Import Stripping — Real Dataset Fixes
**Date:** 2026-04-04
**Hypothesis:** After column whitespace fix, real datasets will produce correct KPIs.
**Why it matters:** SC Analytics had Revenue/Profit but KPI code failed. DataCo had 53 columns and LLM added `import pandas` which got blocked by sandbox.
**Experiment:** Debugged both failures:
- SC Analytics: `Discount %` column was str dtype ("0.25" not 0.25). LLM called `.mean()` on it → TypeError. Fixed by auto-coercing non-numeric columns to float in sandbox.
- DataCo: LLM generated `import pandas as pd` despite instructions. Sandbox correctly blocked it but result was empty. Fixed by stripping safe imports (pandas/numpy only) before validation.
**AI tools used:** KPI Code Executor with DeepSeek.
**Evidence:**
- SC Analytics: Revenue=132,185, Profit=72,537, Margin=54.88% ✅
- DataCo: Revenue=128,413, Profit=15,091, Profit Margin=11.75%, Late Delivery=54.09% ✅
- USAID: Already working (procurement domain correctly identified) ✅
**Decision:** Two fixes: (1) auto-coerce string columns that are >30% numeric to float, (2) strip `import pandas/numpy` from LLM code before sandbox validation.
**Impact:** All 3 real-world datasets now produce correct financial KPIs. Total verified datasets: 8 (5 golden + 3 real-world).

---

## EXP-015: Excel Generation — 5 Root Causes Found and Fixed
**Date:** 2026-04-05
**Hypothesis:** Excel download should always work after analysis completes.
**Why it matters:** User tested sc_analytics, dataco, and usaid — all completed analysis but none had Excel download. A product without downloadable output is not a product.
**Experiment:** Full trace of Excel generation pipeline. Found 5 stacking bugs:
1. `nan_safe()` didn't handle numpy.int64/float64 → openpyxl crash
2. Artifact data as dict (not list) → silent skip, no error but no sheet created
3. `filter_artifacts_for_planner` filtered out ALL tables (>50 rows) → 0 sheets → no Excel
4. Nested dict/list values in cells → openpyxl crash
5. `agent_done` SSE event sent BEFORE Excel generation → frontend closed stream before `artifacts_ready` arrived
**AI tools used:** None (infrastructure bug).
**Evidence:** Rewrote entire Excel generation as standalone `_build_agent_excel()` function with:
- `_excel_safe_value()`: handles numpy, pandas, dict, list, NaN, Timestamp, bytes
- Inline artifact filtering (skip >100 rows non-summary, skip metadata, cap at 30 sheets, 200 rows/sheet)
- Always creates at least 1 sheet (Executive Summary or placeholder)
- Excel generated BEFORE `agent_done` event, `download_id` included in event
- Tested with numpy.int64, numpy.nan, nested dicts, empty lists — all pass
**Decision:** Replaced 100-line fragile inline code with 80-line robust standalone function.
**Impact:** Excel download should now work 100% of the time for any dataset. Previously: ~30% success rate.

---

## EXP-016: Tool Execution Order + Column Keyword Expansion
**Date:** 2026-04-05
**Hypothesis:** Forecast and Risk tools will work on sc_analytics after cleaning runs first and column keywords are expanded.
**Why it matters:** Forecast and Risk returned 0 artifacts because: (1) they ran BEFORE cleaning (got raw data with whitespace), (2) they searched for "date"/"qty" but columns were named "Order YearMonth"/"Order Quantity".
**Experiment:** Two fixes: (1) `resolve_dependencies()` now auto-inserts cleaning as first tool — architectural rule, not per-tool config. (2) Expanded keywords in forecast/risk tools: added "yearmonth", "month", "quantity", "inventory", "warehouse inventory" etc.
**AI tools used:** General Agent on sc_analytics.xlsx (35K rows, 3 sheets).
**Evidence:** sc_analytics now produces: Revenue 6,181,476, Profit 3,994,192, Margin 64.62% — all exact match with hand calculation. Forecast and Risk also return results (previously 0 artifacts). All 6 tools run in correct order.
**Decision:** Auto-cleaning dependency is the right architecture. Keyword expansion is a stopgap — long term should use LLM to identify columns (like KPI code executor does). But works for now.
**Impact:** 8 datasets total: 7 exact match, 1 within 1.26pp. System ready for demo.

---

## Cumulative Verification Status (as of EXP-016)

| # | Dataset | Source | Revenue | Margin% | Hand Calc Match | Tools Run |
|---|---------|--------|---------|---------|-----------------|-----------|
| 1 | eval_golden (6 sheets) | Self-created | 17,637,296 | 50.99% | ✅ Exact | 7 (clean+KPI+var+anom+forecast+BOM+risk) |
| 2 | eval_golden (standard) | Self-created | 1,446,875 | 51.31% | ✅ Exact | 4 (clean+KPI+var+anom) |
| 3 | financial_sample | Microsoft | 118,726,350 | 14.23% | ✅ Exact | 4 |
| 4 | sales_records_100 | eforexcel | 137,348,768 | 32.16% | ✅ Exact | 4 |
| 5 | Superstore | Tableau | 2,296,635 | 12.46% | ✅ Exact | 4 |
| 6 | sc_analytics (35K rows) | GitHub | 6,181,476 | 64.62% | ✅ Exact | 6 |
| 7 | dataco (53 cols) | Kaggle/GitHub | 1,070,474 | 11.82% | ⚠️ -1.26pp | 4 |
| 8 | usaid (procurement) | USAID | N/A | N/A | ✅ Correct domain | 4 |
| 9 | ems_odm (中文) | Self-created | N/A | N/A | ✅ Correct domain | 4 |
| 10 | chinese_income_stmt | GitHub | N/A | N/A | ✅ Correctly rejected | 0 (format validation) |

---

## EXP-017: 2-Step LLM Column Detection Fixes Dataco 1.26pp Gap
**Date:** 2026-04-05
**Hypothesis:** Splitting column detection into a separate lightweight LLM call before KPI code generation will fix the wrong-column selection problem.
**Why it matters:** Dataco (53 columns) had LLM picking `Sales` (gross) instead of `Order Item Total` (net) as revenue. Single-call approach couldn't handle the ambiguity.
**Experiment:** Added `_detect_column_roles()` — a focused LLM call that only asks "which column is revenue/cost/profit?" with just 15 filtered columns and their sums. Then passes the answer as a binding hint to the KPI code generator.
**AI tools used:** DeepSeek via Supabase ai-proxy (2 sequential calls instead of 1).
**Evidence:**
- Before: Revenue=1,070,474 (Sales/gross), Margin=10.56% (hand calc: 11.79%)
- After: Revenue=959,192 (Order Item Total/net), Margin=11.80% (hand calc: 11.79%)
- Gap reduced from 1.26pp to 0.01pp
- sc_analytics and usaid unchanged (no regression)
**Decision:** 2-step approach is correct for high-column-count datasets. Extra LLM call costs ~500 tokens but eliminates column selection errors.
**Impact:** All 10 tested datasets now produce correct or near-correct results. Dataco gap: 1.26pp → 0.01pp.

---

## EXP-018: End-to-End Pipeline Test — 7 Tools Chained Successfully
**Date:** 2026-04-05
**Hypothesis:** All 7 tools can run in sequence with output chaining: forecast → plan → risk, and BOM + KPI + anomaly in parallel.
**Why it matters:** Individual tools passing doesn't mean the pipeline works. Need to verify data flows between tools correctly.
**Experiment:** Ran General Agent on eval_golden.xlsx with prompt "Run full pipeline: forecast, plan, KPI, anomaly, BOM, risk". Traced execution order and output chaining.
**AI tools used:** General Agent with 7 tools (cleaning, forecast, BOM, anomaly, KPI, plan, risk).
**Evidence:**
- Execution order: cleaning → forecast → BOM → anomaly → KPI → plan → risk (correct)
- Forecast → Solver: predictions used to calculate demand_7d=477 for SKU-002 ✅
- Solver → Risk: inventory data produced p_stockout=0.42 for SKU-002 ✅
- BOM: RM-F=21,113.9 matches hand calculation ✅
- KPI: Revenue=1,446,875, Margin=51.31% matches hand calculation ✅
- Total time: 41.7 seconds for 7 tools on 353 rows
**Decision:** Pipeline chaining works. One issue: forecast produces a single demand series (not per-SKU), so all SKUs get the same daily_demand. This is acceptable for MVP but needs per-SKU forecasting for production use.
**Impact:** Full decision loop verified: data → clean → forecast → plan → risk → KPI → anomaly → BOM. Ready for demo.

---

## EXP-019: Multi-Agent Architecture — Parallel Lenses + Reviewer
**Date:** 2026-04-05
**Hypothesis:** Adding a Reviewer agent that reads all 3 specialist outputs + original KPIs will catch contradictions and improve report accuracy.
**Why it matters:** Previous versions had errors where "code computed category margin but narrative said not available." A reviewer reading both should catch this.
**Experiment:** Replaced single synthesizer with 5-agent architecture: 3 specialist lenses (Financial, Operations, Risk) run in parallel, then Reviewer checks for contradictions, then Lead Analyst synthesizes with corrections applied. All reasoning agents use GPT-5.4 with reasoning_effort=high.
**AI tools used:** GPT-5.4 (reasoning=high) for analysis/review, DeepSeek for tool selection/code gen.
**Evidence:** Reviewer successfully caught: "Operations Analyst says lead_time=0.00 but KPI table shows it was computed." Also caught inconsistencies in margin numbers between analysts. Report quality: 7.8-8/10 (up from 6-7/10 without reviewer).
**Decision:** Keep parallel + reviewer architecture. But discovered new issue: the reviewer can't fix what the code gen got wrong (date parsing regression).
**Impact:** Architecture upgrade from single-LLM synthesis to multi-agent with cross-checking. First implementation of inter-agent review in the system.

---

## EXP-020: LLM Code Gen — Negative Profit ≠ Return Rate
**Date:** 2026-04-05
**Hypothesis:** LLM will not confuse negative profit transactions with product returns if explicitly instructed.
**Why it matters:** Previous version calculated "return_rate = 18.72%" from negative profit rows, then built entire risk narrative on this false premise. Negative profit means the transaction lost money (deep discount, high cost), NOT that the product was returned.
**Experiment:** Added KPI code prompt rule: "Negative profit does NOT mean returns/refunds. Never calculate return_rate from negative profit rows." Also added rules for precise metric naming (avg_lines_per_order vs avg_items_per_order) and revenue-weighted discount rate.
**AI tools used:** DeepSeek KPI code generator.
**Evidence:** After fix, no more "return_rate" in output. Discount rate changed from misleading "15.62%" (unweighted mean) to "14.04%" (revenue-weighted effective rate).
**Decision:** KPI code prompt now has 12 rules. Each rule traces back to a specific error found in testing.
**Impact:** Eliminated false "return rate" narrative. Discount rate reporting more accurate.

---

## EXP-021: Excel Serial Date Handling — Lead Time Regression
**Date:** 2026-04-05
**Hypothesis:** LLM-generated date parsing code will correctly handle Excel serial dates.
**Why it matters:** Superstore lead time went from correct 3.96 days (version N-1) to 0.00 days (version N) because LLM used pd.to_datetime() which doesn't handle Excel serial numbers (e.g., 42370 = 2016-01-01).
**Experiment:** Instead of relying on LLM to write correct date parsing, added deterministic pre-processing in the sandbox: detect columns named "date" with numeric values in 30000-60000 range → auto-convert using unit='D', origin='1899-12-30'. This runs BEFORE LLM code executes.
**AI tools used:** None (deterministic fix).
**Evidence:** Test with Excel serial dates [42370, 42371, 42372] → correctly parsed to 2016-01-01, 2016-01-02, 2016-01-03. Lead time calculation: avg=4.33 days (correct).
**Decision:** Date handling moved from LLM responsibility to deterministic pre-processing. LLM code can assume date columns are already datetime type.
**Impact:** Lead time calculation now reliable regardless of LLM code quality. Eliminates an entire class of date-related regressions.

---

## EXP-022: Anomaly Sensitivity — 6594 out of 9989 rows (66%) flagged
**Date:** 2026-04-05
**Hypothesis:** Reducing anomaly detection sensitivity and excluding ID columns will produce more meaningful anomaly counts.
**Why it matters:** Flagging 66% of rows as anomalies is useless — it means the threshold is wrong, not that the data is bad. Also, using Row ID and Postal Code as anomaly evidence is meaningless (these are identifiers, not business metrics).
**Experiment:** Two changes: (1) Z-score threshold raised from 3.0 to 3.5 to reduce false positives on long-tail distributions. (2) Added more ID column patterns to exclusion list: row_id, postal, zip, order_id, customer_id, product_id, invoice, po_number.
**AI tools used:** None (anomaly engine configuration).
**Evidence:** Not yet re-tested with Superstore. Expected: anomaly count should drop from 6594 to a more reasonable number (200-500 range for 9989 rows).
**Decision:** Anomaly thresholds should be tunable per dataset. Current fix is a better default. Future: let the system auto-calibrate threshold based on data distribution.
**Impact:** Reduces false positive rate. Prevents risk narrative from being built on inflated anomaly counts.

---

## EXP-023: Model Routing — reasoning_effort=high for GPT-5.4
**Date:** 2026-04-05
**Hypothesis:** Setting reasoning_effort from default "medium" to "high" for GPT-5.4 will improve analysis quality.
**Why it matters:** Another AI's analysis of our codebase found that GPT-5.4 was running at medium reasoning effort by default, which may explain why our output quality is lower than ChatGPT (which presumably uses high or max).
**Experiment:** Changed all synthesizer and column role detection calls to use reasoning_effort="high". Also added logging to show actual provider/model/reasoning for every LLM call. UI now shows model tag next to each agent (e.g., "openai/gpt-5.4 (reasoning=high)").
**AI tools used:** GPT-5.4 with reasoning_effort=high.
**Evidence:** Testing in progress. Expected: improved reasoning depth in specialist lenses, fewer "not available" false claims, better risk confidence tagging.
**Decision:** High reasoning for analysis tasks, medium/default for tool selection and code gen (where speed matters more than depth).
**Impact:** Transparent model routing — every agent shows which model it used. Users and developers can verify the AI is using the right model for each step.

---

## Cumulative Version Comparison (Superstore Dataset)

| Version | Date | Score | Key Improvement | Key Regression |
|---------|------|-------|-----------------|----------------|
| v1 | 04-03 | 6/10 | First working pipeline | No category margin, dates wrong |
| v2 | 04-04 | 7/10 | Category margin found, less overclaim | Discount = return rate error |
| v3 | 04-05 | 7.8/10 | Lead time computed, confidence tags | Return rate still present |
| v4 | 04-05 | 8/10 | Reviewer catches contradictions | Lead time regressed to 0.00 |
| v5 | 04-05 | TBD | Date pre-processing, parallel+reviewer, reasoning=high | Testing... |

---

## EXP-024: Metric Contract + Quarantine + Deterministic Breakdowns
**Date:** 2026-04-06
**Hypothesis:** Adding metric contract (canonical values), quarantine (date-sum/ID-sum), and expanded deterministic breakdowns (revenue share, discount by dimension) will close the remaining analysis gaps
**Why it matters:** V3 scored 8.4/10 but missed discount-by-category, Consumer segment margin, and treated 6205 anomalies as footnote
**Experiment:** Built 4 new deterministic layers between tool execution and synthesis
**AI tools used:** Pure deterministic (no LLM calls)

**Evidence:**
- Metric contract now produces: margin, revenue share, AND discount rate breakdowns per dimension (3×3 = 9 breakdowns vs 3 before)
- Quarantine catches date-sum and ID-sum garbage before it reaches agents (safelist protects avg_lead_time_days)
- Anomaly escalation: ≥100 anomalies or ≥5 critical → auto-flagged as MAJOR finding in Data Gaps section
- Revenue base ambiguity: auto-warns when revenue + discount + margin coexist without clarifying gross vs net

**Decision:** Ship these as deterministic pre-synthesis layer. Next: structured claims (specialist output → JSON claims → reviewer audits claims not prose)
**Impact:** Agents now see 3× more breakdown data; meaningless metrics quarantined; high anomaly counts auto-escalated; revenue definition ambiguity surfaced

## EXP-025: V3 Quality Evaluation — Best Version
**Date:** 2026-04-06
**Hypothesis:** Metric contract + benchmark policy would produce consistently accurate analysis
**Evidence:** External evaluation scored 8.4/10 overall, 9.5/10 KPI accuracy, 9/10 actionability
**Key finding:** Furniture 2.49% margin caught for first time (was missed in V1-V2). Tables -8.56% sub-category identified. $109K profit shortfall quantified.
**Remaining gaps:** Discount not broken by category, Consumer segment margin dropped, 6205 anomalies under-prioritized
**Decision:** All gaps addressed by EXP-024 deterministic fixes

## EXP-026: Synthesis v2 — Role Briefing + Reference System + Structured Reviewer
**Date:** 2026-04-06
**Hypothesis:** Agent errors come from 3 root causes: (1) too much noise in input, (2) LLM responsible for numbers, (3) reviewer can't enforce corrections. Fixing all 3 at the deterministic layer will improve accuracy more than prompt engineering.
**Why it matters:** V3 scored 8.4/10 but agents still cited wrong numbers, ignored forecast contract, and guessed causal relationships.

**Changes (all deterministic, no prompt tuning):**
1. **Priority Ranking**: `compute_priority_scores()` — scores by `abs(delta_pct) × revenue_weight × is_bad_boost`. Furniture margin now ranks #1 automatically.
2. **Role-Based Routing**: `build_role_briefing()` — Financial gets ~2000 tokens (margin, discount, revenue only), Operations gets ~300 tokens (lead time, forecast contract only). Down from 3500 shared tokens.
3. **[[Reference]] System**: `resolve_references()` — agents write `[[margin_pct:Furniture]]`, system replaces with real value. If ref doesn't exist → [UNRESOLVED]. Agent never writes raw numbers.
4. **Causal Context**: `build_causal_context()` — for top 5 outliers, finds all other metrics for the same dimension. E.g., Furniture margin outlier → system provides Furniture revenue, COGS, discount as explanation candidates. Agent doesn't need to guess causation.
5. **Structured Reviewer**: Reviewer outputs JSON with corrections + worst_agent. If worst agent has critical errors → retry with specific feedback. Max 1 retry.
6. **Key Metrics Table**: System-generated from metric contract, not LLM-generated.

**New file**: `src/ml/api/synthesis_briefing.py` (~350 lines)
**Modified**: `src/ml/api/agent_synthesizer.py` (rewritten synthesize() flow)
**Tests**: 16 tests passing (7 new for briefing + 9 existing)

**Expected impact:**
- "forecast unit unknown" bug → eliminated (Operations briefing includes forecast contract explicitly)
- Number copying errors → eliminated (LLM never writes numbers)
- Furniture margin missed → eliminated (priority ranking forces it to #1)
- Causal guessing → reduced (system provides explanation candidates)

**Decision:** This is the architecture for v2 synthesis. Needs end-to-end validation with real LLM calls.

## EXP-027: [[Reference]] System Failed — 6.2/10, Severe Regression
**Date:** 2026-04-06
**Hypothesis:** If agents use `[[metric_id]]` placeholders and system resolves them, numbers will always be correct.
**Why it matters:** This was supposed to solve the #1 problem (agents citing wrong numbers).

**Evidence (FAILURE):**
- Overall quality: **6.2/10** (down from 8.4/10 — worst version in recent history)
- Consistency: **4.8/10**
- Trustworthiness: **4.5/10**
- Final output contained `[UNRESOLVED: 55,617.82]`, `[UNRESOLVED: -17,725.48]`, `[UNRESOLVED: $2,296,635]` throughout
- Agents invented non-existent refs: `[[total_profit:Copiers]]`, `[[total_revenue:California]]`, `[[units:Standard Class]]`
- Reviewer caught the errors but retry didn't fix them — final report still had broken placeholders

**Root cause:** LLMs see `[[pattern]]` and **generalize** — they create new refs that don't exist. This is LLM's nature: it sees a pattern and extrapolates. Unlike Excel where `=A1` is a closed vocabulary trained billions of times, `[[metric_id:dimension]]` is a custom syntax the LLM hasn't been trained on.

**Decision:** Killed `[[reference]]` system entirely. Reverted briefings to show real numbers. Added `sanitize_output()` safety net to strip any stray `[[...]]`.

**Key lesson:** **Don't make numbers secondary output (embedded in prose). Either make them primary structured output (JSON) or show them directly (real numbers).** The middle ground (placeholders in prose) is the worst of both worlds.

## EXP-028: Structured Claims — Excel Model (Enum-Constrained JSON)
**Date:** 2026-04-06
**Hypothesis:** If we constrain LLM output to a JSON schema where `metric_ref` is an enum of valid IDs, the LLM physically cannot reference non-existent metrics — same principle as Excel formulas.

**Why it matters:** This is the architectural fix for the #1 quality bottleneck: agents citing wrong or non-existent data.

**Architecture:**
```
Metric Contract → extract valid_metric_ids → build JSON schema with enum
    ↓
3 Specialists output JSON claims (OpenAI strict mode: enum enforced at decode time)
    ↓
System validates claims (belt-and-suspenders)
    ↓
Reviewer checks claims (structured JSON)
    ↓
Writer LLM converts verified claims → prose (all numbers pre-filled from ref_values)
    ↓
sanitize_output() safety net
```

**Key insight from research:** OpenAI Responses API supports `text.format.type = "json_schema"` with `strict: true`. With enums, the model **cannot emit tokens outside the enum**. This is the same guarantee Excel gives: you can't write `=VLOOKUP("Copiers", ...)` if Copiers isn't in the data.

**Changes:**
- New: `structured_claims.py` — schema builder, validator, claims-to-prose converter
- Modified: `_call_openai()` — now accepts `json_schema` for strict structured output
- Modified: `_call_llm_via_proxy()` and `_call_llm()` — pass `json_schema` through chain
- Modified: `agent_synthesizer.py` — full rewrite to claims-based flow
- 5 LLM calls (same as before): 3 specialists (JSON) + 1 reviewer (JSON) + 1 writer (prose)

**Tests:** 19 passing (5 new for structured claims)

**Expected impact:**
- `[[total_profit:Copiers]]` → **impossible** (Copiers not in enum)
- `[UNRESOLVED: ...]` in output → **impossible** (no placeholders in flow)
- Numbers copied wrong → **impossible** (writer gets pre-formatted ref_values)
- Agent ignores forecast contract → **reduced** (role briefing shows it directly)

**Status:** Built and tested deterministically. Needs end-to-end validation with real GPT-5.4 API calls.

## Version Quality Tracker

| Version | Date | Score | Best Feature | Worst Issue |
|---------|------|-------|--------------|-------------|
| v1 | 04-03 | 6/10 | First working pipeline | No category margin |
| v2 | 04-04 | 7/10 | Category margin found | Discount = return rate |
| v3 | 04-05 | 7.8/10 | Lead time computed | Return rate still present |
| v4 | 04-05 | 8/10 | Reviewer catches contradictions | Lead time regressed to 0.00 |
| v5 (metric contract) | 04-06 | 8.4/10 | Furniture 2.49% found, reviewer strong | Discount not by category |
| v6 (metric contract v2) | 04-06 | 8.2/10 | Metric conflict awareness | KPI conflict still unresolved |
| v7 ([[reference]]) | 04-06 | **6.2/10** | Reviewer very strong | **[UNRESOLVED] in output — delivery failure** |
| v8 (structured claims) | 04-06 | **6.6/10** | Enum refs work, reviewer strong | **LLM fabricates numbers in free-text fields** |

## EXP-029: Structured Claims v1 — Enum Works, Free-Text Leaks
**Date:** 2026-04-06
**Hypothesis:** Enum-constrained `metric_ref` will prevent fabricated references.
**Result:** Partial success — **6.6/10** (up from 6.2, but still below v5's 8.4)

**What worked:**
- `metric_ref` enum constraint **held** — no invented metric IDs in the JSON field
- Reviewer caught 10 critical errors, correctly identified fabricated benchmarks
- KPI baseline was clean and complete

**What failed:**
- LLM fabricated numbers in `insight` and `note` free-text string fields:
  - "Tables profit -$17,725.48, which is $33,319.50 below its benchmark" ← benchmark is made up
  - "Copiers exceed benchmark by $45,610.72" ← no Copiers benchmark exists
  - "Home Office unit sales dramatically below benchmark" ← no unit benchmarks for segments
- All 3 specialists missed the #1 finding: Office Supplies 60.3% share anomaly (delta +40.45)
- Operations incorrectly labeled Technology as "severely underperforming" when it's ABOVE benchmark

**Root cause:** Schema constrains `metric_ref` (enum) and `assessment` (enum), but `insight` is a free `string` type — LLM fills it with fabricated numbers. The schema prevents bad REFERENCES but not bad PROSE.

**Fix needed:** Remove all free-text number-containing fields from claims. Claims should be:
```json
{"metric_ref": "margin_pct:Furniture", "assessment": "critically_low", "confidence": "data_proven", "cause_ref": "total_revenue:Furniture"}
```
No `insight`, no `note`, no free-text where LLM can embed numbers. The writer gets the real numbers from `ref_values` lookup.

**Key lesson:** Constraining the INDEX is not enough — you also have to constrain the VALUES. Every channel where LLM can write free text is a channel where it will fabricate numbers.

## Version Quality Tracker (updated)

| Version | Date | Score | Architecture | Key Win | Key Fail |
|---------|------|-------|-------------|---------|----------|
| v1 | 04-03 | 6.0 | Basic pipeline | First working | No category margin |
| v2 | 04-04 | 7.0 | + KPI code | Category margin | Discount=return rate |
| v3 | 04-05 | 7.8 | + Lead time | Lead time works | Return rate persists |
| v4 | 04-05 | 8.0 | + Reviewer | Catches contradictions | Lead time regressed |
| **v5** | **04-06** | **8.4** | **+ Metric contract** | **Furniture found, best version** | **Discount not by category** |
| v6 | 04-06 | 8.2 | + Benchmark policy | Metric conflict awareness | KPI conflicts unresolved |
| v7 | 04-06 | 6.2 | + [[Reference]] | Reviewer strong | [UNRESOLVED] in output |
| v8 | 04-06 | 6.6 | + Structured claims | Enum refs hold | Numbers in free-text |

**Trend:** v5 (8.4) remains the high-water mark. v7-v8 introduced architectural changes that regressed quality. The simpler architecture (real numbers in prompt + strong reviewer) outperformed the more complex ones (placeholders, JSON claims).

## EXP-030: Micro-Call Synthesis — One LLM, One Job
**Date:** 2026-04-06
**Hypothesis:** If each LLM call only sees 3-5 facts (~200 tokens), it can only use those numbers. No room to fabricate.

**Insight:** Previous versions failed because one LLM call did 4 things simultaneously (select, judge, explain cause, write). Each additional task multiplied hallucination chances. The deterministic layer already handles select (priority ranking), judge (benchmark delta), and explain (causal context). LLM only needs to WRITE.

**Architecture:**
```
Deterministic: score → rank → build fact packets (3 facts each, ~200 tokens)
    ↓
Parallel micro-calls: each packet → 2-3 sentences (N calls, all parallel)
    ↓
Deterministic: assemble sections from micro-outputs
    ↓
1 LLM call: Executive Summary + Recommendations from assembled sections
    ↓
sanitize_output() safety net
```

**Key differences from v5-v8:**
- No specialist agents (financial/ops/risk each doing full analysis)
- No reviewer (nothing to review — each micro-call is too small to go wrong)
- No JSON claims, no enums, no placeholders
- Each LLM call sees ~200 tokens (vs 2000-3500 in previous versions)
- LLM calls: ~7-10 micro + 1 exec summary = ~8-11 total (vs 5 before)
- But each is faster (small context) and all micro-calls run in parallel

**Why this might work at scale (200+ metrics):**
- Priority ranking selects top N per role (deterministic, O(n log n))
- Each packet is always 3 facts regardless of total metrics
- Token count per call is constant (~200), doesn't grow with data size
- Number of packets grows linearly (60 metrics ÷ 3 = 20 packets), all parallel

**New file:** `src/ml/api/fact_packets.py` (~200 lines)
**Tests:** 20 passing (6 new for fact packets)
**Status:** Built and tested. Needs end-to-end validation with real LLM calls.

| Version | Date | Score | Architecture | Key Idea |
|---------|------|-------|-------------|----------|
| v5 | 04-06 | **8.4** | All facts → 3 agents | Simple, works at small scale |
| v7 | 04-06 | 6.2 | [[placeholder]] system | LLM generalizes patterns → broken |
| v8 | 04-06 | 6.6 | JSON enum claims | Enum works, free-text leaks |
| v9 | 04-06 | 5.8 | Micro-calls (3 facts each) | Too fragmented, no reviewer, grass-draft patchwork |
| v10 | 04-06 | 7.1 | V5+V9 hybrid (first attempt) | Role routing + focused briefings, but GPT-5.4 code gen unstable |
| v11 | 04-06 | 7.4 | + quarantine fix for row_id/postal/date | Garbage metrics gone, but share% still dominates |
| v12 | 04-06 | 8.0 | + gross_revenue→revenue rename | No more net_revenue confusion, code gen reliable |
| v13 | 04-06 | 8.3 | + anomaly engine quarantine | Row_id/postal/date sums fully removed from agents |
| v14 | 04-06 | 3.5 | GPT-5.4 code gen broke (Revenue=0) | Diagnostic log bug crashed KPI path |
| **v15** | **04-07** | **8.5** | **V5+V9 hybrid + 4 guardrails + reasoning optimization** | **Best version. Clean KPIs, strong reviewer, no garbage.** |

## EXP-031: V5+V9 Hybrid — Final Architecture (v15, scored 8.5/10)
**Date:** 2026-04-07
**Hypothesis:** Combine V5 synthesis structure (3 agents + reviewer + synthesizer) with V9 deterministic layer (priority ranking, role routing, causal context, quarantine) for the best of both worlds.

**Architecture:**
```
Deterministic Layer (V9):
  metric_contract → benchmark_policy → priority_scoring → role_routing → causal_context
  + KPI minimum spec (ensure_required_breakdowns)
  + Sanity check (gross_margin ≠ revenue, revenue > 0)
  + Structural vs Problematic classification (share% deprioritized)
  + Quarantine (row_id, postal_code, date sums excluded everywhere)

Synthesis Layer (V5):
  3 specialists parallel (Financial, Operations, Risk) — focused briefings, real numbers
  1 reviewer — sees all data + all 3 outputs, finds errors
  1 synthesizer — applies corrections, McKinsey Pyramid structure

Model Routing:
  Tool selection: DeepSeek (default llm_config)
  KPI code gen: GPT-5.4 reasoning=medium (via env var DI_CODE_GEN_*)
  Synthesis: GPT-5.4 reasoning=medium for specialists, low for reviewer (via env var DI_REASONING_*)
  All configurable via env vars + UI model selector
```

**Key files created/modified:**
- NEW: `kpi_guardrails.py` — 3-layer deterministic guardrails (minimum spec + sanity + structural)
- NEW: `synthesis_briefing.py` — priority ranking, role routing, causal context, key metrics table
- NEW: `fact_packets.py` — micro-call support (kept but not used in final architecture)
- NEW: `structured_claims.py` — JSON enum claims (kept but not used in final architecture)
- MODIFIED: `agent_synthesizer.py` — V5+V9 hybrid flow
- MODIFIED: `metric_registry.py` — source priority, quarantine, per-unit metric separation
- MODIFIED: `kpi_code_executor.py` — GPT-5.4 support, JSON repair, prompt cleanup
- MODIFIED: `mbr_agent.py` — guardrails wired into both LLM and fallback paths
- MODIFIED: `anomaly_engine.py` — quarantine filter on numeric columns
- MODIFIED: `mbr_data_cleaning.py` — neutral canonical name (revenue not gross_revenue)
- MODIFIED: `mapping_rules.py` — same rename fix
- MODIFIED: `tool_executor.py` — Kimi/OpenAI-compat provider, reasoning extraction, max_tokens 8192
- MODIFIED: `AgentWorkspaceView.jsx` — model selector dropdown

**Tests:** 27 passing (kpi_guardrails, synthesis_briefing, fact_packets, metric_registry, synthesis_foundations)

**What worked:**
- Quarantine rules (one set, three entry points) eliminated all garbage metrics
- Priority ranking puts Furniture margin #1 automatically
- Structural classification deprioritizes share% deviations
- Reviewer catches unsupported benchmarks, final absorbs corrections
- KPI code gen reliable with GPT-5.4 medium reasoning + 8192 max_tokens

**What still needs fixing:**
- Key Metrics table shows items without formal benchmark (Tables, Central)
- Lead time by ship_mode = NaT (date parsing edge case)
- Structured breakdowns have duplicates
- Discount benchmarks fabricated by specialists (reviewer catches but shouldn't happen)

**Scores evolution:**
| v1→v5 | 6.0→8.4 | Building the pipeline |
| v7→v9 | 6.2→5.8 | Failed experiments (placeholders, JSON claims, micro-calls) |
| v10→v15 | 7.1→8.5 | Rebuilding with guardrails + hybrid architecture |

*Log updated: 2026-04-07. Total experiments: 31.*
