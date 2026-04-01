# LLM Usage Audit

## Summary

| Category | Python | JS | Total |
|----------|--------|----|-------|
| ✅ JUSTIFIED | 10 | 18 | **28** |
| ⚠️ QUESTIONABLE | 8 | 12 | **20** |
| ❌ SHOULD REPLACE | 7 | 7 | **14** |
| **Total** | **25** | **37** | **62** |

---

## Python Backend LLM Calls

### ❌ SHOULD REPLACE (7 calls)

| # | Location | Pipeline | What LLM does | Replacement |
|---|----------|----------|---------------|-------------|
| 1 | kpi_calculator.py:1789 | KPI config fallback | Maps columns → calculators | `build_kpi_config_from_profile()` already exists |
| 2 | variance_analyzer.py:840 | Variance config fallback | Maps columns → analyzers | `build_variance_config_from_profile()` already exists |
| 3 | anomaly_engine.py:1183 | Anomaly config | Maps columns → detectors | `build_auto_config()` already exists but not wired in `execute_anomaly_pipeline` |
| 4 | tool_executor.py:2273 | /agent/mbr-kpi | KPI via LLM | Remove LLM, use deterministic only |
| 5 | tool_executor.py:2303 | /agent/mbr-variance | Variance via LLM | Remove LLM, use deterministic only |
| 6 | mbr_agent.py:481 | MBR → KPI | Passes LLM to KPI pipeline | Don't pass LLM caller |
| 7 | mbr_agent.py:515 | MBR → Variance | Passes LLM to variance pipeline | Don't pass LLM caller |

**Policy:** CLAUDE.md `feedback_kpi_no_llm.md` — "KPI/margin/variance tools should not call LLM for column mapping"

**Estimated savings:** ~7 LLM calls × 3-5s each = 21-35s per MBR run

### ⚠️ QUESTIONABLE (8 calls)

| # | Location | Pipeline | What LLM does | Could replace with |
|---|----------|----------|---------------|--------------------|
| 1 | tool_executor.py:1396 | Cleaning bootstrap | Maps ALL columns for new workbook | Broader synonym dict + LLM only for unknowns |
| 2 | tool_executor.py:1422 | Cleaning incremental | Maps new columns only | Same |
| 3 | tool_executor.py:1619 | Cleaning parallel | Per-sheet bootstrap | Same |
| 4 | tool_executor.py:1768 | Cleaning single-sheet | Single sheet mapping | Same |
| 5 | mbr_agent.py:947 | MBR Planner | Picks tools from list | Rule-based: if has_target→add_variance, if has_cost→add_margin |
| 6 | mbr_data_cleaning.py:1281 | Column mapping | Entity resolution | Synonym dict + LLM fallback |
| 7 | deep_clean.py:644 | Deep clean ops | Picks fix operations | Extend `_apply_builtin_fixes` with more rules |
| 8 | mbr_report_builder.py:790 | Report planner | Plans Excel layout | Fixed template with conditional sections |

### ✅ JUSTIFIED (10 calls)

| # | Location | Pipeline | Why justified |
|---|----------|----------|---------------|
| 1 | tool_executor.py:1153 | Code generation | NL → Python code synthesis |
| 2 | tool_executor.py:1188 | Code gen retry (syntax) | Self-correction requires NL understanding |
| 3 | tool_executor.py:1256 | Code gen retry (runtime) | Error interpretation |
| 4 | mbr_agent.py:1095 | Synthesizer streaming | Narrative generation from structured data |
| 5 | mbr_agent.py:1102 | Synthesizer non-stream | Same |
| 6 | gpt_bootstrap.py:223 | Full rule bootstrap | Cold-start for unknown schemas |
| 7 | agent_loop_runner.py:444 | Workspace codegen | Multi-step task code synthesis |
| 8 | agent_loop_runner.py:937 | Excel codegen (Opus) | Complex formatted Excel generation |
| 9 | excel_export.py:591 | Excel insights | NL narrative for export |
| 10 | claude_proxy.py:136 | Excel Add-in proxy | User-facing queries |

---

## JS Frontend LLM Calls (37 call sites across 20 files)

### ❌ SHOULD REPLACE (7 calls)

| # | Location | Feature | What LLM does | Replacement |
|---|----------|---------|---------------|-------------|
| 1 | KpiLabView.jsx:195 | KPI Lab column mapping | Maps columns → calculators | deterministic `build_kpi_config_from_profile` |
| 2 | VarianceLabView.jsx:159 | Variance Lab mapping | Maps columns → analyzers | deterministic config builder |
| 3 | AnomalyLabView.jsx:137 | Anomaly Lab mapping | Maps columns → detectors | `build_auto_config` |
| 4 | oneShotAiSuggestService.js:171 | Sheet type classification | Classifies sheet type | Improve `classifySheet()` local classifier |
| 5 | oneShotAiSuggestService.js:233 | Field mapping | Maps columns → schema | `headerSynonyms.js` + `fieldPatternInference.js` |
| 6 | chartEnhancementService.js:62 | Chart styling | Suggests colors/labels | Deterministic style rules by chart type |
| 7 | EnhancedExternalSystemsView.jsx:492 | External field mapping | Maps columns → schema | Same as #5 |

