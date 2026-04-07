"""
agent_tool_selector.py — LLM Call #1: Select tools for a user query.

Given 63 one-line tool descriptions + user query + data profile,
asks DeepSeek to pick 3-8 tool IDs. Single LLM call, ~2000 tokens.
"""

import json
import logging
import os

logger = logging.getLogger(__name__)


# ── Tool Index (63 tools, one line each, ~1500 tokens total) ──────────────

TOOL_INDEX = """
run_forecast: Run time-series demand forecast (P10/P50/P90 quantiles). Requires: demand history. Produces: forecast_series, metrics.
run_plan: Generate optimized replenishment/procurement plan via MIP solver. Requires: forecast. Produces: plan_table, inventory_projection.
run_risk_analysis: Compute supplier risk scores from PO and receipt data. Requires: po_open_lines. Produces: risk_scores.
run_risk_adjustments: Transform risk scores into solver parameter adjustments (lead time, safety stock). Requires: run_risk_analysis. Produces: risk_adjustments.
run_risk_aware_plan: Replenishment plan with risk mode — extends lead times for high-risk items. Requires: forecast + risk_analysis. Produces: risk_plan_table.
run_scenario: Execute a what-if scenario with parameter overrides (budget, service level, demand). Requires: run_plan. Produces: scenario_comparison.
run_batch_scenarios: Run up to 6 what-if scenarios in parallel and compare side by side. Requires: run_plan. Produces: scenario_comparison.
run_negotiation: Full negotiation loop with CFR game theory: generate options, evaluate, rank, recommend. Requires: run_plan. Produces: negotiation_report.
run_bom_explosion: Explode Bill of Materials to compute component-level demand from finished goods. Requires: BOM data + forecast. Produces: bom_explosion, bottlenecks.
run_cost_forecast: Project procurement costs from plan quantities and cost rules. Requires: run_plan. Produces: cost_forecast.
run_revenue_forecast: Forecast revenue and margin-at-risk from BOM plan. Requires: run_bom_explosion. Produces: revenue_forecast.
run_cost_analysis: Analyze operational cost breakdown and detect cost anomalies. Produces: cost_analysis.
run_closed_loop: Re-forecast and re-plan after actual consumption data arrives. Requires: forecast + plan. Produces: updated forecast/plan.
run_risk_score: Compute quantitative risk scores per material/supplier. Requires: forecast. Produces: risk_scores.
run_supply_forecast: Predict supplier delivery quantities, lead time distributions, capacity. Requires: po_open_lines. Produces: supply_forecast.
run_plan_comparison: Compare current plan vs approved baseline — detect KPI drift, quantity changes. Produces: plan_baseline_comparison.
run_ml_forecast: Advanced ML forecast (Prophet/LightGBM/Chronos) via Python API. Requires: demand history. Produces: forecast_series, metrics.
run_lp_solver: LP/MIP solver for replenishment optimization via Python API. Requires: forecast. Produces: plan_table, solver_meta.
run_simulation: Monte Carlo simulation of supply chain with stochastic demand/lead times. Requires: run_plan. Produces: simulation_results.
run_stockout_causal_graph: Build 5-Whys causal graph tracing stockout root causes. Requires: run_plan. Produces: causal_graph.
run_infeasibility_causal_graph: Explain why solver returned infeasible — constraint conflicts, capacity limits. Requires: run_plan. Produces: causal_graph.
get_supplier_kpi_summary: Supplier performance metrics: on-time delivery, defect rate, price volatility. Produces: supplier_kpi_summary.
get_supplier_rankings: Rank suppliers by composite score (delivery, quality, cost). Produces: supplier_kpi_summary.
analyze_risk_for_replan: Evaluate whether risk scores warrant a re-plan. Requires: risk_analysis. Produces: risk_replan_recommendation.
run_war_room: Multi-agent war room: planner, risk analyst, negotiator analyze a plan collaboratively. Requires: run_plan. Produces: war_room_session.
request_plan_approval: Submit replenishment plan for governance approval with audit trail. Requires: run_plan. Produces: approval_request.
run_plan_commit: Commit approved plan to system of record with governance audit. Requires: run_plan. Produces: plan_commit_receipt.
query_live_data: Query real-time ERP data (suppliers, materials, inventory, POs) with filtering/sorting. Produces: query results.
list_available_tables: List all queryable ERP/DI tables with columns and filter options. Produces: table schema list.
query_sap_data: Execute SQL queries on enterprise data via DuckDB (customers, orders, products, etc.). Produces: query results.
list_sap_tables: Show all SAP master data tables with columns, row counts. Produces: table schema.
forecast_from_sap: Run demand forecast from any SAP table data via SQL. Produces: forecast_series, metrics.
generate_proactive_alerts: Generate supply chain alerts: stockout risk, expedite, dual-source suggestions. Requires: risk_analysis. Produces: proactive_alerts.
generate_daily_summary: Daily summary of digital worker activity: tasks, costs, KPIs. Produces: daily_summary.
fetch_external_signals: Fetch macro signals (GDELT geopolitical, supply chain news, currency). Produces: macro_oracle_signals.
analyze_step_failure: Diagnose why an agent step failed and suggest healing strategy. Produces: diagnosis.
run_digital_twin_simulation: Digital twin simulation with configurable scenario and chaos intensity. Produces: simulation_results.
run_digital_twin_optimization: Optimize supply chain parameters (reorder points, safety stock) via digital twin. Produces: optimization_results.
run_digital_twin_comparison: Compare multiple strategies side-by-side via digital twin. Produces: simulation_comparison.
run_digital_twin_reoptimization: Analyze simulation results and derive constraint tightening. Requires: digital_twin_simulation. Produces: reoptimization_results.
run_inventory_projection: Project future inventory levels by material/plant, identify stockout risks. Requires: forecast. Produces: inventory_projection.
generate_report: Generate HTML/XLSX report from accumulated artifacts. Produces: report_html.
run_sku_analysis: Per-SKU deep analysis: trend, seasonality, anomalies, forecast accuracy. Requires: demand data. Produces: sku_analysis.
run_backtest: Backtest forecast models against historical data (MAE, MAPE, RMSE). Requires: demand data. Produces: backtest_results.
run_model_training: Train/retrain a forecast model (Prophet/LightGBM) on new data. Requires: demand data. Produces: model_artifact.
run_feature_importance: Compute feature importance for forecast model explainability. Requires: run_ml_forecast. Produces: feature_importance.
run_drift_check: Detect distribution drift between training and recent actuals. Requires: demand data. Produces: drift_report.
run_stress_test: Stress test supply chain with extreme scenarios (demand spikes, supplier failures). Requires: ml_forecast. Produces: stress_test_results.
generate_chart: Generate chart from predefined recipe catalog (50 chart types). Produces: chart visualization.
run_python_analysis: Advanced statistical analysis in Python sandbox (pandas, scipy, sklearn). Produces: analysis_result.
generate_analysis_workbook: Generate professional multi-sheet Excel workbook from analysis results. Requires: run_python_analysis. Produces: analysis_workbook.
excel_mbr_workbook: Generate formatted MBR Excel workbook (Cover, KPIs, Data, Dashboard). Produces: excel_workbook.
run_data_cleaning: Clean dataset: handle missing values, deduplicate, outlier treatment, normalize. Produces: cleaned_dataset.
run_eda: Automated EDA: statistics, distributions, correlations, missing values, quality score. Produces: eda_report.
run_auto_insights: Auto-scan dataset for patterns: trends, anomalies, concentration, temporal patterns. Produces: auto_insights.
run_anomaly_detection: Detect outliers via z-score, IQR, or isolation forest methods. Produces: anomaly_report.
run_dataset_join: Join two datasets on matching keys (inner/left/right/outer). Produces: joined_dataset.
run_ab_test: A/B test analysis: t-test, chi-square, effect size, confidence intervals. Produces: ab_test_report.
run_regression: Fit regression models (OLS, logistic, ridge) with diagnostics. Produces: regression_report.
run_mbr_cleaning: Clean uploaded Excel for MBR: standardize schema, remove bad rows, entity dedup (LLM + deterministic). Produces: cleaned sheets.
run_mbr_kpi: Calculate revenue, COGS, gross margin, margin% from cleaned sales data. Requires: run_mbr_cleaning. Produces: KPI tables.
run_mbr_variance: Compare actuals vs targets, waterfall decomposition, gap analysis. Requires: run_mbr_kpi. Produces: variance tables.
run_mbr_anomaly: Auto-scan all cleaned sheets for statistical anomalies (z-score, IQR, trend breaks). Requires: run_mbr_cleaning. Produces: anomaly tables.
""".strip()

