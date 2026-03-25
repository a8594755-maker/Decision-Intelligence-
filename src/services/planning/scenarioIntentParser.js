/**
 * scenarioIntentParser.js
 *
 * Text-to-Simulation: Converts natural language scenario descriptions into
 * structured override payloads that scenarioEngine.js can execute.
 *
 * Two execution paths:
 *   1. Fast local parse — regex-based extraction for common patterns (no LLM)
 *   2. LLM-assisted parse — for complex/ambiguous scenarios (calls intent parser)
 *
 * Supported scenario dimensions:
 *   • demand_multiplier       — e.g. "demand +20%", "需求增加 30%"
 *   • lead_time_delta_days    — e.g. "lead time +14 days", "延遲三週"
 *   • safety_stock_alpha      — e.g. "raise safety stock to 0.8"
 *   • budget_cap              — e.g. "budget cap $100k", "預算限制 10萬"
 *   • service_target          — e.g. "service level 98%", "服務水準 95%"
 *   • stockout_penalty_mult   — e.g. "stockout penalty 2x"
 *   • holding_cost_mult       — e.g. "holding cost 1.5x"
 *   • expedite_mode           — e.g. "enable expedite", "開啟緊急採購"
 *   • lead_time_buffer_days   — e.g. "reduce lead time by 3 days"
 *   • risk_mode               — e.g. "with risk", "risk-aware", "含風險"
 *   • chaos_intensity         — e.g. "high chaos", "extreme disruption"
 *   • simulation_scenario     — e.g. "volatile scenario", "disaster mode"
 */

import { runDiPrompt, DI_PROMPT_IDS } from './diModelRouterService';

// ── Local pattern extractors ─────────────────────────────────────────────────

const PATTERNS = [
  // Demand multiplier: "demand +20%", "需求增加 30%", "demand increases by 15%"
  {
    regex: /(?:demand|需求)[\s\w]*?(?:increase|增加|up|rise|上升|上調|grows?|boost)[\s\w]*?(?:by\s+)?(\d+(?:\.\d+)?)\s*%/i,
    extract: (m) => ({ demand_multiplier: 1 + parseFloat(m[1]) / 100 }),
  },
  {
    regex: /(?:demand|需求)[\s\w]*?(?:decrease|減少|down|drop|降低|下降|decline)[\s\w]*?(?:by\s+)?(\d+(?:\.\d+)?)\s*%/i,
    extract: (m) => ({ demand_multiplier: 1 - parseFloat(m[1]) / 100 }),
  },
  {
    regex: /(?:demand|需求)\s*(?:×|x|multiply|倍)\s*(\d+(?:\.\d+)?)/i,
    extract: (m) => ({ demand_multiplier: parseFloat(m[1]) }),
  },

  // Lead time delay: "delay 3 weeks", "延遲三週", "lead time +14 days"
  {
    regex: /(?:delay|延遲|延迟|lead\s*time)[\s\w]*?(?:\+|plus|increase|增加)?\s*(\d+)\s*(?:weeks?|週|周)/i,
    extract: (m) => ({ lead_time_delta_days: parseInt(m[1], 10) * 7 }),
  },
  {
    regex: /(?:delay|延遲|延迟|lead\s*time)[\s\w]*?(?:\+|plus|increase|增加)?\s*(\d+)\s*(?:days?|天|日)/i,
    extract: (m) => ({ lead_time_delta_days: parseInt(m[1], 10) }),
  },
  // Chinese number weeks: 三週, 兩週
  {
    regex: /(?:delay|延遲|延迟)[\s\w]*?(一|二|兩|三|四|五|六|七|八|九|十)\s*(?:週|周)/i,
    extract: (m) => ({ lead_time_delta_days: chineseToNumber(m[1]) * 7 }),
  },
  // Reduce lead time
  {
    regex: /(?:reduce|shorten|縮短)\s*(?:lead\s*time|交期)[\s\w]*?(?:by\s+)?(\d+)\s*(?:days?|天)/i,
    extract: (m) => ({
      lead_time_buffer_days: parseInt(m[1], 10),
      expedite_mode: 'on',
    }),
  },

  // Budget cap: "budget $100k", "budget cap 100000", "預算 10萬"
  {
    regex: /(?:budget|預算|预算)[\s\w]*?\$?\s*([\d,]+(?:\.\d+)?)\s*k?\b/i,
    extract: (m) => {
      let val = parseFloat(m[1].replace(/,/g, ''));
      if (/k\b/i.test(m[0])) val *= 1000;
      return { budget_cap: val };
    },
  },
  {
    regex: /(?:budget|預算|预算)[\s\w]*?([\d.]+)\s*(?:萬|万)/i,
    extract: (m) => ({ budget_cap: parseFloat(m[1]) * 10000 }),
  },

  // Service target: "service level 95%", "服務水準 98%"
  {
    regex: /(?:service\s*level|服務水準|服务水平|SL)[\s\w]*?(\d+(?:\.\d+)?)\s*%/i,
    extract: (m) => ({ service_target: parseFloat(m[1]) / 100 }),
  },

  // Safety stock alpha: "safety stock alpha 0.8", "安全庫存 alpha 0.7"
  {
    regex: /(?:safety\s*stock|安全庫存|安全库存)[\s\w]*?(?:alpha|α)?\s*(0?\.\d+)/i,
    extract: (m) => ({ safety_stock_alpha: parseFloat(m[1]) }),
  },

  // Stockout penalty: "stockout penalty 2x", "缺貨懲罰 1.5倍"
  {
    regex: /(?:stockout|缺貨|缺货)\s*(?:penalty|懲罰|惩罚)[\s\w]*?(\d+(?:\.\d+)?)\s*(?:x|×|倍)/i,
    extract: (m) => ({ stockout_penalty_multiplier: parseFloat(m[1]) }),
  },

  // Holding cost: "holding cost 1.5x"
  {
    regex: /(?:holding\s*cost|持有成本)[\s\w]*?(\d+(?:\.\d+)?)\s*(?:x|×|倍)/i,
    extract: (m) => ({ holding_cost_multiplier: parseFloat(m[1]) }),
  },

  // Expedite: "enable expedite", "開啟緊急採購"
  {
    regex: /(?:enable|turn on|開啟|启用)\s*(?:expedite|緊急採購|紧急采购|加急)/i,
    extract: () => ({ expedite_mode: 'on' }),
  },

  // Risk mode: "with risk", "risk-aware", "含風險"
  {
    regex: /(?:with\s*risk|risk[- ]aware|含風險|含风险|風險模式|风险模式)/i,
    extract: () => ({ risk_mode: 'on' }),
  },

  // Chaos intensity: "high chaos", "extreme disruption", "chaos intensity high"
  {
    regex: /(calm|low|medium|high|extreme)\s+(?:chaos|disruption|中斷|中断)/i,
    extract: (m) => ({ chaos_intensity: m[1].toLowerCase() }),
  },
  {
    regex: /(?:chaos|disruption|中斷|中断)[\s\w]*?(calm|low|medium|high|extreme)/i,
    extract: (m) => ({ chaos_intensity: m[1].toLowerCase() }),
  },

  // Simulation scenario: "volatile scenario", "disaster mode", "scenario volatile"
  {
    regex: /(normal|volatile|disaster|seasonal)\s+(?:scenario|mode|模式)/i,
    extract: (m) => ({ simulation_scenario: m[1].toLowerCase() }),
  },
  {
    regex: /(?:scenario|模式)[\s\w]*?(normal|volatile|disaster|seasonal)/i,
    extract: (m) => ({ simulation_scenario: m[1].toLowerCase() }),
  },
];

