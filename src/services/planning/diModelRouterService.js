import {
  buildBlockingQuestionPrompt,
  buildDecisionIntelligenceReportPrompt,
  buildSchemaContractMappingPrompt,
  buildSystemBrainPrompt,
  buildWorkflowAReadinessPrompt
} from '../../prompts/diJsonContracts';
import {
  buildAgentAnswerContractPrompt,
  buildAnswerContractResponseSchema,
  buildAgentCandidateJudgePrompt,
  buildAgentCandidateJudgeResponseSchema,
  buildAgentBriefSynthesisPrompt,
  buildAgentBriefSynthesisPromptV2,
  buildAgentBriefResponseSchema,
  buildAgentBriefResponseSchemaV2,
  buildAgentQaCrossReviewPrompt,
  buildAgentQaReviewResponseSchema,
  buildAgentQaRepairSynthesisPrompt,
  buildAgentQaSelfReviewPrompt,
  validateAgentBrief,
  validateAgentBriefV2,
  validateAgentBriefRepair,
  validateAgentCandidateJudge,
  validateAgentQaReview,
  validateAnswerContract,
} from '../../prompts/agentResponsePrompt';
import { buildIntentParserPrompt, validateIntentContract } from '../../prompts/intentParserPrompt';
import { extractAiJson } from '../../utils/aiMappingHelper';
import { invokeAiProxy } from '../ai-infra/aiProxyService';

const DEEPSEEK_API_KEY = import.meta.env.VITE_DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEFAULT_DI_KIMI_MODEL = import.meta.env.VITE_DI_KIMI_MODEL || 'kimi-k2.5';
const EDGE_FN_TIMEOUT_MS = 55000;

const withTimeout = (promiseOrFn, ms) => {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), ms);
  const promise = typeof promiseOrFn === 'function' ? promiseOrFn(controller.signal) : promiseOrFn;
  return Promise.race([
    promise.finally(() => clearTimeout(tid)),
    new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new Error(`Edge Function timed out after ${ms}ms`)), { once: true });
    })
  ]);
};

export const DI_PROMPT_IDS = Object.freeze({
  DATA_PROFILER: 'prompt_1_data_profiler',
  SCHEMA_MAPPING: 'prompt_2_schema_mapping',
  WORKFLOW_A_READINESS: 'prompt_3_workflow_a_readiness',
  REPORT_SUMMARY: 'prompt_4_report_summary',
  BLOCKING_QUESTIONS: 'prompt_5_blocking_questions',
  INTENT_PARSER: 'prompt_6_intent_parser',
  AGENT_ANSWER_CONTRACT: 'prompt_7_agent_answer_contract',
  AGENT_BRIEF_SYNTHESIS: 'prompt_8_agent_brief_synthesis',
  AGENT_BRIEF_REVIEW: 'prompt_9_agent_brief_review',
  AGENT_QA_SELF_REVIEW: 'prompt_10_agent_qa_self_review',
  AGENT_QA_CROSS_REVIEW: 'prompt_11_agent_qa_cross_review',
  AGENT_QA_REPAIR_SYNTHESIS: 'prompt_12_agent_qa_repair_synthesis',
  AGENT_CANDIDATE_JUDGE: 'prompt_13_agent_candidate_judge',
  AGENT_BRIEF_SYNTHESIS_V2: 'prompt_14_agent_brief_synthesis_v2',
});

