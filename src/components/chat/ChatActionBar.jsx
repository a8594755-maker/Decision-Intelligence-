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
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-700 dark:hover:text-indigo-300 transition-all duration-150 shadow-sm"
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
            className="w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:border-indigo-300 dark:hover:border-indigo-700 transition-all duration-150"
          >
            <div className="p-1 rounded-md bg-slate-100 dark:bg-slate-700 shrink-0">
              <IconComponent className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">
                {action.label}
              </div>
              {action.description && (
                <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
                  {action.description}
                </div>
              )}
            </div>
            <ArrowRight className="w-3 h-3 text-slate-300 dark:text-slate-600 shrink-0" />
          </button>
        );
      })}
    </div>
  );
}
