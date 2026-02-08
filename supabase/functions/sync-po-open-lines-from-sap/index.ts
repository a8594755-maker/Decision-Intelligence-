// ============================================
// SAP PO Open Lines Sync Edge Function
// ============================================
// Purpose: Sync open PO items from SAP to po_open_lines table
// Environment: SAP_API_KEY, INTEGRATION_USER_ID, SAP_BASE_URL (optional)
// API: API_PURCHASEORDER_PROCESS_SRV
// Entities: PurchaseOrder + PurchaseOrderItem
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SAP_API_KEY = Deno.env.get('SAP_API_KEY')!;
const INTEGRATION_USER_ID = Deno.env.get('INTEGRATION_USER_ID')!;

// Read PO-specific base URL or fall back to generic SAP_BASE_URL
const SAP_BASE_URL_INPUT = Deno.env.get('SAP_PO_BASE_URL') || Deno.env.get('SAP_BASE_URL') || 'https://sandbox.api.sap.com/s4hanacloud';

// URL normalization: always construct correct service URL regardless of what base contains
const SERVICE_NAME = 'API_PURCHASEORDER_PROCESS_SRV';

function buildSapServiceUrl(baseUrl: string, serviceName: string): string {
  const cleaned = baseUrl.replace(/\/+$/, '');
  const odataSegment = '/sap/opu/odata/sap';

  // If base already contains /sap/opu/odata/sap/, strip everything from that point
  // to remove any old/wrong service name baked into the env var
  const idx = cleaned.indexOf(odataSegment);
  const root = idx >= 0 ? cleaned.substring(0, idx) : cleaned;

  return `${root}${odataSegment}/${serviceName}`;
}

const SAP_BASE_URL = buildSapServiceUrl(SAP_BASE_URL_INPUT, SERVICE_NAME);

console.log(`[PO SYNC] SAP_BASE_URL resolved: ${SAP_BASE_URL}`);
console.log(`[PO SYNC] Original input: ${SAP_BASE_URL_INPUT}`);

// Constants
const BATCH_SIZE = 200;
const PAGE_SIZE = 200;

// Types
interface SAPPurchaseOrder {
  PurchaseOrder: string;
  CompanyCode: string;
  DocumentDate: string;
  Vendor: string;
  PurchasingOrganization: string;
  PurchasingGroup: string;
  PaymentTerms: string;
  Currency: string;
  ExchangeRate: number;
  DocumentCurrency: string;
  ValidityStartDate?: string;
  ValidityEndDate?: string;
}

interface SAPPurchaseOrderItem {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  Material: string;
  MaterialGroup: string;
  Plant: string;
  StorageLocation: string;
  Quantity: number;
  OrderQuantityUnit: string;
  NetPrice: number;
  Currency: string;
  DeliveryDate: string;
  MaterialGroupDescription?: string;
  MaterialDescription?: string;
  IsDeleted?: boolean;
}

interface POOpenLineRecord {
  user_id: string;
  material_code: string;
  plant_id: string;
  po_number: string;
  po_item: string;
  vendor_code: string;
  qty_open: number;
  uom: string;
  delivery_date: string;
  source: string;
  updated_at: string;
}

interface SyncStats {
  fetched: number;
  upserted: number;
  skipped: number;
  errors: number;
}

interface DebugInfo {
  sap_status: number;
  fetched_po: number;
  upserted_count: number;
  sample_records: string[];
  errors: string[];
  final_request_url?: string;
}

interface SyncRequestBody {
  plant?: string;
  material_codes?: string[];
  max_pages?: number;
}

// ============================================
// SAP API Operations
// ============================================

