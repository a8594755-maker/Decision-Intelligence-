import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * SidePanel Component
 * Right-side details panel, fixed on desktop, drawer on mobile
 * 
 * @param {boolean} isOpen - Whether panel is open
 * @param {Function} onClose - Close callback
 * @param {string} title - Title
 * @param {ReactNode} children - Content
 * @param {ReactNode} emptyState - Empty state content (shown when nothing selected)
 * @param {string} width - Width mode: desktop | mobile
 * @param {string} position - Position: left | right
 * @param {string} className - Additional CSS class
 */
export const SidePanel = ({
  isOpen = false,
  onClose,
  title,
  children,
  emptyState,
  width = 'desktop', // desktop (fixed) | mobile (drawer)
  position = 'right',
  className = ''
}) => {
  // Keyboard ESC close
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen && onClose) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Mobile lock scroll
  useEffect(() => {
    if (width === 'mobile' && isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen, width]);

  // Desktop mode: fixed in page (no overlay)
  if (width === 'desktop') {
    // When not open, show empty state
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
                  aria-label="Close"
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

  // Mobile mode: overlay + drawer (slide in from right)
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
              aria-label="Close"
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
 * Section component within SidePanel
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
 * Data row component within SidePanel
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
          ? 'text-indigo-600 dark:text-indigo-400'
          : 'text-slate-900 dark:text-slate-100'
      }`}>
        {value}
      </span>
    </div>
  );
};

export default SidePanel;
