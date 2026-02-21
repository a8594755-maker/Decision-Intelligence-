/**
 * Gate Evidence SQL Queries
 * Run all 4 SQL queries to gather hard evidence for Gate report
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY,
  {
    global: {
      headers: JSON_HEADERS
    }
  }
);

async function runQuery(name, query) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${name}`);
  console.log('='.repeat(80));
  
  try {
    const { data, error } = await supabase.rpc('exec_sql', { sql_query: query }, { headers: JSON_HEADERS });
    
    if (error) {
      console.error('Error:', error.message);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log('No results returned');
      return [];
    }
    
    console.log(JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error('Exception:', err.message);
    return null;
  }
}

async function main() {
  console.log('Gate Evidence Queries - Running 4 SQL checks...\n');
  
  // S1: Table structure
  await runQuery(
    'S1: Table & Column Structure',
    `select column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema='public' and table_name='demand_forecast'
     order by ordinal_position`
  );
  
  // S2: UNIQUE constraint
  await runQuery(
    'S2: UNIQUE Constraint Check',
    `select conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     where t.relname = 'demand_forecast' and c.contype in ('u','p')
     order by conname`
  );
  
  // S3: Forecast runs with demand_forecast kind
  await runQuery(
    'S3: Forecast Runs (kind=demand_forecast)',
    `select id, created_at, scenario_name, parameters
     from forecast_runs
     where parameters->>'kind' = 'demand_forecast'
     order by created_at desc
     limit 5`
  );
  
  // S4: Actual demand_forecast data
  await runQuery(
    'S4: Demand Forecast Data (p10/p50/p90)',
    `select material_code, plant_id, time_bucket, p10, p50, p90, model_version, train_window_buckets
     from demand_forecast
     order by created_at desc
     limit 20`
  );
  
  console.log('\n' + '='.repeat(80));
  console.log('All queries completed');
  console.log('='.repeat(80));
}

main().catch(console.error);
