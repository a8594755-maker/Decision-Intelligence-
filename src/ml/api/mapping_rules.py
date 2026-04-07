"""
mapping_rules.py — 3-Layer Column Mapping Rule System.

Priority: Company rules > User corrections > LLM auto-detect.

Layer 1 (LLM): Auto-detected by cleaning engine (existing)
Layer 2 (User): Per-session corrections saved in memory
Layer 3 (Company): Global rules that apply to all datasets

Storage: JSON file on disk (upgradeable to Supabase later).
"""

import json
import os
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Rules are stored alongside the API code
_RULES_DIR = Path(__file__).parent / "rules"
_USER_RULES_FILE = _RULES_DIR / "user_column_rules.json"
_COMPANY_RULES_FILE = _RULES_DIR / "company_column_rules.json"


def _ensure_dir():
    _RULES_DIR.mkdir(exist_ok=True)


def _load_json(path):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, IOError):
            return {}
    return {}


def _save_json(path, data):
    _ensure_dir()
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


# ── Company Rules (Layer 3 — highest priority) ──────────────────────────

def get_company_rules() -> dict:
    """
    Get company-wide column mapping rules.

    Returns:
        {
            "column_rules": {
                "revenue_column": "net_sales",  # "always use Net Sales for revenue"
                "ignore_columns": ["Gross Sales"],
            },
            "entity_rules": {
                "全聯": "PX Mart",
                "全聯福利中心": "PX Mart",
            },
            "currency_rule": "USD",  # "always convert to USD"
        }
    """
    return _load_json(_COMPANY_RULES_FILE)


def set_company_rules(rules: dict):
    """Set company-wide rules (admin only)."""
    _save_json(_COMPANY_RULES_FILE, rules)
    logger.info(f"[MappingRules] Company rules saved: {list(rules.keys())}")


# ── User Rules (Layer 2 — per source/session) ───────────────────────────

def get_user_rules() -> dict:
    """
    Get user column mapping corrections.

    Returns:
        {
            "column_overrides": {
                "Sheet1": {
                    " Sales": "revenue",       # user corrected this
                    "Gross Sales": "__ignore__",     # user said ignore this
                    "Profit": "profit",
                }
            },
            "entity_overrides": {
                "台灣": "Taiwan",
            }
        }
    """
    return _load_json(_USER_RULES_FILE)


def set_user_rules(rules: dict):
    """Save user corrections."""
    _save_json(_USER_RULES_FILE, rules)
    logger.info(f"[MappingRules] User rules saved")


def add_user_column_override(sheet_name: str, original_col: str, mapped_role: str):
    """Add a single user column mapping override."""
    rules = get_user_rules()
    overrides = rules.setdefault("column_overrides", {})
    sheet_rules = overrides.setdefault(sheet_name, {})
    sheet_rules[original_col] = mapped_role
    set_user_rules(rules)
    logger.info(f"[MappingRules] User override: {sheet_name}.{original_col} → {mapped_role}")


def add_user_entity_override(original: str, canonical: str):
    """Add a single entity resolution override."""
    rules = get_user_rules()
    entities = rules.setdefault("entity_overrides", {})
    entities[original] = canonical
    set_user_rules(rules)


# ── Apply Rules (merge 3 layers) ────────────────────────────────────────

