// ============================================
// BOM Explosion Calculator - Ported from Frontend
// Pure calculation logic, no side effects
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
import { DEFAULTS, ERROR_MESSAGES } from './types.ts';
import { roundTo, getAggregationKey, timeBucketToDate, formatError } from './utils.ts';

/**
 * Calculate component requirement considering scrap and yield
 * Formula: component_qty = parent_qty × qty_per × (1 + scrap_rate) / yield_rate
 */
export function calculateComponentRequirement(
  parentQty: number,
  qtyPer: number,
  scrapRate: number = DEFAULTS.DEFAULT_SCRAP_RATE,
  yieldRate: number = DEFAULTS.DEFAULT_YIELD_RATE
): number {
  // Handle null/undefined
  if (parentQty === null || parentQty === undefined) {
    return 0;
  }
  if (qtyPer === null || qtyPer === undefined) {
    qtyPer = DEFAULTS.DEFAULT_QTY_PER;
  }

  // Validation
  if (typeof parentQty !== 'number' || isNaN(parentQty) || parentQty < 0) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('parentQty'));
  }

  if (typeof qtyPer !== 'number' || isNaN(qtyPer) || qtyPer < DEFAULTS.MIN_QTY_PER) {
    throw new Error(ERROR_MESSAGES.NEGATIVE_NUMBER('qtyPer'));
  }

  if (qtyPer === 0) {
    return 0;
  }

  // Scrap rate validation (prevent division by zero)
  if (typeof scrapRate !== 'number' || isNaN(scrapRate) ||
      scrapRate < DEFAULTS.MIN_SCRAP_RATE || scrapRate >= DEFAULTS.MAX_SCRAP_RATE) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE('scrapRate', DEFAULTS.MIN_SCRAP_RATE, DEFAULTS.MAX_SCRAP_RATE));
  }

  // Yield rate validation (prevent division by zero)
  if (typeof yieldRate !== 'number' || isNaN(yieldRate) ||
      yieldRate < DEFAULTS.MIN_YIELD_RATE || yieldRate > DEFAULTS.MAX_YIELD_RATE) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE('yieldRate', DEFAULTS.MIN_YIELD_RATE, DEFAULTS.MAX_YIELD_RATE));
  }

  const result = parentQty * qtyPer * (1 + scrapRate) / yieldRate;
  return roundTo(result, DEFAULTS.QUANTITY_DECIMALS);
}

/**
 * Build BOM index by parent_material with filtering
 * Filters: plant_id matching, time_bucket effectivity, priority selection
 */
