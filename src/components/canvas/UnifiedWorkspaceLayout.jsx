/**
 * UnifiedWorkspaceLayout — The Trinity Layout (3-Pane Canvas Architecture)
 *
 * ┌──────────┬──────────────────────┬──────────────────────┐
 * │  Context  │   Interaction Feed   │    Dynamic Canvas    │
 * │  & Nav    │   (Chat / Tasks)     │    (Widgets)         │
 * │   20%     │       40%            │       40%            │
 * └──────────┴──────────────────────┴──────────────────────┘
 *
 * - Left: ContextPanel (navigation, history, worker info)
 * - Center: Interaction Feed (chat thread, task cards, execution progress)
 * - Right: DynamicCanvas (artifact-driven widget renderer)
 *
 * The center pane is provided as children.
 * The right pane auto-expands when a widget is active, collapses when empty.
 */

import React, { useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCanvas } from '../../contexts/CanvasContext';
import DynamicCanvas from './DynamicCanvas';

// The left pane (ContextPanel) has been intentionally removed from the layout.
// Navigation is provided by the AppShell sidebar (always visible) and the DSV's
// internal conversation sidebar.  Adding a third nav column caused triple-sidebar
// issues.  The ContextPanel component remains available for future use when the
// workspace replaces AppShell entirely.

export default function UnifiedWorkspaceLayout({ children }) {
  const { activeWidget } = useCanvas();
  const [collapsedWidgetKey, setCollapsedWidgetKey] = useState(null);
  const currentWidgetKey = activeWidget?.instanceId || null;
  const rightCollapsed = Boolean(currentWidgetKey && collapsedWidgetKey === currentWidgetKey);

  const toggleRightPane = () => {
    if (!currentWidgetKey) return;
    setCollapsedWidgetKey(prev => (prev === currentWidgetKey ? null : currentWidgetKey));
  };

  return (
    <div className="h-full flex overflow-hidden" style={{ backgroundColor: 'var(--surface-base)' }}>
      {/* ── Center Pane: Interaction Feed (Chat + Conversation Sidebar) ── */}
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {children}
      </div>

      {/* Right expand/collapse toggle */}
      {activeWidget && (
        <button
          onClick={toggleRightPane}
          className="flex-shrink-0 w-5 flex items-center justify-center hover:bg-gray-100 transition-colors border-l"
          style={{ borderColor: 'var(--border-default)' }}
          title={rightCollapsed ? 'Show canvas' : 'Hide canvas'}
        >
          {rightCollapsed ? <PanelRightOpen size={12} style={{ color: 'var(--text-muted)' }} /> : <PanelRightClose size={12} style={{ color: 'var(--text-muted)' }} />}
        </button>
      )}

      {/* ── Right Pane: Dynamic Canvas ────────────────────────────── */}
      {activeWidget && !rightCollapsed && (
        <div
          className="flex-shrink-0 border-l overflow-hidden transition-all duration-200"
          style={{
            width: '40%',
            minWidth: 300,
            maxWidth: '60%',
            borderColor: 'var(--border-default)',
          }}
        >
          <DynamicCanvas />
        </div>
      )}
    </div>
  );
}
