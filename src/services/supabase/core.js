import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const missingSupabaseError = new Error('Supabase configuration error: Missing environment variables');

export const SUPABASE_JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

export const RPC_JSON_OPTIONS = Object.freeze({
  headers: SUPABASE_JSON_HEADERS,
});

const createDisabledQueryBuilder = () => {
  const terminalPromise = Promise.resolve({ data: null, error: missingSupabaseError, count: 0 });
  let proxy = null;

  const handler = {
    get(_target, property) {
      if (property === 'then') return terminalPromise.then.bind(terminalPromise);
      if (property === 'catch') return terminalPromise.catch.bind(terminalPromise);
      if (property === 'finally') return terminalPromise.finally.bind(terminalPromise);
      if (property === 'single' || property === 'maybeSingle') {
        return async () => ({ data: null, error: missingSupabaseError });
      }
      if (property === 'csv') {
        return async () => ({ data: '', error: missingSupabaseError });
      }
      return () => proxy;
    },
  };

  proxy = new Proxy({}, handler);
  return proxy;
};

const createDisabledSupabaseClient = () => ({
  from: () => createDisabledQueryBuilder(),
  rpc: async () => ({ data: null, error: missingSupabaseError }),
  auth: {
    getSession: async () => ({ data: { session: null }, error: missingSupabaseError }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: missingSupabaseError }),
    signUp: async () => ({ data: null, error: missingSupabaseError }),
    signOut: async () => ({ error: missingSupabaseError }),
  },
});

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);
if (!isSupabaseConfigured) {
  console.error('❌ Missing Supabase environment variables!');
  console.error('Please ensure .env file exists with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
}

const SUPABASE_FETCH_TIMEOUT_MS = 20000;

// 1. Probe PostgREST once to discover available tables.
// 2. Short-circuit known missing tables with a synthetic 404.
// 3. Fall back to reactive 404 detection if the startup probe fails.
const unavailableTables = new Set();
let knownTables = null;

function extractTable(url) {
  const match = String(url).match(/\/rest\/v1\/([a-z_]+)/);
  return match ? match[1] : null;
}

function synthetic404(table) {
  return new Response(
    JSON.stringify({
      message: `Could not find the table 'public.${table}' in the schema cache`,
      code: 'PGRST205',
    }),
    { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } },
  );
}

let schemaProbePromise = null;
async function probeAvailableTables() {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return;
    const spec = await res.json();
    if (spec.paths) {
      knownTables = new Set(Object.keys(spec.paths).map((path) => path.replace(/^\//, '')));
    }
  } catch {
    // Probe failed or timed out. Runtime 404 detection still works.
  }
}

if (isSupabaseConfigured) {
  schemaProbePromise = probeAvailableTables();
}

export function markTableUnavailable(table) {
  unavailableTables.add(table);
}

const supabaseFetchWithTimeout = async (url, options = {}) => {
  const table = extractTable(String(url));

  if (table) {
    if (unavailableTables.has(table)) {
      return synthetic404(table);
    }

    if (schemaProbePromise) {
      await schemaProbePromise;
    }

    if (knownTables && !knownTables.has(table)) {
      unavailableTables.add(table);
      return synthetic404(table);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS);

  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (table && response.status === 404) {
      unavailableTables.add(table);
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

const createSupabaseClient = () => {
  if (!isSupabaseConfigured) return createDisabledSupabaseClient();

  if (import.meta.hot?.data?.supabaseClient) {
    return import.meta.hot.data.supabaseClient;
  }

  const authLockWithTimeout = async (name, _acquireTimeout, fn) => {
    if (typeof navigator === 'undefined' || !navigator?.locks?.request) {
      return await fn();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await navigator.locks.request(name, { signal: controller.signal }, async () => fn());
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[Supabase] Lock "${name}" timed out after 5s, proceeding without lock`);
        return await fn();
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const client = createClient(supabaseUrl, supabaseKey, {
    global: {
      headers: SUPABASE_JSON_HEADERS,
      fetch: supabaseFetchWithTimeout,
    },
    auth: {
      lock: authLockWithTimeout,
    },
  });

  if (import.meta.hot) {
    import.meta.hot.data.supabaseClient = client;
  }

  return client;
};

export const supabase = createSupabaseClient();