# Tool dependency map — only tool-to-tool dependencies (not cleaning)
# Cleaning is handled automatically by resolve_dependencies()
TOOL_DEPS = {
    "run_plan": ["run_forecast"],
    "run_risk_adjustments": ["run_risk_analysis"],
    "run_risk_aware_plan": ["run_forecast", "run_risk_analysis"],
    "run_scenario": ["run_plan"],
    "run_batch_scenarios": ["run_plan"],
    "run_negotiation": ["run_plan"],
    "run_bom_explosion": ["run_forecast"],
    "run_cost_forecast": ["run_plan"],
    "run_revenue_forecast": ["run_bom_explosion"],
    "run_closed_loop": ["run_forecast", "run_plan"],
    "run_lp_solver": ["run_forecast"],
    "run_simulation": ["run_plan"],
    "run_stockout_causal_graph": ["run_plan"],
    "run_infeasibility_causal_graph": ["run_plan"],
    "analyze_risk_for_replan": ["run_risk_analysis"],
    "run_war_room": ["run_plan"],
    "request_plan_approval": ["run_plan"],
    "run_plan_commit": ["run_plan"],
    "generate_proactive_alerts": ["run_risk_analysis"],
    "run_digital_twin_reoptimization": ["run_digital_twin_simulation"],
    "run_inventory_projection": ["run_forecast"],
    "run_feature_importance": ["run_ml_forecast"],
    "run_stress_test": ["run_ml_forecast"],
    "generate_analysis_workbook": ["run_python_analysis"],
    "run_mbr_kpi": ["run_mbr_cleaning"],
    "run_mbr_variance": ["run_mbr_kpi"],
    "run_mbr_anomaly": ["run_mbr_cleaning"],
}

