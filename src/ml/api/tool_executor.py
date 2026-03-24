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
    # Analysis mode: uses analysis-specific prompt + server-side dataset loading
    analysis_mode: Optional[bool] = False
    # Dataset source for analysis mode (e.g. "olist")
    dataset: Optional[str] = None
    # SSE context: if provided, publishes code to SSE channel before execution
    task_id: Optional[str] = None
    step_name: Optional[str] = None
    step_index: Optional[int] = None


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

CRITICAL — FUNCTION STRUCTURE:
- The run() function MUST end with `return {"result": ..., "artifacts": [...]}`. NEVER forget the return statement.
- Keep code concise. If asked for many outputs, use a helper function and loop — do NOT write 200+ lines of repetitive code.
- Use try/except for each optional output so one error doesn't crash the whole function.
- Build the artifacts list incrementally: `artifacts = []` then `artifacts.append(...)` for each output.

Return ONLY a JSON object (no markdown, no explanation):
{
  "code": "import pandas as pd\\n...",
  "description": "Brief description of what the code does"
}"""


# ---------------------------------------------------------------------------
# Analysis-specific code generation prompt (Claude-style statistical analysis)
# ---------------------------------------------------------------------------

ANALYSIS_CODE_GEN_SYSTEM_PROMPT = """You are an expert statistical data analyst. Given a task description and a pre-loaded dataset (available as `tables` dict of DataFrames), generate Python code for comprehensive business analysis.

CRITICAL RULES:
1. Your code MUST define `run(input_data, prior_artifacts, tables)` where `tables` is a Dict[str, pd.DataFrame].
   - `tables` keys: customers, orders, order_items, payments, reviews, products, sellers, geolocation, category_translation
   - Use `tables["orders"]` etc. to access DataFrames directly — no file I/O needed.
   - If `tables` is empty, fall back to `input_data["sheets"]`.
2. Available libraries: pandas, numpy, json, re, math, datetime, collections, statistics, itertools, functools, scipy, scipy.stats, statsmodels (statsmodels.tsa.seasonal.seasonal_decompose, statsmodels.tsa.holtwinters.ExponentialSmoothing, statsmodels.tsa.stattools.adfuller), sklearn (sklearn.cluster.KMeans, sklearn.linear_model.LinearRegression, sklearn.preprocessing.StandardScaler), calendar
3. DO NOT import os, sys, subprocess, importlib, shutil, or any I/O libraries.
4. DO NOT use open(), exec(), eval(), __import__(), compile().

ANALYSIS PATTERNS — use these proven techniques:

A. BUSINESS TIER SEGMENTATION with pd.cut:
   ```python
   bins = [0, 500, 2000, 10000, 50000, float('inf')]
   labels = ['Micro', 'Small', 'Medium', 'Large', 'Enterprise']
   df['tier'] = pd.cut(df['revenue'], bins=bins, labels=labels)
   tier_stats = df.groupby('tier', observed=True).agg(count=('id','count'), total=('revenue','sum'), avg=('revenue','mean'))
   ```

B. GINI COEFFICIENT (vectorized, no loops):
   ```python
   values = np.sort(df['revenue'].values.astype(float))
   n = len(values)
   index = np.arange(1, n + 1)
   gini = (2 * np.sum(index * values) - (n + 1) * np.sum(values)) / (n * np.sum(values)) if np.sum(values) > 0 else 0
   ```

C. LORENZ CURVE DATA:
   ```python
   sorted_vals = np.sort(df['revenue'].values.astype(float))
   cum_share = np.cumsum(sorted_vals) / sorted_vals.sum() * 100
   pop_share = np.arange(1, len(sorted_vals) + 1) / len(sorted_vals) * 100
   # Sample ~50 points for chart
   indices = np.linspace(0, len(cum_share) - 1, 50).astype(int)
   lorenz_data = [{"x": round(pop_share[i], 1), "y": round(cum_share[i], 1)} for i in indices]
   lorenz_data.insert(0, {"x": 0, "y": 0})
   ```

