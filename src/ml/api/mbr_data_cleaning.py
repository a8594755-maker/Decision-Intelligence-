"""
mbr_data_cleaning.py — Phase 1 complete implementation.
Replaces the data cleaning logic in tool_executor.py.

Usage:
  from mbr_data_cleaning import execute_cleaning_pipeline

  result = execute_cleaning_pipeline(
      sheets_dict=input_data["sheets"],
      user_rules="...",   # from frontend, can be empty
      call_llm_fn=your_existing_llm_call,
      llm_config={"provider":"deepseek","model":"deepseek-chat"}
  )

Dependencies: pandas, numpy, re, json, collections (all in sandbox)
No external deps: no fuzzywuzzy, thefuzz, os, sys, open, network
"""

import pandas as pd
import numpy as np
import re
import json
from collections import Counter


# ================================================================
# Part 1: DATA PROFILER
# ================================================================

def _is_text_dtype(series_or_col):
    """Check if a Series has text values (handles both object and StringDtype)."""
    return pd.api.types.is_object_dtype(series_or_col) or pd.api.types.is_string_dtype(series_or_col)


def profile_sheet(df, sheet_name, max_unique_display=50):
    """
    Produce a structured data quality report for a single sheet.
    Pure Python, no LLM needed. ~50ms per sheet.
    """
    profile = {
        "sheet_name": sheet_name,
        "row_count": len(df),
        "column_count": len(df.columns),
        "issues_detected": [],
        "columns": {}
    }

    # -- Sheet-level issue detection --

    # Exact duplicate rows
    dup_count = int(df.duplicated().sum())
    if dup_count > 0:
        dup_mask = df.duplicated(keep=False)
        profile["issues_detected"].append({
            "type": "duplicate_rows",
            "count": dup_count,
            "examples": df[dup_mask].head(4).to_dict("records")
        })

    # Header repeated as data (common CSV merge issue)
    # Lowered threshold: 40% match is enough (some columns may have valid values)
    header_rows = []
    for idx, row in df.iterrows():
        matches = sum(
            1 for col in df.columns
            if str(row.get(col, "")).strip().lower() == str(col).strip().lower()
        )
        if matches >= max(len(df.columns) * 0.4, 3):
            header_rows.append(int(idx))
    if header_rows:
        profile["issues_detected"].append({
            "type": "header_repeated_as_data",
            "row_indices": header_rows
        })

    # Mostly empty rows (>80% null)
    mostly_empty = []
    for idx, row in df.iterrows():
        null_ratio = row.isnull().sum() / max(len(df.columns), 1)
        if null_ratio > 0.8:
            mostly_empty.append(int(idx))
    if mostly_empty:
        profile["issues_detected"].append({
            "type": "mostly_empty_rows",
            "count": len(mostly_empty),
            "row_indices": mostly_empty[:10]
        })

    # Suspected test data
    test_pat = re.compile(
        r"\btest\b|\bdummy\b|\bsample\b|\bxxx\b|\bfoo\b|\bbar\b",
        re.IGNORECASE
    )
    test_rows = []
    for idx, row in df.iterrows():
        text = " ".join(str(v) for v in row.values if pd.notna(v))
        if test_pat.search(text):
            test_rows.append({"index": int(idx), "preview": text[:120]})
    if test_rows:
        profile["issues_detected"].append({
            "type": "suspected_test_data",
            "rows": test_rows[:5]
        })

    # Summary/total rows (合計, Total, Grand Total, Subtotal)
    # These rows aggregate other rows and should be removed before analysis
    summary_pat = re.compile(
        r"^(合計|小計|總計|total|grand\s*total|subtotal|sum|合\s*計|小\s*計)$",
        re.IGNORECASE
    )
    summary_rows = []
    for idx, row in df.iterrows():
        for val in row.values:
            if pd.notna(val) and isinstance(val, str) and summary_pat.match(val.strip()):
                summary_rows.append({"index": int(idx), "preview": str(row.values[:4])[:120]})
                break
    if summary_rows:
        profile["issues_detected"].append({
            "type": "summary_total_rows",
            "count": len(summary_rows),
            "row_indices": [r["index"] for r in summary_rows],
            "rows": summary_rows[:5]
        })

    # -- Column-level analysis --

    for col in df.columns:
        series = df[col]
        non_null = series.dropna()
        cp = {
            "null_count": int(series.isnull().sum()),
            "null_pct": round(series.isnull().sum() / max(len(df), 1) * 100, 1),
            "unique_count": int(series.nunique()),
        }

        if len(non_null) == 0:
            cp["status"] = "all_null"
            profile["columns"][col] = cp
            continue

        # Unique values (core: lets LLM see all variants)
        if series.nunique() <= max_unique_display:
            vc = series.value_counts()
            cp["value_counts"] = {str(k): int(v) for k, v in vc.items()}
        else:
            cp["sample_head"] = [str(x) for x in non_null.head(3).tolist()]
            cp["sample_tail"] = [str(x) for x in non_null.tail(3).tolist()]
            cp["most_common"] = {
                str(k): int(v)
                for k, v in series.value_counts().head(10).items()
            }
            cp["least_common"] = {
                str(k): int(v)
                for k, v in series.value_counts().tail(5).items()
            }

        # Date format detection
        if _is_text_dtype(series):
            patterns = [
                ("YYYY-MM-DD", r"^\d{4}-\d{1,2}-\d{1,2}$"),
                ("YYYY/MM/DD", r"^\d{4}/\d{1,2}/\d{1,2}$"),
                ("DD/MM/YYYY or MM/DD/YYYY", r"^\d{1,2}/\d{1,2}/\d{4}$"),
                ("YYYY.MM.DD", r"^\d{4}\.\d{1,2}\.\d{1,2}$"),
                ("DD.MM.YYYY", r"^\d{1,2}\.\d{1,2}\.\d{4}$"),
                ("DD-Mon-YYYY", r"^\d{1,2}-[A-Za-z]{3}-\d{4}$"),
                ("Excel_Serial", r"^\d{5}$"),
            ]
            fmt_counts = Counter()
            for val in non_null.astype(str):
                v = val.strip()
                matched = False
                for fmt_name, pat in patterns:
                    if re.match(pat, v):
                        fmt_counts[fmt_name] += 1
                        matched = True
                        break
                if not matched:
                    fmt_counts["other"] += 1

            total_matched = sum(fmt_counts.values())
            if total_matched > 0 and fmt_counts.get("other", 0) < len(non_null) * 0.5:
                cp["date_formats_detected"] = dict(fmt_counts)
                date_fmt_count = len([k for k in fmt_counts if k != "other"])
                if date_fmt_count > 1:
                    cp["issue"] = "mixed_date_formats"

        # Numeric analysis
        numeric = pd.to_numeric(non_null, errors="coerce")
        num_ratio = numeric.notna().sum() / max(len(non_null), 1)

        if num_ratio > 0.7:
            valid = numeric.dropna()
            if len(valid) > 0:
                cp["numeric_stats"] = {
                    "min": round(float(valid.min()), 2),
                    "max": round(float(valid.max()), 2),
                    "mean": round(float(valid.mean()), 2),
                    "median": round(float(valid.median()), 2),
                }
            non_num = non_null[numeric.isna()]
            if len(non_num) > 0:
                cp["non_numeric_values"] = {
                    str(k): int(v)
                    for k, v in non_num.value_counts().head(10).items()
                }
                cp["issue"] = "mixed_numeric_and_text"

            # IQR outlier
            if len(valid) > 4:
                q1, q3 = valid.quantile(0.25), valid.quantile(0.75)
                iqr = q3 - q1
                if iqr > 0:
                    outliers = valid[
                        (valid < q1 - 1.5 * iqr) | (valid > q3 + 1.5 * iqr)
                    ]
                    if len(outliers) > 0:
                        cp["outliers"] = {
                            "count": len(outliers),
                            "values": sorted(outliers.tolist())[:10],
                        }

        # Leading/trailing whitespace
        if _is_text_dtype(series):
            try:
                as_str = non_null.astype(str)
                stripped = as_str.str.strip()
                with_spaces = non_null[stripped != as_str].dropna()
                if len(with_spaces) > 0:
                    cp["leading_trailing_spaces"] = {
                        "count": len(with_spaces),
                        "examples": [repr(x) for x in with_spaces.head(3).tolist()],
                    }
            except Exception:
                pass

        # Placeholder values
        placeholders = [
            "N/A", "n/a", "NA", "NULL", "null", "None", "none",
            "TBD", "TBA", "#N/A", "#ERROR", "#REF!", "#VALUE!", "#NAME?",
            "-", "--", "---",
            "9999-12-31", "1900-01-01", "0000-00-00",
            "DUMMY", "dummy", "PLACEHOLDER",
        ]
        found = {}
        for ph in placeholders:
            cnt = (non_null.astype(str).str.strip() == ph).sum()
            if cnt > 0:
                found[ph] = int(cnt)
        if found:
            cp["placeholders_detected"] = found

        # Comma decimal (European format)
        if _is_text_dtype(series):
            comma_dec = non_null[
                non_null.astype(str).str.match(r"^\d+,\d+$", na=False)
            ]
            if len(comma_dec) > 0:
                cp["comma_decimal_values"] = {
                    "count": len(comma_dec),
                    "examples": comma_dec.head(5).tolist(),
                }

        # Currency symbols/codes mixed in numbers (US$, USD, EUR, JPY, TWD, etc.)
        if _is_text_dtype(series):
            currency_in = non_null[
                non_null.astype(str).str.match(
                    r"^(?:[\$\u20ac\u00a3\u00a5]|US\$|USD|EUR|JPY|TWD|KRW|RMB)\s*[\d,]+\.?\d*$",
                    na=False, case=False
                )
            ]
            if len(currency_in) > 0:
                cp["currency_symbols_in_values"] = {
                    "count": len(currency_in),
                    "examples": currency_in.head(3).tolist(),
                }

        # Numeric values with unit suffixes (e.g. 480g, 0.15kg, 200 grams, 5ml)
        if _is_text_dtype(series):
            unit_pattern = r"^\s*[\d,.]+\s*(?:g|kg|grams?|lbs?|oz|ml|l|liters?|litres?|cm|mm|m|km|pcs?|units?|ea)\s*$"
            unit_vals = non_null[
                non_null.astype(str).str.match(unit_pattern, na=False, case=False)
            ]
            if len(unit_vals) > 0:
                cp["numeric_with_units"] = {
                    "count": len(unit_vals),
                    "examples": unit_vals.head(5).tolist(),
                }
                cp["issue"] = "numeric_with_units"

        profile["columns"][col] = cp

    # -- Cross-column logic checks --

    cross = []
    num_cols = [
        c for c in df.columns
        if pd.to_numeric(df[c], errors="coerce").notna().sum() > len(df) * 0.5
    ]

    # Auto-detect A = B - C
    if len(num_cols) <= 15:
        for i, a in enumerate(num_cols):
            for j, b in enumerate(num_cols):
                if i == j:
                    continue
                for k, c in enumerate(num_cols):
                    if k == i or k == j:
                        continue
                    va = pd.to_numeric(df[a], errors="coerce")
                    vb = pd.to_numeric(df[b], errors="coerce")
                    vc = pd.to_numeric(df[c], errors="coerce")
                    valid = va.notna() & vb.notna() & vc.notna()
                    if valid.sum() < 5:
                        continue
                    diff = (va[valid] - (vb[valid] - vc[valid])).abs()
                    ratio = (diff < 0.01).sum() / valid.sum()
                    if 0.6 < ratio < 1.0:
                        bad = df[valid & (diff >= 0.01)]
                        cross.append({
                            "type": "arithmetic_mismatch",
                            "rule": f"{a} \u2260 {b} - {c} (matches {ratio:.0%})",
                            "mismatch_count": int(len(bad)),
                            "examples": bad[[a, b, c]].head(3).to_dict("records"),
                        })

    # Auto-detect A = B * C (e.g., total_cost = qty * unit_cost)
    for c1 in num_cols:
        c1l = c1.lower()
        for c2 in num_cols:
            if c1 == c2:
                continue
            c2l = c2.lower()
            for c3 in num_cols:
                if c3 == c1 or c3 == c2:
                    continue
                c3l = c3.lower()
                # Detect total/amount = qty/quantity * price/cost/rate
                is_total = any(kw in c1l for kw in ["total", "amount", "subtotal"])
                is_qty = any(kw in c2l for kw in ["qty", "quantity", "count", "units"])
                is_price = any(kw in c3l for kw in ["price", "cost", "rate", "unit_price", "unit_cost"])
                if is_total and is_qty and is_price:
                    va = pd.to_numeric(df[c1], errors="coerce")
                    vb = pd.to_numeric(df[c2], errors="coerce")
                    vc = pd.to_numeric(df[c3], errors="coerce")
                    valid = va.notna() & vb.notna() & vc.notna() & (vb > 0) & (vc > 0)
                    if valid.sum() < 3:
                        continue
                    calc = (vb[valid] * vc[valid]).round(2)
                    rel_diff = ((va[valid] - calc).abs() / calc.clip(lower=0.01))
                    match_ratio = (rel_diff < 0.05).sum() / valid.sum()
                    if 0.5 < match_ratio < 1.0:
                        mismatch = valid & (
                            ((va - (vb * vc).round(2)).abs() /
                             (vb * vc).clip(lower=0.01).round(2)) >= 0.05
                        )
                        bad = df[mismatch]
                        if len(bad) > 0:
                            cross.append({
                                "type": "multiplication_mismatch",
                                "rule": f"{c1} \u2260 {c2} \u00d7 {c3} (matches {match_ratio:.0%})",
                                "mismatch_count": int(len(bad)),
                                "examples": bad[[c1, c2, c3]].head(3).to_dict("records"),
                            })

    # Auto-detect A > B logical violations
    for c1 in num_cols:
        for c2 in num_cols:
            if c1 == c2:
                continue
            c1l, c2l = c1.lower(), c2.lower()
            is_pair = False
            if ("receiv" in c1l or "fulfill" in c1l) and "order" in c2l:
                is_pair = True
            if "cost" in c1l and "revenue" in c2l:
                is_pair = True
            if "cogs" in c1l and "revenue" in c2l:
                is_pair = True
            if is_pair:
                v1 = pd.to_numeric(df[c1], errors="coerce")
                v2 = pd.to_numeric(df[c2], errors="coerce")
                mask = v1.notna() & v2.notna()
                violations = df[mask & (v1 > v2)]
                if len(violations) > 0:
                    cross.append({
                        "type": "logical_violation",
                        "rule": f"{c1} > {c2}",
                        "count": int(len(violations)),
                        "examples": violations[[c1, c2]]
                        .head(3)
                        .to_dict("records"),
                    })

    # Date order checks (auto-detect chronological date pairs)
    date_col_candidates = [
        c
        for c in df.columns
        if any(
            kw in c.lower()
            for kw in [
                "date", "time", "day", "expir", "deliver", "due",
                "start", "end", "create", "update", "birth",
            ]
        )
    ]
    for i, d1 in enumerate(date_col_candidates):
        for d2 in date_col_candidates[i + 1:]:
            d1l, d2l = d1.lower(), d2.lower()
            # Infer which should come first
            early_kws = ["order", "start", "create", "birth", "snapshot", "open", "invoice", "issue", "submit", "entry", "purchase"]
            late_kws = ["deliver", "due", "end", "expir", "close", "expect", "maturity", "payment", "ship", "receive", "fulfill", "pay"]
            d1_early = any(kw in d1l for kw in early_kws)
            d2_late = any(kw in d2l for kw in late_kws)
            d1_late = any(kw in d1l for kw in late_kws)
            d2_early = any(kw in d2l for kw in early_kws)
            if (d1_early and d2_late) or (d2_early and d1_late):
                try:
                    t1 = pd.to_datetime(df[d1], errors="coerce")
                    t2 = pd.to_datetime(df[d2], errors="coerce")
                    if d1_early and d2_late:
                        bad = df[(t2 < t1) & t1.notna() & t2.notna()]
                        rule_str = f"{d2} < {d1}"
                    else:
                        bad = df[(t1 < t2) & t1.notna() & t2.notna()]
                        rule_str = f"{d1} < {d2}"
                    if len(bad) > 0:
                        cross.append({
                            "type": "date_order_violation",
                            "rule": rule_str,
                            "count": int(len(bad)),
                            "examples": bad[[d1, d2]]
                            .head(3)
                            .to_dict("records"),
                        })
                except Exception:
                    pass

    if cross:
        profile["cross_column_issues"] = cross

    return profile


