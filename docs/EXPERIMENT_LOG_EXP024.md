## EXP-024: Metric Contract + Quarantine — V3 Quality Evaluation
**Date:** 2026-04-06
**Hypothesis:** Adding metric contract, benchmark policy, quarantine, and forecast contract would make analysis consistently accurate
**Why it matters:** Analysis quality went from 6/10 → 8.4/10 across 3 versions; need to close remaining gaps for demo-ready quality
**Experiment:** Ran Superstore through full pipeline after metric contract + benchmark policy + quarantine + forecast contract changes
**AI tools used:** GPT-5.4 (reasoning=high) for 5 agents, DeepSeek for tool selection + KPI code generation

**Evidence (V3 vs V1/V2):**
| Metric | V1 | V2 | V3 |
|--------|-----|-----|-----|
| Furniture 2.49% margin | ❌ | ❌ | ✅ #1 risk |
| Tables -8.56% sub-cat | ❌ | ❌ | ✅ identified |
| Quantified loss | ❌ | ❌ | ✅ "$109K shortfall" |
| Central 7.92% margin | ❌ | ❌ | ✅ #3 risk |
| Metric definition audit | ❌ | ❌ | ✅ Reviewer caught |
| KPI accuracy | 9/10 | 9.5/10 | 9.5/10 |
| Insight depth | 6/10 | 7/10 | 8.5/10 |
| Actionability | 7/10 | 8.5/10 | 9/10 |

**Key turning point:** KPI executor started computing `profit_margin_by_category` and `subcategory_performance` — gave agents the data they needed.

**Remaining issues (V3):**
1. Reviewer knows metric contract better than analysts — front agents not fully absorbing structured facts
2. date aggregation vs raw date distinction still wobbly in narrative
3. 6205 anomalies + 8 critical should be major finding, not footnote
4. `total_revenue = sum(net_revenue)` definition vs `effective_discount_rate` base ambiguity
5. Missing: discount by category, Consumer segment margin, Bookcases depth analysis

**Decision:** Focus next round on (a) structured claims to force agents to cite metric_id, (b) anomaly count auto-escalation, (c) discount-by-dimension breakdown
**Impact:** 8.4/10 overall (best version), but bottleneck shifted from analysis ability to metric definition consistency
