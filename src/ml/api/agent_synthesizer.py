"""
agent_synthesizer.py — LLM Call #2: Synthesize [FACT] findings into narrative.

Takes the findings chain from all executed tools and asks DeepSeek
to write a structured executive summary. Single streaming LLM call, ~3000 tokens.
"""

import logging

logger = logging.getLogger(__name__)


SYNTH_SYSTEM = """You are a senior business analyst writing an executive summary.

## Rules
1. ONLY state facts that appear in the findings below — do NOT invent numbers
2. Structure your response as:
   - **Summary** (2-3 sentences — what the data shows)
   - **Key Metrics** (bullet points with actual numbers from findings)
   - **Issues Found** (anything flagged by anomaly detection or quality checks)
   - **Recommendations** (actionable next steps based on findings)
3. If multiple currencies are detected, write "mixed currency" — never label with a single currency
4. If a tool failed or had no results, say so briefly — do not guess what it would have found
5. Keep it concise — max 500 words
6. Write in English"""

SYNTH_USER = """## Analysis Findings

The following tools were executed on the uploaded data. Each section contains
the factual findings extracted from that tool's output.

{facts_text}

Write the executive summary now."""


async def synthesize(
    findings_chain: list[tuple[str, str]],
    llm_config: dict,
    on_step=None,
) -> str:
    """
    LLM Call #2: Convert tool findings into a structured narrative.

    Args:
        findings_chain: [(tool_id, fact_text), ...] from agent_loop
        llm_config: DeepSeek API config
        on_step: Async SSE callback

    Returns:
        Narrative text (executive summary)
    """
    from ml.api.agent_tool_selector import _call_llm_via_proxy

    # Build facts text
    facts_text = ""
    for tool_id, facts in findings_chain:
        if facts and facts.strip():
            facts_text += f"\n### {tool_id}\n{facts}\n"

    if not facts_text.strip():
        return "No analysis results were produced. Please check that the uploaded data is valid."

    prompt = SYNTH_USER.format(facts_text=facts_text)
    logger.info(f"[Synthesizer] Building narrative from {len(findings_chain)} tools ({len(prompt)} chars)")

    if on_step:
        await on_step({"type": "synthesize_start"})

    narrative = ""

    try:
        # Use Supabase ai-proxy (non-streaming, single call)
        narrative = await _call_llm_via_proxy(prompt, SYNTH_SYSTEM, llm_config)
        if on_step and narrative:
            await on_step({"type": "synthesize_chunk", "text": narrative})

    except Exception as e:
        logger.error(f"[Synthesizer] LLM failed: {e}")
        # Fallback: just concatenate the facts
        narrative = "## Analysis Summary (LLM synthesis failed)\n\n"
        for tool_id, facts in findings_chain:
            if facts and facts.strip():
                narrative += f"### {tool_id}\n{facts}\n\n"

    if on_step:
        word_count = len(narrative.split())
        await on_step({"type": "synthesize_done", "word_count": word_count})

    logger.info(f"[Synthesizer] Done — {len(narrative)} chars, {len(narrative.split())} words")
    return narrative
