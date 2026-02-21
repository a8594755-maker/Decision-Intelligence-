import { supabase } from './supabaseClient';

const AI_PROXY_FUNCTION_NAME = 'ai-proxy';

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
    return error.message;
  }
  return 'Unknown Edge Function error';
};

export const invokeAiProxy = async (mode, payload = {}) => {
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
