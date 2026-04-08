"""
agent_entry.py — General Agent orchestrator.

Ties together: router → selector → loop → synthesizer.
Only 2 LLM calls in the entire flow.
"""

import time
import logging

logger = logging.getLogger(__name__)


async def run_general_agent(
    query: str,
    sheets_data: dict,
    llm_config: dict,
    on_step=None,
) -> dict:
    """
    Full general agent flow:
      1. Route: /mbr → fixed pipeline, free text → general agent
      2. Profile data (deterministic)
      3. LLM Call #1: Select tools (~2000 tokens)
      4. Execute tools in order (deterministic, 0 LLM calls)
      5. LLM Call #2: Synthesize narrative (~3000 tokens)

    Args:
        query: User's natural language question
        sheets_data: Dict of {sheet_name: [row_dicts]} from uploaded Excel
        llm_config: DeepSeek API configuration
        on_step: Async callback for SSE progress events

    Returns:
        {
            "narrative": str,
            "all_artifacts": list,
            "tools_used": list[str],
            "steps_log": list,
            "route": str,
            "reasoning": str,
            "total_duration_ms": int,
        }
    """
    total_start = time.time()

    # ── Step 0: Route ──
    from ml.api.agent_router import route_query

    route = route_query(query)
    logger.info(f"[GeneralAgent] Route: {route} for query: {query[:80]}")

    if route == "mbr_pipeline":
        from ml.api.mbr_agent import run_mbr_agent
        return await run_mbr_agent(sheets_data, llm_config, on_step)

    # Other fixed pipelines can be added here as they're built
    # if route == "forecast_pipeline": ...

    # ── Step 1: Profile data (deterministic) ──
    from ml.api.kpi_calculator import profile_for_kpi

    profile = profile_for_kpi(sheets_data)
    sheet_count = len(profile.get("sheets", {}))
    total_rows = sum(sp.get("row_count", 0) for sp in profile.get("sheets", {}).values())
    logger.info(f"[GeneralAgent] Profiled {sheet_count} sheets, {total_rows} rows")

    # ── Step 1b: Validate data format (deterministic) ──
    from ml.api.agent_format_validator import validate_data_format, explain_rejection

    can_process, format_issues = validate_data_format(profile)
    if not can_process:
        blocking = [i for i in format_issues if i.get("severity") == "blocking"]
        logger.warning(f"[GeneralAgent] Data format rejected: {[i['issue'] for i in blocking]}")

        if on_step:
            await on_step({
                "type": "format_rejected",
                "issues": format_issues,
            })

        # LLM explains why (replaces tool selection + synthesis — still max 1 LLM call)
        explanation = await explain_rejection(profile, format_issues, llm_config)

        if on_step:
            await on_step({"type": "synthesize_start"})
            await on_step({"type": "synthesize_chunk", "text": explanation})
            await on_step({"type": "synthesize_done", "word_count": len(explanation.split())})

        return {
            "narrative": explanation,
            "all_artifacts": [],
            "tools_used": [],
            "steps_log": [{"tool": "format_validation", "status": "rejected",
                           "summary": "; ".join(i["detail"] for i in blocking)}],
            "route": route,
            "reasoning": "Data format not supported — see narrative for details",
            "total_duration_ms": int((time.time() - total_start) * 1000),
        }

    # Log warnings (non-blocking) but continue
    warnings = [i for i in format_issues if i.get("severity") == "warning"]
    if warnings:
        logger.info(f"[GeneralAgent] Format warnings: {[i['issue'] for i in warnings]}")
        if on_step:
            await on_step({"type": "format_warning", "issues": warnings})

    # ── Step 2: LLM Call #1 — Tool Selection ──
    from ml.api.agent_tool_selector import select_tools

    if on_step:
        await on_step({"type": "plan_start", "detail": "Analyzing data and selecting tools..."})

    t1 = time.time()
    tool_ids, reasoning, thinking = await select_tools(query, profile, llm_config)
    selector_ms = int((time.time() - t1) * 1000)

    logger.info(f"[GeneralAgent] Selected {len(tool_ids)} tools in {selector_ms}ms: {tool_ids}")

    if on_step:
        # Emit thinking trace (like Grok's "Think" panel)
        if thinking:
            await on_step({
                "type": "agent_thinking",
                "phase": "tool_selection",
                "thinking": thinking,
                "model": f"{llm_config.get('provider', 'deepseek')}/{llm_config.get('model', 'deepseek-chat')}",
            })
        await on_step({
            "type": "plan_done",
            "tools": tool_ids,
            "reasoning": reasoning,
            "selector_ms": selector_ms,
        })

    if not tool_ids:
        return {
            "narrative": "No suitable analysis tools found for your query and data.",
            "all_artifacts": [],
            "tools_used": [],
            "steps_log": [],
            "route": route,
            "reasoning": reasoning,
            "total_duration_ms": int((time.time() - total_start) * 1000),
        }

    # ── Step 3: Deterministic Execution (0 LLM calls) ──
    from ml.api.agent_loop import run_agent_loop

    context = await run_agent_loop(tool_ids, sheets_data, llm_config, on_step)

    # ── Step 3b: Auto Drill-Down Loop (LLM judges, engine executes) ──
    from ml.api.drill_down_loop import run_drill_down_loop
    from ml.api.agent_tool_selector import _call_llm_via_proxy
    import pandas as pd

    # Get the largest cleaned sheet as DataFrame for drill-down
    largest_sheet = max(sheets_data.items(), key=lambda x: len(x[1]))[1]
    drill_df = pd.DataFrame(largest_sheet)

    async def drill_llm_call(prompt, system):
        return await _call_llm_via_proxy(prompt, system, llm_config)

    drill_artifacts = await run_drill_down_loop(
        drill_df, context["all_artifacts"], drill_llm_call, on_step,
    )
    if drill_artifacts:
        context["all_artifacts"].extend(drill_artifacts)
        context["steps_log"].append({
            "tool": "auto_drill_down",
            "duration_ms": 0,
            "status": "success",
            "summary": f"Auto drill-down: {len(drill_artifacts)} artifacts",
        })

    # ── Step 4: LLM Call — Synthesis ──
    from ml.api.agent_synthesizer import prepare_analysis_context, synthesize

    analysis_context = prepare_analysis_context(context["all_artifacts"])
    if analysis_context.get("enriched_artifacts"):
        context["all_artifacts"].extend(analysis_context["enriched_artifacts"])

    narrative = await synthesize(
        context["findings_chain"], llm_config, on_step,
        all_artifacts=context["all_artifacts"],
        analysis_context=analysis_context,
    )

    # Note: Excel generation is handled by the SSE endpoint (tool_executor.py)
    # which builds Excel from narrative + steps_log + artifacts.
    # No need for a separate LLM call here.

    total_ms = int((time.time() - total_start) * 1000)
    logger.info(f"[GeneralAgent] Done in {total_ms}ms. {len(tool_ids)} tools, {len(narrative)} chars narrative")

    return {
        "narrative": narrative,
        "all_artifacts": context["all_artifacts"],
        "tools_used": tool_ids,
        "steps_log": context["steps_log"],
        "route": route,
        "reasoning": reasoning,
        "total_duration_ms": total_ms,
    }
