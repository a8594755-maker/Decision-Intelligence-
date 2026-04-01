"""
variance_analyzer.py — Deterministic Variance Analysis Engine

Architecture mirrors kpi_calculator.py:
  LLM maps columns (JSON config) → VarianceAnalyzer executes deterministically

Calculators:
  1. waterfall_decomposition — Revenue delta = Volume effect + Price effect + Mix effect
  2. contribution_analysis  — Which dimension (region/product/customer) drove the delta
  3. driver_tree            — Hierarchical drill-down across multiple dimensions

Usage:
  from ml.api.variance_analyzer import execute_variance_pipeline

  result = execute_variance_pipeline(
      sheets_dict={"sales": [...]},
      call_llm_fn=your_llm_call,
      llm_config={"provider": "deepseek", "model": "deepseek-chat"},
  )
"""

import pandas as pd
import numpy as np
import re
import json


# ================================================================
# Part 1: PROFILER
# ================================================================

def profile_for_variance(sheets_dict):
    """
    Profile data for variance analysis. No LLM. ~20ms.
    Detects: metric columns, dimension columns, date/period columns, base vs current data.
    """
    result = {"sheets": {}, "variance_candidates": []}

    for sheet_name, data in sheets_dict.items():
        if not data:
            continue
        df = pd.DataFrame(data)
        sp = {"row_count": len(df), "columns": {}}

        numeric_cols = []
        date_cols = []
        dimension_cols = []
        period_cols = []

        for col in df.columns:
            series = df[col]
            non_null = series.dropna()
            if len(non_null) == 0:
                sp["columns"][col] = {"dtype": "empty"}
                continue

            # Numeric detection
            numeric = pd.to_numeric(non_null, errors="coerce")
            num_ratio = numeric.notna().sum() / max(len(non_null), 1)

            ci = {"null_pct": round(series.isnull().sum() / max(len(df), 1) * 100, 1)}

            if num_ratio > 0.7:
                ci["dtype"] = "numeric"
                valid = numeric.dropna()
                ci["stats"] = {
                    "min": round(float(valid.min()), 2),
                    "max": round(float(valid.max()), 2),
                    "mean": round(float(valid.mean()), 2),
                }
                ci["sample"] = [str(x) for x in non_null.head(3).tolist()]
                numeric_cols.append(col)
            elif series.nunique() <= 30 and series.nunique() >= 2:
                ci["dtype"] = "categorical"
                ci["unique_count"] = int(series.nunique())
                ci["values"] = sorted([str(v) for v in series.dropna().unique().tolist()])
                ci["sample"] = ci["values"][:5]
                # Check if this looks like a period column
                cl = col.lower()
                if any(kw in cl for kw in ["period", "month", "quarter", "year"]):
                    period_cols.append(col)
                    ci["role"] = "period"
                else:
                    dimension_cols.append(col)
                    ci["role"] = "dimension"
            else:
                # Try date parsing
                try:
                    parsed = pd.to_datetime(non_null, errors="coerce")
                    if parsed.notna().sum() / max(len(non_null), 1) > 0.7:
                        ci["dtype"] = "date"
                        ci["date_range"] = f"{parsed.min().strftime('%Y-%m-%d')} to {parsed.max().strftime('%Y-%m-%d')}"
                        date_cols.append(col)
                    else:
                        ci["dtype"] = "text"
                        ci["unique_count"] = int(series.nunique())
                        ci["sample"] = [str(x) for x in non_null.head(3).tolist()]
                        if series.nunique() <= 50:
                            dimension_cols.append(col)
                            ci["role"] = "dimension"
                except Exception:
                    ci["dtype"] = "text"
                    ci["sample"] = [str(x) for x in non_null.head(3).tolist()]

            sp["columns"][col] = ci

        sp["numeric_cols"] = numeric_cols
        sp["date_cols"] = date_cols
        sp["dimension_cols"] = dimension_cols
        sp["period_cols"] = period_cols
        result["sheets"][sheet_name] = sp

    # Suggest which sheets can do variance analysis
    for sn, sp in result["sheets"].items():
        if sp["numeric_cols"] and (sp["date_cols"] or sp["period_cols"]):
            result["variance_candidates"].append({
                "sheet": sn,
                "metrics": sp["numeric_cols"],
                "dimensions": sp["dimension_cols"],
                "periods": sp["period_cols"] or sp["date_cols"],
            })

    return result


