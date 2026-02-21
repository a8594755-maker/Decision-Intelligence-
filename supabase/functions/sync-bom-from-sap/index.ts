// ============================================
// SAP BOM (Bill of Materials) Sync Edge Function
// ============================================
// Purpose: Sync BOM edges from SAP to bom_edges table
// Environment: SAP_API_KEY, INTEGRATION_USER_ID, SAP_BASE_URL (optional)
// API: API_BILL_OF_MATERIAL_SRV;v=0002
// Entities: MaterialBOM (header) + MaterialBOMItem (items)
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SAP_API_KEY = Deno.env.get('SAP_API_KEY')!;
const INTEGRATION_USER_ID = Deno.env.get('INTEGRATION_USER_ID')!;
const FRONTEND_ORIGIN = (Deno.env.get('FRONTEND_ORIGIN') || 'http://localhost:5173').trim();

// Read BOM-specific base URL or fall back to generic SAP_BASE_URL
const SAP_BASE_URL_INPUT = Deno.env.get('SAP_BOM_BASE_URL') || Deno.env.get('SAP_BASE_URL') || 'https://sandbox.api.sap.com/s4hanacloud';

// URL normalization: always construct correct service URL regardless of what base contains
const SERVICE_NAME = 'API_BILL_OF_MATERIAL_SRV;v=0002';

function buildSapServiceUrl(baseUrl: string, serviceName: string): string {
  const cleaned = baseUrl.replace(/\/+$/, '');
  const odataSegment = '/sap/opu/odata/sap';

  // If base already contains /sap/opu/odata/sap, strip everything from that point
  // to remove any old/wrong service name baked into the env var
  const idx = cleaned.indexOf(odataSegment);
  const root = idx >= 0 ? cleaned.substring(0, idx) : cleaned;

  return `${root}${odataSegment}/${serviceName}`;
}

const SAP_BASE_URL = buildSapServiceUrl(SAP_BASE_URL_INPUT, SERVICE_NAME);

console.log(`[BOM SYNC] SAP_BASE_URL resolved: ${SAP_BASE_URL}`);
console.log(`[BOM SYNC] Original input: ${SAP_BASE_URL_INPUT}`);

// Constants
const BATCH_SIZE = 200;
const PAGE_SIZE = 200;

// Types
interface SAPMaterialBOM {
  BillOfMaterial: string;
  Material: string;
  Plant: string;
  BillOfMaterialCategory: string;
  BillOfMaterialVariant: string;
  BillOfMaterialHeaderUUID: string;
}

interface SAPMaterialBOMItem {
  BillOfMaterialItemNodeNumber: string;
  BillOfMaterial: string;
  Material: string;
  BillOfMaterialComponent: string;
  BillOfMaterialItemQuantity: number;
  BillOfMaterialItemUnit: string;
  Plant: string;
  BillOfMaterialHeaderUUID: string;
  BillOfMaterialVariant: string;
  IsDeleted?: boolean;
}

interface BOMEdgeRecord {
  user_id: string;
  parent_material: string;
  child_material: string;
  qty_per: number;
  uom: string;
  plant_id: string;
  alt_group: string | null;
  priority: number;
  valid_from: string | null;
  valid_to: string | null;
  source: string;
  sap_bom_id: string;
}

interface SyncStats {
  fetched: number;
  upserted: number;
  skipped: number;
  errors: number;
}

interface DebugInfo {
  sap_status_headers: number;
  sap_status_items: number;
  fetched_headers: number;
  fetched_items: number;
  joined_count: number;
  upserted_count: number;
  sample_edges: string[];
  sample_headers_keys: string[];
  sample_items_keys: string[];
  errors: string[];
  db_errors: string[];  // Add database errors
  final_request_url?: string;  // Added to debug URL issues
}

interface SyncRequestBody {
  plant?: string;
  material_codes?: string[];
  max_pages?: number;
}

