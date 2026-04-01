"""
deep_clean.py — Step 4: Deep cleaning pass.

Architecture C: Structured operations preferred, code sandbox fallback.

Flow:
  Step 1-3 (existing): Profile -> LLM mapping -> Engine apply
  Step 4 (this module): LLM sees engine results + remaining issues -> returns structured instructions -> engine executes
                        If operation not supported -> fallback to code sandbox

Usage:
  from deep_clean import deep_clean_pass

  result = deep_clean_pass(
      cleaned_sheets={"demand_fg": df, ...},
      profile=profile_result,
      cleaning_log=engine.get_log(),
      call_llm_fn=your_llm_call,
      llm_config=config,
  )
"""

import pandas as pd
import numpy as np
import re
import json


# ================================================================
# Part 1: Structured Operation Engine (Method A)
# ================================================================

SUPPORTED_OPERATIONS = {
    "regex_replace":     "Replace values matching a regex pattern in a column",
    "uppercase":         "Convert all values in a column to uppercase",
    "lowercase":         "Convert all values in a column to lowercase",
    "strip_prefix":      "Remove a prefix string from values (e.g., 'USD ' from prices)",
    "strip_suffix":      "Remove a suffix string from values",
    "split_column":      "Split a column into multiple columns by delimiter",
    "merge_columns":     "Merge multiple columns into one with a separator",
    "fill_null":         "Fill null values with a specified value or method (ffill/bfill/mean/median)",
    "cast_type":         "Cast column to a type (numeric/datetime/string)",
    "boolean_normalize": "Normalize boolean-like values (Y/N/Yes/No/TRUE/1 -> true/false)",
    "conditional_flag":  "Add a flag based on a condition expression",
    "value_replace":     "Replace exact values (not regex) in a column",
    "drop_rows_where":   "Drop rows matching a condition",
    "rename_column":     "Rename a column",
    "reorder_columns":   "Reorder columns in a sheet",
}


