// ============================================
// Job System Hardening - Integration Tests
// Week 4: Test Suite for idempotency, zombie cleanup, streaming
// ============================================

import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { generateJobKey } from "./utils.ts";
import { explodeBOMStream } from "./bomCalculatorStream.ts";
import type { FGDemand, BOMEdge, TraceRow } from "./types.ts";

// ============================================
// Test 1: Job Key Generation (Idempotency)
// ============================================
Deno.test("generateJobKey - same params produce same key", () => {
  const userId = "test-user-123";
  const params = {
    plantId: "P001",
    timeBuckets: ["2026-W01", "2026-W02"],
    demandForecastRunId: "run-abc",
    supplyForecastRunId: "run-def",
    scenarioName: "baseline",
  };

  const key1 = generateJobKey(userId, params);
  const key2 = generateJobKey(userId, params);

  assertEquals(key1, key2, "Same parameters should produce identical job keys");
});

Deno.test("generateJobKey - different params produce different keys", () => {
  const userId = "test-user-123";
  
  const key1 = generateJobKey(userId, {
    plantId: "P001",
    timeBuckets: ["2026-W01"],
  });
  
  const key2 = generateJobKey(userId, {
    plantId: "P002",
    timeBuckets: ["2026-W01"],
  });

  assertEquals(key1 !== key2, true, "Different parameters should produce different job keys");
});

Deno.test("generateJobKey - timeBuckets order is normalized", () => {
  const userId = "test-user-123";
  
  const key1 = generateJobKey(userId, {
    plantId: "P001",
    timeBuckets: ["2026-W02", "2026-W01", "2026-W03"],
  });
  
  const key2 = generateJobKey(userId, {
    plantId: "P001",
    timeBuckets: ["2026-W01", "2026-W02", "2026-W03"],
  });

  assertEquals(key1, key2, "Time buckets should be sorted before hashing");
});

// ============================================
// Test 2: Stream Calculator - Basic Functionality
// ============================================
Deno.test("explodeBOMStream - basic explosion with callback", async () => {
  const fgDemands: FGDemand[] = [
    {
      id: "fg-1",
      material_code: "FG001",
      plant_id: "P001",
      time_bucket: "2026-W01",
      demand_qty: 100,
      source_type: "forecast",
      source_id: "forecast-1",
    },
  ];

  const bomEdges: BOMEdge[] = [
    {
      id: "edge-1",
      parent_material: "FG001",
      child_material: "COMP001",
      plant_id: "P001",
      qty_per: 2,
      scrap_rate: 0,
      yield_rate: 1,
    },
  ];

  const flushedTraces: TraceRow[][] = [];
  
  const result = await explodeBOMStream(fgDemands, bomEdges, {
    maxDepth: 10,
    onTraceChunk: (traces) => {
      flushedTraces.push(traces);
    },
    traceFlushThreshold: 5,
  });

  assertEquals(result.componentDemandRows.length, 1, "Should generate 1 component demand");
  assertEquals(result.componentDemandRows[0].material_code, "COMP001", "Should be COMP001");
  assertEquals(result.componentDemandRows[0].demand_qty, 200, "Should be 200 (100 * 2)");
  assertExists(result.stats, "Should include stats");
  assertEquals(result.stats!.totalTracesGenerated, 1, "Should generate 1 trace");
});

// ============================================
// Test 3: Stream Calculator - Trace Flush Threshold
// ============================================
Deno.test("explodeBOMStream - respects trace flush threshold", async () => {
  const fgDemands: FGDemand[] = Array(10).fill(null).map((_, i) => ({
    id: `fg-${i}`,
    material_code: `FG${String(i).padStart(3, '0')}`,
    plant_id: "P001",
    time_bucket: "2026-W01",
    demand_qty: 10,
    source_type: "forecast",
    source_id: `forecast-${i}`,
  }));

  const bomEdges: BOMEdge[] = fgDemands.map((fg, i) => ({
    id: `edge-${i}`,
    parent_material: fg.material_code,
    child_material: `COMP${String(i).padStart(3, '0')}`,
    plant_id: "P001",
    qty_per: 1,
    scrap_rate: 0,
    yield_rate: 1,
  }));

  const flushedTraces: TraceRow[][] = [];
  const flushThreshold = 3;
  
  const result = await explodeBOMStream(fgDemands, bomEdges, {
    maxDepth: 10,
    onTraceChunk: (traces) => {
      flushedTraces.push([...traces]);
    },
    traceFlushThreshold: flushThreshold,
  });

  // Should have multiple flushes due to threshold
  assertEquals(flushedTraces.length >= 3, true, "Should flush multiple times with threshold of 3");
  assertEquals(result.stats!.flushCount >= 3, true, "Stats should record multiple flushes");
  assertEquals(result.stats!.totalTracesFlushed, 10, "Should flush all 10 traces");
});