# All valid tool IDs
VALID_TOOL_IDS = set()
for line in TOOL_INDEX.split("\n"):
    if ":" in line:
        tid = line.split(":")[0].strip()
        if tid:
            VALID_TOOL_IDS.add(tid)


# ── Dependency Resolver (topological sort) ────────────────────────────────

def resolve_dependencies(tool_ids: list[str]) -> list[str]:
    """
    Given a set of tool IDs, add missing dependencies and return
    in topological order (dependencies first).

    RULE: run_mbr_cleaning always runs first if ANY other tool is selected.
    This is an architectural invariant — all tools need cleaned data.
    """
    needed = set(tool_ids)

    # Auto-insert cleaning if any non-cleaning tool exists
    CLEANING = "run_mbr_cleaning"
    if any(t != CLEANING for t in needed):
        needed.add(CLEANING)

    # Add transitive dependencies
    changed = True
    while changed:
        changed = False
        for tid in list(needed):
            for dep in TOOL_DEPS.get(tid, []):
                if dep not in needed:
                    needed.add(dep)
                    changed = True

    # Topological sort via DFS
    visited = set()
    order = []

    def visit(tid):
        if tid in visited:
            return
        visited.add(tid)
        # Cleaning has no deps — visits first naturally via sorted()
        for dep in TOOL_DEPS.get(tid, []):
            if dep in needed:
                visit(dep)
        order.append(tid)

    for tid in sorted(needed):  # sorted for determinism (run_mbr_cleaning sorts first)
        visit(tid)

    # Ensure cleaning is always first (safety net)
    if CLEANING in order and order[0] != CLEANING:
        order.remove(CLEANING)
        order.insert(0, CLEANING)

    return order


