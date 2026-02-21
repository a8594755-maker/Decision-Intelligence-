// ============================================
// SAP Demand FG Sync Edge Function
// ============================================
// Purpose: Sync Finished Goods demand from SAP to demand_fg table
// Environment: SAP_API_KEY, INTEGRATION_USER_ID, SAP_BASE_URL (optional)
// API: API_PLANNED_INDEPENDENT_REQMT_SRV
// Entities: PlannedIndepReqnt
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SAP_API_KEY = Deno.env.get('SAP_API_KEY')!;
const INTEGRATION_USER_ID = Deno.env.get('INTEGRATION_USER_ID')!;
const FRONTEND_ORIGIN = (Deno.env.get('FRONTEND_ORIGIN') || 'http://localhost:5173').trim();

// Read demand-specific base URL or fall back to generic SAP_BASE_URL
const SAP_BASE_URL_INPUT = Deno.env.get('SAP_DEMAND_BASE_URL') || Deno.env.get('SAP_BASE_URL') || 'https://sandbox.api.sap.com/s4hanacloud';

// URL normalization: always construct correct service URL regardless of what base contains
const SERVICE_NAME = 'API_PLND_INDEP_RQMT_SRV';

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

// Constants
const BATCH_SIZE = 200;
const PAGE_SIZE = 200;

// Types
interface SAPPlannedIndepReqnt {
  PlannedIndepReqnt: string;
  Material: string;
  Plant: string;
  RequirementDate: string;
  Quantity: number;
  RequirementUnit: string;
  MRPController: string;
  Version: string;
  RequirementType: string;
  StorageLocation: string;
  IsDeleted?: boolean;
}

interface DemandFGRecord {
  user_id: string;
  material_code: string;
  plant_id: string;
  time_bucket: string;
  demand_qty: number;
  uom: string;
  source: string;
  created_at: string;
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
  fetched_demand: number;
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

async function fetchAllDemandFG(
  requestBody: SyncRequestBody,
  debug: DebugInfo
): Promise<SAPPlannedIndepReqnt[]> {
  const { plant, material_codes, max_pages } = requestBody;
  let allDemand: SAPPlannedIndepReqnt[] = [];
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
      break;
    }

    // Use correct entity name: A_PlannedIndependentRequirement
    const url = `${SAP_BASE_URL}/A_PlannedIndependentRequirement?${filterQuery}$top=${PAGE_SIZE}&$skip=${skip}&$format=json`;

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
      
      // If response is HTML (403/500 error page), treat as generic error
      if (errorText.includes('<!DOCTYPE html>') || errorText.includes('<html>')) {
        throw new Error(`SAP API error (${response.status}): Service temporarily unavailable`);
      }
      
      // If A_PlannedIndependentRequirement fails with 404, try PlannedIndepRqmt
      if (response.status === 404) {
        const fallbackUrl = `${SAP_BASE_URL}/PlannedIndepRqmt?${filterQuery}$top=${PAGE_SIZE}&$skip=${skip}&$format=json`;
        
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
        
        // Log first result's keys for debugging field names
        if (fallbackResults.length > 0 && allDemand.length === 0) {
          const itemKeys = Object.keys(fallbackResults[0]);
          debug.sample_records.push(`DEMAND_FIELDS: ${itemKeys.join(', ')}`);
          debug.sample_records.push(`DEMAND_SAMPLE: ${JSON.stringify(fallbackResults[0], null, 2)}`);
        }
        
        // Filter for active items and map to our format
        const activeDemand = fallbackResults
          .filter((r: any) => !r.IsDeleted || r.IsDeleted !== 'X')
          .map((r: any) => ({
            PlannedIndepReqnt: r.PlannedIndepReqnt || '',
            Material: r.Material || '',
            Plant: r.Plant || '',
            RequirementDate: r.RequirementDate || '',
            Quantity: parseFloat(r.Quantity) || 0,
            RequirementUnit: r.RequirementUnit || '',
            MRPController: r.MRPController || '',
            Version: r.Version || '',
            RequirementType: r.RequirementType || '',
            StorageLocation: r.StorageLocation || '',
            IsDeleted: r.IsDeleted === true || r.IsDeleted === 'X',
          }));
        
        allDemand.push(...activeDemand);
        hasMore = fallbackResults.length === PAGE_SIZE;
        skip += PAGE_SIZE;
        continue;
      }
      
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // OData V2: results are in data.d.results
    const results = data.d?.results || [];

