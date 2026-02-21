/**
 * PermissionGate.jsx
 *
 * Wrapper component: decides whether to render children based on role.
 *
 * Three modes:
 *   hide    → don't render at all (default)
 *   disable → render but disabled (preserves layout, indicates existence)
 *   tooltip → disabled + tooltip explaining why
 *
 * Usage:
 *   <PermissionGate action={ACTIONS.RUN_PLAN}>
 *     <Button onClick={handleRunPlan}>Run Plan</Button>
 *   </PermissionGate>
 *
 *   <PermissionGate action={ACTIONS.APPROVE_PLAN} mode="disable">
 *     <Button onClick={handleApprove}>Approve</Button>
 *   </PermissionGate>
 */

import React, { cloneElement } from 'react';
import { usePermissions } from '../../hooks/usePermissions';

export default function PermissionGate({
  action,
  mode = 'hide',        // 'hide' | 'disable' | 'tooltip'
  fallback = null,       // content to show in hide mode when not allowed
  reason,                // tooltip text for tooltip mode
  children,
}) {
  const { can, isLoaded } = usePermissions();

  // Loading: render skeleton to avoid flash
  if (!isLoaded) {
    return mode === 'hide' ? null : (
      <span className="opacity-0 pointer-events-none">{children}</span>
    );
  }

  const allowed = can(action);

  // Allowed → render normally
  if (allowed) return children;

  // Not allowed
  if (mode === 'hide') return fallback;

  if (mode === 'disable') {
    const child = React.Children.only(children);
    return cloneElement(child, {
      disabled: true,
      'aria-disabled': true,
      className: `${child.props.className || ''} opacity-40 cursor-not-allowed`,
    });
  }

  if (mode === 'tooltip') {
    const child = React.Children.only(children);
    const disabledChild = cloneElement(child, {
      disabled: true,
      'aria-disabled': true,
      className: `${child.props.className || ''} opacity-40 cursor-not-allowed`,
    });
    return (
      <div
        title={reason || `Requires ${action} permission`}
        className="inline-flex"
      >
        {disabledChild}
      </div>
    );
  }

  return fallback;
}
