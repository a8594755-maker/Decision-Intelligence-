import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type ProxyMode =
  | 'gemini_generate'
  | 'gemini_chat'
  | 'gemini_chat_tools'
  | 'gemini_chat_tools_stream'
  | 'gemini_native'
  | 'deepseek_chat'
  | 'deepseek_chat_tools'
  | 'deepseek_chat_tools_stream'
  | 'deepseek_chat_tools_async'
  | 'ai_proxy_poll'
  | 'ai_chat'
  | 'di_prompt'
  | 'anthropic_chat'
  | 'anthropic_chat_tools'
  | 'anthropic_chat_tools_stream'
  | 'openai_chat'
  | 'openai_chat_tools'
  | 'openai_chat_tools_stream'
  | 'kimi_chat'
  | 'kimi_chat_tools'
  | 'anthropic_billing'
  | 'openai_billing'
  | 'kimi_billing'
  | 'openai_responses';

interface ProxyRequestBody {
  mode?: ProxyMode;
  payload?: Record<string, unknown>;
}

interface AuthContext {
  userId: string | null;
  isServerCall: boolean;
}

const FRONTEND_ORIGIN = (Deno.env.get('FRONTEND_ORIGIN') || '').trim();

const ALLOWED_ORIGINS = new Set(
  [
    FRONTEND_ORIGIN,
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
  ].filter(Boolean),
);

const buildCorsHeaders = (requestOrigin?: string | null): Record<string, string> => {
  const origin = String(requestOrigin || '').trim();
  const isAllowed =
    ALLOWED_ORIGINS.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    /^https?:\/\/[\w-]+\.supabase\.co$/.test(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : (FRONTEND_ORIGIN || 'http://localhost:5173'),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
  };
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || Deno.env.get('VITE_GEMINI_API_KEY') || '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') || Deno.env.get('VITE_DEEPSEEK_API_KEY') || '';
const GEMINI_API_VERSION = Deno.env.get('DI_GEMINI_API_VERSION') || 'v1beta';
const GEMINI_COMPAT_BASE_URL = String(
  Deno.env.get('DI_GEMINI_COMPAT_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai',
).replace(/\/+$/, '');
const GEMINI_GOOG_API_CLIENT = String(
  Deno.env.get('DI_GEMINI_GOOG_API_CLIENT') || 'decision-intelligence-ai-proxy/1.0',
).trim();
const GEMINI_AGENT_TRANSPORT = String(
  Deno.env.get('DI_GEMINI_AGENT_TRANSPORT') || 'hybrid',
).trim().toLowerCase();
const GEMINI_NATIVE_FILE_SEARCH_ENABLED = /^(1|true|yes|on)$/i.test(String(Deno.env.get('DI_GEMINI_ENABLE_FILE_SEARCH') || 'false'));
const GEMINI_NATIVE_LIVE_ENABLED = /^(1|true|yes|on)$/i.test(String(Deno.env.get('DI_GEMINI_ENABLE_LIVE_API') || 'false'));
const DEEPSEEK_BASE_URL = String(Deno.env.get('DI_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const ANTHROPIC_ADMIN_API_KEY = Deno.env.get('ANTHROPIC_ADMIN_API_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const OPENAI_ADMIN_API_KEY = Deno.env.get('OPENAI_ADMIN_API_KEY') || '';
const OPENAI_BASE_URL = String(Deno.env.get('DI_OPENAI_BASE_URL') || 'https://api.openai.com').replace(/\/+$/, '');
const KIMI_API_KEY = Deno.env.get('KIMI_API_KEY') || '';
const KIMI_BASE_URL = String(Deno.env.get('DI_KIMI_BASE_URL') || 'https://api.moonshot.ai').replace(/\/+$/, '');
const ANTHROPIC_API_VERSION = '2023-06-01';

const GEMINI_MODEL_ALIASES = Object.freeze({
  'gemini-3-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
});

const normalizeGeminiModelName = (model: unknown): string => {
  const normalized = String(model || '').trim().replace(/^models\//i, '');
  if (!normalized) return '';
  return GEMINI_MODEL_ALIASES[normalized as keyof typeof GEMINI_MODEL_ALIASES] || normalized;
};

const isGeminiModelName = (model: unknown): boolean => /^gemini-/i.test(String(model || '').trim());

const DEFAULT_GEMINI_MODEL_ADVANCED = normalizeGeminiModelName(
  Deno.env.get('DI_GEMINI_DEFAULT_MODEL_ADVANCED')
    || Deno.env.get('DI_GEMINI_MODEL')
    || Deno.env.get('GEMINI_MODEL')
    || 'gemini-3.1-pro-preview',
);
const DEFAULT_GEMINI_MODEL_FAST = normalizeGeminiModelName(
  Deno.env.get('DI_GEMINI_DEFAULT_MODEL_FAST') || 'gemini-2.5-flash',
);
const DEFAULT_GEMINI_MODEL_LIGHT = normalizeGeminiModelName(
  Deno.env.get('DI_GEMINI_DEFAULT_MODEL_LIGHT') || 'gemini-2.5-flash-lite',
);
const DEFAULT_GEMINI_MODEL = DEFAULT_GEMINI_MODEL_ADVANCED;
const GEMINI_DEFAULT_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_GEMINI_MODEL_ADVANCED,
    DEFAULT_GEMINI_MODEL_FAST,
    DEFAULT_GEMINI_MODEL_LIGHT,
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ]
    .map(normalizeGeminiModelName)
    .filter((model) => Boolean(model) && isGeminiModelName(model)),
));

const DEFAULT_DEEPSEEK_MODEL = String(
  Deno.env.get('DI_DEEPSEEK_MODEL') || Deno.env.get('DEEPSEEK_MODEL') || 'deepseek-chat',
).trim();
const DEEPSEEK_DEFAULT_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_DEEPSEEK_MODEL,
    'deepseek-chat',
    'deepseek-reasoner',
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean),
));

const DEFAULT_ANTHROPIC_MODEL = String(
  Deno.env.get('DI_ANTHROPIC_MODEL') || 'claude-sonnet-4-6',
).trim();
const ANTHROPIC_DEFAULT_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_ANTHROPIC_MODEL,
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean),
));

const DEFAULT_OPENAI_MODEL = String(
  Deno.env.get('DI_OPENAI_MODEL') || 'gpt-4.1-mini',
).trim();
const OPENAI_DEFAULT_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_OPENAI_MODEL,
    'gpt-4.1-mini',
    'gpt-4.1-nano',
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean),
));

const DEFAULT_KIMI_MODEL = String(
  Deno.env.get('DI_KIMI_MODEL') || 'kimi-k2.5',
).trim();
const KIMI_DEFAULT_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_KIMI_MODEL,
    'kimi-k2.5',
    'kimi-k2-0905-preview',
    'kimi-k2-turbo-preview',
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean),
));

const jsonResponse = (payload: unknown, status = 200, cors?: Record<string, string>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...(cors || buildCorsHeaders()),
      'Content-Type': 'application/json',
    },
  });

const toFiniteNumber = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeRequestedToolChoice = (value: unknown): 'auto' | 'required' =>
  String(value || '').trim().toLowerCase() === 'required' ? 'required' : 'auto';

const buildOpenAiStyleToolChoice = (
  value: unknown,
  options?: { provider?: string; thinkingEnabled?: boolean },
): 'auto' | 'required' => {
  const requested = normalizeRequestedToolChoice(value);
  if (requested !== 'required') return 'auto';

  if (options?.provider === 'kimi' && options.thinkingEnabled !== false) {
    return 'auto';
  }

  return 'required';
};

const buildAnthropicToolChoice = (value: unknown): { type: 'auto' | 'any' } =>
  normalizeRequestedToolChoice(value) === 'required'
    ? { type: 'any' }
    : { type: 'auto' };

const parseJsonSafe = async (response: Response): Promise<Record<string, unknown>> =>
  response.json().catch(() => ({}));

const parseJwtPayload = (token: string): Record<string, unknown> => {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const isModelLookupError = (status: number, message = ''): boolean => {
  if (status === 404) return true;
  return /(model|models).*(not found|unsupported|unknown|invalid|not supported)/i.test(message);
};

const buildGeminiApiUrl = ({
  model,
  action,
  query = '',
}: {
  model: string;
  action: 'generateContent' | 'streamGenerateContent';
  query?: string;
}) => {
  const base = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:${action}`;
  return query
    ? `${base}?${query}&key=${encodeURIComponent(GEMINI_API_KEY)}`
    : `${base}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
};

const postGeminiWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const apiUrl = buildGeminiApiUrl({ model, action: 'generateContent' });
    const t = performance.now();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const elapsed = Math.round(performance.now() - t);

    if (response.ok) {
      console.info(`[ai-proxy] Gemini model=${model} OK in ${elapsed}ms`);
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    console.warn(`[ai-proxy] Gemini model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    const failure = {
      ok: false,
      response,
      status: response.status,
      model,
      errorData,
      errorMessage,
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
    model: DEFAULT_GEMINI_MODEL,
    errorData: {},
    errorMessage: 'No Gemini model candidates are available for this request.',
  };
};

const postDeepSeekWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        ...requestBody,
        model,
      }),
    });

    if (response.ok) {
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    const failure = {
      ok: false,
      response,
      status: response.status,
      model,
      errorData,
      errorMessage,
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
    model: DEFAULT_DEEPSEEK_MODEL,
    errorData: {},
    errorMessage: 'No DeepSeek model candidates are available for this request.',
  };
};

const extractGeminiText = (body: Record<string, unknown>): string => {
  const candidates = body?.candidates as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const content = candidates[0]?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts) || parts.length === 0) return '';
  return parts.map((part) => String(part?.text || '')).join('');
};

const extractDeepSeekText = (body: Record<string, unknown>): string => {
  const choices = body?.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => String((part as Record<string, unknown>)?.text || '')).join('');
  }
  return '';
};

const extractDeepSeekReasoningContent = (body: Record<string, unknown>): string => {
  const choices = body?.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  return typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
};

const normalizeChatRole = (role: unknown): 'assistant' | 'user' => {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'ai') return 'assistant';
  return 'user';
};

const buildHistoryLines = (conversationHistory: unknown[] = [], limit = 10): string => (
  conversationHistory
    .slice(-limit)
    .map((entry) => {
      const row = entry as { role?: unknown; content?: unknown };
      const content = typeof row?.content === 'string' ? row.content.trim() : '';
      if (!content) return null;
      const speaker = normalizeChatRole(row.role) === 'assistant' ? 'Assistant' : 'User';
      return `${speaker}: ${content}`;
    })
    .filter(Boolean)
    .join('\n')
);

const buildChatSystemContext = ({
  systemPrompt = '',
  conversationHistory = [],
  historyLimit = 10,
}: {
  systemPrompt?: string;
  conversationHistory?: unknown[];
  historyLimit?: number;
}) => {
  let fullContext = String(systemPrompt || '');
  const historyText = buildHistoryLines(conversationHistory, historyLimit);
  if (historyText) {
    fullContext += `${fullContext ? '\n\n' : ''}Conversation History:\n${historyText}`;
  }
  return fullContext;
};

const buildDeepSeekMessages = ({
  message,
  conversationHistory = [],
  systemPrompt = '',
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
}) => {
  const messages: Array<{ role: 'assistant' | 'user' | 'system'; content: string }> = [];
  const normalizedSystemPrompt = String(systemPrompt || '').trim();
  if (normalizedSystemPrompt) {
    messages.push({ role: 'system', content: normalizedSystemPrompt });
  }

  const cleanMessage = String(message || '').trim();
  const historyWindow = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
  const dedupedHistory = historyWindow.length > 0
    ? historyWindow.slice(0, -1).concat(
        (() => {
          const last = historyWindow[historyWindow.length - 1] as { role?: unknown; content?: unknown };
          const lastRole = normalizeChatRole(last?.role);
          const lastContent = typeof last?.content === 'string' ? last.content.trim() : '';
          if (lastRole === 'user' && lastContent === cleanMessage) return [];
          return [last];
        })(),
      )
    : [];

  dedupedHistory.forEach((entry) => {
    const row = entry as { role?: unknown; content?: unknown };
    const content = typeof row?.content === 'string' ? row.content.trim() : '';
    if (!content) return;
    messages.push({
      role: normalizeChatRole(row.role),
      content,
    });
  });

  messages.push({ role: 'user', content: cleanMessage });
  return messages;
};

const callGeminiGenerate = async ({
  prompt,
  systemContext = '',
  options = {},
}: {
  prompt: string;
  systemContext?: string;
  options?: Record<string, unknown>;
}) => {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on Edge Function.');
  }

  const model = normalizeGeminiModelName(options?.model);
  const modelCandidates = Array.from(new Set(
    [model, ...(options?.modelCandidates as string[] || []), ...GEMINI_DEFAULT_CANDIDATES]
      .map(normalizeGeminiModelName)
      .filter((candidate) => Boolean(candidate) && isGeminiModelName(candidate)),
  ));

  const fullPrompt = systemContext
    ? `${systemContext}\n\nUser Query: ${prompt}`
    : prompt;
  const temperature = toFiniteNumber(options?.temperature, 0.7);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(options?.maxOutputTokens, 8192)));
  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens,
  };
  if (typeof options?.responseMimeType === 'string' && options.responseMimeType.trim()) {
    generationConfig.responseMimeType = options.responseMimeType.trim();
  }

  const request = await postGeminiWithModelFallback({
    requestBody: {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig,
    },
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const message = String(request.errorMessage || 'Gemini request failed.');
    const error = new Error(message);
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);
  const text = extractGeminiText(body);
  if (!text) {
    throw new Error('Gemini returned empty content.');
  }

  return {
    provider: 'gemini',
    model: String(request.model || modelCandidates[0] || DEFAULT_GEMINI_MODEL),
    text,
    raw: body,
  };
};

const callDeepSeekChat = async ({
  message,
  conversationHistory = [],
  systemPrompt = '',
  temperature = 0.7,
  maxOutputTokens = 8192,
  model,
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}) => {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not configured on Edge Function.');
  }

  const modelCandidates = Array.from(new Set(
    [model, ...DEEPSEEK_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  const request = await postDeepSeekWithModelFallback({
    requestBody: {
      model: model || DEFAULT_DEEPSEEK_MODEL,
      messages: buildDeepSeekMessages({
        message,
        conversationHistory,
        systemPrompt,
      }),
      temperature,
      max_tokens: maxOutputTokens,
    },
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const messageText = String(request.errorMessage || 'DeepSeek request failed.');
    const error = new Error(messageText);
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);
  const text = extractDeepSeekText(body);
  if (!text) {
    throw new Error('DeepSeek returned empty content.');
  }

  return {
    provider: 'deepseek',
    model: String(request.model || model || DEFAULT_DEEPSEEK_MODEL),
    text,
    raw: body,
  };
};

// ── Anthropic (Claude) ────────────────────────────────────────────────────

const postAnthropicWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const t = performance.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({ ...requestBody, model }),
    });
    const elapsed = Math.round(performance.now() - t);

    if (response.ok) {
      console.info(`[ai-proxy] Anthropic model=${model} OK in ${elapsed}ms`);
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    console.warn(`[ai-proxy] Anthropic model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    const failure = { ok: false, response, status: response.status, model, errorData, errorMessage };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }
    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false, response: null, status: 0, model: DEFAULT_ANTHROPIC_MODEL,
    errorData: {}, errorMessage: 'No Anthropic model candidates are available for this request.',
  };
};