# ── Data Profile Summary ─────────────────────────────────────────────────

def _build_profile_summary(profile: dict) -> str:
    """Build a compact text summary of the data profile for the LLM."""
    sheets = profile.get("sheets", {})
    if not sheets:
        return "No data uploaded."

    lines = []
    for sn, sp in sheets.items():
        cols = sp.get("columns", {})
        row_count = sp.get("row_count", 0)
        col_names = list(cols.keys())[:15]
        roles = set()
        for ci in cols.values():
            role = ci.get("role", "unknown")
            if role not in ("unknown", "text"):
                roles.add(role)
        role_str = f" (roles: {', '.join(sorted(roles))})" if roles else ""
        lines.append(f"- {sn}: {row_count} rows, columns=[{', '.join(col_names)}]{role_str}")

    return "\n".join(lines)


# ── LLM Selector Prompt ──────────────────────────────────────────────────

SELECTOR_SYSTEM = "You are a supply chain analysis strategist. Think step by step, then return JSON."

SELECTOR_PROMPT = """You are planning an analysis strategy. Think step by step about what this data needs.

## Available Tools (63)
{tool_index}

## User's Data
{profile_summary}

## User's Question
{query}

## Think through these questions before selecting tools:
1. What TYPE of data is this? (sales transactions, procurement POs, production records, inventory snapshot, budget report?)
2. What COLUMNS suggest financial analysis? (revenue, cost, profit, margin)
3. Is there TIME-SERIES data? (dates + quantities → forecast is valuable)
4. Is there INVENTORY data? (on_hand, safety_stock → risk scoring is valuable)
5. Is there BOM/MATERIAL structure? (parent/child → BOM explosion is valuable)
6. Is there a BUDGET or TARGET to compare against? (→ variance analysis is valuable)
7. What is the user actually asking for? What would be MOST USEFUL to them?

## Rules
1. Select ONLY tools whose required data exists (check sheet names and column roles)
2. Do NOT select tools that need data you don't have
3. Dependencies are resolved automatically — just pick what you need
4. For MBR analysis with Excel data: prefer run_mbr_* tools (they handle cleaning, KPI, variance, anomaly)
5. Do NOT mix overlapping tools: run_mbr_anomaly and run_anomaly_detection do the same thing — pick ONE
6. Do NOT select run_eda or run_auto_insights when run_mbr_* tools are selected (MBR tools already cover analysis)
7. If data has time-series (date + qty/demand with 10+ rows): include run_forecast
8. If data has inventory (on_hand, safety_stock): include run_risk_score and/or run_plan
9. If data has BOM (parent/child material): include run_bom_explosion
10. Minimum 1 tool, maximum 8 tools

Return JSON:
{{
  "thinking": "Your step-by-step analysis of the data (answer questions 1-7 above)",
  "tools": ["tool_id_1", "tool_id_2", ...],
  "reasoning": "brief summary of why these tools were chosen"
}}"""


# ── Main Selector Function ───────────────────────────────────────────────

