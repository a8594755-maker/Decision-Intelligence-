// canvasLayoutSchema.js
// ─────────────────────────────────────────────────────────────────────────────
// Layout JSON schema definition, validation, and overlap auto-fix for the
// Agent-Driven Canvas in Insights Hub.
// ─────────────────────────────────────────────────────────────────────────────

export const GRID_COLUMNS = 12;

export const BLOCK_TYPES = Object.freeze([
  'metric',
  'chart',
  'table',
  'narrative',
  'findings',
  'alert',
  'donut_group',
  'horizontal_bar',
  'kpi_row',
  'progress',
]);

const BLOCK_TYPE_SET = new Set(BLOCK_TYPES);

// ── Validation helpers ───────────────────────────────────────────────────────

function isPositiveInt(v) { return Number.isInteger(v) && v > 0; }

function validateBlock(block, index) {
  const errors = [];
  if (!block.id) errors.push(`blocks[${index}]: missing id`);
  if (!BLOCK_TYPE_SET.has(block.type)) errors.push(`blocks[${index}]: unknown type "${block.type}"`);
  if (!isPositiveInt(block.col) || block.col > GRID_COLUMNS) errors.push(`blocks[${index}]: invalid col ${block.col}`);
  if (!isPositiveInt(block.row)) errors.push(`blocks[${index}]: invalid row ${block.row}`);
  if (!isPositiveInt(block.colSpan) || block.col + block.colSpan - 1 > GRID_COLUMNS) errors.push(`blocks[${index}]: colSpan overflows grid`);
  if (!isPositiveInt(block.rowSpan)) errors.push(`blocks[${index}]: invalid rowSpan ${block.rowSpan}`);
  if (!block.props || typeof block.props !== 'object') errors.push(`blocks[${index}]: missing props`);
  return errors;
}

/**
 * Validate a canvas layout JSON.
 * Returns { valid: boolean, errors: string[], layout: object }
 * When valid=false, layout may still contain a best-effort patched version.
 */
export function validateLayout(json) {
  const errors = [];

  if (!json || typeof json !== 'object') {
    return { valid: false, errors: ['Layout must be a non-null object'], layout: buildEmptyLayout() };
  }

  if (!Array.isArray(json.blocks)) {
    return { valid: false, errors: ['Layout.blocks must be an array'], layout: buildEmptyLayout() };
  }

  // Validate individual blocks
  const validBlocks = [];
  for (let i = 0; i < json.blocks.length; i++) {
    const blockErrors = validateBlock(json.blocks[i], i);
    if (blockErrors.length === 0) {
      validBlocks.push({ ...json.blocks[i] });
    } else {
      errors.push(...blockErrors);
    }
  }

  // Auto-fix overlaps on valid blocks
  const fixedBlocks = autoFixOverlaps(validBlocks);

  const layout = {
    title: json.title || '',
    subtitle: json.subtitle || '',
    thinking: json.thinking || '',
    blocks: fixedBlocks,
  };

  return { valid: errors.length === 0, errors, layout };
}

// ── Overlap detection & auto-fix ─────────────────────────────────────────────

/**
 * Detect and fix overlapping blocks by shifting colliding blocks downward.
 * Uses a simple occupied-cell grid approach.
 */
export function autoFixOverlaps(blocks) {
  if (!blocks.length) return blocks;

  const result = [];
  // Track occupied cells: Map<"col,row" → blockId>
  const occupied = new Set();

  function markOccupied(b) {
    for (let r = b.row; r < b.row + b.rowSpan; r++) {
      for (let c = b.col; c < b.col + b.colSpan; c++) {
        occupied.add(`${c},${r}`);
      }
    }
  }

  function isColliding(b) {
    for (let r = b.row; r < b.row + b.rowSpan; r++) {
      for (let c = b.col; c < b.col + b.colSpan; c++) {
        if (occupied.has(`${c},${r}`)) return true;
      }
    }
    return false;
  }

  // Sort by row then col for deterministic placement
  const sorted = [...blocks].sort((a, b) => a.row - b.row || a.col - b.col);

  for (const block of sorted) {
    const b = { ...block };
    // Clamp colSpan to grid
    if (b.col + b.colSpan - 1 > GRID_COLUMNS) {
      b.colSpan = GRID_COLUMNS - b.col + 1;
    }
    // Shift down until no collision
    let maxShifts = 100;
    while (isColliding(b) && maxShifts-- > 0) {
      b.row += 1;
    }
    markOccupied(b);
    result.push(b);
  }

  return result;
}

// ── Empty / placeholder layout ───────────────────────────────────────────────

export function buildEmptyLayout() {
  return {
    title: 'Insights Hub',
    subtitle: '',
    thinking: '',
    blocks: [],
  };
}

/**
 * Build a loading placeholder layout with skeleton blocks.
 */
export function buildSkeletonLayout() {
  return {
    title: 'Insights Hub',
    subtitle: 'Analyzing your data...',
    thinking: '',
    blocks: [
      { id: 'skel_1', type: 'kpi_row', col: 1, row: 1, colSpan: 12, rowSpan: 1, props: { loading: true, count: 4 } },
      { id: 'skel_2', type: 'chart', col: 1, row: 2, colSpan: 8, rowSpan: 2, props: { loading: true } },
      { id: 'skel_3', type: 'chart', col: 9, row: 2, colSpan: 4, rowSpan: 2, props: { loading: true } },
      { id: 'skel_4', type: 'narrative', col: 1, row: 4, colSpan: 6, rowSpan: 1, props: { loading: true } },
      { id: 'skel_5', type: 'findings', col: 7, row: 4, colSpan: 6, rowSpan: 1, props: { loading: true } },
    ],
  };
}
