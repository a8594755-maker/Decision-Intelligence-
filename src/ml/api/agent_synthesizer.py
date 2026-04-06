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
    metric_contract = build_metric_contract(all_artifacts or [])
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


# ── Agent Prompts (v3 — structured claims + writer) ─────────────────────

_CLAIMS_SYSTEM = "You are a specialist analyst. Output structured JSON claims only."

_REVIEWER_PROMPT = """You are a senior review analyst. Three specialists produced structured claims.

## Full Data:
{full_facts}

## Financial Claims:
{financial_claims}

## Operations Claims:
{operations_claims}

## Risk Claims:
{risk_claims}

CHECK:
1. Any claim referencing a metric_ref NOT in the full data? Flag it.
2. Any causal claim (cause_ref set) where the causal link is wrong? Flag it.
3. Any agent that missed the #1 most important finding? Call it out.
4. Any assessment that contradicts the numbers? (e.g., "strong" when delta is negative)

OUTPUT (valid JSON):
```json
{{
  "corrections": [
    {{"agent": "financial|operations|risk", "claim_ref": "metric_ref", "issue": "description", "severity": "critical|warning"}}
  ],
  "worst_agent": "financial|operations|risk",
  "worst_error": "description",
  "gaps": ["missing analysis"]
}}
```"""

_WRITER_SYSTEM = "You are writing a management report. McKinsey Pyramid structure. Only use the verified numbers provided."

_REVIEW_SYSTEM = "You are a quality reviewer. Find errors. Output valid JSON."


# ── Main Entry Point ─────────────────────────────────────────────────────

