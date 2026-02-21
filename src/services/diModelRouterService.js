import {
  buildBlockingQuestionPrompt,
  buildDecisionIntelligenceReportPrompt,
  buildSchemaContractMappingPrompt,
  buildSystemBrainPrompt,
  buildWorkflowAReadinessPrompt
} from '../prompts/diJsonContracts';
import { extractAiJson } from '../utils/aiMappingHelper';
import { getApiKey as getGeminiApiKey } from './geminiAPI';

export const DI_PROMPT_IDS = Object.freeze({
  DATA_PROFILER: 'prompt_1_data_profiler',
  SCHEMA_MAPPING: 'prompt_2_schema_mapping',
  WORKFLOW_A_READINESS: 'prompt_3_workflow_a_readiness',
  REPORT_SUMMARY: 'prompt_4_report_summary',
  BLOCKING_QUESTIONS: 'prompt_5_blocking_questions'
});

const PROMPT_PROVIDER = Object.freeze({
  [DI_PROMPT_IDS.DATA_PROFILER]: 'gemini',
  [DI_PROMPT_IDS.SCHEMA_MAPPING]: 'gemini',
  [DI_PROMPT_IDS.WORKFLOW_A_READINESS]: 'gemini',
  [DI_PROMPT_IDS.REPORT_SUMMARY]: 'deepseek',
  [DI_PROMPT_IDS.BLOCKING_QUESTIONS]: 'deepseek'
});

const PROMPT_DEFAULT_MODEL = Object.freeze({
  [DI_PROMPT_IDS.DATA_PROFILER]: import.meta.env.VITE_DI_GEMINI_MODEL || 'gemini-3.1-pro',
  [DI_PROMPT_IDS.SCHEMA_MAPPING]: import.meta.env.VITE_DI_GEMINI_MODEL || 'gemini-3.1-pro',
  [DI_PROMPT_IDS.WORKFLOW_A_READINESS]: import.meta.env.VITE_DI_GEMINI_MODEL || 'gemini-3.1-pro',
  [DI_PROMPT_IDS.REPORT_SUMMARY]: import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat',
  [DI_PROMPT_IDS.BLOCKING_QUESTIONS]: import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat'
});

const GEMINI_API_VERSION = import.meta.env.VITE_DI_GEMINI_API_VERSION || 'v1beta';
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_LOCAL_STORAGE_KEY = 'deepseek_api_key';

const getDeepSeekApiKey = () => {
  if (import.meta.env.VITE_DEEPSEEK_API_KEY) return import.meta.env.VITE_DEEPSEEK_API_KEY;
  if (typeof localStorage === 'undefined') return '';
  const stored = localStorage.getItem(DEEPSEEK_LOCAL_STORAGE_KEY);
  return stored || '';
};

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
  throw new Error(`Unsupported DI prompt id: ${promptId}`);
};

const callGeminiPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Gemini API key is missing for DI prompt execution.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens
        }
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody?.error?.message || `Gemini request failed (${response.status})`;
    throw new Error(message);
  }

  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('') || '';
  if (!text) {
    const finishReason = body?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Gemini returned empty content (finish_reason=${finishReason}).`);
  }
  return text;
};

const callDeepSeekPrompt = async ({ prompt, model, temperature = 0.15, maxOutputTokens = 4096 }) => {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error('DeepSeek API key is missing for DI prompt execution.');
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxOutputTokens
    })
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody?.error?.message || `DeepSeek request failed (${response.status})`;
    throw new Error(message);
  }

  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content || '';
  if (!text) {
    throw new Error('DeepSeek returned empty content.');
  }
  return text;
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

  const model = PROMPT_DEFAULT_MODEL[promptId];
  const promptText = toPromptText(promptId, input);
  const rawText = provider === 'gemini'
    ? await callGeminiPrompt({ prompt: promptText, model, temperature, maxOutputTokens })
    : await callDeepSeekPrompt({ prompt: promptText, model, temperature, maxOutputTokens });

  return {
    provider,
    model,
    prompt_id: promptId,
    raw: rawText,
    parsed: extractAiJson(rawText)
  };
};

export default {
  DI_PROMPT_IDS,
  runDiPrompt,
  saveDeepSeekApiKey,
  clearDeepSeekApiKey
};
