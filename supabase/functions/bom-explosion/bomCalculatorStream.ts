// ============================================
// BOM Explosion Calculator - Stream Version (Week 2)
// Supports streaming trace flush to prevent memory overflow
// ============================================

import type {
  FGDemand,
  BOMEdge,
  ComponentDemandRow,
  TraceRow,
  ExplosionOptions,
  ExplosionResult,
  BomExplosionError,
} from './types.ts';
import { DEFAULTS, ERROR_MESSAGES, LIMITS } from './types.ts';
import { roundTo, getAggregationKey, timeBucketToDate, formatError } from './utils.ts';

// Re-export the original calculateComponentRequirement and buildBomIndex
export { calculateComponentRequirement, buildBomIndex } from './bomCalculator.ts';

/**
 * Stream-aware BOM explosion function
 * Supports onTraceChunk callback for streaming writes
 */
export async function explodeBOMStream(
  fgDemands: FGDemand[],
  bomEdges: BOMEdge[],
  options: ExplosionOptions = {}
): Promise<ExplosionResult> {
  // Input validation
  if (!Array.isArray(fgDemands)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('fgDemands'));
  }
  if (!Array.isArray(bomEdges)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('bomEdges'));
  }

  const {
    maxDepth = DEFAULTS.MAX_BOM_DEPTH,
    ignoreScrap = false,
    onTraceChunk,
    traceFlushThreshold = LIMITS.INSERT_CHUNK_SIZE_TRACE,
    onProgress,
  } = options;

  const componentDemandMap = new Map<string, number>();
  const traceBuffer: TraceRow[] = [];
  const errors: BomExplosionError[] = [];
  
  // Stats for streaming mode
  let totalTracesGenerated = 0;
  let totalTracesFlushed = 0;
  let flushCount = 0;

  // Early return: empty inputs
  if (fgDemands.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [formatError('NO_INPUT', ERROR_MESSAGES.EMPTY_ARRAY('fgDemands'))],
      stats: { totalTracesGenerated: 0, totalTracesFlushed: 0, flushCount: 0 },
    };
  }

  if (bomEdges.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [formatError('NO_BOM', ERROR_MESSAGES.EMPTY_ARRAY('bomEdges'))],
      stats: { totalTracesGenerated: 0, totalTracesFlushed: 0, flushCount: 0 },
    };
  }

  // Process BOM edges
  const processedBomEdges = ignoreScrap
    ? bomEdges.map(edge => ({ ...edge, scrap_rate: 0, yield_rate: 1 }))
    : bomEdges;

  // Helper: flush trace buffer
  const flushTraceBuffer = async () => {
    if (traceBuffer.length === 0) return;
    
    if (onTraceChunk) {
      await onTraceChunk([...traceBuffer]);
    }
    
    totalTracesFlushed += traceBuffer.length;
    flushCount++;
    traceBuffer.length = 0; // Clear buffer
    
    if (onProgress) {
      onProgress('trace_flush', totalTracesFlushed);
    }
  };

  // Stream-aware recursive explosion
  const explodeRecursive = async (
    parentDemand: { material_code: string; plant_id: string; time_bucket: string; demand_qty: number; id?: string },
    bomLevel: number,
    multiplier: number,
    path: string[],
    bomIndex: Map<string, BOMEdge[]>,
    fgMaterialCode: string,
    fgDemandId: string | null,
    fgQty: number,
    sourceType: string | null,
    sourceId: string | null,
    bomEdgeId: string | null
  ): Promise<void> => {
    // Check max depth
    if (bomLevel > maxDepth) {
      errors.push(formatError(
        'MAX_DEPTH_EXCEEDED',
        ERROR_MESSAGES.MAX_DEPTH(maxDepth),
        { max_depth: maxDepth, current_level: bomLevel },
        parentDemand.material_code,
        [...path, parentDemand.material_code]
      ));
      return;
    }

    // Check for circular BOM
    if (path.includes(parentDemand.material_code)) {
      errors.push(formatError(
        'BOM_CYCLE',
        ERROR_MESSAGES.CIRCULAR_BOM,
        { cycle_path: [...path, parentDemand.material_code] },
        parentDemand.material_code,
        [...path, parentDemand.material_code]
      ));
      return;
    }

    // Get children from BOM index
    const children = bomIndex.get(parentDemand.material_code) || [];

    // Record component demand (path.length > 0 means not the FG itself)
    if (path.length > 0) {
      const key = getAggregationKey(
        parentDemand.plant_id,
        parentDemand.time_bucket,
        parentDemand.material_code
      );

      const currentQty = componentDemandMap.get(key) || 0;
      componentDemandMap.set(key, currentQty + parentDemand.demand_qty);

      const fullPath = [...path, parentDemand.material_code];
      const componentBomLevel = path.length;

      // Add to trace buffer
      traceBuffer.push({
        fg_material_code: fgMaterialCode,
        component_material_code: parentDemand.material_code,
        plant_id: parentDemand.plant_id,
        time_bucket: parentDemand.time_bucket,
        fg_qty: fgQty,
        component_qty: parentDemand.demand_qty,
        source_type: sourceType,
        source_id: sourceId,
        fg_demand_id: fgDemandId,
        bom_edge_id: bomEdgeId,
        bom_level: componentBomLevel,
        qty_multiplier: multiplier,
        path: fullPath,
      });

      totalTracesGenerated++;

      // Check global trace limit
      if (totalTracesGenerated > LIMITS.MAX_TRACE_ROWS_PER_RUN) {
        throw new Error(`Trace rows limit exceeded: ${totalTracesGenerated} > ${LIMITS.MAX_TRACE_ROWS_PER_RUN}`);
      }

      // Flush buffer if threshold reached
      if (traceBuffer.length >= traceFlushThreshold) {
        await flushTraceBuffer();
      }
    }

    // Recursively explode children
    if (children.length > 0) {
      for (const childEdge of children) {
        const scrapRate = childEdge.scrap_rate ?? DEFAULTS.DEFAULT_SCRAP_RATE;
        const yieldRate = childEdge.yield_rate ?? DEFAULTS.DEFAULT_YIELD_RATE;

        const childQty = calculateComponentRequirement(
          parentDemand.demand_qty,
          childEdge.qty_per,
          scrapRate,
          yieldRate
        );

        const newMultiplier = roundTo(
          multiplier * childEdge.qty_per * (1 + scrapRate) / yieldRate,
          4
        );

        await explodeRecursive(
          {
            material_code: childEdge.child_material,
            plant_id: parentDemand.plant_id,
            time_bucket: parentDemand.time_bucket,
            demand_qty: childQty,
          },
          bomLevel + 1,
          newMultiplier,
          [...path, parentDemand.material_code],
          bomIndex,
          fgMaterialCode,
          fgDemandId,
          fgQty,
          sourceType,
          sourceId,
          childEdge.id || null
        );
      }
    }
  };

  // Process each FG demand
  for (let i = 0; i < fgDemands.length; i++) {
    const fgDemand = fgDemands[i];
    
    if (onProgress) {
      onProgress('fg_processing', i + 1);
    }

    // Validate required fields
    if (!fgDemand.material_code || !fgDemand.plant_id || !fgDemand.time_bucket ||
        fgDemand.demand_qty === undefined || fgDemand.demand_qty === null) {
      errors.push(formatError(
        'INVALID_FG_DEMAND',
        'FG 需求缺少必要欄位',
        { provided: fgDemand },
        fgDemand.material_code
      ));
      continue;
    }

    // Convert time_bucket to date
    const bucketDate = timeBucketToDate(fgDemand.time_bucket);

    if (!bucketDate) {
      errors.push(formatError(
        'INVALID_TIME_BUCKET',
        ERROR_MESSAGES.INVALID_TIME_BUCKET(fgDemand.time_bucket),
        { fg_demand: fgDemand },
        fgDemand.material_code
      ));
      continue;
    }

    // Build BOM index
    const bomIndex = buildBomIndex(processedBomEdges, fgDemand.plant_id, bucketDate, errors);

    // Check BOM definition
    if (!bomIndex.has(fgDemand.material_code)) {
      errors.push(formatError(
        'MISSING_BOM',
        ERROR_MESSAGES.MISSING_BOM_DEFINITION(fgDemand.material_code),
        { plant_id: fgDemand.plant_id, time_bucket: fgDemand.time_bucket },
        fgDemand.material_code
      ));
      continue;
    }

    // Start explosion
    await explodeRecursive(
      {
        material_code: fgDemand.material_code,
        plant_id: fgDemand.plant_id,
        time_bucket: fgDemand.time_bucket,
        demand_qty: fgDemand.demand_qty,
        id: fgDemand.id,
      },
      1,
      1.0,
      [],
      bomIndex,
      fgDemand.material_code,
      fgDemand.id || null,
      fgDemand.demand_qty,
      fgDemand.source_type || null,
      fgDemand.source_id || null,
      null
    );
  }

  // Final flush
  await flushTraceBuffer();

  // Convert Map to componentDemandRows
  const componentDemandRows: ComponentDemandRow[] = [];
  for (const [key, demandQty] of componentDemandMap.entries()) {
    const { plantId, timeBucket, materialCode } = parseComponentKey(key);
    componentDemandRows.push({
      material_code: materialCode,
      plant_id: plantId,
      time_bucket: timeBucket,
      demand_qty: demandQty,
    });
  }

  return {
    componentDemandRows,
    traceRows: [], // Empty in streaming mode - traces are flushed via callback
    errors,
    stats: {
      totalTracesGenerated,
      totalTracesFlushed,
      flushCount,
    },
  };
}

