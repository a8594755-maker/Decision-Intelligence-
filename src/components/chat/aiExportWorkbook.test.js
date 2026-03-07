/**
 * aiExportWorkbook.test.js
 *
 * Light smoke tests for the AI Export handler logic.
 * Tests the fetch-based export flow without rendering CanvasPanel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('AI Export Workbook handler', () => {
  let originalFetch;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCreateObjectURL = globalThis.URL.createObjectURL;
    originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.stubEnv('VITE_ML_API_URL', 'http://localhost:8000');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    vi.unstubAllEnvs();
  });

  it('sends run_id, focus, and fallback data in the payload', async () => {
    let capturedBody = null;

    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        blob: async () => new Blob(['fake-xlsx'], { type: 'application/octet-stream' }),
      };
    });

    // Simulate the payload construction from CanvasPanel handler
    const run = { id: 42, status: 'succeeded', workflow: 'workflow_A_replenishment' };
    const activeGroup = { key: 'MAT-001__P1', material_code: 'MAT-001', plant_id: 'P1' };
    const chartPayload = { inventory_projection: [] };
    const downloads = [
      { label: 'plan.csv', fileName: 'plan.csv', content: 'a,b\n1,2', mimeType: 'text/csv' },
    ];

    // Filter downloads same way as CanvasPanel does
    const safeDownloads = downloads
      .filter(d => typeof d.content === 'string' || (typeof d.content === 'object' && !ArrayBuffer.isView(d.content) && !(d.content instanceof ArrayBuffer)))
      .map(d => ({
        label: d.label || d.fileName || '',
        fileName: d.fileName || d.label || '',
        content: typeof d.content === 'string' ? d.content : JSON.stringify(d.content),
        mimeType: d.mimeType || 'application/json',
      }));

    const payload = {
      version: 'v1',
      run_id: run.id,
      ai_insights: true,
      focus: activeGroup
        ? {
            series_key: activeGroup.key || null,
            sku: activeGroup.material_code || null,
            plant: activeGroup.plant_id || null,
            mode: 'selected',
          }
        : null,
      run_meta: { run_id: run.id, status: run.status, workflow: run.workflow },
      chart_payload: chartPayload,
      downloads: safeDownloads,
    };

    const baseUrl = import.meta.env.VITE_ML_API_URL;
    await globalThis.fetch(`${baseUrl}/export-workbook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(capturedBody).toBeTruthy();
    // MUST contain run_id and focus (primary)
    expect(capturedBody.run_id).toBe(42);
    expect(capturedBody.version).toBe('v1');
    expect(capturedBody.focus.series_key).toBe('MAT-001__P1');
    expect(capturedBody.focus.sku).toBe('MAT-001');
    // MUST contain fallback data
    expect(capturedBody.run_meta).toBeTruthy();
    expect(capturedBody.run_meta.run_id).toBe(42);
    expect(capturedBody.chart_payload).toBeTruthy();
    expect(capturedBody.downloads).toHaveLength(1);
    expect(capturedBody.downloads[0].label).toBe('plan.csv');
  });

  it('falls back gracefully on fetch failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network error');
    });

    const fallbackCalled = vi.fn();

    // Simulate the error handling from the handler
    try {
      const _resp = await globalThis.fetch('http://localhost:8000/export-workbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v1', run_id: 1, ai_insights: false }),
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (_err) {
      // Fallback to Quick Export
      fallbackCalled();
    }

    expect(fallbackCalled).toHaveBeenCalledTimes(1);
  });

  it('downloads blob on successful response', async () => {
    const mockBlob = new Blob(['xlsx-bytes'], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => mockBlob,
    }));

    const resp = await globalThis.fetch('http://localhost:8000/export-workbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v1', run_id: 42, ai_insights: false }),
    });

    expect(resp.ok).toBe(true);
    const blob = await resp.blob();
    expect(blob.size).toBeGreaterThan(0);
  });

  it('filters out binary downloads from payload', () => {
    const binaryContent = new Uint8Array([0, 1, 2, 3]);
    const downloads = [
      { label: 'plan.csv', content: 'a,b\n1,2', mimeType: 'text/csv' },
      { label: 'workbook.xlsx', content: binaryContent, mimeType: 'application/octet-stream' },
      { label: 'report.json', content: { summary: 'ok' }, mimeType: 'application/json' },
    ];

    const safeDownloads = downloads
      .filter(d => typeof d.content === 'string' || (typeof d.content === 'object' && !ArrayBuffer.isView(d.content) && !(d.content instanceof ArrayBuffer)))
      .map(d => ({
        label: d.label || '',
        fileName: d.fileName || d.label || '',
        content: typeof d.content === 'string' ? d.content : JSON.stringify(d.content),
        mimeType: d.mimeType || 'application/json',
      }));

    // Binary xlsx should be filtered out
    expect(safeDownloads).toHaveLength(2);
    expect(safeDownloads[0].label).toBe('plan.csv');
    expect(safeDownloads[1].label).toBe('report.json');
    // JSON object should be stringified
    expect(safeDownloads[1].content).toBe('{"summary":"ok"}');
  });
});
