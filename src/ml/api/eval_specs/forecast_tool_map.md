# Forecast Tool Map

## Tool 1: `run_forecast` (JS, tier_c)

### File Path & Entry
- `src/services/forecast/chatForecastService.js` → `runForecastFromDatasetProfile()`
- Catalog: builtinToolCatalog.js L60

### Input Schema
```
userId: string
datasetProfileRow: { profile_json, contract_json, _inlineRawRows? }
horizonPeriods?: number
settings?: { granularity?, metricName? }
```

### Output Schema
```
{ run, forecast_series, metrics, report_json, csv, artifact_refs, summary_text }
```

### Complete Call Chain
```
runForecastFromDatasetProfile
  → createRun → chooseDemandDataset → getFileById
  → normalizeTargetMapping → mapDemandRows → aggregateDemandRows
  → filter >=3pts, cap 25 groups → inferGranularity
  → FOR EACH group:
      → computeHoldoutSize → evaluateCandidates
        → predictWithModel × (naive_last, moving_avg, seasonal_naive, lightgbm_api)
        → calcMetrics (MAE, MAPE on non-zero actuals)
      → select best → predictWithModel(horizon) → toCanonicalForecastPoint
  → buildQuantileCalibration → applyCalibratedQuantiles
  → save artifacts → RETURN
```

### Hardcoded Thresholds
| Value | What | Location |
|-------|------|----------|
| 25 | MAX_GROUPS_IN_ARTIFACT | chatForecastService:19 |
| 8 | min mapped rows | chatForecastService:622 |
| 3 | min series length per group | chatForecastService:633 |
| 4 | min history for evaluateCandidates | chatForecastService:666 |
| 10 | min train for lightgbm_api | chatForecastService:471 |
| 4 | moving_average window | chatForecastService:295 |
| 10000ms | lightgbm_api timeout | chatForecastService:455 |
| 30 | MIN_SERIES_CALIBRATION_SAMPLES | calibrateQuantiles:4 |
| 0.9 / 0.1 | p90/p10 quantiles | calibrateQuantiles:5-6 |
| 14/8/6 | default horizon daily/weekly/monthly | chatForecastService:128-131 |

### Non-negative: Yes (lines 216, 698, 725, calibrateQuantiles:155/160/163, forecastPointMapper:22/27/32)
### p10≤p50≤p90: Yes (calibrateQuantiles:159-163, forecastPointMapper:22-32)

---

## Tool 2: `run_ml_forecast` (Python, tier_b)

### File Path & Entry
- `src/ml/api/main.py:805` → `demand_forecast()`
- Engine: `src/ml/demand_forecasting/forecaster_factory.py`
- Catalog: builtinToolCatalog.js L420

### Input Schema
```python
sku: str, horizon_days: int, preferred_model: str = "auto",
inline_history: list[float], granularity: str = "daily"
```

### Output Schema
```python
{ success, prediction: { predictions, p10, p50, p90, ci, risk_score, model_used },
  metadata: { training_data_points, forecast_horizon },
  forecast_contract_version: "1.0" }
```

### Complete Call Chain
```
POST /demand-forecast
  → validate_forecast_payload → predict_with_prod_pointer
    → predict_with_champion → predict_with_fallback
      → IF auto + >=30pts: ensemble_race (ThreadPoolExecutor, 5 strategies)
      → ELSE: recommend_model → try each in fallback_order
      → Strategy.predict() → backtest → _scale_ci_to_quantiles
  → finalize_forecast_response
```

### 5 Strategies
| Strategy | Real Model | Fallback |
|----------|-----------|----------|
| Prophet | fbprophet | seasonal decomposition |
| LightGBM | lgbm_model.pkl + 19 features | moving average |
| Chronos | torch + chronos-t5 | normal distribution simulation |
| XGBoost | xgb_model.pkl | exponential smoothing |
| ETS | statsmodels ExponentialSmoothing | simple exponential smoothing |

### Hardcoded Thresholds
(From Path B verification — pending completion)

---

## Tool 3: `run_cost_forecast` (JS, tier_c)

### File Path & Entry
- `src/services/forecast/costForecastService.js` → `runCostForecast()`
- Domain: `src/domains/inventory/costForecast.js`

### Dependencies: `['run_plan']`

### Input: userId, sourceRunId, options (ruleSetId, useProbInputs)
### Output: { success, costRunId, kpis: { expedite, substitution, disruption totals }, metrics }

### Default Cost Rules
- expedite: $5/unit, max 1000 qty
- substitution: $5K fixed + $2.5/unit, 7 day setup
- disruption: $50K if stockout, $10K/bucket, min p=0.1

### 3-tier input fallback: prob_summary → component_demand → inventory_snapshots

---

## Tool 4: `run_revenue_forecast` (JS, tier_c)

### File Path & Entry
- `src/services/forecast/revenueForecastService.js` → `runRevenueForecast()`
- Domain: `src/domains/inventory/revenueForecast.js`

### Dependencies: `['run_bom_explosion']`

### Input: userId, sourceBomRunId, options (demandSource, riskInputMode, dryRun)
### Output: { success, revenueRunId, kpis: { totalMarginAtRisk, totalPenaltyAtRisk, totalAtRisk, topFg, byPlant }, metrics }

### Formula
```
margin_at_risk = impacted_qty × margin_per_unit
penalty_at_risk = penalty_value × impacted_qty (if penalty_type != 'none')
total_at_risk = margin + penalty
```

### Requires: revenue_terms table pre-loaded in DB
### Default risk (no risk data): 30% demand impacted, pStockout=0.3
