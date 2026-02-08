// ============================================
// SAP Materials Sync Edge Function
// ============================================
// Purpose: Read-only sync from SAP sandbox to materials table
// Environment: SAP_API_KEY, INTEGRATION_USER_ID, SAP_BASE_URL (optional)
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SAP_API_KEY = Deno.env.get('SAP_API_KEY')!;
const INTEGRATION_USER_ID = Deno.env.get('INTEGRATION_USER_ID')!;
const SAP_BASE_URL_INPUT = Deno.env.get('SAP_BASE_URL') || 'https://sandbox.api.sap.com/s4hanacloud';

// Fix SAP_BASE_URL: auto-append service path if not present
const SERVICE_PATH = '/sap/opu/odata/sap/API_PRODUCT_SRV';
const SAP_BASE_URL = SAP_BASE_URL_INPUT.includes(SERVICE_PATH) 
  ? SAP_BASE_URL_INPUT 
  : SAP_BASE_URL_INPUT + SERVICE_PATH;

console.log(`[SAP SYNC] SAP_BASE_URL resolved: ${SAP_BASE_URL}`);
console.log(`[SAP SYNC] Original input: ${SAP_BASE_URL_INPUT}`);

// Constants
const BATCH_SIZE = 200;
const PAGE_SIZE = 200;

// Types
interface SAPProduct {
  Product: string;
  BaseUnit: string;
  ProductGroup: string;
  IsMarkedForDeletion: boolean;
}

interface SAPProductDescription {
  Product: string;
  Language: string;
  ProductDescription: string;
}

interface MaterialRecord {
  user_id: string;
  material_code: string;
  material_name: string;
  uom: string;
  category: string | null;
}

interface SyncStats {
  fetched: number;
  upserted: number;
  skipped: number;
  errors: number;
}

interface DebugInfo {
  sap_status_products: number;
  sap_status_desc: number;
  fetched_products: number;
  fetched_desc_en: number;
  fetched_desc_any: number;
  joined_count: number;
  upserted_count: number;
  sample_product_codes: string[];
  errors: string[];
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

  const startTime = Date.now();
  const stats: SyncStats = { fetched: 0, upserted: 0, skipped: 0, errors: 0 };
  const debug: DebugInfo = {
    sap_status_products: 0,
    sap_status_desc: 0,
    fetched_products: 0,
    fetched_desc_en: 0,
    fetched_desc_any: 0,
    joined_count: 0,
    upserted_count: 0,
    sample_product_codes: [],
    errors: [],
  };

