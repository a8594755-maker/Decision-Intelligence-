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
from fastapi import APIRouter, Request
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
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "") or os.getenv("VITE_DEEPSEEK_API_KEY", "")

# ---------------------------------------------------------------------------
# Supabase Edge Function ai-proxy — route through Supabase for providers
# whose API keys are stored as Edge Function secrets (Claude, OpenAI, Gemini)
# ---------------------------------------------------------------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "") or os.getenv("VITE_SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "") or os.getenv("VITE_SUPABASE_ANON_KEY", "")
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
    """Use the requested provider. Prefer Supabase proxy to avoid local SSL issues."""
    if config and config.provider:
        # Prefer Supabase proxy (runs on Supabase server, avoids local SSL issues)
        if _has_supabase_proxy():
            logger.info(f"[tool_executor] Routing {config.provider} via Supabase ai-proxy")
            return config
        # Fall back to direct key
        key_map = {
            "gemini": GOOGLE_API_KEY,
            "anthropic": ANTHROPIC_API_KEY,
            "openai": OPENAI_API_KEY,
            "deepseek": DEEPSEEK_API_KEY,
        }
        if key_map.get(config.provider):
            return config
        raise ValueError(f"No API key for provider '{config.provider}' and no Supabase proxy configured.")

    # No provider specified — default to deepseek via proxy
    if _has_supabase_proxy():
        return LLMConfig(provider="deepseek")
    if DEEPSEEK_API_KEY:
        return LLMConfig(provider="deepseek")

    raise ValueError("No LLM provider specified. Configure Supabase proxy or DEEPSEEK_API_KEY.")


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
        logger.info(f"[tool_executor] Routing {provider} via Supabase ai-proxy")
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
    is_reasoner = "reasoner" in model
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
    }
    # deepseek-reasoner does not support temperature parameter
    if not is_reasoner:
        payload["temperature"] = temperature
    # reasoner needs longer timeout (can take 3-5 min)
    timeout = 360 if is_reasoner else 120
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    msg = data["choices"][0]["message"]
    content = msg.get("content") or ""
    # deepseek-reasoner puts reasoning in reasoning_content; if content is empty, use that
    if not content.strip() and msg.get("reasoning_content"):
        content = msg["reasoning_content"]
    return content


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


# ---------------------------------------------------------------------------
# Data Cleaning endpoint — v3: bootstrap + rule store + automatic mode
# All LLM calls are awaited directly (no sync/async bridge needed)
# ---------------------------------------------------------------------------