def suggest_variance_calculators(profile):
    """Suggest which variance calculators are applicable."""
    has_candidates = bool(profile.get("variance_candidates"))
    has_numeric = any(sp.get("numeric_cols") for sp in profile.get("sheets", {}).values())
    has_dimensions = any(sp.get("dimension_cols") for sp in profile.get("sheets", {}).values())
    has_periods = any(sp.get("period_cols") or sp.get("date_cols")
                      for sp in profile.get("sheets", {}).values())

    # Count numeric cols to check for volume × price decomposition
    total_numeric = sum(len(sp.get("numeric_cols", [])) for sp in profile.get("sheets", {}).values())

    return [
        {
            "name": "waterfall_decomposition",
            "description": "Revenue delta = Volume effect + Price effect + Mix effect. Needs qty + price + revenue columns.",
            "available": total_numeric >= 2 and has_periods,
            "reason": "Found numeric + period columns" if (total_numeric >= 2 and has_periods) else "Need qty, price/revenue, and period columns",
        },
        {
            "name": "contribution_analysis",
            "description": "Which dimension (region/product/customer) contributed most to the period-over-period delta.",
            "available": has_dimensions and has_numeric and has_periods,
            "reason": "Found dimensions + metrics + periods" if has_dimensions else "Need dimension + metric + period columns",
        },
        {
            "name": "driver_tree",
            "description": "Hierarchical drill-down: total delta → by region → by product → by customer.",
            "available": has_dimensions and has_numeric and has_periods and sum(
                len(sp.get("dimension_cols", [])) for sp in profile.get("sheets", {}).values()) >= 2,
            "reason": "Found 2+ dimensions for drill-down" if has_dimensions else "Need multiple dimension columns",
        },
    ]


# ================================================================
# Part 2: LLM PROMPT BUILDER
# ================================================================

SUPPORTED_ANALYZERS = {
    "waterfall_decomposition": {
        "description": "Decompose revenue/metric change into Volume effect + Price effect + Mix effect. Uses the formula: Total Delta = Volume Effect + Price Effect + Mix Effect, where Volume Effect = (Q_curr - Q_base) * P_base, Price Effect = (P_curr - P_base) * Q_base, Mix Effect = Total Delta - Volume - Price.",
        "params": {
            "source_sheet": "str — sheet with transaction data",
            "date_col": "str — date column (to derive periods)",
            "period_col": "str — period column if already exists (e.g., 'month'). Either date_col or period_col required.",
            "mode": "str — 'MoM' (month-over-month), 'QoQ', 'YoY'. Auto-detects latest period.",
            "current_period": "str — explicit current period (optional if mode is set)",
            "base_period": "str — explicit base period (optional if mode is set)",
            "revenue_col": "str — total revenue/amount column",
            "volume_col": "str — quantity/volume column (optional — if missing, falls back to contribution analysis by dimension)",
            "price_col": "str — unit price column (optional, can be derived as revenue/volume)",
            "dimension_col": "str — product/SKU/category to decompose by (required for volume/price/mix split)",
            "currency_col": "str — currency column (optional, splits by currency if multi-currency)",
        },
    },
    "contribution_analysis": {
        "description": "For each dimension value (region, product, customer), calculate its contribution to the total period-over-period delta. Shows: base value, current value, delta, contribution% (delta / total_delta * 100).",
        "params": {
            "source_sheet": "str",
            "date_col": "str — date column",
            "period_col": "str — period column (alternative to date_col)",
            "mode": "str — 'MoM', 'QoQ', 'YoY'",
            "metric_col": "str — the metric to analyze (e.g., revenue, qty, mrr)",
            "dimension_col": "str — dimension to break down by (e.g., region, product, customer)",
            "top_n": "int — show top N contributors (default all)",
            "currency_col": "str — optional",
        },
    },
    "driver_tree": {
        "description": "Hierarchical drill-down across multiple dimensions. Level 1: total delta. Level 2: by first dimension. Level 3: by second dimension within each Level 2 group. Shows which sub-segments drove the change.",
        "params": {
            "source_sheet": "str",
            "date_col": "str",
            "period_col": "str",
            "mode": "str — 'MoM', 'QoQ', 'YoY'",
            "metric_col": "str — metric to analyze",
            "dimensions": "list[str] — dimensions in drill-down order, e.g., ['region', 'product_category', 'customer']. First dimension is top-level.",
            "currency_col": "str — optional",
        },
    },
}


