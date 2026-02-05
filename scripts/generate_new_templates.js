/**
 * Generate Excel and CSV templates for new upload types
 * Run: node scripts/generate_new_templates.js
 */

import * as XLSX from 'xlsx';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');

// A) PO Open Lines template data
const poOpenLinesData = [
  {
    po_number: 'PO-10001',
    po_line: '10',
    material_code: 'COMP-3100',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W05',
    open_qty: 5000,
    uom: 'pcs',
    supplier_id: 'SUP-001',
    status: 'open',
    notes: 'Regular weekly delivery'
  },
  {
    po_number: 'PO-10001',
    po_line: '20',
    material_code: 'RM-9000',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W06',
    open_qty: 3500,
    uom: 'kg',
    supplier_id: 'SUP-001',
    status: 'open',
    notes: ''
  },
  {
    po_number: 'PO-10002',
    po_line: '10',
    material_code: 'COMP-3200',
    plant_id: 'PLANT-02',
    time_bucket: '2026-02-10',
    open_qty: 10000,
    uom: 'pcs',
    supplier_id: 'SUP-002',
    status: 'open',
    notes: 'Rush order - expedite'
  },
  {
    po_number: 'PO-10003',
    po_line: '10',
    material_code: 'RM-9100',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W07',
    open_qty: 2000,
    uom: 'kg',
    supplier_id: 'SUP-003',
    status: 'open',
    notes: ''
  },
  {
    po_number: 'PO-10004',
    po_line: '10',
    material_code: 'COMP-3150',
    plant_id: 'PLANT-02',
    time_bucket: '2026-02-20',
    open_qty: 7500,
    uom: 'pcs',
    supplier_id: 'SUP-001',
    status: 'open',
    notes: 'Split delivery allowed'
  },
  {
    po_number: 'PO-10005',
    po_line: '10',
    material_code: 'RM-9200',
    plant_id: 'PLANT-01',
    time_bucket: '2026-W08',
    open_qty: 4200,
    uom: 'kg',
    supplier_id: 'SUP-004',
    status: 'cancelled',
    notes: 'Replaced by PO-10006'
  }
];

// B) Inventory Snapshots template data
const inventorySnapshotsData = [
  {
    material_code: 'COMP-3100',
    plant_id: 'PLANT-01',
    snapshot_date: '2026-01-31',
    onhand_qty: 15000,
    allocated_qty: 8000,
    safety_stock: 5000,
    uom: 'pcs',
    notes: 'End of month snapshot'
  },
  {
    material_code: 'RM-9000',
    plant_id: 'PLANT-01',
    snapshot_date: '2026-01-31',
    onhand_qty: 12500,
    allocated_qty: 3000,
    safety_stock: 2000,
    uom: 'kg',
    notes: ''
  },
  {
    material_code: 'COMP-3200',
    plant_id: 'PLANT-02',
    snapshot_date: '2026-01-31',
    onhand_qty: 25000,
    allocated_qty: 15000,
    safety_stock: 8000,
    uom: 'pcs',
    notes: 'High demand item'
  },
  {
    material_code: 'FG-2000',
    plant_id: 'PLANT-01',
    snapshot_date: '2026-01-31',
    onhand_qty: 5000,
    allocated_qty: 4500,
    safety_stock: 1000,
    uom: 'pcs',
    notes: 'Finished goods ready to ship'
  },
  {
    material_code: 'RM-9100',
    plant_id: 'PLANT-01',
    snapshot_date: '2026-01-31',
    onhand_qty: 8000,
    allocated_qty: 2000,
    safety_stock: 3000,
    uom: 'kg',
    notes: ''
  },
  {
    material_code: 'COMP-3150',
    plant_id: 'PLANT-02',
    snapshot_date: '2026-01-31',
    onhand_qty: 18000,
    allocated_qty: 10000,
    safety_stock: 6000,
    uom: 'pcs',
    notes: 'Critical component'
  }
];

// C) FG Financials template data
const fgFinancialsData = [
  {
    material_code: 'FG-2000',
    unit_margin: 25.50,
    plant_id: 'PLANT-01',
    unit_price: 125.00,
    currency: 'USD',
    valid_from: '2026-01-01',
    valid_to: '2026-06-30',
    notes: 'H1 2026 pricing'
  },
  {
    material_code: 'FG-2100',
    unit_margin: 30.00,
    plant_id: 'PLANT-01',
    unit_price: 150.00,
    currency: 'USD',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    notes: 'Premium product line'
  },
  {
    material_code: 'FG-2200',
    unit_margin: 18.75,
    plant_id: 'PLANT-02',
    unit_price: 95.00,
    currency: 'USD',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    notes: ''
  },
  {
    material_code: 'FG-2300',
    unit_margin: 22.00,
    plant_id: '',
    unit_price: 110.00,
    currency: 'USD',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    notes: 'Global pricing - all plants'
  },
  {
    material_code: 'FG-2400',
    unit_margin: 35.50,
    plant_id: 'PLANT-01',
    unit_price: 185.00,
    currency: 'USD',
    valid_from: '2026-01-01',
    valid_to: '2026-03-31',
    notes: 'Q1 2026 promotional pricing'
  },
  {
    material_code: 'FG-2500',
    unit_margin: 28.25,
    plant_id: 'PLANT-02',
    unit_price: 140.00,
    currency: 'EUR',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    notes: 'European market product'
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
    colWidths.push({ wch: 18 });
  });
  ws['!cols'] = colWidths;
  
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  
  const filepath = join(templatesDir, filename);
  XLSX.writeFile(wb, filepath);
  console.log(`✓ Generated: ${filepath}`);
}

// Generate CSV file
function generateCSV(filename, data) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  
  const filepath = join(templatesDir, filename);
  XLSX.writeFile(wb, filepath, { bookType: 'csv' });
  console.log(`✓ Generated: ${filepath}`);
}

// Generate templates
console.log('Generating new upload templates...\n');

console.log('1. PO Open Lines templates:');
generateExcel('po_open_lines.xlsx', poOpenLinesData, 'po_open_lines');
generateCSV('po_open_lines.csv', poOpenLinesData);

console.log('\n2. Inventory Snapshots templates:');
generateExcel('inventory_snapshots.xlsx', inventorySnapshotsData, 'inventory_snapshots');
generateCSV('inventory_snapshots.csv', inventorySnapshotsData);

console.log('\n3. FG Financials templates:');
generateExcel('fg_financials.xlsx', fgFinancialsData, 'fg_financials');
generateCSV('fg_financials.csv', fgFinancialsData);

console.log('\n✓ All new templates generated successfully!');
console.log('\nSummary:');
console.log('- 6 files created in templates/ directory');
console.log('- Each template contains 5-6 sample records');
console.log('- All data follows ERP naming conventions');
