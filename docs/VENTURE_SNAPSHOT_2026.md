# Decision Intelligence — Venture Snapshot

**AI Venture Velocity Challenge 2026**

---

## 1. Problem & Opportunity

### The Problem I Saw Firsthand

During two supply chain internships at Speed Tech (Luxshare Precision) — an Apple connector manufacturer — I was the person reconciling invoices, tracing inventory discrepancies across SAP, and building SOPs for transaction workflows at both the Taiwan headquarters and Mexico plant.

Every month, I watched the same cycle:

1. Analysts export data from SAP into Excel — 2-4 hours
2. Manually reconcile invoice mismatches, clean column names, deduplicate — 4-8 hours
3. Calculate KPIs for the Monthly Business Review — 4-8 hours
4. Manager reviews, finds errors, requests revisions — another round
5. Decision is finally made — 2-3 days after the data was available

The work was not hard. **It was the same every month**, yet nobody could reproduce last month's calculations. When a VP asked "why did margin drop?", the analyst had to manually trace through five spreadsheets.

In my internship experience and early conversations with manufacturing and consulting professionals, the same bottleneck repeatedly surfaced: **2-3 analyst-days per month, per business unit, on 90% repetitive work with unauditable output.** In a separate conversation with professionals at a Big Four consulting firm, I learned they had invested in building similar internal tools to address this same workflow gap — reinforcing that the problem is significant enough for large organizations to develop proprietary solutions. In a conversation with professionals at Deloitte, I learned they had developed similar internal tools to address this exact workflow gap for their own teams — confirming that the problem is real enough for a Big Four firm to invest in solving it internally.

The root cause is not a lack of tools. Companies have SAP, Power BI, Excel. **No single system owns the complete decision cycle.** Each tool handles one piece. The analyst is the glue — and humans are bad glue.

### Why This Matters

- **$1.1 trillion** in global excess inventory (IHL Group, 2024)
- **10-30% premium** on rush orders when stockouts hit
- **$200K+/year** per supply chain analyst spending 25% of their time on data prep

### Why Now

Three capabilities converged in 2025-2026:
- **LLM schema reasoning** — understands unfamiliar data formats without manual configuration
- **Code generation + sandboxing** — deterministic computation with LLM flexibility, fully auditable
- **Multi-model ML** — ensemble forecasting with calibrated uncertainty

None of these existed at production quality 24 months ago.

### Market Position

We believe the most promising beachhead is mid-market manufacturers ($10M-$500M revenue) that are too operationally complex for spreadsheet-driven planning, yet not well served by enterprise planning suites like SAP IBP ($500K+, 6-12 month implementation). This remains a core market assumption we are actively validating.

---

## 2. Starting Point Snapshot

**Stage:** Internal working prototype, pre-revenue, pre-pilot. All testing has been internal. No external users yet. In early conversations with a publicly listed EMS/ODM manufacturer about pilot testing.

### What Has Been Built

An AI agent that autonomously analyzes Excel/CSV data through a decision pipeline: clean → forecast → optimize → risk score → synthesize narrative → deliver report. Core modules:

- **Schema-agnostic data cleaning** — LLM reads column names + sample values to map any format
- **Auditable KPI code generation** — LLM writes pandas code, executes in sandboxed environment with 4-layer safety
- **5-model demand forecast** — Prophet, LightGBM, Chronos, XGBoost, ETS with calibrated P10/P50/P90
- **Replenishment optimization** — OR-Tools MIP solver with MOQ, capacity, budget constraints
- **Risk scoring** — stockout probability per SKU with causal root cause analysis
- **Closed-loop automation** — trigger engine monitors for drift/risk spikes and initiates re-planning

### Evidence

Across 10 datasets, 7 were fully hand-verified and matched expected outputs; the remaining 3 were validated for domain classification or format rejection:

