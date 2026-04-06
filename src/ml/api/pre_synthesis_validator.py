"""
pre_synthesis_validator.py — Detect structural gaps before writing the narrative.
"""

from __future__ import annotations

from typing import Any
import re

from ml.api.forecast_artifact_contract import extract_forecast_contracts


_SKIP_LABEL_PATTERNS = (
    "column mapping",
    "audit",
    "cleaned_",
    "detection config",
    "forecast contract",
)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_nullish(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value == ""
    if isinstance(value, (list, dict)):
        return len(value) == 0
    try:
        import numpy as np
        if isinstance(value, np.ndarray):
            return value.size == 0
    except ImportError:
        pass
    return False


def _has_real_payload(rows: list[dict[str, Any]]) -> bool:
    for row in rows:
        if not isinstance(row, dict):
            continue
        for value in row.values():
            if not _is_nullish(value):
                return True
    return False


def validate_analysis_inputs(
    all_artifacts: list[dict[str, Any]] | None,
    metric_contract: dict[str, Any] | None = None,
    benchmark_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues = []
    forecast_contracts = extract_forecast_contracts(all_artifacts or [])

    for art in all_artifacts or []:
        if art.get("type") != "table":
            continue
        label = art.get("label", "")
        label_lower = label.lower()
        if any(skip in label_lower for skip in _SKIP_LABEL_PATTERNS):
            continue
        data = art.get("data") or []

        if not data:
            severity = "critical" if any(kw in label_lower for kw in ("lead time", "margin", "revenue", "profit")) else "warning"
            issues.append({
                "severity": severity,
                "code": "empty_table",
                "source_artifact": label,
                "message": f"Artifact '{label}' exists but contains 0 rows.",
            })
            continue

        if isinstance(data, list) and data and isinstance(data[0], dict) and not _has_real_payload(data):
            issues.append({
                "severity": "critical",
                "code": "empty_table_shell",
                "source_artifact": label,
                "message": f"Artifact '{label}' only contains placeholder/null values.",
            })

        if "lead time" in label_lower and isinstance(data, list) and data and isinstance(data[0], dict):
            numeric_seen = False
            for row in data:
                for value in row.values():
                    if _is_number(value):
                        numeric_seen = True
                        break
                if numeric_seen:
                    break
            if not numeric_seen:
                issues.append({
                    "severity": "critical",
                    "code": "missing_lead_time_values",
                    "source_artifact": label,
                    "message": f"Lead time artifact '{label}' has no numeric values. Treat as a hard data gap.",
                })

        # Anomaly escalation: flag when anomaly ratio is high relative to data size
        if "anomal" in label_lower and isinstance(data, list) and len(data) > 0:
            total_anomalies = len(data)
            critical_count = sum(
                1 for row in data
                if isinstance(row, dict) and str(row.get("severity", "")).lower() == "critical"
            )
            # Estimate total rows from other artifacts to compute ratio
            total_rows = 0
            for other in (all_artifacts or []):
                other_label = (other.get("label") or "").lower()
                if other_label.startswith("cleaned_") and isinstance(other.get("data"), list):
                    total_rows = max(total_rows, len(other.get("data", [])))
            anomaly_ratio = total_anomalies / max(total_rows, 1)
            # Escalate if >10% of rows are anomalies, or if critical count is >1% of rows
            if anomaly_ratio > 0.10 or (total_rows > 0 and critical_count / total_rows > 0.01):
                issues.append({
                    "severity": "critical",
                    "code": "high_anomaly_ratio",
                    "source_artifact": label,
                    "message": (
                        f"Anomaly detection flagged {total_anomalies} of ~{total_rows} rows "
                        f"({anomaly_ratio:.0%}) with {critical_count} critical. "
                        "This ratio warrants prominent discussion in the risk section."
                    ),
                })

    for warning in (metric_contract or {}).get("warnings", []):
        issues.append({
            "severity": warning.get("severity", "warning"),
            "code": warning.get("code", "metric_warning"),
            "source_artifact": "metric_contract",
            "message": warning.get("message", ""),
        })

    for contract in forecast_contracts:
        label = contract.get("label", "forecast artifact")
        value_unit = contract.get("value_unit") or "unknown"
        granularity = contract.get("series_granularity") or "unknown"
        measure_name = contract.get("measure_name") or ""

        if value_unit == "unknown":
            issues.append({
                "severity": "warning",
                "code": "ambiguous_forecast_unit",
                "source_artifact": label,
                "message": (
                    f"Forecast artifact '{label}' has predictions but no reliable unit. "
                    "Narrative must not describe forecast magnitude as units or currency without qualification."
                ),
            })

        if not measure_name:
            issues.append({
                "severity": "warning",
                "code": "ambiguous_forecast_measure",
                "source_artifact": label,
                "message": (
                    f"Forecast artifact '{label}' does not identify the forecasted measure. "
                    "Treat the series as magnitude-only until measure semantics are explicit."
                ),
            })

        if granularity == "unknown":
            issues.append({
                "severity": "warning",
                "code": "unknown_forecast_granularity",
                "source_artifact": label,
                "message": (
                    f"Forecast artifact '{label}' does not expose a reliable series granularity. "
                    "Do not describe it as daily/weekly/monthly without qualification."
                ),
            })

    if benchmark_policy is not None and not benchmark_policy.get("comparisons"):
        issues.append({
            "severity": "info",
            "code": "no_benchmark_policy",
            "source_artifact": "benchmark_policy",
            "message": "No comparable breakdowns were available for deterministic benchmark policy.",
        })

    return {"issues": issues}


def build_validation_artifacts(validation_report: dict[str, Any]) -> list[dict[str, Any]]:
    issues = validation_report.get("issues", [])
    if not issues:
        return []
    rows = []
    for issue in issues:
        rows.append({
            "severity": issue.get("severity"),
            "code": issue.get("code"),
            "source_artifact": issue.get("source_artifact"),
            "message": issue.get("message"),
        })
    return [{
        "type": "table",
        "label": "Data Gaps & Warnings",
        "data": rows,
    }]


def validation_report_to_markdown(validation_report: dict[str, Any]) -> str:
    issues = validation_report.get("issues", [])
    if not issues:
        return ""
    lines = ["## Data Gaps & Warnings"]
    for issue in issues:
        lines.append(
            f"- [{issue.get('severity', 'warning')}] {issue.get('message', '')}"
        )
    return "\n".join(lines)


def validate_agent_output_text(phase: str, text: str) -> list[dict[str, Any]]:
    content = (text or "").strip()
    if not content or content.startswith("("):
        return [{
            "severity": "critical",
            "code": "missing_agent_output",
            "phase": phase,
            "message": f"{phase} returned no usable content.",
        }]

    issues = []
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", content) if part.strip()]
    last_line = content.splitlines()[-1].strip()

    if phase in {"financial_analysis", "operations_analysis"} and len(sentences) < 3:
        issues.append({
            "severity": "warning",
            "code": "too_short",
            "phase": phase,
            "message": f"{phase} returned only {len(sentences)} sentences.",
        })

    if phase == "risk_analysis" and not re.search(r"(^|\n)\s*1[\).\s]", content):
        issues.append({
            "severity": "warning",
            "code": "missing_numbered_risks",
            "phase": phase,
            "message": "Risk analysis did not return the expected numbered list format.",
        })

    if last_line.endswith((
        " at",
        " by",
        " with",
        " from",
        " due to",
        ":",
        "-",
        "—",
        "(",
    )) or (last_line and last_line[-1] not in ".!?)]\"'"):
        issues.append({
            "severity": "critical",
            "code": "truncated_output",
            "phase": phase,
            "message": f"{phase} appears truncated or incomplete.",
        })

    return issues
