/**
 * Generate Excel templates for BOM Explosion
 * Run: node scripts/generate_templates.js
 */

import * as XLSX from 'xlsx';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');

// BOM Edge template data
const bomEdgeData = [
  {
    parent_material: 'FG-001',
    child_material: 'COMP-001',
    qty_per: 2.0,
    uom: 'pcs',
    plant_id: 'PLANT-01',
    bom_version: 'V1.0',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    scrap_rate: 0.02,
    yield_rate: 0.98,
    alt_group: '',
    priority: '',
    mix_ratio: '',
    ecn_number: '',
    ecn_effective_date: '',
    routing_id: '',
    notes: ''
  },
  {
    parent_material: 'FG-001',
    child_material: 'COMP-002',
    qty_per: 1.5,
    uom: 'pcs',
    plant_id: 'PLANT-01',
    bom_version: 'V1.0',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    scrap_rate: 0.01,
    yield_rate: 0.99,
    alt_group: '',
    priority: '',
    mix_ratio: '',
    ecn_number: '',
    ecn_effective_date: '',
    routing_id: '',
    notes: ''
  },
  {
    parent_material: 'FG-001',
    child_material: 'COMP-003',
    qty_per: 0.5,
    uom: 'kg',
    plant_id: 'PLANT-01',
    bom_version: 'V1.0',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    scrap_rate: 0.05,
    yield_rate: 0.95,
    alt_group: '',
    priority: '',
    mix_ratio: '',
    ecn_number: '',
    ecn_effective_date: '',
    routing_id: '',
    notes: ''
  },
  {
    parent_material: 'FG-002',
    child_material: 'COMP-001',
    qty_per: 1.0,
    uom: 'pcs',
    plant_id: 'PLANT-01',
    bom_version: 'V1.0',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    scrap_rate: 0.03,
    yield_rate: 0.97,
    alt_group: '',
    priority: '',
    mix_ratio: '',
    ecn_number: '',
    ecn_effective_date: '',
    routing_id: '',
    notes: ''
  },
  {
    parent_material: 'FG-002',
    child_material: 'COMP-004',
    qty_per: 3.0,
    uom: 'pcs',
    plant_id: 'PLANT-01',
    bom_version: 'V1.0',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    scrap_rate: 0.02,
    yield_rate: 0.98,
    alt_group: 'ALT-GROUP-01',
    priority: 1,
    mix_ratio: 0.7,
    ecn_number: 'ECN-2026-001',
    ecn_effective_date: '2026-03-01',
    routing_id: 'ROUTE-001',
    notes: '主要替代料'
  },
  {
    parent_material: 'FG-002',
    child_material: 'COMP-005',
    qty_per: 3.0,
    uom: 'pcs',
    plant_id: 'PLANT-01',
    bom_version: 'V1.0',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    scrap_rate: 0.02,
    yield_rate: 0.98,
    alt_group: 'ALT-GROUP-01',
    priority: 2,
    mix_ratio: 0.3,
    ecn_number: 'ECN-2026-001',
    ecn_effective_date: '2026-03-01',
    routing_id: 'ROUTE-001',
    notes: '次要替代料'
  }
];

// Demand FG template data
const demandFgData = [
  {
    material_code: 'FG-001',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W02',
    week_bucket: '2026-W02',
    date: '',
    demand_qty: 1000.0,
    uom: 'pcs',
    source_type: 'SO',
    source_id: 'SO-2026-001',
    customer_id: 'CUST-001',
    project_id: '',
    priority: 1,
    status: 'confirmed',
    notes: ''
  },
  {
    material_code: 'FG-001',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W03',
    week_bucket: '2026-W03',
    date: '',
    demand_qty: 1500.0,
    uom: 'pcs',
    source_type: 'forecast',
    source_id: 'FCST-2026-001',
    customer_id: '',
    project_id: '',
    priority: 2,
    status: 'confirmed',
    notes: ''
  },
  {
    material_code: 'FG-001',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W04',
    week_bucket: '2026-W04',
    date: '',
    demand_qty: 1200.0,
    uom: 'pcs',
    source_type: 'manual',
    source_id: '',
    customer_id: '',
    project_id: 'PROJ-001',
    priority: 1,
    status: 'confirmed',
    notes: ''
  },
  {
    material_code: 'FG-002',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W02',
    week_bucket: '2026-W02',
    date: '',
    demand_qty: 800.0,
    uom: 'pcs',
    source_type: 'SO',
    source_id: 'SO-2026-002',
    customer_id: 'CUST-002',
    project_id: '',
    priority: 1,
    status: 'confirmed',
    notes: ''
  },
  {
    material_code: 'FG-002',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W03',
    week_bucket: '2026-W03',
    date: '',
    demand_qty: 900.0,
    uom: 'pcs',
    source_type: 'forecast',
    source_id: 'FCST-2026-002',
    customer_id: '',
    project_id: '',
    priority: 2,
    status: 'confirmed',
    notes: ''
  },
  {
    material_code: 'FG-001',
    plant_id: 'PLANT-01',
    time_bucket: '2026-01-08',
    week_bucket: '',
    date: '2026-01-08',
    demand_qty: 1000.0,
    uom: 'pcs',
    source_type: 'SO',
    source_id: 'SO-2026-001',
    customer_id: 'CUST-001',
    project_id: '',
    priority: 1,
    status: 'confirmed',
    notes: ''
  },
  {
    material_code: 'FG-001',
    plant_id: 'PLANT-01',
    time_bucket: '2026-01-15',
    week_bucket: '',
    date: '2026-01-15',
    demand_qty: 1500.0,
    uom: 'pcs',
    source_type: 'forecast',
    source_id: 'FCST-2026-001',
    customer_id: '',
    project_id: '',
    priority: 2,
    status: 'confirmed',
    notes: ''
  }
];

// Generate Excel file
function generateExcel(filename, data, sheetName) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  
  // Set column widths
  const colWidths = [];
  const headers = Object.keys(data[0] || {});
  headers.forEach(() => {
    colWidths.push({ wch: 15 });
  });
  ws['!cols'] = colWidths;
  
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  
  const filepath = join(templatesDir, filename);
  XLSX.writeFile(wb, filepath);
  console.log(`✓ Generated: ${filepath}`);
}

// Generate templates
console.log('Generating Excel templates...\n');

generateExcel('bom_edge.xlsx', bomEdgeData, 'bom_edge');
generateExcel('demand_fg.xlsx', demandFgData, 'demand_fg');

console.log('\n✓ All templates generated successfully!');