@tool_executor_router.post("/execute-cleaning", response_model=ToolExecutionResponse)
async def execute_cleaning(request: ToolExecutionRequest):
    """
    v3 data cleaning pipeline with automatic mode selection:
    - bootstrap: first upload, uses deepseek-reasoner to build complete rule store
    - incremental: has rule store but incomplete, uses deepseek-chat for delta
    - engine_only: rule store fully covers, no LLM needed
    """
    start_time = time.time()

    from ml.api.gpt_bootstrap import (
        should_use_bootstrap, convert_rules_to_engine_mappings,
        merge_rules, _build_bootstrap_prompt, _validate_and_normalize,
    )
    from ml.api.mbr_data_cleaning import (
        profile_workbook, build_llm_prompt, CleaningEngine,
    )

    sheets = request.input_data.get("sheets", {})
    user_rules = request.input_data.get("user_rules", "")
    rule_store = request.input_data.get("rule_store", None)

    if not sheets:
        return ToolExecutionResponse(
            ok=False, error="No sheets found in input_data",
            execution_ms=int((time.time() - start_time) * 1000),
        )

    logger.info(f"[cleaning-v3] {len(sheets)} sheets, rule_store={'yes' if rule_store else 'no'}")

    _used_provider = None
    _used_model = None

    # ── Stage 0: Profile ─────────────────────────────────────────────────
    try:
        profile = profile_workbook(sheets)
    except Exception as e:
        logger.error(f"[cleaning-v3] Profiling failed: {e}", exc_info=True)
        return ToolExecutionResponse(
            ok=False, error=f"Profiling failed: {e}",
            execution_ms=int((time.time() - start_time) * 1000),
        )

    profile_ms = int((time.time() - start_time) * 1000)
    logger.info(f"[cleaning-v3] Profiling done in {profile_ms}ms")

    # ── Stage 1: Decide mode ─────────────────────────────────────────────
    mode = should_use_bootstrap(profile, rule_store)
    logger.info(f"[cleaning-v3] Mode: {mode}")

    # ── Stage 2: Get mappings (all LLM calls are awaited directly) ───────
    llm_mappings = {}
    updated_rules = rule_store or {}

    async def _call_llm_and_parse(sys_prompt, usr_prompt, llm_cfg, strip_thinking=False):
        """Await LLM call and parse JSON response."""
        nonlocal _used_provider, _used_model
        resolved = _pick_provider(llm_cfg)
        _used_provider = resolved.provider
        _used_model = resolved.model or _default_model(resolved.provider)

        for attempt in range(3):
            try:
                raw = await _call_llm(usr_prompt, sys_prompt, resolved)
                raw = raw.strip()

                # Strip reasoner thinking tokens
                if strip_thinking:
                    start_idx = raw.find('{')
                    end_idx = raw.rfind('}')
                    if start_idx != -1 and end_idx != -1:
                        raw = raw[start_idx:end_idx + 1]

                # Strip markdown fences
                raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                raw = re.sub(r"\s*```$", "", raw.strip())
                return json.loads(raw)
            except (json.JSONDecodeError, Exception) as e:
                logger.warning(f"[cleaning-v3] Parse attempt {attempt+1} failed: {e}")
                if attempt == 2:
                    return None
        return None

    try:
        if mode == "bootstrap":
            # Use strong model (deepseek-reasoner)
            strong_cfg = LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=8000)
            sys_prompt, usr_prompt = _build_bootstrap_prompt(profile, user_rules)

            logger.info("[cleaning-v3] Bootstrap: calling deepseek-reasoner...")
            rules_json = await _call_llm_and_parse(sys_prompt, usr_prompt, strong_cfg, strip_thinking=True)

            if rules_json and "error" not in rules_json:
                updated_rules = _validate_and_normalize(rules_json)
                updated_rules["_metadata"] = {
                    "created_by": "deepseek-reasoner",
                    "profile_summary": {
                        name: {"rows": sp["row_count"], "columns": sp["column_count"]}
                        for name, sp in profile["sheet_profiles"].items()
                    }
                }
                llm_mappings = convert_rules_to_engine_mappings(updated_rules)
                logger.info(f"[cleaning-v3] Bootstrap complete: {len(llm_mappings)} mapping columns")
            else:
                logger.warning("[cleaning-v3] Bootstrap failed, falling back to incremental")
                mode = "incremental"

        if mode == "incremental":
            # Use cheap model (deepseek-chat)
            cheap_cfg = request.llm_config or LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=4000)
            llm_mappings = convert_rules_to_engine_mappings(updated_rules)

            # Only ask for values not already covered
            sys_prompt, usr_prompt = build_llm_prompt(profile, user_rules, llm_mappings)
            if sys_prompt:
                logger.info("[cleaning-v3] Incremental: calling deepseek-chat for delta...")
                new_mappings = await _call_llm_and_parse(sys_prompt, usr_prompt, cheap_cfg)
                if new_mappings:
                    llm_mappings.update(new_mappings)
                    updated_rules = merge_rules(updated_rules, new_mappings)
                    logger.info(f"[cleaning-v3] Incremental: added {len(new_mappings)} new mapping columns")
            else:
                logger.info("[cleaning-v3] Incremental: no new columns need mapping")

        elif mode == "engine_only":
            llm_mappings = convert_rules_to_engine_mappings(updated_rules)
            logger.info(f"[cleaning-v3] Engine only: {len(llm_mappings)} mapping columns from rule store")

    except Exception as e:
        logger.warning(f"[cleaning-v3] LLM stage failed: {e}. Running engine without mappings.")

    # ── Stage 3: Deterministic cleaning engine ───────────────────────────
    try:
        engine = CleaningEngine(profile, llm_mappings)
        cleaned = engine.clean_workbook(sheets)
    except Exception as e:
        logger.error(f"[cleaning-v3] Engine failed: {e}", exc_info=True)
        return ToolExecutionResponse(
            ok=False, error=f"Cleaning engine failed: {e}",
            execution_ms=int((time.time() - start_time) * 1000),
            llm_provider=_used_provider,
            llm_model=_used_model,
        )

    # ── Build response ───────────────────────────────────────────────────
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

    metadata = {
        "mode_used": mode,
        "profile_ms": profile_ms,
        "artifact_count": len(artifacts),
        "total_rows": total_clean,
        "rule_store_columns": len(
            list(updated_rules.get("entity_mappings", {}).keys()) +
            list(updated_rules.get("categorical_rules", {}).keys())
        ) if isinstance(updated_rules, dict) else 0,
    }

    logger.info(f"[cleaning-v3] Done in {int((time.time() - start_time) * 1000)}ms, mode={mode}")

    return ToolExecutionResponse(
        ok=True,
        result={
            "sheets_processed": len(cleaned),
            "total_original_rows": total_orig,
            "total_cleaned_rows": total_clean,
            "processing_complete": True,
            "updated_rules": updated_rules,
            "mode_used": mode,
        },
        artifacts=[ArtifactOut(**a) for a in artifacts],
        metadata=metadata,
        code=json.dumps(updated_rules, indent=2, ensure_ascii=False, default=str) if updated_rules else "",
        stdout="",
        stderr="",
        execution_ms=int((time.time() - start_time) * 1000),
        error=None,
        llm_provider=_used_provider,
        llm_model=_used_model,
    )


# ---------------------------------------------------------------------------
# Stepped cleaning endpoints — front-end calls each step, shows results live
# ---------------------------------------------------------------------------

@tool_executor_router.post("/cleaning/profile")
async def cleaning_step_profile(request: ToolExecutionRequest):
    """Step 1: Profile data + decide mode. No LLM call."""
    start = time.time()
    from ml.api.gpt_bootstrap import should_use_bootstrap
    from ml.api.mbr_data_cleaning import profile_workbook, profile_sheet

    sheets = request.input_data.get("sheets", {})
    rule_store = request.input_data.get("rule_store", None)

    if not sheets:
        return {"ok": False, "error": "No sheets"}

    profile = profile_workbook(sheets)
    mode = should_use_bootstrap(profile, rule_store)

    # Build prompts so frontend can call LLM directly
    from ml.api.gpt_bootstrap import _build_bootstrap_prompt
    from ml.api.mbr_data_cleaning import build_llm_prompt

    user_rules = request.input_data.get("user_rules", "")
    prompts = {}

    if mode == "bootstrap":
        # Build cross-sheet consistency hint
        # Collect shared column names across sheets to enforce consistency
        import pandas as pd
        col_values_across_sheets = {}  # col_name -> set of all values
        for sn, sd in sheets.items():
            if not sd:
                continue
            df = pd.DataFrame(sd)
            for col in df.columns:
                if df[col].dtype == 'object' and df[col].nunique() <= 20:
                    col_values_across_sheets.setdefault(col, set()).update(
                        df[col].dropna().astype(str).str.strip().unique()
                    )

        # Find columns that appear in multiple sheets
        shared_cols = [c for c in col_values_across_sheets if
                       sum(1 for sn, sd in sheets.items() if sd and c in pd.DataFrame(sd).columns) > 1]
        cross_hint = ""
        if shared_cols:
            cross_hint = "\n\nCROSS-SHEET CONSISTENCY (IMPORTANT): These columns appear in multiple sheets. "
            cross_hint += "Use the SAME canonical value across all sheets:\n"
            for col in shared_cols[:10]:
                vals = sorted(col_values_across_sheets[col])[:15]
                cross_hint += f"  - '{col}' values across sheets: {vals}\n"
            cross_hint += "Pick ONE canonical value per concept and use it consistently.\n"

        # Per-sheet prompts for parallel frontend calls
        per_sheet = {}
        for sheet_name, sheet_data in sheets.items():
            if not sheet_data:
                continue
            df = pd.DataFrame(sheet_data)
            sp = profile_sheet(df, sheet_name)
            mini = {"sheet_profiles": {sheet_name: sp}, "cross_sheet_issues": []}
            sys_p, usr_p = _build_bootstrap_prompt(mini, user_rules)
            # Inject cross-sheet hint into user prompt
            if cross_hint:
                usr_p = usr_p + cross_hint
            per_sheet[sheet_name] = {"system": sys_p, "user": usr_p}
        prompts["per_sheet"] = per_sheet
    elif mode == "incremental":
        from ml.api.gpt_bootstrap import convert_rules_to_engine_mappings
        existing_mappings = convert_rules_to_engine_mappings(rule_store) if rule_store else {}
        sys_p, usr_p = build_llm_prompt(profile, user_rules, existing_mappings)
        if sys_p:
            prompts["system"] = sys_p
            prompts["user"] = usr_p

    return {
        "ok": True,
        "profile": profile,
        "mode": mode,
        "prompts": prompts,
        "execution_ms": int((time.time() - start) * 1000),
    }