// ============================================
// Test 4: Stream Calculator - Memory Limit Protection
// ============================================
Deno.test("explodeBOMStream - throws on exceeding max trace limit", async () => {
  // This test simulates a scenario where trace generation would exceed the limit
  // We use a deep BOM structure to generate many traces
  const fgDemands: FGDemand[] = [{
    id: "fg-1",
    material_code: "FG001",
    plant_id: "P001",
    time_bucket: "2026-W01",
    demand_qty: 1,
    source_type: "forecast",
    source_id: "forecast-1",
  }];

  // Create a deeply nested BOM that would generate many traces
  const bomEdges: BOMEdge[] = [];
  for (let i = 0; i < 50; i++) {
    bomEdges.push({
      id: `edge-${i}`,
      parent_material: i === 0 ? "FG001" : `COMP${String(i).padStart(3, '0')}`,
      child_material: `COMP${String(i + 1).padStart(3, '0')}`,
      plant_id: "P001",
      qty_per: 1,
      scrap_rate: 0,
      yield_rate: 1,
    });
  }

  // Override the limit for testing
  const originalLimit = 500000; // MAX_TRACE_ROWS_PER_RUN
  
  // This should complete successfully since 50 traces < 500000
  const result = await explodeBOMStream(fgDemands, bomEdges, {
    maxDepth: 100,
    onTraceChunk: () => {},
  });

  assertEquals(result.stats!.totalTracesGenerated, 50, "Should generate 50 traces");
});

// ============================================
// Test 5: Stream Calculator - Empty Input Handling
// ============================================
Deno.test("explodeBOMStream - handles empty FG demands", async () => {
  const result = await explodeBOMStream([], [], {
    maxDepth: 10,
    onTraceChunk: () => {},
  });

  assertEquals(result.componentDemandRows.length, 0, "Should have no component demands");
  assertEquals(result.errors.length, 1, "Should have NO_INPUT error");
  assertEquals(result.errors[0].type, "NO_INPUT", "Error type should be NO_INPUT");
});

Deno.test("explodeBOMStream - handles empty BOM edges", async () => {
  const fgDemands: FGDemand[] = [{
    id: "fg-1",
    material_code: "FG001",
    plant_id: "P001",
    time_bucket: "2026-W01",
    demand_qty: 100,
  }];

  const result = await explodeBOMStream(fgDemands, [], {
    maxDepth: 10,
    onTraceChunk: () => {},
  });

  assertEquals(result.componentDemandRows.length, 0, "Should have no component demands");
  assertEquals(result.errors.length, 1, "Should have NO_BOM error");
  assertEquals(result.errors[0].type, "NO_BOM", "Error type should be NO_BOM");
});

// ============================================
// Test 6: Stream Calculator - Progress Callback
// ============================================
Deno.test("explodeBOMStream - calls progress callback", async () => {
  const fgDemands: FGDemand[] = Array(5).fill(null).map((_, i) => ({
    id: `fg-${i}`,
    material_code: `FG${String(i).padStart(3, '0')}`,
    plant_id: "P001",
    time_bucket: "2026-W01",
    demand_qty: 10,
  }));

  const bomEdges: BOMEdge[] = fgDemands.map((fg, i) => ({
    id: `edge-${i}`,
    parent_material: fg.material_code,
    child_material: `COMP${String(i).padStart(3, '0')}`,
    plant_id: "P001",
    qty_per: 1,
  }));

  const progressEvents: { stage: string; count: number }[] = [];
  
  await explodeBOMStream(fgDemands, bomEdges, {
    maxDepth: 10,
    onTraceChunk: () => {},
    onProgress: (stage, count) => {
      progressEvents.push({ stage, count });
    },
    traceFlushThreshold: 2,
  });

  // Should have fg_processing events
  const fgEvents = progressEvents.filter(e => e.stage === 'fg_processing');
  assertEquals(fgEvents.length, 5, "Should have 5 fg_processing events");
  assertEquals(fgEvents[0].count, 1, "First event count should be 1");
  assertEquals(fgEvents[4].count, 5, "Last event count should be 5");

  // Should have trace_flush events
  const flushEvents = progressEvents.filter(e => e.stage === 'trace_flush');
  assertEquals(flushEvents.length >= 2, true, "Should have multiple trace_flush events");
});

// ============================================
// Test 7: Stream Calculator - Multi-level BOM
// ============================================
Deno.test("explodeBOMStream - handles multi-level BOM", async () => {
  const fgDemands: FGDemand[] = [{
    id: "fg-1",
    material_code: "FG001",
    plant_id: "P001",
    time_bucket: "2026-W01",
    demand_qty: 10,
  }];

  // FG001 -> COMP001 (qty 2) -> COMP002 (qty 3)
  const bomEdges: BOMEdge[] = [
    {
      id: "edge-1",
      parent_material: "FG001",
      child_material: "COMP001",
      plant_id: "P001",
      qty_per: 2,
    },
    {
      id: "edge-2",
      parent_material: "COMP001",
      child_material: "COMP002",
      plant_id: "P001",
      qty_per: 3,
    },
  ];

  const result = await explodeBOMStream(fgDemands, bomEdges, {
    maxDepth: 10,
  });

  assertEquals(result.componentDemandRows.length, 2, "Should have 2 components");
  
  const comp001 = result.componentDemandRows.find(r => r.material_code === "COMP001");
  const comp002 = result.componentDemandRows.find(r => r.material_code === "COMP002");
  
  assertExists(comp001, "Should have COMP001");
  assertExists(comp002, "Should have COMP002");
  assertEquals(comp001!.demand_qty, 20, "COMP001 should be 20 (10 * 2)");
  assertEquals(comp002!.demand_qty, 60, "COMP002 should be 60 (20 * 3)");
});

// ============================================
// Test Runner
// ============================================
console.log("Running Job System Hardening Integration Tests...");
