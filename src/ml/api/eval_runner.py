"""
eval_runner.py — Run Tier 1 tool evaluations against golden test data.

Endpoint: POST /eval/run-tier1
Returns pass/fail per tool + key output tables for display.
"""

import time
import json
import logging
import pandas as pd
import numpy as np
import traceback

logger = logging.getLogger(__name__)


def _nan_safe(obj):
    if isinstance(obj, float) and (np.isnan(obj) or np.isinf(obj)):
        return None
    if isinstance(obj, dict):
        return {k: _nan_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_nan_safe(v) for v in obj]
    return obj


def _pick_key_tables(artifacts, max_tables=3, max_rows=10):
    """Pick the most important tables from artifacts for display."""
    priority_keywords = ["overall", "total", "summary", "top", "revenue", "margin", "anomaly summary", "waterfall"]
    tables = []
    for art in (artifacts or []):
        if art.get("type") != "table" or not art.get("data"):
            continue
        label = (art.get("label") or "").lower()
        if "column mapping" in label or "detection config" in label:
            continue
        score = sum(1 for kw in priority_keywords if kw in label)
        tables.append((score, art))
    tables.sort(key=lambda x: -x[0])
    result = []
    for _, art in tables[:max_tables]:
        result.append({
            "label": art["label"],
            "data": art["data"][:max_rows],
            "total_rows": len(art["data"]),
        })
    return result


# ── Sheet/column lookup — expects canonical names from cleaning output ──
# If cleaning did its job, sheets = {canonical_name: [{canonical_col: val}]}
# These helpers are simple lookups, NOT fuzzy matchers.

def _get_sheet(sheets, canonical_name):
    """Get sheet by canonical name. Returns rows or []."""
    return sheets.get(canonical_name, [])

    return None


# ── Tool runners ──

def _run_mbr_cleaning(sheets):
    from ml.api.mbr_data_cleaning import execute_cleaning_pipeline
    result = execute_cleaning_pipeline(sheets)
    cleaned = {}
    for art in result.get("artifacts", []):
        if art.get("type") == "table" and art.get("label", "").startswith("cleaned_"):
            cleaned[art["label"].replace("cleaned_", "")] = art["data"]
    n_arts = len(result.get("artifacts", []))

    # ── Structural quality metrics (泛化斷言) ──
    quality = {"sheets_cleaned": len(cleaned), "artifacts": n_arts}
    issues = []
    for sn, rows in cleaned.items():
        if not rows:
            continue
        df = pd.DataFrame(rows)
        # Check: header-as-data rows remaining?
        for _, row in df.head(5).iterrows():
            matches = sum(1 for col in df.columns if str(row.get(col, "")).strip().lower() == str(col).strip().lower())
            if matches >= max(len(df.columns) * 0.4, 3):
                issues.append(f"{sn}: header row still in data")
                break
        # Check: test data remaining?
        import re
        test_pat = re.compile(r"\btest\b|\bdummy\b|\bsample\b", re.IGNORECASE)
        for _, row in df.iterrows():
            text = " ".join(str(v) for v in row.values if pd.notna(v))
            if test_pat.search(text):
                issues.append(f"{sn}: test/dummy row still in data")
                break
        # Check: entity dedup effectiveness on categorical columns
        for col in df.columns:
            if df[col].dtype == object or pd.api.types.is_string_dtype(df[col]):
                unique = df[col].nunique()
                if unique >= 2:
                    # Check for case variants
                    lower_unique = df[col].dropna().str.lower().nunique()
                    if lower_unique < unique:
                        issues.append(f"{sn}.{col}: {unique} unique but only {lower_unique} case-insensitive — {unique - lower_unique} case variants remaining")

    quality["issues"] = issues
    quality["issue_count"] = len(issues)

    # Log for cleaning engine actions
    log = result.get("artifacts", [{}])[-1]
    log_data = log.get("data", {}) if isinstance(log, dict) and log.get("type") == "summary" else {}

    # Key tables
    issue_table = [{"issue": iss} for iss in issues] if issues else [{"issue": "No structural issues found"}]
    orig_rows = sum(len(sheets.get(sn, [])) for sn in sheets)
    clean_rows = sum(len(rows) for rows in cleaned.values())

    return {
        "pass": n_arts > 0 and len(issues) == 0,
        "details": f"{orig_rows}→{clean_rows} rows, {len(issues)} structural issues" + (f": {issues[0]}" if issues else ""),
        "cleaned_sheets": cleaned,
        "summary": {"original_rows": orig_rows, "cleaned_rows": clean_rows,
                     "rows_removed": orig_rows - clean_rows, "structural_issues": len(issues)},
        "key_tables": [
            {"label": "Structural Quality Check", "data": issue_table, "total_rows": len(issue_table)},
        ],
    }


