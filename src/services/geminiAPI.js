/**
 * AI API Service
 * - General analysis calls are routed to DeepSeek V3.2 via Edge Function
 * - Conversational chat uses DeepSeek V3.2
 */

import { buildDataProfilerPrompt } from '../prompts/dataProfilerPrompt';
import { invokeAiProxy, streamTextToChunks } from './aiProxyService';

const USE_EDGE_AI_PROXY = true;

// Using environment variable for API key (falls back to empty string)
const DEFAULT_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
const DEFAULT_GEMINI_MODEL = 'gemini-3-pro-preview';
const GEMINI_MODEL_ALIASES = Object.freeze({
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview'
});
const normalizeGeminiModelName = (model) => {
  const normalized = String(model || '').trim().replace(/^models\//i, '');
  if (!normalized) return '';
  return GEMINI_MODEL_ALIASES[normalized] || normalized;
};
const isGeminiModelName = (model) => /^gemini-/i.test(String(model || '').trim());
const resolveGeminiModel = (model, fallback = DEFAULT_GEMINI_MODEL) => {
  const normalized = normalizeGeminiModelName(model);
  return isGeminiModelName(normalized) ? normalized : fallback;
};
const GEMINI_MODEL = resolveGeminiModel(
  import.meta.env.VITE_GEMINI_MODEL || import.meta.env.VITE_DI_GEMINI_MODEL || DEFAULT_GEMINI_MODEL
);
const GEMINI_MODEL_CANDIDATES = Array.from(new Set(
  [
    GEMINI_MODEL,
    import.meta.env.VITE_DI_GEMINI_MODEL,
    import.meta.env.VITE_GEMINI_MODEL,
    DEFAULT_GEMINI_MODEL,
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview'
  ]
    .map(normalizeGeminiModelName)
    .filter((model) => Boolean(model) && isGeminiModelName(model))
));
const API_VERSION = "v1beta"; // Use v1beta for experimental models
const DEEPSEEK_LOCAL_STORAGE_KEY = 'deepseek_api_key';
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEFAULT_DEEPSEEK_CHAT_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_CHAT_MODEL_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_DEEPSEEK_CHAT_MODEL,
    import.meta.env.VITE_DI_DEEPSEEK_MODEL,
    'deepseek-v3.2-exp',
    'deepseek-chat'
  ]
    .map((model) => String(model || '').trim())
    .filter(Boolean)
));

const isModelLookupError = (status, message = '') => {
  if (status === 404) return true;
  return /(model|models).*(not found|unsupported|unknown|invalid|not supported)/i.test(message);
};

