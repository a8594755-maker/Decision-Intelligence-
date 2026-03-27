/**
 * queryIntentClassifier.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic query intent classifier.
 *
 * Classifies user messages into three tiers that gate downstream pipeline
 * complexity (evidence-first enforcement, QA review depth, dual-agent triggers).
 *
 * Tiers:
 *   meta    — capability questions, greetings, help requests → no evidence, no QA
 *   simple  — single-dimension lookups, follow-ups → evidence + lightweight QA
 *   complex — multi-dimension analysis, comparisons → full pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Meta patterns: capability questions, greetings, help requests ───────────

const META_PATTERNS_EN = [
  /\b(what can you|what do you|how do I|how can I|tell me about yourself|what tools|what are your|capabilities|can you help|help me understand)\b/i,
  /\b(hello|hi|hey|good morning|good afternoon|good evening)\b/i,
  /\b(who are you|what are you|introduce yourself|explain your)\b/i,
  /\b(how does this work|what is this|tutorial|getting started|guide me)\b/i,
];

const META_PATTERNS_ZH = [
  /(你能做什麼|你可以做什麼|你有什麼功能|你會什麼|怎麼用|如何使用|教我|幫我了解|使用教學|介紹一下)/,
  /(你好|哈囉|嗨|早安|午安|晚安)/,
  /(你是誰|你是什麼|自我介紹)/,
  /(這是什麼|怎麼操作|入門|指南)/,
];

const META_PATTERNS = [...META_PATTERNS_EN, ...META_PATTERNS_ZH];

// ── Follow-up patterns: references to prior results ─────────────────────────

const FOLLOW_UP_PATTERNS = [
  /\b(the same|above|previous|earlier|that (chart|table|result|data|analysis)|those results|last (one|query|analysis)|this data|just (show|told|said))\b/i,
  /(上面的|剛才的|之前的|那個(圖|表|結果|數據|分析)|同樣的|上一個|這份(數據|資料))/,
];

// ── Complex signal patterns: multi-dimension, deep analysis ─────────────────

const COMPLEX_PATTERNS = [
  /\b(compare|comparison|versus|vs\.?|diagnos[et]|diagnostic|recommend|recommendation|correlat|regression|what.?if|scenario|sensitivity|trade.?off)\b/i,
  /\b(segmentation|cluster|anomaly|outlier|root cause|drill.?down|deep dive|comprehensive|detailed analysis)\b/i,
  /(比較|對比|診斷|建議|推薦|相關性|迴歸|假設|情境|敏感度|權衡|分群|異常|根因|深入|全面分析|詳細分析)/,
];

// ── Multi-dimension indicators ──────────────────────────────────────────────

const MULTI_DIM_CONJUNCTIONS = [
  /\b(and|also|plus|as well as|along with|together with|broken down by|split by|grouped by|across|per)\b/i,
  /(以及|同時|還有|並且|按照|分別|依|各)/,
];

/**
 * Classify a user message into a query complexity tier.
 *
 * @param {string} message        — the user's message
 * @param {Array}  [history=[]]   — recent conversation history (last N turns)
 * @returns {{ tier: 'meta'|'simple'|'complex', reason: string }}
 */
export function classifyQueryIntent(message, history = []) {
  const text = String(message || '').trim();

  if (!text) {
    return { tier: 'meta', reason: 'empty_message' };
  }

  // ── 1. Check for meta intent ──────────────────────────────────────────────
  const isShort = text.length < 80;
  const matchesMeta = META_PATTERNS.some((p) => p.test(text));

  // Meta only if the message is short AND matches meta patterns AND doesn't
  // also contain analytical keywords (e.g. "can you analyze revenue" is NOT meta).
  if (matchesMeta && isShort && !hasAnalyticalContent(text)) {
    return { tier: 'meta', reason: 'capability_or_greeting' };
  }

  // Pure greeting (very short, no analytical content)
  if (isShort && text.split(/\s+/).length <= 5 && !hasAnalyticalContent(text)) {
    const looksLikeGreeting = /^(hi|hello|hey|你好|哈囉|嗨|早安|午安|晚安|thanks|thank you|謝謝|ok|okay|好的|got it|了解)\b/i.test(text);
    if (looksLikeGreeting) {
      return { tier: 'meta', reason: 'greeting' };
    }
  }

  // ── 2. Check for complex intent ───────────────────────────────────────────
  const matchesComplex = COMPLEX_PATTERNS.some((p) => p.test(text));
  const matchesMultiDim = MULTI_DIM_CONJUNCTIONS.some((p) => p.test(text));
  const isLong = text.length > 200;

  // Explicit complex patterns always trigger complex tier
  if (matchesComplex) {
    return { tier: 'complex', reason: 'complex_analysis_pattern' };
  }

  // Long message with multi-dimension conjunctions → complex
  if (isLong && matchesMultiDim) {
    return { tier: 'complex', reason: 'long_multi_dimension' };
  }

  // ── 3. Default: simple ────────────────────────────────────────────────────
  // Check if this is a follow-up to prior results
  const isFollowUp = FOLLOW_UP_PATTERNS.some((p) => p.test(text));
  if (isFollowUp && history.length > 0) {
    return { tier: 'simple', reason: 'follow_up' };
  }

  return { tier: 'simple', reason: 'default_single_dimension' };
}

/**
 * Check if text contains analytical/data keywords that disqualify it from meta tier.
 */
function hasAnalyticalContent(text) {
  return /\b(revenue|orders?|delivery|trend|chart|data|sql|forecast|plan|analy[sz]|segment|distribution|query|calculate|分析|數據|資料|圖表|營收|訂單|趨勢|預測|計畫|查詢|計算)\b/i.test(text);
}

// ── Analytical request patterns: follow-ups & exploratory questions ──────────

const ANALYTICAL_REQUEST_PATTERNS = [
  /\b(tell me more|more about|dig deeper|investigate|elaborate|explain further|walk me through|unpack|explore)\b/i,
  /\b(what patterns|what trends|what drives|what caused|why is|why are|why did|what should we)\b/i,
  /\b(further|deeper|more detail|in.depth|additional insight|break.?down)\b/i,
  /(詳細說明|深入分析|進一步|為什麼|什麼原因|什麼趨勢|更多細節|繼續分析|展開說明|有什麼規律|有什麼模式)/,
];

/**
 * Returns true when a message is an analytical/exploratory request that
 * deserves the full agent loop (with Python tools) rather than bare SQL.
 */
export function isAnalyticalRequest(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  const { tier } = classifyQueryIntent(text);
  if (tier === 'complex') return true;
  return ANALYTICAL_REQUEST_PATTERNS.some((p) => p.test(text));
}

export default { classifyQueryIntent, isAnalyticalRequest };
