import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('supabaseClient facade', () => {
  it('re-exports core bindings and extracted service entrypoints', async () => {
    vi.resetModules();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await vi.importActual('./supabaseClient.js');

    expect(mod.supabase).toBeDefined();
    expect(mod.isSupabaseConfigured).toBeTypeOf('boolean');
    expect(mod.SUPABASE_JSON_HEADERS).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(mod.RPC_JSON_OPTIONS).toEqual({
      headers: mod.SUPABASE_JSON_HEADERS,
    });

    expect(mod.userFilesService.getFileById).toBeTypeOf('function');
    expect(mod.suppliersService.insertSuppliers).toBeTypeOf('function');
    expect(mod.materialsService.batchUpsertMaterials).toBeTypeOf('function');
    expect(mod.goodsReceiptsService.batchInsertReceipts).toBeTypeOf('function');
    expect(mod.priceHistoryService.getLatestPrice).toBeTypeOf('function');
    expect(mod.conversationsService.createConversation).toBeTypeOf('function');
    expect(mod.authService.getSession).toBeTypeOf('function');
    expect(mod.uploadMappingsService.smartMapping).toBeTypeOf('function');
    expect(mod.bomEdgesService.batchInsert).toBeTypeOf('function');

    errorSpy.mockRestore();
  });
});

