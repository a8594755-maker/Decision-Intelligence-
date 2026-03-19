# Batch 2: src/services/negotiation/** — Findings Memo

**Scope**: 26 files, ~9.3k LOC | **Tests**: 203 pass | **Date**: 2026-03-18

---

## Confirmed Defects

### [P1] `binary-strategy-format.js:186` — Hash collision yields wrong strategy silently
The binary search in `BinaryStrategyReader.lookup()` finds the first hash match but does not verify the original key string. FNV-1a 32-bit has non-trivial collision probability. For negotiation tree sizes (~100-200 info sets), practical risk is very low, but a collision would return wrong action probabilities with no error signal.
- **Impact**: Wrong CFR strategy returned silently.
- **Evidence**: Line 186 — match on hash only, no key verification.
- **Fix direction**: Store original key in body alongside probs, verify after hash match.

### [P1] `negotiation-types.js:109-113` — `computeSupplierTypePriors` fragile against negative probabilities
Code subtracts `shift/2` from cooperative and aggressive without clamping. Currently safe with hardcoded thresholds, but any config change could produce negatives → NaN after normalization.
- **Impact**: Currently safe but fragile.
- **Evidence**: Lines 109-113 lack `Math.max(0, ...)` clamping.
- **Fix direction**: Add `Math.max(0, ...)` around each subtraction.

### [P2] `negotiation-game-adapter.js:189,291` — Direct access to private `_negotiations` Map
`processSupplierEvent` iterates `tracker._negotiations` and `updateSupplierPriors` directly mutates internal state, breaking encapsulation.
- **Impact**: Tight coupling; refactoring tracker internals requires adapter changes.
- **Fix direction**: Add public `getActiveNegotiations()` and `updateKpis()` methods to tracker.

### [P2] `negotiationOrchestrator.js:587` — Position strength lookup uses raw array index
`['VERY_WEAK',...][cfrEnrichment.buyer_bucket]` without bounds check. Same pattern in `negotiation-draft-generator.js:307`.
- **Impact**: Low — fallback exists, but error-prone.
- **Fix direction**: Use `POSITION_BUCKET_NAMES` from `negotiation-types.js`.

### [P2] `binary-strategy-format.js:79-92` — Index buffer over-allocates
12 bytes per entry allocated but only 8 bytes written to final buffer.
- **Impact**: Minor memory waste during buffer construction.

---

## Inferred Risks

| ID | Risk | Evidence | Depends on |
|----|------|----------|------------|
| IR-1 | Singleton state lost on HMR | `let _instance = null` pattern in 3 modules | Vite HMR config |
| IR-2 | Sequential option evaluation (6 plan runs × 2-5s = 12-30s) | `for` loop at evaluator:172 | Planning service speed |
| IR-3 | Supabase→localStorage fallback with no sync-back | persistence:22-29 | No periodic sync found |
| IR-4 | `_recentTriggers` Map unbounded (theoretical, very low risk) | orchestrator:44-57 | Session duration |

---

## Redundancy and Simplification

| Module/Pattern | Recommendation | Rationale |
|---|---|---|
| `toNumber()` helper | **Merge** | Identical in orchestrator:87 and evaluator:21 |
| Number fabrication detection | **Merge** | Near-identical in reportBuilder:65-99 and draft-generator:105-144 |
| Position bucket array lookup | **Merge** | Inline arrays in 2 files; use `POSITION_BUCKET_NAMES` |
| `nowIso()` helper | **Keep** | Trivial one-liner |
| StateTracker + PersistenceService | **Keep** | Intentional dual-layer (fast cache + durable storage) |
| `orchestrator._baseMoqRows` (line 268-269) | **Delete** | Dead code, always null |
| `baseConstraints.proof_constraints` (line 279) | **Delete or use** | Assigned but never read |

---

## Test Coverage Gaps

1. **negotiationOrchestrator.js** — zero direct unit tests (only indirect integration)
2. **negotiationReportBuilder.js** — no direct tests (LLM call, fallback, evidence extraction)
3. **negotiationPersistenceService.js** — no tests (CRUD, localStorage fallback)
4. **negotiationApprovalBridge.js** — limited tests (KPI impact, rationale building gaps)
5. **negotiation-draft-generator.js** — no tests (draft generation, tone fallbacks)
6. **negotiation-game-adapter.js** — `updateSupplierPriors` and `processUserAction` untested
7. **Binary strategy format** — no roundtrip test (writer→reader)

---

## Batch Summary

Well-structured, architecturally sound module. CFR engine is correctly implemented (verified by Kuhn poker convergence tests). All 203 tests pass. Good patterns: deterministic option generation, evidence-first LLM validation, graceful degradation without CFR.

Key concerns: (1) two P1 defects (hash collision, fragile priors), (2) encapsulation violations in game adapter, (3) substantial test gaps on orchestrator, report builder, persistence, and draft generator. Sequential option evaluation is a latent performance concern.
