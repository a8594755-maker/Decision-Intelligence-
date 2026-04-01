"""
gpt_bootstrap.py — First upload uses strong model to build complete rule store.

Usage:
  from gpt_bootstrap import execute_with_rule_store

  result = execute_with_rule_store(
      sheets_dict=input_data["sheets"],
      existing_rules=rule_store_from_localstorage,
      user_rules="...",
      call_strong_llm_fn=gpt4o_call,
      call_cheap_llm_fn=deepseek_call,
      strong_llm_config={"provider": "openai", "model": "gpt-4o"},
      cheap_llm_config={"provider": "deepseek", "model": "deepseek-chat"},
  )

Dependencies: same as mbr_data_cleaning.py (pandas, numpy, re, json, collections)
"""

import json
import re
from ml.api.mbr_data_cleaning import (
    profile_workbook,
    build_llm_prompt,
    CleaningEngine,
)


def _build_bootstrap_prompt(profile_result, user_rules=""):
    """
    Build prompt for strong model. Asks for complete rule store structure
    including mappings, format rules, flag rules, junk patterns.
    """
    profiles_json = json.dumps(
        profile_result, indent=2, ensure_ascii=False, default=str
    )

    system_prompt = """You are a senior data quality engineer setting up cleaning rules for a new client.

You receive a DATA QUALITY PROFILE of their Excel workbook. Your job is to generate a COMPLETE
rule configuration that will be saved and reused for all future uploads from this client.

This is a ONE-TIME setup. Be thorough - every rule you write now saves the client from
manual work on every future upload.

Return a JSON object with this exact structure:

{
  "entity_mappings": {
    "sheet_name.column_name": {
      "variant_value": "canonical_value",
      ...
    }
  },

  "categorical_rules": {
    "sheet_name.column_name": {
      "variant_value": "canonical_value",
      ...
    }
  },

  "format_rules": {
    "date_formats_by_source": {
      "source_system_value": "format_string",
      ...
    },
    "sku_case": "upper",
    "currency_code_overrides": {
      "variant": "standard_iso",
      ...
    }
  },

  "flag_rules": {
    "ignore_flags": ["list of flag types that are normal for this client"],
    "notes": "any domain-specific notes"
  },

  "junk_patterns": {
    "test_data_values": ["values that indicate test data"],
    "placeholder_dates": ["date values that are placeholders"],
    "system_accounts": ["system-generated approver names to KEEP, not delete"]
  }
}

RULES FOR GENERATING MAPPINGS:

1. ENTITY MAPPINGS (companies, suppliers, customers, locations):
   - Group ALL variants of the same entity, including cross-language variants
   - For cross-language: TSMC = Taiwan Semiconductor, Murata = village field manufacturing co, etc.
   - Pick the most formal English name as canonical (for international compatibility)
   - Include EVERY variant you see, even minor ones (trailing period, extra space)
   - ALL-CAPS variants map to proper mixed-case canonical

2. CATEGORICAL RULES (region, priority, status, UOM, currency):
   - Map ALL variants to ONE canonical value per concept
   - For multi-language categories: map all to standard English form
   - Region: use standard codes (APAC, AMER, EMEA)
   - Currency: always use ISO 4217 codes (USD, EUR, JPY, TWD, KRW)
   - UOM: pick ONE standard (PCS or EA, not both)
   - Priority: use labels (High/Medium/Low), not numbers

3. FORMAT RULES:
   - Detect date formats PER SOURCE SYSTEM if a source column exists
   - SKU case: "upper" if any lowercase SKUs found, else "preserve"
   - Currency code variants (TWD vs NTD, jpy vs JPY)

4. FLAG RULES:
   - Identify which logical violations are NORMAL for this client
   - These should be flagged but not treated as errors

5. JUNK PATTERNS:
   - Identify test data markers, placeholder dates
   - SYSTEM, MIGRATION, AUTO, BATCH are system accounts - mark as "keep"

Be exhaustive. It's better to over-specify than under-specify.
RESPOND WITH ONLY VALID JSON. No markdown fences, no explanation."""

    user_prompt = f"""## Data Quality Profile

{profiles_json}
"""

    if user_rules and user_rules.strip():
        user_prompt += f"""
## Client-Provided Rules (HIGHEST PRIORITY - incorporate these exactly)
{user_rules.strip()}
"""

    user_prompt += """
Generate the complete rule store JSON for this client.
Include EVERY variant you can find in the profile. Be thorough."""

    return system_prompt, user_prompt