# ================================================================
# Part 2b: AUTO-DETECT VARIANCE CONFIG (replaces LLM call, ~0ms)
# ================================================================

# Keywords for role detection on column names
_REVENUE_KW = {"revenue", "amount", "total_amount", "sales", "total", "subtotal", "net_sales", "gross_sales"}
_QTY_KW = {"qty", "quantity", "units", "volume", "count", "units_sold", "order_qty"}
_PRICE_KW = {"price", "unit_price", "selling_price", "avg_price"}


def _guess_metric_role(col_name):
    """Guess whether a numeric column is revenue, quantity, or price."""
    cl = col_name.lower().strip()
    for kw in _REVENUE_KW:
        if kw in cl:
            return "revenue"
    for kw in _QTY_KW:
        if kw in cl:
            return "quantity"
    for kw in _PRICE_KW:
        if kw in cl:
            return "price"
    return "numeric"


def build_variance_config_from_profile(profile: dict) -> dict:
    """
    Build variance analysis config deterministically from profile.
    Returns {"analyses": [...]} in the same format LLM was producing.
    """
    analyses = []

    for cand in profile.get("variance_candidates", []):
        sheet_name = cand["sheet"]
        metrics = cand.get("metrics", [])
        dimensions = cand.get("dimensions", [])
        periods = cand.get("periods", [])

        if not metrics or not periods:
            continue

        period_col = periods[0]
        sp = profile["sheets"].get(sheet_name, {})

        # Classify numeric columns
        revenue_col = None
        qty_col = None
        price_col = None
        for mc in metrics:
            role = _guess_metric_role(mc)
            if role == "revenue" and not revenue_col:
                revenue_col = mc
            elif role == "quantity" and not qty_col:
                qty_col = mc
            elif role == "price" and not price_col:
                price_col = mc

        # Fallback: use first numeric as metric
        metric_col = revenue_col or metrics[0]

        # Is the period column a date or categorical period?
        col_info = sp.get("columns", {}).get(period_col, {})
        is_date = col_info.get("dtype") == "date"
        period_param = {"date_col": period_col} if is_date else {"period_col": period_col}
        mode = "MoM"

        # 1. Waterfall Decomposition (needs qty or price + a dimension)
        if (qty_col or price_col) and dimensions:
            wf_params = {
                "source_sheet": sheet_name,
                "revenue_col": metric_col,
                "dimension_col": dimensions[0],
                "mode": mode,
                **period_param,
            }
            if qty_col:
                wf_params["volume_col"] = qty_col
            if price_col:
                wf_params["price_col"] = price_col
            analyses.append({
                "analyzer": "waterfall_decomposition",
                "params": wf_params,
                "label": f"{sheet_name} — Waterfall Decomposition",
            })

        # 2. Contribution Analysis (one per dimension)
        for dim in dimensions[:3]:
            analyses.append({
                "analyzer": "contribution_analysis",
                "params": {
                    "source_sheet": sheet_name,
                    "metric_col": metric_col,
                    "dimension_col": dim,
                    "mode": mode,
                    **period_param,
                },
                "label": f"{sheet_name} — Contribution by {dim}",
            })

        # 3. Driver Tree (needs 2+ dimensions)
        if len(dimensions) >= 2:
            analyses.append({
                "analyzer": "driver_tree",
                "params": {
                    "source_sheet": sheet_name,
                    "metric_col": metric_col,
                    "dimensions": dimensions[:3],
                    "mode": mode,
                    **period_param,
                },
                "label": f"{sheet_name} — Driver Tree",
            })

    return {"analyses": analyses} if analyses else None