class StructuredOperationExecutor:
    """Execute structured operation instructions."""

    def __init__(self):
        self.log = []

    def execute(self, df, sheet_name, operations):
        """
        Execute a set of operation instructions.
        operations: [{"type": "...", "column": "...", ...}, ...]
        """
        for op in operations:
            op_type = op.get("type")
            if op_type not in SUPPORTED_OPERATIONS:
                self.log.append({
                    "sheet": sheet_name,
                    "action": "unsupported_operation",
                    "type": op_type,
                    "skipped": True,
                })
                continue

            try:
                handler = getattr(self, f"_op_{op_type}", None)
                if handler:
                    df = handler(df, sheet_name, op)
            except Exception as e:
                self.log.append({
                    "sheet": sheet_name,
                    "action": "operation_error",
                    "type": op_type,
                    "error": str(e)[:200],
                })
        return df

    def _op_regex_replace(self, df, sheet, op):
        col = op["column"]
        if col not in df.columns:
            return df
        pattern = op["pattern"]
        replacement = op.get("replacement", "")
        before = df[col].copy()
        df[col] = df[col].astype(str).str.replace(pattern, replacement, regex=True)
        # Restore NaN
        df.loc[before.isna(), col] = None
        changed = (before != df[col]).sum()
        if changed > 0:
            self.log.append({
                "sheet": sheet, "action": "regex_replace",
                "column": col, "pattern": pattern, "cells_changed": int(changed),
            })
        return df

    def _op_uppercase(self, df, sheet, op):
        col = op["column"]
        if col not in df.columns:
            return df
        before = df[col].copy()
        df[col] = df[col].str.upper()
        changed = ((before != df[col]) & before.notna()).sum()
        if changed > 0:
            self.log.append({
                "sheet": sheet, "action": "uppercase",
                "column": col, "cells_changed": int(changed),
            })
        return df

    def _op_lowercase(self, df, sheet, op):
        col = op["column"]
        if col not in df.columns:
            return df
        before = df[col].copy()
        df[col] = df[col].str.lower()
        changed = ((before != df[col]) & before.notna()).sum()
        if changed > 0:
            self.log.append({
                "sheet": sheet, "action": "lowercase",
                "column": col, "cells_changed": int(changed),
            })
        return df

    def _op_strip_prefix(self, df, sheet, op):
        col = op["column"]
        prefix = op["prefix"]
        if col not in df.columns:
            return df
        mask = df[col].astype(str).str.startswith(prefix, na=False)
        if mask.any():
            df.loc[mask, col] = df.loc[mask, col].astype(str).str[len(prefix):]
            self.log.append({
                "sheet": sheet, "action": "strip_prefix",
                "column": col, "prefix": prefix, "cells_changed": int(mask.sum()),
            })
        return df

    def _op_strip_suffix(self, df, sheet, op):
        col = op["column"]
        suffix = op["suffix"]
        if col not in df.columns:
            return df
        mask = df[col].astype(str).str.endswith(suffix, na=False)
        if mask.any():
            df.loc[mask, col] = df.loc[mask, col].astype(str).str[:-len(suffix)]
            self.log.append({
                "sheet": sheet, "action": "strip_suffix",
                "column": col, "suffix": suffix, "cells_changed": int(mask.sum()),
            })
        return df

    def _op_split_column(self, df, sheet, op):
        col = op["column"]
        delimiter = op["delimiter"]
        into = op["into"]  # list of new column names
        if col not in df.columns:
            return df
        splits = df[col].astype(str).str.split(delimiter, n=len(into)-1, expand=True)
        for i, new_col in enumerate(into):
            if i < splits.shape[1]:
                df[new_col] = splits[i].str.strip()
        self.log.append({
            "sheet": sheet, "action": "split_column",
            "column": col, "into": into,
        })
        return df

    def _op_merge_columns(self, df, sheet, op):
        columns = op["columns"]
        target = op["target"]
        separator = op.get("separator", " ")
        valid_cols = [c for c in columns if c in df.columns]
        if len(valid_cols) < 2:
            return df
        df[target] = df[valid_cols].astype(str).agg(separator.join, axis=1)
        self.log.append({
            "sheet": sheet, "action": "merge_columns",
            "columns": valid_cols, "target": target,
        })
        return df

    def _op_fill_null(self, df, sheet, op):
        col = op["column"]
        method = op.get("method", "value")
        value = op.get("value")
        if col not in df.columns:
            return df
        null_before = df[col].isnull().sum()
        if method == "ffill":
            df[col] = df[col].ffill()
        elif method == "bfill":
            df[col] = df[col].bfill()
        elif method == "mean":
            num = pd.to_numeric(df[col], errors="coerce")
            df[col] = df[col].fillna(str(round(num.mean(), 4)))
        elif method == "median":
            num = pd.to_numeric(df[col], errors="coerce")
            df[col] = df[col].fillna(str(round(num.median(), 4)))
        elif method == "value" and value is not None:
            df[col] = df[col].fillna(value)
        filled = null_before - df[col].isnull().sum()
        if filled > 0:
            self.log.append({
                "sheet": sheet, "action": "fill_null",
                "column": col, "method": method, "filled": int(filled),
            })
        return df

    def _op_cast_type(self, df, sheet, op):
        col = op["column"]
        target_type = op["target_type"]
        if col not in df.columns:
            return df
        if target_type == "numeric":
            df[col] = pd.to_numeric(df[col], errors="coerce")
        elif target_type == "datetime":
            df[col] = pd.to_datetime(df[col], errors="coerce").dt.strftime("%Y-%m-%d")
        elif target_type == "string":
            df[col] = df[col].astype(str)
        self.log.append({
            "sheet": sheet, "action": "cast_type",
            "column": col, "target_type": target_type,
        })
        return df

    def _op_boolean_normalize(self, df, sheet, op):
        col = op["column"]
        true_values = set(str(v).strip().lower() for v in op.get("true_values", ["y","yes","true","1"]))
        false_values = set(str(v).strip().lower() for v in op.get("false_values", ["n","no","false","0"]))
        if col not in df.columns:
            return df
        def normalize(v):
            if pd.isna(v):
                return None
            v_low = str(v).strip().lower()
            if v_low in true_values:
                return "true"
            if v_low in false_values:
                return "false"
            return v
        df[col] = df[col].apply(normalize)
        self.log.append({
            "sheet": sheet, "action": "boolean_normalize", "column": col,
        })
        return df

    def _op_conditional_flag(self, df, sheet, op):
        condition = op["condition"]  # e.g., "price > 500"
        flag_text = op.get("flag", condition)
        flag_col = "_data_quality_flag"
        if flag_col not in df.columns:
            df[flag_col] = None

        # Parse simple condition: "col > value", "col < value", "col == value"
        m = re.match(r"(\w+)\s*(>|<|>=|<=|==|!=)\s*(.+)", condition)
        if not m:
            return df
        col, op_str, val = m.group(1), m.group(2), m.group(3).strip()
        if col not in df.columns:
            return df

        num_val = pd.to_numeric(val, errors="coerce")
        col_vals = pd.to_numeric(df[col], errors="coerce")

        if pd.notna(num_val):
            if op_str == ">": mask = col_vals > num_val
            elif op_str == "<": mask = col_vals < num_val
            elif op_str == ">=": mask = col_vals >= num_val
            elif op_str == "<=": mask = col_vals <= num_val
            elif op_str == "==": mask = col_vals == num_val
            elif op_str == "!=": mask = col_vals != num_val
            else: return df
        else:
            if op_str == "==": mask = df[col].astype(str) == val
            elif op_str == "!=": mask = df[col].astype(str) != val
            else: return df

        mask = mask & mask.notna()
        if mask.any():
            existing = df[flag_col].fillna("")
            df.loc[mask, flag_col] = existing[mask] + flag_text + "; "
            self.log.append({
                "sheet": sheet, "action": "conditional_flag",
                "condition": condition, "rows_flagged": int(mask.sum()),
            })
        return df

    def _op_value_replace(self, df, sheet, op):
        col = op["column"]
        replacements = op["replacements"]  # {"old": "new", ...}
        if col not in df.columns:
            return df
        before = df[col].copy()
        df[col] = df[col].replace(replacements)
        changed = ((before != df[col]) & before.notna()).sum()
        if changed > 0:
            self.log.append({
                "sheet": sheet, "action": "value_replace",
                "column": col, "cells_changed": int(changed),
            })
        return df

    def _op_drop_rows_where(self, df, sheet, op):
        condition = op["condition"]
        m = re.match(r"(\w+)\s*(==|!=|>|<)\s*(.+)", condition)
        if not m:
            return df
        col, op_str, val = m.group(1), m.group(2), m.group(3).strip().strip("'\"")
        if col not in df.columns:
            return df
        if op_str == "==":
            mask = df[col].astype(str) == val
        elif op_str == "!=":
            mask = df[col].astype(str) != val
        else:
            return df
        dropped = mask.sum()
        if dropped > 0:
            df = df[~mask].reset_index(drop=True)
            self.log.append({
                "sheet": sheet, "action": "drop_rows_where",
                "condition": condition, "rows_dropped": int(dropped),
            })
        return df

    def _op_rename_column(self, df, sheet, op):
        old_name = op["old_name"]
        new_name = op["new_name"]
        if old_name in df.columns:
            df = df.rename(columns={old_name: new_name})
            self.log.append({
                "sheet": sheet, "action": "rename_column",
                "old": old_name, "new": new_name,
            })
        return df

    def _op_reorder_columns(self, df, sheet, op):
        order = op["order"]
        valid = [c for c in order if c in df.columns]
        remaining = [c for c in df.columns if c not in valid]
        df = df[valid + remaining]
        self.log.append({"sheet": sheet, "action": "reorder_columns"})
        return df

    def get_log(self):
        return self.log


