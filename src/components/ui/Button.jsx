import React from 'react';
import { Loader2 } from 'lucide-react';

const SIZE_STYLES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm md:text-base',
  lg: 'px-5 py-2.5 text-base',
};

export const Button = ({
  children,
  onClick,
  variant = "primary",
  size = "md",
  className = "",
  disabled = false,
  loading = false,
  icon: Icon,
  type = "button"
}) => {
  const baseStyles = "inline-flex items-center justify-center rounded-lg font-medium transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] focus:ring-offset-2 focus:ring-offset-[var(--focus-ring-offset)] disabled:opacity-50 disabled:cursor-not-allowed";

  const variants = {
    primary: "bg-[var(--brand-600)] hover:bg-[var(--brand-700)] active:brightness-90 text-white shadow-[0_2px_8px_rgba(13,148,136,0.3)]",
    secondary: "bg-[var(--surface-card)] border border-[var(--border-default)] text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-subtle)]",
    danger: "bg-[var(--status-danger)] hover:brightness-90 text-white",
    success: "bg-[var(--status-success)] hover:brightness-90 text-white",
    ghost: "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]",
  };

  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      className={`${baseStyles} ${SIZE_STYLES[size] || SIZE_STYLES.md} ${variants[variant] || variants.primary} ${className}`}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : Icon ? (
        <Icon className="w-4 h-4 mr-2" />
      ) : null}
      {children}
    </button>
  );
};

export default Button;