const extractAnthropicText = (body: Record<string, unknown>): string => {
  const content = body?.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content) || content.length === 0) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block?.text || ''))
    .join('');
};

const callAnthropicChat = async ({
  message,
  conversationHistory = [],
  systemPrompt = '',
  temperature = 0.7,
  maxOutputTokens = 8192,
  model,
  jsonMode = false,
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  jsonMode?: boolean;
}) => {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured on Edge Function.');
  }

  const modelCandidates = Array.from(new Set(
    [model, ...ANTHROPIC_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  // Build messages array (Anthropic format: role must alternate user/assistant)
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const historyWindow = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
  for (const entry of historyWindow) {
    const row = entry as { role?: unknown; content?: unknown };
    const content = typeof row?.content === 'string' ? row.content.trim() : '';
    if (!content) continue;
    const role = normalizeChatRole(row.role);
    // Ensure alternation: skip if same role as last message
    if (messages.length > 0 && messages[messages.length - 1].role === role) continue;
    messages.push({ role, content });
  }
  // Add current user message (skip if duplicate of last)
  const cleanMessage = String(message || '').trim();
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user' ||
      messages[messages.length - 1].content !== cleanMessage) {
    messages.push({ role: 'user', content: cleanMessage });
  }

  // JSON mode: prefill assistant response with '{' to strongly bias toward JSON output
  if (jsonMode) {
    messages.push({ role: 'assistant', content: '{' });
  }

  const requestBody: Record<string, unknown> = {
    messages,
    max_tokens: maxOutputTokens,
    temperature,
  };
  if (systemPrompt.trim()) {
    requestBody.system = systemPrompt.trim();
  }

  const request = await postAnthropicWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const messageText = String(request.errorMessage || 'Anthropic request failed.');
    const error = new Error(messageText);
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);
  let text = extractAnthropicText(body);
  if (!text) {
    throw new Error('Anthropic returned empty content.');
  }

  // When jsonMode prefilled '{', prepend it back to the response text
  if (jsonMode && !text.trimStart().startsWith('{')) {
    text = '{' + text;
  }

  return {
    provider: 'anthropic',
    model: String(request.model || model || DEFAULT_ANTHROPIC_MODEL),
    text,
    raw: body,
    usage: body?.usage || null,
  };
};

// ── OpenAI ────────────────────────────────────────────────────────────────

const postOpenAIWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const t = performance.now();
    const response = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ ...requestBody, model }),
    });
    const elapsed = Math.round(performance.now() - t);

    if (response.ok) {
      console.info(`[ai-proxy] OpenAI model=${model} OK in ${elapsed}ms`);
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    console.warn(`[ai-proxy] OpenAI model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    const failure = { ok: false, response, status: response.status, model, errorData, errorMessage };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }
    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false, response: null, status: 0, model: DEFAULT_OPENAI_MODEL,
    errorData: {}, errorMessage: 'No OpenAI model candidates are available for this request.',
  };
};

const extractOpenAIText = (body: Record<string, unknown>): string => {
  const choices = body?.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  return typeof message?.content === 'string' ? message.content : '';
};

// ── Kimi (Moonshot) — OpenAI-compatible API ───────────────────────────────

// kimi-k2.5 and thinking models use fixed temperature/top_p; sending custom values causes errors
const isKimiFixedTempModel = (model: string): boolean =>
  /^kimi-k2\.5/i.test(model) || /^kimi-k2-thinking/i.test(model);

const postKimiWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const t = performance.now();
    const response = await fetch(`${KIMI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify({ ...requestBody, model }),
    });
    const elapsed = Math.round(performance.now() - t);

    if (response.ok) {
      console.info(`[ai-proxy] Kimi model=${model} OK in ${elapsed}ms`);
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    console.warn(`[ai-proxy] Kimi model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    const failure = { ok: false, response, status: response.status, model, errorData, errorMessage };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }
    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false, response: null, status: 0, model: DEFAULT_KIMI_MODEL,
    errorData: {}, errorMessage: 'No Kimi model candidates are available for this request.',
  };
};

const callKimiChat = async ({
  message,
  conversationHistory = [],
  systemPrompt = '',
  temperature = 0.7,
  maxOutputTokens = 8192,
  model,
  jsonMode = false,
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  jsonMode?: boolean;
}) => {
  if (!KIMI_API_KEY) {
    throw new Error('KIMI_API_KEY is not configured on Edge Function.');
  }

  const modelCandidates = Array.from(new Set(
    [model, ...KIMI_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() });
  }
  const historyWindow = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
  for (const entry of historyWindow) {
    const row = entry as { role?: unknown; content?: unknown };
    const content = typeof row?.content === 'string' ? row.content.trim() : '';
    if (!content) continue;
    messages.push({ role: normalizeChatRole(row.role), content });
  }
  messages.push({ role: 'user', content: String(message || '').trim() });

  const request = await postKimiWithModelFallback({
    requestBody: {
      messages,
      // kimi-k2.5 and thinking models reject custom temperature/top_p
      ...(isKimiFixedTempModel(String(model || '')) ? {} : { temperature }),
      max_tokens: maxOutputTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const messageText = String(request.errorMessage || 'Kimi request failed.');
    const error = new Error(messageText);
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);
  const text = extractOpenAIText(body); // Kimi uses OpenAI-compatible response format
  if (!text) {
    throw new Error('Kimi returned empty content.');
  }

  return {
    provider: 'kimi',
    model: String(request.model || model || DEFAULT_KIMI_MODEL),
    text,
    raw: body,
    usage: body?.usage || null,
  };
};

const safeParseJsonObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const buildAnthropicToolsFromOpenAITools = (tools: unknown[]): Array<Record<string, unknown>> => (
  (Array.isArray(tools) ? tools : [])
    .map((entry) => {
      const tool = entry as { type?: unknown; function?: Record<string, unknown> };
      const fn = tool?.function || {};
      const name = String(fn?.name || '').trim();
      if (tool?.type !== 'function' || !name) return null;
      const description = String(fn?.description || '').trim();
      const inputSchema = fn?.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
        ? fn.parameters as Record<string, unknown>
        : { type: 'object', properties: {} };
      return {
        name,
        description,
        input_schema: inputSchema,
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>
);

const normalizeOpenAIMessageText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const row = part as Record<string, unknown>;
        if (typeof row?.text === 'string') return row.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
};

const mergeAnthropicMessage = (
  messages: Array<{ role: 'assistant' | 'user'; content: Array<Record<string, unknown>> }>,
  role: 'assistant' | 'user',
  content: Array<Record<string, unknown>>,
) => {
  if (!content.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...content);
    return;
  }
  messages.push({ role, content: [...content] });
};

const buildAnthropicMessagesFromOpenAIMessages = (rawMessages: unknown[]) => {
  const systemParts: string[] = [];
  const messages: Array<{ role: 'assistant' | 'user'; content: Array<Record<string, unknown>> }> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) return;
    mergeAnthropicMessage(messages, 'user', pendingToolResults);
    pendingToolResults = [];
  };

  for (const entry of Array.isArray(rawMessages) ? rawMessages : []) {
    const row = entry as {
      role?: unknown;
      content?: unknown;
      tool_calls?: Array<Record<string, unknown>>;
      tool_call_id?: unknown;
    };
    const role = String(row?.role || '').trim().toLowerCase();

    if (role === 'system') {
      const text = normalizeOpenAIMessageText(row?.content).trim();
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      const toolUseId = String(row?.tool_call_id || '').trim();
      if (!toolUseId) continue;
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: normalizeOpenAIMessageText(row?.content),
      });
      continue;
    }

    flushPendingToolResults();

    if (role !== 'assistant' && role !== 'user' && role !== 'ai') continue;

    const messageRole = normalizeChatRole(role);
    const text = normalizeOpenAIMessageText(row?.content);
    const contentBlocks: Array<Record<string, unknown>> = [];
    if (text) {
      contentBlocks.push({ type: 'text', text });
    }

    if (messageRole === 'assistant' && Array.isArray(row?.tool_calls)) {
      row.tool_calls.forEach((toolCall, index) => {
        const fn = (toolCall as { function?: Record<string, unknown> })?.function || {};
        const toolName = String(fn?.name || '').trim();
        if (!toolName) return;
        const toolId = String((toolCall as { id?: unknown })?.id || `toolu_local_${index + 1}`).trim();
        contentBlocks.push({
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input: safeParseJsonObject(fn?.arguments),
        });
      });
    }

    mergeAnthropicMessage(messages, messageRole, contentBlocks);
  }

  flushPendingToolResults();

  return {
    system: systemParts.join('\n\n').trim(),
    messages,
  };
};

const convertAnthropicResponseToOpenAIFormat = ({
  body,
  model,
}: {
  body: Record<string, unknown>;
  model: string;
}) => {
  const content = Array.isArray(body?.content) ? body.content as Array<Record<string, unknown>> : [];
  const textContent = content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block?.text || ''))
    .join('');
  const toolCalls = content
    .filter((block) => block?.type === 'tool_use')
    .map((block) => ({
      id: String(block?.id || ''),
      type: 'function',
      function: {
        name: String(block?.name || ''),
        arguments: JSON.stringify((block?.input && typeof block.input === 'object' && !Array.isArray(block.input))
          ? block.input
          : {}),
      },
    }))
    .filter((toolCall) => toolCall.id && toolCall.function.name);

  const stopReason = String(body?.stop_reason || '').trim();
  const finishReason = stopReason === 'tool_use'
    ? 'tool_calls'
    : stopReason === 'max_tokens'
      ? 'length'
      : 'stop';

  const usage = body?.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : {};
  const inputTokens = Number(usage?.input_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);

  return {
    id: String(body?.id || ''),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
};

const createAnthropicOpenAICompatibleSseStream = (source: ReadableStream<Uint8Array>) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      let buffer = '';
      let inputTokens = 0;
      let streamClosed = false;
      const toolCallIndexes = new Map<number, number>();
      let nextToolCallIndex = 0;

      const enqueueJson = (payload: unknown) => {
        if (streamClosed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const enqueueDone = () => {
        if (streamClosed) return;
        streamClosed = true;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      };

      const processRawEvent = (rawEvent: string) => {
        const trimmed = rawEvent.trim();
        if (!trimmed) return;

        const data = trimmed
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (!data) return;
        if (data === '[DONE]') {
          enqueueDone();
          return;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }

        const type = String(parsed?.type || '');

        if (type === 'message_start') {
          inputTokens = Number((parsed?.message as Record<string, unknown> | undefined)?.usage && ((parsed.message as Record<string, unknown>).usage as Record<string, unknown>)?.input_tokens || 0);
          return;
        }

        if (type === 'content_block_start') {
          const block = parsed?.content_block as Record<string, unknown> | undefined;
          const blockType = String(block?.type || '');
          if (blockType === 'tool_use' || blockType === 'server_tool_use') {
            const contentIndex = Number(parsed?.index || 0);
            const toolCallIndex = nextToolCallIndex++;
            toolCallIndexes.set(contentIndex, toolCallIndex);
            enqueueJson({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: toolCallIndex,
                    id: String(block?.id || ''),
                    type: 'function',
                    function: {
                      name: String(block?.name || ''),
                      arguments: '',
                    },
                  }],
                },
              }],
            });
          }
          return;
        }

        if (type === 'content_block_delta') {
          const delta = parsed?.delta as Record<string, unknown> | undefined;
          const deltaType = String(delta?.type || '');

          if (deltaType === 'text_delta') {
            const text = String(delta?.text || '');
            if (!text) return;
            enqueueJson({
              choices: [{
                delta: {
                  content: text,
                },
              }],
            });
            return;
          }

          if (deltaType === 'input_json_delta') {
            const contentIndex = Number(parsed?.index || 0);
            let toolCallIndex = toolCallIndexes.get(contentIndex);
            if (toolCallIndex == null) {
              toolCallIndex = nextToolCallIndex++;
              toolCallIndexes.set(contentIndex, toolCallIndex);
            }
            enqueueJson({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: toolCallIndex,
                    function: {
                      arguments: String(delta?.partial_json || ''),
                    },
                  }],
                },
              }],
            });
          }
          return;
        }

        if (type === 'message_delta') {
          const usage = parsed?.usage as Record<string, unknown> | undefined;
          const outputTokens = Number(usage?.output_tokens || 0);
          enqueueJson({
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          });
          return;
        }

        if (type === 'message_stop') {
          enqueueDone();
          return;
        }

        if (type === 'error') {
          enqueueJson({ error: parsed?.error || parsed });
          enqueueDone();
        }
      };

      try {
        while (!streamClosed) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            processRawEvent(rawEvent);
            if (streamClosed) break;
            boundary = buffer.indexOf('\n\n');
          }
        }

        if (!streamClosed && buffer.trim()) {
          processRawEvent(buffer);
        }

        if (!streamClosed) {
          enqueueDone();
        }
      } catch (error) {
        if (!streamClosed) {
          controller.error(error);
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
};

const createServiceRoleSupabaseClient = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const buildGeminiCompatHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${GEMINI_API_KEY}`,
  'x-goog-api-client': GEMINI_GOOG_API_CLIENT,
});

const buildGeminiNativeHeaders = (contentType = 'application/json') => ({
  'Content-Type': contentType,
  'x-goog-api-key': GEMINI_API_KEY,
  'x-goog-api-client': GEMINI_GOOG_API_CLIENT,
});

const buildGeminiNativeRestUrl = (path: string, { upload = false, query = '' }: { upload?: boolean; query?: string } = {}) => {
  const basePath = upload ? `https://generativelanguage.googleapis.com/upload/${GEMINI_API_VERSION}` : `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}`;
  const separator = query ? `?${query}&key=` : '?key=';
  return `${basePath}/${path}${separator}${encodeURIComponent(GEMINI_API_KEY)}`;
};

const normalizeGeminiOpenAIUsage = (usage: Record<string, unknown> | undefined) => {
  const promptTokens = Number(usage?.prompt_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage?.total_tokens || (promptTokens + completionTokens)),
  };
};

