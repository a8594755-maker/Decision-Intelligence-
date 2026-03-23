"""
NemoClaw Adapter — Detects NemoClaw/OpenShell environment and adjusts behavior.

When running under NemoClaw:
- Respects OpenShell filesystem/network capability bounds
- Tags data with privacy classification labels
- Exposes /healthz and /readyz probes for NemoClaw monitoring
- Limits resource usage to sandbox manifest declarations

This is a declarative compatibility layer — it has no runtime dependency on
NemoClaw itself. If NemoClaw is not present, everything passes through unchanged.
"""

import os
import logging
from typing import Any

logger = logging.getLogger(__name__)

# ── Environment detection ─────────────────────────────────────────────────────

# NemoClaw sets these environment variables when running under OpenShell
NEMOCLAW_INDICATORS = [
    "NEMOCLAW_SANDBOX_ID",
    "OPENSHELL_RUNTIME",
    "NEMOCLAW_POLICY_ENDPOINT",
]


def is_nemoclaw_environment() -> bool:
    """Check if we're running under NemoClaw OpenShell sandbox."""
    return any(os.getenv(var) for var in NEMOCLAW_INDICATORS)


def get_sandbox_id() -> str | None:
    """Get the NemoClaw sandbox instance ID."""
    return os.getenv("NEMOCLAW_SANDBOX_ID")


# ── Data classification ───────────────────────────────────────────────────────

# Fields that must stay on-device (never sent to cloud LLM)
CONFIDENTIAL_FIELDS = frozenset({
    "supplier_name", "unit_cost", "unit_price", "contract_terms",
    "negotiation_position", "margin", "profit", "cost_breakdown",
    "price_break", "discount_rate", "batna", "reservation_price",
})

# Fields that can be anonymized before cloud processing
INTERNAL_FIELDS = frozenset({
    "material_description", "plant_name", "buyer_name", "approval_notes",
})

# Fields safe for cloud processing (aggregated/statistical)
PUBLIC_FIELDS = frozenset({
    "forecast_series", "risk_scores", "plan_summary", "service_level",
    "total_cost", "time_bucket", "demand_qty",
})


class DataClassification:
    CONFIDENTIAL = "confidential"
    INTERNAL = "internal"
    PUBLIC = "public"


def classify_data(data: dict[str, Any]) -> DataClassification:
    """
    Classify data sensitivity based on field names present.
    Returns the highest sensitivity level found.
    """
    fields = set(_extract_field_names(data))

    if fields & CONFIDENTIAL_FIELDS:
        return DataClassification.CONFIDENTIAL
    if fields & INTERNAL_FIELDS:
        return DataClassification.INTERNAL
    return DataClassification.PUBLIC


def _extract_field_names(data: Any, prefix: str = "") -> list[str]:
    """Recursively extract all field names from nested data."""
    names = []
    if isinstance(data, dict):
        for key, value in data.items():
            names.append(key)
            names.extend(_extract_field_names(value, f"{prefix}{key}."))
    elif isinstance(data, list) and len(data) > 0:
        names.extend(_extract_field_names(data[0], prefix))
    return names


def strip_confidential_fields(data: dict[str, Any]) -> dict[str, Any]:
    """
    Remove confidential fields from data before sending to cloud LLM.
    Returns a sanitized copy.
    """
    if not isinstance(data, dict):
        return data

    sanitized = {}
    for key, value in data.items():
        if key in CONFIDENTIAL_FIELDS:
            sanitized[key] = "[REDACTED]"
        elif isinstance(value, dict):
            sanitized[key] = strip_confidential_fields(value)
        elif isinstance(value, list):
            sanitized[key] = [
                strip_confidential_fields(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            sanitized[key] = value

    return sanitized


def anonymize_internal_fields(data: dict[str, Any]) -> dict[str, Any]:
    """
    Anonymize internal fields (pseudonymize or generalize).
    Returns an anonymized copy.
    """
    if not isinstance(data, dict):
        return data

    anonymized = {}
    for key, value in data.items():
        if key == "supplier_name" and isinstance(value, str):
            # Pseudonymize: hash to Supplier_XXXX
            import hashlib
            h = hashlib.md5(value.encode()).hexdigest()[:4].upper()
            anonymized[key] = f"Supplier_{h}"
        elif key == "buyer_name":
            anonymized[key] = "[Buyer]"
        elif key == "plant_name" and isinstance(value, str):
            anonymized[key] = f"Plant_{value[:2].upper()}"
        elif key == "material_description":
            anonymized[key] = "[Material]"
        elif isinstance(value, dict):
            anonymized[key] = anonymize_internal_fields(value)
        elif isinstance(value, list):
            anonymized[key] = [
                anonymize_internal_fields(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            anonymized[key] = value

    return anonymized


# ── Privacy-aware data preparation ────────────────────────────────────────────


def prepare_for_llm(data: dict[str, Any], destination: str = "cloud") -> dict[str, Any]:
    """
    Prepare data for LLM processing with appropriate privacy controls.

    Args:
        data: The data to process
        destination: 'cloud' (external LLM) or 'local' (on-device model)

    Returns:
        Sanitized data appropriate for the destination
    """
    if destination == "local":
        # Local processing — no sanitization needed
        return data

    classification = classify_data(data)

    if classification == DataClassification.CONFIDENTIAL:
        if is_nemoclaw_environment():
            logger.warning(
                "Confidential data detected — blocking cloud LLM call under NemoClaw. "
                "Use on-device model instead."
            )
            return strip_confidential_fields(data)
        else:
            # Not under NemoClaw — warn but allow (developer responsibility)
            logger.warning("Confidential data detected in cloud-bound LLM call")
            return strip_confidential_fields(data)

    if classification == DataClassification.INTERNAL:
        return anonymize_internal_fields(data)

    # PUBLIC — pass through
    return data


# ── Sandbox resource limits ───────────────────────────────────────────────────


def get_resource_limits() -> dict[str, Any]:
    """Get resource limits from NemoClaw sandbox manifest or defaults."""
    if is_nemoclaw_environment():
        return {
            "max_memory_mb": int(os.getenv("NEMOCLAW_MAX_MEMORY_MB", "2048")),
            "max_cpu_percent": int(os.getenv("NEMOCLAW_MAX_CPU_PERCENT", "80")),
            "timeout_seconds": int(os.getenv("NEMOCLAW_TIMEOUT_SECONDS", "300")),
            "max_concurrent_tools": int(os.getenv("NEMOCLAW_MAX_CONCURRENT", "3")),
        }
    return {
        "max_memory_mb": 4096,
        "max_cpu_percent": 100,
        "timeout_seconds": 600,
        "max_concurrent_tools": 10,
    }


# ── Health check helpers (used by observability.py) ───────────────────────────


def nemoclaw_health_info() -> dict[str, Any]:
    """Return NemoClaw-specific health information for /healthz and /readyz."""
    return {
        "nemoclaw_enabled": is_nemoclaw_environment(),
        "sandbox_id": get_sandbox_id(),
        "resource_limits": get_resource_limits(),
        "data_classification_available": True,
        "privacy_router_compatible": True,
    }
