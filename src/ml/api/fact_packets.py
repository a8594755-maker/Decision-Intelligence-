"""
fact_packets.py — Build tiny, focused fact packets for micro-call synthesis.

Each packet contains 3-5 facts with real numbers. One LLM call per packet.
LLM only sees ~200 tokens and can only use the numbers in front of it.

Flow:
  scored_items + causal_context + metric_contract
      ↓
  build_fact_packets()  → list of packets, each with 3-5 facts
      ↓
  each packet → 1 LLM micro-call → 2-3 sentences
      ↓
  assemble_report()  → Key Metrics table + micro-outputs → final report
"""

from __future__ import annotations

from typing import Any


def _fmt(value: Any) -> str:
    """Format a number for display."""
    if isinstance(value, float):
        if abs(value) >= 1_000_000:
            return f"${value:,.0f}"
        elif abs(value) >= 1:
            return f"{value:,.2f}"
        else:
            return f"{value:.4f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _build_one_fact(item: dict[str, Any], causal_map: dict[str, dict]) -> str:
    """Format a single scored item into a readable fact line."""
    ref = item["ref_id"]
    val = _fmt(item["value"])

    if item["type"] == "scalar":
        name = item.get("display_name", item["metric_id"])
        unit = item.get("unit", "")
        return f"{name}: {val} ({unit})"

    # Breakdown row
    dim_val = item["dimension_value"]
    metric = item["metric_id"].replace("_", " ")
    bad = " ⚠️ PROBLEM" if item["is_bad"] else ""

    parts = [f"{dim_val} {metric}: {val}"]
    if item.get("benchmark") is not None:
        parts.append(f"benchmark: {_fmt(item['benchmark'])}")
    if item.get("delta") is not None:
        parts.append(f"delta: {item['delta']:+.2f}")
    line = " | ".join(parts) + bad

    # Add causal context if available
    causal = causal_map.get(ref)
    if causal:
        candidates = causal.get("explanation_candidates", {})
        if candidates:
            explanations = [f"{mid}={_fmt(v)}" for mid, v in candidates.items()]
            line += f"\n   Why? Available data: {', '.join(explanations)}"

    return line