// Chinese number helper
function chineseToNumber(ch) {
  const map = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  return map[ch] || 1;
}

// ── Entity extraction (affected entities) ────────────────────────────────────

const ENTITY_PATTERNS = [
  // Supplier: "supplier A", "供應商 X"
  {
    regex: /(?:supplier|供應商|供应商|vendor)\s+([A-Za-z0-9_-]+)/gi,
    type: 'supplier',
  },
  // Material/SKU: "SKU-001", "material MAT-123"
  {
    regex: /(?:sku|material|物料|料號|料号)\s*[-:]?\s*([A-Za-z0-9_-]+)/gi,
    type: 'material',
  },
  // Plant: "plant P1", "工廠 A"
  {
    regex: /(?:plant|工廠|工厂|factory)\s*[-:]?\s*([A-Za-z0-9_-]+)/gi,
    type: 'plant',
  },
  // Port/location: "墨西哥港口", "port of X"
  {
    regex: /(?:port\s*(?:of\s+)?|港口\s*)([A-Za-z\u4e00-\u9fff]+)/gi,
    type: 'location',
  },
];

function extractAffectedEntities(text) {
  const entities = [];
  for (const { regex, type } of ENTITY_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      entities.push({ type, value: match[1] });
    }
  }
  return entities;
}

// ── Main parse function ──────────────────────────────────────────────────────

/**
 * Parse a natural language scenario description into structured overrides.
 * Uses local regex first, then optionally falls back to LLM for ambiguous cases.
 *
 * @param {string}  text           - User's natural language scenario description
 * @param {Object}  [options]
 * @param {boolean} [options.allowLlmFallback=false] - If true, calls LLM for unresolved parts
 * @param {Object}  [options.sessionContext]         - Session context for LLM prompt enrichment
 * @returns {Promise<Object>} { overrides, affected_entities, confidence, parse_method, raw_text }
 */
