import { vi } from 'vitest';

// Supabase mock — prevent real DB calls in tests
vi.mock('../services/infra/supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      then: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  },
  isSupabaseConfigured: false,
  RPC_JSON_OPTIONS: Object.freeze({ headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }),
  userFilesService: {
    getLatestFile: vi.fn().mockResolvedValue(null),
    getFileById: vi.fn().mockResolvedValue(null),
    saveFile: vi.fn().mockResolvedValue(null),
    getAllFiles: vi.fn().mockResolvedValue([]),
  },
}));

// DuckDB-WASM mock — prevent WASM loading in Node test environment
vi.mock('@duckdb/duckdb-wasm', () => {
  const mockConn = {
    query: vi.fn().mockResolvedValue({ toArray: () => [] }),
    close: vi.fn(),
  };
  const mockDb = {
    instantiate: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockConn),
    registerFileText: vi.fn(),
    terminate: vi.fn(),
  };
  return {
    getJsDelivrBundles: vi.fn(() => ({})),
    selectBundle: vi.fn().mockResolvedValue({ mainModule: '', mainWorker: '', pthreadWorker: null }),
    AsyncDuckDB: vi.fn(() => mockDb),
    ConsoleLogger: vi.fn(),
  };
});

// i18n mock — prevent actual i18next init in tests
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { changeLanguage: vi.fn() } }),
  Trans: ({ children }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// DOM polyfills — only in jsdom environment
if (typeof window !== 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  window.scrollTo = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = vi.fn();
}
