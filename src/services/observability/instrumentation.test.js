import { describe, it, expect } from 'vitest';
import { createStructuredLogger } from './structuredLogger';
import { createSpan } from './pipelineSpan';
import { createImportMetricsCollector } from './importMetrics';
import { createDataQualityTracker } from './dataQualityTracker';

describe('Observability Instrumentation Integration', () => {
  it('full import pipeline flow produces correct metrics', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    const importId = 'test-import-001';
    const metrics = createImportMetricsCollector(importId);
    const span = createSpan('import', 'workbook');

    // Simulate classification
    log.info('import-pipeline', 'Starting import', { _traceId: span.traceId, fileName: 'test.xlsx' });
    metrics.recordClassification('Sheet1', { uploadType: 'inventory_snapshots', confidence: 0.95, enabled: true });
    metrics.recordClassification('Sheet2', { uploadType: 'po_open_lines', confidence: 0.88, enabled: true });

    // Simulate mapping
    metrics.recordMapping('Sheet1', { totalFields: 10, autoMapped: 8, manualCorrections: 1, confidence: 0.85 });

    // Simulate validation
    metrics.recordValidation('Sheet1', { total: 500, valid: 480, invalid: 20, quarantined: 5, durationMs: 120 });
    metrics.recordValidation('Sheet2', { total: 200, valid: 195, invalid: 5, quarantined: 2, durationMs: 50 });

    // Simulate ingest
    metrics.recordIngest('Sheet1', { savedCount: 480, chunks: 5, durationMs: 300 });
    metrics.recordIngest('Sheet2', { savedCount: 195, chunks: 2, durationMs: 100 });

    span.addMetric('sheetsProcessed', 2);
    span.end();

    log.info('import-pipeline', 'Import complete', { _traceId: span.traceId, durationMs: span.durationMs });

    // Verify metrics
    const summary = metrics.getSummary();
    expect(summary.importId).toBe(importId);
    expect(summary.sheetsProcessed).toBe(2);
    expect(summary.totalRowsProcessed).toBe(700);
    expect(summary.totalRowsValid).toBe(675);
    expect(summary.totalRowsInvalid).toBe(25);
    expect(summary.totalRowsIngested).toBe(675);
    expect(summary.avgAutoMappedPct).toBe(40); // only Sheet1 has mapping (80%), Sheet2 has 0% → avg 40%

    // Verify span
    const spanJson = span.toJSON();
    expect(spanJson.pipeline).toBe('import');
    expect(spanJson.stage).toBe('workbook');
    expect(spanJson.endedAt).toBeTruthy();
    expect(spanJson.metrics.sheetsProcessed).toBe(2);

    // Verify logger captured events with traceId
    const traceEntries = log.getEntries({ traceId: span.traceId });
    expect(traceEntries.length).toBeGreaterThanOrEqual(2);
    expect(traceEntries[0].message).toBe('Starting import');
    expect(traceEntries[traceEntries.length - 1].message).toBe('Import complete');
  });

  it('planning pipeline span tracks solver + fallback audit', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    const planSpan = createSpan('planning', 'full-pipeline');

    log.info('planning-pipeline', 'Planning started', { _traceId: planSpan.traceId });

    // Simulate solver
    const solverSpan = createSpan('planning', 'solver', planSpan.traceId);
    solverSpan.addMetric('status', 'optimal');
    solverSpan.addMetric('planRows', 42);
    solverSpan.end();

    expect(solverSpan.traceId).toBe(planSpan.traceId); // inherits parent traceId

    log.info('planning-pipeline', 'Solver completed', {
      _traceId: planSpan.traceId, durationMs: solverSpan.durationMs,
    });

    // Simulate data quality log
    log.info('planning-pipeline', 'Data quality: partial', {
      _traceId: planSpan.traceId,
      coverageLevel: 'partial',
      missingDatasets: ['fg_financials'],
    });

    planSpan.addMetric('planRows', 42);
    planSpan.addMetric('coverageLevel', 'partial');
    planSpan.end();

    log.info('planning-pipeline', 'Planning completed successfully', {
      _traceId: planSpan.traceId, durationMs: planSpan.durationMs,
    });

    // Verify all entries traceable by traceId
    const allEntries = log.getEntries({ traceId: planSpan.traceId });
    expect(allEntries).toHaveLength(4);
    expect(allEntries.map(e => e.message)).toEqual([
      'Planning started',
      'Solver completed',
      'Data quality: partial',
      'Planning completed successfully',
    ]);

    // Verify solver span nested correctly
    const solverJson = solverSpan.toJSON();
    expect(solverJson.metrics.status).toBe('optimal');
    expect(solverJson.metrics.planRows).toBe(42);
    expect(solverJson.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('error path logs correctly', () => {
    const log = createStructuredLogger({ minLevel: 'debug' });
    const span = createSpan('planning', 'full-pipeline');

    log.info('planning-pipeline', 'Planning started', { _traceId: span.traceId });

    // Simulate error
    span.addMetric('error', 'No inventory data');
    span.end();
    log.error('planning-pipeline', 'Planning failed: No inventory data', {
      _traceId: span.traceId, isBlocking: true,
    });

    const errors = log.getEntries({ level: 'error', traceId: span.traceId });
    expect(errors).toHaveLength(1);
    expect(errors[0].data.isBlocking).toBe(true);
    expect(span.toJSON().metrics.error).toBe('No inventory data');
  });

  it('data quality tracker handles missing localStorage gracefully', () => {
    // In Node test env localStorage is unavailable — tracker should degrade safely
    const tracker = createDataQualityTracker();
    tracker.recordSnapshot({ importId: 'a', validationRate: 95, fallbackRate: 5, autoMappedPct: 90, sheetsProcessed: 2 });

    // Without localStorage, history won't persist — just verify no errors thrown
    const trend = tracker.getTrend();
    expect(['insufficient_data', 'healthy', 'degrading', 'poor']).toContain(trend.trend);
    tracker.clear(); // should not throw
  });

  it('metrics collector getSummary is accurate after partial recording', () => {
    const metrics = createImportMetricsCollector('partial-test');
    metrics.recordClassification('OnlySheet', { uploadType: 'inventory_snapshots', confidence: 0.9, enabled: true });
    // No validation or ingest recorded

    const summary = metrics.getSummary();
    expect(summary.sheetsProcessed).toBe(1);
    expect(summary.totalRowsProcessed).toBe(0);
    expect(summary.totalRowsIngested).toBe(0);
  });
});