async def synthesize(
    findings_chain: list[tuple[str, str]],
    llm_config: dict,
    on_step=None,
    all_artifacts: list = None,
    analysis_context: dict | None = None,
) -> str:
    """
    v3 Synthesis: structured claims (enum-constrained) + writer.

    Like Excel formulas: LLM can only reference metrics that exist.

    Flow:
      1. [Deterministic] Score metrics, build per-role briefings
      2. [Parallel] 3 specialists output JSON claims (strict schema with enum)
      3. [Deterministic] Validate all claims
      4. [Sequential] Reviewer checks claims
      5. [Sequential] Writer converts verified claims to prose
      6. [Deterministic] sanitize_output as safety net
    """
    from ml.api.agent_tool_selector import _call_llm_via_proxy
    from ml.api.synthesis_briefing import (
        compute_priority_scores,
        build_causal_context,
        build_role_briefing,
        build_key_metrics_table,
        sanitize_output,
    )
    from ml.api.structured_claims import (
        build_valid_metric_ids,
        build_claims_schema,
        build_claims_prompt,
        validate_claims,
        claims_to_prose_prompt,
        build_ref_values,
        parse_claims_response,
    )

    analysis_context = analysis_context or prepare_analysis_context(all_artifacts)
    mc = analysis_context.get("metric_contract", {})
    bp = analysis_context.get("benchmark_policy", {})
    fc = analysis_context.get("forecast_contracts", [])
    vr = analysis_context.get("validation_report", {})

    # ── Step 0: Deterministic preparation ──
    scored = compute_priority_scores(mc, bp)
    causal = build_causal_context(scored, mc)
    key_metrics_table = build_key_metrics_table(scored, mc)
    valid_ids = build_valid_metric_ids(scored)
    ref_values = build_ref_values(scored, mc)
    valid_ids_set = set(valid_ids)

    validation_issues = vr.get("issues", [])

    # Build per-role briefings (real numbers, no placeholders)
    briefings = {}
    for role in ("financial", "operational", "risk"):
        briefings[role] = build_role_briefing(
            role, scored, causal, fc, validation_issues, findings_chain,
        )

    full_facts = _build_structured_facts(findings_chain, all_artifacts, analysis_context)[0]

    if not any(b.strip() for b in briefings.values()) and not full_facts.strip():
        return "No analysis results were produced."

    for role, briefing in briefings.items():
        logger.info(f"[Synthesizer] {role} briefing: {len(briefing)} chars")
    logger.info(f"[Synthesizer] Valid metric IDs: {len(valid_ids)}")

    if on_step:
        await on_step({"type": "synthesize_start"})

    reasoning_provider = "openai"
    reasoning_model = "gpt-5.4"
    model_tag = f"{reasoning_provider}/{reasoning_model} (reasoning=high)"

    async def call_agent(name, prompt_text, system, json_schema=None):
        try:
            result = await _call_llm_via_proxy(
                prompt_text, system, llm_config,
                override_provider=reasoning_provider,
                override_model=reasoning_model,
                reasoning_effort="high",
                json_schema=json_schema,
            )
            logger.info(f"[Synthesizer] {name}: {len(result)} chars")
            return result.strip()
        except Exception as e:
            logger.warning(f"[Synthesizer] {name} failed with {reasoning_model}: {e}")
            # Fallback without json_schema (in case strict mode fails)
            try:
                result = await _call_llm_via_proxy(prompt_text, system, llm_config)
                return result.strip()
            except Exception:
                return f"({name} unavailable)"

    try:
        # ── Step 1: 3 specialists in parallel — structured JSON claims ──
        valid_ids_text = "\n".join(f"  - {vid}" for vid in valid_ids)

        role_map = {
            "financial_analysis": ("financial", "Financial Analyst"),
            "operations_analysis": ("operational", "Operations Analyst"),
            "risk_analysis": ("risk", "Risk Analyst"),
        }

        if on_step:
            for phase in role_map:
                await on_step({"type": "agent_status", "phase": phase, "status": "running", "model": model_tag})

        async def run_specialist_claims(phase, role, role_name):
            schema = build_claims_schema(valid_ids, role)
            prompt = build_claims_prompt(role_name, briefings[role], valid_ids_text)
            json_schema_param = {"name": f"{role}_claims", "schema": schema}

            raw = await call_agent(role_name, prompt, _CLAIMS_SYSTEM, json_schema=json_schema_param)

            # Parse and validate
            claims_data = parse_claims_response(raw)
            if claims_data:
                valid_claims, errors = validate_claims(claims_data, valid_ids_set)
                if errors:
                    logger.warning(f"[Synthesizer] {role_name} claim errors: {errors}")
                claims_data["claims"] = valid_claims
            else:
                # Fallback: agent couldn't produce JSON — use empty claims
                logger.warning(f"[Synthesizer] {role_name} produced no parseable claims")
                claims_data = {"claims": [], "top_risk": None, "data_gaps": ["Agent failed to produce structured output"]}

            if on_step:
                # Show claims as thinking trace
                thinking = json.dumps(claims_data, indent=2, default=str)
                await on_step({"type": "agent_status", "phase": phase, "status": "done"})
                await on_step({"type": "agent_thinking", "phase": phase, "thinking": thinking, "model": model_tag})

            return claims_data

        fin_claims, ops_claims, risk_claims = await asyncio.gather(
            run_specialist_claims("financial_analysis", "financial", "Financial Analyst"),
            run_specialist_claims("operations_analysis", "operational", "Operations Analyst"),
            run_specialist_claims("risk_analysis", "risk", "Risk Analyst"),
        )

        # ── Step 2: Reviewer ──
        if on_step:
            await on_step({"type": "agent_status", "phase": "reviewer", "status": "running", "model": model_tag})

        reviewer_prompt = _REVIEWER_PROMPT \
            .replace("{full_facts}", full_facts) \
            .replace("{financial_claims}", json.dumps(fin_claims, indent=2, default=str)) \
            .replace("{operations_claims}", json.dumps(ops_claims, indent=2, default=str)) \
            .replace("{risk_claims}", json.dumps(risk_claims, indent=2, default=str))

        reviewer_raw = await call_agent("Reviewer", reviewer_prompt, _REVIEW_SYSTEM)

        if on_step:
            await on_step({"type": "agent_status", "phase": "reviewer", "status": "done"})
            if reviewer_raw and not reviewer_raw.startswith("("):
                await on_step({"type": "agent_thinking", "phase": "reviewer", "thinking": reviewer_raw, "model": model_tag})

        # Parse reviewer
        reviewer_text = reviewer_raw
        try:
            import re as _re
            json_match = _re.search(r'\{[\s\S]*\}', reviewer_raw)
            if json_match:
                reviewer_data = json.loads(json_match.group())
                correction_lines = []
                for c in reviewer_data.get("corrections", []):
                    correction_lines.append(f"- [{c.get('severity', 'warning')}] {c.get('agent', '?')}: {c.get('issue', '')}")
                for gap in reviewer_data.get("gaps", []):
                    correction_lines.append(f"- [gap] {gap}")
                if correction_lines:
                    reviewer_text = "\n".join(correction_lines)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.warning(f"[Synthesizer] Could not parse reviewer JSON: {e}")

        # ── Step 3: Writer — convert verified claims to prose ──
        all_claims = {
            "financial": fin_claims.get("claims", []),
            "operations": ops_claims.get("claims", []),
            "risk": risk_claims.get("claims", []),
        }

        writer_prompt = claims_to_prose_prompt(all_claims, key_metrics_table, ref_values, reviewer_text)
        narrative = await call_agent("Lead Analyst", writer_prompt, _WRITER_SYSTEM)

        # ── Step 4: Safety net ──
        narrative = sanitize_output(narrative)

        if on_step and narrative:
            await on_step({"type": "synthesize_chunk", "text": narrative})

    except Exception as e:
        logger.error(f"[Synthesizer] Failed: {e}")
        try:
            fallback = f"Write a structured executive summary:\n{full_facts}"
            narrative = await call_agent("Fallback", fallback, _WRITER_SYSTEM)
            narrative = sanitize_output(narrative)
        except Exception:
            narrative = "## Analysis Summary (synthesis failed)\n\n"
            for tool_id, facts in findings_chain:
                if facts and facts.strip():
                    narrative += f"### {tool_id}\n{facts}\n\n"

    if on_step:
        await on_step({"type": "synthesize_done", "word_count": len(narrative.split()) if narrative else 0})

    return narrative
