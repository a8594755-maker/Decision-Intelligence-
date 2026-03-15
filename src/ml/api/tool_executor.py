"""
tool_executor.py
FastAPI router: POST /execute-tool

Executes AI-generated Python code in a restricted sandbox.
LLM generates Python code based on tool_hint + data schema, then the code
is executed with pandas/numpy available. Returns structured artifacts.

Multi-model routing: accepts llm_config to select provider (gemini, anthropic,
openai, deepseek). Falls back based on availability of API keys.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import sys
import time
import traceback
from contextlib import redirect_stdout, redirect_stderr
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger("tool_executor")

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
tool_executor_router = APIRouter()

# ---------------------------------------------------------------------------
# LLM API keys (env-driven) — direct keys for direct calls
# ---------------------------------------------------------------------------
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

# ---------------------------------------------------------------------------
# Supabase Edge Function ai-proxy — route through Supabase for providers
# whose API keys are stored as Edge Function secrets (Claude, OpenAI, Gemini)
# ---------------------------------------------------------------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

CODE_EXEC_TIMEOUT = int(os.getenv("DI_CODE_EXEC_TIMEOUT", "60"))
CODE_EXEC_MAX_MEMORY_MB = int(os.getenv("DI_CODE_EXEC_MAX_MEMORY_MB", "512"))

def _has_supabase_proxy() -> bool:
    """Check if Supabase ai-proxy is available."""
    return bool(SUPABASE_URL and SUPABASE_ANON_KEY)

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class LLMConfig(BaseModel):
    provider: str = "gemini"         # gemini | anthropic | openai | deepseek
    model: Optional[str] = None      # e.g. gemini-2.0-flash, claude-sonnet-4-6
    temperature: float = 0.1
    max_tokens: int = 4096
    reasoning_effort: Optional[str] = None  # none | low | medium | high  (OpenAI gpt-5.4 only)


class ToolExecutionRequest(BaseModel):
    tool_hint: str = Field(..., description="What the code should do")
    input_data: Dict[str, Any] = Field(default_factory=dict, description="sheets, total_rows, etc.")
    prior_artifacts: Dict[str, Any] = Field(default_factory=dict, description="Outputs from previous steps")
    dataset_profile: Optional[Dict[str, Any]] = None
    llm_config: Optional[LLMConfig] = None
    # Optional: pre-generated code (skip LLM generation)
    code: Optional[str] = None
    # Revision instructions from AI review
    revision_instructions: Optional[List[str]] = None


class ArtifactOut(BaseModel):
    type: str
    label: str
    data: Any


class ToolExecutionResponse(BaseModel):
    ok: bool
    result: Optional[Any] = None
    artifacts: List[ArtifactOut] = []
    metadata: Optional[Dict[str, Any]] = None
    code: Optional[str] = None
    stdout: str = ""
    stderr: str = ""
    execution_ms: int = 0
    error: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None


# ---------------------------------------------------------------------------
# Multi-model LLM caller
# ---------------------------------------------------------------------------

def _default_model(provider: str) -> str:
    return {
        "gemini": os.getenv("DI_GEMINI_MODEL", "gemini-3.1-pro-preview"),
        "anthropic": os.getenv("DI_ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        "openai": os.getenv("DI_OPENAI_MODEL", "gpt-4.1-mini"),
        "deepseek": os.getenv("DI_DEEPSEEK_MODEL", "deepseek-chat"),
    }.get(provider, "deepseek-chat")


# Models that support the OpenAI Responses API with reasoning
_OPENAI_REASONING_MODELS = frozenset({"gpt-5.4", "gpt-5.4-mini", "o4-mini", "o3", "o3-mini"})


def _resolve_reasoning_effort(model: str, config: LLMConfig) -> Optional[str]:
    """Determine reasoning effort for OpenAI reasoning models."""
    if model not in _OPENAI_REASONING_MODELS:
        return None
    # Explicit override from config
    if config.reasoning_effort:
        return config.reasoning_effort
    # Default: medium for code generation tasks (good balance of quality/speed)
    return "medium"


def _pick_provider(config: Optional[LLMConfig]) -> LLMConfig:
    """Pick a provider with a valid API key or Supabase proxy. Falls back through the chain."""
    if config and config.provider:
        # Check if the requested provider has a direct key
        key_map = {
            "gemini": GOOGLE_API_KEY,
            "anthropic": ANTHROPIC_API_KEY,
            "openai": OPENAI_API_KEY,
            "deepseek": DEEPSEEK_API_KEY,
        }
        if key_map.get(config.provider):
            return config
        # If no direct key but Supabase proxy is available, still allow it
        if _has_supabase_proxy():
            logger.info(f"[tool_executor] No direct key for {config.provider}, routing via Supabase ai-proxy")
            return config

    # Fallback chain: direct keys first
    for provider, key in [
        ("gemini", GOOGLE_API_KEY),
        ("anthropic", ANTHROPIC_API_KEY),
        ("openai", OPENAI_API_KEY),
        ("deepseek", DEEPSEEK_API_KEY),
    ]:
        if key:
            return LLMConfig(provider=provider)

    # No direct keys — try Supabase proxy (default to anthropic for best code quality)
    if _has_supabase_proxy():
        logger.info("[tool_executor] No direct API keys, using Supabase ai-proxy with anthropic")
        return LLMConfig(provider="anthropic")

    raise ValueError("No LLM API key configured and no Supabase ai-proxy available. "
                     "Set DEEPSEEK_API_KEY or configure SUPABASE_URL + SUPABASE_ANON_KEY.")


async def _call_supabase_ai_proxy(prompt: str, system_prompt: str, provider: str,
                                   model: str, temperature: float, max_tokens: int) -> str:
    """Route LLM call through Supabase Edge Function ai-proxy.

    This allows the Python backend to use Claude, OpenAI, Gemini etc. without
    needing their API keys directly — keys are stored as Supabase secrets.
    """
    proxy_url = f"{SUPABASE_URL}/functions/v1/ai-proxy"
    auth_key = SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY

    # Map provider → ai-proxy mode
    mode_map = {
        "anthropic": "anthropic_chat",
        "openai": "openai_chat",
        "deepseek": "deepseek_chat",
        "gemini": "gemini_generate",
    }
    mode = mode_map.get(provider, "di_prompt")

    # Build payload per mode
    if mode == "gemini_generate":
        payload = {
            "prompt": prompt,
            "systemContext": system_prompt,
            "options": {
                "model": model,
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
                "responseMimeType": "application/json",
            },
        }
    elif mode in ("anthropic_chat", "openai_chat", "deepseek_chat"):
        payload = {
            "message": prompt,
            "conversationHistory": [],
            "systemPrompt": system_prompt,
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "model": model,
        }
    else:
        # di_prompt mode (generic)
        payload = {
            "provider": provider,
            "prompt": prompt,
            "model": model,
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
        }

    headers = {
        "Content-Type": "application/json",
        "apikey": auth_key,
        "Authorization": f"Bearer {auth_key}",
        "x-di-server": "true",  # Server-to-server flag — bypasses user JWT auth
    }

    logger.info(f"[tool_executor] Calling Supabase ai-proxy: mode={mode}, model={model}")

    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(proxy_url, json={"mode": mode, "payload": payload}, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    if data.get("error"):
        raise ValueError(f"ai-proxy error: {data['error']}")

    text = data.get("text", "")
    if not text:
        raise ValueError(f"ai-proxy returned empty text. Response: {json.dumps(data)[:500]}")

    usage = data.get("usage", {})
    logger.info(f"[tool_executor] ai-proxy response: {len(text)} chars, "
                f"tokens={usage.get('prompt_tokens', '?')}/{usage.get('completion_tokens', '?')}")
    return text


async def _call_llm(prompt: str, system_prompt: str, config: LLMConfig) -> str:
    """Call the selected LLM provider. Uses direct API if key available, else Supabase ai-proxy."""
    provider = config.provider
    model = config.model or _default_model(provider)
    temperature = config.temperature
    max_tokens = config.max_tokens

    logger.info(f"[tool_executor] Calling LLM: {provider}/{model}")

    # Check if we have a direct API key for this provider
    direct_key_map = {
        "gemini": GOOGLE_API_KEY,
        "anthropic": ANTHROPIC_API_KEY,
        "openai": OPENAI_API_KEY,
        "deepseek": DEEPSEEK_API_KEY,
    }
    has_direct_key = bool(direct_key_map.get(provider))

    if has_direct_key:
        # Direct API call (fastest, no proxy overhead)
        if provider == "gemini":
            return await _call_gemini(prompt, system_prompt, model, temperature, max_tokens)
        elif provider == "anthropic":
            return await _call_anthropic(prompt, system_prompt, model, temperature, max_tokens)
        elif provider == "openai":
            return await _call_openai(prompt, system_prompt, model, temperature, max_tokens, config)
        elif provider == "deepseek":
            return await _call_deepseek(prompt, system_prompt, model, temperature, max_tokens)

    # No direct key — route through Supabase ai-proxy
    if _has_supabase_proxy():
        return await _call_supabase_ai_proxy(prompt, system_prompt, provider, model, temperature, max_tokens)

    raise ValueError(f"No API key for {provider} and no Supabase ai-proxy configured.")


async def _call_gemini(prompt: str, system_prompt: str, model: str, temperature: float, max_tokens: int) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GOOGLE_API_KEY}"
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
        },
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return text


async def _call_anthropic(prompt: str, system_prompt: str, model: str, temperature: float, max_tokens: int) -> str:
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": system_prompt,
        "messages": [{"role": "user", "content": prompt}],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    return data["content"][0]["text"]


async def _call_openai(prompt: str, system_prompt: str, model: str, temperature: float, max_tokens: int, config: Optional[LLMConfig] = None) -> str:
    """Call OpenAI. Uses Responses API for reasoning models (gpt-5.4 etc.), Chat Completions for others."""
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    reasoning_effort = _resolve_reasoning_effort(model, config or LLMConfig())

    if reasoning_effort:
        # ── Responses API (for reasoning models) ──────────────────────────
        url = "https://api.openai.com/v1/responses"
        payload = {
            "model": model,
            "instructions": system_prompt,
            "input": prompt,
            "reasoning": {
                "effort": reasoning_effort,
                "summary": "auto",
            },
            "text": {"format": {"type": "text"}},
            "max_output_tokens": max_tokens,
        }
        # Reasoning models don't support temperature
        logger.info(f"[tool_executor] OpenAI Responses API: model={model}, reasoning.effort={reasoning_effort}")

        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        # Extract text from output items
        for item in data.get("output", []):
            if item.get("type") == "message":
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        return content["text"]
            # Also check for direct text type
            if item.get("type") == "text":
                return item.get("text", "")

        # Fallback: try output_text shorthand
        if data.get("output_text"):
            return data["output_text"]

        raise ValueError(f"No text found in OpenAI Responses API output: {json.dumps(data)[:500]}")

    else:
        # ── Chat Completions API (for non-reasoning models) ───────────────
        url = "https://api.openai.com/v1/chat/completions"
        payload = {
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
        }
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]


async def _call_deepseek(prompt: str, system_prompt: str, model: str, temperature: float, max_tokens: int) -> str:
    url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Code generation prompt
# ---------------------------------------------------------------------------

CODE_GEN_SYSTEM_PROMPT = """You are a Python data analyst. Given a task description, input data schema, and optional prior step outputs, generate Python code to accomplish the task.