const normalizeGeminiNativeUsage = (usage: Record<string, unknown> | undefined) => {
  const promptTokens = Number(usage?.promptTokenCount || 0) + Number(usage?.cachedContentTokenCount || 0);
  const completionTokens = Number(usage?.candidatesTokenCount || 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage?.totalTokenCount || (promptTokens + completionTokens)),
    cached_tokens: Number(usage?.cachedContentTokenCount || 0),
  };
};

const extractGeminiNativeText = (body: Record<string, unknown>): string => {
  const candidates = Array.isArray(body?.candidates) ? body.candidates as Array<Record<string, unknown>> : [];
  if (candidates.length === 0) return '';
  const content = candidates[0]?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];
  return parts
    .map((part) => String(part?.text || ''))
    .filter(Boolean)
    .join('');
};

const buildGeminiCompatExtraBody = (googleOptions: Record<string, unknown> = {}) => {
  const google: Record<string, unknown> = {};

  const cachedContent = String(googleOptions?.cachedContent || googleOptions?.cached_content || '').trim();
  if (cachedContent) google.cached_content = cachedContent;
  if (googleOptions?.thinkingConfig && typeof googleOptions.thinkingConfig === 'object') {
    google.thinking_config = googleOptions.thinkingConfig;
  }
  if (googleOptions?.safetySettings && Array.isArray(googleOptions.safetySettings)) {
    google.safety_settings = googleOptions.safetySettings;
  }
  if (googleOptions?.generationConfig && typeof googleOptions.generationConfig === 'object') {
    google.generation_config = googleOptions.generationConfig;
  }
  if (googleOptions?.responseSchema && typeof googleOptions.responseSchema === 'object') {
    google.response_schema = googleOptions.responseSchema;
  }
  if (googleOptions?.responseMimeType && typeof googleOptions.responseMimeType === 'string') {
    google.response_mime_type = googleOptions.responseMimeType;
  }

  return Object.keys(google).length > 0 ? { google } : null;
};

const postGeminiCompatWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const t = performance.now();
    const response = await fetch(`${GEMINI_COMPAT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildGeminiCompatHeaders(),
      body: JSON.stringify({ ...requestBody, model }),
    });
    const elapsed = Math.round(performance.now() - t);

    if (response.ok) {
      console.info(`[ai-proxy] Gemini compat model=${model} OK in ${elapsed}ms`);
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    console.warn(`[ai-proxy] Gemini compat model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    const failure = { ok: false, response, status: response.status, model, errorData, errorMessage };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }
    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false,
    response: null,
    status: 0,
    model: DEFAULT_GEMINI_MODEL_FAST,
    errorData: {},
    errorMessage: 'No Gemini compat model candidates are available for this request.',
  };
};

const buildGeminiNativeToolDeclarations = ({
  googleTools = [],
  customTools = [],
}: {
  googleTools?: unknown[];
  customTools?: unknown[];
}) => {
  const normalizedGoogleTools = Array.isArray(googleTools) ? googleTools : [];
  const normalizedCustomTools = Array.isArray(customTools) ? customTools : [];

  if (normalizedGoogleTools.length > 0 && normalizedCustomTools.length > 0) {
    throw new Error('Gemini native requests cannot mix Google server-side tools with custom function declarations. Use compat tool mode for custom/local tools.');
  }

  const tools: Array<Record<string, unknown>> = [];

  normalizedGoogleTools.forEach((entry) => {
    const row = typeof entry === 'string'
      ? { type: entry }
      : (entry && typeof entry === 'object' ? entry as Record<string, unknown> : {});
    const toolType = String(row?.type || row?.name || '').trim().toLowerCase();

    if (!toolType) return;

    if (toolType === 'google_search') {
      tools.push({ googleSearch: row?.config && typeof row.config === 'object' ? row.config : {} });
      return;
    }
    if (toolType === 'code_execution') {
      tools.push({ codeExecution: row?.config && typeof row.config === 'object' ? row.config : {} });
      return;
    }
    if (toolType === 'url_context') {
      tools.push({ urlContext: row?.config && typeof row.config === 'object' ? row.config : {} });
      return;
    }
    if (toolType === 'file_search') {
      if (!GEMINI_NATIVE_FILE_SEARCH_ENABLED) {
        throw new Error('Gemini File Search is disabled by feature flag.');
      }
      const config = row?.config && typeof row.config === 'object' ? row.config : {};
      tools.push({ fileSearch: config });
      return;
    }
    if (toolType === 'live_api') {
      if (!GEMINI_NATIVE_LIVE_ENABLED) {
        throw new Error('Gemini Live API is disabled by feature flag.');
      }
      throw new Error('Gemini Live API requires a websocket/session flow and is not available through ai-proxy HTTP mode.');
    }

    throw new Error(`Unsupported Gemini native Google tool: ${toolType}`);
  });

  if (normalizedCustomTools.length > 0) {
    const functionDeclarations = normalizedCustomTools
      .map((entry) => {
        const tool = entry as { type?: unknown; function?: Record<string, unknown> };
        const fn = tool?.function || {};
        const name = String(fn?.name || '').trim();
        if (tool?.type !== 'function' || !name) return null;
        return {
          name,
          description: String(fn?.description || '').trim(),
          parameters: fn?.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
            ? fn.parameters
            : { type: 'object', properties: {} },
        };
      })
      .filter(Boolean);
    if (functionDeclarations.length > 0) {
      tools.push({ functionDeclarations });
    }
  }

  return tools;
};

const buildGeminiNativeConversationContents = ({
  prompt = '',
  message = '',
  conversationHistory = [],
  contents = [],
}: {
  prompt?: string;
  message?: string;
  conversationHistory?: unknown[];
  contents?: unknown[];
}) => {
  if (Array.isArray(contents) && contents.length > 0) {
    return contents as Array<Record<string, unknown>>;
  }

  const nativeContents: Array<Record<string, unknown>> = [];
  const historyWindow = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];

  historyWindow.forEach((entry) => {
    const row = entry as { role?: unknown; content?: unknown };
    const role = normalizeChatRole(row?.role) === 'assistant' ? 'model' : 'user';
    const text = normalizeOpenAIMessageText(row?.content).trim();
    if (!text) return;
    nativeContents.push({ role, parts: [{ text }] });
  });

  const terminalPrompt = String(prompt || message || '').trim();
  if (terminalPrompt) {
    nativeContents.push({ role: 'user', parts: [{ text: terminalPrompt }] });
  }

  return nativeContents;
};

const buildGeminiNativeSystemInstruction = (value: unknown) => {
  const text = String(value || '').trim();
  if (!text) return null;
  return { parts: [{ text }] };
};

const buildGeminiProviderCacheKey = async ({
  userId,
  model,
  systemInstruction,
  toolSignature,
  fileFingerprints,
}: {
  userId: string;
  model: string;
  systemInstruction: string;
  toolSignature: unknown;
  fileFingerprints: string[];
}) => {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(JSON.stringify({
      userId,
      provider: 'gemini',
      model,
      systemInstruction,
      toolSignature,
      fileFingerprints,
    })),
  );
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
};

const getUserFileRecord = async ({ userId, fileId }: { userId: string; fileId: string | number }) => {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('user_files')
    .select('id, user_id, filename, data, created_at')
    .eq('user_id', userId)
    .eq('id', fileId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
};

const lookupGeminiProviderFile = async ({
  userId,
  sourceFileId,
  sourceFingerprint,
}: {
  userId: string;
  sourceFileId: string | number;
  sourceFingerprint: string;
}) => {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('di_llm_provider_files')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'gemini')
    .eq('source_file_id', sourceFileId)
    .eq('source_fingerprint', sourceFingerprint)
    .gt('expire_at', new Date().toISOString())
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
};

const upsertGeminiProviderFile = async (payload: Record<string, unknown>) => {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('di_llm_provider_files')
    .upsert([payload], { onConflict: 'user_id,provider,source_file_id,source_fingerprint' })
    .select('*')
    .single();

  if (error) throw error;
  return data;
};

const lookupGeminiProviderCache = async ({
  userId,
  modelName,
  cacheKey,
}: {
  userId: string;
  modelName: string;
  cacheKey: string;
}) => {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('di_llm_provider_caches')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'gemini')
    .eq('model_name', modelName)
    .eq('cache_key', cacheKey)
    .gt('expire_at', new Date().toISOString())
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
};

const upsertGeminiProviderCache = async (payload: Record<string, unknown>) => {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('di_llm_provider_caches')
    .upsert([payload], { onConflict: 'user_id,provider,model_name,cache_key' })
    .select('*')
    .single();

  if (error) throw error;
  return data;
};

