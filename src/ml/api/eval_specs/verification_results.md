# Forecast Tool Verification Results

## Path A: `run_forecast` (JS frontend) — 8/8 pass

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| A1 | Predictions non-negative | ✅ | chatForecastService:216,698,725; calibrateQuantiles:155/160/163; forecastPointMapper:22/27/32 |
| A2 | p10 <= p50 <= p90 | ✅ | calibrateQuantiles:159-163 + forecastPointMapper:22-32 (dual enforcement) |
| A3 | MAPE division by zero | ✅ | chatForecastService:330 filters zero actuals; all-zero → null |
| A4 | Holdout no overlap | ✅ | chatForecastService:468-469 complementary slices |
| A5 | p90 < p50 impossible | ✅ | calibrateQuantiles:159-160 clamps upperResidual >= 0 |
| A6 | < 3 data points | ✅ | :633 filters; :622 throws if < 8 total |
| A7 | NaN propagation | ✅ | :214-217 returns null for NaN; dropped at :240 |
| A8 | lightgbm_api timeout | ✅ | :500 catches; :685-687 falls back to naive_last |

## Path B: `run_ml_forecast` (Python) — 9 pass, 1 warning, 1 bug

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| B1 | Non-negative all strategies | ✅ | Prophet:206, LightGBM:388, Chronos:533, XGBoost:685, ETS:818 + all fallbacks |
| B2 | p10 <= p50 <= p90 | ✅ | _scale_ci_to_quantiles:55-75 + Chronos:576-577 + forecast_contract:234-237 |
| B3 | MAPE div-by-zero | ✅ | forecaster_factory:1717-1719 `mask=actual!=0; all-zero→999.0` |
| B4 | Feature schema match | ✅ | forecaster_factory:384 (LightGBM), :682 (XGBoost) call assert_feature_schema |
| B5 | Fallback chain | ✅ | forecaster_factory:1326-1346 try/except, continues to next model |
| B6 | Ensemble thread safety | ✅ | No shared mutable state; results on main thread :1409-1415 |
| B7 | Chronos determinism | ⚠️ | :533/539/550/557 `np.random.normal()` no seed — non-deterministic |
| B8 | Prophet min data | ✅ | :173-176 `6 if month else 14` — reasonable |
| B9 | Contract version | ✅ | forecast_contract:191-193 always set |
| B10 | Data validation timing | ❌ BUG | main.py:999 reports only; models get uncleaned input |
| B11 | ETS all-zero | ✅ | :791 `np.maximum(arr, 0.01)` + triple fallback :796-815 |

## Bug: B10 — Data Cleaning Not Applied to Model Input

**Location:** `src/ml/api/main.py:988-1002`

`validate_and_clean_series` is called AFTER forecast, only for quality reporting. Cleaned series is discarded. Models receive raw `inline_history` with potential negatives, duplicates, missing dates.

**Impact:** Input quality degrades predictions. Output is safe (max(0, pred)) but accuracy suffers.

**Fix:** Call before predict, use cleaned series:
```python
cleaned_series, report = validate_and_clean_series(raw_series)
result = factory.predict_with_fallback(..., inline_history=cleaned_series.values)
```

## Warning: B7 — Chronos Non-Deterministic

`np.random.normal()` with no seed. Same input → different output. Valid for stochastic forecasting but breaks exact-value eval assertions. Recommend optional `seed` parameter.
