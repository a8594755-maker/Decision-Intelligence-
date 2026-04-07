"""
structured_claims.py — Enum-constrained structured output for specialist agents.

Like Excel formulas: the LLM can only reference metric_ids that actually exist.
Uses OpenAI Responses API strict JSON schema to enforce this at decode time.

Flow:
  1. Build dynamic enum from metric contract (only real metric_ids)
  2. Each specialist outputs JSON claims constrained to that enum
  3. System validates claims (belt-and-suspenders — schema already blocks bad refs)
  4. Writer LLM converts validated claims into prose
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def build_valid_metric_ids(
    scored_items: list[dict[str, Any]],
) -> list[str]:
    """Extract all valid ref_ids from scored items.

    These become the enum — the LLM can ONLY reference these.
    """
    ids = set()
    for item in scored_items:
        ids.add(item["ref_id"])
    return sorted(ids)


def build_claims_schema(valid_metric_ids: list[str], role: str) -> dict[str, Any]:
    """Build a JSON schema for structured claims output.

    The metric_ref field is constrained to an enum of valid IDs.
    """
    # Assessment options vary by role
    assessment_options = [
        "critically_low", "below_benchmark", "at_benchmark",
        "above_benchmark", "strong", "improving", "declining",
        "data_gap", "needs_investigation",
    ]

    confidence_options = ["data_proven", "likely_inference", "needs_validation"]

    return {
        "type": "object",
        "properties": {
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "metric_ref": {
                            "type": "string",
                            "enum": valid_metric_ids,
                            "description": "Must be one of the provided metric IDs",
                        },
                        "assessment": {
                            "type": "string",
                            "enum": assessment_options,
                        },
                        "confidence": {
                            "type": "string",
                            "enum": confidence_options,
                        },
                        "insight": {
                            "type": "string",
                            "description": "One sentence explaining why this matters",
                        },
                        "cause_ref": {
                            "type": ["string", "null"],
                            "description": "If making a causal claim, the metric_ref of the cause. Must be from the valid list or null.",
                        },
                    },
                    "required": ["metric_ref", "assessment", "confidence", "insight"],
                    "additionalProperties": False,
                },
            },
            "top_risk": {
                "type": ["string", "null"],
                "description": "The single most important finding (metric_ref)",
            },
            "data_gaps": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of data quality issues or missing metrics",
            },
        },
        "required": ["claims", "top_risk", "data_gaps"],
        "additionalProperties": False,
    }


def build_claims_prompt(role_name: str, briefing: str, valid_ids_text: str) -> str:
    """Build the prompt for structured claims output."""
    return f"""You are a senior {role_name}. Analyze the data and output structured claims.

{briefing}

## Valid metric references (you can ONLY use these):
{valid_ids_text}

RULES:
- Output 4-8 claims, sorted by importance (most critical first).
- Each claim must reference a metric_ref from the valid list above.
- If you want to explain WHY a metric is bad, set cause_ref to another valid metric.
- Do NOT reference metrics not in the valid list.
- If data is missing for something important, add it to data_gaps.
- Use "data_proven" for claims directly supported by numbers.
- Use "likely_inference" for reasonable deductions.
- Use "needs_validation" for hypotheses."""


def validate_claims(
    claims_data: dict[str, Any],
    valid_ids: set[str],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Belt-and-suspenders validation. Schema should already block invalid refs,
    but check anyway.

    Returns (valid_claims, errors).
    """
    valid_claims = []
    errors = []

    for claim in claims_data.get("claims", []):
        ref = claim.get("metric_ref", "")
        if ref not in valid_ids:
            errors.append(f"Invalid metric_ref: {ref}")
            continue

        cause = claim.get("cause_ref")
        if cause and cause not in valid_ids:
            errors.append(f"Invalid cause_ref: {cause}")
            claim["cause_ref"] = None  # strip invalid cause, keep claim

        valid_claims.append(claim)

    return valid_claims, errors


def claims_to_prose_prompt(
    all_claims: dict[str, list[dict[str, Any]]],
    key_metrics_table: str,
    ref_values: dict[str, str],
    reviewer_text: str = "",
) -> str:
    """Build the prompt for the writer LLM that converts claims to prose.

    ref_values maps metric_ref → formatted display value, so the writer
    can include real numbers.
    """
    sections = []

    for role, claims in all_claims.items():
        lines = [f"## {role.title()} Claims"]
        for i, c in enumerate(claims, 1):
            ref = c["metric_ref"]
            val = ref_values.get(ref, ref)
            assessment = c["assessment"].replace("_", " ")
            insight = c["insight"]
            confidence = c["confidence"].replace("_", " ")

            cause_text = ""
            if c.get("cause_ref"):
                cause_ref = c["cause_ref"]
                cause_val = ref_values.get(cause_ref, cause_ref)
                cause_text = f" [Cause: {cause_ref} = {cause_val}]"

            lines.append(
                f"{i}. **{ref}** = {val} → {assessment} ({confidence}){cause_text}"
                f"\n   {insight}"
            )

        gaps = [c for c in claims if False]  # placeholder for data_gaps from role
        sections.append("\n".join(lines))

    # Add data gaps from all roles
    all_gaps = []
    for role_claims in all_claims.values():
        pass  # gaps come from claims_data["data_gaps"], handled at caller level

    claims_text = "\n\n".join(sections)

    return f"""Write the final executive report from these verified claims.

## Key Metrics (system-generated — copy this table exactly):
{key_metrics_table}

## Verified Claims (every number below is confirmed correct):
{claims_text}

## Reviewer Notes:
{reviewer_text}

## Structure:

**Executive Summary**
(2-3 sentences. Lead with the CONCLUSION.)

**Key Metrics**
{key_metrics_table}

**Financial Performance**
(Use the verified claim numbers. Apply reviewer corrections.)

**Operational Performance**
(Use the verified claim numbers. Apply reviewer corrections.)

**Risk Assessment**
(Include confidence levels from claims.)

**Recommendations**
(3 specific actions based on the claims.)

RULES:
- ONLY use numbers from the Verified Claims and Key Metrics above.
- Do NOT invent new numbers or calculations.
- 400-600 words."""


def build_ref_values(
    scored_items: list[dict[str, Any]],
    metric_contract: dict[str, Any],
) -> dict[str, str]:
    """Map every ref_id to its formatted display value."""
    from ml.api.synthesis_briefing import _format_ref_value

    table: dict[str, str] = {}

    # Scalars
    for m in metric_contract.get("scalar_metrics", []):
        table[m["metric_id"]] = _format_ref_value(m.get("value"))

    # Breakdown rows from scored items
    for item in scored_items:
        if item["type"] == "breakdown_row":
            table[item["ref_id"]] = _format_ref_value(item["value"])

    # Also from raw breakdown data
    for breakdown in metric_contract.get("breakdowns", []):
        mid = breakdown["metric_id"]
        for row in breakdown.get("rows", []):
            dim_val = row.get("dimension_value", "")
            val = row.get("metric_value")
            if val is not None:
                ref = f"{mid}:{dim_val}"
                if ref not in table:
                    table[ref] = _format_ref_value(val)

    return table


def parse_claims_response(raw: str) -> dict[str, Any] | None:
    """Parse JSON claims from LLM response, handling markdown fences."""
    text = raw.strip()
    # Strip markdown fences
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    # Find JSON object
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass

    logger.warning(f"[StructuredClaims] Could not parse JSON from response: {text[:200]}")
    return None
