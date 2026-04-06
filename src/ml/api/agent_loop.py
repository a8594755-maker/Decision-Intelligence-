"""
agent_loop.py — Deterministic tool execution loop. 0 LLM calls.

Executes tools in dependency order, chains context between them.
Reuses _execute_tool() and summarize_tool_output() from mbr_agent.py.
"""

import time
import logging

logger = logging.getLogger(__name__)


# Map catalog tool IDs → internal tool IDs used by _execute_tool()
CATALOG_TO_INTERNAL = {
    "run_mbr_cleaning": "data_cleaning",
    "run_mbr_kpi": "kpi_calculation",
    "run_mbr_variance": "variance_analysis",
    "run_mbr_anomaly": "anomaly_detection",
    "run_anomaly_detection": "anomaly_detection",
    "run_eda": "eda",
    "run_auto_insights": "eda",
    "run_regression": "regression",
    "run_forecast": "forecast",
    "run_ml_forecast": "forecast",
    "run_plan": "replenishment_plan",
    "run_lp_solver": "replenishment_plan",
    "run_risk_score": "risk_score",
    "run_risk_analysis": "risk_score",
    "run_bom_explosion": "bom_explosion",
    "run_inventory_projection": "risk_score",
    # These map 1:1 (internal name = catalog name)
    "data_cleaning": "data_cleaning",
    "kpi_calculation": "kpi_calculation",
    "variance_analysis": "variance_analysis",
    "anomaly_detection": "anomaly_detection",
    "inventory_health": "inventory_health",
    "supplier_analysis": "supplier_analysis",
    "expense_analysis": "expense_analysis",
    "margin_analysis": "margin_analysis",
}

# JS-only tools that have no Python executor — skip gracefully
JS_ONLY_TOOLS = {
    "run_data_cleaning",
    "run_ab_test", "run_dataset_join",
    "run_scenario", "run_batch_scenarios", "run_negotiation",
    "run_cost_forecast", "run_revenue_forecast", "run_cost_analysis",
    "run_closed_loop", "run_risk_score", "run_supply_forecast",
    "run_plan_comparison", "run_risk_adjustments", "run_risk_aware_plan",
    "generate_chart", "run_python_analysis", "generate_analysis_workbook",
    "generate_report", "excel_mbr_workbook",
    "query_live_data", "list_available_tables", "query_sap_data", "list_sap_tables",
    "forecast_from_sap", "run_ml_forecast", "run_lp_solver", "run_simulation",
    "run_stockout_causal_graph", "run_infeasibility_causal_graph",
    "get_supplier_kpi_summary", "get_supplier_rankings",
    "analyze_risk_for_replan", "run_war_room", "request_plan_approval",
    "run_plan_commit", "generate_proactive_alerts", "generate_daily_summary",
    "fetch_external_signals", "analyze_step_failure",
    "run_digital_twin_simulation", "run_digital_twin_optimization",
    "run_digital_twin_comparison", "run_digital_twin_reoptimization",
    "run_inventory_projection", "run_sku_analysis", "run_backtest",
    "run_model_training", "run_feature_importance", "run_drift_check",
    "run_stress_test",
}


async def _emit_column_mapping(clean_result, on_step):
    """Extract column mappings from cleaning artifacts and emit as SSE event."""
    if not on_step:
        return
    for art in clean_result.get("artifacts", []):
        label = (art.get("label") or "").lower()
        if "column mapping" in label or "schema" in label:
            mappings = art.get("data", [])
            if mappings:
                lines = []
                for row in mappings[:20]:
                    orig = row.get("original") or row.get("original_column") or row.get("from", "")
                    mapped = row.get("mapped") or row.get("canonical") or row.get("to") or row.get("role", "")
                    if orig:
                        lines.append(f"  {orig} → {mapped}")
                if lines:
                    await on_step({
                        "type": "column_mapping",
                        "mappings": lines,
                        "detail": "\n".join(lines),
                    })
                return

    # Fallback: build mapping from profile of cleaned sheets
    cleaned = clean_result.get("cleaned_sheets", {})
    if cleaned:
        from ml.api.kpi_calculator import _detect_role
        import pandas as pd
        lines = []
        for sn, rows in cleaned.items():
            if not rows:
                continue
            df = pd.DataFrame(rows)
            for col in df.columns:
                role = _detect_role(col, df[col])
                if role != "unknown":
                    lines.append(f"  {col} → {role}")
        if lines:
            await on_step({
                "type": "column_mapping",
                "mappings": lines,
                "detail": "\n".join(lines),
            })


