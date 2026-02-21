/**
 * P0-1: 執行 S1~S4 SQL 驗證查詢
 * 用法: node scripts/P0_run_verification_sql.js
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    headers: JSON_HEADERS
  }
});

const queries = {
  S1: `select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='demand_forecast'
order by ordinal_position`,

  S2: `select conname, pg_get_constraintdef(c.oid) as def
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'demand_forecast' and c.contype in ('u','p')
order by conname`,

  S3: `select id, created_at, scenario_name, parameters
from forecast_runs
where parameters->>'kind' = 'demand_forecast'
order by created_at desc
limit 5`,

  S4: `select material_code, plant_id, time_bucket, p10, p50, p90, model_version, train_window_buckets
from demand_forecast
order by created_at desc
limit 20`
};

async function runQuery(name, sql) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${name} 結果:`);
  console.log('='.repeat(60));
  
  const { data, error } = await supabase.rpc('exec_sql', { sql }, { headers: JSON_HEADERS });
  
  if (error) {
    // fallback: try direct query via REST
    const { data: data2, error: error2 } = await supabase.from('demand_forecast').select('*').limit(0);
    console.log('Direct query test:', error2 ? error2.message : 'OK');
    console.error('Error:', error.message);
    return;
  }
  
  if (data && data.length > 0) {
    console.table(data.slice(0, 20));
    console.log(`(共 ${data.length} 行)`);
  } else {
    console.log('(無資料)');
  }
}

// 使用 Supabase 的 SQL 執行方式
async function runViaRest(name, table, select, filters = {}) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${name} 結果:`);
  console.log('='.repeat(60));
  
  let query = supabase.from(table).select(select);
  
  for (const [key, val] of Object.entries(filters)) {
    if (key === 'order') {
      query = query.order(val, { ascending: false });
    } else if (key === 'limit') {
      query = query.limit(val);
    } else if (key === 'eq') {
      query = query.eq(val.col, val.val);
    }
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error('Error:', error.message);
    return;
  }
  
  if (data && data.length > 0) {
    console.table(data.slice(0, 20));
    console.log(`(共 ${data.length} 行)`);
  } else {
    console.log('(無資料)');
  }
}

async function main() {
  console.log('P0-1: S1~S4 驗證查詢');
  console.log(`URL: ${supabaseUrl}`);
  
  // S3: forecast_runs with demand_forecast kind
  await runViaRest('S3', 'forecast_runs', 'id,created_at,scenario_name,parameters', {
    eq: { col: "parameters->>'kind'", val: 'demand_forecast' },
    order: 'created_at',
    limit: 5
  });
  
  // S4: demand_forecast records
  await runViaRest('S4', 'demand_forecast', 
    'material_code,plant_id,time_bucket,p10,p50,p90,model_version,train_window_buckets', {
    order: 'created_at',
    limit: 20
  });
  
  console.log('\n' + '='.repeat(60));
  console.log('Note: S1/S2 需要 information_schema/pg_constraint 查詢');
  console.log('請在 Supabase Dashboard SQL Editor 執行 P0_VERIFICATION_SQL.sql');
  console.log('='.repeat(60));
}

main().catch(console.error);