const buildGeminiUploadSource = async (userFileRecord: Record<string, unknown>) => {
  const rows = (userFileRecord?.data as Record<string, unknown> | undefined)?.rows;
  const displayName = String(
    (rows && typeof rows === 'object' && !Array.isArray(rows) && ((rows as Record<string, unknown>)?.file_name || (rows as Record<string, unknown>)?.display_name))
      || userFileRecord?.filename
      || 'attachment.txt',
  ).trim() || 'attachment.txt';

  let mimeType = 'text/plain';
  let serialized = '';

  if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
    const payload = rows as Record<string, unknown>;
    if (typeof payload?.extracted_text === 'string' && payload.extracted_text.trim()) {
      serialized = payload.extracted_text;
      mimeType = 'text/plain';
    } else if (typeof payload?.preview_text === 'string' && payload.preview_text.trim()) {
      serialized = payload.preview_text;
      mimeType = 'text/plain';
    } else {
      serialized = JSON.stringify(payload, null, 2);
      mimeType = 'application/json';
    }
    if (typeof payload?.mime_type === 'string' && payload.mime_type.trim()) {
      mimeType = payload.mime_type.trim().includes('pdf') ? 'text/plain' : mimeType;
    }
  } else if (Array.isArray(rows)) {
    serialized = JSON.stringify(rows, null, 2);
    mimeType = 'application/json';
  } else if (typeof rows === 'string') {
    serialized = rows;
    mimeType = 'text/plain';
  } else {
    serialized = JSON.stringify(userFileRecord?.data || {}, null, 2);
    mimeType = 'application/json';
  }

  const version = String((userFileRecord?.data as Record<string, unknown> | undefined)?.version || '').trim();
  const sourceFingerprint = `${String(userFileRecord?.id || '')}:${version || displayName}`;
  const bytes = new TextEncoder().encode(serialized);

  return {
    bytes,
    mimeType: mimeType === 'application/pdf' ? 'text/plain' : mimeType,
    displayName,
    sourceFingerprint,
    sizeBytes: bytes.byteLength,
    metadata: {
      storage_kind: Array.isArray(rows) ? 'json_rows' : typeof rows,
      original_filename: userFileRecord?.filename || displayName,
    },
  };
};

const uploadGeminiFile = async ({
  bytes,
  displayName,
  mimeType,
}: {
  bytes: Uint8Array;
  displayName: string;
  mimeType: string;
}) => {
  const startResponse = await fetch(buildGeminiNativeRestUrl('files', { upload: true }), {
    method: 'POST',
    headers: {
      ...buildGeminiNativeHeaders('application/json'),
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify({
      file: {
        display_name: displayName,
      },
    }),
  });

  if (!startResponse.ok) {
    const errorData = await parseJsonSafe(startResponse);
    throw new Error(String((errorData?.error as { message?: string })?.message || `Gemini file upload start failed (${startResponse.status})`));
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini file upload did not return a resumable upload URL.');
  }

  const finalizeResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });

  if (!finalizeResponse.ok) {
    const errorData = await parseJsonSafe(finalizeResponse);
    throw new Error(String((errorData?.error as { message?: string })?.message || `Gemini file upload finalize failed (${finalizeResponse.status})`));
  }

  const body = await parseJsonSafe(finalizeResponse);
  const file = body?.file && typeof body.file === 'object' ? body.file as Record<string, unknown> : body;
  return {
    name: String(file?.name || ''),
    uri: String(file?.uri || ''),
    mimeType: String(file?.mimeType || mimeType),
    state: String((file?.state as Record<string, unknown> | undefined)?.name || file?.state || ''),
    sizeBytes: Number(file?.sizeBytes || bytes.byteLength),
    raw: body,
  };
};

