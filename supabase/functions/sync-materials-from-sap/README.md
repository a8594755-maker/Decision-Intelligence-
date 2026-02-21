# SAP Materials Sync Edge Function

Read-only sync from SAP OData V2 to Decision-Intelligence materials table.

## Environment Variables

Add to your Supabase project settings:

```bash
SAP_API_KEY=your_sandbox_api_key_here
INTEGRATION_USER_ID=uuid_of_integration_user
SAP_BASE_URL=https://sandbox.api.sap.com/s4hanacloud  # optional, defaults to sandbox
```

## Deployment

```bash
# Deploy the function
supabase functions deploy sync-materials-from-sap

# Set secrets (if not already configured via dashboard)
supabase secrets set SAP_API_KEY=your_key
supabase secrets set INTEGRATION_USER_ID=user_uuid
supabase secrets set SAP_BASE_URL=https://sandbox.api.sap.com/s4hanacloud
```

## Test with curl

### Local testing
```bash
curl -X POST http://localhost:54321/functions/v1/sync-materials-from-sap \
  -H "Authorization: Bearer YOUR_SUPABASE_TOKEN" \
  -H "Content-Type: application/json"
```

### Production testing
```bash
curl -X POST https://your-project.supabase.co/functions/v1/sync-materials-from-sap \
  -H "Authorization: Bearer YOUR_SUPABASE_TOKEN" \
  -H "Content-Type: application/json"
```

## Expected Response

```json
{
  "success": true,
  "stats": {
    "fetched": 1500,
    "upserted": 1450,
    "skipped": 50,
    "errors": 0
  },
  "duration_ms": 12345
}
```

## SQL Verification Queries

### 1. Check sync results for integration user
```sql
SELECT 
  user_id,
  COUNT(*) as total_materials,
  COUNT(DISTINCT category) as categories,
  MIN(created_at) as first_sync,
  MAX(updated_at) as last_update
FROM materials
WHERE user_id = 'YOUR_INTEGRATION_USER_ID'::uuid
GROUP BY user_id;
```

### 2. Verify sample materials with descriptions
```sql
SELECT 
  material_code,
  material_name,
  uom,
  category,
  created_at,
  updated_at
FROM materials
WHERE user_id = 'YOUR_INTEGRATION_USER_ID'::uuid
ORDER BY material_code
LIMIT 20;
```

### 3. Check for materials without proper names (fallback applied)
```sql
SELECT 
  material_code,
  material_name,
  CASE 
    WHEN material_name = material_code THEN 'fallback_applied'
    ELSE 'description_found'
  END as name_status
FROM materials
WHERE user_id = 'YOUR_INTEGRATION_USER_ID'::uuid
ORDER BY material_code;
```

### 4. Category distribution
```sql
SELECT 
  COALESCE(category, 'N/A') as category,
  COUNT(*) as material_count
FROM materials
WHERE user_id = 'YOUR_INTEGRATION_USER_ID'::uuid
GROUP BY category
ORDER BY material_count DESC;
```

## Architecture

### SAP API Endpoints
1. **A_Product**: Fetches product master data
   - Fields: Product, BaseUnit, ProductGroup, IsMarkedForDeletion
   - Pagination: $top=5000, $skip=N

2. **A_ProductDescription**: Fetches product descriptions
   - First pass: Language eq 'EN'
   - Second pass: Any language for missing EN descriptions

### Data Mapping
| SAP Field | materials Column | Notes |
|-----------|-------------------|-------|
| Product | material_code | Primary key component |
| ProductDescription | material_name | EN优先，缺失时尝试任意语言，最后回退到Product |
| BaseUnit | uom | Defaults to 'pcs' if null |
| ProductGroup | category | Nullable |

### Processing Flow
1. Fetch all active products (IsMarkedForDeletion=false)
2. Fetch EN descriptions
3. Fetch any-language descriptions for missing entries
4. Join data on Product key
5. Batch upsert 200 records per transaction
6. Return statistics

## Migration

Run the constraint verification migration before first sync:

```bash
psql -f sql/migrations/verify_materials_constraint.sql
```

Or via Supabase Dashboard SQL Editor.
