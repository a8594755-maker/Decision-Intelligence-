import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * SidePanel Component
 * 右側詳情面板，桌面端固定，行動端變抽屜
 * 
 * @param {boolean} isOpen - 是否開啟
 * @param {Function} onClose - 關閉回調
 * @param {string} title - 標題
 * @param {ReactNode} children - 內容
 * @param {ReactNode} emptyState - 空狀態內容（未選取時顯示）
 * @param {string} width - 寬度（桌面端）desktop | mobile
 * @param {string} position - 位置 left | right
 * @param {string} className - 額外 CSS class
 */
export const SidePanel = ({
  isOpen = false,
  onClose,
  title,
  children,
  emptyState,
  width = 'desktop', // desktop (桌面端固定) | mobile (行動端抽屜)
  position = 'right',
  className = ''
}) => {
  // 鍵盤 ESC 關閉
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen && onClose) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // 行動端鎖定滾動
  useEffect(() => {
    if (width === 'mobile' && isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen, width]);

  // 桌面端模式：固定在頁面中（不使用 overlay）
  if (width === 'desktop') {
    // 未開啟時，顯示空狀態
    if (!isOpen) {
      return emptyState || null;
    }

    return (
      <div className={`h-full ${className}`}>
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg h-full flex flex-col overflow-hidden">
          {/* Header */}
          {(title || onClose) && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
              <h3 className="font-semibold text-lg text-slate-900 dark:text-slate-100">
                {title}
              </h3>
              {onClose && (
                <button
                  onClick={onClose}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  aria-label="關閉"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
          )}
          
          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {children}
          </div>
        </div>
      </div>
    );
  }

  // 行動端模式：overlay + drawer（從右側滑入）
  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        className={`
          fixed top-0 ${position === 'right' ? 'right-0' : 'left-0'} bottom-0
          w-full max-w-md
          bg-white dark:bg-slate-800
          shadow-2xl z-50
          flex flex-col
          ${position === 'right' ? 'animate-slide-in-right' : 'animate-slide-in-left'}
          ${className}
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <h3 className="font-semibold text-lg text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              aria-label="關閉"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </>
  );
};

/**
 * SidePanelSection Component
 * SidePanel 內的區塊元件
 */
export const SidePanelSection = ({
  title,
  icon: Icon,
  children,
  className = ''
}) => {
  return (
    <div className={`space-y-2 ${className}`}>
      {title && (
        <div className="flex items-center gap-2 mb-2">
          {Icon && <Icon className="w-4 h-4 text-slate-600 dark:text-slate-400" />}
          <h4 className="font-semibold text-slate-700 dark:text-slate-300">
            {title}
          </h4>
        </div>
      )}
      <div className="space-y-2">
        {children}
      </div>
    </div>
  );
};

/**
 * SidePanelRow Component
 * SidePanel 內的資料行元件
 */
export const SidePanelRow = ({
  label,
  value,
  highlight = false,
  className = ''
}) => {
  return (
    <div className={`flex justify-between text-sm ${className}`}>
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <span className={`font-semibold ${
        highlight 
          ? 'text-blue-600 dark:text-blue-400' 
          : 'text-slate-900 dark:text-slate-100'
      }`}>
        {value}
      </span>
    </div>
  );
};

export default SidePanel;