export function buildBomIndex(
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

  if (bomEdges.length === 0) {
    return new Map();
  }

  const index = new Map<string, BOMEdge[]>();
  const overlapWarnings = new Map<string, boolean>();

  for (const edge of bomEdges) {
    // Filter 1: Plant matching (plant_id matches or null for generic BOM)
    if (edge.plant_id && edge.plant_id !== plantId) {
      continue;
    }

    // Filter 2: Effectivity date range
    if (bucketDate) {
      const validFrom = edge.valid_from ? new Date(edge.valid_from) : null;
      const validTo = edge.valid_to ? new Date(edge.valid_to) : null;

      if (validFrom && bucketDate < validFrom) {
        continue; // Not yet effective
      }
      if (validTo && bucketDate > validTo) {
        continue; // Expired
      }
    }

    const parent = edge.parent_material;
    const child = edge.child_material;

    if (!index.has(parent)) {
      index.set(parent, []);
    }

    const edges = index.get(parent)!;
    const existingChild = edges.find(e => e.child_material === child);

    if (!existingChild) {
      edges.push(edge);
    } else {
      // Handle overlapping effectivity - log warning once per parent/child pair
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

      // Selection rule: lower priority wins, then newer created_at
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
      } else {
        if (existingChild.priority === null || existingChild.priority === undefined) {
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

/**
 * Recursive BOM explosion
 */
function explodeBOMRecursive(
  parentDemand: { material_code: string; plant_id: string; time_bucket: string; demand_qty: number; id?: string },
  bomLevel: number,
  multiplier: number,
  path: string[],
  bomIndex: Map<string, BOMEdge[]>,
  componentDemandMap: Map<string, number>,
  traceRows: TraceRow[],
  errors: BomExplosionError[],
  maxDepth: number,
  fgMaterialCode: string,
  fgDemandId: string | null,
  fgQty: number,
  sourceType: string | null,
  sourceId: string | null,
  bomEdgeId: string | null
): void {
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

    traceRows.push({
      fg_material_code: fgMaterialCode,
      component_material_code: parentDemand.material_code,
      plant_id: parentDemand.plant_id,
      time_bucket: parentDemand.time_bucket,
      fg_qty: fgQty,
      component_qty: parentDemand.demand_qty,
      source_type: sourceType,
      source_id: sourceId,
      path: fullPath,
      fg_demand_id: fgDemandId,
      bom_edge_id: bomEdgeId,
      bom_level: componentBomLevel,
      qty_multiplier: multiplier,
    });
  }

  // Recursively explode children
  if (children.length > 0) {
    for (const childEdge of children) {
      const scrapRate = childEdge.scrap_rate ?? DEFAULTS.DEFAULT_SCRAP_RATE;
      const yieldRate = childEdge.yield_rate ?? DEFAULTS.DEFAULT_YIELD_RATE;

      // Calculate child quantity
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

      const childDemand = {
        material_code: childEdge.child_material,
        plant_id: parentDemand.plant_id,
        time_bucket: parentDemand.time_bucket,
        demand_qty: childQty,
        id: undefined,
      };

      explodeBOMRecursive(
        childDemand,
        bomLevel + 1,
        newMultiplier,
        [...path, parentDemand.material_code],
        bomIndex,
        componentDemandMap,
        traceRows,
        errors,
        maxDepth,
        fgMaterialCode,
        fgDemandId,
        fgQty,
        sourceType,
        sourceId,
        childEdge.id || null
      );
    }
  }
}

/**
 * Main BOM explosion function
 * Pure function - no side effects
 */
export function explodeBOM(
  fgDemands: FGDemand[],
  bomEdges: BOMEdge[],
  options: ExplosionOptions = {}
): ExplosionResult {
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
  } = options;

  const componentDemandMap = new Map<string, number>();
  const traceRows: TraceRow[] = [];
  const errors: BomExplosionError[] = [];

  // Early return: empty inputs
  if (fgDemands.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [formatError('NO_INPUT', ERROR_MESSAGES.EMPTY_ARRAY('fgDemands'))],
    };
  }

  if (bomEdges.length === 0) {
    return {
      componentDemandRows: [],
      traceRows: [],
      errors: [formatError('NO_BOM', ERROR_MESSAGES.EMPTY_ARRAY('bomEdges'))],
    };
  }

  // Process BOM edges (ignore scrap if flag set)
  const processedBomEdges = ignoreScrap
    ? bomEdges.map(edge => ({ ...edge, scrap_rate: 0, yield_rate: 1 }))
    : bomEdges;

  // Explode each FG demand
  for (const fgDemand of fgDemands) {
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

    // Build BOM index for this FG
    const bomIndex = buildBomIndex(processedBomEdges, fgDemand.plant_id, bucketDate, errors);

    // Check if BOM definition exists
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
    explodeBOMRecursive(
      {
        material_code: fgDemand.material_code,
        plant_id: fgDemand.plant_id,
        time_bucket: fgDemand.time_bucket,
        demand_qty: fgDemand.demand_qty,
        id: fgDemand.id,
      },
      1, // bomLevel
      1.0, // multiplier
      [], // path
      bomIndex,
      componentDemandMap,
      traceRows,
      errors,
      maxDepth,
      fgDemand.material_code,
      fgDemand.id || null,
      fgDemand.demand_qty,
      fgDemand.source_type || null,
      fgDemand.source_id || null,
      null // bomEdgeId (FG has no edge)
    );
  }

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
    traceRows,
    errors,
  };
}

/**
 * Parse component key (reverse of getAggregationKey)
 */
function parseComponentKey(key: string): { plantId: string; timeBucket: string; materialCode: string } {
  const parts = key.split('|');
  return {
    plantId: parts[0],
    timeBucket: parts[1],
    materialCode: parts[2],
  };
}