const createGeminiCachedContent = async ({
  model,
  systemInstruction,
  tools,
  contents,
  displayName,
  ttl = '86400s',
}: {
  model: string;
  systemInstruction?: string;
  tools?: Array<Record<string, unknown>>;
  contents: Array<Record<string, unknown>>;
  displayName: string;
  ttl?: string;
}) => {
  const requestBody: Record<string, unknown> = {
    model: model.startsWith('models/') ? model : `models/${model}`,
    displayName,
    contents,
    ttl,
  };
  const nativeSystemInstruction = buildGeminiNativeSystemInstruction(systemInstruction);
  if (nativeSystemInstruction) {
    requestBody.systemInstruction = nativeSystemInstruction;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools;
  }

  const response = await fetch(buildGeminiNativeRestUrl('cachedContents'), {
    method: 'POST',
    headers: buildGeminiNativeHeaders(),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await parseJsonSafe(response);
    throw new Error(String((errorData?.error as { message?: string })?.message || `Gemini cache creation failed (${response.status})`));
  }

  const body = await parseJsonSafe(response);
  return {
    name: String(body?.name || ''),
    expireTime: String(body?.expireTime || ''),
    usageMetadata: body?.usageMetadata || null,
    raw: body,
  };
};

const resolveGeminiNativeFileParts = async ({
  authContext,
  nativeCapabilities,
  attachments,
}: {
  authContext: AuthContext;
  nativeCapabilities: Record<string, unknown>;
  attachments: unknown[];
}) => {
  const refs = [
    ...(Array.isArray(nativeCapabilities?.fileRefs) ? nativeCapabilities.fileRefs : []),
    ...(Array.isArray(attachments) ? attachments : []),
  ];

  if (refs.length === 0 || !authContext.userId) {
    return { parts: [], fileFingerprints: [], uploadEvents: [] as Array<Record<string, unknown>> };
  }

  const parts: Array<Record<string, unknown>> = [];
  const fileFingerprints: string[] = [];
  const uploadEvents: Array<Record<string, unknown>> = [];

  for (const entry of refs) {
    const row = entry as Record<string, unknown>;
    const fileRecordId = row?.fileRecordId || row?.file_record_id;
    if (!fileRecordId) continue;

    const userFileRecord = await getUserFileRecord({
      userId: authContext.userId,
      fileId: fileRecordId as string | number,
    });
    if (!userFileRecord) continue;

    const uploadSource = await buildGeminiUploadSource(userFileRecord);
    fileFingerprints.push(uploadSource.sourceFingerprint);

    const existingProviderFile = await lookupGeminiProviderFile({
      userId: authContext.userId,
      sourceFileId: userFileRecord.id as string | number,
      sourceFingerprint: uploadSource.sourceFingerprint,
    });

    let providerFile = existingProviderFile;
    let eventType = 'reuse';

    if (!providerFile || !String(providerFile?.provider_file_uri || '').trim()) {
      const uploaded = await uploadGeminiFile({
        bytes: uploadSource.bytes,
        displayName: uploadSource.displayName,
        mimeType: uploadSource.mimeType,
      });
      providerFile = await upsertGeminiProviderFile({
        user_id: authContext.userId,
        provider: 'gemini',
        source_file_id: userFileRecord.id,
        source_fingerprint: uploadSource.sourceFingerprint,
        provider_file_name: uploaded.name,
        provider_file_uri: uploaded.uri,
        mime_type: uploaded.mimeType,
        size_bytes: uploaded.sizeBytes,
        display_name: uploadSource.displayName,
        model_hint: String(nativeCapabilities?.modelHint || ''),
        expire_at: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
        metadata_json: {
          ...(uploadSource.metadata || {}),
          state: uploaded.state,
          raw: uploaded.raw,
        },
        updated_at: new Date().toISOString(),
      });
      eventType = 'upload';
    }

    parts.push({
      file_data: {
        mimeType: String(providerFile?.mime_type || uploadSource.mimeType),
        fileUri: String(providerFile?.provider_file_uri || ''),
      },
    });
    uploadEvents.push({
      source_file_id: userFileRecord.id,
      source_fingerprint: uploadSource.sourceFingerprint,
      event: eventType,
      provider_file_name: providerFile?.provider_file_name || null,
    });
  }

  return { parts, fileFingerprints, uploadEvents };
};

const createGeminiNativeTextSseStream = (source: ReadableStream<Uint8Array>) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      let buffer = '';
      let streamClosed = false;

      const enqueueJson = (payload: unknown) => {
        if (streamClosed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const enqueueDone = () => {
        if (streamClosed) return;
        streamClosed = true;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      };

      try {
        while (!streamClosed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (!rawEvent) continue;
            const data = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data || data === '[DONE]') {
              enqueueDone();
              continue;
            }

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            const usage = parsed?.usageMetadata && typeof parsed.usageMetadata === 'object'
              ? normalizeGeminiNativeUsage(parsed.usageMetadata as Record<string, unknown>)
              : null;
            if (usage) {
              enqueueJson({ usage });
            }

            const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates as Array<Record<string, unknown>> : [];
            const parts = Array.isArray(candidates?.[0]?.content && (candidates[0].content as Record<string, unknown>).parts)
              ? ((candidates[0].content as Record<string, unknown>).parts as Array<Record<string, unknown>>)
              : [];
            const text = parts.map((part) => String(part?.text || '')).filter(Boolean).join('');
            if (text) {
              enqueueJson({
                choices: [{
                  delta: {
                    content: text,
                  },
                }],
              });
            }
          }
        }

        if (!streamClosed) enqueueDone();
      } catch (error) {
        if (!streamClosed) {
          controller.error(error);
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
};

const callGeminiCompatChat = async ({
  message,
  conversationHistory = [],
  systemPrompt = '',
  temperature = 0.7,
  maxOutputTokens = 8192,
  model,
  googleOptions = {},
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  googleOptions?: Record<string, unknown>;
}) => {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on Edge Function.');
  }

  const modelCandidates = Array.from(new Set(
    [model, DEFAULT_GEMINI_MODEL_FAST, ...GEMINI_DEFAULT_CANDIDATES]
      .map(normalizeGeminiModelName)
      .filter(Boolean),
  ));
  const messages = buildDeepSeekMessages({ message, conversationHistory, systemPrompt });
  const requestBody: Record<string, unknown> = {
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
  };
  const extraBody = buildGeminiCompatExtraBody(googleOptions);
  if (extraBody) requestBody.extra_body = extraBody;

  const request = await postGeminiCompatWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const error = new Error(String(request.errorMessage || 'Gemini compat request failed.'));
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const body = await parseJsonSafe(request.response as Response);
  const text = extractOpenAIText(body);
  if (!text) throw new Error('Gemini compat returned empty content.');

  return {
    provider: 'gemini',
    model: String(request.model || model || DEFAULT_GEMINI_MODEL_FAST),
    text,
    raw: body,
    usage: normalizeGeminiOpenAIUsage(body?.usage as Record<string, unknown> | undefined),
    transport: 'compat',
  };
};

const postGeminiNativeStreamWithModelFallback = async ({
  requestBody,
  modelCandidates = [],
}: {
  requestBody: Record<string, unknown>;
  modelCandidates?: string[];
}) => {
  let retryableFailure: Record<string, unknown> | null = null;

  for (const model of modelCandidates) {
    const t = performance.now();
    const response = await fetch(
      buildGeminiApiUrl({ model, action: 'streamGenerateContent', query: 'alt=sse' }),
      {
        method: 'POST',
        headers: buildGeminiNativeHeaders(),
        body: JSON.stringify(requestBody),
      },
    );
    const elapsed = Math.round(performance.now() - t);

    if (response.ok) {
      console.info(`[ai-proxy] Gemini native stream model=${model} OK in ${elapsed}ms`);
      return { ok: true, response, model };
    }

    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'Unknown error');
    console.warn(`[ai-proxy] Gemini native stream model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    const failure = { ok: false, response, status: response.status, model, errorData, errorMessage };

    if (!isModelLookupError(response.status, errorMessage)) {
      return failure;
    }
    retryableFailure = failure;
  }

  return retryableFailure || {
    ok: false,
    response: null,
    status: 0,
    model: DEFAULT_GEMINI_MODEL_ADVANCED,
    errorData: {},
    errorMessage: 'No Gemini native stream model candidates are available for this request.',
  };
};

const buildGeminiNativeRequestPlan = async ({
  payload,
  authContext,
}: {
  payload: Record<string, unknown>;
  authContext: AuthContext;
}) => {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on Edge Function.');
  }

  const nativeCapabilities = payload?.nativeCapabilities && typeof payload.nativeCapabilities === 'object'
    ? payload.nativeCapabilities as Record<string, unknown>
    : {};
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const model = normalizeGeminiModelName(payload?.model) || DEFAULT_GEMINI_MODEL_ADVANCED;
  const modelCandidates = Array.from(new Set(
    [model, DEFAULT_GEMINI_MODEL_ADVANCED, DEFAULT_GEMINI_MODEL_FAST, DEFAULT_GEMINI_MODEL_LIGHT, ...GEMINI_DEFAULT_CANDIDATES]
      .map(normalizeGeminiModelName)
      .filter(Boolean),
  ));
  const prompt = String(payload?.prompt || payload?.message || '').trim();
  const systemInstruction = String(payload?.systemInstruction || payload?.systemPrompt || '').trim();
  const baseContents = buildGeminiNativeConversationContents({
    prompt,
    message: prompt,
    conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    contents: Array.isArray(payload?.contents) ? payload.contents : [],
  });
  const generationConfig: Record<string, unknown> = {
    temperature: toFiniteNumber(payload?.temperature, 0.15),
    maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096))),
  };
  if (typeof payload?.responseMimeType === 'string' && payload.responseMimeType.trim()) {
    generationConfig.responseMimeType = payload.responseMimeType.trim();
  }
  if (payload?.responseSchema && typeof payload.responseSchema === 'object' && !Array.isArray(payload.responseSchema)) {
    generationConfig.responseSchema = payload.responseSchema;
  }
  if (nativeCapabilities?.generationConfig && typeof nativeCapabilities.generationConfig === 'object') {
    Object.assign(generationConfig, nativeCapabilities.generationConfig as Record<string, unknown>);
  }
  if (payload?.thinkingConfig && typeof payload.thinkingConfig === 'object') {
    generationConfig.thinkingConfig = payload.thinkingConfig;
  }
  if (nativeCapabilities?.thinkingConfig && typeof nativeCapabilities.thinkingConfig === 'object') {
    generationConfig.thinkingConfig = nativeCapabilities.thinkingConfig;
  }

  const tools = buildGeminiNativeToolDeclarations({
    googleTools: Array.isArray(nativeCapabilities?.googleTools) ? nativeCapabilities.googleTools : [],
    customTools: Array.isArray(nativeCapabilities?.customTools)
      ? nativeCapabilities.customTools
      : (Array.isArray(payload?.tools) ? payload.tools : []),
  });
  const toolConfig: Record<string, unknown> = nativeCapabilities?.toolConfig && typeof nativeCapabilities.toolConfig === 'object'
    ? { ...(nativeCapabilities.toolConfig as Record<string, unknown>) }
    : {};
  if (Array.isArray(nativeCapabilities?.googleTools) && nativeCapabilities.googleTools.length > 0 && toolConfig.includeServerSideToolInvocations == null) {
    toolConfig.includeServerSideToolInvocations = true;
  }

  const { parts: fileParts, fileFingerprints, uploadEvents } = await resolveGeminiNativeFileParts({
    authContext,
    nativeCapabilities,
    attachments,
  });

  let cacheName = String(nativeCapabilities?.cacheRef || nativeCapabilities?.cachedContent || '').trim();
  let cacheStatus = cacheName ? 'provided' : 'bypass';
  if (!cacheName && fileParts.length > 0 && authContext.userId && (nativeCapabilities?.autoCache !== false)) {
    const cacheKey = await buildGeminiProviderCacheKey({
      userId: authContext.userId,
      model,
      systemInstruction,
      toolSignature: {
        tools,
        toolConfig,
      },
      fileFingerprints,
    });
    const existing = await lookupGeminiProviderCache({
      userId: authContext.userId,
      modelName: model,
      cacheKey,
    });
    if (existing?.provider_cache_name) {
      cacheName = String(existing.provider_cache_name);
      cacheStatus = 'hit';
    } else {
      const created = await createGeminiCachedContent({
        model,
        systemInstruction,
        tools,
        contents: [{ role: 'user', parts: fileParts }],
        displayName: String(nativeCapabilities?.cacheDisplayName || `gemini-cache-${cacheKey.slice(0, 12)}`),
        ttl: String(nativeCapabilities?.cacheTtl || '86400s'),
      });
      cacheName = created.name;
      cacheStatus = 'created';
      await upsertGeminiProviderCache({
        user_id: authContext.userId,
        provider: 'gemini',
        model_name: model,
        cache_key: cacheKey,
        provider_cache_name: created.name,
        expire_at: created.expireTime || new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
        metadata_json: {
          usageMetadata: created.usageMetadata,
          fileFingerprints,
          toolConfig,
        },
        updated_at: new Date().toISOString(),
      });
    }
  }

  const requestBody: Record<string, unknown> = {
    generationConfig,
  };
  if (Array.isArray(payload?.safetySettings)) {
    requestBody.safetySettings = payload.safetySettings;
  }
  if (nativeCapabilities?.retrievalConfig && typeof nativeCapabilities.retrievalConfig === 'object') {
    requestBody.toolConfig = {
      ...toolConfig,
      retrievalConfig: nativeCapabilities.retrievalConfig,
    };
  } else if (Object.keys(toolConfig).length > 0) {
    requestBody.toolConfig = toolConfig;
  }

  const mergedContents = baseContents.length > 0
    ? [...baseContents]
    : [];

  if (cacheName) {
    requestBody.cachedContent = cacheName;
  } else {
    if (fileParts.length > 0) {
      if (mergedContents.length > 0 && String(mergedContents[0]?.role || '').trim().toLowerCase() === 'user') {
        const first = mergedContents[0];
        const existingParts = Array.isArray(first?.parts) ? first.parts as Array<Record<string, unknown>> : [];
        mergedContents[0] = {
          ...first,
          parts: [...fileParts, ...existingParts],
        };
      } else {
        mergedContents.unshift({ role: 'user', parts: fileParts });
      }
    }
    if (systemInstruction) {
      requestBody.systemInstruction = buildGeminiNativeSystemInstruction(systemInstruction);
    }
    if (tools.length > 0) {
      requestBody.tools = tools;
    }
  }

  if (mergedContents.length > 0) {
    requestBody.contents = mergedContents;
  }

  if (!cacheName && (!Array.isArray(requestBody.contents) || requestBody.contents.length === 0)) {
    throw new Error('Gemini native request requires contents or a valid cachedContent reference.');
  }

  return {
    model,
    modelCandidates,
    requestBody,
    nativeToolSet: (Array.isArray(nativeCapabilities?.googleTools) ? nativeCapabilities.googleTools : [])
      .map((entry) => String((typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.type || (entry as Record<string, unknown>)?.name || '')).trim())
      .filter(Boolean),
    uploadEvents,
    cacheStatus,
    transport: 'native',
  };
};

const callGeminiNative = async ({
  payload,
  authContext,
}: {
  payload: Record<string, unknown>;
  authContext: AuthContext;
}) => {
  const plan = await buildGeminiNativeRequestPlan({ payload, authContext });
  const request = await postGeminiWithModelFallback({
    requestBody: plan.requestBody,
    modelCandidates: plan.modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const error = new Error(String(request.errorMessage || 'Gemini native request failed.'));
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const body = await parseJsonSafe(request.response as Response);
  return {
    provider: 'gemini',
    model: String(request.model || plan.model),
    text: extractGeminiNativeText(body),
    raw: body,
    usage: normalizeGeminiNativeUsage(body?.usageMetadata as Record<string, unknown> | undefined),
    transport: 'native',
    nativeToolSet: plan.nativeToolSet,
    uploadEvents: plan.uploadEvents,
    cacheStatus: plan.cacheStatus,
  };
};

const callOpenAIChat = async ({
  message,
  conversationHistory = [],
  systemPrompt = '',
  temperature = 0.7,
  maxOutputTokens = 8192,
  model,
  jsonMode = false,
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  jsonMode?: boolean;
}) => {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on Edge Function.');
  }

  const modelCandidates = Array.from(new Set(
    [model, ...OPENAI_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  // Build messages array (OpenAI format: system + user/assistant)
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() });
  }
  const historyWindow = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
  for (const entry of historyWindow) {
    const row = entry as { role?: unknown; content?: unknown };
    const content = typeof row?.content === 'string' ? row.content.trim() : '';
    if (!content) continue;
    messages.push({ role: normalizeChatRole(row.role), content });
  }
  messages.push({ role: 'user', content: String(message || '').trim() });

  const request = await postOpenAIWithModelFallback({
    requestBody: {
      messages,
      temperature,
      max_completion_tokens: maxOutputTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    const messageText = String(request.errorMessage || 'OpenAI request failed.');
    const error = new Error(messageText);
    (error as Error & { status?: number }).status = status;
    throw error;
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);
  const text = extractOpenAIText(body);
  if (!text) {
    throw new Error('OpenAI returned empty content.');
  }

  return {
    provider: 'openai',
    model: String(request.model || model || DEFAULT_OPENAI_MODEL),
    text,
    raw: body,
    usage: body?.usage || null,
  };
};

// ── Mode handlers ─────────────────────────────────────────────────────────

const handleGeminiGenerate = async (payload: Record<string, unknown>, authContext: AuthContext) => {
  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) return jsonResponse({ error: 'Missing required field: prompt' }, 400);

  const systemContext = String(payload?.systemContext || '');
  const options = (payload?.options as Record<string, unknown>) || {};
  const result = await callGeminiNative({
    payload: {
      prompt,
      systemInstruction: systemContext,
      model: String(options?.model || payload?.model || DEFAULT_GEMINI_MODEL_ADVANCED),
      temperature: toFiniteNumber(options?.temperature, 0.7),
      maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(options?.maxOutputTokens, 8192))),
      responseMimeType: String(options?.responseMimeType || payload?.responseMimeType || 'text/plain'),
      responseSchema: options?.responseSchema || payload?.responseSchema || null,
      nativeCapabilities: (options?.nativeCapabilities && typeof options.nativeCapabilities === 'object')
        ? options.nativeCapabilities
        : payload?.nativeCapabilities,
      attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
      conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    },
    authContext,
  });

  return jsonResponse({
    ok: true,
    ...result,
  });
};

const handleGeminiChat = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);

  const result = await callGeminiCompatChat({
    message,
    conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    systemPrompt: String(payload?.systemPrompt || ''),
    temperature: toFiniteNumber(payload?.temperature, 0.7),
    maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192))),
    model: String(payload?.model || DEFAULT_GEMINI_MODEL_FAST),
    googleOptions: payload?.googleOptions && typeof payload.googleOptions === 'object'
      ? payload.googleOptions as Record<string, unknown>
      : {},
  });

  return jsonResponse({ ok: true, ...result });
};

const handleGeminiChatTools = async (payload: Record<string, unknown>) => {
  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: 'GEMINI_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400);
  }

  const model = normalizeGeminiModelName(payload?.model) || DEFAULT_GEMINI_MODEL_FAST;
  const temperature = toFiniteNumber(payload?.temperature, 0.3);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));
  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const modelCandidates = Array.from(new Set(
    [model, DEFAULT_GEMINI_MODEL_FAST, DEFAULT_GEMINI_MODEL_ADVANCED, ...GEMINI_DEFAULT_CANDIDATES]
      .map(normalizeGeminiModelName)
      .filter(Boolean),
  ));

  const requestBody: Record<string, unknown> = {
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice);
  }
  const extraBody = buildGeminiCompatExtraBody(
    payload?.googleOptions && typeof payload.googleOptions === 'object'
      ? payload.googleOptions as Record<string, unknown>
      : {},
  );
  if (extraBody) requestBody.extra_body = extraBody;

  const request = await postGeminiCompatWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    return jsonResponse(
      { error: String(request.errorMessage || 'Gemini compat tool-calling request failed.'), code: 'gemini_tools_failed' },
      status >= 400 && status < 600 ? status : 500,
    );
  }

  const body = await parseJsonSafe(request.response as Response);
  return jsonResponse({
    ok: true,
    provider: 'gemini',
    model: String(request.model || model),
    transport: 'compat',
    ...body,
    usage: normalizeGeminiOpenAIUsage(body?.usage as Record<string, unknown> | undefined),
  });
};

const handleGeminiChatToolsStream = async (payload: Record<string, unknown>, cors: Record<string, string>) => {
  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: 'GEMINI_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500, cors);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400, cors);
  }

  const model = normalizeGeminiModelName(payload?.model) || DEFAULT_GEMINI_MODEL_FAST;
  const temperature = toFiniteNumber(payload?.temperature, 0.3);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));
  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const modelCandidates = Array.from(new Set(
    [model, DEFAULT_GEMINI_MODEL_FAST, DEFAULT_GEMINI_MODEL_ADVANCED, ...GEMINI_DEFAULT_CANDIDATES]
      .map(normalizeGeminiModelName)
      .filter(Boolean),
  ));

  const requestBody: Record<string, unknown> = {
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice);
  }
  const extraBody = buildGeminiCompatExtraBody(
    payload?.googleOptions && typeof payload.googleOptions === 'object'
      ? payload.googleOptions as Record<string, unknown>
      : {},
  );
  if (extraBody) requestBody.extra_body = extraBody;

  const request = await postGeminiCompatWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    return jsonResponse(
      { error: String(request.errorMessage || 'Gemini compat stream request failed.'), code: 'gemini_stream_failed' },
      status >= 400 && status < 600 ? status : 500,
      cors,
    );
  }

  return new Response((request.response as Response).body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};

const handleGeminiNative = async (
  payload: Record<string, unknown>,
  cors: Record<string, string>,
  authContext: AuthContext,
) => {
  if (Boolean(payload?.stream)) {
    const plan = await buildGeminiNativeRequestPlan({ payload, authContext });
    const request = await postGeminiNativeStreamWithModelFallback({
      requestBody: plan.requestBody,
      modelCandidates: plan.modelCandidates,
    }) as Record<string, unknown>;

    if (!request.ok) {
      const status = Number(request.status || 500);
      return jsonResponse(
        { error: String(request.errorMessage || 'Gemini native stream request failed.'), code: 'gemini_native_stream_failed' },
        status >= 400 && status < 600 ? status : 500,
        cors,
      );
    }

    return new Response(createGeminiNativeTextSseStream((request.response as Response).body!), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const result = await callGeminiNative({ payload, authContext });
  return jsonResponse({ ok: true, ...result });
};

const handleDeepSeekChat = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);

  const result = await callDeepSeekChat({
    message,
    conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    systemPrompt: String(payload?.systemPrompt || ''),
    temperature: toFiniteNumber(payload?.temperature, 0.7),
    maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192))),
    model: String(payload?.model || DEFAULT_DEEPSEEK_MODEL),
  });

  return jsonResponse({
    ok: true,
    ...result,
  });
};

const handleDeepSeekChatTools = async (payload: Record<string, unknown>) => {
  if (!DEEPSEEK_API_KEY) {
    return jsonResponse({ error: 'DEEPSEEK_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const model = String(payload?.model || DEFAULT_DEEPSEEK_MODEL).trim();
  const temperature = toFiniteNumber(payload?.temperature, 0.3);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));
  const thinkingEnabled = Boolean(payload?.thinking);
  const responseFormat = (payload?.response_format && typeof payload.response_format === 'object')
    ? payload.response_format : undefined;

  const modelCandidates = Array.from(new Set(
    [model, ...DEEPSEEK_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  let requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxOutputTokens,
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice);
  }
  if (responseFormat) {
    requestBody.response_format = responseFormat;
  }
  if (thinkingEnabled) {
    requestBody.thinking = { type: 'enabled' };
  }

  // Optional parameters — only include if explicitly provided
  if (typeof payload?.frequency_penalty === 'number') requestBody.frequency_penalty = payload.frequency_penalty;
  if (typeof payload?.presence_penalty === 'number') requestBody.presence_penalty = payload.presence_penalty;
  if (typeof payload?.top_p === 'number') requestBody.top_p = payload.top_p;
  if (payload?.stop !== undefined) requestBody.stop = payload.stop;
  if (typeof payload?.logprobs === 'boolean') requestBody.logprobs = payload.logprobs;
  if (typeof payload?.top_logprobs === 'number') requestBody.top_logprobs = payload.top_logprobs;

  // Sanitize params for reasoning mode
  requestBody = sanitizeDeepSeekParams(requestBody, model, thinkingEnabled);

  const request = await postDeepSeekWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    return jsonResponse(
      { error: String(request.errorMessage || 'DeepSeek tool-calling request failed.'), code: 'deepseek_tools_failed' },
      status >= 400 && status < 600 ? status : 500,
    );
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);

  // Extract cache metrics from usage
  const usage = body?.usage as Record<string, unknown> | undefined;
  const cacheInfo = usage ? {
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
  } : {};

  // Return full OpenAI-format response so the client can handle tool_calls
  return jsonResponse({
    ok: true,
    provider: 'deepseek',
    model: String(request.model || model),
    ...body,
    ...cacheInfo,
  });
};

// ── DeepSeek: Streaming Tool-Calling ────────────────────────────────────────

/**
 * Strip parameters that DeepSeek rejects when thinking/reasoning mode is active.
 * deepseek-reasoner ignores temperature/top_p and rejects logprobs/top_logprobs.
 */
const sanitizeDeepSeekParams = (
  body: Record<string, unknown>,
  model: string,
  thinkingEnabled: boolean,
): Record<string, unknown> => {
  const isReasoner = /deepseek-reasoner/i.test(model) || thinkingEnabled;
  if (!isReasoner) return body;
  const cleaned = { ...body };
  delete cleaned.temperature;
  delete cleaned.top_p;
  delete cleaned.frequency_penalty;
  delete cleaned.presence_penalty;
  delete cleaned.logprobs;
  delete cleaned.top_logprobs;
  return cleaned;
};

const handleDeepSeekChatToolsStream = async (payload: Record<string, unknown>, cors: Record<string, string>) => {
  if (!DEEPSEEK_API_KEY) {
    return jsonResponse({ error: 'DEEPSEEK_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500, cors);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400, cors);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const model = String(payload?.model || DEFAULT_DEEPSEEK_MODEL).trim();
  const temperature = toFiniteNumber(payload?.temperature, 0.3);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));
  const thinkingEnabled = Boolean(payload?.thinking);
  const responseFormat = (payload?.response_format && typeof payload.response_format === 'object')
    ? payload.response_format : undefined;

  let requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice);
  }
  if (responseFormat) {
    requestBody.response_format = responseFormat;
  }
  if (thinkingEnabled) {
    requestBody.thinking = { type: 'enabled' };
  }

  // Optional parameters — only include if explicitly provided
  if (typeof payload?.frequency_penalty === 'number') requestBody.frequency_penalty = payload.frequency_penalty;
  if (typeof payload?.presence_penalty === 'number') requestBody.presence_penalty = payload.presence_penalty;
  if (typeof payload?.top_p === 'number') requestBody.top_p = payload.top_p;
  if (payload?.stop !== undefined) requestBody.stop = payload.stop;
  if (typeof payload?.logprobs === 'boolean') requestBody.logprobs = payload.logprobs;
  if (typeof payload?.top_logprobs === 'number') requestBody.top_logprobs = payload.top_logprobs;

  // Sanitize params for reasoning mode
  requestBody = sanitizeDeepSeekParams(requestBody, model, thinkingEnabled);

  const t = performance.now();
  let response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });
  let elapsed = Math.round(performance.now() - t);

  // Fallback: if model not found, retry with first candidate
  if (!response.ok && (response.status === 404 || response.status === 400)) {
    const fallbackModel = DEEPSEEK_DEFAULT_CANDIDATES.find((c) => c !== model);
    if (fallbackModel) {
      console.warn(`[ai-proxy] DeepSeek stream model=${model} failed (${response.status}), retrying with ${fallbackModel}`);
      requestBody.model = fallbackModel;
      const t2 = performance.now();
      response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });
      elapsed = Math.round(performance.now() - t2);
    }
  }

  if (!response.ok) {
    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'DeepSeek stream request failed');
    console.warn(`[ai-proxy] DeepSeek stream model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    return jsonResponse({ error: errorMessage, code: 'deepseek_stream_failed' }, response.status >= 400 && response.status < 600 ? response.status : 500, cors);
  }

  console.info(`[ai-proxy] DeepSeek stream model=${model} connected in ${elapsed}ms`);

  // Pass through the SSE stream with CORS headers
  return new Response(response.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};

const handleAiChat = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);
  const conversationHistory = Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [];
  const systemPrompt = String(payload?.systemPrompt || '');
  const temperature = toFiniteNumber(payload?.temperature, 0.7);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192)));
  const requestedModel = String(payload?.model || '').trim();

  if (!DEEPSEEK_API_KEY) {
    return jsonResponse(
      {
        error: 'DEEPSEEK_API_KEY is not configured on server.',
        code: 'missing_server_keys',
        details: 'Set DEEPSEEK_API_KEY in Edge Function secrets.',
      },
      500,
    );
  }

  try {
    const result = await callDeepSeekChat({
      message,
      conversationHistory,
      systemPrompt,
      temperature,
      maxOutputTokens,
      model: requestedModel || DEFAULT_DEEPSEEK_MODEL,
    });
    return jsonResponse({
      ok: true,
      ...result,
    });
  } catch (error) {
    const status = Number((error as Error & { status?: number })?.status || 500);
    const messageText = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        error: messageText,
        code: 'deepseek_chat_failed',
        details: 'DeepSeek request failed. Gemini fallback is disabled.',
      },
      status >= 400 && status < 600 ? status : 500,
    );
  }
};