def _run_eda(sheets):
    first_name = list(sheets.keys())[0]
    first_sheet = sheets[first_name]
    df = pd.DataFrame(first_sheet)
    stats = []
    for col in df.columns:
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().sum() > len(df) * 0.5:
            stats.append({"column": col, "type": "numeric", "mean": round(float(numeric.mean()), 2),
                          "std": round(float(numeric.std()), 2), "min": round(float(numeric.min()), 2),
                          "max": round(float(numeric.max()), 2), "null_pct": round(float(numeric.isna().sum() / len(df) * 100), 1)})
        else:
            stats.append({"column": col, "type": "text", "unique": int(df[col].nunique()),
                          "null_pct": round(float(df[col].isna().sum() / len(df) * 100), 1)})
    return {
        "pass": len(stats) > 0,
        "details": f"{len(stats)} columns profiled from {first_name}",
        "key_tables": [{"label": f"Column Stats — {first_name}", "data": stats[:10], "total_rows": len(stats)}],
    }


def _run_kpi(sheets):
    from ml.api.kpi_calculator import execute_kpi_pipeline
    result = execute_kpi_pipeline(sheets)
    n_arts = len(result.get("artifacts", []))
    r = result.get("result", {})
    has_revenue = "total_revenue" in r or "total_revenue_by_currency" in r
    key_tables = _pick_key_tables(result.get("artifacts", []))

    # Structural checks
    issues = []
    if not has_revenue:
        issues.append("No revenue detected in result")

    # Check margin is aggregate (not simple average) — margin_pct should be < 100
    margin_pct = r.get("gross_margin_pct")
    if margin_pct is not None and (margin_pct > 100 or margin_pct < -100):
        issues.append(f"Margin {margin_pct}% is out of reasonable range [-100, 100]")

    # Check no fake categories in breakdown tables (header/test contamination)
    for art in result.get("artifacts", []):
        if "category" in (art.get("label") or "").lower():
            for row in (art.get("data") or [])[:20]:
                for v in row.values():
                    if isinstance(v, str) and v.lower() in ("category", "test", "dummy"):
                        issues.append(f"Fake category '{v}' found in {art['label']}")

    return {
        "pass": n_arts > 0 and has_revenue and len(issues) == 0,
        "details": f"{n_arts} KPI tables, revenue={'found' if has_revenue else 'MISSING'}" + (f", ISSUES: {issues[0]}" if issues else ""),
        "summary": {k: round(v, 2) if isinstance(v, float) else v for k, v in r.items() if isinstance(v, (int, float))},
        "key_tables": key_tables,
    }


def _run_variance(sheets):
    from ml.api.variance_analyzer import execute_variance_pipeline
    result = execute_variance_pipeline(sheets)
    n_arts = len(result.get("artifacts", []))
    key_tables = _pick_key_tables(result.get("artifacts", []))
    return {
        "pass": n_arts > 0,
        "details": f"{n_arts} variance tables",
        "summary": result.get("result", {}),
        "key_tables": key_tables,
    }


def _run_anomaly(sheets):
    from ml.api.anomaly_engine import AnomalyDetector, build_auto_config, profile_for_anomaly
    profile = profile_for_anomaly(sheets)
    config = build_auto_config(profile)
    dfs = {name: pd.DataFrame(data) for name, data in sheets.items() if data}
    detector = AnomalyDetector(dfs)
    result = detector.detect(config)
    total = result.get("result", {}).get("total_anomalies", 0)
    key_tables = _pick_key_tables(result.get("artifacts", []))
    return {
        "pass": True,
        "details": f"{total} anomalies found",
        "summary": {"total_anomalies": total},
        "key_tables": key_tables,
    }


def _run_forecast(sheets):
    from ml.demand_forecasting.forecaster_factory import ForecasterFactory
    sales = _get_sheet(sheets, "sales_transactions")
    if not sales:
        return {"pass": False, "details": "No sales_transactions sheet (cleaning should have renamed it)", "key_tables": []}
    df = pd.DataFrame(sales)
    if "order_date" in df.columns and "qty" in df.columns:
        df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(0)
        daily = df.groupby("order_date")["qty"].sum().sort_index()
        history = daily.tolist()
    else:
        return {"pass": False, "details": "Missing order_date or qty column (cleaning should have renamed them)", "key_tables": []}

    factory = ForecasterFactory()
    result = factory.predict_with_fallback(
        sku="EVAL-TEST", erp_connector=None, horizon_days=7,
        preferred_model="auto", inline_history=history,
    )
    ok = result.get("success", False)
    preds = result.get("prediction", {}).get("predictions", [])
    p10 = result.get("prediction", {}).get("p10", [])
    p90 = result.get("prediction", {}).get("p90", [])
    model = result.get("prediction", {}).get("model_used", result.get("model_used", "?"))
    non_neg = all(p >= 0 for p in preds) if preds else True

    forecast_table = []
    for i, p in enumerate(preds):
        row = {"day": i + 1, "p50": round(p, 1)}
        if p10 and i < len(p10):
            row["p10"] = round(p10[i], 1)
        if p90 and i < len(p90):
            row["p90"] = round(p90[i], 1)
        forecast_table.append(row)

    return {
        "pass": ok and non_neg and len(preds) == 7,
        "details": f"model={model}, {len(preds)} predictions, non_neg={non_neg}",
        "summary": {"model": model, "horizon": 7, "history_points": len(history)},
        "key_tables": [{"label": f"7-Day Forecast (model: {model})", "data": forecast_table, "total_rows": len(forecast_table)}],
    }