D. MULTI-DIMENSIONAL GROUPBY + AGG (one groupby, many metrics):
   ```python
   stats = df.groupby('seller_id').agg(
       total_revenue=('price', 'sum'),
       order_count=('order_id', 'nunique'),
       avg_price=('price', 'mean'),
       avg_review=('review_score', 'mean'),
       first_order=('order_purchase_timestamp', 'min'),
   ).reset_index()
   ```

E. CORRELATION ANALYSIS:
   ```python
   from scipy import stats as sp
   corr, pval = sp.pearsonr(df['metric_a'].dropna(), df['metric_b'].dropna())
   ```

F. CONCENTRATION METRICS:
   ```python
   sorted_desc = df.sort_values('revenue', ascending=False)
   n = len(sorted_desc)
   for pct in [1, 5, 10, 20]:
       top_n = int(n * pct / 100)
       share = sorted_desc.head(top_n)['revenue'].sum() / sorted_desc['revenue'].sum() * 100
   ```

G. TIME SERIES DECOMPOSITION (statsmodels):
   ```python
   from statsmodels.tsa.seasonal import seasonal_decompose
   ts = df.set_index('date')['revenue'].asfreq('M')
   result = seasonal_decompose(ts, model='additive', period=12)
   trend_data = result.trend.dropna().reset_index()
   ```

H. CUSTOMER SEGMENTATION (sklearn KMeans):
   ```python
   from sklearn.cluster import KMeans
   from sklearn.preprocessing import StandardScaler
   features = df[['total_revenue', 'order_count', 'avg_review']].dropna()
   scaled = StandardScaler().fit_transform(features)
   km = KMeans(n_clusters=4, random_state=42, n_init=10).fit(scaled)
   df.loc[features.index, 'segment'] = km.labels_
   ```

OUTPUT FORMAT — return artifacts matching AnalysisResultCard shape:
```python
{
    "result": {"analysisType": "seller_concentration", "title": "...", "summary": "..."},
    "artifacts": [{
        "type": "analysis_result",
        "label": "Analysis Title",
        "data": {
            "analysisType": "seller_concentration",
            "title": "Seller Revenue Concentration Analysis",
            "summary": "One-paragraph executive summary with key numbers",
            "metrics": {"Total Sellers": "2,970", "Gini Coefficient": "0.789", ...},
            "charts": [
                {"type": "lorenz", "title": "Lorenz Curve", "data": [{"x": 0, "y": 0}, ...], "xKey": "x", "yKey": "y", "gini": 0.789},
                {"type": "bar", "title": "Revenue by Tier", "data": [...], "xKey": "tier", "yKey": "revenue"}
            ],
            "tables": [{"title": "Top 10 Sellers", "columns": ["Seller", "Revenue", "Orders"], "rows": [...]}],
            "highlights": ["Top 1% sellers contribute 25% revenue", "Gini = 0.789 (high concentration)"],
            "details": ["Additional observations..."],
            "key_findings": [
                {"finding": "Revenue is highly concentrated (Gini=0.789)", "severity": "high", "implication": "Platform depends on top sellers"}
            ],
            "anomalies": [
                {"dimension": "state", "value": "BA", "metric": "avg_revenue", "actual": 15447, "context": "Only 18 sellers but highest avg revenue"}
            ],
            "recommendations": [
                {"action": "Diversify seller base in underrepresented states", "priority": "P1"}
            ],
            "deep_dive_suggestions": [
                {"id": "dd1", "label": "Seller Churn Analysis", "query": "Which sellers are declining in orders quarter-over-quarter?"},
                {"id": "dd2", "label": "Category Concentration", "query": "How concentrated is revenue within each product category?"}
            ]
        }
    }]
}
```