def _compute_coverage(profile_result, rules_json):
    """
    Compute how well the rule store covers the current data.
    Returns 0.0 ~ 1.0
    """
    if not rules_json:
        return 0.0

    all_mappings = {}
    all_mappings.update(rules_json.get("entity_mappings", {}))
    all_mappings.update(rules_json.get("categorical_rules", {}))

    total_columns = 0
    covered_columns = 0

    for sheet_name, sp in profile_result["sheet_profiles"].items():
        for col_name, col_info in sp["columns"].items():
            vc = col_info.get("value_counts")
            if not vc or col_info.get("unique_count", 0) > 50:
                continue
            if col_info.get("numeric_stats") and not col_info.get("non_numeric_values"):
                continue

            col_key = f"{sheet_name}.{col_name}"
            total_columns += 1

            if col_key in all_mappings and all_mappings[col_key]:
                covered_columns += 1

    return covered_columns / max(total_columns, 1)


def should_use_bootstrap(profile_result, existing_rules=None):
    """
    Decide which mode to use.

    Returns:
      "bootstrap"   - use strong model to build rules
      "incremental" - use cheap model for delta
      "engine_only" - rule store fully covers, no LLM needed
    """
    if not existing_rules:
        return "bootstrap"

    coverage = _compute_coverage(profile_result, existing_rules)

    if coverage >= 0.9:
        # Check for new values not in mapping
        all_mappings = {}
        all_mappings.update(existing_rules.get("entity_mappings", {}))
        all_mappings.update(existing_rules.get("categorical_rules", {}))

        new_values_count = 0
        for sheet_name, sp in profile_result["sheet_profiles"].items():
            for col_name, col_info in sp["columns"].items():
                col_key = f"{sheet_name}.{col_name}"
                if col_key not in all_mappings:
                    continue
                vc = col_info.get("value_counts", {})
                known = set(all_mappings[col_key].keys()) | set(all_mappings[col_key].values())
                for val in vc:
                    if str(val) not in known:
                        new_values_count += 1

        if new_values_count <= 5:
            return "engine_only"
        else:
            return "incremental"

    elif coverage >= 0.5:
        return "incremental"
    else:
        return "bootstrap"


def bootstrap_rules(sheets_dict, call_llm_fn, llm_config, user_rules=""):
    """
    Use strong model to generate complete rule store.
    """
    profile = profile_workbook(sheets_dict)
    sys_prompt, usr_prompt = _build_bootstrap_prompt(profile, user_rules)

    rules_json = None
    for attempt in range(3):
        try:
            raw = call_llm_fn(sys_prompt, usr_prompt, llm_config)

            # Clean reasoner thinking tokens (DeepSeek-R1 etc.)
            raw = raw.strip()
            start = raw.find('{')
            end = raw.rfind('}')
            if start != -1 and end != -1:
                raw = raw[start:end + 1]

            # Clean markdown fences
            raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
            raw = re.sub(r"\s*```$", "", raw.strip())
            rules_json = json.loads(raw)
            break
        except (json.JSONDecodeError, Exception) as e:
            if attempt == 2:
                return {"error": f"Failed to parse LLM response after 3 attempts: {str(e)}"}

    rules_json = _validate_and_normalize(rules_json)

    rules_json["_metadata"] = {
        "created_by": llm_config.get("model", "unknown"),
        "profile_summary": {
            name: {"rows": sp["row_count"], "columns": sp["column_count"]}
            for name, sp in profile["sheet_profiles"].items()
        }
    }

    return rules_json


def _validate_and_normalize(rules):
    """Ensure rule store structure is complete."""
    defaults = {
        "entity_mappings": {},
        "categorical_rules": {},
        "format_rules": {
            "date_formats_by_source": {},
            "sku_case": "preserve",
            "currency_code_overrides": {}
        },
        "flag_rules": {
            "ignore_flags": [],
            "notes": ""
        },
        "junk_patterns": {
            "test_data_values": [],
            "placeholder_dates": ["9999-12-31", "1900-01-01", "0000-00-00"],
            "system_accounts": ["SYSTEM", "MIGRATION", "AUTO", "BATCH"]
        }
    }

    for key, default_val in defaults.items():
        if key not in rules:
            rules[key] = default_val
        elif isinstance(default_val, dict):
            for sub_key, sub_val in default_val.items():
                if sub_key not in rules[key]:
                    rules[key][sub_key] = sub_val

    return rules


def convert_rules_to_engine_mappings(rules_json):
    """
    Convert full rule store format to flat mapping format for CleaningEngine.
    """
    engine_mappings = {}

    for section in ["entity_mappings", "categorical_rules"]:
        for col_key, mapping in rules_json.get(section, {}).items():
            if col_key not in engine_mappings:
                engine_mappings[col_key] = {}
            engine_mappings[col_key].update(mapping)

    return engine_mappings