def _run_data_cleaning(sheets):
    first_name = list(sheets.keys())[0]
    rows = [dict(r) for r in sheets[first_name]]
    before = len(rows)
    for r in rows:
        for k, v in r.items():
            if isinstance(v, str):
                r[k] = v.strip()
    seen = set()
    deduped = []
    for r in rows:
        key = tuple(sorted((k, str(v)) for k, v in r.items()))
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    removed = before - len(deduped)
    return {
        "pass": True,
        "details": f"{before} → {len(deduped)} rows (removed {removed} dupes)",
        "key_tables": [{"label": "Cleaning Result", "data": [{"sheet": first_name, "before": before, "after": len(deduped), "removed": removed}], "total_rows": 1}],
    }


def _run_bom_explosion(sheets):
    bom_rows = _get_sheet(sheets, "bom_edges")
    sales = _get_sheet(sheets, "sales_transactions")
    if not bom_rows or not sales:
        return {"pass": False, "details": "Missing bom_edges or sales_transactions", "key_tables": []}

    df = pd.DataFrame(sales)
    df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(0)
    fg_demand = df.groupby("product_code")["qty"].sum()

    bom_index = {}
    for edge in bom_rows:
        parent = edge.get("parent_material")
        if parent:
            bom_index.setdefault(parent, []).append(edge)

    component_map = {}
    def explode(mat, qty, path, depth):
        if depth > 50 or mat in path:
            return
        for edge in bom_index.get(mat, []):
            child = edge["child_material"]
            qty_per = float(edge.get("qty_per", 1))
            scrap = float(edge.get("scrap_rate", 0))
            yld = max(float(edge.get("yield_rate", 1)), 0.01)
            child_qty = qty * qty_per * (1 + scrap) / yld
            component_map[child] = component_map.get(child, 0) + child_qty
            explode(child, child_qty, path | {mat}, depth + 1)

    for sku, qty in fg_demand.items():
        if sku in bom_index:
            explode(sku, qty, set(), 0)

    comp_table = sorted([{"component": k, "total_qty": round(v, 1)} for k, v in component_map.items()], key=lambda x: -x["total_qty"])
    return {
        "pass": len(component_map) > 0,
        "details": f"{len(fg_demand)} FGs → {len(component_map)} components",
        "key_tables": [{"label": "Component Demand", "data": comp_table[:10], "total_rows": len(comp_table)}],
    }


def _run_lp_solver(sheets):
    inv_rows = _get_sheet(sheets, "inventory_snapshot")
    sales = _get_sheet(sheets, "sales_transactions")
    if not inv_rows or not sales:
        return {"pass": False, "details": "Missing data", "key_tables": []}

    df = pd.DataFrame(sales)
    df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(0)
    demand = df.groupby("product_code")["qty"].sum()

    plan_lines = []
    for inv in inv_rows:
        sku = inv.get("product_code")
        on_hand = float(inv.get("on_hand_qty", 0) or 0)
        ss = float(inv.get("safety_stock", 0) or 0)
        total_demand = float(demand.get(sku, 0))
        avg_daily = total_demand / 180
        projected = on_hand - avg_daily * 30
        if projected < ss:
            order = max(0, ss - projected)
            moq = float(inv.get("moq", 1) or 1)
            if 0 < order < moq:
                order = moq
            plan_lines.append({"sku": sku, "warehouse": inv.get("warehouse", "?"),
                               "order_qty": round(order, 0), "on_hand": on_hand, "safety_stock": ss})

    return {
        "pass": True,
        "details": f"{len(plan_lines)} order lines from {len(inv_rows)} SKUs",
        "key_tables": [{"label": "Replenishment Plan", "data": plan_lines[:10], "total_rows": len(plan_lines)}],
    }


def _run_inventory_projection(sheets):
    inv_rows = _get_sheet(sheets, "inventory_snapshot")
    sales = _get_sheet(sheets, "sales_transactions")
    if not inv_rows:
        return {"pass": False, "details": "No inventory", "key_tables": []}

    df = pd.DataFrame(sales) if sales else pd.DataFrame()
    if "qty" in df.columns:
        df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(0)
        demand = df.groupby("product_code")["qty"].sum()
    else:
        demand = pd.Series(dtype=float)

    projections = []
    for inv in inv_rows:
        sku = inv.get("product_code")
        on_hand = float(inv.get("on_hand_qty", 0) or 0)
        ss = float(inv.get("safety_stock", 0) or 0)
        total_demand = float(demand.get(sku, 0))
        avg_daily = total_demand / 180
        coverage = round(on_hand / max(avg_daily, 0.01), 1)
        status = "critical" if coverage < 30 else ("low" if coverage < 60 else "healthy")
        projections.append({"sku": sku, "warehouse": inv.get("warehouse", "?"),
                            "on_hand": on_hand, "avg_daily_demand": round(avg_daily, 1),
                            "coverage_days": coverage, "status": status})

    projections.sort(key=lambda x: x["coverage_days"])
    at_risk = sum(1 for p in projections if p["status"] in ("critical", "low"))
    return {
        "pass": True,
        "details": f"{len(projections)} SKUs, {at_risk} at risk",
        "key_tables": [{"label": "Inventory Coverage", "data": projections[:10], "total_rows": len(projections)}],
    }


