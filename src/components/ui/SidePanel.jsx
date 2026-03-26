import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * SidePanel Component
 * Right-side details panel, fixed on desktop, drawer on mobile
 */
export const SidePanel = ({
  isOpen = false,
  onClose,
  title,
  children,
  emptyState,
  width = 'desktop',
  position = 'right',
  className = ''
}) => {
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen && onClose) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (width === 'mobile' && isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen, width]);

  if (width === 'desktop') {
    if (!isOpen) {
      return emptyState || null;
    }

    return (
      <div className={`h-full ${className}`}>
        <div className="bg-[var(--surface-card)] rounded-xl border border-[var(--border-default)] shadow-lg h-full flex flex-col overflow-hidden">
          {(title || onClose) && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)] bg-[var(--surface-subtle)]">
              <h3 className="font-semibold text-lg text-[var(--text-primary)]">
                {title}
              </h3>
              {onClose && (
                <button
                  onClick={onClose}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded hover:bg-[var(--accent-hover)] transition-colors"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4">
            {children}
          </div>
        </div>
      </div>
    );
  }

  if (!isOpen) return null;

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
        aria-hidden="true"
      />

      <div
        className={`
          fixed top-0 ${position === 'right' ? 'right-0' : 'left-0'} bottom-0
          w-full max-w-md
          bg-[var(--surface-card)]
          shadow-2xl z-50
          flex flex-col
          ${position === 'right' ? 'animate-slide-in-right' : 'animate-slide-in-left'}
          ${className}
        `}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)] bg-[var(--surface-subtle)]">
          <h3 className="font-semibold text-lg text-[var(--text-primary)]">
            {title}
          </h3>
          {onClose && (
            <button
              onClick={onClose}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded hover:bg-[var(--accent-hover)] transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </>
  );
};

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
          {Icon && <Icon className="w-4 h-4 text-[var(--text-secondary)]" />}
          <h4 className="font-semibold text-[var(--text-secondary)]">
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

export const SidePanelRow = ({
  label,
  value,
  highlight = false,
  className = ''
}) => {
  return (
    <div className={`flex justify-between text-sm ${className}`}>
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className={`font-semibold ${
        highlight
          ? 'text-[var(--brand-600)]'
          : 'text-[var(--text-primary)]'
      }`}>
        {value}
      </span>
    </div>
  );
};

export default SidePanel;
