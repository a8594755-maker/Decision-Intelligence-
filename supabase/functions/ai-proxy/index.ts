import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type ProxyMode = 'gemini_generate' | 'deepseek_chat' | 'ai_chat' | 'di_prompt';

interface ProxyRequestBody {
  mode?: ProxyMode;
  payload?: Record<string, unknown>;
}

const FRONTEND_ORIGIN = (Deno.env.get('FRONTEND_ORIGIN') || 'http://localhost:5173').trim();

const corsHeaders = {
  'Access-Control-Allow-Origin': FRONTEND_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || Deno.env.get('VITE_GEMINI_API_KEY') || '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') || Deno.env.get('VITE_DEEPSEEK_API_KEY') || '';
const GEMINI_API_VERSION = Deno.env.get('DI_GEMINI_API_VERSION') || 'v1beta';
const DEEPSEEK_BASE_URL = String(Deno.env.get('DI_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');

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

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
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
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
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

  return jsonResponse({ error: `Unsupported provider: ${provider}` }, 400);
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Supabase environment is not configured on Edge Function.' }, 500);
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'Missing authorization header' }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const token = authHeader.replace('Bearer ', '');
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: 'Unauthorized', details: authError?.message || null }, 401);
  }

  try {
    const body = await req.json() as ProxyRequestBody;
    const mode = body?.mode;
    const payload = (body?.payload || {}) as Record<string, unknown>;

    if (!mode) return jsonResponse({ error: 'Missing required field: mode' }, 400);
    if (mode === 'gemini_generate') return await handleGeminiGenerate(payload);
    if (mode === 'deepseek_chat') return await handleDeepSeekChat(payload);
    if (mode === 'ai_chat') return await handleAiChat(payload);
    if (mode === 'di_prompt') return await handleDiPrompt(payload);

    return jsonResponse({ error: `Unsupported mode: ${mode}` }, 400);
  } catch (error) {
    const status = Number((error as Error & { status?: number })?.status || 500);
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      { error: message, code: 'runtime_error' },
      status >= 400 && status < 600 ? status : 500,
    );
  }
});