# ================================================================
# Part 2: Code Sandbox Fallback (Method B)
# ================================================================

def execute_code_in_sandbox(code_str, sheets_dict):
    """
    Execute LLM-generated Python code in an isolated environment.

    Restrictions:
    - Only pandas, numpy, re, json, math, collections allowed
    - No os, sys, open, exec, eval, __import__
    - Input: sheets_dict ({"sheet_name": df})
    - Output: modified sheets_dict

    Returns: (modified_sheets, error_or_none)
    """
    # Security checks
    dangerous_patterns = [
        r'\bos\b', r'\bsys\b', r'\bopen\s*\(', r'\bexec\s*\(',
        r'\beval\s*\(', r'__import__', r'\bsubprocess\b',
        r'\bshutil\b', r'\bglobals\b', r'\blocals\b',
        r'\bcompile\s*\(', r'\bgetattr\s*\(',
    ]
    for pattern in dangerous_patterns:
        if re.search(pattern, code_str):
            return sheets_dict, f"Blocked: code contains forbidden pattern '{pattern}'"

    # Length limit
    if len(code_str) > 5000:
        return sheets_dict, "Blocked: code exceeds 5000 character limit"

    # Build isolated namespace
    safe_globals = {
        "__builtins__": {
            "len": len, "range": range, "enumerate": enumerate,
            "zip": zip, "map": map, "filter": filter,
            "str": str, "int": int, "float": float, "bool": bool,
            "list": list, "dict": dict, "set": set, "tuple": tuple,
            "isinstance": isinstance, "type": type,
            "min": min, "max": max, "sum": sum, "abs": abs,
            "round": round, "sorted": sorted, "reversed": reversed,
            "any": any, "all": all, "print": print,
            "None": None, "True": True, "False": False,
            "ValueError": ValueError, "KeyError": KeyError,
            "TypeError": TypeError, "IndexError": IndexError,
        },
        "pd": pd,
        "np": np,
        "re": re,
        "json": json,
    }

    safe_locals = {"sheets": {k: v.copy() for k, v in sheets_dict.items()}}

    try:
        exec(code_str, safe_globals, safe_locals)
        return safe_locals.get("sheets", sheets_dict), None
    except Exception as e:
        return sheets_dict, f"Execution error: {type(e).__name__}: {str(e)[:200]}"


