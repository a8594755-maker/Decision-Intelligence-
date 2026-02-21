import { supabase } from './supabaseClient';
import { acquireOrThrow } from '../utils/rateLimiter';

const AI_PROXY_FUNCTION_NAME = 'ai-proxy';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

const buildFunctionHint = () => {
  const endpoint = SUPABASE_URL
    ? `${String(SUPABASE_URL).replace(/\/+$/, '')}/functions/v1/${AI_PROXY_FUNCTION_NAME}`
    : `(missing VITE_SUPABASE_URL)/functions/v1/${AI_PROXY_FUNCTION_NAME}`;
  return [
    `Edge Function "${AI_PROXY_FUNCTION_NAME}" is unreachable.`,
    `Endpoint: ${endpoint}`,
    'Check that the function is deployed to the same Supabase project and that Edge Functions are enabled.'
  ].join(' ');
};

const readFunctionErrorMessage = async (error) => {
  if (!error) return 'Unknown Edge Function error';
  const contextResponse = error?.context?.response;
  if (contextResponse) {
    try {
      const payload = await contextResponse.json();
      if (payload?.error) return String(payload.error);
      if (payload?.message) return String(payload.message);
    } catch {
      // ignore response parsing errors
    }
  }
  if (typeof error?.message === 'string' && error.message) {
    const lower = error.message.toLowerCase();
    if (
      lower.includes('failed to send a request to the edge function')
      || lower.includes('failed to fetch')
      || lower.includes('networkerror')
    ) {
      return buildFunctionHint();
    }
    return error.message;
  }
  return 'Unknown Edge Function error';
};

export const invokeAiProxy = async (mode, payload = {}) => {
  acquireOrThrow('ai_proxy');

  if (!supabase?.functions?.invoke) {
    throw new Error('Supabase Functions is unavailable. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }
  const requestBody = {
    mode,
    payload,
  };
  const { data, error } = await supabase.functions.invoke(AI_PROXY_FUNCTION_NAME, {
    body: requestBody,
  });

  if (error) {
    const message = await readFunctionErrorMessage(error);
    throw new Error(message);
  }
  if (!data) {
    throw new Error('AI proxy returned an empty response.');
  }
  if (data?.error) {
    throw new Error(String(data.error));
  }

  return data;
};

export const streamTextToChunks = (text, onChunk, chunkSize = 48) => {
  if (typeof onChunk !== 'function') return;
  const content = String(text || '');
  if (!content) return;
  const size = Number.isFinite(Number(chunkSize)) && Number(chunkSize) > 0 ? Number(chunkSize) : 48;
  for (let idx = 0; idx < content.length; idx += size) {
    onChunk(content.slice(idx, idx + size));
  }
};

export default {
  invokeAiProxy,
  streamTextToChunks,
};
