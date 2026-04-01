"""
anomaly_engine.py — Deterministic Anomaly Detection Engine

Architecture mirrors kpi_calculator.py / variance_analyzer.py:
  LLM maps columns (JSON config) → AnomalyDetector executes deterministically

Detectors:
  1. zscore_outlier      — Flag rows where a metric's z-score > threshold
  2. iqr_outlier         — Flag rows outside IQR fences
  3. trend_anomaly       — Detect trend breaks (consecutive decline/surge, rolling deviation)
  4. cross_dimension     — Find dimensions where metric deviates from group average

Usage:
  from ml.api.anomaly_engine import execute_anomaly_pipeline
"""

import pandas as pd
import numpy as np
import re
import json


# ================================================================
# Part 1: PROFILER
# ================================================================

def profile_for_anomaly(sheets_dict):
    """Profile data for anomaly detection. No LLM. ~20ms."""
    result = {"sheets": {}, "anomaly_candidates": []}

    for sheet_name, data in sheets_dict.items():
        if not data:
            continue
        df = pd.DataFrame(data)
        sp = {"row_count": len(df), "columns": {}}

        numeric_cols = []
        date_cols = []
        dimension_cols = []

        for col in df.columns:
            series = df[col]
            non_null = series.dropna()
            if len(non_null) == 0:
                sp["columns"][col] = {"dtype": "empty"}
                continue

            ci = {"null_pct": round(series.isnull().sum() / max(len(df), 1) * 100, 1)}

            numeric = pd.to_numeric(non_null, errors="coerce")
            num_ratio = numeric.notna().sum() / max(len(non_null), 1)

            if num_ratio > 0.7:
                ci["dtype"] = "numeric"
                valid = numeric.dropna()
                ci["stats"] = {
                    "min": round(float(valid.min()), 2),
                    "max": round(float(valid.max()), 2),
                    "mean": round(float(valid.mean()), 2),
                    "std": round(float(valid.std()), 2) if len(valid) > 1 else 0,
                }
                ci["sample"] = [str(x) for x in non_null.head(3).tolist()]
                numeric_cols.append(col)
            elif series.nunique() <= 30 and series.nunique() >= 2:
                # Check if this is a period column (YYYY-MM, YYYY-QN, etc.)
                str_vals = non_null.astype(str)
                period_ratio = str_vals.str.match(r'^\d{4}-\d{2}$|^\d{4}-Q[1-4]$', na=False).sum() / max(len(str_vals), 1)
                if period_ratio > 0.7:
                    ci["dtype"] = "date"
                    ci["unique_count"] = int(series.nunique())
                    ci["values"] = sorted([str(v) for v in series.dropna().unique().tolist()])
                    date_cols.append(col)
                else:
                    ci["dtype"] = "categorical"
                    ci["unique_count"] = int(series.nunique())
                    ci["values"] = sorted([str(v) for v in series.dropna().unique().tolist()])
                    dimension_cols.append(col)
            else:
                try:
                    parsed = pd.to_datetime(non_null, errors="coerce")
                    if parsed.notna().sum() / max(len(non_null), 1) > 0.7:
                        ci["dtype"] = "date"
                        ci["date_range"] = f"{parsed.min().strftime('%Y-%m-%d')} to {parsed.max().strftime('%Y-%m-%d')}"
                        date_cols.append(col)
                    else:
                        ci["dtype"] = "text"
                        ci["sample"] = [str(x) for x in non_null.head(3).tolist()]
                        if series.nunique() <= 50:
                            dimension_cols.append(col)
                except Exception:
                    ci["dtype"] = "text"

            sp["columns"][col] = ci

        sp["numeric_cols"] = numeric_cols
        sp["date_cols"] = date_cols
        sp["dimension_cols"] = dimension_cols
        result["sheets"][sheet_name] = sp

        if numeric_cols:
            result["anomaly_candidates"].append({
                "sheet": sheet_name,
                "metrics": numeric_cols,
                "dimensions": dimension_cols,
                "dates": date_cols,
            })

    return result


def suggest_anomaly_detectors(profile):
    """Suggest which detectors are applicable."""
    has_numeric = any(sp.get("numeric_cols") for sp in profile.get("sheets", {}).values())
    has_dates = any(sp.get("date_cols") for sp in profile.get("sheets", {}).values())
    has_dims = any(sp.get("dimension_cols") for sp in profile.get("sheets", {}).values())
    total_rows = sum(sp.get("row_count", 0) for sp in profile.get("sheets", {}).values())

    total_numeric = sum(len(sp.get("numeric_cols", [])) for sp in profile.get("sheets", {}).values())

    return [
        {
            "name": "zscore_outlier",
            "description": "Flag rows where z-score > threshold (default 3).",
            "available": has_numeric and total_rows >= 5,
            "reason": "Found numeric columns" if has_numeric else "Need numeric columns",
        },
        {
            "name": "iqr_outlier",
            "description": "Flag rows outside IQR fences. More robust for skewed data.",
            "available": has_numeric and total_rows >= 5,
            "reason": "Found numeric columns" if has_numeric else "Need numeric columns",
        },
        {
            "name": "negative_values",
            "description": "Flag negative values in numeric columns.",
            "available": has_numeric,
            "reason": "Found numeric columns" if has_numeric else "Need numeric columns",
        },
        {
            "name": "relationship_anomaly",
            "description": "Flag rows where total != qty * price (A != B * C).",
            "available": total_numeric >= 3,
            "reason": "Found 3+ numeric columns" if total_numeric >= 3 else "Need 3+ numeric columns for relationship check",
        },
        {
            "name": "trend_anomaly",
            "description": "Detect consecutive decline/surge and rolling deviation.",
            "available": has_numeric and has_dates,
            "reason": "Found date + numeric" if (has_numeric and has_dates) else "Need date + numeric columns",
        },
        {
            "name": "composition_shift",
            "description": "Detect when a dimension's share of total changes drastically between periods.",
            "available": has_numeric and has_dims and has_dates,
            "reason": "Found dimension + metric + period" if (has_dims and has_dates) else "Need dimension + metric + period",
        },
        {
            "name": "cross_dimension",
            "description": "Find dimensions where metric deviates from peers + own history.",
            "available": has_numeric and has_dims,
            "reason": "Found dimension + numeric" if (has_numeric and has_dims) else "Need dimension + numeric columns",
        },
    ]