@tool_executor_router.post("/cleaning/mapping")
async def cleaning_step_mapping(request: ToolExecutionRequest):
    """Step 2: Call LLM for mapping rules — per-sheet parallel for bootstrap."""
    start = time.time()
    import asyncio
    from ml.api.gpt_bootstrap import (
        _build_bootstrap_prompt, _validate_and_normalize,
        convert_rules_to_engine_mappings, merge_rules,
    )
    from ml.api.mbr_data_cleaning import (
        profile_workbook, profile_sheet, build_llm_prompt,
    )

    sheets = request.input_data.get("sheets", {})
    user_rules = request.input_data.get("user_rules", "")
    rule_store = request.input_data.get("rule_store", None)
    profile = request.input_data.get("profile", {})
    mode = request.input_data.get("mode", "incremental")

    _used_provider = None
    _used_model = None
    llm_mappings = {}
    updated_rules = rule_store or {}

    async def _call_and_parse(sys_p, usr_p, cfg, strip_thinking=False):
        nonlocal _used_provider, _used_model
        resolved = _pick_provider(cfg)
        _used_provider = resolved.provider
        _used_model = resolved.model or _default_model(resolved.provider)

        for attempt in range(3):
            try:
                raw = await _call_llm(usr_p, sys_p, resolved)
                raw = raw.strip()
                if strip_thinking:
                    s = raw.find('{')
                    e = raw.rfind('}')
                    if s != -1 and e != -1:
                        raw = raw[s:e + 1]
                raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
                raw = re.sub(r"\s*```$", "", raw.strip())
                return json.loads(raw)
            except Exception as ex:
                logger.warning(f"[cleaning-mapping] attempt {attempt+1}: {ex}")
                if attempt == 2:
                    return None
        return None

    try:
        if mode == "bootstrap":
            # ── Parallel per-sheet bootstrap with concurrency limit ───────
            MAX_CONCURRENT = 3  # Max parallel LLM calls (respect API rate limits)
            cfg = LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=8000)
            sheet_names = list(sheets.keys())
            semaphore = asyncio.Semaphore(MAX_CONCURRENT)
            logger.info(f"[cleaning-mapping] Bootstrap: {len(sheet_names)} sheets, max {MAX_CONCURRENT} concurrent")

            async def _bootstrap_one_sheet(sheet_name):
                """Build profile + prompt for one sheet, call LLM with semaphore."""
                async with semaphore:
                    import pandas as pd
                    sheet_data = sheets[sheet_name]
                    if not sheet_data:
                        return sheet_name, {}
                    logger.info(f"[cleaning-mapping] Starting sheet: {sheet_name}")
                    df = pd.DataFrame(sheet_data)
                    single_profile = profile_sheet(df, sheet_name)

                    mini_profile = {
                        "sheet_profiles": {sheet_name: single_profile},
                        "cross_sheet_issues": [],
                    }
                    sys_p, usr_p = _build_bootstrap_prompt(mini_profile, user_rules)
                    result = await _call_and_parse(sys_p, usr_p, cfg, strip_thinking=True)
                    logger.info(f"[cleaning-mapping] Done sheet: {sheet_name}")
                    return sheet_name, result

            # Queue all sheets, semaphore controls concurrency
            tasks = [_bootstrap_one_sheet(sn) for sn in sheet_names]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Merge all per-sheet results
            combined_rules = {
                "entity_mappings": {},
                "categorical_rules": {},
                "format_rules": {"date_formats_by_source": {}, "sku_case": "preserve", "currency_code_overrides": {}},
                "flag_rules": {"ignore_flags": [], "notes": ""},
                "junk_patterns": {"test_data_values": [], "placeholder_dates": ["9999-12-31", "1900-01-01"], "system_accounts": ["SYSTEM", "MIGRATION", "AUTO", "BATCH"]},
            }

            for item in results:
                if isinstance(item, Exception):
                    logger.warning(f"[cleaning-mapping] Sheet failed: {item}")
                    continue
                sheet_name, rules_json = item
                if not rules_json or not isinstance(rules_json, dict):
                    continue
                for section in ["entity_mappings", "categorical_rules"]:
                    for col_key, mapping in rules_json.get(section, {}).items():
                        # Ensure col_key has sheet prefix
                        if "." not in col_key:
                            col_key = f"{sheet_name}.{col_key}"
                        combined_rules.setdefault(section, {})[col_key] = mapping
                # Merge format/flag/junk
                fr = rules_json.get("format_rules", {})
                if fr.get("sku_case") and fr["sku_case"] != "preserve":
                    combined_rules["format_rules"]["sku_case"] = fr["sku_case"]
                for k, v in fr.get("date_formats_by_source", {}).items():
                    combined_rules["format_rules"]["date_formats_by_source"][k] = v
                for k, v in fr.get("currency_code_overrides", {}).items():
                    combined_rules["format_rules"]["currency_code_overrides"][k] = v

            combined_rules["_metadata"] = {"created_by": "deepseek-reasoner (parallel)"}
            updated_rules = _validate_and_normalize(combined_rules)
            llm_mappings = convert_rules_to_engine_mappings(updated_rules)
            logger.info(f"[cleaning-mapping] Parallel bootstrap done: {len(llm_mappings)} mapping columns from {len(sheet_names)} sheets")

        if mode == "incremental":
            cfg = request.llm_config or LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=4000)
            llm_mappings = convert_rules_to_engine_mappings(updated_rules)
            sys_p, usr_p = build_llm_prompt(profile, user_rules, llm_mappings)
            if sys_p:
                new_maps = await _call_and_parse(sys_p, usr_p, cfg)
                if new_maps:
                    llm_mappings.update(new_maps)
                    updated_rules = merge_rules(updated_rules, new_maps)

        elif mode == "engine_only":
            llm_mappings = convert_rules_to_engine_mappings(updated_rules)

    except Exception as e:
        logger.warning(f"[cleaning-mapping] LLM failed: {e}")

    return {
        "ok": True,
        "mode": mode,
        "llm_mappings": llm_mappings,
        "updated_rules": updated_rules,
        "llm_provider": _used_provider,
        "llm_model": _used_model,
        "execution_ms": int((time.time() - start) * 1000),
    }