def build_fact_packets(
    scored_items: list[dict[str, Any]],
    causal_context: list[dict[str, Any]],
    forecast_contracts: list[dict[str, Any]],
    validation_issues: list[dict[str, Any]],
    findings_chain: list[tuple[str, str]] | None = None,
    facts_per_packet: int = 3,
    max_packets_per_role: int = 3,
) -> list[dict[str, Any]]:
    """Build focused fact packets for micro-call synthesis.

    Returns list of packets:
    [
      {"role": "financial", "packet_id": 0, "facts_text": "...", "task": "..."},
      {"role": "financial", "packet_id": 1, "facts_text": "...", "task": "..."},
      {"role": "operational", "packet_id": 0, "facts_text": "...", "task": "..."},
      ...
    ]
    """
    # Build causal lookup
    causal_map = {c["ref_id"]: c for c in causal_context}

    # Separate items by role
    role_items: dict[str, list[dict]] = {"financial": [], "operational": [], "risk": []}

    for item in scored_items:
        role = item.get("role", "financial")
        if role in role_items:
            role_items[role].append(item)

    # Risk also gets all high-priority bad items from other roles
    all_bad = [s for s in scored_items if s.get("is_bad") and s["type"] == "breakdown_row"]
    seen_risk = {s["ref_id"] for s in role_items["risk"]}
    for item in all_bad:
        if item["ref_id"] not in seen_risk:
            role_items["risk"].append(item)
            seen_risk.add(item["ref_id"])
    role_items["risk"].sort(key=lambda x: -x.get("priority_score", 0))

    packets = []

    # Role-specific task descriptions
    role_tasks = {
        "financial": "Analyze the financial picture. What's working, what's not, and why?",
        "operational": "Analyze operational performance. Lead times, fulfillment, shipping patterns.",
        "risk": "Identify risks. What needs immediate attention and what's the business impact?",
    }

    for role, items in role_items.items():
        # Split: scalars first (context), then findings (sorted by priority)
        scalars = [i for i in items if i["type"] == "scalar"]
        findings = [i for i in items if i["type"] == "breakdown_row" and i.get("priority_score", 0) > 0]

        # Build context line from scalars (always included in every packet for this role)
        if scalars:
            context_lines = [_build_one_fact(s, causal_map) for s in scalars[:5]]
            context_text = "Context: " + " | ".join(context_lines)
        else:
            context_text = ""

        # Chunk findings into packets of `facts_per_packet`
        for pkt_idx in range(min(max_packets_per_role, max(1, (len(findings) + facts_per_packet - 1) // facts_per_packet))):
            start = pkt_idx * facts_per_packet
            chunk = findings[start:start + facts_per_packet]
            if not chunk and pkt_idx > 0:
                break

            fact_lines = [_build_one_fact(f, causal_map) for f in chunk]
            numbered = "\n".join(f"{i+1}. {line}" for i, line in enumerate(fact_lines))

            facts_text = ""
            if context_text:
                facts_text += context_text + "\n\n"
            if numbered:
                facts_text += f"Findings:\n{numbered}"

            # Add forecast info for operational role
            if role == "operational" and forecast_contracts and pkt_idx == 0:
                for fc in forecast_contracts:
                    facts_text += (
                        f"\n\nForecast: measure={fc.get('measure_name', 'unknown')}, "
                        f"unit={fc.get('value_unit', 'unknown')}, "
                        f"granularity={fc.get('series_granularity', 'unknown')}"
                    )

            # Add warnings for first packet of each role
            if pkt_idx == 0 and validation_issues:
                role_warnings = _filter_warnings(role, validation_issues)
                if role_warnings:
                    warning_text = "\n".join(f"⚠️ {w.get('message', '')}" for w in role_warnings[:3])
                    facts_text += f"\n\nWarnings:\n{warning_text}"

            # Add relevant tool summaries for first packet
            if pkt_idx == 0 and findings_chain:
                tool_text = _get_tool_summary(role, findings_chain)
                if tool_text:
                    facts_text += f"\n\nTool output:\n{tool_text}"

            task = role_tasks.get(role, "Analyze the data.")
            sentence_count = "2-3" if len(chunk) <= 3 else "3-5"

            packets.append({
                "role": role,
                "packet_id": pkt_idx,
                "facts_text": facts_text,
                "fact_count": len(chunk),
                "task": task,
                "sentence_count": sentence_count,
            })

    return packets


def _filter_warnings(role: str, issues: list[dict]) -> list[dict]:
    kw = {
        "financial": ("revenue", "profit", "margin", "discount", "conflict", "denominator"),
        "operational": ("lead_time", "forecast", "ship", "granularity", "unit"),
        "risk": ("anomaly", "quarantine", "gap", "empty"),
    }
    keywords = kw.get(role, ())
    return [i for i in issues if any(k in (i.get("message", "") + i.get("code", "")).lower() for k in keywords)]


def _get_tool_summary(role: str, findings_chain: list[tuple[str, str]]) -> str:
    kw = {
        "financial": ("kpi", "variance"),
        "operational": ("forecast", "eda", "solver"),
        "risk": ("anomaly", "risk"),
    }
    keywords = kw.get(role, ())
    parts = []
    for tool_id, summary in findings_chain:
        if any(k in tool_id.lower() for k in keywords):
            if summary and summary.strip():
                # Truncate long summaries
                short = summary.strip()[:300]
                parts.append(f"{tool_id}: {short}")
    return "\n".join(parts[:2])  # max 2 tool summaries


def build_micro_prompt(packet: dict[str, Any]) -> str:
    """Build the prompt for a single micro-call."""
    return f"""{packet['facts_text']}

TASK: {packet['task']}
Write exactly {packet['sentence_count']} sentences. Use ONLY the numbers above. Do NOT add any numbers not shown above."""


def assemble_report(
    key_metrics_table: str,
    micro_outputs: dict[str, list[str]],
    reviewer_notes: str = "",
) -> str:
    """Assemble final report from micro-call outputs.

    micro_outputs: {"financial": ["2-3 sentences", ...], "operational": [...], "risk": [...]}
    """
    sections = []

    # Key Metrics (system-generated)
    sections.append(f"**Key Metrics**\n\n{key_metrics_table}")

    # Financial
    fin_text = " ".join(micro_outputs.get("financial", []))
    if fin_text.strip():
        sections.append(f"**Financial Performance**\n\n{fin_text}")

    # Operational
    ops_text = " ".join(micro_outputs.get("operational", []))
    if ops_text.strip():
        sections.append(f"**Operational Performance**\n\n{ops_text}")

    # Risk
    risk_text = " ".join(micro_outputs.get("risk", []))
    if risk_text.strip():
        sections.append(f"**Risk Assessment**\n\n{risk_text}")

    # Reviewer notes (if any corrections)
    if reviewer_notes and reviewer_notes.strip():
        sections.append(f"**Data Quality Notes**\n\n{reviewer_notes}")

    return "\n\n".join(sections)
