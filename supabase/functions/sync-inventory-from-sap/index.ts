// ============================================
// SAP Inventory Sync Edge Function
// ============================================
// Purpose: Sync inventory stock from SAP to material stock table
// Environment: SAP_API_KEY, INTEGRATION_USER_ID, SAP_BASE_URL (optional)
// API: API_MATERIAL_STOCK_SRV (v0001)
// Entity: A_MatlStkInAcctMod
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SAP_API_KEY = Deno.env.get('SAP_API_KEY')!;
const INTEGRATION_USER_ID = Deno.env.get('INTEGRATION_USER_ID')!;

// Read Inventory-specific base URL or fall back to generic SAP_BASE_URL
const SAP_BASE_URL_INPUT = Deno.env.get('SAP_INV_BASE_URL') || Deno.env.get('SAP_BASE_URL') || 'https://sandbox.api.sap.com/s4hanacloud';

// URL normalization: only append service path if base doesn't already contain /sap/opu/odata/sap/
const SERVICE_NAME = 'API_MATERIAL_STOCK_SRV';

function normalizeSapServiceBaseUrl(baseUrl: string, serviceName: string): string {
  const cleanedBase = baseUrl.replace(/\/+$/, '');
  const sapOdataPrefix = '/sap/opu/odata/sap';
  const sapOdataMarker = `${sapOdataPrefix}/`;

  if (cleanedBase.includes(sapOdataMarker)) {
    if (cleanedBase.includes(`${sapOdataMarker}${serviceName}`)) {
      return cleanedBase;
    }

    if (cleanedBase.endsWith(sapOdataPrefix)) {
      return `${cleanedBase}/${serviceName}`;
    }

    if (cleanedBase.endsWith(sapOdataMarker.replace(/\/+$/, ''))) {
      return `${cleanedBase}${serviceName}`;
    }

    return cleanedBase;
  }

  return `${cleanedBase}${sapOdataMarker}${serviceName}`;
}

const SAP_BASE_URL = normalizeSapServiceBaseUrl(SAP_BASE_URL_INPUT, SERVICE_NAME);

console.log(`[INV SYNC] SAP_BASE_URL resolved: ${SAP_BASE_URL}`);
console.log(`[INV SYNC] Original input: ${SAP_BASE_URL_INPUT}`);

// Constants
const BATCH_SIZE = 200;
const PAGE_SIZE = 200;

// Types
interface SAPMaterialStock {
  Material: string;
  Plant: string;
  StorageLocation: string;
  Batch: string;
  MatlWrhsStkQtyInMatlBaseUnit: number;  // Warehouse stock qty in base UoM
  MaterialBaseUnit: string;
  InventoryStockType: string;  // Correct SAP field name (not StockType)
  InventorySpecialStockType: string;
}

interface StockRecord {
  user_id: string;
  material_code: string;
  plant_id: string;
  storage_location: string;
  batch: string | null;
  stock_type: string;
  qty: number;
  uom: string;
  snapshot_at: string;
  source: string;
}

interface SyncStats {
  fetched: number;
  upserted: number;
  skipped: number;
  errors: number;
}

interface DebugInfo {
  sap_status: number;
  fetched_stock: number;
  upserted_count: number;
  sample_records: string[];
  errors: string[];
  final_request_url?: string;  // Added to debug URL issues
}

interface SyncRequestBody {
  plant?: string;
  material_prefix?: string;
  material_codes?: string[];
  max_pages?: number;
}