# ================================================================
# Part 2: LLM PROMPT BUILDER
# ================================================================

SUPPORTED_DETECTORS = {
    "zscore_outlier": {
        "description": "Flag individual rows where a metric's z-score > threshold. Returns flagged rows with z-score values.",
        "params": {
            "source_sheet": "str",
            "metric_cols": "list[str] — numeric columns to check for outliers",
            "threshold": "float — z-score threshold (default 3.0)",
            "group_by": "str — optional dimension to compute z-score within each group (e.g., z-score per region instead of global)",
        },
    },
    "iqr_outlier": {
        "description": "Flag rows outside IQR fences: below Q1 - 1.5*IQR or above Q3 + 1.5*IQR. More robust than z-score for skewed data.",
        "params": {
            "source_sheet": "str",
            "metric_cols": "list[str] — numeric columns to check",
            "multiplier": "float — IQR multiplier (default 1.5, use 3.0 for extreme outliers only)",
            "group_by": "str — optional dimension for per-group IQR",
        },
    },
    "trend_anomaly": {
        "description": "Detect trend breaks in time-series: consecutive decline (N periods in a row), sudden spikes/drops vs rolling average, or acceleration changes.",
        "params": {
            "source_sheet": "str",
            "date_col": "str — date column",
            "metric_col": "str — metric to analyze",
            "freq": "str — aggregation frequency: 'D','W','M','Q' (default 'M')",
            "consecutive_threshold": "int — flag if metric declines/surges for N consecutive periods (default 3)",
            "rolling_window": "int — rolling average window size (default 3)",
            "deviation_threshold": "float — flag if value deviates from rolling avg by this many std (default 2.0)",
            "group_by": "str — optional dimension for per-group trend analysis",
        },
    },
    "negative_values": {
        "description": "Flag negative values in columns that should always be positive. Always critical severity.",
        "params": {
            "source_sheet": "str",
            "metric_cols": "list[str] — columns to check for negatives",
        },
    },
    "relationship_anomaly": {
        "description": "Flag rows where result_col != factor_a * factor_b (e.g., order_value != qty * unit_price). Tolerance default 5%.",
        "params": {
            "source_sheet": "str",
            "result_col": "str — the total/result column (e.g., order_value)",
            "factor_a": "str — first factor (e.g., qty)",
            "factor_b": "str — second factor (e.g., unit_price)",
            "tolerance": "float — relative error tolerance (default 0.05 = 5%)",
        },
    },
    "composition_shift": {
        "description": "Detect when a dimension's share of total changes drastically between periods. E.g., Fashion went from 20% to 45% of revenue.",
        "params": {
            "source_sheet": "str",
            "metric_col": "str — metric to analyze",
            "dimension_col": "str — dimension to check share changes",
            "date_col": "str — date column (optional)",
            "period_col": "str — period column (optional)",
            "mode": "str — 'MoM','QoQ','YoY' (default 'MoM')",
            "shift_threshold": "float — flag if share changes by more than this many percentage points (default 10)",
        },
    },
    "cross_dimension": {
        "description": "Two-axis anomaly: (1) Horizontal — compare each dimension vs peers in current period. (2) Vertical — compare each dimension vs its own prior period. Flags dimensions anomalous on either axis. E.g., 'EMEA dropped 40% MoM while others grew 10%'.",
        "params": {
            "source_sheet": "str",
            "metric_col": "str — metric to compare",
            "dimension_col": "str — dimension to break down (region, product, customer)",
            "date_col": "str — optional date column for period-specific analysis",
            "period_col": "str — optional period column",
            "mode": "str — 'MoM','QoQ','YoY' (optional, for comparing current period only)",
            "threshold": "float — flag if z-score of dimension's metric vs peers > threshold (default 2.0)",
        },
    },
}


def build_anomaly_prompt(profile, selected_detectors=None):
    """Build LLM prompt for anomaly detection config."""
    detectors = SUPPORTED_DETECTORS
    if selected_detectors:
        detectors = {k: v for k, v in SUPPORTED_DETECTORS.items() if k in selected_detectors}

    calc_desc = "\n".join(
        f"  {name}:\n    {info['description']}\n    params: {json.dumps(info['params'], indent=6)}"
        for name, info in detectors.items()
    )

    system_prompt = f"""You are a data analyst configuring anomaly detection.
You receive a data profile and return a JSON config telling the anomaly engine what to check.

AVAILABLE DETECTORS:
{calc_desc}

RESPONSE FORMAT — return ONLY valid JSON:
{{
  "detections": [
    {{
      "detector": "detector_name",
      "params": {{...params...}},
      "label": "Human-readable label"
    }},
    ...
  ]
}}

RULES:
1. Use ONLY detectors from the list above.
2. Map column names EXACTLY as they appear in the data profile.
3. For zscore_outlier and iqr_outlier: include ALL numeric columns that represent business metrics (revenue, qty, cost, price). Exclude ID columns or counts.
4. For trend_anomaly: create one entry per key metric (revenue, qty, etc.) with appropriate freq.
5. For cross_dimension: create one entry per useful dimension (region, product, customer, category).
6. Use group_by when the metric's distribution differs across groups (e.g., price ranges differ by product category).
7. Default thresholds are usually fine. Only lower threshold if you want more sensitivity.
8. For trend_anomaly, prefer freq='M' (monthly) unless data is daily.

RESPOND WITH ONLY VALID JSON."""

    user_prompt = "## Data Profile for Anomaly Detection\n\n"
    for sheet_name, sp in profile["sheets"].items():
        user_prompt += f"### Sheet: {sheet_name} ({sp['row_count']} rows)\n"
        if sp.get("numeric_cols"):
            user_prompt += f"  Numeric: {sp['numeric_cols']}\n"
        if sp.get("dimension_cols"):
            user_prompt += f"  Dimensions: {sp['dimension_cols']}\n"
        if sp.get("date_cols"):
            user_prompt += f"  Dates: {sp['date_cols']}\n"
        user_prompt += "  Details:\n"
        for col_name, ci in sp["columns"].items():
            parts = [f"dtype={ci.get('dtype', '?')}"]
            if ci.get("stats"):
                s = ci["stats"]
                parts.append(f"mean={s['mean']}, std={s['std']}, range=[{s['min']}..{s['max']}]")
            if ci.get("values"):
                parts.append(f"values={ci['values'][:8]}")
            if ci.get("date_range"):
                parts.append(f"range={ci['date_range']}")
            user_prompt += f"    {col_name}: {', '.join(parts)}\n"
        user_prompt += "\n"

    return system_prompt, user_prompt


