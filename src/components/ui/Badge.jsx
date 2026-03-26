import React from 'react';

const TYPE_STYLES = {
  info:    "bg-[var(--status-info-bg)] text-[var(--status-info-text)]",
  brand:   "bg-[var(--brand-50)] text-[var(--brand-700)]",
  neutral: "bg-[var(--surface-subtle)] text-[var(--text-secondary)]",
  success: "bg-[var(--status-success-bg)] text-[var(--status-success-text)]",
  warning: "bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]",
  danger:  "bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]",
};

const DOT_COLORS = {
  info:    "bg-[var(--status-info)]",
  brand:   "bg-[var(--brand-600)]",
  neutral: "bg-[var(--text-muted)]",
  success: "bg-[var(--status-success)]",
  warning: "bg-[var(--status-warning)]",
  danger:  "bg-[var(--status-danger)]",
};

const SIZE_STYLES = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-0.5 text-xs",
};

export const Badge = ({ children, type = "info", size = "md", dot = false, className = "" }) => {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${SIZE_STYLES[size] || SIZE_STYLES.md} ${TYPE_STYLES[type] || TYPE_STYLES.info} ${className}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${DOT_COLORS[type] || DOT_COLORS.info}`} />}
      {children}
    </span>
  );
};

export default Badge;