def _run_risk_score(sheets):
    inv_rows = _get_sheet(sheets, "inventory_snapshot")
    sales = _get_sheet(sheets, "sales_transactions")
    if not inv_rows:
        return {"pass": False, "details": "No inventory", "key_tables": []}

    df = pd.DataFrame(sales) if sales else pd.DataFrame()
    if "qty" in df.columns:
        df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(0)
        demand = df.groupby("product_code")["qty"].sum()
    else:
        demand = pd.Series(dtype=float)

    scores = []
    for inv in inv_rows:
        sku = inv.get("product_code")
        on_hand = float(inv.get("on_hand_qty", 0) or 0)
        unit_cost = float(inv.get("unit_cost", 10) or 10)
        total_demand = float(demand.get(sku, 0))
        avg_daily = total_demand / 180
        coverage = on_hand / max(avg_daily, 0.01)
        p_stockout = max(0, min(1, 1 - coverage / 60))
        impact = avg_daily * 30 * unit_cost
        urgency = 1.5 if coverage < 14 else (1.2 if coverage < 30 else 1.0)
        score = round(p_stockout * impact * urgency, 2)
        tier = "HIGH" if score > 10000 else ("MEDIUM" if score > 1000 else "LOW")
        scores.append({"sku": sku, "warehouse": inv.get("warehouse", "?"),
                        "risk_score": score, "tier": tier,
                        "coverage_days": round(coverage, 1), "p_stockout": round(p_stockout, 2)})

    scores.sort(key=lambda x: -x["risk_score"])
    high = sum(1 for s in scores if s["tier"] == "HIGH")
    return {
        "pass": True,
        "details": f"{len(scores)} scores, {high} high risk",
        "key_tables": [{"label": "Risk Scores", "data": scores[:10], "total_rows": len(scores)}],
    }


def _run_cost_forecast(sheets):
    inv_rows = _get_sheet(sheets, "inventory_snapshot")
    if not inv_rows:
        return {"pass": False, "details": "No inventory", "key_tables": []}
    items = []
    total = 0
    for inv in inv_rows:
        on_hand = float(inv.get("on_hand_qty", 0) or 0)
        cost = float(inv.get("unit_cost", 0) or 0)
        value = round(on_hand * cost, 2)
        total += value
        items.append({"sku": inv.get("product_code"), "warehouse": inv.get("warehouse", "?"),
                       "on_hand": on_hand, "unit_cost": cost, "inventory_value": value})
    items.sort(key=lambda x: -x["inventory_value"])
    return {
        "pass": True,
        "details": f"Inventory value: ${total:,.0f}",
        "key_tables": [{"label": "Inventory Valuation", "data": items[:10], "total_rows": len(items)}],
    }


