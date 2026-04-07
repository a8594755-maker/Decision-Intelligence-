"""
agent_synthesizer.py — Multi-Agent Synthesis with Parallel Lenses + Reviewer.

Architecture:
  1. Build rich facts (summaries + drill-down from artifacts)
  2. 3 specialist lenses analyze IN PARALLEL (fast — same latency as 1 call)
  3. Reviewer reads all 3 + original KPIs, finds contradictions and gaps
  4. Synthesizer merges everything into McKinsey Pyramid report

Agents:
  💰 Financial Analyst — revenue, margin, cost structure, category breakdown
  ⚙️ Operations Analyst — delivery, lead time, fulfillment, data quality
  ⚠️ Risk Analyst — top 3 risks with evidence, impact, action, confidence tags
  🔍 Reviewer — reads all 3, flags contradictions, corrects errors
  🎯 Lead Analyst — final synthesis using Pyramid structure
"""

import asyncio
import logging
import json
import os

from ml.api.metric_registry import (
    build_metric_contract,
    build_metric_contract_artifacts,
    metric_contract_to_markdown,
)
from ml.api.forecast_artifact_contract import (
    build_forecast_contract_artifacts,
    extract_forecast_contracts,
    forecast_contracts_to_markdown,
)
from ml.api.benchmark_policy import (
    build_benchmark_artifacts,
    build_benchmark_policy,
    benchmark_policy_to_markdown,
)
from ml.api.pre_synthesis_validator import (
    build_validation_artifacts,
    validate_agent_output_text,
    validate_analysis_inputs,
    validation_report_to_markdown,
)

logger = logging.getLogger(__name__)


# ── Detail Extraction ────────────────────────────────────────────────────

def prepare_analysis_context(all_artifacts: list | None) -> dict:
    """Build structured context once so every synthesis path shares the same facts."""
    from ml.api.kpi_guardrails import sanity_check_contract

    metric_contract = build_metric_contract(all_artifacts or [])

    # Layer 2: Sanity check — catch impossible canonical values before they propagate
    sanity_issues = sanity_check_contract(metric_contract)
    if sanity_issues:
        metric_contract.setdefault("warnings", []).extend(sanity_issues)

    forecast_contracts = extract_forecast_contracts(all_artifacts or [])
    benchmark_policy = build_benchmark_policy(metric_contract)
    validation_report = validate_analysis_inputs(all_artifacts or [], metric_contract, benchmark_policy)

    existing_labels = {(art.get("label") or "").lower() for art in (all_artifacts or [])}
    enriched_artifacts = []
    for art in (
        build_metric_contract_artifacts(metric_contract)
        + build_forecast_contract_artifacts(forecast_contracts)
        + build_benchmark_artifacts(benchmark_policy)
        + build_validation_artifacts(validation_report)
    ):
        if (art.get("label") or "").lower() not in existing_labels:
            enriched_artifacts.append(art)

    return {
        "metric_contract": metric_contract,
        "forecast_contracts": forecast_contracts,
        "benchmark_policy": benchmark_policy,
        "validation_report": validation_report,
        "enriched_artifacts": enriched_artifacts,
    }


def _build_rich_facts(findings_chain: list, all_artifacts: list = None) -> str:
    """Build rich facts with drill-down detail from artifacts."""
    sections = []
    for tool_id, facts in findings_chain:
        if facts and facts.strip():
            sections.append(f"### {tool_id}\n{facts}")
    if all_artifacts:
        detail_lines = []
        for art in all_artifacts:
            if art.get("type") != "table":
                continue
            label = (art.get("label") or "").lower()
            data = art.get("data", [])
            if not data or not isinstance(data, list) or not data[0] or not isinstance(data[0], dict):
                continue
            if any(skip in label for skip in (
                "column mapping", "detection config", "verify", "cleaning_log", "audit",
                "metric contract", "forecast contract", "benchmark policy", "data gaps & warnings",
            )):
                continue
            # Anomaly details
            if "anomal" in label:
                for row in data[:8]:
                    severity = row.get("severity", "")
                    col = row.get("column", row.get("metric", ""))
                    val = row.get("value", "")
                    if severity in ("critical", "warning"):
                        detail_lines.append(f"  [{severity}] {col}={val}")
                continue
            # Breakdowns
            if any(kw in label for kw in ("by ", "per ", "breakdown", "category", "region", "segment")):
                rows = data[:10]
                if rows:
                    detail_lines.append(f"\n**{art.get('label', 'Detail')}:**")
                    for row in rows:
                        parts = [f"{k}={v:,.2f}" if isinstance(v, float) else f"{k}={v:,}" if isinstance(v, int) else f"{k}={v}" for k, v in list(row.items())[:6] if v is not None]
                        detail_lines.append(f"  {' | '.join(parts)}")
            # Variance/waterfall
            elif "variance" in label or "waterfall" in label:
                for row in data[:5]:
                    parts = [f"{k}={v:,.2f}" if isinstance(v, float) else f"{k}={v}" for k, v in list(row.items())[:5] if v is not None]
                    detail_lines.append(f"  {' | '.join(parts)}")
            # Forecast
            elif "forecast" in label:
                for row in data[:3]:
                    parts = [f"{k}={v:,.1f}" if isinstance(v, float) else f"{k}={v}" for k, v in row.items() if v is not None]
                    detail_lines.append(f"  {' | '.join(parts)}")
        if detail_lines:
            sections.append("\n### Drill-Down Details\n" + "\n".join(detail_lines))
    return "\n\n".join(sections)


