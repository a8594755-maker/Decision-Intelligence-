import {
  buildBlockingQuestionPrompt,
  buildDecisionIntelligenceReportPrompt,
  buildSchemaContractMappingPrompt,
  buildSystemBrainPrompt,
  buildWorkflowAReadinessPrompt
} from '../prompts/diJsonContracts';
import { buildIntentParserPrompt, validateIntentContract } from '../prompts/intentParserPrompt';
import { extractAiJson } from '../utils/aiMappingHelper';
import { invokeAiProxy } from './aiProxyService';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const DEEPSEEK_API_KEY = import.meta.env.VITE_DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const EDGE_FN_TIMEOUT_MS = 25000;

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
  INTENT_PARSER: 'prompt_6_intent_parser'
});

const DEFAULT_DI_GEMINI_MODEL = 'gemini-3.1-pro-preview';
const DI_GEMINI_MODEL_ALIASES = Object.freeze({
  'gemini-3-pro': 'gemini-3-pro-preview',
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
    'gemini-3-pro-preview'
  ]
    .map(normalizeGeminiModelName)
    .filter((model) => Boolean(model) && isGeminiModelName(model))
));

const DEFAULT_DI_DEEPSEEK_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';

// ── Unified LLM provider (configurable via env) ─────────────────────────────
const DI_UNIFIED_PROVIDER = import.meta.env.VITE_DI_CHAT_PROVIDER || 'openai';
const DI_UNIFIED_MODEL = import.meta.env.VITE_DI_CHAT_MODEL || 'gpt-5.4';

const PROMPT_PROVIDER = Object.freeze({
  [DI_PROMPT_IDS.DATA_PROFILER]: DI_UNIFIED_PROVIDER,
  [DI_PROMPT_IDS.SCHEMA_MAPPING]: DI_UNIFIED_PROVIDER,
  [DI_PROMPT_IDS.WORKFLOW_A_READINESS]: DI_UNIFIED_PROVIDER,
  [DI_PROMPT_IDS.REPORT_SUMMARY]: DI_UNIFIED_PROVIDER,
  [DI_PROMPT_IDS.BLOCKING_QUESTIONS]: DI_UNIFIED_PROVIDER,
  [DI_PROMPT_IDS.INTENT_PARSER]: DI_UNIFIED_PROVIDER,
});

const PROMPT_DEFAULT_MODEL = Object.freeze({
  [DI_PROMPT_IDS.DATA_PROFILER]: DI_UNIFIED_MODEL,
  [DI_PROMPT_IDS.SCHEMA_MAPPING]: DI_UNIFIED_MODEL,
  [DI_PROMPT_IDS.WORKFLOW_A_READINESS]: DI_UNIFIED_MODEL,
  [DI_PROMPT_IDS.REPORT_SUMMARY]: DI_UNIFIED_MODEL,
  [DI_PROMPT_IDS.BLOCKING_QUESTIONS]: DI_UNIFIED_MODEL,
  [DI_PROMPT_IDS.INTENT_PARSER]: DI_UNIFIED_MODEL,
});
const STRICT_JSON_PROMPTS = new Set([
  DI_PROMPT_IDS.DATA_PROFILER,
  DI_PROMPT_IDS.SCHEMA_MAPPING,
  DI_PROMPT_IDS.WORKFLOW_A_READINESS,
  DI_PROMPT_IDS.INTENT_PARSER
]);

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
  throw new Error(`Unsupported DI prompt id: ${promptId}`);
};

const callGeminiPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
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
      responseMimeType: 'application/json'
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty Gemini content.');
  console.info(`[diModelRouter] Gemini via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || model };
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

const callDeepSeekPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  // Edge Function only — NO fallback to direct API
  const t0 = performance.now();
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'deepseek',
      prompt,
      model,
      temperature,
      maxOutputTokens
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty DeepSeek content.');
  console.info(`[diModelRouter] DeepSeek via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || model };
};

const callOpenAIPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  const t0 = performance.now();
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'openai',
      prompt,
      model,
      temperature,
      maxOutputTokens,
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty OpenAI content.');
  console.info(`[diModelRouter] OpenAI via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || model };
};

const callAnthropicPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  const t0 = performance.now();
  const response = await withTimeout(
    (signal) => invokeAiProxy('di_prompt', {
      provider: 'anthropic',
      prompt,
      model,
      temperature,
      maxOutputTokens,
    }, { signal }),
    EDGE_FN_TIMEOUT_MS
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  if (!text) throw new Error('AI proxy returned empty Anthropic content.');
  console.info(`[diModelRouter] Anthropic via Edge Function OK in ${Math.round(performance.now() - t0)}ms`);
  return { text, model: response?.model || model };
};

export const runDiPrompt = async ({
  promptId,
  input,
  temperature = 0.15,
  maxOutputTokens = 4096
}) => {
  const provider = PROMPT_PROVIDER[promptId];
  if (!provider) {
    throw new Error(`No DI provider route configured for prompt: ${promptId}`);
  }

  const model = PROMPT_DEFAULT_MODEL[promptId] || DI_UNIFIED_MODEL;
  const promptText = toPromptText(promptId, input);

  const callPrompt = provider === 'gemini' ? callGeminiPrompt
    : provider === 'openai' ? callOpenAIPrompt
    : provider === 'anthropic' ? callAnthropicPrompt
    : callDeepSeekPrompt;

  const result = await callPrompt({
    prompt: promptText,
    model,
    temperature,
    maxOutputTokens,
  });

  const strictJson = STRICT_JSON_PROMPTS.has(promptId);
  const parsed = extractAiJson(result.text, { strict: strictJson });
  if (strictJson && !validatePromptContract(promptId, parsed)) {
    throw new Error(`Prompt ${promptId} returned JSON outside the required contract.`);
  }

  return {
    provider,
    model: result.model,
    prompt_id: promptId,
    raw: result.text,
    parsed
  };
};

export default {
  DI_PROMPT_IDS,
  runDiPrompt,
  saveDeepSeekApiKey,
  clearDeepSeekApiKey
};