| Dataset | Source | Key Result | Status |
|---------|--------|------------|--------|
| Golden MBR (6 sheets, 11 data traps) | Self-created | Revenue: 17.6M, Margin: 50.99% | ✅ Exact match |
| Microsoft Financial Sample | Public | Revenue: 118.7M, Margin: 14.23% | ✅ Exact |
| SC Analytics (35K rows, 3 sheets) | Public | Revenue: 6.2M, Margin: 64.62% | ✅ Exact |
| DataCo Supply Chain (53 columns) | Public | Revenue: 959K, Margin: 11.80% | ✅ Within 0.01pp |
| 3 additional sales datasets | Public | All matched hand calculations | ✅ |
| USAID Procurement (5K orders) | Public | Correctly identified as procurement | ✅ Domain |
| EMS/ODM data (Chinese columns) | Self-created | Correctly identified as procurement | ✅ Domain |
| Chinese Income Statement | Public | Correctly rejected (unsupported format) | ✅ Rejected |

Internally verified on benchmark and public datasets. Enterprise generalization is now being tested.

### What Is Not Yet Proven
- Whether schema mapping generalizes to real enterprise ERP exports (0 enterprise datasets tested)
- Whether analysts trust AI-calculated numbers enough to use in real reports
- Whether the full loop (forecast → plan → risk) delivers more value than point tools
- Whether mid-market manufacturers will pay for this

---

## 3. Highest-Risk Assumptions

### Assumption 1: Schema Mapping Generalizes to Enterprise Data
**Risk level:** HIGH

**What we assume:** The LLM can correctly identify revenue, cost, profit, and date columns across real enterprise Excel exports — with Chinese column names, mixed currencies, inconsistent formatting.

**Why this is high-risk:** If column mapping fails silently, every downstream calculation is wrong. The user gets a confidently presented but incorrect report — worse than no report.

**Evidence today:** 10/10 public datasets correct after iterative prompt engineering. 0 real enterprise datasets tested.

**Next experiment:** Collect 20+ real enterprise Excel files from manufacturing partners. Measure: % correctly mapped on first attempt (target: >90%), % caught by override system (target: 100%).

**Decision if fails:** If accuracy <80%, pivot to human-in-the-loop mapping where the system proposes and the user confirms before calculation.

### Assumption 2: Analysts Trust AI-Calculated Numbers
**Risk level:** HIGH

**What we assume:** The audit trail (column mapping + generated code + reasoning) creates enough trust for analysts to use AI numbers in real reports.

**Why this is high-risk:** If analysts recalculate everything manually, there's no time savings. Trust is the product.

**Evidence today:** Audit trail traces every number to source data and code. No external analyst has evaluated this.

**Next experiment:** Give 5-10 analysts the same dataset to analyze manually and with Decision Intelligence. Survey: "Would you put this number in a report to your VP?" A/B test: audit trail visible vs hidden.

**Decision if fails:** If trust score <3/5, add verification mode showing side-by-side comparison with user's own calculations.

### Assumption 3: The Full Loop > Point Tools
**Risk level:** MEDIUM

**What we assume:** The integrated loop (forecast → plan → risk) is significantly more valuable than cleaning + KPIs alone.

**Why this is high-risk:** If customers only want the first two steps, we're competing with ChatGPT. The full loop is our moat.

**Next experiment:** Measure time-to-decision with full loop vs traditional workflow. Target: 10x reduction.

**Decision if fails:** Narrow to "AI Data Analyst" and deprioritize solver/risk modules.

### Assumption 4: Mid-Market Manufacturers Will Pay
**Risk level:** MEDIUM

**What we assume:** Companies with $10M-$500M revenue will pay $2K-10K/month for an AI supply planning worker.

**Next experiment:** 15-20 customer discovery interviews. Test pricing. Measure willingness to pay + which feature triggers purchase.

**Decision if fails:** Explore per-report pricing or freemium model.

---

## 4. Experimentation Roadmap

### May: Enterprise Data Validation
- Collect 20+ enterprise Excel files across manufacturing industries
- Run column mapping accuracy study on enterprise formats
- First 5 real-user time-to-value measurements
- Continue Experiment Log (18 entries logged, targeting 25+ by July)

### June: User Trust Experiments
- A/B test: audit trail visible vs hidden → measure trust score
- Interview 10 supply chain analysts: trust, confusion points, feature gaps
- Test full pipeline with real enterprise data