async def _call_llm_via_proxy(prompt: str, system_prompt: str, llm_config: dict,
                              override_provider: str = None, override_model: str = None,
                              reasoning_effort: str = None,
                              json_schema: dict = None) -> str:
    """
    Call LLM through Supabase ai-proxy (preferred) or direct API.

    Args:
        override_provider: Force a specific provider (e.g., "openai" for reasoning tasks)
        override_model: Force a specific model (e.g., "gpt-5.4" for synthesis)
        reasoning_effort: For reasoning models (gpt-5.4, o3): "low", "medium", "high"
        json_schema: If provided, forces structured JSON output (OpenAI strict mode).
                     Schema dict with "name" and "schema" keys.
    """
    from ml.api.tool_executor import _call_llm, _has_supabase_proxy, LLMConfig

    # Build LLMConfig — override takes priority over llm_config
    provider = override_provider or llm_config.get("provider", "deepseek")
    model = override_model or llm_config.get("model", None)

    # reasoning_effort only applies to OpenAI reasoning models — clear for other providers
    effective_reasoning = reasoning_effort if provider == "openai" else None

    logger.info(f"[LLM] Calling {provider}/{model} (reasoning={effective_reasoning}, json_schema={'yes' if json_schema else 'no'})")

    config = LLMConfig(
        provider=provider,
        reasoning_effort=effective_reasoning,
        model=model,
        temperature=0.1,
        max_tokens=8192,
    )
    return await _call_llm(prompt, system_prompt, config, json_schema=json_schema)


async def select_tools(query: str, profile: dict, llm_config: dict) -> tuple[list[str], str]:
    """
    LLM Call #1: Ask DeepSeek to pick tools based on query + data profile.

    Returns:
        (tool_ids, reasoning) — resolved and ordered tool list + LLM reasoning
    """
    profile_summary = _build_profile_summary(profile)

    prompt = SELECTOR_PROMPT.format(
        tool_index=TOOL_INDEX,
        profile_summary=profile_summary,
        query=query,
    )

    logger.info(f"[ToolSelector] Calling LLM with {len(prompt)} char prompt")

    try:
        response = await _call_llm_via_proxy(prompt, SELECTOR_SYSTEM, llm_config)
        response = response.strip()

        # Parse JSON from response (handle markdown fences)
        if "```" in response:
            start = response.find("{")
            end = response.rfind("}") + 1
            response = response[start:end]
        elif response.startswith("{"):
            pass
        else:
            start = response.find("{")
            end = response.rfind("}") + 1
            if start >= 0 and end > start:
                response = response[start:end]

        parsed = json.loads(response)
        raw_ids = parsed.get("tools", [])
        reasoning = parsed.get("reasoning", "")
        thinking = parsed.get("thinking", "")

        # Validate: only keep known tool IDs
        valid_ids = [tid for tid in raw_ids if tid in VALID_TOOL_IDS]
        if not valid_ids:
            logger.warning(f"[ToolSelector] LLM returned no valid tools: {raw_ids}")
            return _fallback_selection(profile), "LLM returned no valid tools, using fallback", ""

        # Resolve dependencies and sort
        ordered = resolve_dependencies(valid_ids)

        # Cap at 10 tools (including dependencies)
        if len(ordered) > 10:
            ordered = ordered[:10]

        logger.info(f"[ToolSelector] Selected {len(valid_ids)} tools → {len(ordered)} after deps: {ordered}")
        if thinking:
            logger.info(f"[ToolSelector] Thinking: {thinking[:200]}")
        return ordered, reasoning, thinking

    except Exception as e:
        logger.error(f"[ToolSelector] LLM call failed: {e}")
        return _fallback_selection(profile), f"LLM failed ({e}), using fallback", ""


def _fallback_selection(profile: dict) -> list[str]:
    """Deterministic fallback when LLM fails — uses plan_from_profile logic."""
    try:
        from ml.api.mbr_agent import plan_from_profile
        plan, _ = plan_from_profile(profile)
        # Map generic tool names to catalog IDs
        tool_map = {
            "data_cleaning": "run_mbr_cleaning",
            "kpi_calculation": "run_mbr_kpi",
            "variance_analysis": "run_mbr_variance",
            "anomaly_detection": "run_mbr_anomaly",
        }
        return [tool_map.get(t, t) for t in plan if tool_map.get(t, t) in VALID_TOOL_IDS]
    except Exception:
        return ["run_eda"]