def _build_structured_facts(
    findings_chain: list,
    all_artifacts: list | None,
    analysis_context: dict,
    output_validation_notes: str = "",
) -> tuple[str, str]:
    contract_text = metric_contract_to_markdown(analysis_context.get("metric_contract", {}))
    forecast_text = forecast_contracts_to_markdown(analysis_context.get("forecast_contracts", []))
    benchmark_text = benchmark_policy_to_markdown(analysis_context.get("benchmark_policy", {}))
    validation_text = validation_report_to_markdown(analysis_context.get("validation_report", {}))
    drilldown_text = _build_rich_facts(findings_chain, all_artifacts)

    structured_sections = [
        contract_text,
        forecast_text,
        benchmark_text,
        validation_text,
        output_validation_notes,
        drilldown_text,
    ]
    structured_facts = "\n\n".join(section for section in structured_sections if section)

    scalar_table_lines = []
    scalar_metrics = analysis_context.get("metric_contract", {}).get("scalar_metrics", [])
    if scalar_metrics:
        scalar_table_lines.append("## Structured Facts")
        scalar_table_lines.append("| Metric ID | Display | Value | Aggregation |")
        scalar_table_lines.append("|-----------|---------|-------|-------------|")
        for metric in scalar_metrics[:20]:
            value = metric.get("value")
            if isinstance(value, float):
                value_str = f"{value:,.2f}"
            elif isinstance(value, int):
                value_str = f"{value:,}"
            else:
                value_str = str(value)
            scalar_table_lines.append(
                f"| {metric['metric_id']} | {metric['display_name']} | {value_str} | {metric['aggregation']} |"
            )

    structured_table = "\n".join(scalar_table_lines)
    return structured_facts, structured_table


def _agent_issues_to_markdown(agent_issues: dict[str, list[dict]]) -> str:
    if not agent_issues:
        return ""
    lines = ["## Specialist Output Warnings"]
    for phase, issues in agent_issues.items():
        for issue in issues:
            lines.append(f"- {phase}: [{issue.get('severity', 'warning')}] {issue.get('message', '')}")
    return "\n".join(lines)


# ── V5+V9 Hybrid Prompts ────────────────────────────────────────────────

_LENS_SYSTEM = """You are a specialist analyst. Be specific, cite numbers.

RULES:
- Use ONLY numbers from the data below. Copy them exactly. Do NOT calculate or invent new numbers.
- If "Explanation Candidates" section exists, use it for causal reasoning. Do NOT guess causation.
- Findings are sorted by importance. Discuss the top items first.
- If a Warning says a metric is unknown or empty, say so explicitly.
- Anomalies are signals to investigate, not confirmed problems."""

FINANCIAL_LENS = """You are a senior financial analyst.

{briefing}

Analyze the financial picture:
1. Revenue and profit health
2. Margin structure — which dimensions are dragging margin down?
3. Discount impact on profitability
4. Category/segment/region performance

Use ONLY numbers from the data above. 5-8 sentences."""

OPERATIONS_LENS = """You are a senior operations analyst.

{briefing}

Analyze operational performance:
1. Lead time / shipping performance
2. Fulfillment metrics (order volume, avg order value)
3. Forecast outlook (use the Forecast Contract details if provided)
4. Data quality flags

Use ONLY numbers from the data above. 5-8 sentences."""

RISK_LENS = """You are a supply chain risk analyst.

{briefing}

Identify TOP 3 risks:
1. **Risk**: What specifically? (name the dimension value and metric)
2. **Evidence**: Cite the EXACT number and benchmark delta from the data above
3. **Impact**: Money/time/customers at stake
4. **Action**: What to do THIS WEEK
5. **Confidence**: [DATA-PROVEN], [LIKELY INFERENCE], or [NEEDS VALIDATION]

Use ONLY numbers from the data above. Output as numbered list."""

