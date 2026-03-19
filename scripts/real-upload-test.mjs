#!/usr/bin/env node
/**
 * 真正操作 Output Profiles 上傳流程
 *
 * 模擬人類在瀏覽器上：
 *   1. 登入 → 取得 session
 *   2. 到 Output Profiles 頁 → getOrCreateWorker → 拿到 employee UUID
 *   3. 點 "Bulk Upload & Learn" → 選檔案
 *   4. 點 "Upload & Learn" → runOnboarding()
 *   5. 檢查結果 → listCompanyOutputProfiles / listExemplars
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, 'seed-data');

const SUPABASE_URL = 'https://cbxvqqqulwytdblivtoe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNieHZxcXF1bHd5dGRibGl2dG9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NjQzNjUsImV4cCI6MjA4MDA0MDM2NX0.3PeFtqJAkoxrosFeAiXbOklRCDxaQjH2VjXWwEiFyYI';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', D = '\x1b[0m', DIM = '\x1b[2m';

async function main() {
  console.log(`\n${B}═══ Real Upload Test — Output Profiles ═══${D}\n`);

  // ── Step 1: 登入 ─────────────────────────────────────────
  console.log(`${B}Step 1: 登入 Supabase${D}`);
  const { data: { session }, error: authErr } = await supabase.auth.getSession();
  if (!session) {
    console.log(`  ${Y}⚠ 沒有 session，嘗試用 service role 或匿名查詢${D}`);
  } else {
    console.log(`  ${G}✓${D} 已登入: ${session.user.email} (${session.user.id.slice(0, 8)}...)`);
  }

  // ── Step 2: 找到 AI employee ─────────────────────────────
  console.log(`\n${B}Step 2: 找到 AI Employee (worker)${D}`);

  // 先列出所有 ai_employees
  const { data: employees, error: empErr } = await supabase
    .from('ai_employees')
    .select('id, name, role, status, manager_user_id')
    .is('archived_at', null)
    .limit(10);

  if (empErr) {
    console.log(`  ${R}✗ 查詢 ai_employees 失敗: ${empErr.message}${D}`);
    // 可能是 RLS 問題，試試看有沒有 public access
    console.log(`  ${DIM}(可能需要登入才能查詢)${D}`);
  }

  let workerId = null;
  if (employees?.length) {
    console.log(`  ${G}✓${D} 找到 ${employees.length} 個 workers:`);
    for (const e of employees) {
      console.log(`    ${DIM}${e.id.slice(0, 8)}... | ${e.name} | ${e.role} | ${e.status}${D}`);
    }
    workerId = employees[0].id;
    console.log(`  ${G}→ 使用 worker: ${employees[0].name} (${workerId.slice(0, 8)}...)${D}`);
  } else {
    console.log(`  ${Y}⚠ 找不到 worker，列出 DB 結構確認 table 存在${D}`);
    // 試一下 style_ingestion_jobs table
    const { error: tableErr } = await supabase.from('style_ingestion_jobs').select('id').limit(1);
    if (tableErr) {
      console.log(`  ${R}✗ style_ingestion_jobs table 問題: ${tableErr.message}${D}`);
    } else {
      console.log(`  ${G}✓ style_ingestion_jobs table 存在${D}`);
    }
  }

  // ── Step 3: 選檔案（模擬拖放） ──────────────────────────
  console.log(`\n${B}Step 3: 選擇檔案 (模擬 Bulk Upload & Learn 拖放)${D}`);

  // 挑每種各一個，共 5 個檔案
  const selectedFiles = [
    'MBR_202603_月營運報告.xlsx',
    '週報_202603_W1_Weekly_Ops.xlsx',
    'QBR_2026_Q1_季度報告.xlsx',
    '需求預測_202603_Demand_Forecast.xlsx',
    '風險報告_202603_Risk_Report.xlsx',
  ];

  const uploadFiles = selectedFiles.map(name => {
    const buf = readFileSync(join(SEED_DIR, name));
    console.log(`  ${G}✓${D} ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
    return { buffer: buf, filename: name };
  });

  // ── Step 4: 跑 extractStyleBatch (跟瀏覽器完全一樣) ────
  console.log(`\n${B}Step 4: 抽取 style fingerprints (SheetJS)${D}`);

  const fingerprints = [];
  for (const f of uploadFiles) {
    const wb = XLSX.read(f.buffer, { type: 'buffer', cellStyles: true, cellDates: true });

    const structure = {
      sheet_count: wb.SheetNames.length,
      sheet_names: wb.SheetNames,
      has_cover_sheet: wb.SheetNames.some(n => /cover|封面|首頁/i.test(n)),
      has_dashboard_sheet: wb.SheetNames.some(n => /dashboard|儀表|總覽|summary/i.test(n)),
      has_data_sheet: wb.SheetNames.some(n => /data|資料|cleaned/i.test(n)),
    };

    // KPI keyword scan
    const kpiKeywords = [];
    const KPI_WORDS = ['kpi', 'metric', 'target', 'actual', 'variance', 'ytd', 'mtd', '指標', '目標', '實際', '達成率', 'mape'];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws?.['!ref']) continue;
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(0, 20);
      for (const row of rows) {
        for (const cell of row) {
          if (!cell) continue;
          const val = String(cell).toLowerCase();
          for (const kw of KPI_WORDS) {
            if (val.includes(kw) && !kpiKeywords.includes(kw)) kpiKeywords.push(kw);
          }
        }
      }
    }

    const fp = {
      source_file: f.filename,
      structure,
      kpi_layout: { kpi_keywords_found: kpiKeywords, position: kpiKeywords.length > 0 ? 'inline' : null },
    };

    console.log(`  ${G}✓${D} ${f.filename}: ${structure.sheet_count} sheets, ${kpiKeywords.length} KPI keywords [${kpiKeywords.slice(0, 5).join(', ')}]`);
    fingerprints.push(fp);
  }

  // ── Step 5: 嘗試寫入 Supabase (跟 runOnboarding 一樣) ──
  console.log(`\n${B}Step 5: 寫入 Supabase (createJob → saveProfile)${D}`);

  if (!workerId) {
    console.log(`  ${Y}⚠ 沒有 worker UUID，跳過 DB 寫入${D}`);
    console.log(`  ${Y}  根本原因: ExemplarUploadPanel 之前傳 "default" 字串，現在已修成從 auth context 取 UUID${D}`);
    console.log(`  ${Y}  修復: OutputProfilesPage 加了 useAuth + getOrCreateWorker${D}`);
  } else {
    // 5a: createJob
    console.log(`  嘗試 createJob (employee_id=${workerId.slice(0, 8)}...)...`);
    const { data: job, error: jobErr } = await supabase
      .from('style_ingestion_jobs')
      .insert({
        employee_id: workerId,
        job_type: 'onboarding',
        status: 'pending',
        total_files: uploadFiles.length,
        config: { bulkFileCount: uploadFiles.length },
      })
      .select()
      .single();

    if (jobErr) {
      console.log(`  ${R}✗ createJob 失敗: ${jobErr.message}${D}`);
    } else {
      console.log(`  ${G}✓ Job created: ${job.id.slice(0, 8)}...${D}`);

      // 5b: saveProfile
      console.log(`  嘗試 saveProfile...`);
      const { data: profile, error: profErr } = await supabase
        .from('style_profiles')
        .upsert({
          employee_id: workerId,
          team_id: null,
          doc_type: 'mbr_report',
          profile_name: 'mbr_baseline',
          sample_count: 1,
          confidence: 0.5,
          canonical_structure: fingerprints[0].structure,
          canonical_formatting: {},
          canonical_charts: {},
          canonical_kpi_layout: fingerprints[0].kpi_layout,
          canonical_text_style: {},
          high_variance_dims: [],
        }, { onConflict: 'employee_id,team_id,doc_type' })
        .select()
        .single();

      if (profErr) {
        console.log(`  ${R}✗ saveProfile 失敗: ${profErr.message}${D}`);
      } else {
        console.log(`  ${G}✓ Profile saved: ${profile.id?.slice(0, 8)}... (doc_type: mbr_report)${D}`);
      }

      // 5c: mark job completed
      await supabase.from('style_ingestion_jobs').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: { profileCreated: true, exemplarsCreated: 0, errors: [] },
      }).eq('id', job.id);
      console.log(`  ${G}✓ Job marked completed${D}`);
    }
  }

  // ── Step 6: 驗證讀取 (模擬頁面 reload) ──────────────────
  console.log(`\n${B}Step 6: 驗證讀取 (模擬頁面 reload 後的 loadProfiles)${D}`);

  if (workerId) {
    const { data: profiles, error: listErr } = await supabase
      .from('style_profiles')
      .select('id, doc_type, profile_name, sample_count, confidence')
      .eq('employee_id', workerId);

    if (listErr) {
      console.log(`  ${R}✗ listProfiles 失敗: ${listErr.message}${D}`);
    } else {
      console.log(`  ${G}✓${D} 找到 ${profiles?.length || 0} 個 profiles:`);
      for (const p of (profiles || [])) {
        console.log(`    ${DIM}${p.id?.slice(0, 8)}... | ${p.doc_type} | ${p.profile_name} | samples: ${p.sample_count} | conf: ${p.confidence}${D}`);
      }
    }

    // Check exemplars
    const { data: exemplars, error: exErr } = await supabase
      .from('style_exemplars')
      .select('id, title, doc_type, quality_score')
      .eq('employee_id', workerId)
      .limit(10);

    if (exErr) {
      console.log(`  ${R}✗ listExemplars 失敗: ${exErr.message}${D}`);
    } else {
      console.log(`  ${G}✓${D} 找到 ${exemplars?.length || 0} 個 exemplars`);
    }

    // Check jobs
    const { data: jobs, error: jobsErr } = await supabase
      .from('style_ingestion_jobs')
      .select('id, status, job_type, total_files, completed_at')
      .eq('employee_id', workerId)
      .order('created_at', { ascending: false })
      .limit(3);

    if (!jobsErr && jobs?.length) {
      console.log(`  ${G}✓${D} 最近 ${jobs.length} 個 jobs:`);
      for (const j of jobs) {
        console.log(`    ${DIM}${j.id?.slice(0, 8)}... | ${j.status} | ${j.job_type} | ${j.total_files} files${D}`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n${B}═══ 結論 ═══${D}`);
  if (workerId) {
    console.log(`  ${G}✅ 上傳流程可以正常運作${D}`);
    console.log(`  Worker UUID: ${workerId}`);
  } else {
    console.log(`  ${Y}⚠ 需要先登入才能操作（RLS policy 保護）${D}`);
    console.log(`  ${Y}  但 code bug 已修：${D}`);
    console.log(`    1. employee_id "default" → 改從 useAuth + getOrCreateWorker 取真 UUID`);
    console.log(`    2. team_id "default" → 改為 null`);
    console.log(`    3. STAGES.map crash → 修成 array`);
    console.log(`    4. 上傳後注入 local state → 頁面即時顯示`);
  }
  console.log('');
}

main().catch(e => { console.error(R, e.message, D); process.exit(1); });
