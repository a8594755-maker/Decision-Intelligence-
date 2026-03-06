import React from 'react';
import Card from './Card';
import Button from './Button';

/**
 * Modal Component
 * General-purpose dialog component
 */
export const Modal = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  icon: Icon,
  iconBgColor = "bg-indigo-50 dark:bg-indigo-900/30",
  iconColor = "text-indigo-600",
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmVariant = "primary",
  children
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-md w-full">
        {(Icon || title) && (
          <div className="flex items-center gap-3 mb-4">
            {Icon && (
              <div className={`w-12 h-12 rounded-full ${iconBgColor} flex items-center justify-center`}>
                <Icon className={`w-6 h-6 ${iconColor}`} />
              </div>
            )}
            <div>
              {title && <h3 className="text-lg font-semibold">{title}</h3>}
              {description && <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{description}</p>}
            </div>
          </div>
        )}

        {children && <div className="mb-4">{children}</div>}

        <div className="flex gap-2 justify-end">
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              {cancelText}
            </Button>
          )}
          {onConfirm && (
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmText}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};

export default Modal;
