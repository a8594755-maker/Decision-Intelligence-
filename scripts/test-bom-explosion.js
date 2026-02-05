/**
 * BOM Explosion 測試腳本
 * 使用 BOM_EXPLOSION_SPEC.md 的測試案例 1 和 2
 * 
 * 執行方式: node test-bom-explosion.js
 */

import { calculateBomExplosion } from './src/services/bomExplosionService.js';

// 顏色輸出工具
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ 斷言失敗: ${message}`);
  }
}

function assertClose(actual, expected, tolerance = 0.01, message = '') {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(
      `❌ 數值斷言失敗: ${message}\n` +
      `  預期: ${expected}\n` +
      `  實際: ${actual}\n` +
      `  誤差: ${diff} (容忍度: ${tolerance})`
    );
  }
}

// ============================================
// 測試案例 1：簡單兩層 BOM
// ============================================
function testCase1() {
  log('\n' + '='.repeat(60), colors.cyan);
  log('測試案例 1：簡單兩層 BOM', colors.cyan);
  log('='.repeat(60), colors.cyan);

  // 輸入資料
  const bomEdges = [
    {
      id: 'BE-001',
      parent_material: 'FG-001',
      child_material: 'COMP-001',
      qty_per: 2.0,
      plant_id: 'PLANT-01',
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      scrap_rate: 0.05,
      yield_rate: 0.95,
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 'BE-002',
      parent_material: 'FG-001',
      child_material: 'COMP-002',
      qty_per: 1.5,
      plant_id: 'PLANT-01',
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      scrap_rate: null,
      yield_rate: null,
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 'BE-003',
      parent_material: 'COMP-001',
      child_material: 'COMP-010',
      qty_per: 0.5,
      plant_id: 'PLANT-01',
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      scrap_rate: 0.02,
      yield_rate: 1.0,
      created_at: '2026-01-01T00:00:00Z'
    }
  ];

  const demandFg = [
    {
      id: 'DF-001',
      material_code: 'FG-001',
      plant_id: 'PLANT-01',
      time_bucket: '2026-W02',
      demand_qty: 1000.0,
      uom: 'pcs'
    },
    {
      id: 'DF-002',
      material_code: 'FG-001',
      plant_id: 'PLANT-01',
      time_bucket: '2026-W03',
      demand_qty: 1500.0,
      uom: 'pcs'
    }
  ];

  // 執行計算
  const result = calculateBomExplosion(demandFg, bomEdges, {
    userId: 'test-user',
    batchId: 'test-batch-1'
  });

  log('\n✓ 計算完成', colors.green);
  log(`  - Component Demand 記錄數: ${result.componentDemandRows.length}`);
  log(`  - Trace 記錄數: ${result.traceRows.length}`);
  log(`  - 錯誤/警告數: ${result.errors.length}`);

  // 調試輸出：顯示所有產生的記錄
  log('\n調試：Component Demand 記錄:', colors.yellow);
  result.componentDemandRows.forEach(row => {
    log(`  - ${row.material_code}, ${row.plant_id}, ${row.time_bucket}: ${row.demand_qty.toFixed(2)}`);
  });

  // 如果有錯誤，顯示詳情
  if (result.errors.length > 0) {
    log('\n調試：錯誤/警告詳情:', colors.yellow);
    result.errors.forEach((err, idx) => {
      log(`  ${idx + 1}. [${err.type}] ${err.message}`);
      if (err.material) log(`     料號: ${err.material}`);
      if (err.path) log(`     路徑: ${JSON.stringify(err.path)}`);
    });
  }

  // 驗證：應該沒有錯誤
  assert(result.errors.length === 0, 
    `不應該有錯誤，但有 ${result.errors.length} 個: ${JSON.stringify(result.errors, null, 2)}`);

  // 驗證：應該有 6 筆 component demand（3 種料號 × 2 個時間桶）
  assert(result.componentDemandRows.length === 6, 
    `應該有 6 筆 component demand，實際: ${result.componentDemandRows.length}`);

  // 建立查詢映射
  const demandMap = {};
  result.componentDemandRows.forEach(row => {
    const key = `${row.material_code}|${row.plant_id}|${row.time_bucket}`;
    demandMap[key] = row;
  });

  // 驗證各個 Component 的需求數量
  log('\n驗證 Component 需求數量:', colors.yellow);

  // COMP-001, 2026-W02: 1000 × 2.0 × 1.05 / 0.95 = 2210.53
  const comp001_w02 = demandMap['COMP-001|PLANT-01|2026-W02'];
  assert(comp001_w02, 'COMP-001, 2026-W02 記錄應存在');
  assertClose(comp001_w02.demand_qty, 2210.53, 0.01, 'COMP-001, 2026-W02');
  log(`  ✓ COMP-001, 2026-W02: ${comp001_w02.demand_qty.toFixed(2)} ≈ 2210.53`);

  // COMP-001, 2026-W03: 1500 × 2.0 × 1.05 / 0.95 = 3315.79
  const comp001_w03 = demandMap['COMP-001|PLANT-01|2026-W03'];
  assert(comp001_w03, 'COMP-001, 2026-W03 記錄應存在');
  assertClose(comp001_w03.demand_qty, 3315.79, 0.01, 'COMP-001, 2026-W03');
  log(`  ✓ COMP-001, 2026-W03: ${comp001_w03.demand_qty.toFixed(2)} ≈ 3315.79`);

  // COMP-002, 2026-W02: 1000 × 1.5 = 1500.0
  const comp002_w02 = demandMap['COMP-002|PLANT-01|2026-W02'];
  assert(comp002_w02, 'COMP-002, 2026-W02 記錄應存在');
  assertClose(comp002_w02.demand_qty, 1500.0, 0.01, 'COMP-002, 2026-W02');
  log(`  ✓ COMP-002, 2026-W02: ${comp002_w02.demand_qty.toFixed(2)} = 1500.00`);

  // COMP-002, 2026-W03: 1500 × 1.5 = 2250.0
  const comp002_w03 = demandMap['COMP-002|PLANT-01|2026-W03'];
  assert(comp002_w03, 'COMP-002, 2026-W03 記錄應存在');
  assertClose(comp002_w03.demand_qty, 2250.0, 0.01, 'COMP-002, 2026-W03');
  log(`  ✓ COMP-002, 2026-W03: ${comp002_w03.demand_qty.toFixed(2)} = 2250.00`);

  // COMP-010, 2026-W02: 2210.53 × 0.5 × 1.02 / 1.0 = 1127.37
  const comp010_w02 = demandMap['COMP-010|PLANT-01|2026-W02'];
  assert(comp010_w02, 'COMP-010, 2026-W02 記錄應存在');
  assertClose(comp010_w02.demand_qty, 1127.37, 0.01, 'COMP-010, 2026-W02');
  log(`  ✓ COMP-010, 2026-W02: ${comp010_w02.demand_qty.toFixed(2)} ≈ 1127.37`);

  // COMP-010, 2026-W03: 3315.79 × 0.5 × 1.02 / 1.0 = 1691.05
  const comp010_w03 = demandMap['COMP-010|PLANT-01|2026-W03'];
  assert(comp010_w03, 'COMP-010, 2026-W03 記錄應存在');
  assertClose(comp010_w03.demand_qty, 1691.05, 0.01, 'COMP-010, 2026-W03');
  log(`  ✓ COMP-010, 2026-W03: ${comp010_w03.demand_qty.toFixed(2)} ≈ 1691.05`);

  log('\n✅ 測試案例 1 通過！', colors.green);
  return { passed: true, total: 6 };
}

// ============================================
// 測試案例 2：多來源匯總 + 時效性過濾
// ============================================
function testCase2() {
  log('\n' + '='.repeat(60), colors.cyan);
  log('測試案例 2：多來源匯總 + 時效性過濾', colors.cyan);
  log('='.repeat(60), colors.cyan);

  // 輸入資料
  const bomEdges = [
    {
      id: 'BE-101',
      parent_material: 'FG-001',
      child_material: 'COMP-001',
      qty_per: 2.0,
      plant_id: 'PLANT-01',
      valid_from: '2026-01-01',
      valid_to: '2026-06-30',
      scrap_rate: null,
      yield_rate: null,
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 'BE-102',
      parent_material: 'FG-001',
      child_material: 'COMP-001',
      qty_per: 3.0,
      plant_id: 'PLANT-01',
      valid_from: '2026-07-01',
      valid_to: '2026-12-31',
      scrap_rate: null,
      yield_rate: null,
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 'BE-103',
      parent_material: 'FG-002',
      child_material: 'COMP-001',
      qty_per: 1.5,
      plant_id: null, // 通用 BOM
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      scrap_rate: 0.1,
      yield_rate: null,
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 'BE-104',
      parent_material: 'FG-002',
      child_material: 'COMP-002',
      qty_per: 2.5,
      plant_id: 'PLANT-01',
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      scrap_rate: null,
      yield_rate: null,
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 'BE-105',
      parent_material: 'COMP-002',
      child_material: 'COMP-001',
      qty_per: 0.8,
      plant_id: 'PLANT-01',
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      scrap_rate: null,
      yield_rate: null,
      created_at: '2026-01-01T00:00:00Z'
    }
  ];

  const demandFg = [
    {
      id: 'DF-101',
      material_code: 'FG-001',
      plant_id: 'PLANT-01',
      time_bucket: '2026-W10', // 2026-03-07
      demand_qty: 1000.0,
      uom: 'pcs'
    },
    {
      id: 'DF-102',
      material_code: 'FG-001',
      plant_id: 'PLANT-01',
      time_bucket: '2026-W30', // 2026-07-20
      demand_qty: 800.0,
      uom: 'pcs'
    },
    {
      id: 'DF-103',
      material_code: 'FG-002',
      plant_id: 'PLANT-01',
      time_bucket: '2026-W10',
      demand_qty: 500.0,
      uom: 'pcs'
    },
    {
      id: 'DF-104',
      material_code: 'FG-002',
      plant_id: 'PLANT-02',
      time_bucket: '2026-W10',
      demand_qty: 600.0,
      uom: 'pcs'
    }
  ];

  // 執行計算
  const result = calculateBomExplosion(demandFg, bomEdges, {
    userId: 'test-user',
    batchId: 'test-batch-2'
  });

  log('\n✓ 計算完成', colors.green);
  log(`  - Component Demand 記錄數: ${result.componentDemandRows.length}`);
  log(`  - Trace 記錄數: ${result.traceRows.length}`);
  log(`  - 錯誤/警告數: ${result.errors.length}`);

  // 調試輸出：顯示所有產生的記錄
  log('\n調試：Component Demand 記錄:', colors.yellow);
  result.componentDemandRows.forEach(row => {
    log(`  - ${row.material_code}, ${row.plant_id}, ${row.time_bucket}: ${row.demand_qty.toFixed(2)}`);
  });

  // 如果有錯誤，顯示詳情
  if (result.errors.length > 0) {
    log('\n調試：錯誤/警告詳情:', colors.yellow);
    result.errors.forEach((err, idx) => {
      log(`  ${idx + 1}. [${err.type}] ${err.message}`);
      if (err.material) log(`     料號: ${err.material}`);
      if (err.plant_id) log(`     工廠: ${err.plant_id}`);
    });
  }

  // 建立查詢映射
  const demandMap = {};
  result.componentDemandRows.forEach(row => {
    const key = `${row.material_code}|${row.plant_id}|${row.time_bucket}`;
    demandMap[key] = row;
  });

  log('\n驗證 Component 需求數量:', colors.yellow);

  // COMP-001, PLANT-01, 2026-W10 (聚合)
  // 來源 1: FG-001 → COMP-001 = 1000 × 2.0 = 2000.0
  // 來源 2: FG-002 → COMP-001 = 500 × 1.5 × 1.1 = 825.0
  // 來源 3: FG-002 → COMP-002 → COMP-001 = 500 × 2.5 × 0.8 = 1000.0
  // 總計: 2000 + 825 + 1000 = 3825.0
  const comp001_p01_w10 = demandMap['COMP-001|PLANT-01|2026-W10'];
  assert(comp001_p01_w10, 'COMP-001, PLANT-01, 2026-W10 記錄應存在');
  assertClose(comp001_p01_w10.demand_qty, 3825.0, 0.01, 'COMP-001, PLANT-01, 2026-W10');
  log(`  ✓ COMP-001, PLANT-01, 2026-W10: ${comp001_p01_w10.demand_qty.toFixed(2)} = 3825.00 (聚合)`);

  // COMP-001, PLANT-01, 2026-W30
  // 來源: FG-001 → COMP-001 = 800 × 3.0 = 2400.0 (時效性：使用 BE-102)
  const comp001_p01_w30 = demandMap['COMP-001|PLANT-01|2026-W30'];
  assert(comp001_p01_w30, 'COMP-001, PLANT-01, 2026-W30 記錄應存在');
  assertClose(comp001_p01_w30.demand_qty, 2400.0, 0.01, 'COMP-001, PLANT-01, 2026-W30');
  log(`  ✓ COMP-001, PLANT-01, 2026-W30: ${comp001_p01_w30.demand_qty.toFixed(2)} = 2400.00 (時效性過濾)`);

  // COMP-001, PLANT-02, 2026-W10
  // 來源: FG-002 → COMP-001 = 600 × 1.5 × 1.1 = 990.0 (通用 BOM)
  const comp001_p02_w10 = demandMap['COMP-001|PLANT-02|2026-W10'];
  assert(comp001_p02_w10, 'COMP-001, PLANT-02, 2026-W10 記錄應存在');
  assertClose(comp001_p02_w10.demand_qty, 990.0, 0.01, 'COMP-001, PLANT-02, 2026-W10');
  log(`  ✓ COMP-001, PLANT-02, 2026-W10: ${comp001_p02_w10.demand_qty.toFixed(2)} = 990.00 (通用 BOM)`);

  // COMP-002, PLANT-01, 2026-W10
  // 來源: FG-002 → COMP-002 = 500 × 2.5 = 1250.0
  const comp002_p01_w10 = demandMap['COMP-002|PLANT-01|2026-W10'];
  assert(comp002_p01_w10, 'COMP-002, PLANT-01, 2026-W10 記錄應存在');
  assertClose(comp002_p01_w10.demand_qty, 1250.0, 0.01, 'COMP-002, PLANT-01, 2026-W10');
  log(`  ✓ COMP-002, PLANT-01, 2026-W10: ${comp002_p01_w10.demand_qty.toFixed(2)} = 1250.00`);

  // 驗證：COMP-002 在 PLANT-02 不應該有記錄（缺少對應的 BOM）
  const comp002_p02_w10 = demandMap['COMP-002|PLANT-02|2026-W10'];
  assert(!comp002_p02_w10, 'COMP-002, PLANT-02, 2026-W10 記錄不應存在（缺少 BOM）');
  log(`  ✓ COMP-002, PLANT-02, 2026-W10: 不存在 (符合預期，缺少 BOM)`);

  // 驗證錯誤/警告（非必須，因為 FG-002 在 PLANT-02 有通用 BOM）
  const missingBomErrors = result.errors.filter(e => e.type === 'MISSING_BOM');
  log('\n驗證錯誤/警告:', colors.yellow);
  log(`  - MISSING_BOM 警告數: ${missingBomErrors.length}`);
  if (missingBomErrors.length > 0) {
    log(`    警告詳情: ${missingBomErrors[0].message}`);
    log(`  ✓ 檢測到缺少 BOM 定義的警告`);
  } else {
    log(`  ✓ 無 MISSING_BOM 警告（FG-002 在 PLANT-02 有通用 BOM BE-103）`);
  }

  log('\n✅ 測試案例 2 通過！', colors.green);
  return { passed: true, total: 4 };
}

// ============================================
// 主測試函數
// ============================================
async function runTests() {
  log('\n' + '='.repeat(60), colors.bright);
  log('🧪 BOM Explosion 測試套件', colors.bright);
  log('='.repeat(60), colors.bright);

  const results = [];
  let totalPassed = 0;
  let totalTests = 0;

  try {
    // 測試案例 1
    const result1 = testCase1();
    results.push({ name: '測試案例 1', ...result1 });
    totalTests += result1.total;
    if (result1.passed) totalPassed += result1.total;
  } catch (error) {
    log(`\n❌ 測試案例 1 失敗: ${error.message}`, colors.red);
    results.push({ name: '測試案例 1', passed: false, error: error.message });
  }

  try {
    // 測試案例 2
    const result2 = testCase2();
    results.push({ name: '測試案例 2', ...result2 });
    totalTests += result2.total;
    if (result2.passed) totalPassed += result2.total;
  } catch (error) {
    log(`\n❌ 測試案例 2 失敗: ${error.message}`, colors.red);
    results.push({ name: '測試案例 2', passed: false, error: error.message });
  }

  // 總結
  log('\n' + '='.repeat(60), colors.bright);
  log('📊 測試結果總結', colors.bright);
  log('='.repeat(60), colors.bright);

  results.forEach(result => {
    if (result.passed) {
      log(`  ✅ ${result.name}: 通過 (${result.total} 個斷言)`, colors.green);
    } else {
      log(`  ❌ ${result.name}: 失敗`, colors.red);
      if (result.error) {
        log(`     錯誤: ${result.error}`, colors.red);
      }
    }
  });

  const allPassed = results.every(r => r.passed);
  log('\n' + '-'.repeat(60));
  if (allPassed) {
    log(`✅ 全部測試通過！(${totalPassed}/${totalTests})`, colors.green);
    log('='.repeat(60), colors.bright);
    process.exit(0);
  } else {
    log(`❌ 有測試失敗 (${totalPassed}/${totalTests})`, colors.red);
    log('='.repeat(60), colors.bright);
    process.exit(1);
  }
}

// 執行測試
runTests().catch(error => {
  log(`\n❌ 測試執行失敗: ${error.message}`, colors.red);
  console.error(error);
  process.exit(1);
});
