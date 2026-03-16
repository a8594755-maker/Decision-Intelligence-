export {
  SUPABASE_JSON_HEADERS,
  RPC_JSON_OPTIONS,
  isSupabaseConfigured,
  markTableUnavailable,
  supabase,
} from './supabase/core.js';
export { userFilesService } from './supabase/storageService.js';
export { suppliersService, materialsService } from './supabase/masterDataService.js';
export { goodsReceiptsService, priceHistoryService } from './supabase/transactionsService.js';
export {
  conversationsService,
  authService,
  uploadMappingsService,
} from './supabase/appDataService.js';

// Legacy facade: preserve the existing import path while moving the client
// bootstrap and foundational data services into domain-focused modules.
export {
  bomEdgesService,
  demandFgService,
  demandForecastService,
  forecastRunsService,
  componentDemandService,
  componentDemandTraceService,
} from './supabase/planningDataService.js';
export {
  poOpenLinesService,
  inventorySnapshotsService,
  fgFinancialsService,
} from './supabase/operationsDataService.js';
export { importBatchesService } from './importHistoryService';
