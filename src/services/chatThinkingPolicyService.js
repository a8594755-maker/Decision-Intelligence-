import { shouldUseAgentMode } from './chatAgentLoop.js';
import { resolveDirectAnalysisRequest } from './directAnalysisService.js';

const LIGHT_DATASET_PATTERNS = [
  /\b(what\s+(kind|kinds|types?)\s+of\s+datasets|what\s+datasets\s+do\s+you\s+have|available\s+datasets|dataset\s+overview|database\s+overview|available\s+tables|what\s+tables\s+do\s+you\s+have)\b/i,
  /\b(how\s+can\s+i\s+use\s+(it|this|the\s+data)|how\s+should\s+i\s+use\s+(it|this)|how\s+do\s+i\s+make\s+use\s+of\s+(it|this)|how\s+can\s+i\s+make\s+use\s+of\s+(it|this))\b/i,
  /(有哪些資料集|資料集.*介紹|資料庫.*概覽|資料表.*有哪些|你有什麼資料|怎麼使用這些資料|怎麼運用這些資料|這個資料庫.*理解|介紹.*資料集)/,
];

const LIGHT_HELP_PATTERNS = [
  /\b(what\s+can\s+you\s+do|help\s+me\s+understand|how\s+should\s+i\s+ask|starter\s+questions|example\s+questions|sample\s+questions|how\s+to\s+ask)\b/i,
  /(你可以做什麼|我該怎麼問|可以問哪些問題|範例問題|示範問題|怎麼開始用)/,
];

const MANUAL_THINKING_PREFIX_RE = /^\/(think|思考)(?:\s+(light|lite|full|deep|輕量|轻量|完整|深度))?(?:\s+([\s\S]*))?$/i;

function normalizeMessage(message) {
  return String(message || '').trim();
}

function looksChinese(message) {
  return /[\u4e00-\u9fff]/.test(String(message || ''));
}

function matchesAny(message, patterns) {
  return patterns.some((pattern) => pattern.test(message));
}

function buildSteps(lines) {
  return lines.map((content, index) => ({
    step: index + 1,
    type: 'preamble',
    content,
    timestamp: Date.now() + index,
  }));
}

function buildDatasetOrientationSteps(message) {
  if (looksChinese(message)) {
    return buildSteps([
      '我先盤點目前可用的資料集與各自對應的業務範圍。',
      '我再整理主要資料表、可回答的問題，以及適合的分析方向。',
      '最後我會給你幾個可以直接開始問的高價值範例。',
    ]);
  }

  return buildSteps([
    "I'll identify the datasets available in this workspace and the business domains they cover.",
    "I'll summarize the key tables, the kinds of questions each dataset supports, and the best entry points.",
    "Then I'll give you a few concrete ways to use the data right away.",
  ]);
}

function buildCapabilityOrientationSteps(message) {
  if (looksChinese(message)) {
    return buildSteps([
      '我先確認這個工作區目前支援的資料與分析能力。',
      '我再整理最適合的使用方式與常見任務類型。',
      '最後我會給你幾個可以直接複製使用的提問方式。',
    ]);
  }

  return buildSteps([
    "I'll map the capabilities available in this workspace to the kinds of tasks you can ask for.",
    "I'll keep it practical by grouping the best use cases and what outputs you can expect.",
    "Then I'll suggest a few high-value prompts you can use immediately.",
  ]);
}

function buildManualLightSteps(message) {
  if (looksChinese(message)) {
    return buildSteps([
      '我先快速拆解你的問題，確認回答方向與範圍。',
      '我再整理最重要的資訊結構，避免直接丟一段鬆散回答。',
      '最後我會給你一個簡潔但可直接延伸的答案。',
    ]);
  }

  return buildSteps([
    "I'll quickly break the question into the key angles that matter.",
    "Then I'll organize the answer so the main points are easy to scan.",
    "Finally I'll give you a concise response that you can follow up on.",
  ]);
}

function normalizeManualMode(modeToken) {
  const token = String(modeToken || '').trim().toLowerCase();
  if (!token) return 'full';
  if (['light', 'lite', '輕量', '轻量'].includes(token)) return 'light';
  if (['full', 'deep', '完整', '深度'].includes(token)) return 'full';
  return 'full';
}

export function parseManualThinkingDirective(message) {
  const normalized = normalizeMessage(message);
  const match = normalized.match(MANUAL_THINKING_PREFIX_RE);
  if (!match) {
    return {
      isDirective: false,
      mode: null,
      cleanedMessage: normalized,
      rawMessage: normalized,
    };
  }

  const [, , modeToken, remainder] = match;
  return {
    isDirective: true,
    mode: normalizeManualMode(modeToken),
    cleanedMessage: normalizeMessage(remainder),
    rawMessage: normalized,
  };
}

export function resolveChatThinkingPolicy(message, opts = {}) {
  const directive = parseManualThinkingDirective(message);
  const {
    hasRecentToolUse = false,
    hasUploadedData = false,
    manualModeOverride = null,
  } = opts;
  const effectiveDirective = manualModeOverride
    ? {
        isDirective: true,
        mode: normalizeManualMode(manualModeOverride),
        cleanedMessage: normalizeMessage(message),
        rawMessage: normalizeMessage(message),
      }
    : directive;
  const normalized = effectiveDirective.cleanedMessage;

  if (!normalized) {
    if (effectiveDirective.isDirective && effectiveDirective.mode === 'light') {
      return {
        mode: 'light',
        reason: 'manual_light_override',
        steps: buildManualLightSteps(effectiveDirective.rawMessage),
      };
    }
    if (effectiveDirective.isDirective) {
      return { mode: effectiveDirective.mode, reason: 'manual_override', steps: [] };
    }
    return { mode: 'none', reason: 'empty', steps: [] };
  }

  if (effectiveDirective.isDirective) {
    if (effectiveDirective.mode === 'light') {
      return {
        mode: 'light',
        reason: 'manual_light_override',
        steps: buildManualLightSteps(normalized),
      };
    }
    return { mode: effectiveDirective.mode, reason: 'manual_override', steps: [] };
  }

  if (hasRecentToolUse) {
    return { mode: 'full', reason: 'recent_tool_context', steps: [] };
  }

  if (resolveDirectAnalysisRequest(normalized, { hasUploadedData })) {
    return { mode: 'full', reason: 'direct_analysis', steps: [] };
  }

  if (shouldUseAgentMode(normalized)) {
    return { mode: 'full', reason: 'agent_signal', steps: [] };
  }

  if (matchesAny(normalized, LIGHT_DATASET_PATTERNS)) {
    return {
      mode: 'light',
      reason: 'dataset_orientation',
      steps: buildDatasetOrientationSteps(normalized),
    };
  }

  if (matchesAny(normalized, LIGHT_HELP_PATTERNS)) {
    return {
      mode: 'light',
      reason: 'capability_orientation',
      steps: buildCapabilityOrientationSteps(normalized),
    };
  }

  return { mode: 'none', reason: 'default', steps: [] };
}
