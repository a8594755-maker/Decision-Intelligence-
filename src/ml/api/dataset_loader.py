"""
Server-side dataset loader with in-memory caching.

Loads Olist CSV files directly from the filesystem so the Python sandbox
can work with full DataFrames without receiving data via JSON request body.
"""

import os
import time
import logging
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Table registry — maps logical names to CSV filenames
# ---------------------------------------------------------------------------

OLIST_TABLE_REGISTRY = {
    "customers":            "olist_customers_dataset.csv",
    "orders":               "olist_orders_dataset.csv",
    "order_items":          "olist_order_items_dataset.csv",
    "payments":             "olist_order_payments_dataset.csv",
    "reviews":              "olist_order_reviews_dataset.csv",
    "products":             "olist_products_dataset.csv",
    "sellers":              "olist_sellers_dataset.csv",
    "geolocation":          "olist_geolocation_dataset.csv",
    "category_translation": "product_category_name_translation.csv",
}

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_cache: Dict[str, Dict[str, pd.DataFrame]] = {}
_cache_ts: Dict[str, float] = {}
CACHE_TTL_SECONDS = 3600  # 1 hour — data is static


def _resolve_data_dir() -> str:
    """Resolve the data directory from env or default."""
    env_dir = os.environ.get("DATA_DIR")
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    # Default: relative to project root
    project_root = Path(__file__).resolve().parents[3]  # src/ml/api -> project root
    default = project_root / "public" / "data" / "sap"
    return str(default)


def load_olist_tables(
    data_dir: Optional[str] = None,
    tables: Optional[List[str]] = None,
) -> Dict[str, pd.DataFrame]:
    """
    Load Olist CSV tables into DataFrames with caching.

    Args:
        data_dir: Override data directory. Uses DATA_DIR env or default if None.
        tables: Specific table names to load. Loads all if None.

    Returns:
        Dict mapping table name -> DataFrame.
    """
    data_dir = data_dir or _resolve_data_dir()
    cache_key = data_dir

    # Return cached if still fresh
    if cache_key in _cache and (time.time() - _cache_ts.get(cache_key, 0)) < CACHE_TTL_SECONDS:
        cached = _cache[cache_key]
        if tables:
            return {k: v for k, v in cached.items() if k in tables}
        return cached

    # Load tables
    result: Dict[str, pd.DataFrame] = {}
    requested = tables or list(OLIST_TABLE_REGISTRY.keys())

    for table_name in requested:
        filename = OLIST_TABLE_REGISTRY.get(table_name)
        if not filename:
            logger.warning("Unknown table: %s", table_name)
            continue

        filepath = os.path.join(data_dir, filename)
        if not os.path.isfile(filepath):
            logger.warning("CSV not found: %s", filepath)
            continue

        try:
            df = pd.read_csv(filepath, low_memory=False)
            result[table_name] = df
            logger.info("Loaded %s: %d rows x %d cols", table_name, len(df), len(df.columns))
        except Exception as e:
            logger.error("Failed to load %s: %s", table_name, e)

    # Update cache (merge with existing if partial load)
    if cache_key in _cache and tables:
        _cache[cache_key].update(result)
    else:
        _cache[cache_key] = result
    _cache_ts[cache_key] = time.time()

    return result


def get_table_schemas(data_dir: Optional[str] = None) -> Dict[str, List[dict]]:
    """
    Return column metadata for all loaded tables.

    Returns:
        Dict mapping table name -> list of { name, dtype, sample, non_null_pct }.
    """
    tables = load_olist_tables(data_dir)
    schemas = {}

    for name, df in tables.items():
        cols = []
        for col in df.columns:
            sample_vals = df[col].dropna().head(3).tolist()
            non_null_pct = round((df[col].notna().sum() / len(df)) * 100, 1) if len(df) > 0 else 0
            cols.append({
                "name": col,
                "dtype": str(df[col].dtype),
                "sample": [str(v)[:80] for v in sample_vals],
                "non_null_pct": non_null_pct,
            })
        schemas[name] = {
            "columns": cols,
            "row_count": len(df),
        }

    return schemas


def get_table_summary(data_dir: Optional[str] = None) -> dict:
    """Return a lightweight summary suitable for LLM prompts."""
    schemas = get_table_schemas(data_dir)
    summary_lines = []
    total_rows = 0

    for name, info in schemas.items():
        col_names = [c["name"] for c in info["columns"]]
        row_count = info["row_count"]
        total_rows += row_count
        summary_lines.append(f"  - {name} ({row_count:,} rows): {', '.join(col_names)}")

    return {
        "source": "olist",
        "table_count": len(schemas),
        "total_rows": total_rows,
        "tables": summary_lines,
        "schemas": schemas,
    }


def invalidate_cache(data_dir: Optional[str] = None):
    """Force reload on next access."""
    key = data_dir or _resolve_data_dir()
    _cache.pop(key, None)
    _cache_ts.pop(key, None)
