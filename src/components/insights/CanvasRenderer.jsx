/**
 * CanvasRenderer.jsx
 *
 * Renders an agent-generated layout JSON as a 12-column CSS Grid.
 * Each block is placed via grid-column/grid-row with spans.
 * Responsive: on mobile (< md) all blocks become full-width stacked.
 */

import { Suspense } from 'react';
import BLOCK_REGISTRY from './blocks';
import { GRID_COLUMNS } from '../../services/canvas/canvasLayoutSchema';

// ── Fallback for unknown block types ─────────────────────────────────────────

function UnknownBlock({ type }) {
  return (
    <div className="h-full rounded-xl border border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50 p-4 flex items-center justify-center">
      <p className="text-xs text-slate-400 dark:text-slate-500">Unknown block type: {type}</p>
    </div>
  );
}

// ── Single block renderer ────────────────────────────────────────────────────

function CanvasBlock({ block, onAction, runningQuery }) {
  const Component = BLOCK_REGISTRY[block.type];

  if (!Component) {
    return <UnknownBlock type={block.type} />;
  }

  // Pass loading state to suggestion blocks so the active one shows a spinner
  const extraProps = (block.type === 'suggestion' && runningQuery)
    ? { loading: runningQuery === block.props?.query }
    : {};

  return (
    <Suspense fallback={<div className="animate-pulse h-full rounded-xl bg-slate-100 dark:bg-slate-800" />}>
      <Component {...(block.props || {})} {...extraProps} onAction={onAction} />
    </Suspense>
  );
}

// ── Row height mapping ───────────────────────────────────────────────────────

const ROW_HEIGHT = 'minmax(120px, auto)';

function computeMaxRow(blocks) {
  if (!blocks.length) return 1;
  return Math.max(...blocks.map((b) => b.row + b.rowSpan - 1));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

export default function CanvasRenderer({ layout, onAction, runningQuery }) {
  if (!layout?.blocks?.length) {
    return null;
  }

  const maxRow = computeMaxRow(layout.blocks);

  return (
    <div
      className="grid gap-4 w-full"
      style={{
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
        gridTemplateRows: `repeat(${maxRow}, ${ROW_HEIGHT})`,
      }}
    >
      {layout.blocks.map((block) => (
        <div
          key={block.id}
          className="min-w-0 min-h-0 canvas-block"
          style={{
            gridColumn: `${block.col} / span ${block.colSpan}`,
            gridRow: `${block.row} / span ${block.rowSpan}`,
          }}
        >
          <CanvasBlock block={block} onAction={onAction} runningQuery={runningQuery} />
        </div>
      ))}

      {/* Responsive override: on mobile, stack all blocks full-width */}
      <style>{`
        @media (max-width: 768px) {
          .canvas-block {
            grid-column: 1 / -1 !important;
            grid-row: auto !important;
          }
        }
      `}</style>
    </div>
  );
}