def profile_workbook(sheets_dict):
    """Profile entire workbook + cross-sheet checks."""
    profiles = {}
    for name, data in sheets_dict.items():
        if not data:
            continue
        df = pd.DataFrame(data)
        profiles[name] = profile_sheet(df, name)

    # Cross-sheet ID consistency
    id_cols = {}
    for name, data in sheets_dict.items():
        df = pd.DataFrame(data)
        for col in df.columns:
            cl = col.lower()
            if any(
                kw in cl
                for kw in ["sku", "_id", "item_sku", "fg_sku", "product", "code"]
            ):
                vals = set(df[col].dropna().astype(str).str.strip())
                if vals:
                    id_cols.setdefault(name, {})[col] = vals

    cross_sheet = []
    checked = set()
    for s1, cols1 in id_cols.items():
        for c1, v1 in cols1.items():
            for s2, cols2 in id_cols.items():
                if s1 == s2:
                    continue
                for c2, v2 in cols2.items():
                    key = tuple(sorted([(s1, c1), (s2, c2)]))
                    if key in checked:
                        continue
                    checked.add(key)
                    overlap = v1 & v2
                    if len(overlap) > 2:
                        o1 = v1 - v2
                        o2 = v2 - v1
                        if o1 or o2:
                            cross_sheet.append({
                                "sheet1": s1, "col1": c1,
                                "sheet2": s2, "col2": c2,
                                "overlap": len(overlap),
                                "only_in_sheet1": sorted(list(o1))[:10],
                                "only_in_sheet2": sorted(list(o2))[:10],
                            })

    return {"sheet_profiles": profiles, "cross_sheet_issues": cross_sheet}