// ============================================
// Main Handler
// ============================================
Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Validate environment variables
  const envValidation = validateEnvironment();
  if (!envValidation.valid) {
    return new Response(JSON.stringify({ error: envValidation.error }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Parse request body for optional filters
  let requestBody: SyncRequestBody = {};
  try {
    requestBody = await req.json();
  } catch (_e) {
    // No body or invalid JSON, use defaults
  }

  const startTime = Date.now();
  const stats: SyncStats = { fetched: 0, upserted: 0, skipped: 0, errors: 0 };
  const debug: DebugInfo = {
    sap_status: 0,
    fetched_stock: 0,
    upserted_count: 0,
    sample_records: [],
    errors: [],
  };

  try {
    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Check if inventory table exists, create if not
    await ensureInventoryTable(supabase);

    // Fetch stock from SAP
    console.log('[INV SYNC] Fetching inventory stock...');
    const stockRecords = await fetchAllStock(requestBody, debug);
    stats.fetched = stockRecords.length;
    debug.fetched_stock = stockRecords.length;
    console.log(`[INV SYNC] Stock records fetched: ${stockRecords.length}`);

    if (stockRecords.length === 0) {
      console.log('[INV SYNC] No stock records found, returning early');
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No stock records found in SAP for given filters',
          stats,
          debug,
          duration_ms: Date.now() - startTime,
          filters: {
            plant: requestBody.plant || null,
            material_prefix: requestBody.material_prefix || null,
          },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Get sample records (first 3)
    debug.sample_records = stockRecords.slice(0, 3).map(r =>
      `${r.material_code} @ ${r.plant_id}/${r.storage_location}: ${r.qty} ${r.uom}`
    );

    // Batch upsert to database
    console.log('[INV SYNC] Starting batch upsert...');
    const upsertResult = await batchUpsertStock(supabase, stockRecords);
    stats.upserted = upsertResult.upserted;
    stats.errors = upsertResult.errors;
    debug.upserted_count = upsertResult.upserted;
    console.log(`[INV SYNC] Upserted: ${upsertResult.upserted}, Errors: ${upsertResult.errors}`);

    const duration = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        success: stats.errors === 0 && stats.fetched > 0,
        stats,
        debug,
        duration_ms: duration,
        filters: {
          plant: requestBody.plant || null,
          material_prefix: requestBody.material_prefix || null,
          material_codes: requestBody.material_codes || null,
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    debug.errors.push(errorMsg);

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMsg,
        stats,
        debug,
        duration_ms: duration,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

// ============================================
// Environment Validation
// ============================================
function validateEnvironment(): { valid: boolean; error?: string } {
  if (!SUPABASE_URL) {
    return { valid: false, error: 'Missing SUPABASE_URL environment variable' };
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return { valid: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable' };
  }
  if (!SAP_API_KEY) {
    return { valid: false, error: 'Missing SAP_API_KEY environment variable' };
  }
  if (!INTEGRATION_USER_ID) {
    return { valid: false, error: 'Missing INTEGRATION_USER_ID environment variable' };
  }
  return { valid: true };
}

// ============================================
// SAP API Functions
// ============================================
async function fetchAllStock(
  filters: SyncRequestBody,
  debug: DebugInfo
): Promise<StockRecord[]> {
  const allStock: SAPMaterialStock[] = [];
  let skip = 0;
  let hasMore = true;
  let pageCount = 0;

  const filterParams: string[] = [];
  if (filters.plant) {
    filterParams.push(`Plant eq '${filters.plant}'`);
  }
  if (filters.material_prefix) {
    filterParams.push(`startswith(Material, '${filters.material_prefix}')`);
  }
  if (filters.material_codes && filters.material_codes.length > 0) {
    const materialFilter = filters.material_codes.map(m => `Material eq '${m}'`).join(' or ');
    filterParams.push(`(${materialFilter})`);
  }

  const filterQuery = filterParams.length > 0
    ? `$filter=${filterParams.join(' and ')}&`
    : '';

  while (hasMore) {
    pageCount++;
    if (filters.max_pages && pageCount > filters.max_pages) {
      console.log(`[INV SYNC] Reached max_pages limit: ${filters.max_pages}`);
      break;
    }

    const url = `${SAP_BASE_URL}/A_MatlStkInAcctMod?${filterQuery}$select=Material,Plant,StorageLocation,Batch,MatlWrhsStkQtyInMatlBaseUnit,MaterialBaseUnit,InventoryStockType,InventorySpecialStockType&$top=${PAGE_SIZE}&$skip=${skip}`;

    console.log(`[INV SYNC] Requesting stock: ${url}`);

    const response = await fetch(url, {
      headers: {
        'apikey': SAP_API_KEY,
        'Accept': 'application/json',
      },
    });

    // Store the final URL for debugging (only on first request)
    if (!debug.final_request_url) {
      debug.final_request_url = url;
    }

    debug.sap_status = response.status;
    console.log(`[INV SYNC] Stock API status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[INV SYNC] Stock API error: ${response.status} - ${errorText}`);
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // OData V2: results are in data.d.results
    const results = data.d?.results || [];
    console.log(`[INV SYNC] Stock response: ${results.length} items`);

    allStock.push(...results.map((r: any) => ({
      Material: r.Material,
      Plant: r.Plant,
      StorageLocation: r.StorageLocation,
      Batch: r.Batch || '',
      MatlWrhsStkQtyInMatlBaseUnit: parseFloat(r.MatlWrhsStkQtyInMatlBaseUnit) || 0,
      MaterialBaseUnit: r.MaterialBaseUnit,
      InventoryStockType: r.InventoryStockType || '01',  // Use correct SAP field name
      InventorySpecialStockType: r.InventorySpecialStockType || '',
    })));

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  // Convert SAP records to our format
  const now = new Date().toISOString();
  return allStock.map(stock => ({
    user_id: INTEGRATION_USER_ID,
    material_code: stock.Material,
    plant_id: stock.Plant,
    storage_location: stock.StorageLocation,
    batch: stock.Batch || null,
    stock_type: stock.InventoryStockType,  // Use correct SAP field name
    qty: stock.MatlWrhsStkQtyInMatlBaseUnit,
    uom: stock.MaterialBaseUnit,
    snapshot_at: now,
    source: 'sap_sync',
  }));
}

// ============================================
// Database Operations
// ============================================
async function ensureInventoryTable(supabase: any): Promise<void> {
  // Check if table exists by attempting a simple query
  try {
    const { error } = await supabase
      .from('material_stock_snapshots')
      .select('id', { count: 'exact', head: true })
      .limit(1);

    if (!error) {
      console.log('[INV SYNC] material_stock_snapshots table exists');
      return;
    }

    // Table doesn't exist, create it
    console.log('[INV SYNC] Creating material_stock_snapshots table...');

    const { error: createError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS material_stock_snapshots (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          material_code TEXT NOT NULL,
          plant_id TEXT NOT NULL,
          storage_location TEXT NOT NULL DEFAULT '',
          batch TEXT,
          stock_type TEXT NOT NULL DEFAULT 'UNRESTRICTED',
          qty NUMERIC NOT NULL DEFAULT 0,
          uom TEXT NOT NULL,
          snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          source TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(user_id, material_code, plant_id, storage_location, batch, stock_type, snapshot_at)
        );
        
        CREATE INDEX IF NOT EXISTS idx_stock_snapshots_material 
          ON material_stock_snapshots(user_id, material_code);
        CREATE INDEX IF NOT EXISTS idx_stock_snapshots_plant 
          ON material_stock_snapshots(user_id, plant_id);
        CREATE INDEX IF NOT EXISTS idx_stock_snapshots_snapshot 
          ON material_stock_snapshots(snapshot_at);
      `
    });

    if (createError) {
      console.error('[INV SYNC] Failed to create table:', createError);
      // Don't throw - we'll try to upsert anyway and let that fail if table really doesn't exist
    } else {
      console.log('[INV SYNC] material_stock_snapshots table created successfully');
    }
  } catch (err) {
    console.error('[INV SYNC] Error checking/creating table:', err);
  }
}

async function batchUpsertStock(
  supabase: any,
  records: StockRecord[]
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);

    try {
      const { error } = await supabase
        .from('material_stock_snapshots')
        .upsert(chunk, {
          onConflict: 'user_id,material_code,plant_id,storage_location,batch,stock_type,snapshot_at',
          ignoreDuplicates: false,
        });

      if (error) {
        console.error(`[INV SYNC] Batch ${i / BATCH_SIZE + 1} error:`, error);
        errors += chunk.length;
      } else {
        upserted += chunk.length;
      }
    } catch (err) {
      console.error(`[INV SYNC] Batch ${i / BATCH_SIZE + 1} exception:`, err);
      errors += chunk.length;
    }
  }

  return { upserted, errors };
}