# ================================================================
# Part 3: LLM Prompt for Step 4
# ================================================================

def build_deep_clean_prompt(cleaned_sheets, profile, cleaning_log):
    """
    Build Step 4 LLM prompt.
    LLM sees engine results + remaining issues, decides operations.
    """
    # Scan remaining issues
    remaining_issues = _scan_remaining_issues(cleaned_sheets, profile, cleaning_log)

    if not remaining_issues:
        return None, None  # No Step 4 needed

    ops_list = "\n".join(
        f"  - {name}: {desc}" for name, desc in SUPPORTED_OPERATIONS.items()
    )

    system_prompt = f"""You are a data cleaning engineer performing a SECOND PASS on already-cleaned data.

The data has ALREADY been through an initial cleaning engine that handled:
- Removed junk rows (headers, test data, empty rows)
- Stripped whitespace
- Applied entity/category mappings (LLM-generated)
- Standardized dates (where format was recognized)
- Fixed numeric formats (comma decimals, currency symbols)
- Cleared placeholder values
- Added quality flags for logical violations
- Removed exact duplicates

Your job: fix the REMAINING issues that the engine couldn't handle.

You have two options:

OPTION A (PREFERRED): Return structured operations from this list:
{ops_list}

OPTION B (FALLBACK): If the fix requires logic not in the operation list,
return Python code that modifies a `sheets` dict of DataFrames.

RESPONSE FORMAT - return ONLY valid JSON:
{{
  "structured_operations": {{
    "sheet_name": [
      {{"type": "regex_replace", "column": "col", "pattern": "...", "replacement": "..."}},
      {{"type": "uppercase", "column": "col"}},
      ...
    ]
  }},
  "code_operations": {{
    "sheet_name": "python code string that modifies sheets['sheet_name'] in place"
  }},
  "no_action_needed": ["sheet_name1", "sheet_name2"]
}}

RULES:
1. Use structured_operations whenever possible. Only use code_operations for things
   that genuinely can't be expressed as structured ops.
2. code_operations must be minimal - under 20 lines, pandas only, no file I/O.
3. Do NOT redo what the engine already did. Only fix remaining issues.
4. If a sheet has no remaining issues, put it in no_action_needed.

RESPOND WITH ONLY VALID JSON. No markdown fences, no explanation."""

    user_prompt = "## Remaining Issues After Engine Cleaning\n\n"
    for issue in remaining_issues:
        user_prompt += f"### {issue['sheet']}.{issue['column']}\n"
        user_prompt += f"Issue: {issue['description']}\n"
        if issue.get("examples"):
            user_prompt += f"Examples: {issue['examples'][:5]}\n"
        user_prompt += "\n"

    return system_prompt, user_prompt


