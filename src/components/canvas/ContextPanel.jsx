/**
 * ContextPanel — The left pane of the Trinity Layout.
 *
 * Provides:
 *  - Project navigation (quick links to key areas)
 *  - Recent activity / artifact history
 *  - Active worker info
 *  - File/dataset references
 *  - Environment indicator
 */

import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  MessageSquare, ClipboardList, CheckSquare, Bot, Wrench, Layers, Shield,
  ChevronDown, ChevronRight, Clock, FileText, Database, Zap, FolderOpen,
  Activity, Settings, Search,
} from 'lucide-react';
import { useCanvas } from '../../contexts/CanvasContext';

// ── Nav items ────────────────────────────────────────────────────────────
const QUICK_NAV = [
  { to: '/workspace',           label: 'Chat',           icon: MessageSquare, end: true },
  { to: '/employees/tasks',     label: 'Task Board',     icon: ClipboardList },
  { to: '/employees/review',    label: 'Review Center',  icon: CheckSquare },
  { to: '/employees',           label: 'Workers',        icon: Bot },
  { to: '/employees/tools',     label: 'Tool Library',   icon: Wrench },
];

const ADVANCED_NAV = [
  { to: '/employees/templates', label: 'Templates',     icon: Layers },
  { to: '/employees/policies',  label: 'Governance',    icon: Shield },
  { to: '/employees/profiles',  label: 'Profiles',      icon: FileText },
  { to: '/settings',            label: 'Settings',      icon: Settings },
];

function NavItem({ to, label, icon: Icon, end }) {
  const iconNode = React.createElement(Icon, { size: 14 });
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          isActive
            ? 'bg-indigo-50 text-indigo-700'
            : 'hover:bg-gray-50'
        }`
      }
      style={({ isActive }) => ({ color: isActive ? undefined : 'var(--text-secondary)' })}
    >
      {iconNode}
      <span>{label}</span>
    </NavLink>
  );
}

/**
 * @param {object} props
 * @param {Array}  [props.recentArtifacts] - recent artifacts for history display
 * @param {object} [props.activeWorker] - current digital worker info
 * @param {object} [props.user] - authenticated user
 */
export default function ContextPanel({ recentArtifacts = [], activeWorker, user }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { openWidget } = useCanvas();

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--surface-base)' }}>
      {/* Logo / Title */}
      <div className="px-3 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Zap size={14} className="text-white" />
          </div>
          <div>
            <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>DI Workspace</p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Digital Worker Canvas</p>
          </div>
        </div>
      </div>

      {/* Active Worker Badge */}
      {activeWorker && (
        <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
          <div className="flex items-center gap-2 p-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
            <Bot size={14} className="text-indigo-500" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {activeWorker.name || 'Aiden'}
              </p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {activeWorker.role || 'Supply Planning Worker'}
              </p>
            </div>
            <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" title="Online" />
          </div>
        </div>
      )}

      {/* Quick Navigation */}
      <div className="px-2 py-2 space-y-0.5">
        {QUICK_NAV.map(item => <NavItem key={item.to} {...item} />)}
      </div>

      {/* Advanced toggle */}
      <div className="px-2">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-medium w-full rounded-lg hover:bg-gray-50"
          style={{ color: 'var(--text-muted)' }}
        >
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced
        </button>
        {showAdvanced && (
          <div className="space-y-0.5 mb-2">
            {ADVANCED_NAV.map(item => <NavItem key={item.to} {...item} />)}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="border-t mx-3 my-1" style={{ borderColor: 'var(--border-default)' }} />

      {/* Recent Artifacts */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider px-3 mb-2" style={{ color: 'var(--text-muted)' }}>
          <Clock size={10} className="inline mr-1" />
          Recent Artifacts
        </p>
        {recentArtifacts.length > 0 ? (
          <div className="space-y-0.5">
            {recentArtifacts.slice(0, 20).map((art, i) => (
              <button
                key={i}
                onClick={() => openWidget(art.type, art.data, { title: art.title })}
                className="flex items-center gap-2 w-full px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50 text-left transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Database size={12} style={{ color: 'var(--text-muted)' }} />
                <span className="truncate flex-1">{art.title || art.type}</span>
                <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {art.time || ''}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[10px] px-3" style={{ color: 'var(--text-muted)' }}>
            No artifacts yet. Start a conversation to generate results.
          </p>
        )}
      </div>

      {/* User footer */}
      <div className="px-3 py-2 border-t" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600">
            {(user?.email?.[0] || 'U').toUpperCase()}
          </div>
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
            {user?.email || 'User'}
          </span>
        </div>
      </div>
    </div>
  );
}