def build_variance_prompt(profile, selected_analyzers=None):
    """Build LLM prompt for variance analysis config. Returns (system, user)."""
    analyzers = SUPPORTED_ANALYZERS
    if selected_analyzers:
        analyzers = {k: v for k, v in SUPPORTED_ANALYZERS.items() if k in selected_analyzers}

    calc_desc = "\n".join(
        f"  {name}:\n    {info['description']}\n    params: {json.dumps(info['params'], indent=6)}"
        for name, info in analyzers.items()
    )

    system_prompt = f"""You are a financial analyst configuring variance analysis calculations.
You receive a data profile and return a JSON config telling the variance engine what to analyze.

AVAILABLE ANALYZERS:
{calc_desc}

RESPONSE FORMAT — return ONLY valid JSON:
{{
  "analyses": [
    {{
      "analyzer": "analyzer_name",
      "params": {{...analyzer-specific params...}},
      "label": "Human-readable label"
    }},
    ...
  ]
}}

RULES:
1. Use ONLY analyzers from the list above.
2. Map column names EXACTLY as they appear in the data profile.
3. For waterfall_decomposition: needs a dimension_col (product/SKU) to decompose by. The volume_col should be quantity, price_col should be unit price. If only revenue exists without qty/price, skip waterfall — use contribution_analysis instead.
4. For contribution_analysis: create one entry per useful dimension (region, product, customer, channel, etc.).
5. For driver_tree: order dimensions from broadest to narrowest (region → category → product).
6. Prefer mode="MoM" for auto-detection. Only use explicit periods if the data has non-standard period columns.
7. MULTI-CURRENCY: set currency_col if multiple currencies exist.
8. If a sheet has both date_col and period_col, prefer period_col (already aggregated).

RESPOND WITH ONLY VALID JSON."""

    user_prompt = "## Data Profile for Variance Analysis\n\n"
    for sheet_name, sp in profile["sheets"].items():
        user_prompt += f"### Sheet: {sheet_name} ({sp['row_count']} rows)\n"
        if sp.get("numeric_cols"):
            user_prompt += f"  Numeric columns: {sp['numeric_cols']}\n"
        if sp.get("dimension_cols"):
            user_prompt += f"  Dimension columns: {sp['dimension_cols']}\n"
        if sp.get("period_cols"):
            user_prompt += f"  Period columns: {sp['period_cols']}\n"
        if sp.get("date_cols"):
            user_prompt += f"  Date columns: {sp['date_cols']}\n"
        user_prompt += "  Column details:\n"
        for col_name, ci in sp["columns"].items():
            parts = [f"dtype={ci.get('dtype', '?')}"]
            if ci.get("role"):
                parts.append(f"role={ci['role']}")
            if ci.get("stats"):
                parts.append(f"range=[{ci['stats']['min']}..{ci['stats']['max']}]")
            if ci.get("values"):
                parts.append(f"values={ci['values'][:8]}")
            elif ci.get("sample"):
                parts.append(f"sample={ci['sample'][:3]}")
            if ci.get("date_range"):
                parts.append(f"range={ci['date_range']}")
            user_prompt += f"    {col_name}: {', '.join(parts)}\n"
        user_prompt += "\n"

    if profile.get("variance_candidates"):
        user_prompt += "### Variance Analysis Candidates\n"
        for vc in profile["variance_candidates"]:
            user_prompt += f"  {vc['sheet']}: metrics={vc['metrics']}, dimensions={vc['dimensions']}, periods={vc['periods']}\n"

    return system_prompt, user_prompt


# ================================================================
# Part 3: VARIANCE ANALYZER ENGINE
# ================================================================