const DEFAULT_DI_GEMINI_MODEL = 'gemini-3.1-pro-preview';
const DI_GEMINI_MODEL_ALIASES = Object.freeze({
  'gemini-3-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview'
});
const normalizeGeminiModelName = (model) => {
  const normalized = String(model || '').trim().replace(/^models\//i, '');
  if (!normalized) return '';
  return DI_GEMINI_MODEL_ALIASES[normalized] || normalized;
};
const isGeminiModelName = (model) => /^gemini-/i.test(String(model || '').trim());
const resolveGeminiModel = (model, fallback = DEFAULT_DI_GEMINI_MODEL) => {
  const normalized = normalizeGeminiModelName(model);
  return isGeminiModelName(normalized) ? normalized : fallback;
};
const DI_GEMINI_MODEL = resolveGeminiModel(
  import.meta.env.VITE_DI_GEMINI_MODEL || import.meta.env.VITE_GEMINI_MODEL || DEFAULT_DI_GEMINI_MODEL
);
const DI_GEMINI_MODEL_CANDIDATES = Array.from(new Set(
  [
    DI_GEMINI_MODEL,
    import.meta.env.VITE_DI_GEMINI_MODEL,
    import.meta.env.VITE_GEMINI_MODEL,
    DEFAULT_DI_GEMINI_MODEL,
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ]
    .map(normalizeGeminiModelName)
    .filter((model) => Boolean(model) && isGeminiModelName(model))
));

const DEFAULT_DI_DEEPSEEK_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';

// ── Unified LLM provider (dynamic via modelConfigService + env fallback) ─────
import { getModelConfig } from '../ai-infra/modelConfigService.js';

const JUDGE_PROMPT_IDS = new Set([
  DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW,
  DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE,
]);

function getPromptProvider(promptId) {
  const role = JUDGE_PROMPT_IDS.has(promptId) ? 'judge' : 'primary';
  return getModelConfig(role).provider;
}

function getPromptDefaultModel(promptId) {
  const role = JUDGE_PROMPT_IDS.has(promptId) ? 'judge' : 'primary';
  return getModelConfig(role).model;
}
const STRICT_JSON_PROMPTS = new Set([
  DI_PROMPT_IDS.DATA_PROFILER,
  DI_PROMPT_IDS.SCHEMA_MAPPING,
  DI_PROMPT_IDS.WORKFLOW_A_READINESS,
  DI_PROMPT_IDS.INTENT_PARSER,
  DI_PROMPT_IDS.AGENT_ANSWER_CONTRACT,
  DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS,
  DI_PROMPT_IDS.AGENT_BRIEF_REVIEW,
  DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW,
  DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW,
  DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS,
  DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE,
]);
const JSON_REPAIR_RETRY_NOTE = [
  'CRITICAL RETRY INSTRUCTIONS:',
  'The previous attempt did not match the required JSON contract.',
  'Return exactly one JSON object that matches the schema above.',
  'Include every required key. Use empty arrays instead of omitting fields.',
  'Do not add markdown, explanations, code fences, or trailing prose.',
].join('\n');

const buildPromptResponseSchema = (promptId) => {
  if (promptId === DI_PROMPT_IDS.AGENT_ANSWER_CONTRACT) {
    return buildAnswerContractResponseSchema();
  }
  if (promptId === DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS_V2) {
    return buildAgentBriefResponseSchemaV2();
  }
  if (
    promptId === DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS
    || promptId === DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS
  ) {
    return buildAgentBriefResponseSchema();
  }
  if (
    promptId === DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW
    || promptId === DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW
  ) {
    return buildAgentQaReviewResponseSchema();
  }
  if (promptId === DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE) {
    return buildAgentCandidateJudgeResponseSchema();
  }
  return null;
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasArrayField = (value, field) => Array.isArray(value?.[field]);
const hasBooleanField = (value, field) => typeof value?.[field] === 'boolean';

const validatePromptContract = (promptId, parsed) => {
  if (!isPlainObject(parsed)) return false;

  if (promptId === DI_PROMPT_IDS.DATA_PROFILER) {
    return isPlainObject(parsed.global) && hasArrayField(parsed, 'sheets');
  }

  if (promptId === DI_PROMPT_IDS.SCHEMA_MAPPING) {
    return (
      typeof parsed.upload_type === 'string'
      && hasArrayField(parsed, 'mapping')
      && hasArrayField(parsed, 'missing_required_fields')
      && hasArrayField(parsed, 'unmapped_input_columns')
      && hasArrayField(parsed, 'assumptions')
      && hasArrayField(parsed, 'minimal_questions')
    );
  }

  if (promptId === DI_PROMPT_IDS.WORKFLOW_A_READINESS) {
    return (
      hasBooleanField(parsed, 'can_run_forecast')
      && hasBooleanField(parsed, 'can_run_optimization')
      && hasArrayField(parsed, 'blocking_items')
      && hasArrayField(parsed, 'recommended_next_actions')
      && hasArrayField(parsed, 'minimal_questions')
    );
  }

  if (promptId === DI_PROMPT_IDS.INTENT_PARSER) {
    return validateIntentContract(parsed);
  }

  if (promptId === DI_PROMPT_IDS.AGENT_ANSWER_CONTRACT) {
    return validateAnswerContract(parsed);
  }

  if (promptId === DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS) {
    return validateAgentBrief(parsed);
  }

  if (promptId === DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS_V2) {
    return validateAgentBriefV2(parsed);
  }

  if (promptId === DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW || promptId === DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW) {
    return validateAgentQaReview(parsed);
  }

  if (promptId === DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS) {
    return validateAgentBriefRepair(parsed);
  }

  if (promptId === DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE) {
    return validateAgentCandidateJudge(parsed);
  }

  return true;
};

const DEEPSEEK_LOCAL_STORAGE_KEY = 'deepseek_api_key';

export const saveDeepSeekApiKey = (apiKey) => {
  if (typeof localStorage === 'undefined') return false;
  if (!apiKey || !String(apiKey).trim()) return false;
  localStorage.setItem(DEEPSEEK_LOCAL_STORAGE_KEY, String(apiKey).trim());
  return true;
};

export const clearDeepSeekApiKey = () => {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(DEEPSEEK_LOCAL_STORAGE_KEY);
};

const toPromptText = (promptId, input) => {
  if (promptId === DI_PROMPT_IDS.DATA_PROFILER) return buildSystemBrainPrompt(input);
  if (promptId === DI_PROMPT_IDS.SCHEMA_MAPPING) return buildSchemaContractMappingPrompt(input);
  if (promptId === DI_PROMPT_IDS.WORKFLOW_A_READINESS) return buildWorkflowAReadinessPrompt(input);
  if (promptId === DI_PROMPT_IDS.REPORT_SUMMARY) return buildDecisionIntelligenceReportPrompt(input);
  if (promptId === DI_PROMPT_IDS.BLOCKING_QUESTIONS) return buildBlockingQuestionPrompt(input);
  if (promptId === DI_PROMPT_IDS.INTENT_PARSER) return buildIntentParserPrompt(input);
  if (promptId === DI_PROMPT_IDS.AGENT_ANSWER_CONTRACT) return buildAgentAnswerContractPrompt(input);
  if (promptId === DI_PROMPT_IDS.AGENT_CANDIDATE_JUDGE) return buildAgentCandidateJudgePrompt(input);
  if (promptId === DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS) return buildAgentBriefSynthesisPrompt(input);
  if (promptId === DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS_V2) return buildAgentBriefSynthesisPromptV2(input);
  if (promptId === DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW) return buildAgentQaSelfReviewPrompt(input);
  if (promptId === DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW) return buildAgentQaCrossReviewPrompt(input);
  if (promptId === DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS) return buildAgentQaRepairSynthesisPrompt(input);
  throw new Error(`Unsupported DI prompt id: ${promptId}`);
};

// Centralized prompt caller registry — add new providers here.
// Lazy-initialized to avoid referencing arrow-function consts before declaration.
let _promptCallerMap = null;
const getPromptCallerMap = () => {
  if (!_promptCallerMap) {
    _promptCallerMap = {
      gemini:    callGeminiPrompt,
      openai:    callOpenAIPrompt,
      anthropic: callAnthropicPrompt,
      kimi:      callKimiPrompt,
      deepseek:  callDeepSeekPrompt,
    };
  }
  return _promptCallerMap;
};

const selectPromptCaller = (provider) => {
  const map = getPromptCallerMap();
  const caller = map[provider];
  if (!caller) {
    console.warn(`[diModelRouter] Unknown provider "${provider}", using DeepSeek caller`);
    return callDeepSeekPrompt;
  }
  return caller;
};

const buildSchemaRepairPrompt = (promptText) => `${promptText}\n\n${JSON_REPAIR_RETRY_NOTE}`;

function buildJudgeRecoveryAttempts({ provider, model, promptText }) {
  const attempts = [
    { provider, model, prompt: promptText },
    { provider, model, prompt: buildSchemaRepairPrompt(promptText) },
  ];

  if (provider === 'gemini') {
    for (const candidateModel of DI_GEMINI_MODEL_CANDIDATES) {
      if (candidateModel === model) continue;
      attempts.push({
        provider: 'gemini',
        model: candidateModel,
        prompt: buildSchemaRepairPrompt(promptText),
      });
    }
  }

  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = `${attempt.provider}:${attempt.model}:${attempt.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildStrictJsonRecoveryAttempts({ provider, model, promptText, promptId }) {
  if (JUDGE_PROMPT_IDS.has(promptId)) {
    return buildJudgeRecoveryAttempts({ provider, model, promptText });
  }

  return [
    { provider, model, prompt: promptText },
    { provider, model, prompt: buildSchemaRepairPrompt(promptText) },
  ];
}

const callGeminiPrompt = async ({
  prompt,
  model,
  temperature = 0.15,
  maxOutputTokens = 4096,
  responseSchema = null,
} = {}) => {
  // All Gemini calls go through the ai-proxy Edge Function (no client-side API key)
  const t0 = performance.now();
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'gemini',
      prompt,
      model,
      modelCandidates: DI_GEMINI_MODEL_CANDIDATES,
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      ...(responseSchema ? { responseSchema } : {}),
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty Gemini content.');
  console.info(`[diModelRouter] Gemini via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return {
    text,
    model: response?.model || model,
    transport: response?.transport || 'native',
  };
};

const callDeepSeekDirect = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  if (!DEEPSEEK_API_KEY) throw new Error('No VITE_DEEPSEEK_API_KEY configured for direct DeepSeek call.');
  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxOutputTokens
    })
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `DeepSeek direct API failed (${res.status})`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('DeepSeek direct API returned empty content.');
  return { text, model: data.model || model };
};

const callDeepSeekPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096, thinking = false, responseMimeType } = {}) => {
  // Edge Function only — NO fallback to direct API
  const t0 = performance.now();
  const resolvedModel = thinking ? 'deepseek-reasoner' : model;
  const payload = {
    provider: 'deepseek',
    prompt,
    model: resolvedModel,
    maxOutputTokens,
    ...(thinking ? { thinking: true } : { temperature }),
    ...(responseMimeType ? { responseMimeType } : {}),
  };
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', payload, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty DeepSeek content.');
  console.info(`[diModelRouter] DeepSeek via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return {
    text,
    model: response?.model || resolvedModel,
    reasoning_content: response?.reasoning_content || undefined,
  };
};

const callKimiPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096, responseMimeType } = {}) => {
  const t0 = performance.now();
  const resolvedModel = model || DEFAULT_DI_KIMI_MODEL;
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'kimi',
      prompt,
      model: resolvedModel,
      temperature,
      maxOutputTokens,
      ...(responseMimeType ? { responseMimeType } : {}),
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty Kimi content.');
  console.info(`[diModelRouter] Kimi via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || resolvedModel };
};

const callOpenAIPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096, responseMimeType } = {}) => {
  const t0 = performance.now();
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'openai',
      prompt,
      model,
      temperature,
      maxOutputTokens,
      ...(responseMimeType ? { responseMimeType } : {}),
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty OpenAI content.');
  console.info(`[diModelRouter] OpenAI via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || model };
};

const callAnthropicPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096, responseMimeType } = {}) => {
  const t0 = performance.now();
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'anthropic',
      prompt,
      model,
      temperature,
      maxOutputTokens,
      ...(responseMimeType ? { responseMimeType } : {}),
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty Anthropic content.');
  console.info(`[diModelRouter] Anthropic via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || model };
};

