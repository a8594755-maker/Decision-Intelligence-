# Batch 8: src/utils/** — Findings Memo

**Scope**: 61 files, ~12.5k LOC | **Tests**: 161/161 pass (19 test files) | **Date**: 2026-03-18

---

## Confirmed Defects

### [P2] `fieldPatternInference.js:48` — Operator precedence bug in `looksLikeQuantity`
`Number.isFinite(n) && n >= 0 && Number.isInteger(n) || (n >= 0 && n < 1e9)` — `||` has lower precedence than `&&`, making the integer check dead code (subsumed by range check in second branch).
- **Impact**: Function works but logic is misleading; first branch is dead.
- **Fix direction**: Simplify to `Number.isFinite(n) && n >= 0 && n < 1e9` or add explicit parentheses.

### [P2] `dataValidation.js:708-712` — Warning shows "open" instead of original invalid status
`row.status` mutated to `'open'` on line 708, then warning reads `row.status` on line 712 — always shows "open".
- **Impact**: User sees nonsensical warning message, loses original invalid value.
- **Fix direction**: Capture original value before mutation.

### [P3] `dataValidation.js:49-51` — Excel date epoch uses local time, inconsistent with 3 other implementations
`new Date(1900, 0, 1)` (local) vs `Date.UTC(1899, 11, 30)` (UTC) in dataServiceHelpers, dataCleaningUtils, timeColumnDetection.
- **Impact**: 1-day drift for Excel serial dates in non-UTC timezones. Affects real user data in import pipeline.
- **Fix direction**: Standardize on `Date.UTC(1899, 11, 30)` across all files.

### [P3] `dataValidation.js:309,326,585` — ISO week year uses wrong variable
`date.getFullYear()` instead of `d.getUTCFullYear()` after Thursday adjustment. For dates near year boundaries, year and week can be inconsistent. Copy-pasted 3 times.
- **Fix direction**: Use `d.getUTCFullYear()` after adjustment. Extract shared ISO week helper.

---

## Inferred Risks

| ID | Risk | Evidence |
|----|------|----------|
| IR-1 | `dataValidationWorkerClient.js:29-30` — Worker onerror silently drops pending promises | `_pending` entries never rejected; callers hang forever. Same in `xlsxParserWorkerClient.js:28-29` |
| IR-2 | `artifactStore.js:100-126` — Silent fallback to local stub creates fake file_id | Subsequent `loadArtifact` fails silently (returns null) |
| IR-3 | `replaySimulator.js:183` — Negative `on_hand_end` accumulates unbounded deficit | By design but misleading with data errors |

---

## Redundancy and Simplification

| Pattern | Files | Recommendation |
|---------|-------|----------------|
| Excel date parsing (4 implementations, inconsistent epoch) | dataValidation, dataCleaningUtils, dataServiceHelpers, timeColumnDetection | **Merge** → single `parseExcelSerialDate()` |
| `safeNum`/`toNumber` (5+ copies) | buildDecisionNarrative, buildMultiScenarioSummary, buildScenarioComparison, reusePlanner, exportWorkbook, dataServiceHelpers | **Merge** → import from dataServiceHelpers |
| `normalizeText` (4+ copies) | replaySimulator, datasetSimilarity, reusePlanner, dataServiceHelpers | **Merge** → import from dataServiceHelpers |
| ISO week calculation (3 copies in dataValidation + 1 in dataServiceHelpers) | dataValidation:303,319,577 + dataServiceHelpers:61 | **Collapse** → shared `dateToIsoWeekBucket()` |
| `dataCleaningUtils.js` vs `dataValidation.js` | 2 overlapping validation pipelines | **Delete** legacy `dataCleaningUtils`, redirect imports |
| `requiredMappingStatus.js` vs `mappingValidation.js` | 2 overlapping mapping status modules | **Merge** — add confidence features to deterministic version |

---

## Test Coverage Gaps

**19 test files, 161 tests all pass.** But critical gaps:

| File (no tests) | LOC | Risk |
|-----------------|-----|------|
| `dataValidation.js` | ~1100 | **Critical** — primary import pipeline, contains confirmed timezone bug |
| `dataServiceHelpers.js` | ~153 | High — shared module, no dedicated tests (transitive only) |
| `artifactStore.js` | ~200 | High — critical save/load pipeline |
| `dataCleaningUtils.js` | ~300 | Medium — legacy validation |
| `mappingValidation.js` | ~200 | Medium — confidence scoring |
| `exportWorkbook.js` | ~400 | Medium — multi-sheet Excel export |
| `aiMappingHelper.js` | ~200 | Medium — JSON extraction + partial repair |
| `headerNormalize.js` | ~100 | Low — BOM/fullwidth handling |

---

## Batch Summary

Core utilities (constraintChecker, replaySimulator, scenarioKey) are well-designed pure functions with good test coverage. Data mapping chain (deterministicMapping, headerNormalize, fieldPatternInference) is architecturally sound.

Key concerns: (1) Excel date epoch inconsistency (local vs UTC) in the primary import pipeline — affects real user data. (2) Significant redundancy: 4 Excel date parsers, 5+ copies of `safeNum`/`toNumber`, 4+ copies of `normalizeText`. (3) `dataValidation.js` (1100 lines, primary import pipeline) has zero tests despite containing confirmed bugs.