    // Log first result's keys for debugging field names
    if (results.length > 0 && allDemand.length === 0) {
      const itemKeys = Object.keys(results[0]);
      debug.sample_records.push(`DEMAND_FIELDS: ${itemKeys.join(', ')}`);
      
      // Also log a sample record to see the structure
      debug.sample_records.push(`DEMAND_SAMPLE: ${JSON.stringify(results[0], null, 2)}`);
    }

    // Filter for active items (not deleted) and map to our format
    const activeDemand = results
      .filter((r: any) => !r.IsDeleted || r.IsDeleted !== 'X')
      .map((r: any) => ({
        PlannedIndepReqnt: r.PlannedIndepReqnt || '',
        Material: r.Material || '',
        Plant: r.Plant || '',
        RequirementDate: r.RequirementDate || '',
        Quantity: parseFloat(r.Quantity) || 0,
        RequirementUnit: r.RequirementUnit || '',
        MRPController: r.MRPController || '',
        Version: r.Version || '',
        RequirementType: r.RequirementType || '',
        StorageLocation: r.StorageLocation || '',
        IsDeleted: r.IsDeleted === true || r.IsDeleted === 'X',
      }));

    allDemand.push(...activeDemand);

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  return allDemand;
}

// ============================================
// Database Operations
// ============================================

async function batchUpsertDemandFG(
  supabase: any,
  demand: SAPPlannedIndepReqnt[],
  debug: DebugInfo
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  // Map SAP demand to our database format
  const recordsToUpsert = demand.map(item => ({
    user_id: INTEGRATION_USER_ID,
    material_code: item.Material || 'UNKNOWN_MATERIAL', // Handle empty Material
    plant_id: item.Plant || 'UNKNOWN_PLANT', // Handle empty Plant
    time_bucket: item.RequirementDate ? item.RequirementDate.substring(0, 10) : new Date().toISOString().substring(0, 10), // Convert to YYYY-MM-DD format
    demand_qty: item.Quantity || 0,
    uom: item.RequirementUnit || 'PC',
    source: 'sap_sync',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  console.log(`[DEMAND SYNC] Attempting to upsert ${recordsToUpsert.length} records`);
  console.log(`[DEMAND SYNC] Sample record: ${JSON.stringify(recordsToUpsert[0], null, 2)}`);

  // Deduplicate records within the same batch to avoid "cannot affect row a second time" error
  const deduplicatedRecords = new Map();
  for (const record of recordsToUpsert) {
    const key = `${record.user_id}_${record.material_code}_${record.plant_id}_${record.time_bucket}`;
    deduplicatedRecords.set(key, record);
  }

  const uniqueRecords = Array.from(deduplicatedRecords.values());

  for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
    const chunk = uniqueRecords.slice(i, i + BATCH_SIZE);

    try {
      const { error } = await supabase
        .from('demand_fg')
        .upsert(chunk, {
          onConflict: 'user_id,material_code,plant_id,time_bucket',
          ignoreDuplicates: false,
        });

      if (error) {
        debug.sample_records.push(`Batch ${i / BATCH_SIZE + 1} error: ${error.message || JSON.stringify(error)}`);
        errors += chunk.length;
      } else {
        upserted += chunk.length;
      }
    } catch (err) {
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
  const corsHeaders = {
    'Access-Control-Allow-Origin': FRONTEND_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const requestBody: SyncRequestBody = await req.json();
    const startTime = Date.now();
    const stats: SyncStats = { fetched: 0, upserted: 0, skipped: 0, errors: 0 };
    const debug: DebugInfo = {
      sap_status: 0,
      fetched_demand: 0,
      upserted_count: 0,
      sample_records: [],
      errors: [],
    };

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch demand FG from SAP
    const demandFG = await fetchAllDemandFG(requestBody, debug);
    stats.fetched = demandFG.length;
    debug.fetched_demand = demandFG.length;

    // Get sample records for debugging
    debug.sample_records = demandFG.slice(0, 3).map(item =>
      `${item.PlannedIndepReqnt}: ${item.Material} @ ${item.Plant} (${item.Quantity} ${item.RequirementUnit}) on ${item.RequirementDate}`
    );

    // Batch upsert to database
    const upsertResult = await batchUpsertDemandFG(supabase, demandFG, debug);
    stats.upserted = upsertResult.upserted;
    stats.errors = upsertResult.errors;
    debug.upserted_count = upsertResult.upserted;

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
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        debug: { errors: [error.message] }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