# ================================================================
# Part 3: ANOMALY DETECTOR ENGINE
# ================================================================

class AnomalyDetector:
    """Deterministic anomaly detection engine."""

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

    def detect(self, config):
        """Execute all detections from LLM config."""
        detections = config.get("detections", [])
        all_artifacts = []
        used_labels = set()
        total_anomalies = 0
        global_findings = []  # collect all individual findings for summary

        for det in detections:
            name = det.get("detector")
            if name not in SUPPORTED_DETECTORS and name != "negative_values":
                self.log.append({"action": "skip_unknown", "detector": name})
                continue

            handler = getattr(self, f"_detect_{name}", None)
            if not handler:
                self.log.append({"action": "skip_no_handler", "detector": name})
                continue

            try:
                label = det.get("label", name)
                params = det.get("params", {})
                artifacts, count = handler(params, label)
                total_anomalies += count
                for a in artifacts:
                    base_lbl = a["label"]
                    lbl = base_lbl
                    i = 2
                    while lbl in used_labels:
                        lbl = f"{base_lbl} ({i})"
                        i += 1
                    a["label"] = lbl
                    used_labels.add(lbl)

                    # Collect detail rows for global summary
                    if "Detail" in a["label"] or name == "negative_values":
                        for row in a.get("data", [])[:20]:
                            finding = {"detector": name, "source": label}
                            finding.update(row)
                            global_findings.append(finding)

                all_artifacts.extend(artifacts)
                self.log.append({"action": "detected", "detector": name, "label": label,
                                 "anomalies_found": count, "params_used": params})
            except Exception as e:
                self.log.append({"action": "error", "detector": name, "error": str(e)[:300]})

        self.result_summary["total_anomalies"] = total_anomalies

        # Global anomaly summary: all findings sorted by severity + magnitude
        if global_findings:
            severity_order = {"critical": 0, "warning": 1}
            # business_impact = z_score × |value| — same z-score, bigger value = more important
            for f in global_findings:
                z = abs(f.get("z_score", 0) or f.get("deviation_sigma", 0) or f.get("error_pct", 0) or 0)
                v = abs(f.get("value", 0) or 0)
                f["business_impact"] = round(z * max(v, 1), 2)

            sorted_findings = sorted(global_findings, key=lambda f: (
                severity_order.get(f.get("severity", "warning"), 2),
                -f.get("business_impact", 0),
            ))
            # Deduplicate: same row + column → keep highest severity
            seen = set()
            deduped = []
            for f in sorted_findings:
                key = (f.get("row"), f.get("column"), f.get("metric"))
                if key != (None, None, None) and key in seen:
                    continue
                seen.add(key)
                deduped.append(f)

            all_artifacts.insert(0, {
                "type": "table",
                "label": "Anomaly Summary (Top Findings)",
                "data": deduped[:50],
            })

        # Detection config metadata
        mapping_rows = []
        for d in detections:
            p = d.get("params", {})
            row = {"detector": d.get("detector", ""), "label": d.get("label", "")}
            for key in ["source_sheet", "metric_cols", "metric_col", "dimension_col",
                         "date_col", "group_by", "threshold", "mode"]:
                if key in p:
                    row[key] = str(p[key])
            mapping_rows.append(row)
        if mapping_rows:
            all_artifacts.append({"type": "table", "label": "Detection Config (verify)", "data": mapping_rows})

        # Build summary for narrative (top findings from global summary)
        summary_lines = [f"Total anomalies: {total_anomalies}"]
        # Use the global summary artifact (first table)
        for a in all_artifacts[:1]:
            if "Summary" in a.get("label", ""):
                for row in a.get("data", [])[:10]:
                    detector = row.get("detector", "")
                    col = row.get("column", row.get("metric", ""))
                    val = row.get("value", "")
                    sev = row.get("severity", "")
                    z = row.get("z_score", row.get("deviation_sigma", row.get("error_pct", "")))
                    summary_lines.append(f"  [{sev}] {detector}: {col}={val} (z={z})")

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

    def _nan_safe_records(self, df):
        return df.where(df.notna(), None).to_dict("records")

    # -- Detector implementations --

    def _detect_zscore_outlier(self, params, label):
        """Flag rows where z-score of metric > threshold."""
        df = self._get_sheet(params["source_sheet"]).copy()
        metric_cols = params["metric_cols"]
        threshold = params.get("threshold", 3.0)
        group_by = params.get("group_by")

        valid_cols = [c for c in metric_cols if c in df.columns]
        if not valid_cols:
            raise ValueError(f"No valid metric columns found. Requested: {metric_cols}")

        all_flags = []

        for col in valid_cols:
            numeric = self._to_numeric(df[col])

            if group_by and group_by in df.columns:
                # Per-group z-score
                grouped = df.groupby(group_by)
                for group_val, group_idx in grouped.groups.items():
                    group_vals = numeric.loc[group_idx].dropna()
                    if len(group_vals) < 3:
                        continue
                    mean, std = group_vals.mean(), group_vals.std()
                    if std == 0:
                        continue
                    z = ((group_vals - mean) / std).abs()
                    outliers = z[z > threshold]
                    for idx in outliers.index:
                        all_flags.append({
                            "row": int(idx),
                            "column": col,
                            group_by: str(group_val),
                            "value": round(float(df.loc[idx, col]), 2) if pd.notna(df.loc[idx, col]) else None,
                            "z_score": round(float(z.loc[idx]), 2),
                            "group_mean": round(float(mean), 2),
                            "group_std": round(float(std), 2),
                            "severity": "critical" if z.loc[idx] > threshold * 1.5 else "warning",
                        })
            else:
                # Global z-score
                valid = numeric.dropna()
                if len(valid) < 3:
                    continue
                mean, std = valid.mean(), valid.std()
                if std == 0:
                    continue
                z = ((numeric - mean) / std).abs()
                outliers = z[z > threshold]
                for idx in outliers.index:
                    all_flags.append({
                        "row": int(idx),
                        "column": col,
                        "value": round(float(df.loc[idx, col]), 2) if pd.notna(df.loc[idx, col]) else None,
                        "z_score": round(float(z.loc[idx]), 2),
                        "mean": round(float(mean), 2),
                        "std": round(float(std), 2),
                        "severity": "critical" if z.loc[idx] > threshold * 1.5 else "warning",
                    })

        count = len(all_flags)
        # Summary by column
        summary = {}
        for f in all_flags:
            col = f["column"]
            summary.setdefault(col, {"count": 0, "critical": 0, "warning": 0})
            summary[col]["count"] += 1
            summary[col][f["severity"]] += 1

        summary_rows = [{"column": k, **v} for k, v in summary.items()]

        artifacts = []
        if summary_rows:
            artifacts.append({"type": "table", "label": f"{label} — Summary", "data": summary_rows})
        if all_flags:
            artifacts.append({"type": "table", "label": f"{label} — Details", "data": all_flags[:100]})

        return artifacts, count

    def _detect_iqr_outlier(self, params, label):
        """Flag rows outside IQR fences."""
        df = self._get_sheet(params["source_sheet"]).copy()
        metric_cols = params["metric_cols"]
        multiplier = params.get("multiplier", 1.5)
        group_by = params.get("group_by")

        valid_cols = [c for c in metric_cols if c in df.columns]
        if not valid_cols:
            raise ValueError(f"No valid metric columns found")

        all_flags = []

        for col in valid_cols:
            numeric = self._to_numeric(df[col])

            def _iqr_check(vals, indices, group_label=None):
                if len(vals) < 4:
                    return
                q1, q3 = vals.quantile(0.25), vals.quantile(0.75)
                iqr = q3 - q1
                if iqr == 0:
                    return
                lower = q1 - multiplier * iqr
                upper = q3 + multiplier * iqr
                outlier_mask = (vals < lower) | (vals > upper)
                for idx in vals[outlier_mask].index:
                    val = float(vals.loc[idx])
                    flag = {
                        "row": int(idx),
                        "column": col,
                        "value": round(val, 2),
                        "lower_fence": round(float(lower), 2),
                        "upper_fence": round(float(upper), 2),
                        "direction": "below" if val < lower else "above",
                        "severity": "critical" if (val < q1 - 3 * iqr or val > q3 + 3 * iqr) else "warning",
                    }
                    if group_label is not None:
                        flag[group_by] = str(group_label)
                    all_flags.append(flag)

            if group_by and group_by in df.columns:
                for gval, gidx in df.groupby(group_by).groups.items():
                    _iqr_check(numeric.loc[gidx].dropna(), gidx, gval)
            else:
                _iqr_check(numeric.dropna(), numeric.dropna().index)

        count = len(all_flags)
        summary = {}
        for f in all_flags:
            col = f["column"]
            summary.setdefault(col, {"count": 0, "above": 0, "below": 0})
            summary[col]["count"] += 1
            summary[col][f["direction"]] += 1

        summary_rows = [{"column": k, **v} for k, v in summary.items()]
        artifacts = []
        if summary_rows:
            artifacts.append({"type": "table", "label": f"{label} — Summary", "data": summary_rows})
        if all_flags:
            artifacts.append({"type": "table", "label": f"{label} — Details", "data": all_flags[:100]})

        return artifacts, count

    def _detect_trend_anomaly(self, params, label):
        """Detect trend breaks: consecutive decline/surge, rolling deviation."""
        df = self._get_sheet(params["source_sheet"]).copy()
        date_col = params["date_col"]
        metric_col = params["metric_col"]
        freq_raw = params.get("freq", "M")
        consecutive_n = params.get("consecutive_threshold", 3)
        window = params.get("rolling_window", 3)
        dev_threshold = params.get("deviation_threshold", 2.0)
        group_by = params.get("group_by")

        freq_map = {"M": "ME", "Q": "QE", "Y": "YE"}
        freq = freq_map.get(freq_raw, freq_raw)

        if date_col not in df.columns or metric_col not in df.columns:
            raise ValueError(f"Missing columns: {date_col} or {metric_col}")

        df["_date"] = pd.to_datetime(df[date_col], errors="coerce")
        df["_val"] = self._to_numeric(df[metric_col])
        df = df.dropna(subset=["_date", "_val"])

        all_findings = []

        def _analyze_series(sub_df, group_label=None):
            ts = sub_df.set_index("_date")["_val"].resample(freq).sum().reset_index()
            ts.columns = ["period", "value"]
            if len(ts) < 3:
                return

            ts["pct_change"] = ts["value"].pct_change() * 100

            # 1. Consecutive decline/surge
            ts["direction"] = ts["pct_change"].apply(
                lambda x: "decline" if (pd.notna(x) and x < 0) else ("surge" if (pd.notna(x) and x > 0) else "flat")
            )
            streak = 0
            streak_dir = None
            for i, row in ts.iterrows():
                d = row["direction"]
                if d == streak_dir and d != "flat":
                    streak += 1
                else:
                    streak = 1
                    streak_dir = d
                if streak >= consecutive_n and d != "flat":
                    finding = {
                        "type": f"consecutive_{d}",
                        "period": row["period"].strftime("%Y-%m-%d"),
                        "value": round(float(row["value"]), 2),
                        "streak_length": streak,
                        "severity": "critical" if streak >= consecutive_n + 1 else "warning",
                        "metric": metric_col,
                    }
                    if group_label is not None:
                        finding[group_by] = str(group_label)
                    all_findings.append(finding)

            # 2. Rolling deviation
            if len(ts) >= window + 1:
                ts["rolling_mean"] = ts["value"].rolling(window, min_periods=window).mean()
                ts["rolling_std"] = ts["value"].rolling(window, min_periods=window).std()
                for _, row in ts.dropna(subset=["rolling_mean", "rolling_std"]).iterrows():
                    if row["rolling_std"] == 0:
                        continue
                    deviation = abs(row["value"] - row["rolling_mean"]) / row["rolling_std"]
                    if deviation > dev_threshold:
                        finding = {
                            "type": "rolling_deviation",
                            "period": row["period"].strftime("%Y-%m-%d"),
                            "value": round(float(row["value"]), 2),
                            "rolling_mean": round(float(row["rolling_mean"]), 2),
                            "deviation_sigma": round(float(deviation), 2),
                            "severity": "critical" if deviation > dev_threshold * 1.5 else "warning",
                            "metric": metric_col,
                        }
                        if group_label is not None:
                            finding[group_by] = str(group_label)
                        all_findings.append(finding)

        if group_by and group_by in df.columns:
            for gval, gidx in df.groupby(group_by).groups.items():
                _analyze_series(df.loc[gidx], gval)
        else:
            _analyze_series(df)

        count = len(all_findings)

        # Summary
        summary = {}
        for f in all_findings:
            t = f["type"]
            summary.setdefault(t, {"count": 0, "critical": 0, "warning": 0})
            summary[t]["count"] += 1
            summary[t][f["severity"]] += 1
        summary_rows = [{"anomaly_type": k, **v} for k, v in summary.items()]

        artifacts = []
        if summary_rows:
            artifacts.append({"type": "table", "label": f"{label} — Summary", "data": summary_rows})
        if all_findings:
            artifacts.append({"type": "table", "label": f"{label} — Details", "data": all_findings[:100]})

        return artifacts, count

    def _detect_cross_dimension(self, params, label):
        """
        Two-axis anomaly detection:
        1. Horizontal: each dimension vs peers in current period (z-score of group values)
        2. Vertical: each dimension vs its own prior period (MoM/QoQ/YoY change)
        Flags dimensions that are anomalous on either axis.
        """
        raw_df = self._get_sheet(params["source_sheet"]).copy()
        metric_col = params["metric_col"]
        dimension_col = params["dimension_col"]
        threshold = params.get("threshold", 2.0)
        date_col = params.get("date_col")
        period_col = params.get("period_col")
        mode = params.get("mode")

        if metric_col not in raw_df.columns or dimension_col not in raw_df.columns:
            raise ValueError(f"Missing: {metric_col} or {dimension_col}")

        raw_df[metric_col] = self._to_numeric(raw_df[metric_col])

        # Derive period column if needed
        pcol = period_col
        if mode and (date_col or period_col):
            if not pcol or pcol not in raw_df.columns:
                if date_col and date_col in raw_df.columns:
                    dates = pd.to_datetime(raw_df[date_col], errors="coerce")
                    if mode == "MoM":
                        raw_df["_period"] = dates.dt.strftime("%Y-%m")
                    elif mode == "QoQ":
                        raw_df["_period"] = dates.apply(
                            lambda d: f"{d.year}-Q{(d.month-1)//3+1}" if pd.notna(d) else None)
                    elif mode == "YoY":
                        raw_df["_period"] = dates.dt.strftime("%Y")
                    pcol = "_period"

        # Determine current and prior periods
        current_period = None
        prior_period = None
        if pcol and pcol in raw_df.columns:
            periods_sorted = sorted(raw_df[pcol].dropna().unique())
            if len(periods_sorted) >= 2:
                current_period = periods_sorted[-1]
                prior_period = periods_sorted[-2]
            elif len(periods_sorted) == 1:
                current_period = periods_sorted[0]

        # ── Axis 1: Horizontal (vs peers in current period) ──
        if current_period and pcol:
            df_current = raw_df[raw_df[pcol].astype(str) == str(current_period)]
        else:
            df_current = raw_df

        dim_agg = df_current.groupby(dimension_col)[metric_col].sum().reset_index()
        dim_agg.columns = [dimension_col, "value"]

        artifacts = []
        horizontal_count = 0

        if len(dim_agg) >= 2:
            mean = dim_agg["value"].mean()
            std = dim_agg["value"].std()
            dim_agg["pct_of_avg"] = (dim_agg["value"] / mean * 100).round(1) if mean else 0

            if len(dim_agg) >= 5 and std > 0:
                # Enough peers: use z-score
                dim_agg["z_score_vs_peers"] = ((dim_agg["value"] - mean) / std).round(2)
                dim_agg["is_peer_anomaly"] = dim_agg["z_score_vs_peers"].abs() > threshold
            else:
                # Small peer group: use pct_of_avg (>200% or <50% = anomaly)
                dim_agg["z_score_vs_peers"] = None
                dim_agg["is_peer_anomaly"] = (dim_agg["pct_of_avg"] > 200) | (dim_agg["pct_of_avg"] < 50)

            horizontal_count = int(dim_agg["is_peer_anomaly"].sum())

        dim_agg["value"] = dim_agg["value"].round(2)

        # ── Axis 2: Vertical (vs own prior period) ──
        vertical_count = 0
        if prior_period and pcol:
            df_prior = raw_df[raw_df[pcol].astype(str) == str(prior_period)]
            prior_agg = df_prior.groupby(dimension_col)[metric_col].sum().reset_index()
            prior_agg.columns = [dimension_col, "prior_value"]
            prior_agg["prior_value"] = prior_agg["prior_value"].round(2)

            dim_agg = dim_agg.merge(prior_agg, on=dimension_col, how="left")
            dim_agg["self_delta"] = (dim_agg["value"] - dim_agg["prior_value"].fillna(0)).round(2)
            dim_agg["self_delta_pct"] = dim_agg.apply(
                lambda r: round((r["self_delta"] / abs(r["prior_value"])) * 100, 1)
                if pd.notna(r.get("prior_value")) and r["prior_value"] != 0 else None, axis=1
            )

            # Flag: dimension's MoM change is anomalous vs peers' MoM changes
            all_deltas = dim_agg["self_delta_pct"].dropna()
            if len(all_deltas) >= 2:
                delta_mean = all_deltas.mean()
                delta_std = all_deltas.std()
                if delta_std > 0:
                    dim_agg["z_score_vs_self"] = ((dim_agg["self_delta_pct"] - delta_mean) / delta_std).round(2)
                    dim_agg["is_self_anomaly"] = dim_agg["z_score_vs_self"].abs() > threshold
                    vertical_count = int(dim_agg["is_self_anomaly"].sum())

            self.log.append({"action": "info", "detector": "cross_dimension",
                             "message": f"Compared {current_period} vs {prior_period}"})

        # Combined anomaly flag
        dim_agg["is_anomaly"] = False
        if "is_peer_anomaly" in dim_agg.columns:
            dim_agg["is_anomaly"] = dim_agg["is_anomaly"] | dim_agg["is_peer_anomaly"]
        if "is_self_anomaly" in dim_agg.columns:
            dim_agg["is_anomaly"] = dim_agg["is_anomaly"] | dim_agg["is_self_anomaly"]

        dim_agg = dim_agg.sort_values("value", ascending=False)
        count = int(dim_agg["is_anomaly"].sum())

        artifacts.append({
            "type": "table",
            "label": f"{label} — {metric_col} by {dimension_col}" + (f" ({current_period})" if current_period else ""),
            "data": self._nan_safe_records(dim_agg),
        })

        if count > 0:
            anomalous = dim_agg[dim_agg["is_anomaly"]].copy()
            anomalous = anomalous.sort_values("value", ascending=True)
            artifacts.append({
                "type": "table",
                "label": f"{label} — Anomalous {dimension_col}s",
                "data": self._nan_safe_records(anomalous),
            })

        return artifacts, count

    def _detect_relationship_anomaly(self, params, label):
        """Flag rows where A ≠ B × C (e.g., order_value ≠ qty × unit_price)."""
        df = self._get_sheet(params["source_sheet"]).copy()
        result_col = params["result_col"]       # e.g., order_value
        factor_a = params["factor_a"]           # e.g., qty
        factor_b = params["factor_b"]           # e.g., unit_price
        tolerance = params.get("tolerance", 0.05)  # 5% tolerance

        for c in [result_col, factor_a, factor_b]:
            if c not in df.columns:
                raise ValueError(f"Missing column: {c}")

        df["_result"] = self._to_numeric(df[result_col])
        df["_expected"] = self._to_numeric(df[factor_a]) * self._to_numeric(df[factor_b])
        valid = df["_result"].notna() & df["_expected"].notna() & (df["_expected"].abs() > 0.01)
        df_valid = df[valid].copy()

        df_valid["_rel_error"] = ((df_valid["_result"] - df_valid["_expected"]).abs() / df_valid["_expected"].abs())
        mismatches = df_valid[df_valid["_rel_error"] > tolerance]

        all_flags = []
        for idx in mismatches.index:
            row = mismatches.loc[idx]
            all_flags.append({
                "row": int(idx),
                result_col: round(float(row["_result"]), 2),
                f"expected ({factor_a}×{factor_b})": round(float(row["_expected"]), 2),
                "error_pct": round(float(row["_rel_error"] * 100), 1),
                "severity": "critical" if row["_rel_error"] > 0.5 else "warning",
            })

        count = len(all_flags)
        artifacts = []
        if all_flags:
            artifacts.append({"type": "table", "label": label, "data": all_flags[:100]})
        return artifacts, count

    def _detect_composition_shift(self, params, label):
        """Detect when a dimension's share of total changes drastically between periods."""
        df = self._get_sheet(params["source_sheet"]).copy()
        metric_col = params["metric_col"]
        dimension_col = params["dimension_col"]
        date_col = params.get("date_col")
        period_col = params.get("period_col")
        mode = params.get("mode", "MoM")
        shift_threshold = params.get("shift_threshold", 10.0)  # percentage points

        if metric_col not in df.columns or dimension_col not in df.columns:
            raise ValueError(f"Missing: {metric_col} or {dimension_col}")

        df[metric_col] = self._to_numeric(df[metric_col])

        # Derive period
        pcol = period_col
        if not pcol or pcol not in df.columns:
            if date_col and date_col in df.columns:
                dates = pd.to_datetime(df[date_col], errors="coerce")
                if mode == "MoM":
                    df["_period"] = dates.dt.strftime("%Y-%m")
                elif mode == "QoQ":
                    df["_period"] = dates.apply(lambda d: f"{d.year}-Q{(d.month-1)//3+1}" if pd.notna(d) else None)
                else:
                    df["_period"] = dates.dt.strftime("%Y-%m")
                pcol = "_period"
            # Also try YYYY-MM format in categorical columns
            if not pcol or pcol not in df.columns:
                for c in df.columns:
                    if df[c].astype(str).str.match(r'^\d{4}-\d{2}$').sum() > len(df) * 0.5:
                        pcol = c
                        break

        if not pcol or pcol not in df.columns:
            raise ValueError("Cannot determine period column")

        periods = sorted(df[pcol].dropna().unique())
        if len(periods) < 2:
            return [], 0

        current, prior = periods[-1], periods[-2]
        curr_data = df[df[pcol].astype(str) == str(current)]
        prior_data = df[df[pcol].astype(str) == str(prior)]

        # Compute shares
        curr_total = curr_data[metric_col].sum()
        prior_total = prior_data[metric_col].sum()
        if curr_total == 0 or prior_total == 0:
            return [], 0

        curr_share = (curr_data.groupby(dimension_col)[metric_col].sum() / curr_total * 100).round(2)
        prior_share = (prior_data.groupby(dimension_col)[metric_col].sum() / prior_total * 100).round(2)

        comparison = pd.DataFrame({
            "prior_share_pct": prior_share,
            "current_share_pct": curr_share,
        }).fillna(0)
        comparison["shift_pp"] = (comparison["current_share_pct"] - comparison["prior_share_pct"]).round(2)
        comparison = comparison.reset_index().rename(columns={"index": dimension_col})

        # Flag shifts > threshold
        flagged = comparison[comparison["shift_pp"].abs() > shift_threshold].copy()
        flagged["direction"] = flagged["shift_pp"].apply(lambda s: "gained_share" if s > 0 else "lost_share")
        flagged["severity"] = flagged["shift_pp"].abs().apply(lambda s: "critical" if s > shift_threshold * 2 else "warning")

        count = len(flagged)
        artifacts = []
        # Always show full composition comparison
        comparison = comparison.sort_values("shift_pp", key=abs, ascending=False)
        artifacts.append({
            "type": "table",
            "label": f"{label} — {metric_col} share by {dimension_col} ({prior}→{current})",
            "data": self._nan_safe_records(comparison),
        })
        if count > 0:
            artifacts.append({
                "type": "table",
                "label": f"{label} — Significant Shifts",
                "data": self._nan_safe_records(flagged),
            })

        return artifacts, count

    def _detect_negative_values(self, params, label):
        """Flag negative values in columns that should always be positive (price, qty, revenue)."""
        df = self._get_sheet(params["source_sheet"]).copy()
        metric_cols = params.get("metric_cols", [])

        valid_cols = [c for c in metric_cols if c in df.columns]
        if not valid_cols:
            return [], 0

        all_flags = []
        for col in valid_cols:
            numeric = self._to_numeric(df[col])
            negatives = df[numeric < 0]
            for idx in negatives.index:
                all_flags.append({
                    "row": int(idx),
                    "column": col,
                    "value": round(float(numeric.loc[idx]), 2),
                    "severity": "critical",
                })

        count = len(all_flags)
        artifacts = []
        if all_flags:
            artifacts.append({"type": "table", "label": f"{label}", "data": all_flags[:100]})
        return artifacts, count

    def get_log(self):
        return self.log