// ── Truncation detection ─────────────────────────────────────────────────────
// Detects if raw LLM output looks like truncated JSON (cut off mid-value/key).
// Applies to ALL providers — not just Gemini — so any future hard-truncation is
// caught automatically.
const MAX_TRUNCATION_RETRIES = 1;
const TRUNCATION_TOKEN_MULTIPLIER = 2;
const TRUNCATION_TOKEN_CAP = 16384;

function looksLikeTruncatedJson(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trimEnd();
  if (!trimmed) return false;
  // Must start with { or [ to look like intended JSON
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace === -1) return false;
  // If it ends with } or ] it's likely complete (even if malformed, not truncated)
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === '}' || lastChar === ']') return false;
  // Ends mid-string, mid-key, mid-value, or after a comma/colon — truncated
  return true;
}

export const runDiPrompt = async ({
  promptId,
  input,
  temperature = 0.15,
  maxOutputTokens = 4096,
  providerOverride = '',
  modelOverride = '',
}) => {
  const provider = String(providerOverride || getPromptProvider(promptId) || '').trim();
  if (!provider) {
    throw new Error(`No DI provider route configured for prompt: ${promptId}`);
  }

  const rawRequestedModel = String(modelOverride || getPromptDefaultModel(promptId) || getModelConfig('primary').model).trim();
  // Thinking models (e.g. gpt-5.4-thinking, deepseek-reasoner) reject response_format:json_object.
  // For strict-JSON prompts (QA review, brief synthesis, etc.) strip the thinking suffix so the
  // ai-proxy doesn't silently fall back to a weaker model like gpt-4.1-mini.
  const strictJson = STRICT_JSON_PROMPTS.has(promptId);
  // Tool-calling prompts (agent loops) should not use thinking models — they add 3-5x latency
  // per tool call and risk exceeding Edge Function timeouts.
  const isToolCallingPrompt = /^agent_(?:chat|optimizer)_loop$/i.test(promptId);
  const requestedModel = (strictJson || isToolCallingPrompt)
    ? rawRequestedModel.replace(/-thinking$/i, '')
    : rawRequestedModel;
  const model = provider === 'gemini'
    ? resolveGeminiModel(requestedModel)
    : requestedModel;
  const promptText = toPromptText(promptId, input);
  const responseSchema = strictJson ? buildPromptResponseSchema(promptId) : null;
  const recoveryAttempts = strictJson
    ? buildStrictJsonRecoveryAttempts({ provider, model, promptText, promptId })
    : [{ provider, model, prompt: promptText }];
  const errors = [];

  let effectiveMaxTokens = maxOutputTokens;
  let truncationRetries = 0;

  for (const attempt of recoveryAttempts) {
    try {
      const callPrompt = selectPromptCaller(attempt.provider);
      const result = await callPrompt({
        prompt: attempt.prompt,
        model: attempt.provider === 'gemini' ? resolveGeminiModel(attempt.model) : attempt.model,
        temperature,
        maxOutputTokens: effectiveMaxTokens,
        ...(strictJson ? { responseMimeType: 'application/json' } : {}),
        ...(attempt.provider === 'gemini' && responseSchema ? { responseSchema } : {}),
      });

      // ── Truncation auto-retry: detect hard-truncated JSON and retry with 2× tokens ──
      if (strictJson && looksLikeTruncatedJson(result.text) && truncationRetries < MAX_TRUNCATION_RETRIES) {
        const nextTokens = Math.min(effectiveMaxTokens * TRUNCATION_TOKEN_MULTIPLIER, TRUNCATION_TOKEN_CAP);
        console.warn(
          `[diModelRouter] Truncated JSON detected for ${promptId} (${attempt.provider}/${attempt.model}, ` +
          `maxOutputTokens=${effectiveMaxTokens}). Retrying with ${nextTokens} tokens.`
        );
        effectiveMaxTokens = nextTokens;
        truncationRetries += 1;
        // Re-run the SAME attempt with more tokens instead of advancing to next recovery attempt
        const retryResult = await callPrompt({
          prompt: attempt.prompt,
          model: attempt.provider === 'gemini' ? resolveGeminiModel(attempt.model) : attempt.model,
          temperature,
          maxOutputTokens: effectiveMaxTokens,
          ...(strictJson ? { responseMimeType: 'application/json' } : {}),
          ...(attempt.provider === 'gemini' && responseSchema ? { responseSchema } : {}),
        });
        // Use the retry result if it's better; otherwise fall through to normal parsing
        if (!looksLikeTruncatedJson(retryResult.text)) {
          const parsed = extractAiJson(retryResult.text, { strict: strictJson });
          if (strictJson && !validatePromptContract(promptId, parsed)) {
            const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
            console.warn(`[diModelRouter] Contract validation failed for ${promptId} after truncation retry. Keys: [${keys.join(', ')}]`);
            throw new Error(`Prompt ${promptId} returned JSON outside the required contract (after truncation retry).`);
          }
          console.info(`[diModelRouter] Truncation retry succeeded for ${promptId} (${effectiveMaxTokens} tokens).`);
          return {
            provider: attempt.provider,
            model: retryResult.model,
            transport: retryResult.transport || null,
            prompt_id: promptId,
            raw: retryResult.text,
            parsed,
          };
        }
        // Retry still truncated — fall through to normal parsing of original result
        console.warn(`[diModelRouter] Truncation retry still truncated for ${promptId}. Attempting repair.`);
      }

      const parsed = extractAiJson(result.text, { strict: strictJson });
      if (strictJson && !validatePromptContract(promptId, parsed)) {
        const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
        console.warn(`[diModelRouter] Contract validation failed for ${promptId}. Keys present: [${keys.join(', ')}]. Raw (first 300): ${String(result.text).substring(0, 300)}`);
        throw new Error(`Prompt ${promptId} returned JSON outside the required contract.`);
      }

      return {
        provider: attempt.provider,
        model: result.model,
        transport: result.transport || null,
        prompt_id: promptId,
        raw: result.text,
        parsed
      };
    } catch (error) {
      errors.push(`${attempt.provider}/${attempt.model}: ${error?.message || 'unknown error'}`);
    }
  }

  throw new Error(errors.join(' | '));
};

export default {
  DI_PROMPT_IDS,
  runDiPrompt,
  saveDeepSeekApiKey,
  clearDeepSeekApiKey
};