@tool_executor_router.post("/cleaning/mapping-sheet")
async def cleaning_step_mapping_sheet(request: ToolExecutionRequest):
    """Step 2b: Bootstrap mapping for a SINGLE sheet. Front-end calls N times in parallel."""
    start = time.time()
    import pandas as pd
    from ml.api.gpt_bootstrap import _build_bootstrap_prompt, _validate_and_normalize
    from ml.api.mbr_data_cleaning import profile_sheet

    sheet_name = request.input_data.get("sheet_name", "")
    sheet_data = request.input_data.get("sheet_data", [])
    user_rules = request.input_data.get("user_rules", "")

    if not sheet_name or not sheet_data:
        return {"ok": False, "error": "Missing sheet_name or sheet_data"}

    _used_provider = None
    _used_model = None

    # Profile this one sheet
    df = pd.DataFrame(sheet_data)
    single_profile = profile_sheet(df, sheet_name)
    mini_profile = {
        "sheet_profiles": {sheet_name: single_profile},
        "cross_sheet_issues": [],
    }

    # Call LLM
    cfg = LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=8000)
    resolved = _pick_provider(cfg)
    _used_provider = resolved.provider
    _used_model = resolved.model or _default_model(resolved.provider)

    sys_p, usr_p = _build_bootstrap_prompt(mini_profile, user_rules)
    rules_json = None

    for attempt in range(3):
        try:
            raw = await _call_llm(usr_p, sys_p, resolved)
            raw = raw.strip()
            s = raw.find('{')
            e = raw.rfind('}')
            if s != -1 and e != -1:
                raw = raw[s:e + 1]
            raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
            raw = re.sub(r"\s*```$", "", raw.strip())
            rules_json = json.loads(raw)
            break
        except Exception as ex:
            logger.warning(f"[mapping-sheet] {sheet_name} attempt {attempt+1}: {ex}")
            if attempt == 2:
                rules_json = None

    return {
        "ok": True,
        "sheet_name": sheet_name,
        "rules": rules_json or {},
        "profile": single_profile,
        "llm_provider": _used_provider,
        "llm_model": _used_model,
        "execution_ms": int((time.time() - start) * 1000),
    }


@tool_executor_router.post("/cleaning/apply")
async def cleaning_step_apply(request: ToolExecutionRequest):
    """Step 3: Apply mappings with deterministic engine. No LLM call."""
    start = time.time()
    from ml.api.mbr_data_cleaning import profile_workbook, CleaningEngine

    sheets = request.input_data.get("sheets", {})
    llm_mappings = request.input_data.get("llm_mappings", {})

    profile = profile_workbook(sheets)
    engine = CleaningEngine(profile, llm_mappings)
    cleaned = engine.clean_workbook(sheets)

    import math

    def _sanitize_records(records):
        """Replace NaN/Inf with None for JSON serialization."""
        for row in records:
            for k, v in row.items():
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    row[k] = None
        return records

    artifacts = []
    for sheet_name, df in cleaned.items():
        records = df.where(df.notna(), None).to_dict("records")
        artifacts.append({
            "type": "table",
            "label": f"cleaned_{sheet_name}",
            "data": _sanitize_records(records),
        })
    artifacts.append({
        "type": "summary",
        "label": "cleaning_log",
        "data": engine.get_summary(),
    })

    # Detect unmapped values — values in low-cardinality columns not covered by any mapping
    import pandas as pd
    unmapped_values = []
    all_mapped = set()
    for col_key, mapping in llm_mappings.items():
        all_mapped.update(mapping.keys())
        all_mapped.update(mapping.values())

    for sheet_name, sheet_data in sheets.items():
        if not sheet_data:
            continue
        df = pd.DataFrame(sheet_data)
        for col in df.columns:
            if df[col].dtype != 'object' or df[col].nunique() > 30:
                continue
            col_key = f"{sheet_name}.{col}"
            mapping_for_col = llm_mappings.get(col_key, {})
            if not mapping_for_col:
                continue  # Column not in mapping scope
            known = set(mapping_for_col.keys()) | set(mapping_for_col.values())
            for val in df[col].dropna().astype(str).str.strip().unique():
                if val and val not in known:
                    unmapped_values.append({"sheet": sheet_name, "column": col, "value": val})

    # Build deep-clean prompt for LLM #2
    # This tells LLM what the engine already did and what's left
    deep_clean_prompt = _build_deep_clean_prompt(profile, engine.get_log(), unmapped_values, cleaned)

    return {
        "ok": True,
        "artifacts": artifacts,
        "log": engine.get_log()[:30],
        "total_original_rows": sum(p["row_count"] for p in profile["sheet_profiles"].values()),
        "total_cleaned_rows": sum(len(df) for df in cleaned.values()),
        "unmapped_values": unmapped_values[:20],
        "deep_clean_prompt": deep_clean_prompt,
        "execution_ms": int((time.time() - start) * 1000),
    }


