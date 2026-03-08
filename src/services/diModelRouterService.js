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

const PROMPT_PROVIDER = Object.freeze({
  [DI_PROMPT_IDS.DATA_PROFILER]: 'gemini',
  [DI_PROMPT_IDS.SCHEMA_MAPPING]: 'gemini',
  [DI_PROMPT_IDS.WORKFLOW_A_READINESS]: 'gemini',
  [DI_PROMPT_IDS.REPORT_SUMMARY]: 'deepseek',
  [DI_PROMPT_IDS.BLOCKING_QUESTIONS]: 'deepseek',
  [DI_PROMPT_IDS.INTENT_PARSER]: 'deepseek'
});

const PROMPT_DEFAULT_MODEL = Object.freeze({
  [DI_PROMPT_IDS.DATA_PROFILER]: DI_GEMINI_MODEL,
  [DI_PROMPT_IDS.SCHEMA_MAPPING]: DI_GEMINI_MODEL,
  [DI_PROMPT_IDS.WORKFLOW_A_READINESS]: DI_GEMINI_MODEL,
  [DI_PROMPT_IDS.REPORT_SUMMARY]: DEFAULT_DI_DEEPSEEK_MODEL,
  [DI_PROMPT_IDS.BLOCKING_QUESTIONS]: DEFAULT_DI_DEEPSEEK_MODEL,
  [DI_PROMPT_IDS.INTENT_PARSER]: DEFAULT_DI_DEEPSEEK_MODEL
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

const callGeminiDirect = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  if (!GEMINI_API_KEY) throw new Error('No VITE_GEMINI_API_KEY configured for direct Gemini call.');
  const candidates = DI_GEMINI_MODEL_CANDIDATES.length > 0 ? DI_GEMINI_MODEL_CANDIDATES : [model];
  let lastError = null;
  for (const m of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) return { text, model: m };
      throw new Error('Gemini direct API returned empty content.');
    }
    const errData = await res.json().catch(() => ({}));
    const errMsg = errData?.error?.message || `Gemini ${res.status}`;
    if (res.status === 404 || /not found|unsupported/i.test(errMsg)) {
      lastError = new Error(errMsg);
      continue;
    }
    throw new Error(errMsg);
  }
  throw lastError || new Error('All Gemini model candidates failed.');
};

const callGeminiPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  // Try Edge Function with timeout, fall back to direct API
  const t0 = performance.now();
  if (GEMINI_API_KEY) {
    try {
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
    } catch (proxyError) {
      console.warn(`[diModelRouter] Gemini Edge Function failed after ${Math.round(performance.now() - t0)}ms, trying direct API:`, proxyError.message);
      return callGeminiDirect({ prompt, model, temperature, maxOutputTokens });
    }
  }
  return callGeminiDirect({ prompt, model, temperature, maxOutputTokens });
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
  // Try Edge Function with timeout, fall back to direct API
  const t0 = performance.now();
  if (DEEPSEEK_API_KEY) {
    try {
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
    } catch (proxyError) {
      console.warn(`[diModelRouter] DeepSeek Edge Function failed after ${Math.round(performance.now() - t0)}ms, trying direct API:`, proxyError.message);
      return callDeepSeekDirect({ prompt, model, temperature, maxOutputTokens });
    }
  }
  return callDeepSeekDirect({ prompt, model, temperature, maxOutputTokens });
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

  const model = PROMPT_DEFAULT_MODEL[promptId] || (provider === 'gemini' ? DI_GEMINI_MODEL : DEFAULT_DI_DEEPSEEK_MODEL);
  const promptText = toPromptText(promptId, input);

  const result = provider === 'gemini'
    ? await callGeminiPrompt({
        prompt: promptText,
        model,
        temperature,
        maxOutputTokens
      })
    : await callDeepSeekPrompt({
        prompt: promptText,
        model,
        temperature,
        maxOutputTokens
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
