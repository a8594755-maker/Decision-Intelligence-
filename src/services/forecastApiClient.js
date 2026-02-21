const ML_API_BASE = import.meta.env.VITE_ML_API_URL || '';

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Forecast API timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function postJson(path, payload, timeoutMs = 15000) {
  const baseUrl = normalizeBaseUrl(ML_API_BASE);
  if (!baseUrl) {
    throw new Error('VITE_ML_API_URL is not configured');
  }

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }),
    timeoutMs
  );

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Forecast API ${response.status}: ${message || response.statusText}`);
  }

  const parsed = await response.json();
  if (parsed?.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

export const forecastApiClient = {
  isConfigured() {
    return Boolean(normalizeBaseUrl(ML_API_BASE));
  },

  async demandForecast(payload, options = {}) {
    return postJson('/demand-forecast', payload, options.timeoutMs || 15000);
  },

  async backtest(payload, options = {}) {
    return postJson('/backtest', payload, options.timeoutMs || 15000);
  }
};

export default forecastApiClient;
