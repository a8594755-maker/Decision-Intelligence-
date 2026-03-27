import React from 'react';

const BASE = 'animate-pulse bg-[var(--surface-subtle)] rounded';

/**
 * Skeleton — loading placeholder
 * @param {"text"|"rect"|"circle"} variant
 * @param {string} className — override width/height
 */
export const Skeleton = ({ variant = 'text', className = '' }) => {
  const variants = {
    text: `${BASE} h-4 w-full ${className}`,
    rect: `${BASE} h-24 w-full rounded-lg ${className}`,
    circle: `${BASE} h-10 w-10 rounded-full ${className}`,
  };
  return <div className={variants[variant] || variants.text} />;
};

/** Card skeleton — 3 text lines inside a card shape */
Skeleton.Card = ({ className = '' }) => (
  <div className={`bg-[var(--surface-card)] border border-[var(--border-default)] rounded-xl p-5 space-y-3 ${className}`}>
    <div className={`${BASE} h-5 w-2/5`} />
    <div className={`${BASE} h-4 w-full`} />
    <div className={`${BASE} h-4 w-3/4`} />
    <div className={`${BASE} h-4 w-1/2`} />
  </div>
);
Skeleton.Card.displayName = 'Skeleton.Card';

/** Chart skeleton — rectangle with axis hints */
Skeleton.Chart = ({ className = '', height = 'h-56' }) => (
  <div className={`bg-[var(--surface-card)] border border-[var(--border-default)] rounded-xl p-5 ${className}`}>
    <div className={`${BASE} h-4 w-1/3 mb-4`} />
    <div className="flex items-end gap-2">
      {[40, 65, 50, 80, 35, 70, 55].map((h, i) => (
        <div key={i} className={`${BASE} flex-1`} style={{ height: `${h}%`, minHeight: 20 }} />
      ))}
    </div>
    <div className={`${BASE} h-px w-full mt-2`} />
  </div>
);
Skeleton.Chart.displayName = 'Skeleton.Chart';

/** Table skeleton — header + N rows */
Skeleton.Table = ({ rows = 5, cols = 4, className = '' }) => (
  <div className={`bg-[var(--surface-card)] border border-[var(--border-default)] rounded-xl overflow-hidden ${className}`}>
    {/* Header */}
    <div className="flex gap-4 px-4 py-3 bg-[var(--surface-subtle)]">
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className={`${BASE} h-3 flex-1`} />
      ))}
    </div>
    {/* Rows */}
    {Array.from({ length: rows }).map((_, r) => (
      <div key={r} className="flex gap-4 px-4 py-3 border-t border-[var(--border-default)]">
        {Array.from({ length: cols }).map((_, c) => (
          <div key={c} className={`${BASE} h-4 flex-1`} style={{ width: `${60 + Math.random() * 40}%` }} />
        ))}
      </div>
    ))}
  </div>
);
Skeleton.Table.displayName = 'Skeleton.Table';

export default Skeleton;