def _build_deep_clean_prompt(profile, engine_log, unmapped_values, cleaned_dfs):
    """Build prompt for LLM #2: generate Python code for issues the engine couldn't handle."""
    import json as _json

    system_prompt = """You are a Python data cleaning engineer. You receive:
1. A data quality profile showing detected issues
2. A log of what the deterministic engine already did
3. Remaining issues the engine could NOT handle

Generate a Python function `run(input_data, prior_artifacts)` that fixes the REMAINING issues only.
Do NOT redo what the engine already did (mapping, whitespace, dates, placeholders, dedup).

Focus on:
- Text cleaning: remove annotations like [EOL Q3], (NEW - pending approval), etc.
- Pattern-based fixes the engine missed
- Any unmapped values that need special handling
- Cross-column consistency checks the engine didn't cover

RULES:
1. input_data["sheets"] contains the ALREADY-CLEANED data from the engine
2. Return {"result": summary, "artifacts": [{"type":"table", "label":"deep_cleaned_<sheet>", "data": records}]}
3. Available: pandas, numpy, re, collections. NO os/sys/open/network.
4. Keep string literals SHORT and ASCII-only.
5. Process ALL rows, not just samples.
6. If nothing needs fixing, return the data unchanged with result: {"no_changes": true}."""

    # Build user prompt with context
    parts = ["## What the engine already did:"]
    action_counts = {}
    for entry in engine_log:
        action = entry.get("action", "")
        if action == "sheet_summary":
            parts.append(f"- {entry.get('sheet')}: {entry.get('original_rows')} → {entry.get('cleaned_rows')} rows")
        else:
            action_counts[action] = action_counts.get(action, 0) + 1
    for action, count in action_counts.items():
        parts.append(f"- {action}: {count} operations")

    parts.append("\n## Remaining issues to fix:")

    if unmapped_values:
        parts.append("Unmapped values (not covered by mapping rules):")
        for u in unmapped_values[:10]:
            parts.append(f"  - {u['sheet']}.{u['column']}: \"{u['value']}\"")

    # Show sample of cleaned data so LLM knows the current state
    parts.append("\n## Current data state (after engine cleaning):")
    for sheet_name, df in cleaned_dfs.items():
        parts.append(f"\n### {sheet_name}: {len(df)} rows, columns: {list(df.columns)}")
        # Show columns that might need text cleaning
        for col in df.columns:
            if df[col].dtype == 'object':
                sample_vals = df[col].dropna().unique()[:5]
                has_brackets = any('[' in str(v) or '(' in str(v) for v in sample_vals)
                if has_brackets:
                    parts.append(f"  {col} has bracket/paren annotations: {list(sample_vals[:3])}")

    # Show profile issues that engine didn't address
    parts.append("\n## Profile issues for reference:")
    for sheet_name, sp in profile.get("sheet_profiles", {}).items():
        for issue in sp.get("issues_detected", []):
            parts.append(f"  - {sheet_name}: {issue['type']}")

    user_prompt = "\n".join(parts)

    return {"system": system_prompt, "user": user_prompt}


@tool_executor_router.post("/cleaning/deep-clean")
async def cleaning_step_deep_clean(request: ToolExecutionRequest):
    """Step 4: Execute LLM-generated Python code on cleaned data."""
    start = time.time()

    code = request.input_data.get("code", "")
    cleaned_sheets = request.input_data.get("cleaned_sheets", {})

    if not code or not cleaned_sheets:
        return {"ok": True, "artifacts": [], "no_changes": True,
                "execution_ms": int((time.time() - start) * 1000)}

    # Validate code safety
    safety_error = _validate_code(code)
    if safety_error:
        return {"ok": False, "error": safety_error,
                "execution_ms": int((time.time() - start) * 1000)}

    # Execute in sandbox
    exec_result = _execute_code(code, {"sheets": cleaned_sheets}, {})

    import math

    def _sanitize(records):
        for row in records:
            for k, v in row.items():
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    row[k] = None
        return records

    artifacts = []
    if exec_result.get("ok"):
        for a in exec_result.get("artifacts", []):
            if isinstance(a.get("data"), list):
                a["data"] = _sanitize(a["data"])
            artifacts.append(a)

    return {
        "ok": exec_result.get("ok", False),
        "artifacts": artifacts,
        "result": exec_result.get("result"),
        "code": code,
        "error": exec_result.get("error"),
        "execution_ms": int((time.time() - start) * 1000),
    }


# =====================================================================
# KPI Calculator Endpoints (deterministic — LLM does mapping, not code)
# =====================================================================

