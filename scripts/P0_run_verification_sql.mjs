/**
 * P0-1: 執行 S1~S4 SQL 驗證查詢
 * 用法: node scripts/P0_run_verification_sql.mjs
 */
import { createClient } from '@supabase/supabase-js';

// Supabase credentials
const SUPABASE_URL = 'https://cbvxqqqulwytdblivtoe.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNieHZxcXF1bHd5dGRibGl2dG9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NjQzNjUsImV4cCI6MjA4MDA0MDM2NX0.3PeFtqJAkoxrosFeAiXbOklRCDxaQjH2VjXWwEiFyYI';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    headers: JSON_HEADERS
  }
});

async function runQuery(name, sql) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${name}`);
  console.log('='.repeat(70));
  
  try {
    const { data, error } = await supabase.rpc('exec_sql', { sql }, { headers: JSON_HEADERS });
    
    if (error) {
      console.error('Error:', error.message);
      return null;
    }
    
    if (data && data.length > 0) {
      console.table(data.slice(0, 20));
      console.log(`\n(顯示前 ${Math.min(data.length, 20)} 行，共 ${data.length} 行)`);
    } else {
      console.log('(無資料)');
    }
    return data;
  } catch (err) {
    console.error('Exception:', err.message);
    return null;
  }
}

async function runDirectQuery(name, table, select, options = {}) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${name}`);
  console.log('='.repeat(70));
  
  try {
    let query = supabase.from(table).select(select);
    
    if (options.eq) {
      query = query.eq(options.eq.col, options.eq.val);
    }
    if (options.order) {
      query = query.order(options.order, { ascending: false });
    }
    if (options.limit) {
      query = query.limit(options.limit);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error:', error.message);
      return null;
    }
    
    if (data && data.length > 0) {
      console.table(data.slice(0, 20));
      console.log(`\n(顯示前 ${Math.min(data.length, 20)} 行，共 ${data.length} 行)`);
    } else {
      console.log('(無資料)');
    }
    return data;
  } catch (err) {
    console.error('Exception:', err.message);
    return null;
  }
}

async function main() {
  console.log('P0-1: S1~S4 驗證查詢');
  console.log(`URL: ${SUPABASE_URL}`);
  
  // S3 & S4: 用 REST API 查詢
  await runDirectQuery('S3: forecast_runs (kind=demand_forecast)', 
    'forecast_runs', 
    'id,created_at,scenario_name,parameters',
    { order: 'created_at', limit: 5 }
  );
  
  await runDirectQuery('S4: demand_forecast (latest 20)', 
    'demand_forecast', 
    'material_code,plant_id,time_bucket,p10,p50,p90,model_version,train_window_buckets',
    { order: 'created_at', limit: 20 }
  );
  
  // 嘗試用 RPC 執行 S1/S2
  console.log('\n' + '='.repeat(70));
  console.log('嘗試用 RPC 執行 S1/S2 (information_schema/pg_constraint)...');
  console.log('='.repeat(70));
  
  const s1Result = await runQuery('S1: demand_forecast columns (information_schema)', 
    `SELECT column_name, data_type, is_nullable 
     FROM information_schema.columns 
     WHERE table_schema='public' AND table_name='demand_forecast' 
     ORDER BY ordinal_position`
  );
  
  const s2Result = await runQuery('S2: demand_forecast constraints', 
    `SELECT conname, pg_get_constraintdef(c.oid) as def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'demand_forecast' AND c.contype IN ('u','p')
     ORDER BY conname`
  );
  
  // 如果 RPC 失敗，給出提示
  if (!s1Result && !s2Result) {
    console.log('\n' + '='.repeat(70));
    console.log('⚠️ S1/S2 無法透過 REST API 執行 (需要 exec_sql RPC 權限)');
    console.log('請在 Supabase Dashboard → SQL Editor 手動執行 P0_VERIFICATION_SQL.sql');
    console.log('='.repeat(70));
  }
  
  // 額外驗證 P0-2 和 P0-3
  console.log('\n' + '='.repeat(70));
  console.log('P0-2 / P0-3 驗證: BOM runs 與 trace 追溯');
  console.log('='.repeat(70));
  
  await runDirectQuery('BOM runs with demand_source', 
    'forecast_runs', 
    'id,created_at,scenario_name,parameters,input_batch_ids',
    { order: 'created_at', limit: 5 }
  );
  
  await runDirectQuery('component_demand_trace (latest 10)', 
    'component_demand_trace', 
    'id,component_demand_id,fg_demand_id,bom_level,trace_meta,created_at',
    { order: 'created_at', limit: 10 }
  );
}

main().catch(console.error);