def apply_rules_to_llm_mappings(llm_mappings: dict) -> dict:
    """
    Merge 3 layers: LLM auto → User overrides → Company rules.
    Higher priority layers override lower ones.

    Args:
        llm_mappings: Raw LLM output from cleaning engine
            {
                "column_mappings": {"Sheet1": {"Gross Sales": "revenue", ...}},
                "sheet_mappings": {"Sheet1": "sales_transactions"},
                "entity_dictionary": {"全聯": "PX Mart"},
                ...
            }

    Returns:
        Merged mappings dict (same format, rules applied)
    """
    user_rules = get_user_rules()
    company_rules = get_company_rules()

    merged = dict(llm_mappings)  # Start with LLM (Layer 1)

    # ── Apply User Column Overrides (Layer 2) ──
    user_col_overrides = user_rules.get("column_overrides", {})
    if user_col_overrides:
        col_mappings = merged.get("column_mappings", {})
        for sheet_name, overrides in user_col_overrides.items():
            sheet_map = col_mappings.get(sheet_name, {})
            for orig_col, new_role in overrides.items():
                if new_role == "__ignore__":
                    # User says ignore this column — remove from mapping
                    sheet_map.pop(orig_col, None)
                else:
                    sheet_map[orig_col] = new_role
            col_mappings[sheet_name] = sheet_map
        merged["column_mappings"] = col_mappings

    # ── Apply User Entity Overrides (Layer 2) ──
    user_entity_overrides = user_rules.get("entity_overrides", {})
    if user_entity_overrides:
        entity_dict = merged.get("entity_dictionary", {})
        entity_dict.update(user_entity_overrides)
        merged["entity_dictionary"] = entity_dict

    # ── Apply Company Rules (Layer 3 — highest priority) ──

    # Revenue column preference
    revenue_pref = company_rules.get("column_rules", {}).get("revenue_column")
    if revenue_pref:
        col_mappings = merged.get("column_mappings", {})
        for sheet_name, sheet_map in col_mappings.items():
            # Find which column is currently mapped to revenue
            current_revenue_cols = [k for k, v in sheet_map.items()
                                     if v in ("revenue", "net_revenue")]
            # Find the preferred column
            for orig_col in sheet_map:
                if orig_col.lower().strip().replace(" ", "_") == revenue_pref.lower().replace(" ", "_"):
                    sheet_map[orig_col] = "revenue"
                    # Downgrade others
                    for other in current_revenue_cols:
                        if other != orig_col:
                            sheet_map[other] = "__ignore__"
                    break
        merged["column_mappings"] = col_mappings

    # Ignore columns
    ignore_cols = company_rules.get("column_rules", {}).get("ignore_columns", [])
    if ignore_cols:
        col_mappings = merged.get("column_mappings", {})
        for sheet_name, sheet_map in col_mappings.items():
            for col in ignore_cols:
                if col in sheet_map:
                    sheet_map.pop(col)
        merged["column_mappings"] = col_mappings

    # Company entity rules
    company_entities = company_rules.get("entity_rules", {})
    if company_entities:
        entity_dict = merged.get("entity_dictionary", {})
        entity_dict.update(company_entities)
        merged["entity_dictionary"] = entity_dict

    return merged


def get_mapping_audit(llm_mappings: dict) -> list[dict]:
    """
    Build an audit trail showing all 3 layers for each column mapping.
    Used for transparency in reports.

    Returns:
        [
            {
                "sheet": "Sheet1",
                "column": "Gross Sales",
                "llm_role": "revenue",
                "user_override": null,
                "company_rule": null,
                "final_role": "revenue",
                "source": "llm",
            },
            ...
        ]
    """
    user_rules = get_user_rules()
    company_rules = get_company_rules()

    user_col_overrides = user_rules.get("column_overrides", {})
    ignore_cols = set(company_rules.get("column_rules", {}).get("ignore_columns", []))

    audit = []
    col_mappings = llm_mappings.get("column_mappings", {})

    for sheet_name, sheet_map in col_mappings.items():
        for orig_col, llm_role in sheet_map.items():
            user_override = user_col_overrides.get(sheet_name, {}).get(orig_col)
            company_ignored = orig_col in ignore_cols

            if company_ignored:
                final_role = "(ignored by company rule)"
                source = "company"
            elif user_override:
                final_role = user_override if user_override != "__ignore__" else "(ignored by user)"
                source = "user"
            else:
                final_role = llm_role
                source = "llm"

            audit.append({
                "sheet": sheet_name,
                "column": orig_col,
                "llm_role": llm_role,
                "user_override": user_override,
                "company_ignored": company_ignored,
                "final_role": final_role,
                "source": source,
            })

    return audit