def build_auto_config(profile):
    """
    Build a comprehensive config that covers ALL numeric columns across ALL sheets.
    No LLM needed — deterministic coverage guarantee.
    """
    detections = []

    # ID-like column patterns to skip
    id_patterns = {"_id", "_no", "_code", "index", "row_num", "record", "seq"}

    for sheet_name, sp in profile.get("sheets", {}).items():
        numeric_cols = sp.get("numeric_cols", [])
        date_cols = sp.get("date_cols", [])
        dimension_cols = sp.get("dimension_cols", [])

        if not numeric_cols:
            continue

        # Filter out ID-like and single-value numeric columns
        cols_info = sp.get("columns", {})
        meaningful_numeric = []
        for c in numeric_cols:
            cl = c.lower()
            if any(pat in cl for pat in id_patterns):
                continue
            ci = cols_info.get(c, {})
            # Skip if basically constant (std ≈ 0)
            stats = ci.get("stats", {})
            if stats.get("std", 1) == 0 and stats.get("min") == stats.get("max"):
                continue
            meaningful_numeric.append(c)

        if not meaningful_numeric:
            continue

        numeric_cols = meaningful_numeric

        # 1. Z-score on all numeric cols
        detections.append({
            "detector": "zscore_outlier",
            "params": {"source_sheet": sheet_name, "metric_cols": numeric_cols, "threshold": 3.0},
            "label": f"Z-score Outliers — {sheet_name}",
        })

        # 2. IQR on all numeric cols
        detections.append({
            "detector": "iqr_outlier",
            "params": {"source_sheet": sheet_name, "metric_cols": numeric_cols, "multiplier": 1.5},
            "label": f"IQR Outliers — {sheet_name}",
        })

        # 3. Negative value check on ALL numeric cols (language-agnostic)
        detections.append({
            "detector": "negative_values",
            "params": {"source_sheet": sheet_name, "metric_cols": numeric_cols},
            "label": f"Negative Values — {sheet_name}",
        })

        # 4. Trend: Layer 1 = ungrouped, Layer 2 = grouped by first dimension only
        if date_cols:
            for metric in numeric_cols:
                # Layer 1: overall trend per metric
                detections.append({
                    "detector": "trend_anomaly",
                    "params": {
                        "source_sheet": sheet_name,
                        "date_col": date_cols[0],
                        "metric_col": metric,
                        "freq": "M",
                        "consecutive_threshold": 3,
                    },
                    "label": f"Trend — {sheet_name}.{metric}",
                })
            # Layer 2: first dimension only, top 3 numeric cols by std
            if dimension_cols:
                top_dim = dimension_cols[0]
                sorted_by_std = sorted(
                    numeric_cols,
                    key=lambda c: cols_info.get(c, {}).get("stats", {}).get("std", 0),
                    reverse=True,
                )[:3]
                for metric in sorted_by_std:
                    detections.append({
                        "detector": "trend_anomaly",
                        "params": {
                            "source_sheet": sheet_name,
                            "date_col": date_cols[0],
                            "metric_col": metric,
                            "freq": "M",
                            "consecutive_threshold": 3,
                            "group_by": top_dim,
                        },
                        "label": f"Trend — {sheet_name}.{metric} by {top_dim}",
                    })

        # 5. Cross-dimension: top 3 dimensions × top 3 numeric cols
        if dimension_cols:
            sorted_dims = sorted(
                dimension_cols,
                key=lambda d: cols_info.get(d, {}).get("unique_count", 999),
            )[:3]
            sorted_metrics = sorted(
                numeric_cols,
                key=lambda c: cols_info.get(c, {}).get("stats", {}).get("std", 0),
                reverse=True,
            )[:3]
            for metric in sorted_metrics:
                for dim in sorted_dims:
                    params = {
                        "source_sheet": sheet_name,
                        "metric_col": metric,
                        "dimension_col": dim,
                        "threshold": 2.0,
                    }
                    if date_cols:
                        params["date_col"] = date_cols[0]
                        params["mode"] = "MoM"
                    detections.append({
                        "detector": "cross_dimension",
                        "params": params,
                        "label": f"Cross-dim — {sheet_name}.{metric} by {dim}",
                    })

        # 6. Relationship anomaly: only check semantically valid A = B × C patterns
        if len(numeric_cols) >= 3:
            # Each tuple: (result keywords, factor_a keywords, factor_b keywords)
            # Only these specific patterns make business sense
            relationship_patterns = [
                (["total", "amount", "value", "subtotal", "order_value"], ["qty", "quantity", "units", "count"], ["price", "unit_price"]),
                (["revenue", "sales"], ["qty", "quantity", "units"], ["price", "unit_price", "selling_price"]),
                (["total_cost"], ["qty", "quantity", "units"], ["unit_cost", "cost_per_unit"]),
                (["gross_profit", "margin"], ["revenue", "sales", "total"], ["cogs", "cost_of_goods"]),
            ]

            col_lower_map = {c: c.lower() for c in numeric_cols}
            for result_kws, fa_kws, fb_kws in relationship_patterns:
                result_matches = [c for c in numeric_cols if any(k in col_lower_map[c] for k in result_kws)]
                fa_matches = [c for c in numeric_cols if any(k in col_lower_map[c] for k in fa_kws)]
                fb_matches = [c for c in numeric_cols if any(k in col_lower_map[c] for k in fb_kws)]

                for tc in result_matches[:1]:  # only first match per pattern
                    for qc in fa_matches[:1]:
                        for pc in fb_matches[:1]:
                            if len({tc, qc, pc}) == 3:
                                detections.append({
                                    "detector": "relationship_anomaly",
                                    "params": {"source_sheet": sheet_name, "result_col": tc, "factor_a": qc, "factor_b": pc},
                                    "label": f"Relationship — {sheet_name}: {tc} ≠ {qc}×{pc}",
                                })

        # 7. Composition shift: top 2 metrics × top 2 dimensions
        if dimension_cols and (date_cols or any(
                cols_info.get(c, {}).get("dtype") == "date" for c in sp.get("columns", {}))):
            sorted_dims_comp = sorted(
                dimension_cols,
                key=lambda d: cols_info.get(d, {}).get("unique_count", 999),
            )[:2]
            sorted_metrics_comp = sorted(
                numeric_cols,
                key=lambda c: cols_info.get(c, {}).get("stats", {}).get("std", 0),
                reverse=True,
            )[:2]
            for metric in sorted_metrics_comp:
                for dim in sorted_dims_comp:
                    params = {
                        "source_sheet": sheet_name,
                        "metric_col": metric,
                        "dimension_col": dim,
                    }
                    if date_cols:
                        params["date_col"] = date_cols[0]
                        params["mode"] = "MoM"
                    detections.append({
                        "detector": "composition_shift",
                        "params": params,
                        "label": f"Composition — {sheet_name}.{metric} by {dim}",
                    })

    return {"detections": detections}


# ================================================================
# Part 4: PIPELINE ENTRY POINT
# ================================================================

def execute_anomaly_pipeline(sheets_dict, call_llm_fn=None, llm_config=None):
    """Full anomaly detection pipeline."""
    profile = profile_for_anomaly(sheets_dict)

    config = None
    if call_llm_fn:
        sys_prompt, usr_prompt = build_anomaly_prompt(profile)
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
        return {"result": {}, "artifacts": [], "profile": profile,
                "config": None, "error": "Failed to get anomaly config from LLM"}

    dfs = {name: pd.DataFrame(data) for name, data in sheets_dict.items() if data}
    detector = AnomalyDetector(dfs)
    result = detector.detect(config)

    return {
        "result": result["result"],
        "artifacts": result["artifacts"],
        "profile": profile,
        "config": config,
        "log": detector.get_log(),
    }
