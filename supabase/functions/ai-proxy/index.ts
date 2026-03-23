import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type ProxyMode = 'gemini_generate' | 'deepseek_chat' | 'deepseek_chat_tools' | 'ai_chat' | 'di_prompt' | 'anthropic_chat' | 'anthropic_chat_tools' | 'anthropic_chat_tools_stream' | 'openai_chat' | 'openai_chat_tools' | 'openai_chat_tools_stream';

interface ProxyRequestBody {
  mode?: ProxyMode;
  payload?: Record<string, unknown>;
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
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || Deno.env.get('VITE_GEMINI_API_KEY') || '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') || Deno.env.get('VITE_DEEPSEEK_API_KEY') || '';
const GEMINI_API_VERSION = Deno.env.get('DI_GEMINI_API_VERSION') || 'v1beta';
const DEEPSEEK_BASE_URL = String(Deno.env.get('DI_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const OPENAI_BASE_URL = String(Deno.env.get('DI_OPENAI_BASE_URL') || 'https://api.openai.com').replace(/\/+$/, '');
const ANTHROPIC_API_VERSION = '2023-06-01';

const GEMINI_MODEL_ALIASES = Object.freeze({
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
});

const normalizeGeminiModelName = (model: unknown): string => {
  const normalized = String(model || '').trim().replace(/^models\//i, '');
  if (!normalized) return '';
  return GEMINI_MODEL_ALIASES[normalized as keyof typeof GEMINI_MODEL_ALIASES] || normalized;
};

const isGeminiModelName = (model: unknown): boolean => /^gemini-/i.test(String(model || '').trim());

const DEFAULT_GEMINI_MODEL = normalizeGeminiModelName(
  Deno.env.get('DI_GEMINI_MODEL') || Deno.env.get('GEMINI_MODEL') || 'gemini-3.1-pro-preview',
);
const GEMINI_DEFAULT_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_GEMINI_MODEL,
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
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
    'deepseek-v3.2-exp',
    'deepseek-chat',
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

const parseJsonSafe = async (response: Response): Promise<Record<string, unknown>> =>
  response.json().catch(() => ({}));

const isModelLookupError = (status: number, message = ''): boolean => {
  if (status === 404) return true;
  return /(model|models).*(not found|unsupported|unknown|invalid|not supported)/i.test(message);
};

const buildGeminiApiUrl = ({ model, action }: { model: string; action: 'generateContent' }) =>
  `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:${action}?key=${encodeURIComponent(GEMINI_API_KEY)}`;

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
}: {
  message: string;
  conversationHistory?: unknown[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
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
  const text = extractAnthropicText(body);
  if (!text) {
    throw new Error('Anthropic returned empty content.');
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

const callOpenAIChat = async ({
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

const handleGeminiGenerate = async (payload: Record<string, unknown>) => {
  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) return jsonResponse({ error: 'Missing required field: prompt' }, 400);

  const systemContext = String(payload?.systemContext || '');
  const options = (payload?.options as Record<string, unknown>) || {};
  const result = await callGeminiGenerate({
    prompt,
    systemContext,
    options,
  });

  return jsonResponse({
    ok: true,
    ...result,
  });
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

  const modelCandidates = Array.from(new Set(
    [model, ...DEEPSEEK_DEFAULT_CANDIDATES]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxOutputTokens,
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

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

  // Return full OpenAI-format response so the client can handle tool_calls
  return jsonResponse({
    ok: true,
    provider: 'deepseek',
    model: String(request.model || model),
    ...body,
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
    requestBody.tool_choice = { type: 'auto' };
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
    stream: true,
  };
  if (converted.system) {
    requestBody.system = converted.system;
  }
  if (anthropicTools.length > 0) {
    requestBody.tools = anthropicTools;
    requestBody.tool_choice = { type: 'auto' };
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
    requestBody.tool_choice = 'auto';
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
    requestBody.tool_choice = 'auto';
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
    return jsonResponse({ error: errorMessage, code: 'openai_stream_failed' }, response.status >= 400 && response.status < 600 ? response.status : 500);
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

const handleDiPrompt = async (payload: Record<string, unknown>) => {
  const provider = String(payload?.provider || '').trim().toLowerCase();
  const prompt = String(payload?.prompt || '').trim();
  if (!provider) return jsonResponse({ error: 'Missing required field: provider' }, 400);
  if (!prompt) return jsonResponse({ error: 'Missing required field: prompt' }, 400);

  const model = String(payload?.model || '').trim();
  const temperature = toFiniteNumber(payload?.temperature, 0.15);
  const maxOutputTokens = Math.max(64, Math.floor(toFiniteNumber(payload?.maxOutputTokens, 4096)));

  if (provider === 'gemini') {
    const result = await callGeminiGenerate({
      prompt,
      options: {
        model,
        modelCandidates: Array.isArray(payload?.modelCandidates) ? payload.modelCandidates : GEMINI_DEFAULT_CANDIDATES,
        temperature,
        maxOutputTokens,
        responseMimeType: String(payload?.responseMimeType || 'application/json'),
      },
    });
    return jsonResponse({
      ok: true,
      provider: 'gemini',
      model: result.model,
      text: result.text,
    });
  }

  if (provider === 'deepseek') {
    if (!DEEPSEEK_API_KEY) {
      return jsonResponse({ error: 'DEEPSEEK_API_KEY is not configured on Edge Function.' }, 500);
    }
    const request = await postDeepSeekWithModelFallback({
      requestBody: {
        model: model || DEFAULT_DEEPSEEK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxOutputTokens,
      },
      modelCandidates: Array.from(new Set([model, ...DEEPSEEK_DEFAULT_CANDIDATES].map((item) => String(item || '').trim()).filter(Boolean))),
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
    if (!text) return jsonResponse({ error: 'DeepSeek returned empty content.' }, 500);
    return jsonResponse({
      ok: true,
      provider: 'deepseek',
      model: String(request.model || model || DEFAULT_DEEPSEEK_MODEL),
      text,
    });
  }

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
    });
    return jsonResponse({
      ok: true,
      provider: 'anthropic',
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
  // 3. x-di-server header with value 'true' + apikey header (Python backend using anon key)
  const serverKey = Deno.env.get('DI_SERVER_API_KEY') || '';
  const isDiServer = req.headers.get('x-di-server') === 'true';
  const isServerCall = (token === SUPABASE_SERVICE_ROLE_KEY) ||
                       (serverKey && token === serverKey) ||
                       isDiServer;

  let authMs = 0;
  if (!isServerCall) {
    // Standard user auth via Supabase JWT
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    authMs = Math.round(performance.now() - t0);
    if (authError || !user) {
      console.warn(`[ai-proxy] auth failed in ${authMs}ms`);
      return jsonResponse({ error: 'Unauthorized', details: authError?.message || null }, 401, cors);
    }
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

    if (mode === 'gemini_generate') return wrapCors(await handleGeminiGenerate(payload));
    if (mode === 'deepseek_chat') return wrapCors(await handleDeepSeekChat(payload));
    if (mode === 'deepseek_chat_tools') return wrapCors(await handleDeepSeekChatTools(payload));
    if (mode === 'ai_chat') return wrapCors(await handleAiChat(payload));
    if (mode === 'di_prompt') return wrapCors(await handleDiPrompt(payload));
    if (mode === 'anthropic_chat') return wrapCors(await handleAnthropicChat(payload));
    if (mode === 'anthropic_chat_tools') return wrapCors(await handleAnthropicChatTools(payload));
    if (mode === 'openai_chat') return wrapCors(await handleOpenAIChat(payload));
    if (mode === 'openai_chat_tools') return wrapCors(await handleOpenAIChatTools(payload));
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