async function fetchAllPOItems(
  requestBody: SyncRequestBody,
  debug: DebugInfo
): Promise<SAPPurchaseOrderItem[]> {
  const { plant, material_codes, max_pages } = requestBody;
  let allItems: SAPPurchaseOrderItem[] = [];
  let hasMore = true;
  let skip = 0;
  let pageCount = 0;

  // Build filter parameters
  const filterParams = [];
  if (plant) {
    filterParams.push(`Plant eq '${plant}'`);
  }
  if (material_codes && material_codes.length > 0) {
    const materialFilter = material_codes.map(code => `Material eq '${code}'`).join(' or ');
    filterParams.push(`(${materialFilter})`);
  }

  const filterQuery = filterParams.length > 0
    ? `$filter=${filterParams.join(' and ')}&`
    : '';

  while (hasMore) {
    pageCount++;
    if (max_pages && pageCount > max_pages) {
      console.log(`[PO SYNC] Reached max_pages limit: ${max_pages}`);
      break;
    }

    // Try A_PurchaseOrderItem without $select first to discover field names
    const url = `${SAP_BASE_URL}/A_PurchaseOrderItem?${filterQuery}$top=${PAGE_SIZE}&$skip=${skip}&$format=json`;

    console.log(`[PO SYNC] Requesting PO items: ${url}`);

    // Store the final URL for debugging (only on first request)
    if (!debug.final_request_url) {
      debug.final_request_url = url;
    }

    const response = await fetch(url, {
      headers: {
        'apikey': SAP_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[PO SYNC] PO items API error: ${response.status} - ${errorText}`);
      
      // If A_PurchaseOrderItem fails, try PurchaseOrderItem
      if (response.status === 404 && !url.includes('PurchaseOrderItem')) {
        console.log('[PO SYNC] A_PurchaseOrderItem not found, trying PurchaseOrderItem...');
        const fallbackUrl = `${SAP_BASE_URL}/PurchaseOrderItem?${filterQuery}$select=PurchaseOrder,PurchaseOrderItem,Material,Plant,StorageLocation,Quantity,OrderQuantityUnit,NetPrice,Currency,DeliveryDate,IsDeleted&$top=${PAGE_SIZE}&$skip=${skip}&$format=json`;
        
        const fallbackResponse = await fetch(fallbackUrl, {
          headers: {
            'apikey': SAP_API_KEY,
            'Accept': 'application/json',
          },
        });
        
        if (!fallbackResponse.ok) {
          throw new Error(`SAP API error (${fallbackResponse.status}): ${await fallbackResponse.text()}`);
        }
        
        const fallbackData = await fallbackResponse.json();
        const fallbackResults = fallbackData.d?.results || [];
        console.log(`[PO SYNC] Fallback PO items response: ${fallbackResults.length} items`);
        
        // Log first result's keys for debugging field names
        if (fallbackResults.length > 0 && allItems.length === 0) {
          const itemKeys = Object.keys(fallbackResults[0]);
          console.log(`[PO SYNC] PurchaseOrderItem fields: ${itemKeys.join(', ')}`);
          debug.sample_records.push(`ITEM_FIELDS: ${itemKeys.join(', ')}`);
          debug.sample_records.push(`ITEM_SAMPLE: ${JSON.stringify(fallbackResults[0], null, 2)}`);
        }
        
        // Filter for open items and map to our format
        const openItems = fallbackResults
          .filter((r: any) => !r.IsDeleted || r.IsDeleted !== 'X')
          .map((r: any) => ({
            PurchaseOrder: r.PurchaseOrder || '',
            PurchaseOrderItem: r.PurchaseOrderItem || '',
            Material: r.Material || '',
            Plant: r.Plant || '',
            StorageLocation: r.StorageLocation || '',
            Quantity: parseFloat(r.Quantity) || 0,
            OrderQuantityUnit: r.OrderQuantityUnit || '',
            NetPrice: parseFloat(r.NetPrice) || 0,
            Currency: r.Currency || '',
            DeliveryDate: r.DeliveryDate || '',
            IsDeleted: r.IsDeleted === true || r.IsDeleted === 'X',
          }));
        
        allItems.push(...openItems);
        hasMore = fallbackResults.length === PAGE_SIZE;
        skip += PAGE_SIZE;
        continue;
      }
      
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // OData V2: results are in data.d.results
    const results = data.d?.results || [];
    console.log(`[PO SYNC] PO items response: ${results.length} items`);

    // Log first result's keys for debugging field names
    if (results.length > 0 && allItems.length === 0) {
      const itemKeys = Object.keys(results[0]);
      console.log(`[PO SYNC] A_PurchaseOrderItem fields: ${itemKeys.join(', ')}`);
      debug.sample_records.push(`ITEM_FIELDS: ${itemKeys.join(', ')}`);
      
      // Also log a sample record to see the structure
      debug.sample_records.push(`ITEM_SAMPLE: ${JSON.stringify(results[0], null, 2)}`);
    }

    // Filter for open items (not deleted) and map to our format
    const openItems = results
      .filter((r: any) => !r.IsDeleted || r.IsDeleted !== 'X')
      .map((r: any) => ({
        PurchaseOrder: r.PurchaseOrder || '',
        PurchaseOrderItem: r.PurchaseOrderItem || '',
        Material: r.Material || '',
        Plant: r.Plant || '',
        StorageLocation: r.StorageLocation || '',
        Quantity: parseFloat(r.Quantity) || 0,
        OrderQuantityUnit: r.OrderQuantityUnit || '',
        NetPrice: parseFloat(r.NetPrice) || 0,
        Currency: r.Currency || '',
        DeliveryDate: r.DeliveryDate || '',
        IsDeleted: r.IsDeleted === true || r.IsDeleted === 'X',
      }));

    allItems.push(...openItems);

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  return allItems;
}

// ============================================
// Database Operations
// ============================================

async function batchUpsertPOLines(
  supabase: any,
  items: SAPPurchaseOrderItem[],
  debug: DebugInfo
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  // Map SAP PO items to our database format
  const recordsToUpsert = items.map(item => ({
    user_id: INTEGRATION_USER_ID,
    material_code: item.Material,
    plant_id: item.Plant,
    po_number: item.PurchaseOrder,
    po_line: item.PurchaseOrderItem,
    supplier_id: '', // Will be populated from PO header if needed
    open_qty: item.Quantity,
    uom: item.OrderQuantityUnit,
    time_bucket: item.DeliveryDate ? item.DeliveryDate.substring(0, 10) : new Date().toISOString().substring(0, 10), // Convert to YYYY-MM-DD format
    status: 'open',
    source: 'sap_sync',
    updated_at: new Date().toISOString(),
  }));

  console.log(`[PO SYNC] Attempting to upsert ${recordsToUpsert.length} records`);
  console.log(`[PO SYNC] Sample record: ${JSON.stringify(recordsToUpsert[0], null, 2)}`);

  // Deduplicate records within the same batch to avoid "cannot affect row a second time" error
  const deduplicatedRecords = new Map();
  for (const record of recordsToUpsert) {
    const key = `${record.user_id}_${record.po_number}_${record.po_line}`;
    deduplicatedRecords.set(key, record);
  }

  const uniqueRecords = Array.from(deduplicatedRecords.values());
  console.log(`[PO SYNC] Deduplicated ${recordsToUpsert.length} records to ${uniqueRecords.length} unique records`);

  for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
    const chunk = uniqueRecords.slice(i, i + BATCH_SIZE);

    try {
      const { error } = await supabase
        .from('po_open_lines')
        .upsert(chunk, {
          onConflict: 'user_id,po_number,po_line,time_bucket',
          ignoreDuplicates: false,
        });

      if (error) {
        console.error(`[PO SYNC] Batch ${i / BATCH_SIZE + 1} error:`, error);
        debug.sample_records.push(`Batch ${i / BATCH_SIZE + 1} error: ${error.message || JSON.stringify(error)}`);
        errors += chunk.length;
      } else {
        upserted += chunk.length;
        console.log(`[PO SYNC] Batch ${i / BATCH_SIZE + 1} success: ${chunk.length} records`);
      }
    } catch (err) {
      console.error(`[PO SYNC] Batch ${i / BATCH_SIZE + 1} exception:`, err);
      debug.sample_records.push(`Batch ${i / BATCH_SIZE + 1} exception: ${err.message || JSON.stringify(err)}`);
      errors += chunk.length;
    }
  }

  return { upserted, errors };
}

// ============================================
// Main Handler
// ============================================

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 200, 
      headers: { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      } 
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const requestBody: SyncRequestBody = await req.json();
    const startTime = Date.now();
    const stats: SyncStats = { fetched: 0, upserted: 0, skipped: 0, errors: 0 };
    const debug: DebugInfo = {
      sap_status: 0,
      fetched_po: 0,
      upserted_count: 0,
      sample_records: [],
      errors: [],
    };

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch PO items from SAP
    console.log('[PO SYNC] Fetching PO items from SAP...');
    const poItems = await fetchAllPOItems(requestBody, debug);
    stats.fetched = poItems.length;
    debug.fetched_po = poItems.length;
    console.log(`[PO SYNC] PO items fetched: ${poItems.length}`);

    // Get sample records for debugging
    debug.sample_records = poItems.slice(0, 3).map(item =>
      `${item.PurchaseOrder}-${item.PurchaseOrderItem}: ${item.Material} @ ${item.Plant} (${item.Quantity} ${item.OrderQuantityUnit})`
    );

    // Batch upsert to database
    console.log('[PO SYNC] Starting batch upsert...');
    const upsertResult = await batchUpsertPOLines(supabase, poItems, debug);
    stats.upserted = upsertResult.upserted;
    stats.errors = upsertResult.errors;
    debug.upserted_count = upsertResult.upserted;
    console.log(`[PO SYNC] Upserted: ${upsertResult.upserted}, Errors: ${upsertResult.errors}`);

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
          max_pages: requestBody.max_pages || null,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('[PO SYNC] Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        debug: { errors: [error.message] }
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
});