const handleAnthropicChat = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);

  const result = await callAnthropicChat({
    message,
    conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    systemPrompt: String(payload?.systemPrompt || ''),
    temperature: toFiniteNumber(payload?.temperature, 0.7),
    maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192))),
    model: String(payload?.model || DEFAULT_ANTHROPIC_MODEL),
  });

  return jsonResponse({ ok: true, ...result });
};

const handleKimiChat = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);

  const result = await callKimiChat({
    message,
    conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    systemPrompt: String(payload?.systemPrompt || ''),
    temperature: toFiniteNumber(payload?.temperature, 0.7),
    maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192))),
    model: String(payload?.model || DEFAULT_KIMI_MODEL),
  });

  return jsonResponse({ ok: true, ...result });
};

// ── OpenAI Responses API (for reasoning models like gpt-5.4) ──────────────
const handleOpenAIResponses = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);
  if (!OPENAI_API_KEY) return jsonResponse({ error: 'OPENAI_API_KEY is not configured.' }, 500);

  const model = String(payload?.model || 'gpt-5.4').trim();
  const systemPrompt = String(payload?.systemPrompt || '').trim();
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192)));
  const reasoningEffort = String(payload?.reasoningEffort || 'medium').trim();

  const requestBody: Record<string, unknown> = {
    model,
    instructions: systemPrompt,
    input: message,
    text: { format: { type: 'text' } },
    max_output_tokens: maxOutputTokens,
  };

  // Only add reasoning config for reasoning-capable models
  if (['high', 'medium', 'low'].includes(reasoningEffort)) {
    requestBody.reasoning = { effort: reasoningEffort, summary: 'auto' };
  }

  const t = performance.now();
  const response = await fetch(`${OPENAI_BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });
  const elapsed = Math.round(performance.now() - t);

  if (!response.ok) {
    const errorData = await response.text().catch(() => '');
    console.warn(`[ai-proxy] OpenAI Responses API failed (${response.status}) in ${elapsed}ms: ${errorData.slice(0, 300)}`);
    return jsonResponse({ error: `OpenAI Responses API error: ${response.status}`, details: errorData.slice(0, 500) }, response.status);
  }

  const data = await response.json() as Record<string, unknown>;
  console.info(`[ai-proxy] OpenAI Responses API model=${model} effort=${reasoningEffort} OK in ${elapsed}ms`);

  // Extract text from output items
  let text = '';
  let reasoningText = '';
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const itemObj = item as Record<string, unknown>;
    if (itemObj.type === 'reasoning') {
      const summaries = Array.isArray(itemObj.summary) ? itemObj.summary : [];
      for (const s of summaries) {
        const sObj = s as Record<string, unknown>;
        if (sObj.type === 'summary_text' && typeof sObj.text === 'string') {
          reasoningText += sObj.text + '\n';
        }
      }
    }
    if (itemObj.type === 'message') {
      const content = Array.isArray(itemObj.content) ? itemObj.content : [];
      for (const c of content) {
        const cObj = c as Record<string, unknown>;
        if (cObj.type === 'output_text' && typeof cObj.text === 'string') {
          text = cObj.text;
        }
      }
    }
  }

  if (!text && typeof data?.output_text === 'string') {
    text = data.output_text;
  }

  return jsonResponse({
    ok: true,
    provider: 'openai',
    model,
    text,
    reasoning: reasoningText.trim() || null,
    raw: data,
    usage: data?.usage || null,
  });
};

const handleOpenAIChat = async (payload: Record<string, unknown>) => {
  const message = String(payload?.message || '').trim();
  if (!message) return jsonResponse({ error: 'Missing required field: message' }, 400);

  const result = await callOpenAIChat({
    message,
    conversationHistory: Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [],
    systemPrompt: String(payload?.systemPrompt || ''),
    temperature: toFiniteNumber(payload?.temperature, 0.7),
    maxOutputTokens: Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 8192))),
    model: String(payload?.model || DEFAULT_OPENAI_MODEL),
  });

  return jsonResponse({ ok: true, ...result });
};

const handleAnthropicChatTools = async (payload: Record<string, unknown>) => {
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'ANTHROPIC_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const model = String(payload?.model || DEFAULT_ANTHROPIC_MODEL).trim();
  const temperature = Math.max(0, Math.min(1, toFiniteNumber(payload?.temperature, 0.3)));
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  const modelCandidates = Array.from(new Set(
    [model, ...ANTHROPIC_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  const converted = buildAnthropicMessagesFromOpenAIMessages(messages);
  const anthropicTools = buildAnthropicToolsFromOpenAITools(tools);

  const requestBody: Record<string, unknown> = {
    temperature,
    max_tokens: maxOutputTokens,
    messages: converted.messages,
  };
  if (converted.system) {
    requestBody.system = converted.system;
  }
  if (anthropicTools.length > 0) {
    requestBody.tools = anthropicTools;
    requestBody.tool_choice = buildAnthropicToolChoice(payload?.toolChoice);
  }

  const request = await postAnthropicWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    return jsonResponse(
      { error: String(request.errorMessage || 'Anthropic tool-calling request failed.'), code: 'anthropic_tools_failed' },
      status >= 400 && status < 600 ? status : 500,
    );
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);
  const openAiShape = convertAnthropicResponseToOpenAIFormat({
    body,
    model: String(request.model || model),
  });

  return jsonResponse({
    ok: true,
    provider: 'anthropic',
    model: String(request.model || model),
    ...openAiShape,
  });
};

const handleAnthropicChatToolsStream = async (payload: Record<string, unknown>, cors: Record<string, string>) => {
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'ANTHROPIC_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500, cors);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400, cors);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const model = String(payload?.model || DEFAULT_ANTHROPIC_MODEL).trim();
  const temperature = Math.max(0, Math.min(1, toFiniteNumber(payload?.temperature, 0.3)));
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  const modelCandidates = Array.from(new Set(
    [model, ...ANTHROPIC_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  const converted = buildAnthropicMessagesFromOpenAIMessages(messages);
  const anthropicTools = buildAnthropicToolsFromOpenAITools(tools);

  const requestBody: Record<string, unknown> = {
    temperature,
    max_tokens: maxOutputTokens,
    messages: converted.messages,
    stream: true,
  };
  if (converted.system) {
    requestBody.system = converted.system;
  }
  if (anthropicTools.length > 0) {
    requestBody.tools = anthropicTools;
    requestBody.tool_choice = buildAnthropicToolChoice(payload?.toolChoice);
  }

  const t = performance.now();
  const request = await postAnthropicWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;
  const elapsed = Math.round(performance.now() - t);

  if (!request.ok) {
    const status = Number(request.status || 500);
    console.warn(`[ai-proxy] Anthropic stream model=${model} failed (${status}) in ${elapsed}ms: ${String(request.errorMessage || 'Unknown error')}`);
    return jsonResponse(
      { error: String(request.errorMessage || 'Anthropic stream request failed.'), code: 'anthropic_stream_failed' },
      status >= 400 && status < 600 ? status : 500,
      cors,
    );
  }

  const response = request.response as Response;
  console.info(`[ai-proxy] Anthropic stream model=${String(request.model || model)} connected in ${elapsed}ms`);

  return new Response(createAnthropicOpenAICompatibleSseStream(response.body!), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};

const handleKimiChatTools = async (payload: Record<string, unknown>) => {
  if (!KIMI_API_KEY) {
    return jsonResponse({ error: 'KIMI_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const model = String(payload?.model || DEFAULT_KIMI_MODEL).trim();
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  const modelCandidates = Array.from(new Set(
    [model, ...KIMI_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  // kimi-k2.5 and thinking models reject custom temperature/top_p
  const requestBody: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxOutputTokens,
  };
  if (!isKimiFixedTempModel(model)) {
    requestBody.temperature = toFiniteNumber(payload?.temperature, 0.3);
  }
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice, {
      provider: 'kimi',
      thinkingEnabled: true,
    });
  }

  const request = await postKimiWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    return jsonResponse(
      { error: String(request.errorMessage || 'Kimi tool-calling request failed.'), code: 'kimi_tools_failed' },
      status >= 400 && status < 600 ? status : 500,
    );
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);

  return jsonResponse({
    ok: true,
    provider: 'kimi',
    model: String(request.model || model),
    ...body,
  });
};

const handleOpenAIChatTools = async (payload: Record<string, unknown>) => {
  if (!OPENAI_API_KEY) {
    return jsonResponse({ error: 'OPENAI_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const model = String(payload?.model || DEFAULT_OPENAI_MODEL).trim();
  const temperature = toFiniteNumber(payload?.temperature, 0.3);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  const modelCandidates = Array.from(new Set(
    [model, ...OPENAI_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice);
  }

  const request = await postOpenAIWithModelFallback({
    requestBody,
    modelCandidates,
  }) as Record<string, unknown>;

  if (!request.ok) {
    const status = Number(request.status || 500);
    return jsonResponse(
      { error: String(request.errorMessage || 'OpenAI tool-calling request failed.'), code: 'openai_tools_failed' },
      status >= 400 && status < 600 ? status : 500,
    );
  }

  const response = request.response as Response;
  const body = await parseJsonSafe(response);

  return jsonResponse({
    ok: true,
    provider: 'openai',
    model: String(request.model || model),
    ...body,
  });
};

const handleOpenAIChatToolsStream = async (payload: Record<string, unknown>, cors: Record<string, string>) => {
  if (!OPENAI_API_KEY) {
    return jsonResponse({ error: 'OPENAI_API_KEY is not configured on Edge Function.', code: 'missing_server_keys' }, 500, cors);
  }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing required field: messages (array)' }, 400, cors);
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : undefined;
  const model = String(payload?.model || DEFAULT_OPENAI_MODEL).trim();
  const temperature = toFiniteNumber(payload?.temperature, 0.3);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = buildOpenAiStyleToolChoice(payload?.toolChoice);
  }

  const t = performance.now();
  const response = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });
  const elapsed = Math.round(performance.now() - t);

  if (!response.ok) {
    const errorData = await parseJsonSafe(response);
    const errorMessage = String((errorData?.error as { message?: string })?.message || 'OpenAI stream request failed');
    console.warn(`[ai-proxy] OpenAI stream model=${model} failed (${response.status}) in ${elapsed}ms: ${errorMessage}`);
    return jsonResponse({ error: errorMessage, code: 'openai_stream_failed' }, response.status >= 400 && response.status < 600 ? response.status : 500, cors);
  }

  console.info(`[ai-proxy] OpenAI stream model=${model} connected in ${elapsed}ms`);

  // Pass through the SSE stream with CORS headers
  return new Response(response.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};

const handleDiPrompt = async (payload: Record<string, unknown>, authContext: AuthContext) => {
  const provider = String(payload?.provider || '').trim().toLowerCase();
  const prompt = String(payload?.prompt || '').trim();
  if (!provider) return jsonResponse({ error: 'Missing required field: provider' }, 400);
  if (!prompt) return jsonResponse({ error: 'Missing required field: prompt' }, 400);

  const model = String(payload?.model || '').trim();
  const temperature = toFiniteNumber(payload?.temperature, 0.15);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  if (provider === 'gemini') {
    const result = await callGeminiNative({
      payload: {
        prompt,
        model: model || DEFAULT_GEMINI_MODEL_ADVANCED,
        temperature,
        maxOutputTokens,
        responseMimeType: String(payload?.responseMimeType || 'application/json'),
        responseSchema: payload?.responseSchema,
        thinkingConfig: payload?.thinkingConfig,
        nativeCapabilities: payload?.nativeCapabilities,
        attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
      },
      authContext,
    });
    return jsonResponse({
      ok: true,
      provider: 'gemini',
      model: result.model,
      text: result.text,
      usage: result.usage,
      transport: result.transport,
      nativeToolSet: result.nativeToolSet,
      uploadEvents: result.uploadEvents,
      cacheStatus: result.cacheStatus,
    });
  }

  if (provider === 'deepseek') {
    if (!DEEPSEEK_API_KEY) {
      return jsonResponse({ error: 'DEEPSEEK_API_KEY is not configured on Edge Function.' }, 500);
    }
    const thinkingEnabled = Boolean(payload?.thinking);
    const resolvedModel = model || DEFAULT_DEEPSEEK_MODEL;
    const isJsonMode = String(payload?.responseMimeType || '').includes('json');

    let dsRequestBody: Record<string, unknown> = {
      model: resolvedModel,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxOutputTokens,
    };
    if (isJsonMode) {
      dsRequestBody.response_format = { type: 'json_object' };
    }
    if (thinkingEnabled) {
      dsRequestBody.thinking = { type: 'enabled' };
    }
    dsRequestBody = sanitizeDeepSeekParams(dsRequestBody, resolvedModel, thinkingEnabled);

    const request = await postDeepSeekWithModelFallback({
      requestBody: dsRequestBody,
      modelCandidates: Array.from(new Set([resolvedModel, ...DEEPSEEK_DEFAULT_CANDIDATES].map((item) => String(item || '').trim()).filter(Boolean))),
    }) as Record<string, unknown>;

    if (!request.ok) {
      return jsonResponse(
        {
          error: String(request.errorMessage || 'DeepSeek request failed.'),
          status: Number(request.status || 500),
        },
        Number(request.status || 500),
      );
    }
    const response = request.response as Response;
    const body = await parseJsonSafe(response);
    const text = extractDeepSeekText(body);
    const reasoningContent = extractDeepSeekReasoningContent(body);
    if (!text) return jsonResponse({ error: 'DeepSeek returned empty content.' }, 500);

    const dsUsage = body?.usage as Record<string, unknown> | undefined;
    return jsonResponse({
      ok: true,
      provider: 'deepseek',
      model: String(request.model || resolvedModel),
      text,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(dsUsage ? {
        prompt_cache_hit_tokens: dsUsage.prompt_cache_hit_tokens ?? 0,
        prompt_cache_miss_tokens: dsUsage.prompt_cache_miss_tokens ?? 0,
      } : {}),
    });
  }

  const isJsonMode = String(payload?.responseMimeType || '').includes('json');

  if (provider === 'anthropic') {
    if (!ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'ANTHROPIC_API_KEY is not configured on Edge Function.' }, 500);
    }
    const result = await callAnthropicChat({
      message: prompt,
      systemPrompt: '',
      temperature,
      maxOutputTokens,
      model: model || DEFAULT_ANTHROPIC_MODEL,
      jsonMode: isJsonMode,
    });
    return jsonResponse({
      ok: true,
      provider: 'anthropic',
      model: result.model,
      text: result.text,
      usage: result.usage,
    });
  }

  if (provider === 'kimi') {
    if (!KIMI_API_KEY) {
      return jsonResponse({ error: 'KIMI_API_KEY is not configured on Edge Function.' }, 500);
    }
    const result = await callKimiChat({
      message: prompt,
      systemPrompt: '',
      temperature,
      maxOutputTokens,
      model: model || DEFAULT_KIMI_MODEL,
      jsonMode: isJsonMode,
    });
    return jsonResponse({
      ok: true,
      provider: 'kimi',
      model: result.model,
      text: result.text,
      usage: result.usage,
    });
  }

  if (provider === 'openai') {
    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: 'OPENAI_API_KEY is not configured on Edge Function.' }, 500);
    }
    const result = await callOpenAIChat({
      message: prompt,
      systemPrompt: '',
      temperature,
      maxOutputTokens,
      model: model || DEFAULT_OPENAI_MODEL,
      jsonMode: isJsonMode,
    });
    return jsonResponse({
      ok: true,
      provider: 'openai',
      model: result.model,
      text: result.text,
      usage: result.usage,
    });
  }

  return jsonResponse({ error: `Unsupported provider: ${provider}` }, 400);
};

// ── Billing / Usage Query Handlers ──────────────────────────

/**
 * Anthropic billing: uses Admin API to fetch organization usage.
 * Returns credit balance info from the Anthropic Admin API.
 */
const handleAnthropicBilling = async (): Promise<Response> => {
  if (!ANTHROPIC_ADMIN_API_KEY) {
    return jsonResponse({ error: 'ANTHROPIC_ADMIN_API_KEY is not configured.', code: 'missing_admin_key' }, 500);
  }

  const adminHeaders = {
    'x-api-key': ANTHROPIC_ADMIN_API_KEY,
    'anthropic-version': '2023-06-01',
  };

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startAt = thirtyDaysAgo.toISOString().replace(/\.\d+Z$/, 'Z');
    const endAt = now.toISOString().replace(/\.\d+Z$/, 'Z');

    // Fetch usage report (tokens) and cost report in parallel
    const [usageRes, costRes] = await Promise.all([
      fetch(
        `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${startAt}&ending_at=${endAt}&bucket_width=1d&limit=31`,
        { headers: adminHeaders },
      ),
      fetch(
        `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startAt}&ending_at=${endAt}&bucket_width=1d&limit=31`,
        { headers: adminHeaders },
      ),
    ]);

    let usageData = null;
    if (usageRes.ok) usageData = await usageRes.json();

    let costData = null;
    if (costRes.ok) costData = await costRes.json();

    // Summarize cost: amount is in cents, convert to USD
    let totalCostCents = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    if (costData?.data) {
      for (const bucket of costData.data) {
        for (const r of (bucket.results || [])) {
          totalCostCents += parseFloat(r.amount || '0');
        }
      }
    }
    if (usageData?.data) {
      for (const bucket of usageData.data) {
        for (const r of (bucket.results || [])) {
          totalInputTokens += (r.uncached_input_tokens || 0) + (r.cache_read_input_tokens || 0);
          totalOutputTokens += (r.output_tokens || 0);
        }
      }
    }

    return jsonResponse({
      provider: 'anthropic',
      total_cost_usd: totalCostCents / 100,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      period_days: 30,
      usage_raw: usageData,
      cost_raw: costData,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message), code: 'anthropic_billing_failed' }, 502);
  }
};

/**
 * OpenAI billing: fetches costs via Admin API.
 * Requires OPENAI_ADMIN_API_KEY (admin key from platform.openai.com/settings/organization/admin-keys).
 */
const handleOpenAIBilling = async (): Promise<Response> => {
  const adminKey = OPENAI_ADMIN_API_KEY || OPENAI_API_KEY;
  if (!adminKey) {
    return jsonResponse({ error: 'OPENAI_API_KEY is not configured.', code: 'missing_key' }, 500);
  }

  const headers = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startTime = Math.floor(thirtyDaysAgo.getTime() / 1000);

    // Fetch costs (last 30 days)
    const costsRes = await fetch(
      `${OPENAI_BASE_URL}/v1/organization/costs?start_time=${startTime}&bucket_width=1d&limit=31`,
      { headers },
    );

    let costsData = null;
    let totalCostCents = 0;
    if (costsRes.ok) {
      costsData = await costsRes.json();
      // Sum up costs from all buckets
      const buckets = costsData?.data || [];
      for (const bucket of buckets) {
        for (const r of (bucket.results || [])) {
          totalCostCents += parseFloat(r.amount?.value || '0');
        }
      }
    }

    // Fetch usage/completions (last 30 days)
    const usageRes = await fetch(
      `${OPENAI_BASE_URL}/v1/organization/usage/completions?start_time=${startTime}&bucket_width=1d&limit=31`,
      { headers },
    );

    let usageData = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalRequests = 0;
    if (usageRes.ok) {
      usageData = await usageRes.json();
      const buckets = usageData?.data || [];
      for (const bucket of buckets) {
        for (const r of (bucket.results || [])) {
          totalInputTokens += (r.input_tokens || 0);
          totalOutputTokens += (r.output_tokens || 0);
          totalRequests += (r.num_model_requests || 0);
        }
      }
    }

    // If both failed, the key is likely not an admin key
    if (!costsRes.ok && !usageRes.ok) {
      return jsonResponse({
        provider: 'openai',
        error: 'OpenAI Admin API not accessible. Set OPENAI_ADMIN_API_KEY (admin key from platform.openai.com/settings/organization/admin-keys).',
        code: 'admin_key_required',
        costs_status: costsRes.status,
        usage_status: usageRes.status,
        fetched_at: new Date().toISOString(),
      });
    }

    return jsonResponse({
      provider: 'openai',
      total_cost_usd: totalCostCents / 100,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      total_requests: totalRequests,
      period_days: 30,
      costs_raw: costsData,
      usage_raw: usageData,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message), code: 'openai_billing_failed' }, 502);
  }
};

// ── Kimi (Moonshot) — Balance API ─────────────────────────────────────────
const handleKimiBilling = async (): Promise<Response> => {
  if (!KIMI_API_KEY) {
    return jsonResponse({ error: 'KIMI_API_KEY is not configured.', code: 'missing_server_keys' }, 500);
  }
  try {
    const res = await fetch(`${KIMI_BASE_URL}/v1/users/me/balance`, {
      headers: { Authorization: `Bearer ${KIMI_API_KEY}` },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return jsonResponse({ error: `Kimi billing API returned ${res.status}: ${errText}`, code: 'kimi_billing_failed' }, 502);
    }
    const json = await res.json();
    const data = json?.data || {};
    return jsonResponse({
      provider: 'kimi',
      balance_usd: data.available_balance ?? null,
      voucher_balance: data.voucher_balance ?? null,
      cash_balance: data.cash_balance ?? null,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message), code: 'kimi_billing_failed' }, 502);
  }
};

Deno.serve(async (req) => {
  const t0 = performance.now();
  const cors = buildCorsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  // Parse body once — used for both ping check and handler dispatch
  let body: ProxyRequestBody;
  try {
    body = await req.json() as ProxyRequestBody;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, cors);
  }

  // Fast ping for warmup — no auth required, just wake the runtime
  if (body?.mode === 'ping') {
    return jsonResponse({ ok: true, mode: 'ping' }, 200, cors);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Supabase environment is not configured on Edge Function.' }, 500, cors);
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'Missing authorization header' }, 401, cors);
  }

  const token = authHeader.replace('Bearer ', '');

  // Allow server-to-server calls:
  // 1. Service role key as bearer token
  // 2. DI_SERVER_API_KEY (shared secret between Python backend and Edge Function)
  // 3. x-di-server header with value 'true' + anon key in both Authorization/apikey
  const serverKey = Deno.env.get('DI_SERVER_API_KEY') || '';
  const isDiServer = req.headers.get('x-di-server') === 'true';
  const apiKeyHeader = String(req.headers.get('apikey') || '').trim();
  const authTokenPayload = parseJwtPayload(token);
  const authTokenRole = String(authTokenPayload?.role || '').trim().toLowerCase();
  const isLegacyServiceRoleJwt = Boolean(
    authTokenRole === 'service_role'
    && token
    && apiKeyHeader
    && apiKeyHeader === token,
  );
  const isDiServerHeaderAuth = Boolean(
    isDiServer
    && SUPABASE_ANON_KEY
    && token
    && apiKeyHeader
    && apiKeyHeader === token
    && apiKeyHeader === SUPABASE_ANON_KEY,
  );
  const isServerCall = (token === SUPABASE_SERVICE_ROLE_KEY) ||
                       (serverKey && token === serverKey) ||
                       isLegacyServiceRoleJwt ||
                       isDiServerHeaderAuth;

  let authMs = 0;
  let authContext: AuthContext = {
    userId: null,
    isServerCall,
  };
  if (!isServerCall) {
    // Standard user auth via Supabase JWT
    const supabase = createServiceRoleSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    authMs = Math.round(performance.now() - t0);
    if (authError || !user) {
      console.warn(`[ai-proxy] auth failed in ${authMs}ms`);
      return jsonResponse({ error: 'Unauthorized', details: authError?.message || null }, 401, cors);
    }
    authContext = {
      userId: user.id,
      isServerCall: false,
    };
  } else {
    authMs = Math.round(performance.now() - t0);
    console.log(`[ai-proxy] server-to-server call authenticated in ${authMs}ms`);
  }

  try {
    const mode = body?.mode;
    const payload = (body?.payload || {}) as Record<string, unknown>;

    if (!mode) return jsonResponse({ error: 'Missing required field: mode' }, 400, cors);

    console.info(`[ai-proxy] mode=${mode} auth=${authMs}ms`);

    // Handlers return jsonResponse internally; wrap to ensure CORS headers
    const wrapCors = (response: Response) => {
      Object.entries(cors).forEach(([key, value]) => response.headers.set(key, value));
      console.info(`[ai-proxy] mode=${mode} total=${Math.round(performance.now() - t0)}ms`);
      return response;
    };

    // ── Async mode: fire-and-forget with background task ──
    if (mode === 'deepseek_chat_tools_async') {
      const taskId = crypto.randomUUID();
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      // Insert pending task
      await supabase.from('ai_proxy_tasks').insert({ id: taskId, status: 'pending' });

      // Run LLM in background (up to 400s wall clock)
      // deno-lint-ignore no-explicit-any
      (EdgeRuntime as any).waitUntil(
        (async () => {
          try {
            const response = await handleDeepSeekChatTools(payload);
            const body = await response.json();
            await supabase.from('ai_proxy_tasks').update({
              status: 'completed', result: body, completed_at: new Date().toISOString(),
            }).eq('id', taskId);
          } catch (err) {
            await supabase.from('ai_proxy_tasks').update({
              status: 'failed', error: String(err), completed_at: new Date().toISOString(),
            }).eq('id', taskId);
          }
        })(),
      );

      // Return immediately with taskId
      console.info(`[ai-proxy] async task ${taskId} dispatched`);
      return jsonResponse({ taskId, status: 'pending' }, 202, cors);
    }

    // ── Poll mode: check async task status ──
    if (mode === 'ai_proxy_poll') {
      const taskId = String(payload?.taskId || '');
      if (!taskId) return jsonResponse({ error: 'Missing taskId' }, 400, cors);
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await supabase.from('ai_proxy_tasks').select('*').eq('id', taskId).single();
      if (!data) return jsonResponse({ error: 'Task not found' }, 404, cors);
      if (data.status === 'completed') {
        // Clean up after retrieval
        supabase.from('ai_proxy_tasks').delete().eq('id', taskId).then(() => {});
        return jsonResponse({ status: 'completed', ...data.result }, 200, cors);
      }
      if (data.status === 'failed') {
        supabase.from('ai_proxy_tasks').delete().eq('id', taskId).then(() => {});
        return jsonResponse({ status: 'failed', error: data.error }, 200, cors);
      }
      return jsonResponse({ status: 'pending' }, 200, cors);
    }

    if (mode === 'gemini_generate') return wrapCors(await handleGeminiGenerate(payload, authContext));
    if (mode === 'gemini_chat') return wrapCors(await handleGeminiChat(payload));
    if (mode === 'gemini_chat_tools') return wrapCors(await handleGeminiChatTools(payload));
    if (mode === 'deepseek_chat') return wrapCors(await handleDeepSeekChat(payload));
    if (mode === 'deepseek_chat_tools') return wrapCors(await handleDeepSeekChatTools(payload));
    if (mode === 'deepseek_chat_tools_stream') {
      const streamResp = await handleDeepSeekChatToolsStream(payload, cors);
      console.info(`[ai-proxy] mode=${mode} total=${Math.round(performance.now() - t0)}ms`);
      return streamResp;
    }
    if (mode === 'ai_chat') return wrapCors(await handleAiChat(payload));
    if (mode === 'di_prompt') return wrapCors(await handleDiPrompt(payload, authContext));
    if (mode === 'anthropic_chat') return wrapCors(await handleAnthropicChat(payload));
    if (mode === 'anthropic_chat_tools') return wrapCors(await handleAnthropicChatTools(payload));
    if (mode === 'kimi_chat') return wrapCors(await handleKimiChat(payload));
    if (mode === 'kimi_chat_tools') return wrapCors(await handleKimiChatTools(payload));
    if (mode === 'openai_responses') return wrapCors(await handleOpenAIResponses(payload));
    if (mode === 'openai_chat') return wrapCors(await handleOpenAIChat(payload));
    if (mode === 'openai_chat_tools') return wrapCors(await handleOpenAIChatTools(payload));
    if (mode === 'gemini_native') {
      const streamResp = await handleGeminiNative(payload, cors, authContext);
      console.info(`[ai-proxy] mode=${mode} total=${Math.round(performance.now() - t0)}ms`);
      return streamResp;
    }
    if (mode === 'gemini_chat_tools_stream') {
      const streamResp = await handleGeminiChatToolsStream(payload, cors);
      console.info(`[ai-proxy] mode=${mode} total=${Math.round(performance.now() - t0)}ms`);
      return streamResp;
    }
    if (mode === 'anthropic_chat_tools_stream') {
      const streamResp = await handleAnthropicChatToolsStream(payload, cors);
      console.info(`[ai-proxy] mode=${mode} total=${Math.round(performance.now() - t0)}ms`);
      return streamResp;
    }
    if (mode === 'openai_chat_tools_stream') {
      // Streaming handler returns SSE response with CORS already set — no wrapCors needed
      const streamResp = await handleOpenAIChatToolsStream(payload, cors);
      console.info(`[ai-proxy] mode=${mode} total=${Math.round(performance.now() - t0)}ms`);
      return streamResp;
    }

    if (mode === 'anthropic_billing') return wrapCors(await handleAnthropicBilling());
    if (mode === 'openai_billing') return wrapCors(await handleOpenAIBilling());
    if (mode === 'kimi_billing') return wrapCors(await handleKimiBilling());

    return jsonResponse({ error: `Unsupported mode: ${mode}` }, 400, cors);
  } catch (error) {
    const status = Number((error as Error & { status?: number })?.status || 500);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-proxy] error after ${Math.round(performance.now() - t0)}ms:`, message);
    return jsonResponse(
      { error: message, code: 'runtime_error' },
      status >= 400 && status < 600 ? status : 500,
      cors,
    );
  }
});