REVIEWER_PROMPT = """You are a senior review analyst. Three specialists analyzed the same data.
Your job: find ERRORS, CONTRADICTIONS, and GAPS.

## Full Data (all metrics + benchmarks + warnings):
{full_facts}

## Financial Analyst said:
{financial}

## Operations Analyst said:
{operations}

## Risk Analyst said:
{risk}

CHECK FOR:
1. Did any analyst cite a number NOT in the Full Data above? Flag it with the correct value.
2. Did any analyst say "not available" when the data IS above? Correct them.
3. Did any analyst miss the top-priority finding (first item in findings list)?
4. Did any analyst guess causation without supporting data? Flag as [NEEDS EVIDENCE].
5. Are all three consistent — same numbers for the same metric?

Output: bullet list of corrections. Be direct, cite correct numbers."""

SYNTHESIS_PROMPT = """Write the final executive report.

## Key Metrics (system-generated — copy this table exactly):
{key_metrics_table}

## Financial Analysis:
{financial}

## Operations Analysis:
{operations}

## Risk Assessment:
{risk}

## Reviewer Corrections:
{reviewer}

## Structure:

**Executive Summary**
(2-3 sentences. Lead with CONCLUSION — what should the reader do?)

**Key Metrics**
{key_metrics_table}

**Financial Performance**
(Apply reviewer corrections. Use only numbers from the analyses above.)

**Operational Performance**
(Apply reviewer corrections. Use only numbers from the analyses above.)

**Risk Assessment**
(Keep confidence tags. Apply corrections.)

**Recommendations**
(3 specific actions. Who, what, when, expected impact.)

RULES:
- Apply ALL reviewer corrections.
- Use ONLY numbers from the sections above. Do NOT invent new numbers.
- 400-600 words."""

_REVIEW_SYSTEM = "You are a quality reviewer. Find errors and contradictions. Be direct."
_SYNTH_SYSTEM = "You are writing a management report. McKinsey Pyramid structure. Apply all corrections."


# ── Main Entry Point ─────────────────────────────────────────────────────

