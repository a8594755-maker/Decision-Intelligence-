"""
agent_router.py — Deterministic query router. 0 LLM calls.

Routes user queries to fixed pipelines or general agent.
Commands like /mbr go to existing pipelines; free text goes to general agent.
"""

import re


FIXED_PIPELINES = [
    (re.compile(r"^/mbr\b", re.IGNORECASE), "mbr_pipeline"),
    (re.compile(r"^/forecast\b", re.IGNORECASE), "forecast_pipeline"),
    (re.compile(r"^/plan\b", re.IGNORECASE), "plan_pipeline"),
    (re.compile(r"^/backtest\b", re.IGNORECASE), "backtest_pipeline"),
]


def route_query(query: str) -> str:
    """
    Determine which execution path to use.

    Returns:
        "mbr_pipeline" | "forecast_pipeline" | "plan_pipeline" |
        "backtest_pipeline" | "general_agent"
    """
    query = query.strip()
    for pattern, pipeline in FIXED_PIPELINES:
        if pattern.match(query):
            return pipeline
    return "general_agent"
