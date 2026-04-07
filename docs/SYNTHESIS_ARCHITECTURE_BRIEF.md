# SmartOps Synthesis Architecture — Current State & Bottleneck

## What This System Does

SmartOps is an AI Digital Worker for supply chain operations. Users upload Excel/CSV data (sales, procurement, inventory, etc.) and the system autonomously:

1. Cleans the data
2. Runs analysis tools (KPI calculation, anomaly detection, forecasting, etc.)
3. Synthesizes a structured executive report with recommendations

The goal is to replace manual analyst work end-to-end. Not a copilot — a worker.

---

## Pipeline Architecture

```
User uploads Excel
    ↓
Tool Selector (LLM #1: DeepSeek) — picks 3-7 tools from 63 available
    ↓
Deterministic Execution (0 LLM calls):
  - Data Cleaning → cleaned DataFrame
  - KPI Calculation → LLM generates pandas code → sandbox executes → scalar KPIs + breakdowns
  - Anomaly Detection → z-score + IQR outliers
  - Forecasting → 5-model ensemble race
  - etc.
    ↓
Metric Contract (deterministic):
  - Normalizes all KPI artifacts into canonical {metric_id, value, unit, aggregation, definition}
  - Resolves conflicts when same metric appears in multiple artifacts
  - Quarantines meaningless aggregates (date-sums, ID-sums)
    ↓
Benchmark Policy (deterministic):
  - For each breakdown (e.g., margin by category), computes peer benchmark
  - Method: peer_median_excluding_self (if 3+ rows) or peer_average (if 2)
  - Pre-computes delta and delta_pct for every row
    ↓
Synthesis (LLM #2-6: GPT-5.4 with reasoning=high):
  - 3 Specialist Agents (Financial, Operations, Risk) — run in parallel
  - 1 Reviewer — checks all 3 for errors
  - 1 Writer/Synthesizer — assembles final report
    ↓
Executive Report (markdown + Excel download)
```

Key design principles:
- **Only 2 LLM touchpoints**: tool selection + synthesis. Everything in between is deterministic.
- **Anti-hallucination**: KPIs computed by code execution, not LLM. LLM only writes narrative around pre-computed facts.
- **Eval-driven**: golden datasets + automated assertions after every change.

---

## What We've Built So Far (Deterministic Layer)

### Metric Contract (`metric_registry.py`)
- Extracts scalar metrics from KPI artifacts
- Infers semantic metadata: `{metric_id, display_name, unit, aggregation, definition, preferred_direction}`
- Canonicalizes when same metric_id appears in multiple sources (picks highest-priority source, flags conflicts)
- Quarantines non-business metrics (date column sums, ID column sums, NaN/Inf)
- Extracts dimensional breakdowns with proper dimension inference

### Benchmark Policy (`benchmark_policy.py`)
- For each breakdown with 2+ rows, computes per-row benchmark (median of peers, excluding self)
- Pre-computes: `delta_abs`, `delta_pct`, `preferred_direction`
- Deterministic — no LLM involved

### Priority Scoring (`synthesis_briefing.py`)
- Scores every metric by: `abs(delta_pct) × revenue_weight × is_bad_boost`
- Bad metrics (wrong direction vs. preferred) get 1.5× boost
- Result: Furniture margin (2.49%, delta -14.7pp) automatically ranks #1

### Role-Based Routing (`synthesis_briefing.py`)
- Financial Agent sees only: revenue, profit, margin, discount, cost metrics
- Operations Agent sees only: lead time, fulfillment, forecast, shipping metrics
- Risk Agent sees: all high-priority outliers + anomaly flags
- Reduces each agent's input from ~3500 tokens (everything) to ~800-2000 tokens (role-relevant only)

### Causal Context (`synthesis_briefing.py`)
- For top 5 outlier breakdown rows, finds all other metrics for the same dimension value
- E.g., if Furniture margin is #1 outlier → provides Furniture's revenue, discount, quantity as explanation candidates
- Agent has data to reason about causes, doesn't need to guess

### Key Metrics Table (system-generated)
- The Key Metrics table in the final report is generated deterministically from metric contract
- Not written by LLM — guarantees correct numbers in the summary table

### Validation (`pre_synthesis_validator.py`)
- Flags empty artifacts, missing lead times, high anomaly ratios
- Warns about ambiguous forecast units/granularity
- Detects shared-denominator ambiguity (e.g., margin and discount both divide by "revenue" — but is it gross or net?)

---

## Version History & Scores

External evaluator (another AI) scored each version on: overall quality, consistency, trustworthiness.

| Version | Score | Architecture Change | What Improved | What Broke |
|---------|-------|-------------------|---------------|------------|
| v1 | 6.0 | Basic pipeline | First working end-to-end | No category margin, dates wrong |
| v2 | 7.0 | + LLM KPI code gen | Category margin found | LLM invented "return_rate" from negative profit |
| v3 | 7.8 | + Lead time calc | Lead time computed correctly | Return rate hallucination persisted |
| v4 | 8.0 | + Multi-agent reviewer | Reviewer catches contradictions | Lead time regressed to 0.00 (Excel serial dates) |
| **v5** | **8.4** | **+ Metric contract + benchmark** | **Furniture 2.49% margin found for first time, best version** | Discount not broken by category |
| v6 | 8.2 | + Forecast contract + validation | Metric conflict awareness, revenue base ambiguity detected | KPI conflicts still unresolved in narrative |
| v7 | **6.2** | + `[[reference]]` placeholder system | Reviewer very strong | **`[UNRESOLVED: ...]` in final output — delivery failure** |
| v8 | **6.6** | + Structured JSON claims with enum | Enum constraint on metric_ref held | **Numbers fabricated in free-text fields** |

