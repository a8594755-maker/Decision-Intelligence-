import React from 'react';
import { Inbox } from 'lucide-react';
import Button from './Button';

/**
 * EmptyState — standard empty / zero-data placeholder
 * @param {ReactNode} icon — Lucide icon component (default: Inbox)
 * @param {string} title
 * @param {string} description
 * @param {string} actionLabel — CTA button text
 * @param {Function} onAction — CTA click handler
 */
export const EmptyState = ({
  icon: IconComponent = Inbox,
  title = 'No data yet',
  description,
  actionLabel,
  onAction,
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center py-16 px-6 text-center ${className}`}>
      <div className="w-12 h-12 rounded-full bg-[var(--surface-subtle)] flex items-center justify-center mb-4">
        <IconComponent className="w-6 h-6 text-[var(--text-muted)]" />
      </div>
      <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-[var(--text-secondary)] max-w-sm mb-4">{description}</p>
      )}
      {actionLabel && onAction && (
        <Button variant="primary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
};

export default EmptyState;
