import React from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Select Component
 * 原生 <select> 的樣式化包裝，支援鍵盤操作
 * 
 * @param {Array} options - 選項陣列 [{ value, label }] 或 string[]
 * @param {string} value - 當前選中值
 * @param {Function} onChange - 變更回調 (value) => void
 * @param {string} placeholder - 預設提示文字
 * @param {boolean} disabled - 是否禁用
 * @param {string} className - 額外 CSS class
 * @param {string} size - 尺寸 sm | md | lg
 */
export const Select = ({
  options = [],
  value,
  onChange,
  placeholder = '請選擇',
  disabled = false,
  className = '',
  size = 'md',
  ...props
}) => {
  // 處理選項格式（支援 string[] 或 object[]）
  const normalizedOptions = options.map(opt => {
    if (typeof opt === 'string') {
      return { value: opt, label: opt };
    }
    return opt;
  });

  // 尺寸樣式
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
          w-full appearance-none rounded-lg border border-slate-300 dark:border-slate-600
          bg-white dark:bg-slate-700
          text-slate-900 dark:text-slate-100
          ${sizeClasses[size]}
          pr-10
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500
          disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed
          dark:disabled:bg-slate-800 dark:disabled:text-slate-600
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
      
      {/* 下拉箭頭圖示 */}
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
        <ChevronDown className="w-4 h-4" />
      </div>
    </div>
  );
};

/**
 * SelectGroup Component
 * 帶標籤的 Select 元件
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
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      {children}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {helperText && !error && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{helperText}</p>
      )}
    </div>
  );
};

export default Select;