const buildGeminiApiUrl = ({ model, action, apiKey, query = '' }) => {
  const base = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${model}:${action}`;
  if (query) {
    return `${base}?${query}&key=${encodeURIComponent(apiKey)}`;
  }
  return `${base}?key=${encodeURIComponent(apiKey)}`;
};

const postGeminiWithModelFallback = async ({
  apiKey,
  action,
  requestBody,
  query = ''
}) => {
  let retryableFailure = null;

  for (const model of GEMINI_MODEL_CANDIDATES) {
    const apiUrl = buildGeminiApiUrl({ model, action, apiKey, query });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (response.ok) {
      return { ok: true, response, model, apiUrl };
    }

    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData?.error?.message || 'Unknown error';
    const failure = {
      ok: false,
      response,
      status: response.status,
      model,
      apiUrl,
      errorData,
      errorMessage
    };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }

    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false,
    response: null,
    status: 0,
    model: GEMINI_MODEL,
    apiUrl: '',
    errorData: {},
    errorMessage: 'No Gemini model candidates are available for this request.'
  };
};

/**
 * Get API Key from environment variable, localStorage, or default value
 * Priority: environment variable > localStorage > default value
 */
export const getApiKey = () => {
  if (USE_EDGE_AI_PROXY) return '';
  // Prefer environment variable (if exists)
  if (import.meta.env.VITE_GEMINI_API_KEY) {
    return import.meta.env.VITE_GEMINI_API_KEY;
  }
  // Then use localStorage
  if (typeof localStorage === 'undefined') return DEFAULT_API_KEY;
  const storedKey = localStorage.getItem('gemini_api_key');
  if (storedKey) {
    return storedKey;
  }
  // Finally use default value
  return DEFAULT_API_KEY;
};

/**
 * Save API Key to localStorage
 */
export const saveApiKey = (apiKey) => {
  if (USE_EDGE_AI_PROXY) return false;
  if (typeof localStorage === 'undefined') return false;
  if (apiKey && apiKey.trim()) {
    localStorage.setItem('gemini_api_key', apiKey.trim());
    return true;
  }
  return false;
};

/**
 * Clear API Key
 */
export const clearApiKey = () => {
  if (USE_EDGE_AI_PROXY) return;
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem('gemini_api_key');
};

export const getDeepSeekApiKey = () => {
  if (USE_EDGE_AI_PROXY) return '';
  if (import.meta.env.VITE_DEEPSEEK_API_KEY) {
    return import.meta.env.VITE_DEEPSEEK_API_KEY;
  }
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(DEEPSEEK_LOCAL_STORAGE_KEY) || '';
};

export const saveDeepSeekApiKey = (apiKey) => {
  if (USE_EDGE_AI_PROXY) return false;
  if (typeof localStorage === 'undefined') return false;
  if (!apiKey || !String(apiKey).trim()) return false;
  localStorage.setItem(DEEPSEEK_LOCAL_STORAGE_KEY, String(apiKey).trim());
  return true;
};

export const clearDeepSeekApiKey = () => {
  if (USE_EDGE_AI_PROXY) return;
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(DEEPSEEK_LOCAL_STORAGE_KEY);
};

const normalizeChatRole = (role) => {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'ai') return 'assistant';
  return 'user';
};

const buildHistoryLines = (conversationHistory = [], limit = 10) => {
  return conversationHistory
    .slice(-limit)
    .map((msg) => {
      const content = typeof msg?.content === 'string' ? msg.content.trim() : '';
      if (!content) return null;
      const speaker = normalizeChatRole(msg.role) === 'assistant' ? 'Assistant' : 'User';
      return `${speaker}: ${content}`;
    })
    .filter(Boolean)
    .join('\n');
};

const buildChatSystemContext = ({ systemPrompt = '', conversationHistory = [], historyLimit = 10 }) => {
  let fullContext = String(systemPrompt || '');
  const historyText = buildHistoryLines(conversationHistory, historyLimit);
  if (historyText) {
    fullContext += `${fullContext ? '\n\n' : ''}Conversation History:\n${historyText}`;
  }
  return fullContext;
};

const buildDeepSeekMessages = ({ message, conversationHistory = [], systemPrompt = '' }) => {
  const messages = [];
  const normalizedSystemPrompt = String(systemPrompt || '').trim();
  if (normalizedSystemPrompt) {
    messages.push({ role: 'system', content: normalizedSystemPrompt });
  }

  const cleanMessage = String(message || '').trim();
  const historyWindow = conversationHistory.slice(-10);
  const dedupedHistory = historyWindow.length > 0
    ? historyWindow.slice(0, -1).concat(
        (() => {
          const last = historyWindow[historyWindow.length - 1];
          const lastRole = normalizeChatRole(last?.role);
          const lastContent = typeof last?.content === 'string' ? last.content.trim() : '';
          if (lastRole === 'user' && lastContent === cleanMessage) {
            return [];
          }
          return [last];
        })()
      )
    : [];

  dedupedHistory.forEach((entry) => {
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (!content) return;
    messages.push({
      role: normalizeChatRole(entry.role),
      content
    });
  });

  messages.push({ role: 'user', content: cleanMessage });
  return messages;
};

const postDeepSeekWithModelFallback = async ({
  apiKey,
  requestBody
}) => {
  const modelCandidates = Array.from(new Set(
    [requestBody?.model, ...DEEPSEEK_CHAT_MODEL_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));

  let retryableFailure = null;

  for (const model of modelCandidates) {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        ...requestBody,
        model
      })
    });

    if (response.ok) {
      return { ok: true, response, model };
    }

    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData?.error?.message || 'Unknown error';
    const failure = {
      ok: false,
      response,
      status: response.status,
      model,
      errorData,
      errorMessage
    };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }

    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false,
    response: null,
    status: 0,
    model: requestBody?.model || DEFAULT_DEEPSEEK_CHAT_MODEL,
    errorData: {},
    errorMessage: 'No DeepSeek model candidates are available for this request.'
  };
};

/**
 * Call Gemini API
 * @param {string} prompt - User prompt
 * @param {string} systemContext - System context (optional)
 * @param {object} options - Configuration options
 * @returns {Promise<string>} AI response
 */
export const callGeminiAPI = async (prompt, systemContext = "", options = {}) => {
  if (USE_EDGE_AI_PROXY) {
    try {
      const fullPrompt = systemContext
        ? `${systemContext}\n\nUser Query: ${prompt}`
        : prompt;
      const result = await invokeAiProxy('di_prompt', {
        provider: 'deepseek',
        prompt: fullPrompt,
        model: options.model || DEFAULT_DEEPSEEK_CHAT_MODEL,
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxOutputTokens || 8192
      });
      const text = typeof result?.text === 'string' ? result.text : '';
      if (!text) {
        return 'No response generated.\n\nPlease check AI proxy logs in Supabase Edge Functions.';
      }
      return text;
    } catch (error) {
      const message = String(error?.message || 'Unknown AI proxy error');
      if (/not configured on server|missing_server_keys|api key/i.test(message)) {
        return '⚠️ AI service is not configured on server.\n\nAsk your admin to set Supabase Edge Function secret: DEEPSEEK_API_KEY.';
      }
      return `❌ AI service request failed\n\nError message: ${message}\n\nPlease check Edge Function logs and retry.`;
    }
  }

  const apiKey = getApiKey();

  if (!apiKey) {
    console.warn("No API Key found.");
    return "WARNING: No API key found. Add your Google AI API key in Settings.\n\nYou can grab a free key here: https://ai.google.dev/";
  }

  try {
    const fullPrompt = systemContext
      ? `${systemContext}\n\nUser Query: ${prompt}`
      : prompt;

    const requestBody = {
      contents: [{
        parts: [{ text: fullPrompt }]
      }],
      generationConfig: {
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxOutputTokens || 8192,  // Increased default for longer responses
      }
    };

    const request = await postGeminiWithModelFallback({
      apiKey,
      action: 'generateContent',
      requestBody
    });

    if (!request.ok) {
      const errorData = request.errorData || {};
      console.error("API Error Details:", errorData);

      // Handle quota errors explicitly
      if (request.status === 429) {
        return "⚠️ API quota exhausted\n\nPlease try:\n1. Wait for daily reset\n2. Replace with a new API key in Settings\n3. Upgrade to a paid plan\n\nGet a new free key: https://ai.google.dev/";
      }

      // Handle service unavailable (503) - model overloaded
      if (request.status === 503) {
        return "⚠️ AI service temporarily unavailable\n\nModel is currently overloaded, please try again later.\n\nSuggestions:\n1. Wait 30 seconds and retry\n2. Check network connection\n3. If the issue persists, try again later";
      }

      // Handle other errors
      const errorMessage = errorData.error?.message || 'Unknown error';
      return `❌ AI service error (${request.status || 'unknown'})\n\n${errorMessage}\n\nPlease check:\n1. Is the API key correct\n2. Is the network connection working\n3. Try again later`;
    }

    if (request.model !== GEMINI_MODEL) {
      console.warn(`Model "${GEMINI_MODEL}" is unavailable. Falling back to "${request.model}".`);
    }
    console.log(`Using API URL: ${request.apiUrl}`);

    const data = await request.response.json();
    console.log("=== Gemini API Full Response ===");
    console.log(JSON.stringify(data, null, 2));
    
    // Check for errors in response
    if (data.error) {
      console.error("API returned error:", data.error);
      return `ERROR: ${data.error.message || 'Unknown API error'}`;
    }
    
    // Check for safety filters or blocked content
    if (data.candidates?.[0]?.finishReason === "SAFETY") {
      console.warn("Content blocked by safety filters:", data.candidates[0].safetyRatings);
      return "WARNING: Content blocked by AI safety filters.\n\nThe AI detected potentially sensitive content in the request or response. Try:\n1. Simplify your data\n2. Remove any sensitive information\n3. Try again with different parameters";
    }
    
    // Check finish reason
    const finishReason = data.candidates?.[0]?.finishReason;
    console.log("Finish reason:", finishReason);
    
    // Handle MAX_TOKENS finish reason - response might still have partial text
    if (finishReason === "MAX_TOKENS") {
      const partialText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (partialText) {
        console.warn("Response was truncated due to MAX_TOKENS, but partial text is available");
        return partialText + "\n\n[Response truncated due to length limit]";
      }
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      console.warn("No text in response. Candidates:", data.candidates);
      return `No response generated.\n\nFinish reason: ${finishReason || 'unknown'}\n\nThis might be due to:\n1. Content safety filters\n2. Model not supporting this request\n3. Invalid model name (configured: ${GEMINI_MODEL}, tried: ${request.model})\n\nPlease check the console for full details.`;
    }
    
    return text;
  } catch (error) {
    console.error("Gemini API Failed:", error);
    
    // Handle network errors
    if (error.message.includes('fetch') || error.message.includes('network')) {
      return "❌ Network connection error\n\nUnable to connect to AI service.\n\nPlease check:\n1. Is the network connection working\n2. Is the firewall blocking requests\n3. Try again later";
    }
    
    // Handle timeout errors
    if (error.message.includes('timeout') || error.name === 'AbortError') {
      return "⏱️ Request timeout\n\nAI service response took too long.\n\nPlease try:\n1. Try again later\n2. Simplify your question\n3. Check network connection";
    }
    
    return `❌ AI service request failed\n\nError message: ${error.message}\n\nPlease check:\n1. Is the API key configured correctly\n2. Is the network connection working\n3. Is the firewall blocking requests\n4. Try again later`;
  }
};

/**
 * AI call specifically for data analysis
 */
export const analyzeData = async (data, analysisType = "general") => {
  const sample = Array.isArray(data) ? data.slice(0, 30) : data;

  let prompt = "";

  switch (analysisType) {
    case "profile":
      prompt = buildDataProfilerPrompt(sample);
      break;

    case "quality":
      prompt = `Analyze data quality of the following dataset. Identify missing values, inconsistencies, and potential errors. Provide recommendations: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    case "insights":
      prompt = `Analyze this dataset and provide key business insights, trends, and actionable recommendations: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    default:
      prompt = `Analyze this data and provide a summary: ${JSON.stringify(sample).slice(0, 12000)}`;
  }

  return await callGeminiAPI(prompt);
};

/**
 * AI call for conversational chat
 */
export const chatWithAI = async (message, conversationHistory = [], dataContext = null) => {
  let baseSystemContext = "";

  if (dataContext && Array.isArray(dataContext)) {
    baseSystemContext = `USER DATA CONTEXT: ${JSON.stringify(dataContext.slice(0, 5))}`;
  }

  if (USE_EDGE_AI_PROXY) {
    try {
      const result = await invokeAiProxy('deepseek_chat', {
        message,
        conversationHistory,
        systemPrompt: baseSystemContext,
        temperature: 0.7,
        maxOutputTokens: 8192,
        model: 'deepseek-chat'
      });
      const text = typeof result?.text === 'string' ? result.text : '';
      if (text) return text;
      throw new Error('AI proxy returned empty content.');
    } catch (error) {
      console.warn('[chatWithAI] DeepSeek chat failed:', error.message);
      return `❌ DeepSeek 對話服務請求失敗\n\nError: ${error.message}`;
    }
  }

  // Legacy local path: DeepSeek only (no Gemini fallback).
  const deepSeekApiKey = getDeepSeekApiKey();
  if (deepSeekApiKey) {
    try {
      const request = await postDeepSeekWithModelFallback({
        apiKey: deepSeekApiKey,
        requestBody: {
          model: DEFAULT_DEEPSEEK_CHAT_MODEL,
          messages: buildDeepSeekMessages({
            message,
            conversationHistory,
            systemPrompt: baseSystemContext
          }),
          temperature: 0.7,
          max_tokens: 8192
        }
      });

      if (!request.ok) {
        const errorMessage = request.errorData?.error?.message || request.errorMessage || `DeepSeek request failed (${request.status || 'unknown'})`;
        throw new Error(errorMessage);
      }

      const body = await request.response.json();
      const content = body?.choices?.[0]?.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => part?.text || '').join('')
          : '';
      if (text) return text;
      throw new Error('DeepSeek returned empty content.');
    } catch (error) {
      console.warn('[chatWithAI] DeepSeek failed:', error.message);
      return `❌ DeepSeek 對話服務請求失敗\n\nError: ${error.message}`;
    }
  }

  return '❌ 未設定 DeepSeek API Key，無法進行對話。\n\n請在設定中加入 DeepSeek API Key。';
};

/**
 * Generate report summary
 */
export const generateReportSummary = async (reportType, data) => {
  const prompt = `Generate a comprehensive ${reportType} report summary based on the following data. Provide insights, trends, and recommendations: ${JSON.stringify(data).slice(0, 10000)}`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 3000
  });
};

/**
 * Extract JSON from AI response
 */
export const extractJsonFromResponse = (text) => {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
};

/**
 * Analyze cost anomaly
 * @param {object} anomaly - Anomaly data
 * @param {object} historicalData - Historical data (optional)
 * @returns {Promise<string>} AI analysis result
 */
export const analyzeCostAnomaly = async (anomaly, historicalData = null) => {
  let prompt = `You are a cost analysis expert. Please analyze the following cost anomaly and provide detailed analysis and recommendations.

Anomaly Type: ${anomaly.anomaly_type}
Anomaly Date: ${anomaly.anomaly_date}
Detected Value: ${anomaly.detected_value}
Expected Value: ${anomaly.expected_value}
Deviation: ${anomaly.deviation_percent}%
Description: ${anomaly.description || 'None'}`;

  if (historicalData) {
    prompt += `\n\nHistorical data reference:\n${JSON.stringify(historicalData).slice(0, 3000)}`;
  }

  prompt += `\n\nPlease provide:
1. Possible root cause analysis (2-3 main causes)
2. Business impact assessment
3. Specific improvement recommendations (3-5 actionable suggestions)
4. Preventive measures for the future

Please be professional, concise, and focus on actionability.`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 1500
  });
};

/**
 * Generate cost optimization suggestions
 * @param {object} costStructure - Cost structure data
 * @param {object} trends - Cost trend data
 * @returns {Promise<string>} AI optimization suggestions
 */
export const generateCostOptimizationSuggestions = async (costStructure, trends) => {
  const prompt = `You are an operational cost optimization consultant. Please provide cost optimization suggestions based on the following data.

Cost Structure:
- Direct Labor: ${costStructure.breakdown?.directLabor || 0} (${(costStructure.percentages?.directLabor || 0).toFixed(1)}%)
- Indirect Labor: ${costStructure.breakdown?.indirectLabor || 0} (${(costStructure.percentages?.indirectLabor || 0).toFixed(1)}%)
- Material Cost: ${costStructure.breakdown?.material || 0} (${(costStructure.percentages?.material || 0).toFixed(1)}%)
- Overhead: ${costStructure.breakdown?.overhead || 0} (${(costStructure.percentages?.overhead || 0).toFixed(1)}%)
- Total Cost: ${costStructure.totalCost || 0}
- Cost Per Unit: ${costStructure.costPerUnit || 0}/unit

Recent Trends:
- Average Total Cost: ${trends.averages?.avgTotalCost || 0}
- Average Unit Cost: ${trends.averages?.avgUnitCost || 0}

Please provide:
1. Cost structure analysis (which parts have disproportionately high ratios?)
2. Optimization opportunity identification (3-5 specific optimization points)
3. Priority ranking (which should be done first?)
4. Expected benefit assessment

Please be practical and specific, avoid generic suggestions.`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.6,
    maxOutputTokens: 2000
  });
};

/**
 * Predict cost trend
 * @param {Array} historicalCosts - Historical cost data
 * @param {number} forecastDays - Number of days to forecast
 * @returns {Promise<string>} AI prediction analysis
 */
export const predictCostTrend = async (historicalCosts, forecastDays = 7) => {
  const recentData = historicalCosts.slice(-30); // Take last 30 days

  const prompt = `You are a data analyst specializing in cost prediction. Based on the following historical cost data, predict the cost trend for the next ${forecastDays} days.

Historical Data (last 30 days):
${JSON.stringify(recentData.map(d => ({
  date: d.cost_date,
  total: d.total_labor_cost,
  unit: d.cost_per_unit,
  output: d.production_output
}))).slice(0, 4000)}

Please provide:
1. Trend analysis (rising/declining/stable?)
2. Key influencing factors identification
3. Forecast for the next ${forecastDays} days (approximate range)
4. Risk alerts (what should be watched?)

Please base your analysis on data, avoid excessive speculation.`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 1500
  });
};

const streamGeminiChat = async ({
  apiKey,
  message,
  fullContext,
  onChunk,
  temperature = 0.7,
  maxOutputTokens = 8192
}) => {
  const fullPrompt = fullContext
    ? `${fullContext}\n\nUser Query: ${message}`
    : message;

  const requestBody = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens
    }
  };

  const request = await postGeminiWithModelFallback({
    apiKey,
    action: 'streamGenerateContent',
    requestBody,
    query: 'alt=sse'
  });

  if (!request.ok) {
    throw new Error(request.errorData?.error?.message || request.errorMessage || `Gemini streaming request failed (${request.status || 'unknown'})`);
  }

  if (request.model !== GEMINI_MODEL) {
    console.warn(`Streaming model fallback: "${GEMINI_MODEL}" -> "${request.model}"`);
  }

  const reader = request.response.body?.getReader();
  if (!reader) {
    throw new Error('Gemini streaming response body is not readable.');
  }

  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (chunk) {
          fullText += chunk;
          onChunk?.(chunk);
        }
      } catch {
        // Skip malformed JSON chunks
      }
    }
  }

  return fullText || 'No response generated.';
};

const streamDeepSeekChat = async ({
  apiKey,
  message,
  conversationHistory,
  systemPrompt,
  
  
  onChunk,
  temperature = 0.7,
  maxOutputTokens = 8192
}) => {
  const request = await postDeepSeekWithModelFallback({
    apiKey,
    requestBody: {
      model: DEFAULT_DEEPSEEK_CHAT_MODEL,
      messages: buildDeepSeekMessages({
        message,
        conversationHistory,
        systemPrompt
      }),
      temperature,
      max_tokens: maxOutputTokens,
      stream: true
    }
  });

  if (!request.ok) {
    throw new Error(request.errorData?.error?.message || request.errorMessage || `DeepSeek streaming request failed (${request.status || 'unknown'})`);
  }

  const reader = request.response.body?.getReader();
  if (!reader) {
    throw new Error('DeepSeek streaming response body is not readable.');
  }

  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed?.choices?.[0]?.delta?.content;
        const chunk = typeof delta === 'string'
          ? delta
          : Array.isArray(delta)
            ? delta.map((part) => part?.text || '').join('')
            : '';
        if (!chunk) continue;
        fullText += chunk;
        onChunk?.(chunk);
      } catch {
        // Skip malformed chunks
      }
    }
  }

  return fullText || 'No response generated.';
};

/**
 * Streaming chat with AI - sends tokens to onChunk callback as they arrive.
 * Preferred route: DeepSeek V3.2 (deepseek-chat), fallback: Gemini.
 * @param {string} message - User message
 * @param {Array} conversationHistory - Recent messages [{role, content}, ...]
 * @param {string} systemPrompt - Rich system context (supply-chain state)
 * @param {function} onChunk - Called with each text chunk as it streams
 * @returns {Promise<string>} Full concatenated response
 */
export const streamChatWithAI = async (message, conversationHistory = [], systemPrompt = '', onChunk = null) => {
  if (USE_EDGE_AI_PROXY) {
    try {
      const result = await invokeAiProxy('deepseek_chat', {
        message,
        conversationHistory,
        systemPrompt,
        temperature: 0.7,
        maxOutputTokens: 8192,
        model: 'deepseek-chat'
      });
      const text = typeof result?.text === 'string' ? result.text : 'No response generated.';
      streamTextToChunks(text, onChunk, 48);
      return text;
    } catch (error) {
      const fallback = `❌ AI service request failed\n\nError message: ${error?.message || 'Unknown AI proxy error'}`;
      onChunk?.(fallback);
      return fallback;
    }
  }

  const deepSeekApiKey = getDeepSeekApiKey();
  const geminiApiKey = getApiKey();
  const noKeyWarning = "WARNING: No API key found. Add your DeepSeek API key (preferred) or Google AI API key in Settings.";

  if (!deepSeekApiKey && !geminiApiKey) {
    const fallback = `${noKeyWarning}\n\nDeepSeek: https://platform.deepseek.com/\nGoogle AI: https://ai.google.dev/`;
    onChunk?.(fallback);
    return fallback;
  }

  if (deepSeekApiKey) {
    try {
      return await streamDeepSeekChat({
        apiKey: deepSeekApiKey,
        message,
        conversationHistory,
        systemPrompt,
        onChunk
      });
    } catch (error) {
      console.warn('[streamChatWithAI] DeepSeek streaming failed:', error.message);
      const fallback = `❌ DeepSeek 串流對話請求失敗\n\nError: ${error.message}`;
      onChunk?.(fallback);
      return fallback;
    }
  }

  const fallback = '❌ 未設定 DeepSeek API Key，無法進行對話。\n\n請在設定中加入 DeepSeek API Key。';
  onChunk?.(fallback);
  return fallback;
};

export default {
  callGeminiAPI,
  analyzeData,
  chatWithAI,
  streamChatWithAI,
  generateReportSummary,
  extractJsonFromResponse,
  getApiKey,
  saveApiKey,
  clearApiKey,
  getDeepSeekApiKey,
  saveDeepSeekApiKey,
  clearDeepSeekApiKey,
  // Cost analysis related AI functions
  analyzeCostAnomaly,
  generateCostOptimizationSuggestions,
  predictCostTrend
};