class VarianceAnalyzer:
    """Deterministic variance analysis engine."""

    def __init__(self, sheets):
        # Force numeric dtype coercion (defense against object columns)
        self.sheets = {}
        for name, df in sheets.items():
            df = df.copy()
            for col in df.columns:
                if pd.api.types.is_string_dtype(df[col]) or df[col].dtype == object:
                    coerced = pd.to_numeric(df[col], errors="coerce")
                    non_null = df[col].dropna()
                    if len(non_null) > 0 and coerced.notna().sum() / len(non_null) > 0.5:
                        df[col] = coerced
            self.sheets[name] = df
        self.log = []
        self.result_summary = {}

    def analyze(self, config):
        """Execute all analyses from LLM config."""
        analyses = config.get("analyses", [])
        all_artifacts = []
        used_labels = set()

        for analysis in analyses:
            name = analysis.get("analyzer")
            if name not in SUPPORTED_ANALYZERS:
                self.log.append({"action": "skip_unknown", "analyzer": name})
                continue

            handler = getattr(self, f"_analyze_{name}", None)
            if not handler:
                self.log.append({"action": "skip_no_handler", "analyzer": name})
                continue

            try:
                label = analysis.get("label", name)
                params = analysis.get("params", {})
                artifacts = handler(params, label)
                for a in artifacts:
                    base = a["label"]
                    lbl = base
                    i = 2
                    while lbl in used_labels:
                        lbl = f"{base} ({i})"
                        i += 1
                    a["label"] = lbl
                    used_labels.add(lbl)
                all_artifacts.extend(artifacts)
                self.log.append({"action": "analyzed", "analyzer": name, "label": label,
                                 "artifacts": len(artifacts), "params_used": params})
            except Exception as e:
                self.log.append({"action": "error", "analyzer": name, "error": str(e)[:300]})

        # Column mapping metadata
        mapping_rows = []
        for a in analyses:
            p = a.get("params", {})
            row = {"analyzer": a.get("analyzer", ""), "label": a.get("label", "")}
            for key in ["source_sheet", "metric_col", "revenue_col", "volume_col", "price_col",
                         "dimension_col", "dimensions", "date_col", "period_col", "mode", "currency_col"]:
                if key in p:
                    row[key] = str(p[key])
            mapping_rows.append(row)
        if mapping_rows:
            all_artifacts.append({"type": "table", "label": "Column Mapping (verify)", "data": mapping_rows})

        # Build summary for narrative
        summary_lines = []
        for a in all_artifacts[:15]:
            if a.get("label", "").startswith("Column Mapping"):
                continue
            data = a.get("data", [])
            if not data:
                continue
            if "Waterfall Summary" in a.get("label", ""):
                for row in data:
                    summary_lines.append(f"{row.get('component', '')}: {row.get('value', '')} ({row.get('pct_of_total', '')}%)")
            elif "Contribution" in a.get("label", "") or "Drill-down" in a.get("label", ""):
                top3 = data[:3]
                for row in top3:
                    dim_key = [v for k, v in row.items() if k not in ("base", "current", "delta", "contribution_pct", "delta_pct")][0] if row else ""
                    summary_lines.append(f"  {dim_key}: delta={row.get('delta', '')}, contribution={row.get('contribution_pct', '')}%")
            elif "Total Delta" in a.get("label", ""):
                for row in data:
                    summary_lines.append(f"Total delta: {row.get('delta', '')} ({row.get('delta_pct', '')}%)")

        return {
            "result": self.result_summary,
            "artifacts": all_artifacts,
            "summary_for_narrative": "\n".join(summary_lines[:10]),
        }

    # -- Helpers --

    def _get_sheet(self, name):
        if name not in self.sheets:
            raise ValueError(f"Sheet '{name}' not found. Available: {list(self.sheets.keys())}")
        return self.sheets[name]

    def _to_numeric(self, series):
        return pd.to_numeric(series, errors="coerce")

    def _safe_div(self, a, b):
        if b == 0 or pd.isna(b):
            return None
        return a / b

    def _nan_safe_records(self, df):
        return df.where(df.notna(), None).to_dict("records")

    def _resolve_periods(self, df, params):
        """Resolve base and current periods. Returns (df_with_period_col, period_col, current, base)."""
        date_col = params.get("date_col")
        period_col = params.get("period_col")
        mode = params.get("mode", "MoM")
        current = params.get("current_period")
        base = params.get("base_period")

        df = df.copy()

        if period_col and period_col in df.columns:
            # Use existing period column
            pass
        elif date_col and date_col in df.columns:
            dates = pd.to_datetime(df[date_col], errors="coerce")
            if mode == "MoM":
                df["_period"] = dates.dt.strftime("%Y-%m")
            elif mode == "QoQ":
                df["_period"] = dates.apply(
                    lambda d: f"{d.year}-Q{(d.month - 1) // 3 + 1}" if pd.notna(d) else None)
            elif mode == "YoY":
                df["_period"] = dates.dt.strftime("%Y")
            else:
                df["_period"] = dates.dt.strftime("%Y-%m")
            period_col = "_period"
        else:
            raise ValueError("Need either date_col or period_col")

        # Auto-detect current and base if not provided
        periods_sorted = sorted(df[period_col].dropna().unique())
        if not current:
            current = periods_sorted[-1] if periods_sorted else None
        if not base:
            if mode == "YoY" and current:
                # Find same period last year
                try:
                    curr_year = int(current[:4])
                    base = str(curr_year - 1) + current[4:]
                except Exception:
                    base = periods_sorted[-2] if len(periods_sorted) >= 2 else None
            else:
                idx = periods_sorted.index(current) if current in periods_sorted else -1
                base = periods_sorted[idx - 1] if idx > 0 else None

        if not current or not base:
            raise ValueError(f"Cannot determine periods. Available: {periods_sorted}")

        return df, period_col, str(current), str(base)

    # -- Analyzer implementations --

    def _analyze_waterfall_decomposition(self, params, label):
        """
        Waterfall decomposition: Total Delta = Volume Effect + Price Effect + Mix Effect

        For each product/dimension:
          Volume Effect = (Q_curr - Q_base) * P_base
          Price Effect  = (P_curr - P_base) * Q_base
          Mix Effect    = Total - Volume - Price  (interaction term)

        Fallback: if volume_col is missing, degrades to contribution_analysis by dimension.
        """
        df = self._get_sheet(params["source_sheet"])
        revenue_col = params["revenue_col"]
        volume_col = params.get("volume_col")
        price_col = params.get("price_col")
        dimension_col = params["dimension_col"]
        currency_col = params.get("currency_col")

        # Fallback: no qty/price → degrade to contribution by dimension
        if not volume_col or volume_col not in df.columns:
            self.log.append({
                "action": "fallback", "analyzer": "waterfall_decomposition",
                "message": f"No volume column '{volume_col}' found. Falling back to contribution analysis by {dimension_col}.",
            })
            return self._analyze_contribution_analysis({
                **params,
                "metric_col": revenue_col,
                "dimension_col": dimension_col,
            }, f"{label} (total delta by {dimension_col})")

        df, period_col, current, base = self._resolve_periods(df, params)

        df[revenue_col] = self._to_numeric(df[revenue_col])
        df[volume_col] = self._to_numeric(df[volume_col])

        # Derive price if not provided
        if price_col and price_col in df.columns:
            df[price_col] = self._to_numeric(df[price_col])
        else:
            price_col = "_derived_price"
            df[price_col] = df[revenue_col] / df[volume_col].clip(lower=0.01)

        multi_currency = currency_col and currency_col in df.columns and df[currency_col].nunique() > 1

        def _waterfall_for(sub_df, suffix=""):
            # Aggregate by dimension for each period
            group_keys = [dimension_col]
            base_data = sub_df[sub_df[period_col].astype(str) == base]
            curr_data = sub_df[sub_df[period_col].astype(str) == current]

            base_agg = base_data.groupby(group_keys).agg(
                q_base=(volume_col, "sum"),
                rev_base=(revenue_col, "sum"),
            ).reset_index()
            base_agg["p_base"] = base_agg["rev_base"] / base_agg["q_base"].clip(lower=0.01)

            curr_agg = curr_data.groupby(group_keys).agg(
                q_curr=(volume_col, "sum"),
                rev_curr=(revenue_col, "sum"),
            ).reset_index()
            curr_agg["p_curr"] = curr_agg["rev_curr"] / curr_agg["q_curr"].clip(lower=0.01)

            merged = base_agg.merge(curr_agg, on=group_keys, how="outer").fillna(0)

            # Decomposition per dimension
            merged["total_delta"] = (merged["rev_curr"] - merged["rev_base"]).round(2)
            merged["volume_effect"] = ((merged["q_curr"] - merged["q_base"]) * merged["p_base"]).round(2)
            merged["price_effect"] = ((merged["p_curr"] - merged["p_base"]) * merged["q_base"]).round(2)
            merged["mix_effect"] = (merged["total_delta"] - merged["volume_effect"] - merged["price_effect"]).round(2)

            # Round all
            for c in ["q_base", "q_curr", "rev_base", "rev_curr", "p_base", "p_curr"]:
                merged[c] = merged[c].round(2)

            detail = merged.sort_values("total_delta", key=abs, ascending=False)

            # Summary row
            totals = {
                "component": ["Total Delta", "Volume Effect", "Price Effect", "Mix Effect"],
                "value": [
                    round(float(detail["total_delta"].sum()), 2),
                    round(float(detail["volume_effect"].sum()), 2),
                    round(float(detail["price_effect"].sum()), 2),
                    round(float(detail["mix_effect"].sum()), 2),
                ],
            }
            summary_df = pd.DataFrame(totals)
            total_delta = float(detail["total_delta"].sum())
            summary_df["pct_of_total"] = summary_df["value"].apply(
                lambda v: round(self._safe_div(v, total_delta) * 100, 1) if total_delta else None
            )

            return [
                {"type": "table", "label": f"Waterfall Summary ({base} → {current}){suffix}",
                 "data": self._nan_safe_records(summary_df)},
                {"type": "table", "label": f"Waterfall Detail by {dimension_col}{suffix}",
                 "data": self._nan_safe_records(detail)},
            ]

        if multi_currency:
            artifacts = []
            for cur in sorted(df[currency_col].dropna().unique()):
                artifacts.extend(_waterfall_for(df[df[currency_col] == cur], f" ({cur})"))
            return artifacts
        else:
            return _waterfall_for(df)

    def _analyze_contribution_analysis(self, params, label):
        """
        For each value in dimension_col, show base, current, delta, contribution%.
        contribution% = this_entity_delta / total_delta * 100
        """
        df = self._get_sheet(params["source_sheet"])
        metric_col = params["metric_col"]
        dimension_col = params["dimension_col"]
        top_n = params.get("top_n")
        currency_col = params.get("currency_col")

        df, period_col, current, base = self._resolve_periods(df, params)
        df[metric_col] = self._to_numeric(df[metric_col])

        multi_currency = currency_col and currency_col in df.columns and df[currency_col].nunique() > 1

        def _contrib_for(sub_df, suffix=""):
            base_data = sub_df[sub_df[period_col].astype(str) == base]
            curr_data = sub_df[sub_df[period_col].astype(str) == current]

            base_agg = base_data.groupby(dimension_col)[metric_col].sum().reset_index().rename(
                columns={metric_col: "base"})
            curr_agg = curr_data.groupby(dimension_col)[metric_col].sum().reset_index().rename(
                columns={metric_col: "current"})

            merged = base_agg.merge(curr_agg, on=dimension_col, how="outer").fillna(0)
            merged["delta"] = (merged["current"] - merged["base"]).round(2)
            total_delta = float(merged["delta"].sum())
            merged["contribution_pct"] = merged["delta"].apply(
                lambda d: round(self._safe_div(d, total_delta) * 100, 1) if total_delta else None
            )
            merged["delta_pct"] = merged.apply(
                lambda r: round(self._safe_div(r["delta"], abs(r["base"])) * 100, 1) if r["base"] else None, axis=1
            )
            merged["base"] = merged["base"].round(2)
            merged["current"] = merged["current"].round(2)

            merged = merged.sort_values("delta", key=abs, ascending=False)
            if top_n:
                merged = merged.head(top_n)

            return [{"type": "table",
                      "label": f"{label} — {metric_col} by {dimension_col} ({base}→{current}){suffix}",
                      "data": self._nan_safe_records(merged)}]

        if multi_currency:
            artifacts = []
            for cur in sorted(df[currency_col].dropna().unique()):
                artifacts.extend(_contrib_for(df[df[currency_col] == cur], f" ({cur})"))
            return artifacts
        else:
            return _contrib_for(df)

    def _analyze_driver_tree(self, params, label):
        """
        Hierarchical drill-down across multiple dimensions.
        Level 0: Total delta
        Level 1: Delta by dimensions[0]
        Level 2: Delta by dimensions[0] × dimensions[1]
        ...
        """
        df = self._get_sheet(params["source_sheet"])
        metric_col = params["metric_col"]
        dimensions = params["dimensions"]
        currency_col = params.get("currency_col")

        df, period_col, current, base = self._resolve_periods(df, params)
        df[metric_col] = self._to_numeric(df[metric_col])

        multi_currency = currency_col and currency_col in df.columns and df[currency_col].nunique() > 1

        def _tree_for(sub_df, suffix=""):
            base_data = sub_df[sub_df[period_col].astype(str) == base]
            curr_data = sub_df[sub_df[period_col].astype(str) == current]

            artifacts = []

            # Level 0: Total
            base_total = float(self._to_numeric(base_data[metric_col]).sum())
            curr_total = float(self._to_numeric(curr_data[metric_col]).sum())
            total_delta = curr_total - base_total
            total_pct = self._safe_div(total_delta, abs(base_total)) * 100 if base_total else None

            self.result_summary[f"total_delta_{metric_col}"] = round(total_delta, 2)

            artifacts.append({"type": "table", "label": f"Total Delta ({base}→{current}){suffix}", "data": [{
                "metric": metric_col,
                "base_period": base,
                "current_period": current,
                "base_value": round(base_total, 2),
                "current_value": round(curr_total, 2),
                "delta": round(total_delta, 2),
                "delta_pct": round(total_pct, 1) if total_pct is not None else None,
            }]})

            # Each drill-down level
            for depth in range(len(dimensions)):
                group_dims = dimensions[:depth + 1]
                valid_dims = [d for d in group_dims if d in base_data.columns and d in curr_data.columns]
                if not valid_dims:
                    continue

                b_agg = base_data.groupby(valid_dims)[metric_col].sum().reset_index().rename(
                    columns={metric_col: "base"})
                c_agg = curr_data.groupby(valid_dims)[metric_col].sum().reset_index().rename(
                    columns={metric_col: "current"})
                merged = b_agg.merge(c_agg, on=valid_dims, how="outer").fillna(0)
                merged["delta"] = (merged["current"] - merged["base"]).round(2)
                merged["contribution_pct"] = merged["delta"].apply(
                    lambda d: round(self._safe_div(d, total_delta) * 100, 1) if total_delta else None
                )
                merged["delta_pct"] = merged.apply(
                    lambda r: round(self._safe_div(r["delta"], abs(r["base"])) * 100, 1) if r["base"] else None,
                    axis=1
                )
                merged["base"] = merged["base"].round(2)
                merged["current"] = merged["current"].round(2)
                merged = merged.sort_values("delta", key=abs, ascending=False)

                level_label = " × ".join(valid_dims)
                artifacts.append({
                    "type": "table",
                    "label": f"Drill-down: {level_label}{suffix}",
                    "data": self._nan_safe_records(merged),
                })

            return artifacts

        if multi_currency:
            artifacts = []
            for cur in sorted(df[currency_col].dropna().unique()):
                artifacts.extend(_tree_for(df[df[currency_col] == cur], f" ({cur})"))
            return artifacts
        else:
            return _tree_for(df)

    def get_log(self):
        return self.log