// Copy of helper functions from bomCalculator.ts
function calculateComponentRequirement(
  parentQty: number,
  qtyPer: number,
  scrapRate: number = DEFAULTS.DEFAULT_SCRAP_RATE,
  yieldRate: number = DEFAULTS.DEFAULT_YIELD_RATE
): number {
  if (parentQty === null || parentQty === undefined) return 0;
  if (qtyPer === null || qtyPer === undefined) qtyPer = DEFAULTS.DEFAULT_QTY_PER;
  if (typeof parentQty !== 'number' || isNaN(parentQty) || parentQty < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('parentQty'));
  }
  if (qtyPer === 0) return 0;
  if (typeof scrapRate !== 'number' || isNaN(scrapRate) ||
      scrapRate < DEFAULTS.MIN_SCRAP_RATE || scrapRate >= DEFAULTS.MAX_SCRAP_RATE) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE('scrapRate', DEFAULTS.MIN_SCRAP_RATE, DEFAULTS.MAX_SCRAP_RATE));
  }
  if (typeof yieldRate !== 'number' || isNaN(yieldRate) ||
      yieldRate < DEFAULTS.MIN_YIELD_RATE || yieldRate > DEFAULTS.MAX_YIELD_RATE) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE('yieldRate', DEFAULTS.MIN_YIELD_RATE, DEFAULTS.MAX_YIELD_RATE));
  }
  const result = parentQty * qtyPer * (1 + scrapRate) / yieldRate;
  return roundTo(result, DEFAULTS.QUANTITY_DECIMALS);
}

