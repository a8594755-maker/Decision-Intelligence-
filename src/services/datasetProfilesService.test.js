import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('datasetProfilesService local profile persistence', () => {
  let localStore;

  beforeEach(() => {
    vi.resetModules();
    localStore = new Map();
    globalThis.localStorage = {
      getItem: (key) => localStore.get(key) ?? null,
      setItem: (key, value) => {
        localStore.set(key, String(value));
      },
      removeItem: (key) => {
        localStore.delete(key);
      },
      clear: () => {
        localStore.clear();
      },
    };
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('rehydrates local profiles from localStorage after a module reload', async () => {
    vi.doMock('./supabaseClient', () => ({
      supabase: {
        from: vi.fn(() => {
          throw new Error('Supabase should not be called for local profiles.');
        }),
      },
    }));

    let datasetProfilesModule = await import('./datasetProfilesService.js');
    datasetProfilesModule.registerLocalProfile({
      id: 'local-profile-1',
      user_id: 'user-1',
      _local: true,
      _inlineRawRows: [{ sku: 'A-1', demand: 12 }],
      profile_json: { fingerprint: 'abc' },
      contract_json: {},
    });

    vi.resetModules();
    vi.doMock('./supabaseClient', () => ({
      supabase: {
        from: vi.fn(() => {
          throw new Error('Supabase should not be called for local profiles.');
        }),
      },
    }));

    datasetProfilesModule = await import('./datasetProfilesService.js');
    const rehydrated = await datasetProfilesModule.datasetProfilesService.getDatasetProfileById(
      'user-1',
      'local-profile-1'
    );

    expect(rehydrated).toEqual(expect.objectContaining({
      id: 'local-profile-1',
      _local: true,
      _inlineRawRows: [{ sku: 'A-1', demand: 12 }],
    }));
  });
});