def _scan_remaining_issues(cleaned_sheets, profile, cleaning_log):
    """Scan for issues that the engine didn't handle."""
    issues = []

    for sheet_name, df in cleaned_sheets.items():
        sp = profile.get("sheet_profiles", {}).get(sheet_name, {})

        for col in df.columns:
            if col.startswith("_"):
                continue
            series = df[col].dropna()
            if len(series) == 0:
                continue

            # 1. Mixed case ID/code columns
            col_lower = col.lower()
            if any(kw in col_lower for kw in ["sku", "code", "id"]):
                if (pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series)):
                    has_lower = series[series.str.match(r'^[a-z]', na=False)]
                    has_upper = series[series.str.match(r'^[A-Z]', na=False)]
                    if len(has_lower) > 0 and len(has_upper) > 0:
                        issues.append({
                            "sheet": sheet_name, "column": col,
                            "description": "Mixed case in ID/code column - some lowercase, some uppercase",
                            "examples": has_lower.head(3).tolist(),
                        })

            # 2. Bracket annotations in values
            if pd.api.types.is_string_dtype(series):
                bracket = series[series.str.contains(r'\[.*?\]', na=False, regex=True)]
                if len(bracket) > 0:
                    issues.append({
                        "sheet": sheet_name, "column": col,
                        "description": "Values contain bracket annotations like [EOL Q3] that should be removed",
                        "examples": bracket.head(3).tolist(),
                    })

            # 3. Date column still has non-ISO formats
            col_info = sp.get("columns", {}).get(col, {})
            if col_info.get("date_formats_detected"):
                non_iso = series[~series.str.match(r'^\d{4}-\d{2}-\d{2}', na=False)]
                if len(non_iso) > 0 and len(non_iso) < len(series):  # partial non-ISO
                    issues.append({
                        "sheet": sheet_name, "column": col,
                        "description": "Date column still has non-ISO formats after engine pass",
                        "examples": non_iso.head(5).tolist(),
                    })

            # 4. Numeric column still has text mixed in
            if col_info.get("numeric_stats"):
                non_num = series[pd.to_numeric(series, errors="coerce").isna()]
                if len(non_num) > 0 and len(non_num) < len(series) * 0.5:
                    issues.append({
                        "sheet": sheet_name, "column": col,
                        "description": "Numeric column still has text values",
                        "examples": non_num.head(5).tolist(),
                    })

            # 5. Currency prefixes still present (US$, USD, etc.)
            if pd.api.types.is_string_dtype(series):
                currency_prefix = series[series.str.match(
                    r'^(US\$|USD\s|EUR\s|JPY\s|TWD\s)', na=False, case=False
                )]
                if len(currency_prefix) > 0:
                    issues.append({
                        "sheet": sheet_name, "column": col,
                        "description": "Values still have currency prefix text (US$, USD, etc.)",
                        "examples": currency_prefix.head(3).tolist(),
                    })

            # 6. Numeric values with unit suffixes (480g, 200 grams, 0.15kg)
            if pd.api.types.is_string_dtype(series):
                unit_in_num = series[series.str.match(
                    r'^\d+\.?\d*\s*'
                    r'(g|kg|mg|ml|l|oz|lb|mm|cm|m|'
                    r'grams?|kilograms?|milligrams?|'
                    r'liters?|milliliters?|ounces?|pounds?|'
                    r'meters?|centimeters?|millimeters?|'
                    r'pieces?|pcs|units?)\s*$',
                    na=False, case=False
                )]
                if len(unit_in_num) > 0 and len(unit_in_num) < len(series):
                    issues.append({
                        "sheet": sheet_name, "column": col,
                        "description": "Numeric column has unit suffixes mixed in (e.g., 480g, 0.15kg)",
                        "examples": unit_in_num.head(5).tolist(),
                    })

    return issues


