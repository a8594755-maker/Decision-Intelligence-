/**
 * SmartOps DI - Excel Custom Functions
 *
 * Provides =CLAUDE(), =DI_KPI(), =DI_ANALYZE() formula functions.
 * All calls go through the backend proxy (never exposes API keys).
 *
 * Architecture:
 *   Excel cell → Custom Function (async) → POST /claude on backend
 *   → Backend calls Anthropic API → returns text → Excel cell
 *
 * Caching: Backend caches identical prompts for 5 min.
 * Rate limiting: Backend enforces 30 req/min.
 */

/* global CustomFunctions */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DI_API_BASE = "http://localhost:8000";

// Local dedup cache (prevents Excel recalc from re-sending identical requests)
const _localCache = new Map();
const LOCAL_CACHE_TTL = 60_000; // 1 min

function _cacheKey(fnName, args) {
  return `${fnName}:${JSON.stringify(args)}`;
}

function _getCached(key) {
  const entry = _localCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > LOCAL_CACHE_TTL) {
    _localCache.delete(key);
    return null;
  }
  return entry.value;
}

function _setCache(key, value) {
  _localCache.set(key, { ts: Date.now(), value });
  // Evict old entries if cache grows too large
  if (_localCache.size > 500) {
    const oldest = _localCache.keys().next().value;
    _localCache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function _post(path, body) {
  const resp = await fetch(`${DI_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "Unknown error");
    throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// =CLAUDE(prompt, [context])
// ---------------------------------------------------------------------------

/**
 * Ask Claude a question. Optionally provide cell data as context.
 * @customfunction CLAUDE
 * @param {string} prompt The question or instruction for Claude
 * @param {string} [context] Optional cell data to include as context
 * @returns {Promise<string>} Claude's response
 * @volatile false
 */
async function CLAUDE(prompt, context) {
  if (!prompt || prompt.trim() === "") return "";

  const key = _cacheKey("CLAUDE", [prompt, context]);
  const cached = _getCached(key);
  if (cached) return cached;

  try {
    const body = { prompt };
    if (context && context.trim()) {
      body.context = context;
    }
    const data = await _post("/claude", body);
    const result = data.text || "";
    _setCache(key, result);
    return result;
  } catch (e) {
    return `#ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// =DI_KPI(metric_name, [data_range_text])
// ---------------------------------------------------------------------------

/**
 * Calculate a specific KPI using Claude's analysis.
 * @customfunction DI_KPI
 * @param {string} metric The KPI to calculate (e.g. "revenue growth rate", "avg order value")
 * @param {string} [data] Optional data context from cells
 * @returns {Promise<string>} The calculated KPI value
 * @volatile false
 */
async function DI_KPI(metric, data) {
  if (!metric || metric.trim() === "") return "";

  const key = _cacheKey("DI_KPI", [metric, data]);
  const cached = _getCached(key);
  if (cached) return cached;

  const systemPrompt = [
    "You are a business analyst. The user asks for a specific KPI or metric.",
    "Return ONLY the numeric value or short answer. No explanation.",
    "If calculating from data, show the result. If data is insufficient, say 'N/A'.",
    "For percentages, include the % sign. For currency, include the symbol.",
  ].join(" ");

  let prompt = `Calculate this KPI: ${metric}`;
  if (data && data.trim()) {
    prompt += `\n\nData:\n${data}`;
  }

  try {
    const result = await _post("/claude", { prompt, system: systemPrompt });
    const text = (result.text || "").trim();
    _setCache(key, text);
    return text;
  } catch (e) {
    return `#ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// =DI_ANALYZE(instruction, data)
// ---------------------------------------------------------------------------

/**
 * Analyze data with Claude and return structured insights.
 * @customfunction DI_ANALYZE
 * @param {string} instruction What analysis to perform
 * @param {string} data The data to analyze (paste from cells)
 * @returns {Promise<string>} Analysis result
 * @volatile false
 */
async function DI_ANALYZE(instruction, data) {
  if (!instruction || instruction.trim() === "") return "";

  const key = _cacheKey("DI_ANALYZE", [instruction, data]);
  const cached = _getCached(key);
  if (cached) return cached;

  const systemPrompt = [
    "You are a data analyst working in Excel.",
    "Analyze the provided data according to the user's instruction.",
    "Return a concise, structured response suitable for an Excel cell.",
    "Use bullet points (•) for multiple insights. Keep each point brief.",
    "If the user asks for a table, format as tab-separated values.",
  ].join(" ");

  let prompt = instruction;
  if (data && data.trim()) {
    prompt += `\n\nData:\n${data}`;
  }

  try {
    const result = await _post("/claude", { prompt, system: systemPrompt });
    const text = (result.text || "").trim();
    _setCache(key, text);
    return text;
  } catch (e) {
    return `#ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// =DI_TRANSLATE(text, target_language)
// ---------------------------------------------------------------------------

/**
 * Translate text to another language using Claude.
 * @customfunction DI_TRANSLATE
 * @param {string} text The text to translate
 * @param {string} language Target language (e.g. "English", "Chinese", "Japanese")
 * @returns {Promise<string>} Translated text
 * @volatile false
 */
async function DI_TRANSLATE(text, language) {
  if (!text || text.trim() === "") return "";
  if (!language || language.trim() === "") return text;

  const key = _cacheKey("DI_TRANSLATE", [text, language]);
  const cached = _getCached(key);
  if (cached) return cached;

  const prompt = `Translate to ${language}. Return ONLY the translation, no explanation:\n\n${text}`;
  const systemPrompt = "You are a translator. Return only the translated text.";

  try {
    const result = await _post("/claude", { prompt, system: systemPrompt });
    const translated = (result.text || "").trim();
    _setCache(key, translated);
    return translated;
  } catch (e) {
    return `#ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// =DI_FORMULA(description)
// ---------------------------------------------------------------------------

/**
 * Generate an Excel formula from a natural language description.
 * @customfunction DI_FORMULA
 * @param {string} description What the formula should do
 * @returns {Promise<string>} The Excel formula (copy-paste into another cell)
 * @volatile false
 */
async function DI_FORMULA(description) {
  if (!description || description.trim() === "") return "";

  const key = _cacheKey("DI_FORMULA", [description]);
  const cached = _getCached(key);
  if (cached) return cached;

  const systemPrompt = [
    "You are an Excel formula expert.",
    "Given a description, return ONLY the Excel formula. No explanation.",
    "Start with = sign. Use standard Excel functions.",
    "If the description references specific cells, use those cell references.",
  ].join(" ");

  try {
    const result = await _post("/claude", { prompt: description, system: systemPrompt });
    const formula = (result.text || "").trim();
    _setCache(key, formula);
    return formula;
  } catch (e) {
    return `#ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Register functions (for custom functions runtime)
// ---------------------------------------------------------------------------

if (typeof CustomFunctions !== "undefined") {
  CustomFunctions.associate("CLAUDE", CLAUDE);
  CustomFunctions.associate("DI_KPI", DI_KPI);
  CustomFunctions.associate("DI_ANALYZE", DI_ANALYZE);
  CustomFunctions.associate("DI_TRANSLATE", DI_TRANSLATE);
  CustomFunctions.associate("DI_FORMULA", DI_FORMULA);
}