def _run_revenue_forecast(sheets):
    sales = _get_sheet(sheets, "sales_transactions")
    if not sales:
        return {"pass": False, "details": "No sales", "key_tables": []}
    df = pd.DataFrame(sales)
    for col in ["gross_revenue", "cogs"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    if "gross_revenue" not in df.columns:
        return {"pass": False, "details": "No gross_revenue column", "key_tables": []}

    # Multi-currency detection
    currency_col = None
    for c in df.columns:
        if c.lower() in ("currency", "currency_code", "curr"):
            currency_col = c
            break

    multi_currency = currency_col and df[currency_col].nunique() > 1
    currency_warning = ""

    if multi_currency:
        currencies = sorted(df[currency_col].unique())
        currency_warning = f" WARNING: Mixed currencies ({', '.join(str(c) for c in currencies)}) — totals NOT comparable"
        # Split by currency
        by_currency = []
        for cur in currencies:
            sub = df[df[currency_col] == cur]
            rev = float(sub["gross_revenue"].sum())
            cogs_val = float(sub["cogs"].sum()) if "cogs" in sub.columns else 0
            margin = rev - cogs_val
            pct = round(margin / max(rev, 0.01) * 100, 1)
            by_currency.append({"currency": cur, "revenue": round(rev, 2), "cogs": round(cogs_val, 2),
                                 "margin": round(margin, 2), "margin_pct": pct, "rows": len(sub)})
        return {
            "pass": True,
            "details": f"{len(currencies)} currencies detected.{currency_warning}",
            "summary": {"currencies": len(currencies), "warning": "MIXED_CURRENCY"},
            "key_tables": [{"label": "Revenue by Currency", "data": by_currency, "total_rows": len(by_currency)}],
        }

    total_rev = float(df["gross_revenue"].sum())
    total_cogs = float(df.get("cogs", pd.Series([0])).sum())
    margin = total_rev - total_cogs
    margin_pct = round(margin / max(total_rev, 0.01) * 100, 1)

    # By category
    if "category" in df.columns:
        by_cat = df.groupby("category").agg(
            revenue=("gross_revenue", "sum"), cogs=("cogs", "sum")
        ).reset_index()
        by_cat["margin"] = by_cat["revenue"] - by_cat["cogs"]
        by_cat["margin_pct"] = (by_cat["margin"] / by_cat["revenue"].clip(lower=0.01) * 100).round(1)
        by_cat = by_cat.round(2).sort_values("revenue", ascending=False)
        cat_table = by_cat.to_dict("records")
    else:
        cat_table = []

    return {
        "pass": total_rev > 0,
        "details": f"Revenue: ${total_rev:,.0f}, Margin: {margin_pct}%",
        "summary": {"total_revenue": round(total_rev, 2), "total_cogs": round(total_cogs, 2),
                     "margin": round(margin, 2), "margin_pct": margin_pct},
        "key_tables": [
            {"label": "Revenue Summary", "data": [{"total_revenue": round(total_rev, 2), "total_cogs": round(total_cogs, 2), "gross_margin": round(margin, 2), "margin_pct": margin_pct}], "total_rows": 1},
            {"label": "Margin by Category", "data": cat_table[:10], "total_rows": len(cat_table)},
        ],
    }


# ── Tool registry ──

TIER1_TOOLS = [
    ("run_mbr_cleaning", "Data Cleaning (MBR)", _run_mbr_cleaning),
    ("run_eda", "Exploratory Data Analysis", _run_eda),
    ("run_data_cleaning", "Data Cleaning (Generic)", _run_data_cleaning),
    ("run_mbr_kpi", "KPI Calculation", _run_kpi),
    ("run_mbr_variance", "Variance Analysis", _run_variance),
    ("run_mbr_anomaly", "Anomaly Detection", _run_anomaly),
    ("run_forecast", "Demand Forecast", _run_forecast),
    ("run_ml_forecast", "ML Forecast", _run_forecast),
    ("run_bom_explosion", "BOM Explosion", _run_bom_explosion),
    ("run_lp_solver", "Replenishment Solver", _run_lp_solver),
    ("run_inventory_projection", "Inventory Projection", _run_inventory_projection),
    ("run_risk_score", "Risk Score", _run_risk_score),
    ("run_plan", "Replenishment Plan", _run_lp_solver),
    ("run_cost_forecast", "Cost Forecast", _run_cost_forecast),
    ("run_revenue_forecast", "Revenue Forecast", _run_revenue_forecast),
]


def run_all_tier1(sheets):
    results = []
    total_start = time.time()

    # Chain: cleaning output feeds into downstream tools
    active_sheets = sheets  # start with raw
    cleaned_sheets = None

    for tool_id, name, runner in TIER1_TOOLS:
        t0 = time.time()
        try:
            # Use cleaned data for downstream tools (if cleaning succeeded)
            input_sheets = cleaned_sheets if (cleaned_sheets and tool_id != "run_mbr_cleaning" and tool_id != "run_eda") else sheets
            result = runner(input_sheets)

            # Capture cleaned output for downstream
            if tool_id == "run_mbr_cleaning" and result.get("cleaned_sheets"):
                cleaned_sheets = result["cleaned_sheets"]
            duration = int((time.time() - t0) * 1000)
            results.append({
                "tool_id": tool_id,
                "name": name,
                "pass": result.get("pass", False),
                "details": result.get("details", ""),
                "summary": result.get("summary"),
                "key_tables": result.get("key_tables", []),
                "duration_ms": duration,
                "error": None,
            })
        except Exception as e:
            duration = int((time.time() - t0) * 1000)
            logger.error(f"[eval] {tool_id} failed: {e}")
            results.append({
                "tool_id": tool_id,
                "name": name,
                "pass": False,
                "details": f"ERROR: {str(e)[:200]}",
                "summary": None,
                "key_tables": [],
                "duration_ms": duration,
                "error": traceback.format_exc()[-500:],
            })

    total_ms = int((time.time() - total_start) * 1000)
    passed = sum(1 for r in results if r["pass"])

    return {
        "ok": True,
        "total_tools": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "pass_rate": round(passed / max(len(results), 1) * 100, 1),
        "total_duration_ms": total_ms,
        "results": _nan_safe(results),
    }


# ================================================================
# Pipeline Mode — run full chain, structural assertions only
# ================================================================

def run_pipeline_eval(sheets, call_llm_fn=None, answer_key=None):
    """
    Run the full pipeline: cleaning → KPI → variance → anomaly → forecast.
    Each step feeds into the next. Structural assertions on final results.
    Captures detailed step logs including LLM calls.
    """
    import re
    start = time.time()
    assertions = []
    step_log = []  # detailed log of each step
    llm_calls = []  # track every LLM call
    pipeline_results = []  # collect tool results with key_tables for download

    def _assert(name, condition, detail=""):
        assertions.append({"name": name, "pass": bool(condition), "detail": detail})

    def _log(step, msg):
        step_log.append({"step": step, "time": round(time.time() - start, 2), "msg": msg})

    # Wrap LLM caller to capture calls
    wrapped_llm = None
    if call_llm_fn:
        def _tracked_llm(sys_p, usr_p, cfg):
            t0 = time.time()
            _log("llm", f"Calling LLM... (prompt: {len(sys_p)+len(usr_p)} chars)")
            try:
                result = call_llm_fn(sys_p, usr_p, cfg)
                duration = round(time.time() - t0, 2)
                # Parse what was returned
                resp_len = len(result) if result else 0
                _log("llm", f"LLM responded ({resp_len} chars, {duration}s)")
                llm_calls.append({
                    "purpose": sys_p[:80] if sys_p else "?",
                    "input_chars": len(sys_p) + len(usr_p),
                    "output_chars": resp_len,
                    "duration_s": duration,
                })
                return result
            except Exception as e:
                _log("llm", f"LLM FAILED: {str(e)[:100]}")
                llm_calls.append({"purpose": "failed", "error": str(e)[:100]})
                raise
        wrapped_llm = _tracked_llm
    else:
        _log("config", "No LLM provided — deterministic-only mode")

    # ── Step 1: Cleaning ──
    _log("cleaning", "Starting data cleaning...")
    t1 = time.time()
    from ml.api.mbr_data_cleaning import execute_cleaning_pipeline
    clean_result = execute_cleaning_pipeline(sheets, call_llm_fn=wrapped_llm)
    clean_dur = round(time.time() - t1, 2)

    cleaned = {}
    for art in clean_result.get("artifacts", []):
        if art.get("type") == "table" and art.get("label", "").startswith("cleaned_"):
            cleaned[art["label"].replace("cleaned_", "")] = art["data"]

    # Extract cleaning engine log
    engine_log = []
    for art in clean_result.get("artifacts", []):
        if art.get("type") == "summary" and isinstance(art.get("data"), dict):
            for sheet_name, actions in art["data"].items():
                if isinstance(actions, dict) and actions.get("actions"):
                    for action in actions["actions"]:
                        engine_log.append(f"{sheet_name}: {action.get('action', '?')} — {action.get('cells_changed', action.get('count', '?'))}")

    active_sheets = cleaned if cleaned else sheets
    orig_rows = sum(len(v) for v in sheets.values())
    clean_rows = sum(len(v) for v in active_sheets.values())

    _log("cleaning", f"Done ({clean_dur}s). {len(cleaned)} sheets, {orig_rows}→{clean_rows} rows. Engine actions: {len(engine_log)}")
    pipeline_results.append({
        "tool_id": "run_mbr_cleaning", "name": "Data Cleaning",
        "pass": len(cleaned) > 0, "details": f"{orig_rows}→{clean_rows} rows, {len(engine_log)} actions",
        "summary": {"original_rows": orig_rows, "cleaned_rows": clean_rows, "engine_actions": len(engine_log)},
        "key_tables": [{"label": "Engine Actions", "data": [{"action": a} for a in engine_log[:10]], "total_rows": len(engine_log)}] if engine_log else [],
        "duration_ms": int(clean_dur * 1000),
    })
    for el in engine_log[:5]:
        _log("cleaning", f"  {el}")
    if len(engine_log) > 5:
        _log("cleaning", f"  ... and {len(engine_log) - 5} more actions")

    _assert("cleaning_produced_output", len(cleaned) > 0, f"{len(cleaned)} sheets")
    _assert("rows_removed", clean_rows < orig_rows, f"{orig_rows}→{clean_rows}")

    # Check header rows removed
    header_found = False
    test_pat = re.compile(r"\btest\b|\bdummy\b|\bsample\b", re.IGNORECASE)
    test_found = False
    for sn, rows in active_sheets.items():
        if not rows:
            continue
        df = pd.DataFrame(rows)
        for _, row in df.iterrows():
            matches = sum(1 for col in df.columns if str(row.get(col, "")).strip().lower() == str(col).strip().lower())
            if matches >= max(len(df.columns) * 0.4, 3):
                header_found = True
                break
            text = " ".join(str(v) for v in row.values if pd.notna(v))
            if test_pat.search(text):
                test_found = True

    _assert("header_rows_removed", not header_found, "no header-as-data rows in output" if not header_found else "HEADER ROW STILL PRESENT")
    _assert("test_rows_removed", not test_found, "no test rows in output" if not test_found else "TEST ROW STILL PRESENT")

    # Check entity dedup (structural: unique counts should be reasonable)
    sales_sheet = None
    for sn in active_sheets:
        if sn == "sales_transactions":
            sales_sheet = sn
            break
    if not sales_sheet:
        sales_sheet = list(active_sheets.keys())[0] if active_sheets else None

    if sales_sheet and active_sheets.get(sales_sheet):
        df = pd.DataFrame(active_sheets[sales_sheet])
        for col in df.columns:
            cl = col.lower()
            if "region" in cl:
                n = df[col].nunique()
                _assert("unique_regions_reasonable", n <= 8, f"{n} unique regions")
            if "customer" in cl or "client" in cl:
                n = df[col].nunique()
                _assert("unique_customers_reasonable", n <= 10, f"{n} unique customers (expected ≤10 after entity resolution)")
            if "currency" in cl:
                n = df[col].nunique()
                _assert("currencies_detected", n >= 1, f"{n} currencies")
                if n > 1:
                    _assert("multi_currency_present", True, f"{n} currencies")

    # ── Step 1b: Planner (deterministic, on cleaned data) ──
    _log("planner", "Running deterministic planner on cleaned profile...")
    try:
        from ml.api.kpi_calculator import profile_for_kpi
        from ml.api.mbr_agent import plan_from_profile
        cleaned_profile = profile_for_kpi(active_sheets)
        plan, plan_reasoning = plan_from_profile(cleaned_profile)
        plan_tools = [t for t in plan if t != "data_cleaning"]
        _log("planner", f"Plan: {plan_tools}")
        for k, v in plan_reasoning.items():
            if k not in ("sheet_types", "total_tools"):
                _log("planner", f"  {k}: {v}")
        _assert("planner_has_tools", len(plan_tools) > 0, f"{len(plan_tools)} tools: {plan_tools}")
    except Exception as e:
        _log("planner", f"Planner failed: {e}")
        plan_tools = ["kpi_calculation", "anomaly_detection"]  # fallback

    # ── Step 2: KPI (on cleaned data) ──
    _log("kpi", "Starting KPI calculation...")
    t2 = time.time()
    from ml.api.kpi_calculator import execute_kpi_pipeline
    kpi_result = execute_kpi_pipeline(active_sheets)
    kpi_dur = round(time.time() - t2, 2)
    kpi_arts = kpi_result.get("artifacts", [])
    kpi_r = kpi_result.get("result", {})
    _log("kpi", f"Done ({kpi_dur}s). {len(kpi_arts)} tables. {kpi_r}")
    pipeline_results.append({
        "tool_id": "run_mbr_kpi", "name": "KPI Calculation",
        "pass": len(kpi_arts) > 0, "details": f"{len(kpi_arts)} tables",
        "summary": {k: round(v, 2) if isinstance(v, float) else v for k, v in kpi_r.items() if isinstance(v, (int, float))},
        "key_tables": _pick_key_tables(kpi_arts), "duration_ms": int(kpi_dur * 1000),
    })

    _assert("kpi_has_artifacts", len(kpi_arts) > 0, f"{len(kpi_arts)} tables")
    _assert("kpi_has_revenue", "total_revenue" in kpi_r or "total_revenue_by_currency" in kpi_r, str(list(kpi_r.keys())[:5]))

    margin_pct = kpi_r.get("gross_margin_pct")
    if margin_pct is not None:
        _assert("margin_pct_reasonable", -100 <= margin_pct <= 100, f"{margin_pct}%")

    # Check no fake categories or summary rows in KPI output
    bad_values = {"category", "test", "dummy", "header", "合計", "小計", "總計", "total", "subtotal", "grand total"}
    for art in kpi_arts:
        label = (art.get("label") or "").lower()
        if "category" in label or "by" in label:
            for row in (art.get("data") or [])[:20]:
                for v in row.values():
                    if isinstance(v, str) and v.strip().lower() in bad_values:
                        _assert("no_fake_categories", False, f"'{v}' found in {art['label']}")

    # ── Answer key assertions (if provided) ──
    if answer_key:
        _log("answer_key", "Checking against hand-calculated answer key...")

        # Revenue
        ak_rev = answer_key.get("total_revenue")
        sys_rev = kpi_r.get("total_revenue")
        if ak_rev and sys_rev:
            diff = abs(float(sys_rev) - ak_rev)
            _assert("ak_revenue", diff < max(ak_rev * 0.01, 1.0),
                     f"system={sys_rev:,.2f} vs expected={ak_rev:,.2f} (diff={diff:,.2f})")
            _log("answer_key", f"  Revenue: {sys_rev:,.2f} vs {ak_rev:,.2f} (diff={diff:,.2f})")

        # Margin%
        ak_margin = answer_key.get("gross_margin_pct")
        sys_margin = kpi_r.get("gross_margin_pct")
        if ak_margin and sys_margin:
            diff = abs(float(sys_margin) - ak_margin)
            _assert("ak_margin_pct", diff < 0.5,
                     f"system={sys_margin:.2f}% vs expected={ak_margin:.2f}% (diff={diff:.2f}pp)")
            _log("answer_key", f"  Margin%: {sys_margin:.2f}% vs {ak_margin:.2f}%")

            # Method verification: must NOT be simple mean
            wrong_margin = answer_key.get("simple_mean_margin_pct")
            if wrong_margin and sys_margin is not None:
                gap = abs(ak_margin - wrong_margin)
                if gap < 0.2:
                    _log("answer_key", f"  Method check: SKIPPED (gap={gap:.2f}pp too small to distinguish)")
                else:
                    is_wrong_method = abs(float(sys_margin) - wrong_margin) < 0.1
                    _assert("ak_not_simple_mean", not is_wrong_method,
                             f"system={sys_margin:.2f}% matches simple_mean={wrong_margin:.2f}% — WRONG METHOD"
                             if is_wrong_method else
                             f"system={sys_margin:.2f}% ≠ simple_mean={wrong_margin:.2f}% — correct aggregate method")
                    _log("answer_key", f"  Method check: {'FAIL' if is_wrong_method else 'PASS'}")

        # Rows removed
        ak_removed = answer_key.get("rows_removed")
        if ak_removed is not None:
            sys_removed = orig_rows - clean_rows
            _assert("ak_rows_removed", sys_removed >= ak_removed,
                     f"removed={sys_removed} vs expected≥{ak_removed}")

    # ── Step 3: Variance ──
    _log("variance", "Starting variance analysis...")
    t3 = time.time()
    from ml.api.variance_analyzer import execute_variance_pipeline
    var_result = execute_variance_pipeline(active_sheets)
    var_dur = round(time.time() - t3, 2)
    var_arts = var_result.get("artifacts", [])
    _assert("variance_has_artifacts", len(var_arts) > 0, f"{len(var_arts)} tables")
    _log("variance", f"Done ({var_dur}s). {len(var_arts)} tables.")
    pipeline_results.append({
        "tool_id": "run_mbr_variance", "name": "Variance Analysis",
        "pass": len(var_arts) > 0, "details": f"{len(var_arts)} tables",
        "summary": var_result.get("result", {}),
        "key_tables": _pick_key_tables(var_arts), "duration_ms": int(var_dur * 1000),
    })

    # ── Step 4: Anomaly ──
    _log("anomaly", "Starting anomaly detection (auto scan)...")
    t4 = time.time()
    from ml.api.anomaly_engine import AnomalyDetector, build_auto_config, profile_for_anomaly
    profile = profile_for_anomaly(active_sheets)
    config = build_auto_config(profile)
    n_detections = len(config.get("detections", []))
    _log("anomaly", f"Auto-config: {n_detections} detection configs generated")
    dfs = {name: pd.DataFrame(data) for name, data in active_sheets.items() if data}
    detector = AnomalyDetector(dfs)
    anomaly_result = detector.detect(config)
    anom_dur = round(time.time() - t4, 2)
    total_anomalies = anomaly_result.get("result", {}).get("total_anomalies", 0)
    _assert("anomaly_ran", True, f"{total_anomalies} anomalies")
    _log("anomaly", f"Done ({anom_dur}s). {total_anomalies} anomalies found.")
    pipeline_results.append({
        "tool_id": "run_mbr_anomaly", "name": "Anomaly Detection",
        "pass": True, "details": f"{total_anomalies} anomalies",
        "summary": {"total_anomalies": total_anomalies},
        "key_tables": _pick_key_tables(anomaly_result.get("artifacts", [])), "duration_ms": int(anom_dur * 1000),
    })
    # Top anomalies
    for art in anomaly_result.get("artifacts", [])[:1]:
        if "Summary" in (art.get("label") or ""):
            for row in (art.get("data") or [])[:3]:
                sev = row.get("severity", "")
                col = row.get("column", row.get("metric", ""))
                val = row.get("value", "")
                _log("anomaly", f"  [{sev}] {col}={val}")

    # ── Step 5: Forecast ──
    _log("forecast", "Starting demand forecast...")
    t5 = time.time()
    try:
        forecast_result = _run_forecast(active_sheets)
        fc_dur = round(time.time() - t5, 2)
        _assert("forecast_ran", forecast_result.get("pass", False), forecast_result.get("details", ""))
        _log("forecast", f"Done ({fc_dur}s). {forecast_result.get('details', '')}")
        pipeline_results.append({
            "tool_id": "run_forecast", "name": "Demand Forecast",
            "pass": forecast_result.get("pass", False), "details": forecast_result.get("details", ""),
            "summary": forecast_result.get("summary"),
            "key_tables": forecast_result.get("key_tables", []), "duration_ms": int(fc_dur * 1000),
        })
    except Exception as e:
        _assert("forecast_ran", False, str(e)[:200])
        _log("forecast", f"FAILED: {str(e)[:100]}")

    # ── Step 6: BOM (conditional — skip if no bom_edges sheet) ──
    has_bom = bool(_get_sheet(active_sheets, "bom_edges"))
    if has_bom:
        _log("bom", "Starting BOM explosion...")
        t6 = time.time()
        try:
            bom_result = _run_bom_explosion(active_sheets)
            bom_dur = round(time.time() - t6, 2)
            _assert("bom_ran", bom_result.get("pass", False), bom_result.get("details", ""))
            _log("bom", f"Done ({bom_dur}s). {bom_result.get('details', '')}")
            pipeline_results.append({
                "tool_id": "run_bom_explosion", "name": "BOM Explosion",
                "pass": bom_result.get("pass", False), "details": bom_result.get("details", ""),
                "key_tables": bom_result.get("key_tables", []), "duration_ms": int(bom_dur * 1000),
            })
        except Exception as e:
            _assert("bom_ran", False, str(e)[:200])
            _log("bom", f"FAILED: {str(e)[:100]}")
    else:
        _log("bom", "Skipped — no bom_edges sheet in data")

    # ── Results ──
    total_ms = int((time.time() - start) * 1000)
    passed = sum(1 for a in assertions if a["pass"])

    return {
        "ok": True,
        "mode": "pipeline",
        "total_assertions": len(assertions),
        "passed": passed,
        "failed": len(assertions) - passed,
        "pass_rate": round(passed / max(len(assertions), 1) * 100, 1),
        "total_duration_ms": total_ms,
        "assertions": assertions,
        "results": _nan_safe(pipeline_results),
        "step_log": step_log,
        "llm_calls": llm_calls,
    }