# ================================================================
# Part 4: Pipeline Entry Point
# ================================================================

def deep_clean_pass(cleaned_sheets, profile, cleaning_log,
                    call_llm_fn=None, llm_config=None):
    """
    Step 4 entry point. Scan remaining issues, fix them.

    Parameters:
        cleaned_sheets: {"sheet_name": DataFrame}  (Step 3 output)
        profile: profile_workbook() result
        cleaning_log: engine.get_log()
        call_llm_fn: fn(sys, usr, config) -> str
        llm_config: dict

    Returns:
        {
            "sheets": {"sheet_name": DataFrame},
            "log": [...],
            "issues_found": int,
            "issues_fixed": int,
            "mode": "structured" | "code" | "none"
        }
    """
    # Scan remaining issues
    remaining = _scan_remaining_issues(cleaned_sheets, profile, cleaning_log)

    if not remaining:
        return {
            "sheets": cleaned_sheets,
            "log": [],
            "issues_found": 0,
            "issues_fixed": 0,
            "mode": "none",
        }

    # If no LLM, try builtin rules for common issues
    if not call_llm_fn:
        return _apply_builtin_fixes(cleaned_sheets, remaining)

    # Build prompt
    sys_prompt, usr_prompt = build_deep_clean_prompt(
        cleaned_sheets, profile, cleaning_log
    )
    if not sys_prompt:
        return {
            "sheets": cleaned_sheets,
            "log": [],
            "issues_found": 0,
            "issues_fixed": 0,
            "mode": "none",
        }

    # Call LLM
    operations = None
    for attempt in range(3):
        try:
            raw = call_llm_fn(sys_prompt, usr_prompt, llm_config or {})
            raw = raw.strip()
            start = raw.find("{")
            end = raw.rfind("}")
            if start != -1 and end != -1:
                raw = raw[start:end+1]
            raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
            raw = re.sub(r"\s*```$", "", raw.strip())
            operations = json.loads(raw)
            break
        except (json.JSONDecodeError, Exception):
            if attempt == 2:
                # LLM failed, use builtin rules
                return _apply_builtin_fixes(cleaned_sheets, remaining)

    # Execute operations
    result_sheets = {k: v.copy() for k, v in cleaned_sheets.items()}
    all_log = []
    mode_used = "none"

    # Method A: Structured operations
    struct_ops = operations.get("structured_operations", {})
    if struct_ops:
        mode_used = "structured"
        executor = StructuredOperationExecutor()
        for sheet_name, ops in struct_ops.items():
            if sheet_name in result_sheets and isinstance(ops, list):
                result_sheets[sheet_name] = executor.execute(
                    result_sheets[sheet_name], sheet_name, ops
                )
        all_log.extend(executor.get_log())

    # Method B: Code fallback
    code_ops = operations.get("code_operations", {})
    if code_ops:
        mode_used = "code" if mode_used == "none" else "structured+code"
        for sheet_name, code_str in code_ops.items():
            if sheet_name in result_sheets and code_str:
                modified, error = execute_code_in_sandbox(
                    code_str, {sheet_name: result_sheets[sheet_name]}
                )
                if error:
                    all_log.append({
                        "sheet": sheet_name,
                        "action": "code_sandbox_error",
                        "error": error,
                    })
                else:
                    result_sheets[sheet_name] = modified[sheet_name]
                    all_log.append({
                        "sheet": sheet_name,
                        "action": "code_sandbox_executed",
                    })

    return {
        "sheets": result_sheets,
        "log": all_log,
        "issues_found": len(remaining),
        "issues_fixed": len(all_log),
        "mode": mode_used,
    }


