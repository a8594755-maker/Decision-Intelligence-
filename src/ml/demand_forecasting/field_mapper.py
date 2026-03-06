"""
Phase 1 – Deliverable 1.2: Server-Side Field Mapper
────────────────────────────────────────────────────
Maps ERP column names to canonical field names.
Python equivalent of the JS headerSynonyms.js for use in API endpoints.

Usage:
    from ml.demand_forecasting.field_mapper import (
        map_header,
        map_headers_batch,
        normalize_dataframe_columns,
    )
    canonical = map_header("Part Number")  # → "material_code"
    df = normalize_dataframe_columns(df)   # → renames columns in-place
"""
import re
from typing import Dict, List, Optional, Tuple

# ── Canonical field → synonyms mapping ───────────────────────────────────
# Mirrors src/config/headerSynonyms.js (Python-side for API validation)

FIELD_SYNONYMS: Dict[str, List[str]] = {
    "material_code": [
        "part_no", "part_number", "item", "item_code", "sku",
        "product_code", "product_id", "material", "material_id",
        "mat_code", "mat_no", "matnr", "article",
    ],
    "date": [
        "delivery_date", "ship_date", "due_date", "order_date",
        "po_date", "receipt_date", "transaction_date", "created_date",
        "planned_date", "actual_date", "period", "timestamp",
    ],
    "qty": [
        "quantity", "amount", "volume", "units", "order_qty",
        "demand", "sales", "consumption", "usage",
    ],
    "plant_id": [
        "plant", "site", "location", "warehouse", "wh",
        "facility", "dc", "distribution_center",
    ],
    "supplier_id": [
        "supplier", "vendor", "vendor_id", "supplier_code",
        "supplier_name", "vendor_name",
    ],
    "lead_time_days": [
        "lead_time", "lt", "lt_days", "delivery_time",
        "replenishment_time",
    ],
    "onhand_qty": [
        "on_hand", "stock", "inventory", "available",
        "current_stock", "stock_level",
    ],
    "safety_stock": [
        "ss", "safety", "buffer", "min_stock",
        "reorder_point",
    ],
    "unit_cost": [
        "cost", "price", "unit_price", "purchase_price",
        "standard_cost",
    ],
    "moq": [
        "min_order_qty", "minimum_order", "min_qty",
    ],
    "pack_size": [
        "lot_size", "batch_size", "order_multiple",
        "rounding_qty",
    ],
}

# Build reverse lookup: normalized_synonym → canonical
_REVERSE_MAP: Dict[str, str] = {}
for canonical, synonyms in FIELD_SYNONYMS.items():
    _REVERSE_MAP[canonical] = canonical
    for syn in synonyms:
        _REVERSE_MAP[syn] = canonical


def _normalize(header: str) -> str:
    """Normalize a header: lowercase, replace spaces/dashes with _, strip."""
    s = header.strip().lower()
    s = re.sub(r"[\s\-]+", "_", s)
    s = re.sub(r"_+", "_", s)
    return s.strip("_")


def map_header(raw_header: str) -> Optional[str]:
    """
    Map a raw column header to its canonical field name.

    Returns canonical name or None if no match found.
    """
    normalized = _normalize(raw_header)
    return _REVERSE_MAP.get(normalized)


def map_headers_batch(headers: List[str]) -> Dict[str, Optional[str]]:
    """
    Map a batch of raw headers to canonical names.

    Returns {raw_header: canonical_or_None}.
    """
    return {h: map_header(h) for h in headers}


def normalize_dataframe_columns(
    df,
    strict: bool = False,
) -> Tuple:
    """
    Rename DataFrame columns to canonical names where possible.

    Args:
        df: pandas DataFrame.
        strict: If True, raise ValueError for unmapped columns.

    Returns:
        (df_renamed, mapping_report)
        mapping_report: {
            "mapped": {"raw": "canonical", ...},
            "unmapped": ["raw1", ...],
        }
    """
    mapped = {}
    unmapped = []
    rename_map = {}

    for col in df.columns:
        canonical = map_header(col)
        if canonical:
            rename_map[col] = canonical
            mapped[col] = canonical
        else:
            unmapped.append(col)

    if strict and unmapped:
        raise ValueError(
            f"Unmapped columns: {unmapped}. "
            f"Known fields: {sorted(FIELD_SYNONYMS.keys())}"
        )

    df_renamed = df.rename(columns=rename_map)
    report = {"mapped": mapped, "unmapped": unmapped}

    return df_renamed, report


def get_required_fields(endpoint: str) -> List[str]:
    """
    Return required canonical field names for an endpoint.

    Args:
        endpoint: "forecast", "train", "plan".
    """
    base = ["material_code"]
    if endpoint in ("forecast", "train"):
        return base + ["date", "qty"]
    if endpoint == "plan":
        return base + ["date", "qty", "plant_id"]
    return base
