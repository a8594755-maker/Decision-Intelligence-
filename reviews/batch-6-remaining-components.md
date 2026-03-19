# Batch 6: Remaining src/components/** — Findings Memo

**Scope**: ~82 files, ~18.5k LOC | **Tests**: 54/54 pass (3 test files) | **Date**: 2026-03-18

---

## Confirmed Defects

### [P1] `ConsensusWarning.jsx:106-108,124,160,173,188,195,202` — Dynamic Tailwind classes in full mode
Full-size render path still uses `getLevelColor()` with string interpolation (`text-${levelColor}-600`, `bg-${levelColor}-50`, etc.). The compact mode uses static `LEVEL_STYLES` map correctly, but full mode classes will be purged in production.
- **Fix direction**: Extend `LEVEL_STYLES` to cover full mode. `getLevelColor()` becomes dead code after fix.

### [P1] `ModelToggle.jsx:77-78,84,131-132,158,205` — Dynamic Tailwind classes
`border-${getModelColor(model.id)}-500`, `bg-${...}-50`, `text-${...}-600` — all will be purged.
- **Fix direction**: Static color map keyed by model.id.

### [P1] `DecisionReviewPanel.jsx:392-393` — Dynamic Tailwind classes in DecisionButton
`bg-${color}-100`, `border-${color}-400`, etc. with 4 color values (emerald, red, amber, slate).
- **Fix direction**: Static map from color to full class strings.

### [P2] `ProbabilisticSection.jsx:103` — Extra closing brace in className
`}}` produces literal `}` in the rendered class string. Should be `}`}.
- **Impact**: Garbage character injected into DOM class name.

### [P2] `MappingProfileManager.jsx:36` — Uses `window.confirm()` for delete
Blocks main thread, not accessible.
- **Fix direction**: Replace with Modal component.

### [P2] `RiskScoreSection.jsx:89` — Uses `window.location.reload()` instead of React state refresh
Loses all in-memory state.

### [P3] `Modal.jsx` — Missing focus trap and Escape key handler
`SidePanel.jsx` correctly implements ESC and scroll-lock but Modal does not. Accessibility gap (WCAG 2.4.3).

### [P3] `ViewDataModal.jsx:36` — Stale closure risk from eslint-disable
`loadData` references props that could change. If modal stays mounted while props change, stale data.

### [P3] `RiskScoreSection.jsx:62` — Missing `riskScoreData` in useEffect deps
Prop changes won't trigger effect re-run.

### [P3] `FeatureImportancePanel.jsx:37-39` — Empty deps array suppresses fetchImportance dep
Not a runtime bug but fragile to future refactoring.

---

## Inferred Risks

| ID | Risk | Evidence |
|----|------|----------|
| IR-1 | Badge prop mismatch: some consumers pass `variant` but Badge uses `type` | CostSection:159 passes `variant="red"` — silently renders wrong color |
| IR-2 | WhatIfPanel polling stale closure | eslint-disable on `startPolling` deps, `loadComparison` identity may change |
| IR-3 | ExemplarUploadPanel + OnboardingWizard inject duplicate `@keyframes spin` via inline `<style>` | Both mount → duplicate global styles |
| IR-4 | EmployeeProfilePanel:61 — 30s polling accumulates on rapid mount/unmount | Tab switching could stack stale fetches |

---

## Redundancy and Simplification

| Pattern | Recommendation | Rationale |
|---------|---------------|-----------|
| `ErrorBoundary` vs `ViewErrorBoundary` | **Merge** | Nearly identical error UI rendering |
| `KPIPill` in ForecastWidget + PlanTableWidget | **Merge** | Identical sub-component defined twice |
| `getModelIcon` in ConsensusWarning + ConfidenceOverlayChart | **Merge** | Shared utility |
| `getLevelColor()` in ConsensusWarning | **Delete** (after P1 fix) | Dead code once LEVEL_STYLES extended |
| Output-profile components use inline `style={{}}` | **Collapse** | 5 files inconsistent with Tailwind codebase |
| `KpiTile` name collision in 2 files | **Keep but note** | Different scopes, confusing not broken |

---

## Test Coverage Gaps

- **3 P1 components** (ConsensusWarning, ModelToggle, DecisionReviewPanel) — zero tests, Tailwind purge would be caught by visual regression
- `DataImportPanel.jsx` (~1000+ lines, XLSX wizard) — zero tests
- `WhatIfPanel.jsx` (async polling + state machine) — zero tests
- `Modal.jsx` (missing a11y) — zero tests
- All `whatif/` (8 files), `output-profile/` (5 files), `risk/` sub-sections (15+ files except RiskCard) — zero tests

**Coverage**: 3 of ~82 files have tests (3.7%).

---

## Batch Summary

Most impactful: **3 Tailwind dynamic class purge defects** (P1) in ConsensusWarning, ModelToggle, DecisionReviewPanel — visually broken in production while correct in dev. The `ProbabilisticSection.jsx` double-brace typo (P2) injects garbage into DOM. One `window.confirm()` usage remains in MappingProfileManager. Generally sound React patterns, but style inconsistency between Tailwind-first and inline-style components is a maintenance concern. Test coverage at 3.7%.