# ================================================================
# Part 2: LLM PROMPT BUILDER
# ================================================================

def _find_columns_needing_mapping(profile_result, user_rules="", historical_mappings=None):
    """
    Find columns with variants from the profile.
    Filters out values already covered by historical_mappings.
    """
    hist = historical_mappings or {}

    # Extract column names mentioned in user_rules (case-insensitive)
    user_mentioned_cols = set()
    if user_rules:
        rules_lower = user_rules.lower()
        for sheet_name, sp in profile_result["sheet_profiles"].items():
            for col_name in sp["columns"]:
                if col_name.lower() in rules_lower:
                    user_mentioned_cols.add((sheet_name, col_name))

    columns = {}
    for sheet_name, sp in profile_result["sheet_profiles"].items():
        for col_name, col_info in sp["columns"].items():
            vc = col_info.get("value_counts")
            if not vc:
                continue
            unique_count = col_info.get("unique_count", 0)
            if unique_count > 50 or unique_count < 2:
                if (sheet_name, col_name) not in user_mentioned_cols:
                    continue
            if col_info.get("numeric_stats") and not col_info.get("non_numeric_values"):
                if (sheet_name, col_name) not in user_mentioned_cols:
                    continue

            # Skip ID-like columns (unless user explicitly mentioned them)
            col_lower = col_name.lower()
            is_id_col = any(
                kw in col_lower
                for kw in ["_id", "sku", "number", "code", "lot"]
            )
            if is_id_col and (sheet_name, col_name) not in user_mentioned_cols:
                continue

            col_key = f"{sheet_name}.{col_name}"

            # Filter out values already in historical mappings
            hist_for_col = hist.get(col_key, {})
            if hist_for_col:
                hist_keys = set(hist_for_col.keys())
                hist_vals = set(hist_for_col.values())
                covered = hist_keys | hist_vals
                remaining_vc = {k: v for k, v in vc.items() if str(k) not in covered}
                if not remaining_vc or len(remaining_vc) < 2:
                    continue
                vc = remaining_vc

            normalized = {}
            for val in vc.keys():
                key = str(val).strip().lower()
                key = re.sub(r"[.,;:!\s]+", " ", key).strip()
                normalized.setdefault(key, []).append(str(val))

            has_variants = any(len(v) > 1 for v in normalized.values())
            low_cardinality = unique_count <= 20
            user_forced = (sheet_name, col_name) in user_mentioned_cols

            if has_variants or low_cardinality or user_forced:
                columns[col_key] = vc

    return columns


