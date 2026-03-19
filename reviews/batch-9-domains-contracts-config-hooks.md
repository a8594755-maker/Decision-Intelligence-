# Batch 9: src/domains/** + contracts + config + hooks — Findings Memo

**Scope**: ~63 files, ~17.1k LOC | **Tests**: 249/249 pass (11 test files) | **Date**: 2026-03-18

---

## Confirmed Defects

### [P1] `coverageCalculator.js:38-48` — Incorrect ISO week calculation
`getCurrentTimeBucket()` uses `Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7)` which does not match ISO 8601 (weeks start Monday, week 1 contains Jan 4th). Off-by-one around year boundaries. Same bug in `supplyForecastEngine.js:46-48`.
- **Impact**: Wrong week buckets near year boundaries → incorrect coverage/risk calculations.
- **Fix direction**: Extract correct ISO 8601 week function using Thursday-based algorithm into shared utility.

### [P1] `inventoryProbForecast.js:555` — All Monte Carlo keys use identical seed
Same `seed` value passed to `runMonteCarloForKey()` for every key in the loop. All material-plant keys get identical pseudo-random sequences → spurious correlation across keys.
- **Impact**: Monte Carlo simulation results are correlated when they should be independent.
- **Fix direction**: Derive per-key seed: `seed + keyIndex` or hash of `seed + key`.

### [P2] `useBOMData.js:78` — Unsanitized user input in ilike query
Filter values interpolated directly into `%${val}%` without escaping `%`, `_`, `\`.
- **Fix direction**: Escape special characters before interpolation.

### [P2] `useForecastData.js:98` — Unnecessary dependency causes potential re-fetch loop
`loadRunData` includes `selectedMaterial` in deps, but sets `selectedMaterial` inside itself.

### [P3] `whatIfEngine.js:159` — Dead variable `_netAvailable`

---

## Inferred Risks

| ID | Risk | Severity |
|----|------|----------|
| IR-1 | 52-week year assumption in bucket arithmetic (riskScore, whatIfEngine, supplyForecastEngine) | P2 |
| IR-2 | `actionRecommender.js:32` module-level mutable counter leaks across tests | P2 |
| IR-3 | `usePermissions.jsx` module-level mutable flags (no TTL reset) | P2 |
| IR-4 | `useRiskData.js` — `generateActionsBatch` imported but never called | P3 |
| IR-5 | `diArtifactContractV1.js:944-951` — inconsistent validator path convention | P3 |
| IR-6 | `supplyForecastEngine.js:86` — `new Date()` makes function impure/untestable | P3 |

---

## Redundancy and Simplification

| Pattern | Recommendation | Rationale |
|---------|---------------|-----------|
| ISO week calculation (2 files, both wrong) | **Merge** → correct shared function | ~60 LOC, eliminates bug in both |
| Bucket parsing/arithmetic (4+ files) | **Merge** → `src/utils/timeBucket.js` | ~120 LOC duplicated |
| `supplyForecastEngine._targetBuckets:368` | **Delete** | Assigned but never read |
| `supplyForecastEngine` default export duplicates named exports | **Simplify** | Remove default export or named exports |

---

## Test Coverage Gaps

**~35% of batch LOC has direct tests.** 17 areas with zero coverage:

| Critical (domain logic) | hooks/config |
|------------------------|--------------|
| coverageCalculator.js | useRiskData, useForecastData, useBOMData |
| riskScore.js | useDecisionOverview |
| whatIfEngine.js | usePermissions.jsx |
| inventoryProbForecast.js | headerSynonyms.js |
| supplyForecastEngine.js | capabilityMatrix.js |
| bomCalculator.js | fallbackPolicies.js |
| costForecast.js, revenueForecast.js | planningApiContractV1.js |

---

## Batch Summary

Domain logic modules (risk, inventory, supply) contain the most critical business calculations. Two P1 defects: incorrect ISO week calculation affecting coverage/risk and correlated Monte Carlo seeds producing spurious correlation. Bucket parsing/arithmetic is duplicated across 4+ files with a 52-week year assumption that breaks on ISO 53-week years. The existing 249 tests cover calculator, actionRecommender, and inventoryProjection well, but the majority of domain logic (coverageCalculator, riskScore, whatIfEngine, inventoryProbForecast, supplyForecastEngine, bomCalculator) has zero test coverage.