def _apply_builtin_fixes(cleaned_sheets, remaining_issues):
    """
    Built-in fix rules that don't need LLM.
    Covers common engine gaps.
    """
    result = {k: v.copy() for k, v in cleaned_sheets.items()}
    log = []

    for issue in remaining_issues:
        sheet = issue["sheet"]
        col = issue["column"]
        desc = issue["description"]

        if sheet not in result or col not in result[sheet].columns:
            continue

        df = result[sheet]

        # SKU/ID mixed case -> uppercase
        if "Mixed case in ID" in desc:
            before = df[col].copy()
            df[col] = df[col].str.upper()
            changed = ((before != df[col]) & before.notna()).sum()
            if changed > 0:
                log.append({
                    "sheet": sheet, "action": "builtin_uppercase",
                    "column": col, "cells_changed": int(changed),
                })

        # Bracket annotations -> regex remove
        elif "bracket annotations" in desc:
            before = df[col].copy()
            df[col] = df[col].str.replace(r"\s*\[.*?\]", "", regex=True)
            changed = ((before != df[col]) & before.notna()).sum()
            if changed > 0:
                log.append({
                    "sheet": sheet, "action": "builtin_remove_brackets",
                    "column": col, "cells_changed": int(changed),
                })

        # Currency prefix -> strip
        elif "currency prefix" in desc:
            before = df[col].copy()
            df[col] = (df[col].astype(str)
                       .str.replace(r"^US\$\s*", "", regex=True)
                       .str.replace(r"^USD\s+", "", regex=True)
                       .str.replace(r"^EUR\s+", "", regex=True)
                       .str.replace(r"^JPY\s+", "", regex=True)
                       .str.replace(r",", "", regex=False))
            # Restore original NaN
            df.loc[before.isna(), col] = None
            changed = ((before != df[col]) & before.notna()).sum()
            if changed > 0:
                log.append({
                    "sheet": sheet, "action": "builtin_strip_currency",
                    "column": col, "cells_changed": int(changed),
                })

        # Numeric values with unit suffixes -> parse and convert
        elif "unit suffixes" in desc:
            before = df[col].copy()
            # Infer target unit from column name
            col_lower = col.lower()
            target_unit = None
            if '_g' in col_lower or 'gram' in col_lower or 'weight_g' in col_lower:
                target_unit = 'g'
            elif '_kg' in col_lower:
                target_unit = 'kg'
            elif '_ml' in col_lower:
                target_unit = 'ml'
            elif '_l' in col_lower or 'liter' in col_lower:
                target_unit = 'l'
            elif '_cm' in col_lower:
                target_unit = 'cm'
            elif '_m' in col_lower and '_mm' not in col_lower:
                target_unit = 'm'

            def parse_unit_value(v):
                if pd.isna(v):
                    return v
                v_str = str(v).strip().lower()
                m = re.match(
                    r'^(\d+\.?\d*)\s*'
                    r'(g|kg|mg|ml|l|oz|lb|mm|cm|m|'
                    r'grams?|kilograms?|milligrams?|'
                    r'liters?|milliliters?|ounces?|pounds?|'
                    r'meters?|centimeters?|millimeters?|'
                    r'pieces?|pcs|units?)$',
                    v_str
                )
                if not m:
                    return v
                num = float(m.group(1))
                unit = m.group(2)

                # Convert to target unit
                if target_unit == 'g':
                    if unit.startswith('kg') or unit.startswith('kilogram'):
                        num *= 1000
                    elif unit.startswith('mg') or unit.startswith('milligram'):
                        num /= 1000
                    elif unit.startswith('oz') or unit.startswith('ounce'):
                        num *= 28.3495
                    elif unit.startswith('lb') or unit.startswith('pound'):
                        num *= 453.592
                elif target_unit == 'ml':
                    if unit.startswith('l') and not unit.startswith('lb'):
                        num *= 1000
                elif target_unit == 'cm':
                    if unit == 'm' or unit.startswith('meter'):
                        num *= 100
                    elif unit.startswith('mm') or unit.startswith('millimeter'):
                        num /= 10

                return str(int(num)) if num == int(num) else str(round(num, 2))

            df[col] = df[col].apply(parse_unit_value)
            changed = ((before != df[col]) & before.notna()).sum()
            if changed > 0:
                log.append({
                    "sheet": sheet, "action": "builtin_parse_units",
                    "column": col, "target_unit": target_unit,
                    "cells_changed": int(changed),
                })

        result[sheet] = df

    return {
        "sheets": result,
        "log": log,
        "issues_found": len(remaining_issues),
        "issues_fixed": len(log),
        "mode": "builtin",
    }