async def run_agent_loop(
    tool_ids: list[str],
    sheets_data: dict,
    llm_config: dict,
    on_step=None,
) -> dict:
    """
    Execute tools sequentially in dependency order.
    Each tool receives cumulative context from prior tools.

    Args:
        tool_ids: Ordered list of tool IDs (already dependency-resolved)
        sheets_data: Dict of {sheet_name: [rows]} from uploaded data
        llm_config: LLM configuration for tools that need it (e.g., cleaning)
        on_step: Async callback for SSE events

    Returns:
        {
            "tool_outputs": {tool_id: result_dict},
            "findings_chain": [(tool_id, fact_text), ...],
            "all_artifacts": [artifact, ...],
            "steps_log": [{tool, duration_ms, status, summary}, ...],
        }
    """
    from ml.api.mbr_agent import _execute_tool, summarize_tool_output

    context = {
        "tool_outputs": {},
        "findings_chain": [],
        "all_artifacts": [],
        "steps_log": [],
    }

    current_sheets = sheets_data

    # Filter out JS-only tools (no Python executor available)
    executable_ids = []
    for tid in tool_ids:
        internal = CATALOG_TO_INTERNAL.get(tid)
        if internal:
            executable_ids.append((tid, internal))
        elif tid in JS_ONLY_TOOLS:
            logger.info(f"[AgentLoop] Skipping JS-only tool: {tid}")
        else:
            # Unknown tool — try as-is (might work if _execute_tool knows it)
            executable_ids.append((tid, tid))

    for i, (catalog_id, internal_id) in enumerate(executable_ids):
        logger.info(f"[AgentLoop] Step {i+1}/{len(executable_ids)}: {catalog_id} → {internal_id}")

        # Emit SSE: tool_start
        if on_step:
            await on_step({
                "type": "tool_start",
                "tool_id": catalog_id,
                "step_index": i,
                "total_steps": len(executable_ids),
            })

        t0 = time.time()
        try:
            # Execute tool with cumulative context (use internal ID)
            result = await _execute_tool(
                internal_id, current_sheets, context["tool_outputs"], llm_config
            )
            duration_ms = int((time.time() - t0) * 1000)

            # Store result (keyed by internal ID for context chaining)
            context["tool_outputs"][internal_id] = result

            # If cleaning produced new sheets, use them downstream
            if internal_id == "data_cleaning" and result.get("cleaned_sheets"):
                current_sheets = result["cleaned_sheets"]

            # Extract column mapping from cleaning artifacts (for audit trail)
            if internal_id == "data_cleaning":
                await _emit_column_mapping(result, on_step)

            # Emit KPI audit trail if available
            if internal_id == "kpi_calculation" and result.get("kpi_audit") and on_step:
                audit = result["kpi_audit"]
                await on_step({
                    "type": "kpi_audit",
                    "code": audit.get("code", ""),
                    "reasoning": audit.get("reasoning", ""),
                    "derivations": audit.get("derivations", []),
                    "method": audit.get("method", ""),
                })

            # Extract facts (deterministic summary, no LLM)
            facts = summarize_tool_output(internal_id, result)
            context["findings_chain"].append((catalog_id, facts))

            # Accumulate artifacts
            if result.get("artifacts"):
                context["all_artifacts"].extend(result["artifacts"])

            context["steps_log"].append({
                "tool": catalog_id,
                "duration_ms": duration_ms,
                "status": "success",
                "summary": facts[:200] if facts else "",
            })

            logger.info(f"[AgentLoop] {catalog_id} done ({duration_ms}ms)")

            # Emit SSE: tool_done with findings
            if on_step:
                if facts:
                    for line in facts.split("\n")[:2]:
                        if line.strip():
                            await on_step({
                                "type": "tool_finding",
                                "tool_id": catalog_id,
                                "finding": line[:200],
                            })
                await on_step({
                    "type": "tool_done",
                    "tool_id": catalog_id,
                    "duration_ms": duration_ms,
                    "status": "success",
                })

        except Exception as e:
            duration_ms = int((time.time() - t0) * 1000)
            error_msg = str(e)[:300]
            logger.error(f"[AgentLoop] {catalog_id} FAILED ({duration_ms}ms): {error_msg}")

            context["steps_log"].append({
                "tool": catalog_id,
                "duration_ms": duration_ms,
                "status": "error",
                "error": error_msg,
            })

            # Emit SSE: tool_error (recoverable — continue with remaining tools)
            if on_step:
                await on_step({
                    "type": "tool_error",
                    "tool_id": catalog_id,
                    "error": error_msg,
                    "recoverable": True,
                    "duration_ms": duration_ms,
                })

            # Continue execution — don't abort on single tool failure

    return context