CRITICAL NOTES:
- Produce MULTIPLE artifacts if the analysis covers multiple dimensions.
- Each artifact MUST have type="analysis_result" and follow the data shape above.
- Charts: use type "horizontal_bar" for rankings/distributions (sorted descending), "bar" for comparisons, "line" for time trends, "area" for cumulative trends, "pie" or "donut" for composition/proportions, "scatter" for correlations between two numeric variables, "stacked_bar" for composition over time, "grouped_bar" for multi-dimension comparisons, "histogram" for frequency distributions, "lorenz" for Lorenz curves/inequality.
- For histogram charts: data = [{"bin": "0-100", "count": 45}, ...], xKey="bin", yKey="count".
- metrics dict: keys are display labels, values are pre-formatted strings.
- highlights: short badge-style strings (1 line each).
- key_findings: include severity (high/medium/low) and business implication.
- deep_dive_suggestions: actionable follow-up questions the user can click.
- Keep string literals SHORT and ASCII-only. No Chinese/CJK in code — put those in output data only.
- Handle missing values with .fillna() or .dropna().
- Use pd.to_numeric(col, errors='coerce') for mixed types.
- The run() function MUST return {"result": ..., "artifacts": [...]}.

Return ONLY a JSON object (no markdown, no explanation):
{
  "code": "import pandas as pd\\nimport numpy as np\\n...",
  "description": "Brief description of what the code does"
}"""


def _build_analysis_data_schema(table_schemas: dict) -> str:
    """Build schema description for analysis mode using server-side loaded tables."""
    parts = ["\n## Dataset Tables (pre-loaded as `tables` dict of DataFrames)"]
    parts.append("Access via: `tables['table_name']` → pd.DataFrame")
    for name, info in table_schemas.items():
        row_count = info.get("row_count", "?")
        cols = info.get("columns", [])
        col_names = [c["name"] for c in cols]
        parts.append(f"\n### tables['{name}'] ({row_count:,} rows)")
        parts.append(f"Columns: {col_names}")
        # Show dtype + sample for each column
        for c in cols[:20]:
            sample_str = ", ".join(c.get("sample", [])[:2])
            parts.append(f"  - `{c['name']}` ({c['dtype']}): {sample_str}")
    return "\n".join(parts)


def _build_code_gen_prompt(request: ToolExecutionRequest) -> str:
    parts = [f"## Task\n{request.tool_hint}"]

    # Analysis mode: show table schemas from server-side loaded data
    if request.analysis_mode and hasattr(request, '_table_schemas') and request._table_schemas:
        parts.append(_build_analysis_data_schema(request._table_schemas))

    # Data schema — show ALL columns with types and sample values
    elif request.input_data.get("sheets"):
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
    # statsmodels — time series decomposition, Holt-Winters, stationarity tests
    "statsmodels", "statsmodels.api", "statsmodels.tsa",
    "statsmodels.tsa.seasonal", "statsmodels.tsa.holtwinters",
    "statsmodels.tsa.stattools", "statsmodels.formula.api",
    # sklearn — clustering, regression, preprocessing, metrics
    "sklearn", "sklearn.cluster", "sklearn.preprocessing",
    "sklearn.linear_model", "sklearn.ensemble", "sklearn.metrics",
    "sklearn.decomposition",
    # calendar — month/day name utilities
    "calendar",
    # openpyxl — for LLM-generated Excel workbook code
    "openpyxl", "openpyxl.styles", "openpyxl.utils", "openpyxl.chart",
    "openpyxl.chart.series", "openpyxl.chart.label", "openpyxl.chart.reference",
    "openpyxl.formatting", "openpyxl.formatting.rule",
    # Internal modules used by pandas/datetime — needed for date parsing
    "_strptime", "zoneinfo", "dateutil", "dateutil.parser",
    "pytz", "warnings", "typing", "abc", "enum",
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


def _execute_code(code: str, input_data: dict, prior_artifacts: dict, tables: Optional[Dict[str, Any]] = None) -> dict:
    """
    Execute Python code in a restricted namespace with pandas/numpy available.
    Returns { ok, result, artifacts, stdout, stderr, execution_ms }.

    Args:
        tables: Optional dict of pre-loaded DataFrames (for analysis mode).
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

            # Pass tables if available (analysis mode)
            import inspect
            sig = inspect.signature(run_fn)
            if len(sig.parameters) >= 3 and tables:
                raw_result = run_fn(input_data, prior_artifacts, tables)
            else:
                raw_result = run_fn(input_data, prior_artifacts)

        execution_ms = int((time.time() - start) * 1000)

        # Safety net: if run() returned None, try to find artifacts in namespace
        if raw_result is None:
            # Check if there's a global 'artifacts' or 'result' in namespace
            ns_artifacts = namespace.get("artifacts") or namespace.get("_artifacts")
            ns_result = namespace.get("result") or namespace.get("_result")
            if ns_artifacts or ns_result:
                raw_result = {"result": ns_result or {}, "artifacts": ns_artifacts or []}
                logger.warning("[tool_executor] run() returned None but found artifacts in namespace — using them")

        if not isinstance(raw_result, dict):
            return {
                "ok": False,
                "error": f"run() must return a dict, got {type(raw_result).__name__}",
                "stdout": stdout_buf.getvalue(),
                "stderr": stderr_buf.getvalue(),
                "execution_ms": execution_ms,
            }

        # Extract and sanitize artifacts
        # Some recipes nest artifacts under result.artifacts — check both levels
        artifacts = raw_result.get("artifacts", [])
        if not artifacts and isinstance(raw_result.get("result"), dict):
            artifacts = raw_result["result"].get("artifacts", [])
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
    match = re.search(r'```(?:python|json)?\s*\n(.*?)```', response_text, re.DOTALL)
    if match:
        inner = match.group(1).strip()
        # If the markdown block looks like JSON (starts with {), try parsing it
        if inner.startswith('{'):
            try:
                data = json.loads(inner)
                if isinstance(data, dict) and "code" in data:
                    return data["code"]
            except (json.JSONDecodeError, ValueError):
                # JSON parse failed — try manual extraction of the "code" value
                # This handles cases where the code string has invalid JSON escapes
                code = _manual_extract_code_from_json(inner)
                if code:
                    return code
        else:
            # Raw Python code in markdown block
            return inner

    # Try extracting JSON from full response text (handles responses with text + JSON)
    if '"code"' in response_text:
        code = _manual_extract_code_from_json(response_text)
        if code:
            return code

    # If it looks like raw Python code, use it
    if 'def run(' in response_text:
        return response_text.strip()

    return None


