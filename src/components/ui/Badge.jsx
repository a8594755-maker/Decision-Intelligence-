import React from 'react';

export const Badge = ({ children, type = "info" }) => {
  const styles = {
    info:    "bg-[var(--brand-50)] text-[var(--brand-700)] dark:text-[var(--brand-500)]",
    brand:   "bg-[var(--brand-50)] text-[var(--brand-700)] dark:text-[var(--brand-500)]",
    neutral: "bg-[var(--surface-subtle)] text-[var(--text-secondary)]",
    success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    warning: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    danger:  "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };

  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[type] || styles.info}`}>
      {children}
    </span>
  );
};

export default Badge;