def merge_rules(existing_rules, new_mappings):
    """
    Merge new LLM mappings into existing rule store.
    New values override old ones.
    """
    updated = json.loads(json.dumps(existing_rules))  # deep copy

    for col_key, mapping in new_mappings.items():
        col_name = col_key.split(".", 1)[-1] if "." in col_key else col_key
        entity_keywords = ["customer", "supplier", "location", "company", "vendor", "name"]
        is_entity = any(kw in col_name.lower() for kw in entity_keywords)

        section = "entity_mappings" if is_entity else "categorical_rules"

        if col_key not in updated.get(section, {}):
            updated.setdefault(section, {})[col_key] = {}

        for variant, canonical in mapping.items():
            if variant not in ("__HEADER_ROW__", "__TEST_DATA__"):
                updated[section][col_key][variant] = canonical

    return updated


# ================================================================
# Main pipeline entry point
# ================================================================

def execute_with_rule_store(
    sheets_dict,
    existing_rules=None,
    user_rules="",
    call_strong_llm_fn=None,
    call_cheap_llm_fn=None,
    strong_llm_config=None,
    cheap_llm_config=None,
):
    """
    Complete pipeline with automatic mode selection.

    Returns:
        {
            "result": { ... },
            "artifacts": [ ... ],
            "updated_rules": rule_store_json,
            "mode_used": "bootstrap" | "incremental" | "engine_only",
            "profile": { ... }
        }
    """
    # Stage 0: Profile
    profile = profile_workbook(sheets_dict)

    # Stage 1: Decide mode
    mode = should_use_bootstrap(profile, existing_rules)

    # Stage 2: Get mappings
    llm_mappings = {}
    updated_rules = existing_rules or {}

    if mode == "bootstrap" and call_strong_llm_fn:
        updated_rules = bootstrap_rules(
            sheets_dict, call_strong_llm_fn,
            strong_llm_config or {}, user_rules
        )
        if "error" not in updated_rules:
            llm_mappings = convert_rules_to_engine_mappings(updated_rules)
        else:
            mode = "incremental"  # fallback

    if mode == "incremental" and call_cheap_llm_fn:
        llm_mappings = convert_rules_to_engine_mappings(updated_rules)

        # Incremental: ask cheap model for new values only
        sys_prompt, usr_prompt = build_llm_prompt(profile, user_rules, llm_mappings)
        if sys_prompt:
            for attempt in range(3):
                try:
                    raw = call_cheap_llm_fn(sys_prompt, usr_prompt, cheap_llm_config or {})
                    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                    raw = re.sub(r"\s*```$", "", raw.strip())
                    new_mappings = json.loads(raw)
                    llm_mappings.update(new_mappings)
                    updated_rules = merge_rules(updated_rules, new_mappings)
                    break
                except (json.JSONDecodeError, Exception):
                    if attempt == 2:
                        pass

    elif mode == "engine_only":
        llm_mappings = convert_rules_to_engine_mappings(updated_rules)

    elif mode == "bootstrap" and not call_strong_llm_fn:
        # No strong model available, fall back to cheap
        if call_cheap_llm_fn:
            mode = "incremental"
            sys_prompt, usr_prompt = build_llm_prompt(profile, user_rules)
            if sys_prompt:
                for attempt in range(3):
                    try:
                        raw = call_cheap_llm_fn(sys_prompt, usr_prompt, cheap_llm_config or {})
                        raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                        raw = re.sub(r"\s*```$", "", raw.strip())
                        llm_mappings = json.loads(raw)
                        updated_rules = merge_rules(updated_rules, llm_mappings)
                        break
                    except (json.JSONDecodeError, Exception):
                        if attempt == 2:
                            pass

    # Stage 3: Engine clean
    engine = CleaningEngine(profile, llm_mappings)
    cleaned = engine.clean_workbook(sheets_dict)

    # Build response
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

    total_orig = sum(p["row_count"] for p in profile["sheet_profiles"].values())
    total_clean = sum(len(df) for df in cleaned.values())

    return {
        "result": {
            "sheets_processed": len(cleaned),
            "total_original_rows": total_orig,
            "total_cleaned_rows": total_clean,
            "processing_complete": True,
            "mode_used": mode,
        },
        "artifacts": artifacts,
        "updated_rules": updated_rules,
        "mode_used": mode,
        "profile": profile,
    }