# ================================================================
# Part 4: PIPELINE ENTRY POINT
# ================================================================

def execute_variance_pipeline(sheets_dict, call_llm_fn=None, llm_config=None):
    """
    Full variance analysis pipeline.

    Returns:
        {
            "result": {summary},
            "artifacts": [{type, label, data}],
            "profile": {...},
            "config": {...},
        }
    """
    profile = profile_for_variance(sheets_dict)

    # Stage 1: Deterministic config from profile (~0ms)
    config = build_variance_config_from_profile(profile)

    # Stage 1b: LLM fallback ONLY if auto-detect produced nothing
    if not config and call_llm_fn:
        sys_prompt, usr_prompt = build_variance_prompt(profile)
        for attempt in range(3):
            try:
                raw = call_llm_fn(sys_prompt, usr_prompt, llm_config)
                raw = raw.strip()
                s = raw.find("{")
                e = raw.rfind("}")
                if s != -1 and e != -1:
                    raw = raw[s:e + 1]
                raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                raw = re.sub(r"\s*```$", "", raw.strip())
                config = json.loads(raw)
                break
            except (json.JSONDecodeError, Exception):
                if attempt == 2:
                    config = None

    if not config:
        return {
            "result": {},
            "artifacts": [],
            "profile": profile,
            "config": None,
            "error": "Failed to build variance config (auto-detect and LLM both failed)",
        }

    dfs = {name: pd.DataFrame(data) for name, data in sheets_dict.items() if data}
    analyzer = VarianceAnalyzer(dfs)
    result = analyzer.analyze(config)

    return {
        "result": result["result"],
        "artifacts": result["artifacts"],
        "profile": profile,
        "config": config,
        "log": analyzer.get_log(),
    }