def build_llm_prompt(profile_result, user_rules="", historical_mappings=None):
    """
    Build prompt for LLM. LLM only returns JSON mapping, no code.
    Filters out values already covered by historical_mappings.
    """
    columns = _find_columns_needing_mapping(profile_result, user_rules, historical_mappings)
    if not columns:
        return None, None

    system_prompt = """You are a data standardization expert.
You receive columns that contain multiple variants of the same values.
Return a JSON mapping from variant to canonical name.

RULES:

1. CANONICAL SELECTION - how to pick the right canonical value:
   a) For ENTITY NAMES (companies, suppliers, customers, people):
      - Prefer proper mixed-case with suffix: "SteelCo Ltd" over "STEELCO LTD" or "STEELCO" or "SteelCo"
      - Prefer formal registered name: "PlastiPak Inc" over "PLASTIPAK" or "Plastipak"
      - ALL-CAPS variants are almost never the canonical form
   b) For LOCATION / CODE columns:
      - Prefer short hyphenated system codes: "WH-East" over "Warehouse East" or "WH East"
      - Short codes are master data IDs; long names are display labels
   c) For CATEGORY values (priority, status, region, type):
      - Prefer human-readable LABELS over numeric codes: "High" over "1", "Medium" over "2"
      - Prefer standard abbreviations over full names: "APAC" over "Asia Pacific", "EMEA" over "Europe"
      - ALL categories in the same column must map to the SAME style (all text or all codes, not mixed)
   d) When two variants have similar frequency, pick the one that looks like
      a system master value, not a casual human entry.

2. Keep genuinely DIFFERENT entities SEPARATE - do NOT merge them.
   Example: "Costco Asia" (regional subsidiary) vs "Costco Wholesale" (US parent)
   might be different entities. Only merge if they are clearly the same.

3. SEMANTIC OPPOSITES - if a column has only 2-3 distinct values that are
   semantically opposite or represent different states, NEVER merge them:
   - Active/Inactive, Open/Closed, Yes/No, True/False, Enabled/Disabled
   - Even if one is ALL-CAPS ("INACTIVE") and the other is mixed-case ("Active"),
     they are DIFFERENT values. Only fix casing, do not merge.
   - Map "INACTIVE" -> "Inactive", not "INACTIVE" -> "Active".

4. Fix obvious typos: "Costco Aisa" -> "Costco Asia", "UDS" -> "USD"

5. Fix case/spacing/punctuation variants: "costco asia " -> "Costco Asia"

5b. CROSS-LANGUAGE ENTITY MERGE - the same real-world entity written in different
    languages MUST be merged into ONE canonical name:
    - "全聯" = "全聯福利中心" = "PX Mart" → pick ONE canonical (prefer English if mixed)
    - "家樂福" = "Carrefour" = "家樂福量販" → "Carrefour"
    - "好市多" = "Costco" = "COSTCO" → "Costco"
    - "台幣" = "新台幣" = "TWD" = "NTD" = "NT$" → "TWD"
    - "美金" = "美元" = "USD" = "US$" → "USD"
    This applies to ALL columns: customers, suppliers, currencies, regions, etc.
    If you see Chinese + English names for the same entity, ALWAYS merge them.

6. COMPLETENESS - map ALL variants, not just some. If a column has 5 different
   spellings of the same entity, all 5 must appear in the mapping (except the
   canonical one itself). Do not skip variants.

7. STYLE CONSISTENCY within a column - if most values in a column use the same
   style (e.g., abbreviations like APAC, AMER, EMEA), map ALL values to that
   style. Do not mix full names with abbreviations in the same column.
   Example: if a region column has APAC(10), Americas(5), EMEA(3), Europe(2),
   map to: Americas->AMER, Europe->EMEA (because APAC/EMEA are already abbreviations).

8. Values that exactly match the column name (header repeated as data) -> "__HEADER_ROW__"

9. SYSTEM VALUES are NOT test data. Values like "SYSTEM", "MIGRATION", "AUTO",
   "BATCH", "IMPORT", "API", "SCHEDULED" are legitimate system-generated entries.
   Do NOT map them to "__TEST_DATA__". Only map values that are clearly fake/test
   (e.g., "Test Customer", "DUMMY", "foo", "xxx").

10. Do NOT map empty strings "". Leave them out of the mapping entirely.

## SCHEMA STANDARDIZATION (sheet names + column names)

In addition to entity value mappings, ALSO provide:

11. "sheet_mappings": Map each sheet name to its canonical English name.
    Canonical names: sales_transactions, monthly_budget, inventory_snapshot,
    supplier_invoices, expense_reports, bom_edges.
    Only include sheets that need renaming (non-English or non-canonical names).

12. "column_mappings": For each sheet, map non-English or non-standard column
    names to canonical English names. Common canonical names:
    order_date, product_code, product_name, category, region, customer_name,
    qty, unit_price, gross_revenue, cogs, currency, payment_status, channel,
    period, revenue_target, qty_target,
    on_hand_qty, safety_stock, unit_cost, warehouse, lead_time_days, moq,
    invoice_id, supplier_name, invoice_date, due_date, amount, status,
    department, expense_type, expense_date,
    parent_material, child_material, qty_per, scrap_rate, yield_rate.
    Only include columns that need renaming. Skip already-canonical columns.

13. "kpi_formula": For EACH sheet that has financial data (revenue/cost/profit),
    specify how to calculate KPIs. Look at the column sample values to decide.
    Structure per sheet:
    {
      "sheet_name": {
        "revenue_col": "original column name for revenue/sales (the TOTAL, not per-unit)",
        "cost_col": "original column name for COGS/total cost (null if not available)",
        "profit_col": "original column name for profit (null if not available)",
        "margin_method": "revenue_minus_cogs" | "profit_direct",
        "reasoning": "brief explanation of why this method was chosen"
      }
    }
    Rules for choosing margin_method:
    - If BOTH total cost and profit columns exist: use "revenue_minus_cogs" (more granular)
    - If only profit exists (no cost column): use "profit_direct"
    - NEVER use a per-unit column (Unit Cost, Unit Price) as total COGS.
      Check the value range: if mean < 1000 while revenue mean > 100000, it's per-unit.
    - A column called "Sales Channel", "Sales Rep" etc. with TEXT values is NOT revenue.

RESPOND WITH ONLY VALID JSON. No markdown fences, no explanation."""

    user_prompt = ""

    # Inject user-provided rules
    if user_rules and user_rules.strip():
        user_prompt += f"""## User-provided rules (HIGHEST PRIORITY - follow these exactly)
{user_rules.strip()}

---

"""

    # Columns needing mapping
    user_prompt += "Standardize these column values. Return JSON mapping.\n\n"
    for col_key, vc in columns.items():
        user_prompt += f"## {col_key}\n"
        for val, count in sorted(vc.items(), key=lambda x: -x[1]):
            user_prompt += f'  "{val}": {count}\n'
        user_prompt += "\n"

    # Add sheet names + column profiles for schema mapping
    # Include sample values + dtype so LLM can distinguish:
    #   "Sales Channel" (string: Online/Offline) from "Total Revenue" (float: 2,533,654)
    #   "Unit Cost" (float: 159.42, per-unit) from "Total Cost" (float: 1,582,243, aggregated)
    user_prompt += "## Sheet & Column Profiles (for schema standardization)\n"
    user_prompt += "Use column NAMES + SAMPLE VALUES + DTYPE to map to canonical names.\n"
    user_prompt += "A column named 'Sales Channel' with values ['Online','Offline'] is a CATEGORY, not revenue.\n"
    user_prompt += "A column named 'Unit Cost' with small values [159, 117] is per-unit cost, NOT total COGS.\n"
    user_prompt += "A column named 'Total Cost' with large values [1,582,243] is total COGS.\n\n"

    for sheet_name, sp in profile_result.get("sheet_profiles", {}).items():
        user_prompt += f'### Sheet: "{sheet_name}" ({sp.get("row_count", 0)} rows)\n'
        for col_name, col_info in sp.get("columns", {}).items():
            dtype_hint = "numeric" if col_info.get("numeric_stats") else "text"
            stats = col_info.get("numeric_stats")
            vc = col_info.get("value_counts")
            sample = col_info.get("sample_head")

            parts = [f'  {col_name}: {dtype_hint}']
            if stats:
                parts.append(f'range=[{stats["min"]:,.2f} .. {stats["max"]:,.2f}]')
                parts.append(f'mean={stats["mean"]:,.2f}')
            elif vc:
                # Show top 3 values for text columns
                top3 = list(vc.keys())[:3]
                parts.append(f'values={top3}')
            elif sample:
                parts.append(f'sample={sample[:3]}')

            unique = col_info.get("unique_count", 0)
            if unique > 0:
                parts.append(f'unique={unique}')

            user_prompt += " | ".join(parts) + "\n"
        user_prompt += "\n"

    user_prompt += """
Return format:
{
  "sheet_mappings": {
    "original_sheet_name": "canonical_english_name"
  },
  "column_mappings": {
    "original_sheet_name": {
      "original_column_name": "canonical_english_name"
    }
  },
  "kpi_formula": {
    "sheet_name": {
      "revenue_col": "column name",
      "cost_col": "column name or null",
      "profit_col": "column name or null",
      "margin_method": "revenue_minus_cogs or profit_direct",
      "reasoning": "why"
    }
  },
  "sheet_name.column_name": {
    "variant_value": "canonical_value"
  }
}

Only include items that NEED changing. Skip already-canonical names and values.
kpi_formula is REQUIRED for any sheet with financial/numeric data."""

    return system_prompt, user_prompt