export async function parseScenarioFromText(text, options = {}) {
  const { allowLlmFallback = false, sessionContext } = options;

  // Step 1: Local regex extraction
  const overrides = {};
  let matchCount = 0;

  for (const { regex, extract } of PATTERNS) {
    const match = text.match(regex);
    if (match) {
      Object.assign(overrides, extract(match));
      matchCount++;
    }
  }

  // Step 2: Extract affected entities
  const affectedEntities = extractAffectedEntities(text);

  // Step 3: Determine confidence
  const hasOverrides = Object.keys(overrides).length > 0;
  let confidence = hasOverrides ? Math.min(0.6 + matchCount * 0.1, 0.95) : 0.1;
  let parseMethod = 'local_regex';

  // Step 4: LLM fallback for low confidence or complex scenarios
  if (allowLlmFallback && confidence < 0.5) {
    try {
      const llmResult = await runDiPrompt({
        promptId: DI_PROMPT_IDS.INTENT_PARSER,
        input: {
          userMessage: text,
          sessionContext,
          domainContext: {
            mode: 'scenario_parse',
            supported_overrides: [
              'demand_multiplier', 'lead_time_delta_days', 'safety_stock_alpha',
              'budget_cap', 'service_target', 'stockout_penalty_multiplier',
              'holding_cost_multiplier', 'expedite_mode', 'lead_time_buffer_days',
              'risk_mode', 'chaos_intensity', 'simulation_scenario',
            ],
          },
        },
        temperature: 0.1,
        maxOutputTokens: 512,
      });

      if (llmResult?.parsed?.entities) {
        Object.assign(overrides, llmResult.parsed.entities);
        confidence = Math.max(confidence, llmResult.parsed.confidence || 0.5);
        parseMethod = 'llm_assisted';
      }
    } catch (err) {
      console.warn('[scenarioIntentParser] LLM fallback failed:', err?.message);
      // Keep local results
    }
  }

  return {
    overrides,
    affected_entities: affectedEntities,
    confidence,
    parse_method: parseMethod,
    raw_text: text,
  };
}

/**
 * Quick check: does this text look like a scenario description?
 * Used by intent parser to decide whether to route to WHAT_IF.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeScenario(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const markers = [
    'what if', 'what-if', 'what happens', 'suppose', 'assume', 'imagine',
    'scenario', 'simulate', 'disruption', 'delay', 'shock', 'increase', 'decrease',
    '如果', '假設', '假设', '假如', '情境', '模擬', '模拟', '中斷', '中断',
    '延遲', '延迟', '增加', '減少', '减少',
  ];
  return markers.some(m => t.includes(m));
}

/**
 * Validate parsed overrides — ensure values are within sane bounds.
 *
 * @param {Object} overrides
 * @returns {{ valid: boolean, errors: string[], sanitized: Object }}
 */
export function validateScenarioOverrides(overrides) {
  const errors = [];
  const sanitized = { ...overrides };

  if (sanitized.demand_multiplier != null) {
    if (sanitized.demand_multiplier < 0 || sanitized.demand_multiplier > 10) {
      errors.push(`demand_multiplier=${sanitized.demand_multiplier} out of range [0, 10]`);
      sanitized.demand_multiplier = Math.max(0, Math.min(10, sanitized.demand_multiplier));
    }
  }
  if (sanitized.lead_time_delta_days != null) {
    if (sanitized.lead_time_delta_days < -90 || sanitized.lead_time_delta_days > 180) {
      errors.push(`lead_time_delta_days=${sanitized.lead_time_delta_days} out of range [-90, 180]`);
      sanitized.lead_time_delta_days = Math.max(-90, Math.min(180, sanitized.lead_time_delta_days));
    }
  }
  if (sanitized.service_target != null) {
    if (sanitized.service_target < 0.5 || sanitized.service_target > 1) {
      errors.push(`service_target=${sanitized.service_target} out of range [0.5, 1.0]`);
      sanitized.service_target = Math.max(0.5, Math.min(1, sanitized.service_target));
    }
  }
  if (sanitized.budget_cap != null && sanitized.budget_cap <= 0) {
    errors.push(`budget_cap=${sanitized.budget_cap} must be positive`);
    delete sanitized.budget_cap;
  }
  if (sanitized.safety_stock_alpha != null) {
    if (sanitized.safety_stock_alpha < 0 || sanitized.safety_stock_alpha > 2) {
      errors.push(`safety_stock_alpha=${sanitized.safety_stock_alpha} out of range [0, 2]`);
      sanitized.safety_stock_alpha = Math.max(0, Math.min(2, sanitized.safety_stock_alpha));
    }
  }
  if (sanitized.stockout_penalty_multiplier != null) {
    sanitized.stockout_penalty_multiplier = Math.max(0.1, Math.min(10, sanitized.stockout_penalty_multiplier));
  }
  if (sanitized.holding_cost_multiplier != null) {
    sanitized.holding_cost_multiplier = Math.max(0.1, Math.min(10, sanitized.holding_cost_multiplier));
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized,
  };
}

export default {
  parseScenarioFromText,
  looksLikeScenario,
  validateScenarioOverrides,
};