@tool_executor_router.post("/kpi/profile")
async def kpi_profile(request: ToolExecutionRequest):
    """
    Step 1: Profile data for KPI calculation. No LLM call.
    Returns profile + prompts for frontend to call LLM.
    """
    start = time.time()
    try:
        from ml.api.kpi_calculator import profile_for_kpi, build_kpi_prompt, suggest_calculators

        sheets = request.input_data.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        profile = profile_for_kpi(sheets)
        suggestions = suggest_calculators(profile)
        selected = request.input_data.get("selected_calculators")
        sys_prompt, usr_prompt = build_kpi_prompt(profile, selected)

        return {
            "ok": True,
            "profile": profile,
            "suggestions": suggestions,
            "prompts": {"system": sys_prompt, "user": usr_prompt},
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[kpi/profile] Error: {e}")
        return {"ok": False, "error": str(e), "execution_ms": int((time.time() - start) * 1000)}


@tool_executor_router.post("/kpi/calculate")
async def kpi_calculate(request: ToolExecutionRequest):
    """
    Step 2: Execute deterministic KPI calculations from LLM config. No LLM call.
    input_data must contain: sheets + kpi_config (JSON from LLM).
    """
    start = time.time()
    try:
        from ml.api.kpi_calculator import KpiCalculator
        import pandas as pd

        sheets = request.input_data.get("sheets", {})
        kpi_config = request.input_data.get("kpi_config", {})

        if not sheets:
            return {"ok": False, "error": "No sheets provided"}
        if not kpi_config or not kpi_config.get("calculations"):
            return {"ok": False, "error": "No kpi_config or empty calculations"}

        # Convert to DataFrames
        dfs = {name: pd.DataFrame(data) for name, data in sheets.items() if data}

        calc = KpiCalculator(dfs)
        result = calc.calculate(kpi_config)

        # NaN-safe serialization
        artifacts = []
        for a in result.get("artifacts", []):
            data = a.get("data", [])
            if isinstance(data, list):
                safe_data = []
                for row in data:
                    if isinstance(row, dict):
                        safe_data.append({k: (None if isinstance(v, float) and (v != v) else v)
                                          for k, v in row.items()})
                    else:
                        safe_data.append(row)
                artifacts.append({"type": a["type"], "label": a["label"], "data": safe_data})
            else:
                artifacts.append(a)

        return {
            "ok": True,
            "result": result.get("result", {}),
            "artifacts": artifacts,
            "log": calc.get_log(),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[kpi/calculate] Error: {e}")
        import traceback
        return {
            "ok": False,
            "error": str(e),
            "stderr": traceback.format_exc(),
            "execution_ms": int((time.time() - start) * 1000),
        }


# =====================================================================
# Variance Analysis Endpoints (deterministic)
# =====================================================================

@tool_executor_router.post("/variance/profile")
async def variance_profile(request: ToolExecutionRequest):
    """Profile data for variance analysis. No LLM call."""
    start = time.time()
    try:
        from ml.api.variance_analyzer import profile_for_variance, build_variance_prompt, suggest_variance_calculators

        sheets = request.input_data.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        profile = profile_for_variance(sheets)
        suggestions = suggest_variance_calculators(profile)
        selected = request.input_data.get("selected_analyzers")
        sys_prompt, usr_prompt = build_variance_prompt(profile, selected)

        return {
            "ok": True,
            "profile": profile,
            "suggestions": suggestions,
            "prompts": {"system": sys_prompt, "user": usr_prompt},
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[variance/profile] Error: {e}")
        return {"ok": False, "error": str(e), "execution_ms": int((time.time() - start) * 1000)}


@tool_executor_router.post("/variance/analyze")
async def variance_analyze(request: ToolExecutionRequest):
    """Execute deterministic variance analysis from LLM config. No LLM call."""
    start = time.time()
    try:
        from ml.api.variance_analyzer import VarianceAnalyzer
        import pandas as pd

        sheets = request.input_data.get("sheets", {})
        variance_config = request.input_data.get("variance_config", {})

        if not sheets:
            return {"ok": False, "error": "No sheets provided"}
        if not variance_config or not variance_config.get("analyses"):
            return {"ok": False, "error": "No variance_config or empty analyses"}

        dfs = {name: pd.DataFrame(data) for name, data in sheets.items() if data}

        analyzer = VarianceAnalyzer(dfs)
        result = analyzer.analyze(variance_config)

        # NaN-safe serialization
        artifacts = []
        for a in result.get("artifacts", []):
            data = a.get("data", [])
            if isinstance(data, list):
                safe_data = []
                for row in data:
                    if isinstance(row, dict):
                        safe_data.append({k: (None if isinstance(v, float) and (v != v) else v)
                                          for k, v in row.items()})
                    else:
                        safe_data.append(row)
                artifacts.append({"type": a["type"], "label": a["label"], "data": safe_data})
            else:
                artifacts.append(a)

        return {
            "ok": True,
            "result": result.get("result", {}),
            "artifacts": artifacts,
            "log": analyzer.get_log(),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[variance/analyze] Error: {e}")
        import traceback
        return {
            "ok": False,
            "error": str(e),
            "stderr": traceback.format_exc(),
            "execution_ms": int((time.time() - start) * 1000),
        }


# =====================================================================
# Anomaly Detection Endpoints (deterministic)
# =====================================================================

@tool_executor_router.post("/anomaly/profile")
async def anomaly_profile(request: ToolExecutionRequest):
    """Profile data for anomaly detection. No LLM call."""
    start = time.time()
    try:
        from ml.api.anomaly_engine import profile_for_anomaly, build_anomaly_prompt, suggest_anomaly_detectors

        sheets = request.input_data.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        profile = profile_for_anomaly(sheets)
        suggestions = suggest_anomaly_detectors(profile)
        selected = request.input_data.get("selected_detectors")
        sys_prompt, usr_prompt = build_anomaly_prompt(profile, selected)

        return {
            "ok": True,
            "profile": profile,
            "suggestions": suggestions,
            "prompts": {"system": sys_prompt, "user": usr_prompt},
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[anomaly/profile] Error: {e}")
        return {"ok": False, "error": str(e), "execution_ms": int((time.time() - start) * 1000)}


@tool_executor_router.post("/anomaly/detect")
async def anomaly_detect(request: ToolExecutionRequest):
    """Execute deterministic anomaly detection from LLM config. No LLM call."""
    start = time.time()
    try:
        from ml.api.anomaly_engine import AnomalyDetector, build_auto_config, profile_for_anomaly
        import pandas as pd

        sheets = request.input_data.get("sheets", {})
        anomaly_config = request.input_data.get("anomaly_config", {})
        auto_mode = request.input_data.get("auto_mode", False)

        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        # Auto mode: generate config from profile, no LLM needed
        if auto_mode or not anomaly_config or not anomaly_config.get("detections"):
            profile = profile_for_anomaly(sheets)
            anomaly_config = build_auto_config(profile)

        dfs = {name: pd.DataFrame(data) for name, data in sheets.items() if data}

        detector = AnomalyDetector(dfs)
        result = detector.detect(anomaly_config)

        artifacts = []
        for a in result.get("artifacts", []):
            data = a.get("data", [])
            if isinstance(data, list):
                safe_data = [{k: (None if isinstance(v, float) and (v != v) else v) for k, v in row.items()}
                             if isinstance(row, dict) else row for row in data]
                artifacts.append({"type": a["type"], "label": a["label"], "data": safe_data})
            else:
                artifacts.append(a)

        return {
            "ok": True,
            "result": result.get("result", {}),
            "artifacts": artifacts,
            "log": detector.get_log(),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[anomaly/detect] Error: {e}")
        import traceback
        return {
            "ok": False, "error": str(e), "stderr": traceback.format_exc(),
            "execution_ms": int((time.time() - start) * 1000),
        }


# =====================================================================
# MBR Agent Endpoints (accept flat format from builtinToolExecutor)
# =====================================================================

@tool_executor_router.post("/agent/mbr-kpi")
async def agent_mbr_kpi(request: Request):
    """
    Agent-callable KPI endpoint. Accepts flat JSON from builtinToolExecutor.
    Runs full pipeline: profile → LLM mapping → calculate.
    """
    start = time.time()
    try:
        from ml.api.kpi_calculator import execute_kpi_pipeline
        body = await request.json()
        sheets = body.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        async def call_llm(sys_p, usr_p, cfg):
            resolved = _pick_provider(LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=4000))
            return await _call_llm(usr_p, sys_p, resolved)

        import asyncio
        result = execute_kpi_pipeline(sheets, call_llm_fn=lambda s, u, c: asyncio.get_event_loop().run_until_complete(call_llm(s, u, c)))

        return {
            "ok": True,
            "result": result.get("result", {}),
            "artifacts": result.get("artifacts", []),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[agent/mbr-kpi] Error: {e}")
        return {"ok": False, "error": str(e), "execution_ms": int((time.time() - start) * 1000)}


@tool_executor_router.post("/agent/mbr-variance")
async def agent_mbr_variance(request: Request):
    """Agent-callable variance analysis endpoint."""
    start = time.time()
    try:
        from ml.api.variance_analyzer import execute_variance_pipeline
        body = await request.json()
        sheets = body.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        async def call_llm(sys_p, usr_p, cfg):
            resolved = _pick_provider(LLMConfig(provider="deepseek", model="deepseek-chat", temperature=0.1, max_tokens=4000))
            return await _call_llm(usr_p, sys_p, resolved)

        import asyncio
        result = execute_variance_pipeline(sheets, call_llm_fn=lambda s, u, c: asyncio.get_event_loop().run_until_complete(call_llm(s, u, c)))

        return {
            "ok": True,
            "result": result.get("result", {}),
            "artifacts": result.get("artifacts", []),
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[agent/mbr-variance] Error: {e}")
        return {"ok": False, "error": str(e), "execution_ms": int((time.time() - start) * 1000)}


@tool_executor_router.post("/agent/mbr-anomaly")
async def agent_mbr_anomaly(request: Request):
    """Agent-callable anomaly detection endpoint. Uses auto_mode (no LLM needed)."""
    start = time.time()
    try:
        from ml.api.anomaly_engine import AnomalyDetector, build_auto_config, profile_for_anomaly
        import pandas as pd

        body = await request.json()
        sheets = body.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        profile = profile_for_anomaly(sheets)
        config = build_auto_config(profile)

        dfs = {name: pd.DataFrame(data) for name, data in sheets.items() if data}
        detector = AnomalyDetector(dfs)
        result = detector.detect(config)

        # NaN-safe
        artifacts = []
        for a in result.get("artifacts", []):
            data = a.get("data", [])
            if isinstance(data, list):
                safe = [{k: (None if isinstance(v, float) and v != v else v) for k, v in row.items()}
                        if isinstance(row, dict) else row for row in data]
                artifacts.append({"type": a["type"], "label": a["label"], "data": safe})
            else:
                artifacts.append(a)

        return {
            "ok": True,
            "result": result.get("result", {}),
            "artifacts": artifacts,
            "summary_for_narrative": result.get("summary_for_narrative", ""),
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[agent/mbr-anomaly] Error: {e}")
        return {"ok": False, "error": str(e), "execution_ms": int((time.time() - start) * 1000)}


# ── MBR download storage (in-memory, expires with server restart) ──
_mbr_downloads = {}  # {download_id: file_path}


@tool_executor_router.get("/agent/mbr/download/{download_id}")
async def agent_mbr_download(download_id: str):
    """Download MBR Excel file by ID."""
    from starlette.responses import FileResponse
    path = _mbr_downloads.get(download_id)
    if not path or not os.path.exists(path):
        return {"ok": False, "error": "Download not found or expired"}
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=f"mbr_report_{download_id}.xlsx",
    )


# =====================================================================
# MBR ReAct Agent Endpoint
# =====================================================================

@tool_executor_router.post("/agent/mbr")
async def agent_mbr(request: Request):
    """
    MBR ReAct Agent — LLM thinks and decides which tools to call.
    Not a hardcoded pipeline. The agent sees results and decides next steps.
    """
    start = time.time()
    try:
        from ml.api.mbr_agent import run_mbr_agent
        body = await request.json()
        sheets = body.get("sheets", {})
        if not sheets:
            return {"ok": False, "error": "No sheets provided"}

        # LLM config — defaults to DeepSeek, configurable
        llm_config = body.get("llm_config", {})
        if not llm_config.get("api_key"):
            llm_config["api_key"] = os.getenv("DEEPSEEK_API_KEY")
        if not llm_config.get("base_url"):
            llm_config["base_url"] = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        if not llm_config.get("provider"):
            llm_config["provider"] = os.getenv("MBR_LLM_PROVIDER", "deepseek")
        if not llm_config.get("model"):
            llm_config["model"] = os.getenv("MBR_LLM_MODEL", "deepseek-chat")

        # Collect step events for response
        step_events = []
        async def on_step(info):
            step_events.append(info)
            logger.info(f"[agent/mbr] Step: {info}")

        result = await run_mbr_agent(sheets, llm_config, on_step=on_step)

        # NaN-safe artifacts
        safe_artifacts = []
        for a in result.get("artifacts", []):
            data = a.get("data", [])
            if isinstance(data, list):
                safe = [{k: (None if isinstance(v, float) and v != v else v) for k, v in row.items()}
                        if isinstance(row, dict) else row for row in data]
                safe_artifacts.append({"type": a.get("type", "table"), "label": a.get("label", ""), "data": safe})
            else:
                safe_artifacts.append(a)

        return {
            "ok": True,
            "narrative": result.get("narrative", ""),
            "key_tables": result.get("key_tables", []),
            "artifacts": safe_artifacts,
            "steps": result.get("steps", []),
            "plan": result.get("plan", []),
            "step_events": step_events,
            "execution_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        logger.error(f"[agent/mbr] Error: {e}")
        import traceback
        return {
            "ok": False,
            "error": str(e),
            "stderr": traceback.format_exc(),
            "execution_ms": int((time.time() - start) * 1000),
        }


@tool_executor_router.post("/agent/mbr/stream")
async def agent_mbr_stream(request: Request):
    """
    MBR ReAct Agent with SSE streaming.
    Sends real-time events as the agent thinks and calls tools.

    Event types:
      - agent_thinking: Agent is deciding what to do
      - tool_start: Tool execution started
      - tool_done: Tool execution completed with summary
      - tool_error: Tool execution failed
      - narrative: Final narrative text
      - done: All complete with full result
    """
    from starlette.responses import StreamingResponse
    from ml.api.mbr_agent import run_mbr_agent
    import asyncio

    body = await request.json()
    sheets = body.get("sheets", {})

    if not sheets:
        async def error_stream():
            yield f"data: {json.dumps({'type': 'error', 'message': 'No sheets provided'})}\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    llm_config = body.get("llm_config", {})
    if not llm_config.get("api_key"):
        llm_config["api_key"] = os.getenv("DEEPSEEK_API_KEY")
    if not llm_config.get("base_url"):
        llm_config["base_url"] = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    if not llm_config.get("provider"):
        llm_config["provider"] = os.getenv("MBR_LLM_PROVIDER", "deepseek")
    if not llm_config.get("model"):
        llm_config["model"] = os.getenv("MBR_LLM_MODEL", "deepseek-chat")

    # Queue for SSE events
    event_queue = asyncio.Queue()

    async def on_step(info):
        await event_queue.put(info)

    async def run_agent_task():
        try:
            result = await run_mbr_agent(sheets, llm_config, on_step=on_step)
            await event_queue.put({"type": "done", "result": result})
        except Exception as e:
            await event_queue.put({"type": "error", "message": str(e)})

    async def event_generator():
        task = asyncio.create_task(run_agent_task())

        while True:
            try:
                event = await asyncio.wait_for(event_queue.get(), timeout=120)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                continue

            evt_type = event.get("type", "")

            if evt_type == "done":
                # Agent finished — package final results
                result = event.get("result", {})

                # NaN-safe helper for JSON serialization
                def nan_safe(obj):
                    if isinstance(obj, float) and (obj != obj or obj == float('inf') or obj == float('-inf')):
                        return None
                    return obj

                def clean_artifacts(arts):
                    safe = []
                    for a in arts:
                        data = a.get("data", [])
                        if isinstance(data, list):
                            cleaned = [{k: nan_safe(v) for k, v in row.items()} if isinstance(row, dict) else row for row in data]
                            safe.append({**a, "data": cleaned})
                        else:
                            safe.append(a)
                    return safe

                # Send key tables (small enough for SSE)
                key_tables = clean_artifacts(result.get("key_tables", []))
                if key_tables:
                    yield f"data: {json.dumps({'type': 'key_tables', 'tables': key_tables}, default=str)}\n\n"

                # Store Excel report for download
                all_artifacts = result.get("all_artifacts", [])
                artifact_count = len(all_artifacts)
                download_id = None
                excel_report = result.get("excel_report")

                if excel_report:
                    # Use the formatted report from mbr_report_builder
                    try:
                        import uuid
                        import tempfile
                        download_id = str(uuid.uuid4())[:8]
                        path = os.path.join(tempfile.gettempdir(), f"mbr_{download_id}.xlsx")
                        with open(path, "wb") as f:
                            f.write(excel_report)
                        _mbr_downloads[download_id] = path
                        logger.info(f"[agent/mbr] Formatted report saved: {path} ({len(excel_report)} bytes)")
                    except Exception as ex:
                        logger.warning(f"[agent/mbr] Report save failed: {ex}")
                elif artifact_count > 0:
                    # Fallback: raw artifact dump
                    try:
                        import openpyxl
                        import uuid
                        import tempfile
                        wb = openpyxl.Workbook()
                        wb.remove(wb.active)
                        used_names = set()
                        for art in all_artifacts:
                            if art.get("type") != "table" or not art.get("data"):
                                continue
                            raw_name = (art.get("label") or "Sheet")
                            name = re.sub(r'[:\\/?\*\[\]]', '-', raw_name)[:31]
                            base = name
                            i = 2
                            while name in used_names:
                                name = f"{base[:28]}_{i}"
                                i += 1
                            used_names.add(name)
                            ws = wb.create_sheet(title=name)
                            rows = art["data"]
                            if rows and isinstance(rows[0], dict):
                                headers = list(rows[0].keys())
                                ws.append(headers)
                                for row in rows:
                                    ws.append([row.get(h) for h in headers])
                        download_id = str(uuid.uuid4())[:8]
                        path = os.path.join(tempfile.gettempdir(), f"mbr_{download_id}.xlsx")
                        wb.save(path)
                        _mbr_downloads[download_id] = path
                        logger.info(f"[agent/mbr] Fallback Excel saved: {path}")
                    except Exception as ex:
                        logger.warning(f"[agent/mbr] Excel generation failed: {ex}")

                yield f"data: {json.dumps({'type': 'artifacts_ready', 'count': artifact_count, 'download_id': download_id, 'execution_ms': result.get('total_duration_ms', 0)})}\n\n"
                break

            elif evt_type == "error":
                yield f"data: {json.dumps({'type': 'error', 'message': event.get('message', 'Unknown error')})}\n\n"
                break

            else:
                # All rich events pass through directly:
                # plan_start, plan_done, tool_start, tool_thinking, tool_finding,
                # tool_done, tool_error, synthesize_start, synthesize_chunk,
                # synthesize_done, agent_done
                yield f"event: agent_event\ndata: {json.dumps(event, default=str, ensure_ascii=False)}\n\n"

        if not task.done():
            task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
