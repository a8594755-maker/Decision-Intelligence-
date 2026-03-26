import React from 'react';

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
  icon: Icon,
  type = "button"
}) => {
  const baseStyles = "flex items-center justify-center rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";

  const variants = {
    primary: "bg-[var(--brand-600)] hover:bg-[var(--brand-700)] active:brightness-90 text-white focus:ring-[var(--brand-500)] shadow-[0_2px_8px_rgba(13,148,136,0.3)]",
    secondary: "bg-[var(--surface-card)] border border-[var(--border-default)] text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-subtle)] focus:ring-[var(--brand-500)]",
    danger: "bg-red-600 hover:bg-red-700 text-white focus:ring-red-500",
    success: "bg-emerald-600 hover:bg-emerald-700 text-white focus:ring-emerald-500",
    ghost: "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus:ring-[var(--brand-500)]",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${baseStyles} ${SIZE_STYLES[size] || SIZE_STYLES.md} ${variants[variant] || variants.primary} ${className}`}
    >
      {Icon && <Icon className="w-4 h-4 mr-2" />}
      {children}
    </button>
  );
};

export default Button;
