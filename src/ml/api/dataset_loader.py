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
    _profile_cache.pop(key, None)
    _profile_cache_ts.pop(key, None)


# ---------------------------------------------------------------------------
# Data Profiling
# ---------------------------------------------------------------------------

_profile_cache: Dict[str, dict] = {}
_profile_cache_ts: Dict[str, float] = {}


def _profile_column(series: pd.Series) -> dict:
    """Compute detailed stats for a single column."""
    total = len(series)
    info = {
        "dtype": str(series.dtype),
        "null_pct": round(float(series.isna().sum() / total * 100), 1) if total > 0 else 0.0,
        "cardinality": int(series.nunique()),
        "sample_values": [str(v)[:80] for v in series.dropna().head(3).tolist()],
    }

    # Numeric columns: descriptive stats
    if series.dtype in ("int64", "float64"):
        desc = series.dropna().describe()
        info.update({
            "min": float(desc.get("min", 0)),
            "max": float(desc.get("max", 0)),
            "mean": round(float(desc.get("mean", 0)), 2),
            "median": round(float(desc.get("50%", 0)), 2),
            "std": round(float(desc.get("std", 0)), 2),
        })

    # Low-cardinality columns: top value distribution
    if info["cardinality"] < 50:
        vc = series.dropna().value_counts(normalize=True).head(10)
        info["top_values"] = {str(k): round(float(v * 100), 1) for k, v in vc.items()}

    # Semantic type inference
    col_name = series.name.lower() if series.name else ""
    if col_name.endswith("_id"):
        info["semantic"] = "identifier"
    elif any(kw in col_name for kw in ("date", "timestamp", "time", "_at")):
        info["semantic"] = "temporal"
    elif info["cardinality"] < 20:
        info["semantic"] = "categorical"
    elif series.dtype == "float64":
        info["semantic"] = "measure"
    elif series.dtype == "object" and info["cardinality"] > 100:
        info["semantic"] = "text"

    return info


def _detect_relationships(tables: Dict[str, pd.DataFrame]) -> list:
    """Detect FK relationships by matching _id columns across tables."""
    # Collect all _id columns per table
    id_columns: Dict[str, list] = {}
    for tname, df in tables.items():
        for col in df.columns:
            if col.endswith("_id"):
                id_columns.setdefault(col, []).append(tname)

    relationships = []
    for col, table_list in id_columns.items():
        if len(table_list) < 2:
            continue

        # Find parent: the table where the column is most unique (likely PK)
        # Pick the table with highest uniqueness ratio as the parent
        uniqueness = {t: tables[t][col].nunique() / max(len(tables[t]), 1) for t in table_list}
        parent = max(table_list, key=lambda t: uniqueness[t])

        # Only treat as PK if uniqueness >= 95%
        if uniqueness[parent] < 0.95:
            continue

        parent_set = set(tables[parent][col].dropna())
        for child in table_list:
            if child == parent:
                continue
            child_series = tables[child][col].dropna()
            if len(child_series) == 0:
                continue
            match_pct = round(float(child_series.isin(parent_set).mean() * 100), 1)
            relationships.append({
                "child": child,
                "parent": parent,
                "column": col,
                "match_pct": match_pct,
            })

    return relationships


def generate_data_profile(data_dir: Optional[str] = None) -> dict:
    """
    Generate comprehensive profile for all loaded tables.

    Includes per-column stats, FK relationships, and semantic type inference.
    Results are cached with the same TTL as table data.
    """
    data_dir = data_dir or _resolve_data_dir()

    # Return cached if fresh
    if data_dir in _profile_cache and \
       (time.time() - _profile_cache_ts.get(data_dir, 0)) < CACHE_TTL_SECONDS:
        return _profile_cache[data_dir]

    tables = load_olist_tables(data_dir)
    profile: dict = {
        "tables": {},
        "relationships": [],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    total_rows = 0
    date_min, date_max = None, None

    for name, df in tables.items():
        table_profile = {
            "row_count": len(df),
            "duplicate_rows": int(df.duplicated().sum()),
            "columns": {},
        }
        for col in df.columns:
            table_profile["columns"][col] = _profile_column(df[col])

            # Track overall date range
            if "date" in col.lower() or "timestamp" in col.lower():
                try:
                    parsed = pd.to_datetime(df[col], errors="coerce").dropna()
                    if len(parsed) > 0:
                        col_min, col_max = parsed.min(), parsed.max()
                        if date_min is None or col_min < date_min:
                            date_min = col_min
                        if date_max is None or col_max > date_max:
                            date_max = col_max
                except Exception:
                    pass

        total_rows += len(df)
        profile["tables"][name] = table_profile

    profile["relationships"] = _detect_relationships(tables)
    profile["total_rows"] = total_rows
    profile["table_count"] = len(profile["tables"])

    if date_min and date_max:
        profile["date_range"] = {
            "min": date_min.strftime("%Y-%m-%d"),
            "max": date_max.strftime("%Y-%m-%d"),
        }

    # Cache
    _profile_cache[data_dir] = profile
    _profile_cache_ts[data_dir] = time.time()

    logger.info(
        "Data profile generated: %d tables, %d total rows, %d relationships",
        profile["table_count"], total_rows, len(profile["relationships"]),
    )
    return profile