async def synthesize(
    findings_chain: list[tuple[str, str]],
    llm_config: dict,
    on_step=None,
    all_artifacts: list = None,
    analysis_context: dict | None = None,
) -> str:
    """
    V5+V9 Hybrid: V9 deterministic layer + V5 synthesis structure.

    V9 deterministic: priority ranking, role routing, causal context, key metrics table
    V5 synthesis: 3 specialist agents → reviewer → synthesizer (5 LLM calls)

    Each agent sees focused, role-filtered briefing (~800-2000 tokens) instead of
    everything (~3500 tokens). Numbers are real (no placeholders). Reviewer catches errors.
    """
    from ml.api.agent_tool_selector import _call_llm_via_proxy
    from ml.api.synthesis_briefing import (
        compute_priority_scores,
        build_causal_context,
        build_role_briefing,
        build_key_metrics_table,
        sanitize_output,
    )

    analysis_context = analysis_context or prepare_analysis_context(all_artifacts)
    mc = analysis_context.get("metric_contract", {})
    bp = analysis_context.get("benchmark_policy", {})
    fc = analysis_context.get("forecast_contracts", [])
    vr = analysis_context.get("validation_report", {})

    # ── Step 0: V9 deterministic preparation ──
    scored = compute_priority_scores(mc, bp)
    causal = build_causal_context(scored, mc)
    key_metrics_table = build_key_metrics_table(scored, mc)
    validation_issues = vr.get("issues", [])

    # Build per-role briefings (real numbers, priority-sorted, causal-annotated)
    briefings = {}
    for role in ("financial", "operational", "risk"):
        briefings[role] = build_role_briefing(
            role, scored, causal, fc, validation_issues, findings_chain,
        )

    # Full facts for reviewer (sees everything)
    full_facts = _build_structured_facts(findings_chain, all_artifacts, analysis_context)[0]

    if not any(b.strip() for b in briefings.values()) and not full_facts.strip():
        return "No analysis results were produced."

    for role, b in briefings.items():
        logger.info(f"[Synthesizer] {role} briefing: {len(b)} chars")

    if on_step:
        await on_step({"type": "synthesize_start"})

    # Use request llm_config if user selected a specific model, else env var, else default
    _req_provider = llm_config.get("provider", "")
    _use_request = _req_provider and _req_provider != "deepseek"  # non-default = user chose
    reasoning_provider = _req_provider if _use_request else os.environ.get("DI_REASONING_PROVIDER", "openai")
    reasoning_model = llm_config.get("model") if _use_request else os.environ.get("DI_REASONING_MODEL", "gpt-5.4")
    model_tag = f"{reasoning_provider}/{reasoning_model}"

    # Reasoning effort by role: specialists=medium (good enough), reviewer=low (just comparing numbers)
    _effort_for = {"specialist": "medium", "reviewer": "low", "writer": "medium"}

    async def call_agent(name, prompt_text, system=_LENS_SYSTEM, role="specialist"):
        effort = _effort_for.get(role, "medium")
        try:
            result = await _call_llm_via_proxy(
                prompt_text, system, llm_config,
                override_provider=reasoning_provider,
                override_model=reasoning_model,
                reasoning_effort=effort,
            )
            logger.info(f"[Synthesizer] {name}: {len(result)} chars")
            return result.strip()
        except Exception as e:
            logger.warning(f"[Synthesizer] {name} failed with {reasoning_provider}/{reasoning_model}: {e}")
            # Fallback: try without override (uses llm_config default)
            try:
                result = await _call_llm_via_proxy(prompt_text, system, llm_config)
                return result.strip()
            except Exception as e2:
                logger.error(f"[Synthesizer] {name} fallback also failed: {e2}")
                return f"({name} unavailable)"

    try:
        # ── Step 1: 3 specialists in parallel (V5 structure, V9 briefings) ──
        if on_step:
            for phase in ("financial_analysis", "operations_analysis", "risk_analysis"):
                await on_step({"type": "agent_status", "phase": phase, "status": "running", "model": model_tag})

        async def run_and_emit(name, phase, prompt):
            text = await call_agent(name, prompt)
            issues = validate_agent_output_text(phase, text)
            if any(i.get("severity") == "critical" for i in issues):
                retry_prompt = prompt + "\n\nYour previous answer was truncated. Rewrite fully from scratch."
                text = await call_agent(f"{name} retry", retry_prompt)
            if on_step and text and not text.startswith("("):
                await on_step({"type": "agent_status", "phase": phase, "status": "done"})
                await on_step({"type": "agent_thinking", "phase": phase, "thinking": text, "model": model_tag})
            return text

        fin_prompt = FINANCIAL_LENS.replace("{briefing}", briefings["financial"])
        ops_prompt = OPERATIONS_LENS.replace("{briefing}", briefings["operational"])
        risk_prompt = RISK_LENS.replace("{briefing}", briefings["risk"])

        financial, operations, risk = await asyncio.gather(
            run_and_emit("Financial Analyst", "financial_analysis", fin_prompt),
            run_and_emit("Operations Analyst", "operations_analysis", ops_prompt),
            run_and_emit("Risk Analyst", "risk_analysis", risk_prompt),
        )

        # ── Step 2: Reviewer (V5 structure — sees full facts + all 3 outputs) ──
        if on_step:
            await on_step({"type": "agent_status", "phase": "reviewer", "status": "running", "model": model_tag})

        reviewer_prompt = REVIEWER_PROMPT \
            .replace("{full_facts}", full_facts) \
            .replace("{financial}", financial) \
            .replace("{operations}", operations) \
            .replace("{risk}", risk)

        reviewer = await call_agent("Reviewer", reviewer_prompt, system=_REVIEW_SYSTEM, role="reviewer")

        if on_step:
            await on_step({"type": "agent_status", "phase": "reviewer", "status": "done"})
            if reviewer and not reviewer.startswith("("):
                await on_step({"type": "agent_thinking", "phase": "reviewer", "thinking": reviewer, "model": model_tag})

        # ── Step 3: Final synthesis (V5 structure — applies corrections) ──
        synth_prompt = SYNTHESIS_PROMPT \
            .replace("{key_metrics_table}", key_metrics_table) \
            .replace("{financial}", financial) \
            .replace("{operations}", operations) \
            .replace("{risk}", risk) \
            .replace("{reviewer}", reviewer)

        narrative = await call_agent("Lead Analyst", synth_prompt, system=_SYNTH_SYSTEM, role="writer")

        # ── Step 4: Safety net ──
        narrative = sanitize_output(narrative)

        if on_step and narrative:
            await on_step({"type": "synthesize_chunk", "text": narrative})

    except Exception as e:
        logger.error(f"[Synthesizer] Failed: {e}")
        try:
            fallback = f"Write a structured executive summary:\n{full_facts[:3000]}"
            narrative = await call_agent("Fallback", fallback)
            narrative = sanitize_output(narrative)
        except Exception:
            narrative = "## Analysis Summary (synthesis failed)\n\n"
            for tool_id, facts in findings_chain:
                if facts and facts.strip():
                    narrative += f"### {tool_id}\n{facts}\n\n"

    if on_step:
        await on_step({"type": "synthesize_done", "word_count": len(narrative.split()) if narrative else 0})

    return narrative
