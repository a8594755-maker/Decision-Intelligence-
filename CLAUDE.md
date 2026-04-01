# CLAUDE.md — SmartOps

## What This Is
AI Digital Worker for supply chain operations. Autonomously executes analysis, generates reports, delivers decision recommendations. Not a copilot — a worker that replaces manual analyst tasks end-to-end.

Target: US market, manufacturing / EMS / ODM companies.

## Tech Stack
- Frontend: React 19 + Vite 7 + Tailwind, `src/`
- Backend: FastAPI + Python 3.11, `src/ml/`
- DB: Supabase (PostgreSQL, RLS enabled)
- Agent LLM: DeepSeek
- Forecast: 5 models (ETS/Prophet/LightGBM/XGBoost/Chronos) in `src/ml/demand_forecasting/`

## Commands
- `npm run dev` / `npm run build` / `npm run lint`
- `uvicorn ml.api.main:app --reload`
- `python -m ml.api.tool_eval` — **run after every change, no exceptions**
- `python -m ml.api.tool_eval --tool <name>` — single tool
- Eval specs in `src/ml/api/eval_specs/`, copy `_template_spec.py` to add new ones

## Architecture Direction

### Current: Pipeline Mode
Each command triggers a fixed pipeline. MBR has 8 tools, Forecast has its own chain. Pattern is always: **Planner -> Executor (context chain) -> Synthesizer**.

### Goal: General Agent Mode
User says anything in natural language -> agent picks the right tools from 63+ registered tools -> executes -> synthesizes -> delivers.

Key components needed:
- **Tool Registry**: each tool has `{ description, requires, produces, cost, depends_on }`
- **Query Router**: `/mbr` and `/forecast` stay as fixed pipelines; free text goes to General Agent
- **Semantic Search**: find top 10 relevant tools from registry, LLM planner picks 3-5
- **Shared infrastructure**: SSE streaming, report builder, summarizer reused across all pipelines

**Do not build General Agent until**: MBR eval 100% green, Forecast eval 100% green, at least 3 more stable pipelines exist, common patterns extracted into shared modules.

## Tier 1 Forecast Tools — File Map

### `run_forecast` (JS, tier_c)
Entry: `runForecastFromDatasetProfile()` in `src/services/forecast/chatForecastService.js`

| File | Role |
|---|---|
| `src/services/forecast/chatForecastService.js` | Main: data mapping, model selection (naive_last/moving_avg/seasonal_naive/lightgbm_api), quantile calibration, artifact saving |
| `src/services/forecast/forecastApiClient.js` | HTTP client to Python `/demand-forecast` |
| `src/services/forecasting/calibrateQuantiles.js` | P10/P50/P90 quantile calibration from backtest residuals |
| `src/services/forecasting/forecastPointMapper.js` | Canonical forecast point shape |
| `src/utils/dataServiceHelpers.js` | `parseDateValue`, `toIsoDay`, `normalizeSheetName` |

Pipeline: load demand_fg dataset -> map columns -> aggregate by SKU/plant -> holdout backtest -> select best model -> predict future -> calibrate quantiles -> save 4 artifacts (forecast_series, metrics, report_json, forecast_csv)

### `run_ml_forecast` (Python, tier_b)
Entry: `POST /demand-forecast` in `src/ml/api/main.py:805`

| File | Role |
|---|---|
| `src/ml/api/main.py:473-531` | `ForecastRequest` Pydantic model |
| `src/ml/api/main.py:805-1049` | Endpoint: schema validation -> cache check -> prod pointer -> champion -> fallback -> quantiles -> response |
| `src/ml/demand_forecasting/forecaster_factory.py` | `ForecasterFactory` + 5 strategies (Prophet/LightGBM/Chronos/XGBoost/ETS), ensemble race, backtest, calibration |
| `src/ml/demand_forecasting/feature_engineer.py` | `FeatureEngineer` + `FEATURE_COLUMNS` (19 features), schema validation |
| `src/ml/demand_forecasting/data_contract.py` | `SalesSeries`, `DataQualityReport` |
| `src/ml/demand_forecasting/data_validation.py` | `validate_and_clean_series` |
| `src/ml/demand_forecasting/dataset_schema.py` | `validate_forecast_payload` input gate |
| `src/ml/api/forecast_contract.py` | Response envelope (`finalize_forecast_response`) |

Inference priority: PROD registry pointer -> champion artifact -> fallback (ensemble race if auto + >=30 points, else recommend_model -> try all with fallback)

Each strategy has: real model mode (.json/.pkl) + statistical fallback (deterministic, no randomness except Chronos)

### Shared Forecast Invariants (for eval specs)
- p10 <= p50 <= p90 (monotonicity)
- All predictions >= 0 (non-negative demand)
- Forecast horizon matches requested periods
- MAPE/MAE computed only on non-zero actuals
- Quantile calibration: P90 coverage should be ~90%
- Feature schema: exactly 19 columns in fixed order (training = serving)

## Things That Go Wrong (Guardrails)

### Math Errors That Have Actually Happened
- **Margin% used simple mean instead of aggregate** -> `sum(margin)/sum(revenue)*100`, never `mean(per_row_pct)`
- **Variance attainment used mean instead of sum** -> `sum(actual)/sum(target)*100`, never `mean(per_row_attainment)`
- **Expense `amount` classified as revenue** -> `amount`, `total_amount` must NOT trigger revenue_summary on supplier/expense sheets. Only `gross_revenue`, `net_revenue`, `revenue`, `total_revenue` count.
- **Volume + Price + Mix != Total Delta** -> must sum exactly. If not, bug.

### Synthesizer Hallucinations That Have Actually Happened
- Wrote "Sales is the largest cost center" when Marketing was largest -> insights must come from `generate_insight_from_artifact()` with `[FACT]` lines, not LLM guessing
- Wrote "12.16M THB" when data had USD + TWD + NTD mixed -> multiple currencies = "mixed currency", never single label
- Wrote "X THB" placeholder -> never use placeholders, omit the claim
- Section 2 empty because summarizer grabbed waterfall before target variance -> `_art_priority()` sorts target variance first

### Data Quality Issues That Keep Recurring
- `台灣` / `TW` / `Taiwan` not unified -> entity resolution must resolve to one canonical value
- TEST rows and header-as-data rows not removed -> cleaning must catch these
- Negative inventory (qty = -200) -> flag as anomaly, preserve original value
- `result_summary` overwritten by later tools -> each tool appends, never overwrites

### Performance Traps
- Report planner seeing 181 artifacts -> pre-filter to ~30, skip metadata/detail tables
- KPI config via LLM -> replaced with deterministic builder, 71x faster
- Nested event loop deadlock -> never `asyncio.new_event_loop()` inside ThreadPoolExecutor with FastAPI

## Roadmap
1. MBR eval 100% green, zero manual verification
2. Forecast eval 100% green
3. Verify Tier 1 tools (12 tools that affect money/decisions)
4. Build 2-3 more fixed pipelines (inventory, supplier risk, cost analysis)
5. Extract shared modules (summarizer, report builder, SSE)
6. Build Tool Registry + General Agent
7. Currency normalization tool (when customer needs it, not before)

## For Demos
- Not a chatbot — digital worker that autonomously runs multi-step pipelines
- Eval-driven: golden datasets + automated assertions after every change
- Anti-hallucination: insights computed from data, LLM only rephrases [FACT] lines
- 5-model ensemble race with calibrated quantiles (p10/p50/p90)
- Three-mode cleaning: LLM bootstrap -> incremental -> deterministic engine (71x speedup)
- "How do you know output is correct?" -> eval framework, not manual checking