// ============================================
// Main Handler
// ============================================
Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': FRONTEND_ORIGIN,
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
    sap_status_headers: 0,
    sap_status_items: 0,
    fetched_headers: 0,
    fetched_items: 0,
    joined_count: 0,
    upserted_count: 0,
    sample_edges: [],
    sample_headers_keys: [],
    sample_items_keys: [],
    errors: [],
    db_errors: [],
  };

  try {
    // First, let's check the service metadata to understand the structure
    console.log('[BOM SYNC] Checking service metadata...');
    const metadataUrl = `${SAP_BASE_URL}/$metadata`;
    console.log(`[BOM SYNC] Metadata URL: ${metadataUrl}`);
    
    const metadataResponse = await fetch(metadataUrl, {
      headers: {
        'apikey': SAP_API_KEY,
        'Accept': 'application/xml',
      },
    });
    
    if (metadataResponse.ok) {
      const metadataText = await metadataResponse.text();
      console.log(`[BOM SYNC] Metadata received, length: ${metadataText.length}`);
      debug.sample_edges.push(`METADATA_PREVIEW: ${metadataText.substring(0, 1000)}...`);
    } else {
      console.log(`[BOM SYNC] Metadata request failed: ${metadataResponse.status}`);
    }

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch BOM headers from SAP
    console.log('[BOM SYNC] Fetching BOM headers...');
    const bomHeaders = await fetchAllBOMHeaders(requestBody, debug);
    debug.fetched_headers = bomHeaders.length;
    console.log(`[BOM SYNC] BOM headers fetched: ${bomHeaders.length}`);

    if (bomHeaders.length === 0) {
      throw new Error(`No BOM headers fetched from SAP. Status: ${debug.sap_status_headers}`);
    }

    // Fetch BOM items from SAP
    console.log('[BOM SYNC] Fetching BOM items...');
    const bomItems = await fetchAllBOMItems(requestBody, debug);
    debug.fetched_items = bomItems.length;
    console.log(`[BOM SYNC] BOM items fetched: ${bomItems.length}`);

    if (bomItems.length === 0) {
      throw new Error(`No BOM items fetched from SAP. Status: ${debug.sap_status_items}`);
    }

    // Join headers with items to build BOM edges
    console.log('[BOM SYNC] Building BOM edges...');
    const bomEdges = buildBOMEdges(bomHeaders, bomItems, debug);
    stats.fetched = bomEdges.length;
    debug.joined_count = bomEdges.length;
    console.log(`[BOM SYNC] BOM edges built: ${bomEdges.length}`);

    // Filter out deleted items
    const activeEdges = bomEdges.filter(e => !e.isDeleted);
    stats.skipped = bomEdges.length - activeEdges.length;
    console.log(`[BOM SYNC] Active BOM edges (not deleted): ${activeEdges.length}`);

    // Get sample edges (first 3)
    debug.sample_edges = activeEdges.slice(0, 3).map(e =>
      `${e.parent_material} → ${e.child_material} (qty: ${e.qty_per}, plant: ${e.plant_id})`
    );

    // Batch upsert to database
    console.log('[BOM SYNC] Starting batch upsert...');
    const upsertResult = await batchUpsertBOMEdges(supabase, activeEdges, debug);
    stats.upserted = upsertResult.upserted;
    stats.errors = upsertResult.errors;
    debug.upserted_count = upsertResult.upserted;
    console.log(`[BOM SYNC] Upserted: ${upsertResult.upserted}, Errors: ${upsertResult.errors}`);

    const duration = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        success: stats.errors === 0 && stats.fetched > 0,
        stats,
        debug,
        duration_ms: duration,
        filters: {
          plant: requestBody.plant || null,
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
async function fetchAllBOMHeaders(
  filters: SyncRequestBody,
  debug: DebugInfo
): Promise<SAPMaterialBOM[]> {
  const allHeaders: SAPMaterialBOM[] = [];
  let skip = 0;
  let hasMore = true;
  let pageCount = 0;

  const filterParams: string[] = [];
  if (filters.plant) {
    filterParams.push(`Plant eq '${filters.plant}'`);
  }
  if (filters.material_codes && filters.material_codes.length > 0) {
    // SAP OData IN operator format
    const materialFilter = filters.material_codes.map(m => `Material eq '${m}'`).join(' or ');
    filterParams.push(`(${materialFilter})`);
  }

  const filterQuery = filterParams.length > 0
    ? `$filter=${filterParams.join(' and ')}&`
    : '';

  while (hasMore) {
    pageCount++;
    if (filters.max_pages && pageCount > filters.max_pages) {
      console.log(`[BOM SYNC] Reached max_pages limit: ${filters.max_pages}`);
      break;
    }

    const url = `${SAP_BASE_URL}/MaterialBOM?${filterQuery}$select=BillOfMaterial,BillOfMaterialCategory,BillOfMaterialVariant,Material,Plant,BillOfMaterialHeaderUUID&$top=${PAGE_SIZE}&$skip=${skip}&$format=json`;

    console.log(`[BOM SYNC] Requesting BOM headers: ${url}`);

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

    debug.sap_status_headers = response.status;
    console.log(`[BOM SYNC] BOM headers API status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BOM SYNC] BOM headers API error: ${response.status} - ${errorText}`);
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // OData V2: results are in data.d.results
    const results = data.d?.results || [];
    console.log(`[BOM SYNC] BOM headers response: ${results.length} items`);

    // Log first result's keys for debugging field names
    if (results.length > 0 && allHeaders.length === 0) {
      const headerKeys = Object.keys(results[0]);
      console.log(`[BOM SYNC] MaterialBOM fields: ${headerKeys.join(', ')}`);
      debug.sample_headers_keys = headerKeys; // ALL header fields
      debug.sample_edges.push(`HEADER_FIELDS: ${headerKeys.join(', ')}`);
      
      // Also log a sample record to see the structure
      debug.sample_edges.push(`HEADER_SAMPLE: ${JSON.stringify(results[0], null, 2)}`);
    }

    allHeaders.push(...results.map((r: any) => ({
      BillOfMaterial: r.BillOfMaterial || '',
      Material: r.Material || '',
      Plant: r.Plant || '',
      BillOfMaterialCategory: r.BillOfMaterialCategory || '',
      BillOfMaterialVariant: r.BillOfMaterialVariant || '',
      BillOfMaterialHeaderUUID: r.BillOfMaterialHeaderUUID || '',
    })));

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  return allHeaders;
}

async function fetchAllBOMItems(
  filters: SyncRequestBody,
  debug: DebugInfo
): Promise<SAPMaterialBOMItem[]> {
  const allItems: SAPMaterialBOMItem[] = [];
  let skip = 0;
  let hasMore = true;
  let pageCount = 0;

  const filterParams: string[] = [];
  if (filters.plant) {
    filterParams.push(`Plant eq '${filters.plant}'`);
  }

  const filterQuery = filterParams.length > 0
    ? `$filter=${filterParams.join(' and ')}&`
    : '';

  while (hasMore) {
    pageCount++;
    if (filters.max_pages && pageCount > filters.max_pages) {
      console.log(`[BOM SYNC] Reached max_pages limit for items: ${filters.max_pages}`);
      break;
    }

    const url = `${SAP_BASE_URL}/MaterialBOMItem?${filterQuery}$select=BillOfMaterial,BillOfMaterialCategory,BillOfMaterialVariant,BillOfMaterialItemNodeNumber,Material,BillOfMaterialComponent,BillOfMaterialItemQuantity,BillOfMaterialItemUnit,Plant,BillOfMaterialHeaderUUID,IsDeleted&$top=${PAGE_SIZE}&$skip=${skip}&$format=json`;

    console.log(`[BOM SYNC] Requesting BOM items: ${url}`);

    const response = await fetch(url, {
      headers: {
        'apikey': SAP_API_KEY,
        'Accept': 'application/json',
      },
    });

    debug.sap_status_items = response.status;
    console.log(`[BOM SYNC] BOM items API status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BOM SYNC] BOM items API error: ${response.status} - ${errorText}`);
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // OData V2: results are in data.d.results
    const results = data.d?.results || [];
    console.log(`[BOM SYNC] BOM items response: ${results.length} items`);

    // Log first result's keys for debugging field names
    if (results.length > 0 && allItems.length === 0) {
      const itemKeys = Object.keys(results[0]);
      console.log(`[BOM SYNC] MaterialBOMItem fields: ${itemKeys.join(', ')}`);
      debug.sample_items_keys = itemKeys; // ALL item fields
      debug.sample_edges.push(`ITEM_FIELDS: ${itemKeys.join(', ')}`);
      
      // Also log a sample record to see the structure
      debug.sample_edges.push(`ITEM_SAMPLE: ${JSON.stringify(results[0], null, 2)}`);
    }

    allItems.push(...results.map((r: any) => ({
      BillOfMaterialItemNodeNumber: r.BillOfMaterialItemNodeNumber || '',
      BillOfMaterial: r.BillOfMaterial || '',
      Material: r.Material || '',
      BillOfMaterialComponent: r.BillOfMaterialComponent || '',
      BillOfMaterialItemQuantity: parseFloat(r.BillOfMaterialItemQuantity) || 0,
      BillOfMaterialItemUnit: r.BillOfMaterialItemUnit || '',
      Plant: r.Plant || '',
      BillOfMaterialHeaderUUID: r.BillOfMaterialHeaderUUID || '',
      IsDeleted: r.IsDeleted === true || r.IsDeleted === 'X',
    })));

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  return allItems;
}

// Build BOM edges by joining headers with items
function buildBOMEdges(
  headers: SAPMaterialBOM[],
  items: SAPMaterialBOMItem[],
  debug: DebugInfo
): (BOMEdgeRecord & { isDeleted: boolean })[] {
  const edges: (BOMEdgeRecord & { isDeleted: boolean })[] = [];

  // Create a map of BOM headers for quick lookup using flexible join keys
  const headerMap = new Map<string, SAPMaterialBOM>();
  for (const header of headers) {
    // Primary key: BillOfMaterial + Plant
    const primaryKey = `${header.BillOfMaterial}_${header.Plant}`;
    headerMap.set(primaryKey, header);
    
    // Secondary key with variant (if variant exists)
    if (header.BillOfMaterialVariant && header.BillOfMaterialVariant !== 'undefined' && header.BillOfMaterialVariant !== '') {
      const variantKey = `${header.BillOfMaterial}_${header.BillOfMaterialVariant}_${header.Plant}`;
      headerMap.set(variantKey, header);
    }
  }

  // Add debug info for first few headers
  debug.sample_edges.push(`HEADER_KEYS_SAMPLE: ${headers.slice(0, 3).map(h => 
    `${h.BillOfMaterial}_${h.BillOfMaterialVariant || 'NULL'}_${h.Plant}`
  ).join(', ')}`);

  for (const item of items) {
    // Try primary key first (BillOfMaterial + Plant)
    let headerKey = `${item.BillOfMaterial}_${item.Plant}`;
    let header = headerMap.get(headerKey);
    
    // If not found and item has variant, try variant key
    if (!header && item.BillOfMaterialVariant && item.BillOfMaterialVariant !== 'undefined' && item.BillOfMaterialVariant !== '') {
      headerKey = `${item.BillOfMaterial}_${item.BillOfMaterialVariant}_${item.Plant}`;
      header = headerMap.get(headerKey);
    }

    if (!header) {
      console.warn(`[BOM SYNC] No header found for item: ${item.BillOfMaterial} variant ${item.BillOfMaterialVariant} in plant ${item.Plant}`);
      debug.errors.push(`JOIN_MISS: ${item.BillOfMaterial}_${item.BillOfMaterialVariant || 'NULL'}_${item.Plant}`);
      continue;
    }

    edges.push({
      user_id: INTEGRATION_USER_ID,
      parent_material: item.Material,
      child_material: item.BillOfMaterialComponent,
      qty_per: item.BillOfMaterialItemQuantity,
      uom: item.BillOfMaterialItemUnit,
      plant_id: item.Plant,
      alt_group: header.BillOfMaterialVariant || null,
      priority: 1, // Default priority, can be adjusted based on BOM variant
      valid_from: null,
      valid_to: null,
      source: 'sap_sync',
      sap_bom_id: item.BillOfMaterialItemNodeNumber,
      isDeleted: item.IsDeleted || false,
    });
  }

  // Add debug info for first few items
  debug.sample_edges.push(`ITEM_KEYS_SAMPLE: ${items.slice(0, 3).map(i => 
    `${i.BillOfMaterial}_${i.BillOfMaterialVariant || 'NULL'}_${i.Plant}`
  ).join(', ')}`);

  return edges;
}

// ============================================
// Database Operations
// ============================================
async function batchUpsertBOMEdges(
  supabase: any,
  edges: (BOMEdgeRecord & { isDeleted: boolean })[],
  debug: DebugInfo
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  // Remove the isDeleted field before upserting (not a DB column)
  const recordsToUpsert = edges.map(({ isDeleted, ...record }) => {
    // Ensure all required fields exist and handle missing optional fields
    return {
      user_id: record.user_id,
      parent_material: record.parent_material,
      child_material: record.child_material,
      qty_per: record.qty_per,
      uom: record.uom,
      plant_id: record.plant_id || null,
      alt_group: record.alt_group || null,
      priority: record.priority || 1,
      valid_from: record.valid_from || null,
      valid_to: record.valid_to || null,
      source: record.source || 'sap_sync',
      sap_bom_id: record.sap_bom_id || null,
      // Don't include bom_version, scrap_rate, yield_rate, etc. as they may not exist
    };
  });

  // Deduplicate records within the same batch to avoid "cannot affect row a second time" error
  const deduplicatedRecords = new Map();
  for (const record of recordsToUpsert) {
    const key = `${record.user_id}_${record.parent_material}_${record.child_material}_${record.plant_id}`;
    deduplicatedRecords.set(key, record);
  }

  const uniqueRecords = Array.from(deduplicatedRecords.values());
  console.log(`[BOM SYNC] Deduplicated ${recordsToUpsert.length} records to ${uniqueRecords.length} unique records`);
  console.log(`[BOM SYNC] Sample record: ${JSON.stringify(uniqueRecords[0], null, 2)}`);

  for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
    const chunk = uniqueRecords.slice(i, i + BATCH_SIZE);

    try {
      const { error } = await supabase
        .from('bom_edges')
        .upsert(chunk, {
          onConflict: 'user_id,parent_material,child_material,plant_id',
          ignoreDuplicates: false,
        });

      if (error) {
        console.error(`[BOM SYNC] Batch ${i / BATCH_SIZE + 1} error:`, error);
        console.error(`[BOM SYNC] Sample failing record:`, JSON.stringify(chunk[0], null, 2));
        debug.db_errors.push(`Batch ${i / BATCH_SIZE + 1}: ${error.message || JSON.stringify(error)}`);
        debug.db_errors.push(`Sample record: ${JSON.stringify(chunk[0], null, 2)}`);
        errors += chunk.length;
      } else {
        upserted += chunk.length;
        console.log(`[BOM SYNC] Batch ${i / BATCH_SIZE + 1} success: ${chunk.length} records`);
      }
    } catch (err) {
      console.error(`[BOM SYNC] Batch ${i / BATCH_SIZE + 1} exception:`, err);
      debug.db_errors.push(`Batch ${i / BATCH_SIZE + 1} exception: ${err.message || JSON.stringify(err)}`);
      errors += chunk.length;
    }
  }

  return { upserted, errors };
}