# ================================================================
# Part 3: CLEANING ENGINE (deterministic)
# ================================================================

class CleaningEngine:
    """
    Deterministic cleaning engine. Zero hardcoded mappings.
    All standardization driven by LLM mapping.
    """

    def __init__(self, profile_result, llm_mappings=None):
        self.profile = profile_result
        self.mappings = llm_mappings or {}
        self.log = []

    def clean_workbook(self, sheets_dict):
        results = {}
        for sheet_name, data in sheets_dict.items():
            if not data:
                continue
            df = pd.DataFrame(data)
            sp = self.profile["sheet_profiles"].get(sheet_name, {})
            df = self._clean_sheet(df, sheet_name, sp)
            results[sheet_name] = df

        # Cross-sheet ID validation
        results = self._flag_cross_sheet_orphans(results)

        # Schema standardization: rename columns + sheets to canonical English
        results = self._standardize_schema(results)

        return results

    def _clean_sheet(self, df, sheet_name, profile):
        original_len = len(df)
        df = self._remove_junk_rows(df, sheet_name, profile)
        df = self._strip_whitespace(df, sheet_name)
        df = self._normalize_id_columns(df, sheet_name)
        df = self._clean_annotations(df, sheet_name)
        df = self._apply_mappings(df, sheet_name)
        df = self._deduplicate_entities(df, sheet_name, profile)
        df = self._fix_dates(df, sheet_name, profile)
        df = self._fix_numerics(df, sheet_name, profile)
        df = self._handle_placeholders(df, sheet_name, profile)
        df = self._add_flags(df, sheet_name, profile)
        df = self._drop_exact_duplicates(df, sheet_name)

        self.log.append({
            "sheet": sheet_name,
            "action": "sheet_summary",
            "original_rows": original_len,
            "cleaned_rows": len(df),
            "removed": original_len - len(df),
        })
        return df

    def _remove_junk_rows(self, df, sheet_name, profile):
        drop = set()
        for issue in profile.get("issues_detected", []):
            if issue["type"] == "header_repeated_as_data":
                for idx in issue["row_indices"]:
                    if idx < len(df):
                        drop.add(idx)
                        self.log.append({
                            "sheet": sheet_name,
                            "action": "remove_header_row",
                            "row_index": idx,
                        })
            elif issue["type"] == "suspected_test_data":
                for r in issue["rows"]:
                    idx = r["index"]
                    if idx < len(df):
                        drop.add(idx)
                        self.log.append({
                            "sheet": sheet_name,
                            "action": "remove_test_data",
                            "row_index": idx,
                        })
            elif issue["type"] == "summary_total_rows":
                for idx in issue.get("row_indices", []):
                    if idx < len(df):
                        drop.add(idx)
                        self.log.append({
                            "sheet": sheet_name,
                            "action": "remove_summary_row",
                            "row_index": idx,
                        })
            elif issue["type"] == "mostly_empty_rows":
                for idx in issue.get("row_indices", []):
                    if idx < len(df):
                        drop.add(idx)

        # Fully empty rows
        empty = df.isna().all(axis=1) | df.astype(str).apply(
            lambda row: all(
                str(v).strip() in ("", "nan", "None", "NaN") for v in row
            ),
            axis=1,
        )
        for idx in df[empty].index:
            drop.add(idx)

        if drop:
            df = df.drop(index=list(drop)).reset_index(drop=True)
            self.log.append({
                "sheet": sheet_name,
                "action": "removed_junk_rows",
                "count": len(drop),
            })
        return df

    def _strip_whitespace(self, df, sheet_name):
        count = 0
        for col in df.columns:
            if _is_text_dtype(df[col]):
                as_str = df[col].where(df[col].isna(), df[col].astype(str))
                stripped = as_str.str.strip()
                changed = (stripped != as_str) & as_str.notna()
                count += int(changed.sum())
                df[col] = stripped
        if count > 0:
            self.log.append({
                "sheet": sheet_name,
                "action": "strip_whitespace",
                "cells_affected": count,
            })
        return df

    def _normalize_id_columns(self, df, sheet_name):
        """Uppercase SKU/code/ID columns - system identifiers should be consistent case."""
        id_keywords = ["sku", "item_sku", "fg_sku", "child_sku", "parent_sku",
                        "product_code", "material_code", "part_no"]
        count = 0
        for col in df.columns:
            col_lower = col.lower()
            if any(kw in col_lower for kw in id_keywords):
                if _is_text_dtype(df[col]):
                    as_str = df[col].where(df[col].isna(), df[col].astype(str))
                    upper = as_str.str.upper()
                    changed = (upper != as_str) & as_str.notna()
                    count += int(changed.sum())
                    df[col] = upper
        if count > 0:
            self.log.append({
                "sheet": sheet_name,
                "action": "normalize_id_case",
                "cells_affected": count,
            })
        return df

    def _clean_annotations(self, df, sheet_name):
        """Remove bracket/parenthesis annotations from name/description columns."""
        count = 0
        for col in df.columns:
            col_lower = col.lower()
            if any(kw in col_lower for kw in ["name", "description", "product", "title"]):
                if _is_text_dtype(df[col]):
                    has_brackets = df[col].str.contains(r"\[.*?\]", na=False, regex=True)
                    if has_brackets.any():
                        before = df[col].copy()
                        df[col] = df[col].str.replace(
                            r"\s*\[.*?\]\s*", "", regex=True
                        ).str.strip()
                        changed = ((before != df[col]) & before.notna()).sum()
                        count += int(changed)
        if count > 0:
            self.log.append({
                "sheet": sheet_name,
                "action": "clean_annotations",
                "cells_changed": count,
            })
        return df

    def _apply_mappings(self, df, sheet_name):
        for col_key, mapping in self.mappings.items():
            parts = col_key.split(".", 1)
            if len(parts) != 2:
                continue
            m_sheet, m_col = parts
            if m_sheet != sheet_name or m_col not in df.columns:
                continue

            header_vals = {k for k, v in mapping.items() if v == "__HEADER_ROW__"}
            test_vals = {k for k, v in mapping.items() if v == "__TEST_DATA__"}
            normal_map = {
                k: v
                for k, v in mapping.items()
                if v not in ("__HEADER_ROW__", "__TEST_DATA__")
            }

            drop_vals = header_vals | test_vals
            if drop_vals:
                mask = df[m_col].isin(drop_vals)
                if mask.any():
                    df = df[~mask].reset_index(drop=True)
                    self.log.append({
                        "sheet": sheet_name,
                        "action": "drop_by_mapping",
                        "column": m_col,
                        "rows_dropped": int(mask.sum()),
                    })

            if normal_map:
                before = df[m_col].copy()
                df[m_col] = df[m_col].replace(normal_map)
                changed = (before != df[m_col]) & before.notna()
                if changed.any():
                    self.log.append({
                        "sheet": sheet_name,
                        "action": "apply_mapping",
                        "column": m_col,
                        "mappings_applied": len(normal_map),
                        "cells_changed": int(changed.sum()),
                    })
        return df

    def _deduplicate_entities(self, df, sheet_name, profile):
        """
        Case-insensitive entity deduplication for categorical columns.
        No LLM needed — picks the most frequent casing as canonical.

        Example: "APAC"(10), "apac"(3), "Apac"(1) → all become "APAC"
        Also handles: "Acme Corp", "ACME CORP", "acme corp" → "Acme Corp" (most frequent)
        """
        total_mapped = 0
        for col in df.columns:
            if not _is_text_dtype(df[col]):
                continue
            unique_count = df[col].nunique()
            # Skip ID columns (high cardinality), skip single-value columns
            if unique_count < 2 or unique_count > 100:
                continue
            # Skip columns that look like IDs (mostly unique values)
            col_lower = col.lower()
            if any(kw in col_lower for kw in ["_id", "sku", "code", "number", "invoice", "expense_id", "order_id"]):
                continue

            # Group by case-insensitive key
            non_null = df[col].dropna()
            case_groups = {}
            for val in non_null:
                key = str(val).strip().lower()
                case_groups.setdefault(key, []).append(str(val))

            # Build mapping: for each group with multiple casings, pick most frequent
            col_mapping = {}
            for key, variants in case_groups.items():
                if len(set(variants)) <= 1:
                    continue  # only one casing, skip
                # Most frequent variant wins
                from collections import Counter
                counts = Counter(variants)
                canonical = counts.most_common(1)[0][0]
                for variant in set(variants):
                    if variant != canonical:
                        col_mapping[variant] = canonical

            if col_mapping:
                before = df[col].copy()
                df[col] = df[col].replace(col_mapping)
                changed = ((before != df[col]) & before.notna()).sum()
                if changed > 0:
                    total_mapped += int(changed)
                    self.log.append({
                        "sheet": sheet_name,
                        "action": "deduplicate_entities",
                        "column": col,
                        "mappings": len(col_mapping),
                        "cells_changed": int(changed),
                        "examples": dict(list(col_mapping.items())[:3]),
                    })

        if total_mapped > 0:
            self.log.append({
                "sheet": sheet_name,
                "action": "entity_dedup_summary",
                "total_cells_changed": total_mapped,
            })
        return df

    def _fix_dates(self, df, sheet_name, profile):
        for col_name, col_info in profile.get("columns", {}).items():
            if col_name not in df.columns:
                continue
            if not col_info.get("date_formats_detected"):
                continue

            # Skip columns that are clearly numeric
            col_lower = col_name.lower()
            numeric_keywords = [
                "qty", "quantity", "amount", "price", "cost", "value",
                "count", "total", "sum", "rate", "pct", "percent",
                "weight", "volume", "margin", "revenue", "cogs",
                "allocated", "available", "on_hand", "fulfilled",
                "ordered", "received",
            ]
            if any(kw in col_lower for kw in numeric_keywords):
                continue
            if col_info.get("numeric_stats"):
                continue

            # Require date patterns cover majority of non-null values
            fmts = col_info["date_formats_detected"]
            date_count = sum(v for k, v in fmts.items() if k != "other")
            other_count = fmts.get("other", 0)
            if date_count < other_count:
                continue

            source_col = None
            for c in df.columns:
                if "source" in c.lower() and c != col_name:
                    source_col = c
                    break

            new_dates = []
            unparsed = 0
            for idx, row in df.iterrows():
                val = row.get(col_name)
                if pd.isna(val) or str(val).strip() == "":
                    new_dates.append(None)
                    continue

                parsed = self._parse_date(str(val).strip(), row, source_col)
                if parsed and 1950 <= parsed.year <= 2090:
                    new_dates.append(parsed.strftime("%Y-%m-%d"))
                elif parsed:
                    new_dates.append(None)  # placeholder date
                else:
                    new_dates.append(None)
                    unparsed += 1

            df[col_name] = new_dates
            converted = sum(1 for d in new_dates if d is not None)
            self.log.append({
                "sheet": sheet_name,
                "action": "standardize_dates",
                "column": col_name,
                "dates_converted": converted,
                "unparseable": unparsed,
            })
        return df

    @staticmethod
    def _parse_date(val_str, row, source_col):
        # Excel serial
        if re.match(r"^\d{5}$", val_str):
            try:
                return pd.Timestamp("1899-12-30") + pd.Timedelta(
                    days=int(val_str)
                )
            except Exception:
                return None

        # ISO
        if re.match(r"^\d{4}-\d{1,2}-\d{1,2}", val_str):
            try:
                return pd.to_datetime(val_str)
            except Exception:
                return None

        # YYYY/MM/DD (Taiwan, Japan)
        if re.match(r"^\d{4}/\d{1,2}/\d{1,2}$", val_str):
            try:
                return pd.to_datetime(val_str, format="%Y/%m/%d")
            except Exception:
                return None

        # YYYY.MM.DD
        if re.match(r"^\d{4}\.\d{1,2}\.\d{1,2}$", val_str):
            try:
                return pd.to_datetime(val_str, format="%Y.%m.%d")
            except Exception:
                return None

        # DD.MM.YYYY (Germany, Europe)
        if re.match(r"^\d{1,2}\.\d{1,2}\.\d{4}$", val_str):
            try:
                return pd.to_datetime(val_str, format="%d.%m.%Y")
            except Exception:
                return None

        # DD-Mon-YYYY
        if re.match(r"^\d{1,2}-[A-Za-z]{3}-\d{4}$", val_str):
            try:
                return pd.to_datetime(val_str, format="%d-%b-%Y")
            except Exception:
                return None

        # DD/MM/YYYY vs MM/DD/YYYY
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", val_str)
        if m:
            p1, p2 = int(m.group(1)), int(m.group(2))
            source = ""
            if source_col:
                source = str(row.get(source_col, "")).lower()

            dd_first_kws = [
                "oracle", "apac", "asia", "emea", "europe", "eu",
                "access", "uk", "au", "nz", "de", "fr", "jp",
            ]
            mm_first_kws = [
                "sap", "amer", "us", "na", "north america", "salesforce",
            ]

            if any(kw in source for kw in dd_first_kws):
                try:
                    return pd.to_datetime(val_str, format="%d/%m/%Y")
                except Exception:
                    pass
            elif any(kw in source for kw in mm_first_kws):
                try:
                    return pd.to_datetime(val_str, format="%m/%d/%Y")
                except Exception:
                    pass

            if p1 > 12:
                try:
                    return pd.to_datetime(val_str, format="%d/%m/%Y")
                except Exception:
                    pass
            elif p2 > 12:
                try:
                    return pd.to_datetime(val_str, format="%m/%d/%Y")
                except Exception:
                    pass
            else:
                try:
                    return pd.to_datetime(val_str, dayfirst=True)
                except Exception:
                    pass

        # Fallback
        try:
            return pd.to_datetime(val_str, dayfirst=True)
        except Exception:
            return None

    def _fix_numerics(self, df, sheet_name, profile):
        for col_name, col_info in profile.get("columns", {}).items():
            if col_name not in df.columns:
                continue
            changes = 0

            # Comma decimal
            if col_info.get("comma_decimal_values"):
                mask = df[col_name].astype(str).str.match(
                    r"^\d+,\d+$", na=False
                )
                if mask.any():
                    df.loc[mask, col_name] = (
                        df.loc[mask, col_name].astype(str).str.replace(",", ".")
                    )
                    changes += int(mask.sum())

            # Currency symbols (including US$, USD, EUR prefixes)
            if col_info.get("currency_symbols_in_values"):
                mask = df[col_name].astype(str).str.match(
                    r"^(?:[\$\u20ac\u00a3\u00a5]|US\$|USD|EUR|JPY|TWD|KRW|RMB)\s*[\d,]+\.?\d*$",
                    na=False, case=False
                )
                if mask.any():
                    df.loc[mask, col_name] = (
                        df.loc[mask, col_name]
                        .astype(str)
                        .str.replace(
                            r"^(?:US\$|USD|EUR|JPY|TWD|KRW|RMB|[\$\u20ac\u00a3\u00a5])\s*",
                            "", regex=True
                        )
                        .str.replace(",", "", regex=False)
                    )
                    changes += int(mask.sum())

            # Thousands separator
            if col_info.get("numeric_stats"):
                mask = df[col_name].astype(str).str.match(
                    r"^\d{1,3}(,\d{3})+(\.\d+)?$", na=False
                )
                if mask.any():
                    df.loc[mask, col_name] = (
                        df.loc[mask, col_name].astype(str).str.replace(",", "")
                    )
                    changes += int(mask.sum())

            if changes > 0:
                self.log.append({
                    "sheet": sheet_name,
                    "action": "fix_numeric_format",
                    "column": col_name,
                    "cells_fixed": changes,
                })
        return df

    def _handle_placeholders(self, df, sheet_name, profile):
        universal = {
            "N/A", "n/a", "NA", "NULL", "null", "None", "none",
            "TBD", "TBA", "#N/A", "#ERROR", "#REF!", "#VALUE!", "#NAME?",
            "-", "--", "---",
            "9999-12-31", "1900-01-01", "0000-00-00",
            "DUMMY", "dummy", "PLACEHOLDER", "placeholder",
        }
        for col_name, col_info in profile.get("columns", {}).items():
            if col_name not in df.columns:
                continue
            detected = col_info.get("placeholders_detected", {})
            to_clear = [ph for ph in detected if ph in universal]
            if to_clear:
                mask = df[col_name].astype(str).str.strip().isin(to_clear)
                if mask.any():
                    df.loc[mask, col_name] = None
                    self.log.append({
                        "sheet": sheet_name,
                        "action": "clear_placeholders",
                        "column": col_name,
                        "count": int(mask.sum()),
                    })
        return df

    def _add_flags(self, df, sheet_name, profile):
        cross = profile.get("cross_column_issues", [])
        if not cross:
            return df

        flags = pd.Series([""] * len(df), index=df.index)

        for issue in cross:
            itype = issue["type"]
            if itype == "logical_violation":
                rule = issue["rule"]
                parts = rule.split(" ")
                if len(parts) == 3:
                    c1, op, c2 = parts
                    if c1 in df.columns and c2 in df.columns:
                        v1 = pd.to_numeric(df[c1], errors="coerce")
                        v2 = pd.to_numeric(df[c2], errors="coerce")
                        mask = v1.notna() & v2.notna()
                        if op == ">":
                            mask = mask & (v1 > v2)
                        flags[mask] += f"{rule}; "

            elif itype == "date_order_violation":
                parts = issue["rule"].split(" < ")
                if len(parts) == 2:
                    d2, d1 = parts
                    if d1 in df.columns and d2 in df.columns:
                        try:
                            t1 = pd.to_datetime(df[d1], errors="coerce")
                            t2 = pd.to_datetime(df[d2], errors="coerce")
                            mask = (t2 < t1) & t1.notna() & t2.notna()
                            flags[mask] += f"{issue['rule']}; "
                        except Exception:
                            pass

            elif itype == "arithmetic_mismatch":
                match = re.match(r"(\w+) \u2260 (\w+) - (\w+)", issue["rule"])
                if match:
                    a, b, c = match.groups()
                    if all(col in df.columns for col in [a, b, c]):
                        va = pd.to_numeric(df[a], errors="coerce")
                        vb = pd.to_numeric(df[b], errors="coerce")
                        vc = pd.to_numeric(df[c], errors="coerce")
                        valid = va.notna() & vb.notna() & vc.notna()
                        mm = valid & ((va - (vb - vc)).abs() > 0.01)
                        flags[mm] += f"{a}\u2260{b}-{c}; "

            elif itype == "multiplication_mismatch":
                match = re.match(r"(\w+) \u2260 (\w+) \u00d7 (\w+)", issue["rule"])
                if match:
                    a, b, c = match.groups()
                    if all(col in df.columns for col in [a, b, c]):
                        va = pd.to_numeric(df[a], errors="coerce")
                        vb = pd.to_numeric(df[b], errors="coerce")
                        vc = pd.to_numeric(df[c], errors="coerce")
                        valid = va.notna() & vb.notna() & vc.notna() & (vb > 0) & (vc > 0)
                        calc = (vb * vc).round(2)
                        rel_diff = ((va - calc).abs() / calc.clip(lower=0.01))
                        mm = valid & (rel_diff >= 0.05)
                        flags[mm] += f"{a}\u2260{b}\u00d7{c}; "

        flags = flags.str.strip("; ")
        if (flags != "").any():
            df["_data_quality_flag"] = flags.replace("", None)
            self.log.append({
                "sheet": sheet_name,
                "action": "add_quality_flags",
                "rows_flagged": int((flags != "").sum()),
            })
        return df

    def _drop_exact_duplicates(self, df, sheet_name):
        check_cols = [c for c in df.columns if not c.startswith("_")]
        dup = df.duplicated(subset=check_cols, keep="first")
        if dup.sum() > 0:
            df = df[~dup].reset_index(drop=True)
            self.log.append({
                "sheet": sheet_name,
                "action": "drop_duplicates",
                "count": int(dup.sum()),
            })
        return df

    def _flag_cross_sheet_orphans(self, results):
        """Cross-sheet ID validation: flag references to non-existent IDs."""
        # Build valid ID sets per sheet+column
        id_sets = {}
        for sheet_name, df in results.items():
            for col in df.columns:
                cl = col.lower()
                if any(kw in cl for kw in ["_id", "emp_id", "employee_id",
                                            "sku", "product_code", "item_code"]):
                    vals = set(df[col].dropna().astype(str).str.strip())
                    id_sets[f"{sheet_name}.{col}"] = vals

        # Find foreign key references, check values exist in source
        fk_patterns = [
            ("employee_id", "emp_id"),
            ("product_code", "product_code"),
            ("item_sku", "fg_sku"),
            ("supplier_id", "supplier_id"),
            ("order_id", "order_id"),
        ]

        for sheet_name, df in results.items():
            for col in df.columns:
                cl = col.lower()
                for fk_col, pk_col in fk_patterns:
                    if fk_col not in cl:
                        continue
                    # Find matching primary key sheet
                    for pk_key, pk_vals in id_sets.items():
                        pk_sheet, pk_colname = pk_key.split(".", 1)
                        if pk_sheet == sheet_name:
                            continue
                        if pk_col not in pk_colname.lower():
                            continue
                        # Find orphan IDs
                        fk_vals = set(df[col].dropna().astype(str).str.strip())
                        orphans = fk_vals - pk_vals
                        if orphans and len(orphans) < len(fk_vals):
                            flag_col = "_data_quality_flag"
                            if flag_col not in df.columns:
                                df[flag_col] = None
                            for orphan_id in orphans:
                                mask = df[col].astype(str).str.strip() == orphan_id
                                existing = df.loc[mask, flag_col].fillna("")
                                df.loc[mask, flag_col] = (
                                    existing + f"{col}={orphan_id} not in {pk_sheet}; "
                                )
                            self.log.append({
                                "sheet": sheet_name,
                                "action": "flag_orphan_ids",
                                "column": col,
                                "reference": pk_key,
                                "orphan_count": len(orphans),
                                "orphan_ids": sorted(list(orphans))[:10],
                            })
                            results[sheet_name] = df

        return results

    def _standardize_schema(self, results):
        """Rename sheet names and column names to canonical English using LLM mappings."""
        # Extract schema mappings from LLM response
        sheet_mappings = self.mappings.get("sheet_mappings", {})
        column_mappings = self.mappings.get("column_mappings", {})

        if not sheet_mappings and not column_mappings:
            return results

        # 1. Rename columns first (before renaming sheets, since column_mappings uses original sheet names)
        for sheet_name, col_map in column_mappings.items():
            if sheet_name in results and col_map and isinstance(col_map, dict):
                before_cols = list(results[sheet_name].columns)
                results[sheet_name] = results[sheet_name].rename(columns=col_map)
                after_cols = list(results[sheet_name].columns)
                renamed_count = sum(1 for b, a in zip(before_cols, after_cols) if b != a)
                if renamed_count > 0:
                    self.log.append({
                        "sheet": sheet_name,
                        "action": "rename_columns",
                        "count": renamed_count,
                        "examples": {k: v for k, v in list(col_map.items())[:5]},
                    })

        # 2. Rename sheets
        if sheet_mappings:
            renamed = {}
            for old_name, df in results.items():
                new_name = sheet_mappings.get(old_name, old_name)
                renamed[new_name] = df
                if new_name != old_name:
                    self.log.append({
                        "sheet": old_name,
                        "action": "rename_sheet",
                        "new_name": new_name,
                    })
            results = renamed

        return results

    def get_log(self):
        return self.log

    def get_summary(self):
        summary = {}
        for entry in self.log:
            sheet = entry.get("sheet", "global")
            summary.setdefault(sheet, {"actions": []})
            if entry.get("action") == "sheet_summary":
                summary[sheet]["original_rows"] = entry.get("original_rows")
                summary[sheet]["cleaned_rows"] = entry.get("cleaned_rows")
            elif entry.get("action"):
                summary[sheet]["actions"].append(
                    {k: v for k, v in entry.items() if k != "sheet"}
                )
        return summary