### July: Virtual Semifinal + Market Validation
- Present experiment results and pivots from May-June
- Customer discovery interviews (n=15+)
- Pricing hypothesis testing

### August: Scale & Retention
- Enterprise-scale data (10K+ rows, multi-currency)
- Deploy scheduled analysis (weekly auto-run) for pilot users
- Measure retention

### September: Finals
- Cumulative Experiment Log (25+ experiments)
- Before/after metrics: analyst time saved, error rate reduced
- Live demo with real enterprise data

---

## 5. How AI Accelerates Learning

### In the Product

**Schema Reasoning (LLM):** Reads column names + sample values to understand any data structure. Documents every decision. Users can override.

**Code Generation (LLM + Sandbox):** Writes pandas code for KPI calculation. Runs in restricted sandbox. 4-layer safety. Every output is auditable and reproducible.

**Multi-Model Forecasting (ML):** 5 models race per forecast task. Best selected by backtest. Calibrated confidence intervals. Quality gates before downstream use.

**Mathematical Optimization (OR):** MIP solver for replenishment planning. Deterministic, provably optimal within constraints.

### For Our Own Learning Velocity

- LLM-generated test datasets with intentional data traps (header-as-data rows, mixed currencies, entity duplicates)
- Automated eval framework: 25 specs + 59 Python tests run after every code change — catches regressions instantly
- AI-assisted data profiling for rapid hypothesis testing on new datasets

---

## 6. Responsible AI Design

**Transparency:** Full audit trail at every step — column mapping, generated code, LLM reasoning. Users can override any mapping. Every number traces to source data.

**Safety:** LLM code runs in sandbox (no file access, no imports, no network). Format validator rejects unsupported data instead of producing garbage.

**Privacy:** Only column profiles sent to LLM — not raw business data. No data persisted after session.

**Governance:** Approval gates for high-risk decisions. Role-based access control. Model lifecycle gates (promotion requires performance thresholds).

---

## 7. Evidence of Progress

**18 documented experiments** following: Hypothesis → Test → Evidence → Decision → Impact.

| # | What We Tested | What We Learned | What We Changed |
|---|---------------|-----------------|-----------------|
| EXP-004 | Chinese financial statement | System produced garbage from transposed data | Built format validator — rejects unsupported formats with explanation |
| EXP-006 | Column mapping without sample values | LLM picked wrong columns 40% of the time | Added sample values to prompt — accuracy 100% on test set |
| EXP-007 | Hardcoded KPI formulas | Every new format needed manual coding | Replaced with LLM code generation + sandbox — handles any format |
| EXP-011 | Procurement data through sales pipeline | Meaningless "margin 1.29%" | Added domain detection — calculates appropriate KPIs per data type |
| EXP-017 | 53-column dataset, ambiguous revenue | LLM picked gross instead of net revenue | 2-step column detection. Error: 1.26pp → 0.01pp |
| EXP-018 | Full 7-tool pipeline end-to-end | All tools chained correctly, 41.7 seconds | Revenue and BOM match hand calculations exactly |

**Pattern:** Each experiment surfaces a failure → we fix with a generalizable solution → verified across all 10 datasets.

---

## 8. Why Me

I built this because I lived the problem.

At Speed Tech (Luxshare Precision), I was selected by headquarters to support the Mexico plant and bridge communication between Taiwan HQ and local teams across Procurement, Accounting, Warehouse, IQC, and IT. I built SOPs for SAP transactions, conducted root cause analysis on inventory issues, and proposed SAP-Oracle integration ideas to reduce manual work.

I realized the real problem wasn't the ERP system — it was the gap between ERP data and business decisions. No tool owned that gap.

I'm studying Business Information Technology with a concentration in Operations and Supply Chain Management at Virginia Tech (expected Dec 2026). This project is the intersection of what I've studied and what I've experienced on the factory floor.

**I'm not building a product I think the market needs. I'm building the tool I wish I'd had.**

---

*Decision Intelligence — An AI supply planning worker that owns the decision cycle from raw data to management-ready recommendation, with every step auditable and every number reproducible.*
