/**
 * ChatActionBar.jsx
 *
 * Renders context-aware action buttons above or below the chat composer.
 * Actions are filtered by the current chat_session_context — only available
 * actions are shown.
 *
 * Used as a "next best action" strip that adapts to where the user is
 * in the decision workflow.
 */

import React, { useMemo } from 'react';
import {
  Upload, FileCheck, TrendingUp, Calculator, ShieldAlert,
  Workflow, AlertTriangle, FlaskConical, GitCompare, Layers,
  Dices, SearchCheck, ActivitySquare, Handshake, ListChecks,
  CheckSquare, ClipboardCheck, Archive, ArrowRight,
} from 'lucide-react';

const ICON_MAP = {
  Upload, FileCheck, TrendingUp, Calculator, ShieldAlert,
  Workflow, AlertTriangle, FlaskConical, GitCompare, Layers,
  Dices, SearchCheck, ActivitySquare, Handshake, ListChecks,
  CheckSquare, ClipboardCheck, Archive,
};

/**
 * @param {Object} props
 * @param {Array<Object>} props.actions - From getAvailableActions() or suggestNextActions()
 * @param {Function} props.onActionClick - (action_id) => void
 * @param {number} [props.maxVisible=4] - Max number of actions to show
 * @param {string} [props.variant='compact'] - 'compact' | 'full'
 */
export default function ChatActionBar({ actions = [], onActionClick, maxVisible = 4, variant = 'compact' }) {
  const visibleActions = useMemo(() => {
    return actions.slice(0, maxVisible);
  }, [actions, maxVisible]);

  if (visibleActions.length === 0) return null;

  if (variant === 'compact') {
    return (
      <div className="flex flex-wrap gap-1.5 px-1 py-1.5">
        {visibleActions.map((action) => {
          const IconComponent = ICON_MAP[action.icon] || ArrowRight;
          return (
            <button
              key={action.action_id || action.id}
              type="button"
              onClick={() => onActionClick?.(action.action_id || action.id)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:bg-[var(--accent-active)] dark:hover:bg-[var(--accent-active)] hover:border-[var(--brand-500)] hover:text-[var(--brand-600)] transition-all duration-150 shadow-sm"
              title={action.description}
            >
              <IconComponent className="w-3.5 h-3.5" />
              <span>{action.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Full variant — vertical list with descriptions
  return (
    <div className="space-y-1 px-1 py-1.5">
      {visibleActions.map((action) => {
        const IconComponent = ICON_MAP[action.icon] || ArrowRight;
        return (
          <button
            key={action.action_id || action.id}
            type="button"
            onClick={() => onActionClick?.(action.action_id || action.id)}
            className="w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] hover:bg-[var(--accent-active)] dark:hover:bg-[var(--accent-active)] hover:border-[var(--brand-500)] transition-all duration-150"
          >
            <div className="p-1 rounded-md bg-[var(--surface-subtle)] shrink-0">
              <IconComponent className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[var(--text-secondary)] truncate">
                {action.label}
              </div>
              {action.description && (
                <div className="text-[10px] text-[var(--text-muted)] truncate">
                  {action.description}
                </div>
              )}
            </div>
            <ArrowRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
          </button>
        );
      })}
    </div>
  );
}
