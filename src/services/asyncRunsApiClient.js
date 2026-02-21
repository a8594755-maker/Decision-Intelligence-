const ML_API_BASE = import.meta.env.VITE_ML_API_URL || '';

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Async run API timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function requestJson(path, method = 'GET', payload = null, timeoutMs = 15000) {
  const baseUrl = normalizeBaseUrl(ML_API_BASE);
  if (!baseUrl) {
    throw new Error('VITE_ML_API_URL is not configured');
  }

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload)
    }),
    timeoutMs
  );

  const text = await response.text().catch(() => '');
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const detail = parsed?.detail || parsed?.error || text || response.statusText;
    throw new Error(`Async run API ${response.status}: ${detail}`);
  }

  if (parsed?.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

export const asyncRunsApiClient = {
  isConfigured() {
    return Boolean(normalizeBaseUrl(ML_API_BASE));
  },

  async submitRun(payload, options = {}) {
    return requestJson('/runs', 'POST', payload || {}, options.timeoutMs || 20000);
  },

  async getJob(jobId, options = {}) {
    if (!jobId) throw new Error('jobId is required');
    return requestJson(`/jobs/${jobId}`, 'GET', null, options.timeoutMs || 10000);
  },

  async cancelJob(jobId, options = {}) {
    if (!jobId) throw new Error('jobId is required');
    return requestJson(`/jobs/${jobId}/cancel`, 'POST', {}, options.timeoutMs || 10000);
  },

  async getRunSteps(runId, options = {}) {
    if (!runId) throw new Error('runId is required');
    return requestJson(`/runs/${runId}/steps`, 'GET', null, options.timeoutMs || 10000);
  },

  async getRunArtifacts(runId, options = {}) {
    if (!runId) throw new Error('runId is required');
    return requestJson(`/runs/${runId}/artifacts`, 'GET', null, options.timeoutMs || 10000);
  }
};

export default asyncRunsApiClient;