def _manual_extract_code_from_json(text: str) -> Optional[str]:
    """Extract Python code from a JSON-like string when json.loads fails.

    Handles cases where the LLM generates a JSON wrapper around code but the
    code string contains characters that break standard JSON parsing (e.g.
    unescaped backslashes in regex patterns, CJK characters, etc.)
    """
    # Find "code": " and then capture everything until the closing "
    # We need to handle escaped quotes inside the code string
    match = re.search(r'"code"\s*:\s*"', text)
    if not match:
        return None

    start = match.end()
    # Walk forward, handling escaped characters
    result = []
    i = start
    while i < len(text):
        ch = text[i]
        if ch == '\\' and i + 1 < len(text):
            next_ch = text[i + 1]
            if next_ch == 'n':
                result.append('\n')
            elif next_ch == 't':
                result.append('\t')
            elif next_ch == '"':
                result.append('"')
            elif next_ch == '\\':
                result.append('\\')
            elif next_ch == 'r':
                result.append('\r')
            elif next_ch == '/':
                result.append('/')
            else:
                # Keep the backslash for unknown escapes (e.g. \b in regex)
                result.append('\\')
                result.append(next_ch)
            i += 2
        elif ch == '"':
            # Unescaped quote = end of string
            break
        else:
            result.append(ch)
            i += 1

    code = ''.join(result)
    if 'def run(' in code and len(code) > 50:
        return code
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

    When analysis_mode=True, uses analysis-specific prompt and loads
    dataset tables from server-side CSV cache.
    """
    start_time = time.time()

    code = request.code

    _used_provider = None
    _used_model = None

    # Analysis mode: load dataset tables + attach schemas to request
    _loaded_tables = None
    if request.analysis_mode:
        try:
            from ml.api.dataset_loader import load_olist_tables, get_table_schemas
            _loaded_tables = load_olist_tables()
            request._table_schemas = get_table_schemas()
            logger.info(f"[tool_executor] Analysis mode: loaded {len(_loaded_tables)} tables")
        except Exception as e:
            logger.warning(f"[tool_executor] Failed to load dataset tables: {e}")

    # Select prompt based on mode
    system_prompt = ANALYSIS_CODE_GEN_SYSTEM_PROMPT if request.analysis_mode else CODE_GEN_SYSTEM_PROMPT

    # Step 1: Generate code via LLM if not provided
    if not code:
        try:
            llm_config = _pick_provider(request.llm_config)
            _used_provider = llm_config.provider
            _used_model = llm_config.model or _default_model(llm_config.provider)
            prompt = _build_code_gen_prompt(request)
            llm_response = await _call_llm(prompt, system_prompt, llm_config)
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
            llm_response2 = await _call_llm(fix_prompt, system_prompt, _pick_provider(request.llm_config))
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

    # Publish generated code to SSE channel (if task_id provided) so frontend
    # can display it in real-time BEFORE execution completes.
    if request.task_id and code:
        try:
            from ml.api.agent_sse_router import _get_or_create_channel
            import asyncio
            channel = _get_or_create_channel(request.task_id)
            sse_event = {
                "event_type": "step_event",
                "step_name": request.step_name,
                "step_index": request.step_index,
                "status": "running",
                "code": code,
                "code_language": "python",
                "timestamp": time.time(),
            }
            try:
                channel.put_nowait(sse_event)
            except asyncio.QueueFull:
                logger.warning("[tool_executor] SSE channel full, skipping code publish")
        except Exception as sse_err:
            logger.debug(f"[tool_executor] SSE code publish failed (non-blocking): {sse_err}")

    # Step 3: Execute code in sandbox (with runtime error retry)
    exec_result = _execute_code(code, request.input_data, request.prior_artifacts, tables=_loaded_tables)

    # If execution failed with a runtime error, retry once with error context
    if not exec_result.get("ok") and not request.code:
        runtime_error = exec_result.get("error", "")
        # Only retry for code-quality errors, not sandbox/resource limits
        retryable = any(kw in runtime_error for kw in [
            "KeyError", "IndexError", "NameError", "TypeError", "ValueError",
            "AttributeError", "must return a dict", "NoneType",
        ])
        if retryable:
            logger.warning(f"[tool_executor] Runtime error, retrying: {runtime_error[:200]}")
            try:
                fix_prompt = (
                    f"The previous code failed at runtime with this error:\n{runtime_error}\n\n"
                    f"The failing code started with:\n```python\n{code[:800]}\n```\n\n"
                    f"CRITICAL fixes needed:\n"
                    f"- Use df.columns.tolist() to discover actual column names before accessing\n"
                    f"- The run() function MUST return a dict with 'result' and 'artifacts' keys\n"
                    f"- Handle missing columns gracefully with if col in df.columns checks\n"
                    f"- Keep string literals short and ASCII-only\n\n"
                    f"Original task:\n{request.tool_hint}"
                )
                llm_response2 = await _call_llm(fix_prompt, system_prompt, _pick_provider(request.llm_config))
                code2 = _extract_code_from_llm(llm_response2)
                if code2:
                    safety2 = _validate_code(code2)
                    if not safety2:
                        exec_result2 = _execute_code(code2, request.input_data, request.prior_artifacts, tables=_loaded_tables)
                        if exec_result2.get("ok"):
                            code = code2
                            exec_result = exec_result2
                            logger.info("[tool_executor] Runtime retry succeeded")
                        else:
                            logger.warning(f"[tool_executor] Runtime retry also failed: {exec_result2.get('error', '')[:200]}")
            except Exception as retry_err:
                logger.warning(f"[tool_executor] Runtime retry LLM call failed: {retry_err}")

    # Step 4: Verify results
    artifacts = exec_result.get("artifacts", [])
    if exec_result.get("ok") and not artifacts:
        logger.warning("[tool_executor] Code executed successfully but produced 0 artifacts")

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