function buildBomIndex(
  bomEdges: BOMEdge[],
  plantId: string,
  bucketDate: Date | null,
  errors: BomExplosionError[]
): Map<string, BOMEdge[]> {
  if (!Array.isArray(bomEdges)) {
    throw new Error(ERROR_MESSAGES.INVALID_ARRAY('bomEdges'));
  }
  if (!plantId || typeof plantId !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('plantId'));
  }
  if (bomEdges.length === 0) return new Map();

  const index = new Map<string, BOMEdge[]>();
  const overlapWarnings = new Map<string, boolean>();

  for (const edge of bomEdges) {
    if (edge.plant_id && edge.plant_id !== plantId) continue;
    if (bucketDate) {
      const validFrom = edge.valid_from ? new Date(edge.valid_from) : null;
      const validTo = edge.valid_to ? new Date(edge.valid_to) : null;
      if (validFrom && bucketDate < validFrom) continue;
      if (validTo && bucketDate > validTo) continue;
    }

    const parent = edge.parent_material;
    const child = edge.child_material;
    if (!index.has(parent)) index.set(parent, []);

    const edges = index.get(parent)!;
    const existingChild = edges.find(e => e.child_material === child);

    if (!existingChild) {
      edges.push(edge);
    } else {
      const overlapKey = `${parent}|${child}`;
      if (!overlapWarnings.has(overlapKey)) {
        errors.push(formatError(
          'OVERLAP_EFFECTIVITY',
          '同一時間有效的 BOM 記錄重疊',
          {
            existing_bom: { id: existingChild.id, priority: existingChild.priority, created_at: existingChild.created_at },
            new_bom: { id: edge.id, priority: edge.priority, created_at: edge.created_at },
          },
          parent,
          [parent, child]
        ));
        overlapWarnings.set(overlapKey, true);
      }

      let shouldReplace = false;
      if (edge.priority !== null && edge.priority !== undefined) {
        if (existingChild.priority === null || existingChild.priority === undefined) {
          shouldReplace = true;
        } else if (edge.priority < existingChild.priority) {
          shouldReplace = true;
        } else if (edge.priority === existingChild.priority) {
          const newCreatedAt = edge.created_at ? new Date(edge.created_at) : null;
          const existingCreatedAt = existingChild.created_at ? new Date(existingChild.created_at) : null;
          if (newCreatedAt && existingCreatedAt && newCreatedAt > existingCreatedAt) {
            shouldReplace = true;
          }
        }
      }

      if (shouldReplace) {
        const idx = edges.indexOf(existingChild);
        edges[idx] = edge;
      }
    }
  }

  return index;
}

function parseComponentKey(key: string): { plantId: string; timeBucket: string; materialCode: string } {
  const parts = key.split('|');
  return {
    plantId: parts[0],
    timeBucket: parts[1],
    materialCode: parts[2],
  };
}
