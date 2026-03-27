import React from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Select Component
 * Styled wrapper for native <select>, supports keyboard interaction
 */
export const Select = ({
  options = [],
  value,
  onChange,
  placeholder = 'Select...',
  disabled = false,
  className = '',
  size = 'md',
  error = false,
  ...props
}) => {
  const normalizedOptions = options.map(opt => {
    if (typeof opt === 'string') {
      return { value: opt, label: opt };
    }
    return opt;
  });

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-2 text-sm',
    lg: 'px-4 py-3 text-base'
  };

  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
        disabled={disabled}
        className={`
          w-full appearance-none rounded-lg border
          ${error
            ? 'border-[var(--status-danger)] ring-1 ring-[var(--status-danger)]'
            : 'border-[var(--border-strong)]'
          }
          bg-[var(--surface-card)]
          text-[var(--text-primary)]
          ${sizeClasses[size]}
          pr-10 cursor-pointer
          focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] focus:border-[var(--focus-ring)]
          disabled:bg-[var(--surface-subtle)] disabled:text-[var(--text-muted)] disabled:cursor-not-allowed
          transition-colors
        `}
        {...props}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {normalizedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {/* Dropdown arrow icon */}
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
        <ChevronDown className="w-4 h-4" />
      </div>
    </div>
  );
};

/**
 * SelectGroup Component
 * Select component with label
 */
export const SelectGroup = ({
  label,
  error,
  helperText,
  required = false,
  children,
  className = ''
}) => {
  return (
    <div className={`space-y-1 ${className}`}>
      {label && (
        <label className="block text-sm font-medium text-[var(--text-secondary)]">
          {label}
          {required && <span className="text-[var(--status-danger)] ml-1">*</span>}
        </label>
      )}
      {children}
      {error && (
        <p className="text-xs text-[var(--status-danger-text)]">{error}</p>
      )}
      {helperText && !error && (
        <p className="text-xs text-[var(--text-muted)]">{helperText}</p>
      )}
    </div>
  );
};

export default Select;