CRITICAL RULES:
1. Your code MUST define a function `run(input_data, prior_artifacts)` that returns a dict with:
   - "result": summary dict (e.g. {"cleaned_rows": 9850, "issues_found": 42})
   - "artifacts": list of dicts, each with {"type": str, "label": str, "data": list_of_dicts_or_value}
2. Available libraries: pandas, numpy, json, re, math, datetime, collections, statistics, itertools, functools
3. DO NOT import os, sys, subprocess, importlib, shutil, or any I/O libraries
4. DO NOT use open(), exec(), eval(), __import__(), compile()
5. input_data has: input_data["sheets"] = {"SheetName": [list of row dicts]}, input_data.get("total_rows")
6. prior_artifacts is a dict: {"step_name": [list of artifact dicts from prior steps]}
   - Each artifact has: {"type": str, "label": str, "data": list_of_dicts}
   - To get data from prior step: prior_artifacts["step_name"][0]["data"]
7. Return data as lists of dicts (tabular) — these become Excel sheets
8. Handle missing/null values gracefully with .fillna() or defaults
9. If calculating KPIs, include both the value and its unit/description

STRING SAFETY — VERY IMPORTANT:
- NEVER embed the task description, user instructions, or any long text as string literals in your code.
- Use short English-only comments for code documentation. Keep string literals SHORT and ASCII-only.
- For labels and descriptions in output artifacts, use short English strings (e.g. "Revenue by Region", "Data Issues Log").
- NEVER put Chinese/CJK characters, pipe characters (|), or markdown formatting inside Python string literals.
- If you need to reference column names that contain non-ASCII characters, read them dynamically from the DataFrame: df.columns.tolist()