  try {
    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch all products from SAP
    console.log('[SAP SYNC] Fetching products...');
    const products = await fetchAllProducts(debug);
    stats.fetched = products.length;
    debug.fetched_products = products.length;
    console.log(`[SAP SYNC] Products fetched: ${products.length}`);

    // Fail fast if no products fetched
    if (products.length === 0) {
      throw new Error(`No products fetched from SAP. Status: ${debug.sap_status_products}`);
    }

    // Filter out deleted products
    const activeProducts = products.filter(p => !p.IsMarkedForDeletion);
    stats.skipped = products.length - activeProducts.length;
    console.log(`[SAP SYNC] Active products (not deleted): ${activeProducts.length}`);

    // Fetch descriptions (EN only first)
    console.log('[SAP SYNC] Fetching EN descriptions...');
    const descriptions = await fetchAllProductDescriptions('EN', debug);
    debug.fetched_desc_en = descriptions.length;
    console.log(`[SAP SYNC] EN descriptions fetched: ${descriptions.length}`);
    
    const descriptionMap = buildDescriptionMap(descriptions);

    // Find products missing EN description
    const missingEnDescriptions = activeProducts.filter(
      p => !descriptionMap.has(p.Product)
    );
    console.log(`[SAP SYNC] Products missing EN description: ${missingEnDescriptions.length}`);

    // Fetch any language description for missing ones
    if (missingEnDescriptions.length > 0) {
      console.log('[SAP SYNC] Fetching any-language descriptions...');
      const anyLangDescriptions = await fetchAllProductDescriptions(undefined, debug);
      debug.fetched_desc_any = anyLangDescriptions.length;
      console.log(`[SAP SYNC] Any-language descriptions fetched: ${anyLangDescriptions.length}`);
      
      const anyLangMap = buildDescriptionMap(anyLangDescriptions);

      // Merge with EN map (EN takes priority)
      for (const [product, desc] of anyLangMap) {
        if (!descriptionMap.has(product)) {
          descriptionMap.set(product, desc);
        }
      }
    }

    // Build material records
    const materials: MaterialRecord[] = activeProducts.map(product => ({
      user_id: INTEGRATION_USER_ID,
      material_code: product.Product,
      material_name: descriptionMap.get(product.Product) || product.Product,
      uom: product.BaseUnit || 'pcs',
      category: product.ProductGroup || null,
    }));
    debug.joined_count = materials.length;

    // Get sample product codes (first 3)
    debug.sample_product_codes = activeProducts.slice(0, 3).map(p => p.Product);

    // Batch upsert to database
    console.log('[SAP SYNC] Starting batch upsert...');
    const upsertResult = await batchUpsertMaterials(supabase, materials);
    stats.upserted = upsertResult.upserted;
    stats.errors = upsertResult.errors;
    debug.upserted_count = upsertResult.upserted;
    console.log(`[SAP SYNC] Upserted: ${upsertResult.upserted}, Errors: ${upsertResult.errors}`);

    const duration = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        success: stats.errors === 0 && stats.fetched > 0,
        stats,
        debug,
        duration_ms: duration,
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
async function fetchAllProducts(debug: DebugInfo): Promise<SAPProduct[]> {
  const allProducts: SAPProduct[] = [];
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const url = `${SAP_BASE_URL}/A_Product?$select=Product,BaseUnit,ProductGroup,IsMarkedForDeletion&$top=${PAGE_SIZE}&$skip=${skip}`;
    
    console.log(`[SAP SYNC] Requesting: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'apikey': SAP_API_KEY,
        'Accept': 'application/json',
      },
    });

    debug.sap_status_products = response.status;
    console.log(`[SAP SYNC] Products API status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SAP SYNC] Products API error: ${response.status} - ${errorText}`);
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    // OData V2: results are in data.d.results
    const results = data.d?.results || [];
    console.log(`[SAP SYNC] Products response: data.d.results.length = ${results.length}`);
    
    if (results.length === 0 && allProducts.length === 0) {
      console.log('[SAP SYNC] Warning: No products in first page. Response keys:', Object.keys(data));
    }
    
    allProducts.push(...results.map((r: any) => ({
      Product: r.Product,
      BaseUnit: r.BaseUnit,
      ProductGroup: r.ProductGroup,
      IsMarkedForDeletion: r.IsMarkedForDeletion === true || r.IsMarkedForDeletion === 'X',
    })));

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  return allProducts;
}

async function fetchAllProductDescriptions(
  language: string | undefined, 
  debug: DebugInfo
): Promise<SAPProductDescription[]> {
  const allDescriptions: SAPProductDescription[] = [];
  let skip = 0;
  let hasMore = true;

  const filterParam = language ? `$filter=Language eq '${language}'&` : '';

  while (hasMore) {
    const url = `${SAP_BASE_URL}/A_ProductDescription?${filterParam}$select=Product,Language,ProductDescription&$top=${PAGE_SIZE}&$skip=${skip}`;
    
    console.log(`[SAP SYNC] Requesting descriptions: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'apikey': SAP_API_KEY,
        'Accept': 'application/json',
      },
    });

    debug.sap_status_desc = response.status;
    console.log(`[SAP SYNC] Descriptions API status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SAP SYNC] Descriptions API error: ${response.status} - ${errorText}`);
      throw new Error(`SAP API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    // OData V2: results are in data.d.results
    const results = data.d?.results || [];
    console.log(`[SAP SYNC] Descriptions response: data.d.results.length = ${results.length}`);
    
    allDescriptions.push(...results.map((r: any) => ({
      Product: r.Product,
      Language: r.Language,
      ProductDescription: r.ProductDescription,
    })));

    hasMore = results.length === PAGE_SIZE;
    skip += PAGE_SIZE;
  }

  return allDescriptions;
}

function buildDescriptionMap(descriptions: SAPProductDescription[]): Map<string, string> {
  const map = new Map<string, string>();
  
  for (const desc of descriptions) {
    if (desc.ProductDescription && !map.has(desc.Product)) {
      map.set(desc.Product, desc.ProductDescription);
    }
  }
  
  return map;
}

// ============================================
// Database Operations
// ============================================
async function batchUpsertMaterials(
  supabase: any,
  materials: MaterialRecord[]
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  for (let i = 0; i < materials.length; i += BATCH_SIZE) {
    const chunk = materials.slice(i, i + BATCH_SIZE);
    
    try {
      const { error } = await supabase
        .from('materials')
        .upsert(chunk, {
          onConflict: 'user_id,material_code',
          ignoreDuplicates: false,
        });

      if (error) {
        console.error(`Batch ${i / BATCH_SIZE + 1} error:`, error);
        errors += chunk.length;
      } else {
        upserted += chunk.length;
      }
    } catch (err) {
      console.error(`Batch ${i / BATCH_SIZE + 1} exception:`, err);
      errors += chunk.length;
    }
  }

  return { upserted, errors };
}
