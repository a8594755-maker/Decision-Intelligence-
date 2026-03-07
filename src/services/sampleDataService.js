/**
 * Sample Data Service
 * Loads the bundled sample Excel workbook for one-click demo.
 */
import * as XLSX from 'xlsx';

const SAMPLE_FILE_PATH = '/sample_data/test_data.xlsx';
const SAMPLE_FILE_NAME = 'test_data.xlsx';

/**
 * Fetch and parse the sample workbook.
 * @returns {{ workbook: object, fileName: string, fileSize: number }}
 */
export async function loadSampleWorkbook() {
  const resp = await fetch(SAMPLE_FILE_PATH);
  if (!resp.ok) throw new Error(`Failed to load sample data (${resp.status})`);
  const buf = await resp.arrayBuffer();
  const workbook = XLSX.read(new Uint8Array(buf), { type: 'array' });
  return { workbook, fileName: SAMPLE_FILE_NAME, fileSize: buf.byteLength };
}

export function getSampleDataManifest() {
  return {
    fileName: SAMPLE_FILE_NAME,
    description: 'Multi-sheet Excel file with supply chain data (inventory, demand, POs, BOM, financials)',
    path: SAMPLE_FILE_PATH,
  };
}