# ================================================================
# Part 4: PIPELINE ENTRY POINT
# ================================================================

def execute_cleaning_pipeline(
    sheets_dict,
    user_rules="",
    call_llm_fn=None,
    llm_config=None,
):
    """
    Full cleaning pipeline. Direct replacement for tool_executor.py core.

    Parameters:
        sheets_dict: { "sheet_name": [list of row dicts] }
        user_rules:  str, user-provided rules from frontend textbox (can be empty)
        call_llm_fn: fn(system_prompt, user_prompt, config) -> raw string
        llm_config:  dict

    Returns:
        {
            "result": { sheets_processed, total_original_rows, ... },
            "artifacts": [ {type:"table", ...}, {type:"summary", ...} ],
            "profile": { ... },
        }
    """

    # -- Stage 0a: Strip column name whitespace (fixes " Sales", " Order ID " etc.) --
    for sheet_name in list(sheets_dict.keys()):
        rows = sheets_dict[sheet_name]
        if rows and isinstance(rows[0], dict):
            sheets_dict[sheet_name] = [
                {k.strip() if isinstance(k, str) else k: v for k, v in row.items()}
                for row in rows
            ]

    # -- Stage 0: Profile (no LLM, ~100ms) --
    profile = profile_workbook(sheets_dict)

    # -- Stage 1: LLM mapping (1 call, JSON only) --
    llm_mappings = {}
    if call_llm_fn:
        sys_prompt, usr_prompt = build_llm_prompt(profile, user_rules)
        if sys_prompt:
            for attempt in range(3):
                try:
                    raw = call_llm_fn(sys_prompt, usr_prompt, llm_config)
                    # Clean markdown fence
                    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                    raw = re.sub(r"\s*```$", "", raw.strip())
                    llm_mappings = json.loads(raw)
                    break
                except (json.JSONDecodeError, Exception):
                    if attempt == 2:
                        llm_mappings = {}  # All failed, skip

    # -- Stage 1b: Apply 3-layer rule system (Company > User > LLM) --
    mapping_audit = []
    try:
        from ml.api.mapping_rules import apply_rules_to_llm_mappings, get_mapping_audit
        mapping_audit = get_mapping_audit(llm_mappings)
        llm_mappings = apply_rules_to_llm_mappings(llm_mappings)
    except Exception as e:
        logger.warning(f"[Cleaning] Rule system failed, using raw LLM mappings: {e}")

    # -- Stage 2: Deterministic cleaning --
    engine = CleaningEngine(profile, llm_mappings)
    cleaned = engine.clean_workbook(sheets_dict)

    # -- Build response (compatible with frontend) --
    artifacts = []
    for sheet_name, df in cleaned.items():
        artifacts.append({
            "type": "table",
            "label": f"cleaned_{sheet_name}",
            "data": df.where(df.notna(), None).to_dict("records"),
        })
    artifacts.append({
        "type": "summary",
        "label": "cleaning_log",
        "data": engine.get_summary(),
    })

    # Add column mapping audit trail (3-layer transparency)
    if mapping_audit:
        artifacts.append({
            "type": "table",
            "label": "column_mapping_audit",
            "data": mapping_audit,
        })

    total_orig = sum(
        p["row_count"] for p in profile["sheet_profiles"].values()
    )
    total_clean = sum(len(df) for df in cleaned.values())

    # Extract kpi_formula from LLM mappings (if present)
    kpi_formula = llm_mappings.get("kpi_formula", {})

    return {
        "result": {
            "sheets_processed": len(cleaned),
            "total_original_rows": total_orig,
            "total_cleaned_rows": total_clean,
            "total_duplicates_removed": total_orig - total_clean,
            "total_nulls_found": sum(
                sum(
                    col.get("null_count", 0)
                    for col in sp["columns"].values()
                )
                for sp in profile["sheet_profiles"].values()
            ),
            "processing_complete": True,
        },
        "artifacts": artifacts,
        "profile": profile,
        "kpi_formula": kpi_formula,
    }