CODE QUALITY:
- ALWAYS use the EXACT column names from the Input Data Schema below. NEVER guess column names.
- Process ALL rows from the input data, not just sample rows.
- When loading sheets: df = pd.DataFrame(input_data["sheets"]["SheetName"])
- When loading prior artifacts: df = pd.DataFrame(prior_artifacts["step_name"][0]["data"])
- Use df.columns.tolist() to discover columns dynamically if unsure.
- For numeric operations, use pd.to_numeric(df[col], errors='coerce') to handle mixed types.
- ALWAYS produce at least 1 artifact. Empty artifacts = failure.
- NEVER use pd.to_datetime(infer_datetime_format=True) — removed in pandas 2.0. Just use pd.to_datetime(col, errors='coerce').
- NEVER use df.append() — removed in pandas 2.0. Use pd.concat([df, new_row]) instead.

Return ONLY a JSON object (no markdown, no explanation):
{
  "code": "import pandas as pd\\n...",
  "description": "Brief description of what the code does"
}"""


def _build_code_gen_prompt(request: ToolExecutionRequest) -> str:
    parts = [f"## Task\n{request.tool_hint}"]

    # Data schema — show ALL columns with types and sample values
    if request.input_data.get("sheets"):
        parts.append("\n## Input Data Schema")
        parts.append("Access via: `input_data['sheets']['SheetName']` → list of row dicts")
        sheets = request.input_data["sheets"]
        for sheet_name, rows in sheets.items():
            if isinstance(rows, list) and len(rows) > 0:
                parts.append(f"\n### Sheet '{sheet_name}': {len(rows)} rows")

                # Column analysis: name, type, sample values
                sample = rows[0] if isinstance(rows[0], dict) else {}
                cols_info = []
                for col_name, val in sample.items():
                    val_type = type(val).__name__ if val is not None else "null"
                    cols_info.append(f"  - `{col_name}` ({val_type}): {json.dumps(val, default=str, ensure_ascii=False)[:80]}")
                parts.append("Columns:")
                parts.extend(cols_info[:40])

                # Show 3 sample rows
                parts.append("Sample rows:")
                for i, row in enumerate(rows[:3]):
                    parts.append(f"  Row {i+1}: {json.dumps(row, default=str, ensure_ascii=False)[:600]}")

    elif request.input_data:
        # Might have data in other format
        parts.append(f"\n## Input Data Keys: {list(request.input_data.keys())}")

    # Dataset profile (summary)
    if request.dataset_profile:
        parts.append("\n## Dataset Profile Summary")
        profile = request.dataset_profile
        if "sheets" in profile:
            for s in profile["sheets"][:10]:
                if isinstance(s, str):
                    parts.append(f"- {s}")
                elif isinstance(s, dict):
                    parts.append(f"- {s.get('name', '?')}: {s.get('rowCount', '?')} rows, {s.get('columnCount', '?')} columns")
                    if "columns" in s:
                        col_names = [c.get('name', c) if isinstance(c, dict) else str(c) for c in s['columns'][:20]]
                        parts.append(f"  Columns: {col_names}")

    # Prior artifacts — show column names from artifact data
    if request.prior_artifacts:
        parts.append("\n## Prior Step Artifacts")
        parts.append("Access via: `prior_artifacts['step_name']` → list of artifact dicts, each has 'type', 'label', 'data'")
        for step_name, artifacts in request.prior_artifacts.items():
            if isinstance(artifacts, list):
                for art in artifacts[:5]:
                    if not isinstance(art, dict):
                        continue
                    label = art.get("label", art.get("type", "?"))
                    data = art.get("data")
                    if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
                        cols = list(data[0].keys())[:20]
                        parts.append(f"- {step_name} / '{label}': {len(data)} rows, columns: {cols}")
                        parts.append(f"  Sample: {json.dumps(data[0], default=str, ensure_ascii=False)[:400]}")
                    elif isinstance(data, dict):
                        parts.append(f"- {step_name} / '{label}': dict with keys {list(data.keys())[:15]}")
                    else:
                        parts.append(f"- {step_name} / '{label}': {type(data).__name__}")
            elif isinstance(artifacts, dict) and "data" in artifacts:
                parts.append(f"- {step_name}: {type(artifacts['data']).__name__}")

    # Revision instructions
    if request.revision_instructions:
        parts.append("\n## REVISION REQUIRED — Fix these issues from prior attempt:")
        for inst in request.revision_instructions:
            parts.append(f"- {inst}")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Restricted code execution
# ---------------------------------------------------------------------------

# Allowed built-in modules for the sandbox
_ALLOWED_MODULES = frozenset({
    "pandas", "numpy", "json", "re", "math", "datetime", "time",
    "collections", "statistics", "itertools", "functools",
    "decimal", "fractions", "copy", "string", "textwrap",
    "operator", "numbers", "hashlib", "base64", "uuid",
    "scipy", "scipy.stats", "scipy.interpolate", "scipy.optimize",
})

# Dangerous patterns to reject
_DANGEROUS_PATTERNS = [
    r'\bimport\s+os\b',
    r'\bimport\s+sys\b',
    r'\bimport\s+subprocess\b',
    r'\bimport\s+shutil\b',
    r'\bimport\s+importlib\b',
    r'\b__import__\s*\(',
    r'\bopen\s*\(',
    r'\bexec\s*\(',
    r'\beval\s*\(',
    r'\bcompile\s*\(',
    r'\bglobals\s*\(',
    r'\bgetattr\s*\(\s*__builtins__',
]


def _validate_code(code: str) -> Optional[str]:
    """Return error message if code contains dangerous patterns, else None."""
    for pattern in _DANGEROUS_PATTERNS:
        if re.search(pattern, code):
            return f"Blocked: code contains dangerous pattern matching '{pattern}'"
    # Syntax check — catch SyntaxError before execution
    try:
        compile(code, "<generated>", "exec")
    except SyntaxError as e:
        return f"SyntaxError in generated code: {e}"
    return None


def _execute_code(code: str, input_data: dict, prior_artifacts: dict) -> dict:
    """
    Execute Python code in a restricted namespace with pandas/numpy available.
    Returns { ok, result, artifacts, stdout, stderr, execution_ms }.
    """
    import pandas as pd
    import numpy as np

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    # Build restricted namespace — expose all safe builtins
    namespace = {
        "__builtins__": {
            # I/O
            "print": print,
            # Iterators & sequences
            "len": len,
            "range": range,
            "enumerate": enumerate,
            "zip": zip,
            "map": map,
            "filter": filter,
            "sorted": sorted,
            "reversed": reversed,
            "iter": iter,
            "next": next,
            "slice": slice,
            # Aggregation
            "min": min,
            "max": max,
            "sum": sum,
            "abs": abs,
            "round": round,
            "pow": pow,
            "divmod": divmod,
            # Type constructors
            "int": int,
            "float": float,
            "str": str,
            "bool": bool,
            "list": list,
            "dict": dict,
            "set": set,
            "tuple": tuple,
            "frozenset": frozenset,
            "bytes": bytes,
            "bytearray": bytearray,
            "complex": complex,
            "object": object,
            # Type checking & introspection
            "type": type,
            "isinstance": isinstance,
            "issubclass": issubclass,
            "hasattr": hasattr,
            "getattr": getattr,
            "setattr": setattr,
            "delattr": delattr,
            "callable": callable,
            "id": id,
            "hash": hash,
            "dir": dir,
            "vars": vars,
            "repr": repr,
            "format": format,
            "super": super,
            "property": property,
            "staticmethod": staticmethod,
            "classmethod": classmethod,
            # Logic
            "any": any,
            "all": all,
            # String / char
            "chr": chr,
            "ord": ord,
            "hex": hex,
            "bin": bin,
            "oct": oct,
            "ascii": ascii,
            # Exceptions
            "Exception": Exception,
            "ValueError": ValueError,
            "TypeError": TypeError,
            "KeyError": KeyError,
            "IndexError": IndexError,
            "AttributeError": AttributeError,
            "RuntimeError": RuntimeError,
            "NotImplementedError": NotImplementedError,
            "ZeroDivisionError": ZeroDivisionError,
            "StopIteration": StopIteration,
            "OverflowError": OverflowError,
            "ArithmeticError": ArithmeticError,
            # Constants
            "None": None,
            "True": True,
            "False": False,
            # Controlled import
            "__import__": _restricted_import,
            "__name__": "__main__",
            "__build_class__": __builtins__["__build_class__"] if isinstance(__builtins__, dict) else getattr(__builtins__, "__build_class__"),
        },
        "pd": pd,
        "np": np,
        "pandas": pd,
        "numpy": np,
        "json": json,
        "re": re,
        "math": __import__("math"),
        "datetime": __import__("datetime"),
        "collections": __import__("collections"),
        "statistics": __import__("statistics"),
    }

    start = time.time()

    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, namespace)

            # Call the run() function
            run_fn = namespace.get("run")
            if not callable(run_fn):
                return {
                    "ok": False,
                    "error": "Code must define a function `run(input_data, prior_artifacts)`",
                    "stdout": stdout_buf.getvalue(),
                    "stderr": stderr_buf.getvalue(),
                    "execution_ms": int((time.time() - start) * 1000),
                }

            raw_result = run_fn(input_data, prior_artifacts)

        execution_ms = int((time.time() - start) * 1000)

        if not isinstance(raw_result, dict):
            return {
                "ok": False,
                "error": f"run() must return a dict, got {type(raw_result).__name__}",
                "stdout": stdout_buf.getvalue(),
                "stderr": stderr_buf.getvalue(),
                "execution_ms": execution_ms,
            }

        # Extract and sanitize artifacts
        artifacts = raw_result.get("artifacts", [])
        sanitized_artifacts = []
        for art in artifacts:
            if not isinstance(art, dict):
                continue
            data = art.get("data")
            # Convert DataFrame to list of dicts
            if isinstance(data, pd.DataFrame):
                data = json.loads(data.to_json(orient="records", date_format="iso", default_handler=str))
            elif isinstance(data, pd.Series):
                data = json.loads(data.to_json(default_handler=str))
            elif isinstance(data, np.ndarray):
                data = data.tolist()
            sanitized_artifacts.append({
                "type": str(art.get("type", "data")),
                "label": str(art.get("label", "Output")),
                "data": _sanitize_result(data),
            })

        return {
            "ok": True,
            "result": _sanitize_result(raw_result.get("result")),
            "artifacts": sanitized_artifacts,
            "stdout": stdout_buf.getvalue(),
            "stderr": stderr_buf.getvalue(),
            "execution_ms": execution_ms,
        }

    except Exception as e:
        execution_ms = int((time.time() - start) * 1000)
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {str(e)}",
            "stdout": stdout_buf.getvalue(),
            "stderr": stderr_buf.getvalue() + "\n" + traceback.format_exc(),
            "execution_ms": execution_ms,
        }


def _restricted_import(name, *args, **kwargs):
    """Only allow importing whitelisted modules (including sub-modules like scipy.stats)."""
    # Check exact match or parent module match (e.g. "scipy.stats.mstats" → "scipy" is allowed)
    if name in _ALLOWED_MODULES:
        return __import__(name, *args, **kwargs)
    # Allow sub-modules if parent is whitelisted (e.g. scipy.stats.mstats if scipy is allowed)
    parts = name.split(".")
    for i in range(1, len(parts) + 1):
        if ".".join(parts[:i]) in _ALLOWED_MODULES:
            return __import__(name, *args, **kwargs)
    raise ImportError(f"Import of '{name}' is not allowed in sandbox")


def _sanitize_result(obj):
    """Make result JSON-serializable."""
    import numpy as np
    import pandas as pd

    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        v = float(obj)
        return v if v == v else None  # NaN check
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, pd.DataFrame):
        return json.loads(obj.to_json(orient="records", default_handler=str))
    if isinstance(obj, pd.Series):
        return json.loads(obj.to_json(default_handler=str))
    if isinstance(obj, dict):
        return {str(k): _sanitize_result(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_result(v) for v in obj]
    return str(obj)


def _extract_code_from_llm(response_text: str) -> Optional[str]:
    """Extract Python code from LLM response (handles JSON wrapper and code blocks)."""
    # Try parsing as JSON first
    try:
        data = json.loads(response_text)
        if isinstance(data, dict) and "code" in data:
            return data["code"]
    except (json.JSONDecodeError, ValueError):
        pass

    # Try extracting from markdown code block
    match = re.search(r'```(?:python)?\s*\n(.*?)```', response_text, re.DOTALL)
    if match:
        return match.group(1).strip()

    # Try extracting JSON from within the response
    json_match = re.search(r'\{[^{}]*"code"\s*:\s*"(.*?)"[^{}]*\}', response_text, re.DOTALL)
    if json_match:
        code = json_match.group(1)
        # Unescape
        code = code.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"')
        return code

    # If it looks like raw Python code, use it
    if 'def run(' in response_text:
        return response_text.strip()

    return None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@tool_executor_router.post("/execute-tool", response_model=ToolExecutionResponse)
async def execute_tool(request: ToolExecutionRequest):
    """
    Execute a data processing tool:
    1. If code is provided, execute it directly
    2. Otherwise, call LLM to generate Python code, then execute
    """
    start_time = time.time()

    code = request.code

    _used_provider = None
    _used_model = None

    # Step 1: Generate code via LLM if not provided
    if not code:
        try:
            llm_config = _pick_provider(request.llm_config)
            _used_provider = llm_config.provider
            _used_model = llm_config.model or _default_model(llm_config.provider)
            prompt = _build_code_gen_prompt(request)
            llm_response = await _call_llm(prompt, CODE_GEN_SYSTEM_PROMPT, llm_config)
            code = _extract_code_from_llm(llm_response)

            if not code:
                return ToolExecutionResponse(
                    ok=False,
                    error="LLM did not generate valid Python code",
                    stderr=f"Raw LLM response:\n{llm_response[:2000]}",
                    execution_ms=int((time.time() - start_time) * 1000),
                )

            logger.info(f"[tool_executor] LLM generated {len(code)} chars of Python code via {llm_config.provider}")

        except Exception as e:
            logger.error(f"[tool_executor] LLM call failed: {e}")
            return ToolExecutionResponse(
                ok=False,
                error=f"LLM code generation failed: {str(e)}",
                execution_ms=int((time.time() - start_time) * 1000),
            )

    # Step 2: Validate code safety (includes syntax check)
    safety_error = _validate_code(code)
    if safety_error and "SyntaxError" in safety_error and not request.code:
        # Syntax error in LLM-generated code — retry once with fix instruction
        logger.warning(f"[tool_executor] Syntax error in generated code, retrying: {safety_error}")
        try:
            fix_prompt = (
                f"The previous code had a syntax error:\n{safety_error}\n\n"
                f"The broken code started with:\n```\n{code[:500]}\n```\n\n"
                f"Please regenerate the code. CRITICAL: Do NOT embed long text, Chinese characters, "
                f"or markdown inside Python string literals. Use only short ASCII strings. "
                f"Keep all string literals on a single line.\n\n"
                f"Original task:\n{request.tool_hint}"
            )
            llm_response2 = await _call_llm(fix_prompt, CODE_GEN_SYSTEM_PROMPT, _pick_provider(request.llm_config))
            code2 = _extract_code_from_llm(llm_response2)
            if code2:
                safety_error2 = _validate_code(code2)
                if not safety_error2:
                    code = code2
                    safety_error = None
                    logger.info("[tool_executor] Retry succeeded — syntax error fixed")
                else:
                    safety_error = safety_error2
        except Exception as retry_err:
            logger.warning(f"[tool_executor] Retry failed: {retry_err}")

    if safety_error:
        return ToolExecutionResponse(
            ok=False,
            error=safety_error,
            code=code,
            execution_ms=int((time.time() - start_time) * 1000),
        )

    # Step 3: Execute code in sandbox
    exec_result = _execute_code(code, request.input_data, request.prior_artifacts)

    # Step 4: Verify results
    artifacts = exec_result.get("artifacts", [])
    if exec_result.get("ok") and not artifacts:
        logger.warning("[tool_executor] Code executed successfully but produced 0 artifacts")
        # Don't fail — some steps legitimately produce no artifacts (e.g. validation)

    # Build metadata
    metadata = {
        "description": f"Executed tool: {request.tool_hint[:100]}",
        "artifact_count": len(artifacts),
        "total_rows": sum(
            len(a["data"]) for a in artifacts
            if isinstance(a.get("data"), list)
        ),
    }

    return ToolExecutionResponse(
        ok=exec_result.get("ok", False),
        result=exec_result.get("result"),
        artifacts=[ArtifactOut(**a) for a in artifacts],
        metadata=metadata,
        code=code,
        stdout=exec_result.get("stdout", ""),
        stderr=exec_result.get("stderr", ""),
        execution_ms=int((time.time() - start_time) * 1000),
        error=exec_result.get("error"),
        llm_provider=_used_provider,
        llm_model=_used_model,
    )