**Key observation: v5 (simplest architecture with metric contract) remains the best. Every attempt to add complexity regressed quality.**

---

## The Current Bottleneck

### Problem Statement

The synthesis agents (GPT-5.4) consistently fabricate numbers that don't exist in the data they're given. Specifically:

1. **Agents invent benchmark values.** When a metric has no pre-computed benchmark, the agent makes one up. Example: `total_profit:Tables` has no benchmark in the data, but Financial Agent writes "Tables profit is $33,319.50 below its benchmark" — that benchmark number is fabricated.

2. **Agents cite metrics at granularities that don't exist.** The data has `margin_pct` by Category (3 values: Furniture, Technology, Office Supplies), but agents reference `total_profit:Tables` (sub-category level) as if it has a benchmark — it doesn't.

3. **The reviewer catches these errors every time** but can only flag them after the fact. The final writer may or may not apply corrections.

### What We've Tried

**Attempt 1: `[[reference]]` placeholders (v7, scored 6.2)**
- Agents write `[[margin_pct:Furniture]]` instead of actual numbers
- System resolves placeholders to real values after generation
- **Failed because:** LLM sees the `[[pattern]]` and generalizes — it creates `[[total_profit:Copiers]]`, `[[total_revenue:California]]` which don't exist. Unresolvable placeholders appear as `[UNRESOLVED: ...]` in the final output.
- **Root cause:** LLMs generalize patterns. `[[x]]` in prose is an open vocabulary — unlike Excel's `=A1` which is a closed vocabulary trained billions of times.

**Attempt 2: Structured JSON claims with enum constraint (v8, scored 6.6)**
- Specialists output JSON instead of prose: `{"metric_ref": "margin_pct:Furniture", "assessment": "critically_low", ...}`
- `metric_ref` field is constrained to an enum of valid metric IDs using OpenAI strict JSON schema
- A separate Writer LLM converts validated claims to prose
- **Partially worked:** The enum constraint held — no invalid metric_ref values. But agents fabricated numbers in the `insight` free-text field: "Tables profit -$17,725.48, which is $33,319.50 below its benchmark" — the benchmark number is made up.
- **Root cause:** Constraining the INDEX (metric_ref enum) is not enough. Any free-text field is a channel where LLM will embed fabricated numbers.

**What worked best: v5 (scored 8.4)**
- Simple approach: all metrics as real numbers in markdown, fed directly to agents
- No placeholders, no JSON claims, no enum constraints
- Agent sees `Furniture margin: 2.49%, benchmark: 17.21%, delta: -14.72pp` and naturally copies the correct numbers
- **Why it worked:** LLM is good at copying numbers it can see. It's bad at (a) finding numbers in 3500 tokens of noise, (b) generating numbers from patterns, (c) knowing what it doesn't know.

### The Scaling Problem

V5 works for Superstore (3 categories, ~20 metrics total). But for real enterprise data:

- 50 SKUs × 4 metrics = 200 breakdown rows
- 10 factories × 6 metrics = 60 more
- All converted to markdown = 8000+ tokens

At that scale, v5 hits the same "agent sees too much, misses important things" problem that started this whole journey.

### The Fundamental Tension

```
Small data (20 metrics):
  Show everything → agent copies correctly → works great (v5)

Large data (200+ metrics):
  Show everything → agent drowns in noise → misses key findings
  Filter to top 20 → agent copies correctly → works, but need good filtering
  Use structured output → agent fabricates in free-text → broken
```

The priority ranking + role routing we built (in `synthesis_briefing.py`) is the right filtering mechanism — it correctly puts Furniture margin as #1 priority. The question is how to combine it with reliable number handling.

---

## Specific Technical Question

**Given this architecture, what's the most reliable way to ensure LLM agents ONLY cite numbers that exist in the pre-computed metric contract, especially at scale (200+ metrics)?**

Constraints:
- We use GPT-5.4 via OpenAI Responses API (supports strict JSON schema with enums)
- We also use DeepSeek for tool selection (no strict schema support)
- Synthesis requires 5 LLM calls (3 specialists + 1 reviewer + 1 writer)
- Target latency: <120 seconds total pipeline
- Must work for any dataset (sales, procurement, manufacturing, inventory — schema-agnostic)

Options we're considering:
1. **V5 + role routing + priority ranking** — show real numbers but filtered to top 20 per role. Simple, proven at small scale. Unknown at large scale.
2. **Pure enum claims with zero free-text** — remove `insight` field entirely, only allow `{metric_ref, assessment, confidence, cause_ref}`. Writer LLM fills in all numbers from lookup table. Untested.
3. **Template-based generation** — system generates the entire report structure with numbers pre-filled, LLM only writes connecting sentences between pre-filled facts. Most constrained, least creative.
4. **Something else?**

---

## Codebase Reference

Key files:
- `src/ml/api/agent_synthesizer.py` — main synthesis orchestrator
- `src/ml/api/synthesis_briefing.py` — priority ranking, role routing, causal context
- `src/ml/api/structured_claims.py` — JSON enum claims (v8)
- `src/ml/api/metric_registry.py` — metric contract builder
- `src/ml/api/benchmark_policy.py` — deterministic benchmark computation
- `src/ml/api/pre_synthesis_validator.py` — pre-synthesis validation
- `src/ml/api/kpi_code_executor.py` — LLM code generation + sandbox execution
- `src/ml/api/mbr_agent.py` — tool execution dispatcher
- `src/ml/api/agent_entry.py` — general agent orchestrator
- `docs/EXPERIMENT_LOG.md` — 29 experiments documenting every decision