### ⚠️ QUESTIONABLE (12 calls)

| # | Location | Feature | Could replace with |
|---|----------|---------|-------------------|
| 1-4 | MbrLabView.jsx:224/272/335/397 | Cleaning bootstrap/incremental/deep | Broader synonym dict, LLM only for unknowns |
| 5 | insightsHubAgent.js:431 | Dashboard layout | Sort by severity + group by type |
| 6 | insightsHubAgent.js:518 | Dashboard review | Deterministic value cross-check |
| 7 | dashboardSummaryAgent.js:202 | Dashboard summary | `buildDeterministicSummary` already exists |
| 8 | errorDiagnosticService.js:151 | Error diagnosis | Pattern-matching diagnostic engine |
| 9 | chatPlanningService.js:832 | Blocking questions | Template-based questions |
| 10 | chatPlanningService.js:1679 | Readiness check | `capabilityMatrix.js` already has logic |
| 11 | chartArtisanService.js:328 | Chart HTML gen | Expand deterministic chart builder |
| 12 | agentCandidateJudgeService.js:233 | Response judge | Deterministic scoring criteria |

### ✅ JUSTIFIED (18 calls)

Agent loops (2), chat streaming (3), NL-to-SQL (2), insights planner/worker (2), health scanner (1), forecast synthesis (1), report generation (3), review learning (1), dynamic tool gen (2), tool blueprint (1), negotiation drafts (2), evidence synthesis (1)

---

## Priority Actions

### Immediate (Quick Wins)

1. **Remove LLM fallback from KPI/Variance/Anomaly config builders**
   - Files: kpi_calculator.py, variance_analyzer.py, anomaly_engine.py
   - Change: If deterministic config is empty, return error (per `feedback_no_fallback.md`), don't call LLM
   - Savings: ~7 calls × 3-5s = 21-35s per MBR run
   - Risk: None — deterministic builders already work; empty result = profiler bug to fix

2. **Wire `build_auto_config` in `execute_anomaly_pipeline`**
   - File: anomaly_engine.py
   - Change: Use `build_auto_config(profile)` as primary, remove LLM call
   - MBR agent already does this correctly at mbr_agent.py:524-528

3. **Route excel_export.py through central `_call_llm`**
   - Currently makes direct httpx call to DeepSeek
   - Should use `_call_llm` for provider switching + proxy routing

### Medium Term

4. **Replace MBR Planner with rule-based**
   - Heuristic: `_classify_sheet` already knows sheet types → tool selection is deterministic
   - Keep LLM planner as optional "smart" mode
   - Savings: 1 LLM call × 3-5s

5. **Expand cleaning synonym dictionary**
   - Reduce bootstrap LLM calls for common column patterns
   - Keep LLM only for truly novel CJK/domain-specific headers

### Later

6. **Template-based report builder**
   - Fixed Excel template with conditional sections
   - Savings: 1 LLM call × 5-10s for report layout planning

---

## LLM Budget Estimate (per MBR run)

### Current
| Step | LLM calls | Avg latency | Total |
|------|-----------|-------------|-------|
| Planner | 1 | 3s | 3s |
| Data cleaning (bootstrap) | 1-6 (per sheet) | 5s each | 5-30s |
| KPI config (LLM fallback) | 0-1 | 5s | 0-5s |
| Variance config (LLM fallback) | 0-1 | 5s | 0-5s |
| Anomaly config (LLM) | 0-1 | 5s | 0-5s |
| Synthesizer | 1 | 5-10s | 5-10s |
| Report builder | 1 | 5s | 5s |
| **Total** | **5-12** | — | **23-58s** |

### After optimization (remove ❌)
| Step | LLM calls | Avg latency | Total |
|------|-----------|-------------|-------|
| Planner (rule-based) | 0 | 0s | 0s |
| Data cleaning (bootstrap) | 1-6 | 5s each | 5-30s |
| KPI config (deterministic) | 0 | 0s | 0s |
| Variance config (deterministic) | 0 | 0s | 0s |
| Anomaly config (deterministic) | 0 | 0s | 0s |
| Synthesizer | 1 | 5-10s | 5-10s |
| Report builder | 1 | 5s | 5s |
| **Total** | **3-8** | — | **15-45s** |

**Savings: 2-4 LLM calls, 8-13s faster per run**

For repeat runs (rule store exists):
| Step | LLM calls | Total |
|------|-----------|-------|
| Cleaning (engine_only) | 0 | 0s |
| Synthesizer | 1 | 5-10s |
| Report builder | 1 | 5s |
| **Total** | **2** | **10-15s** |
