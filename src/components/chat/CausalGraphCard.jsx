/**
 * CausalGraphCard.jsx
 *
 * Renders a 5-Whys causal chain in chat. Shows the DAG as a vertical
 * tree from Symptom → Proximate → Contributing → Root → Action.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────┐
 *   │  🔍 Root Cause Analysis                        │
 *   │  ──────────────────────────────────────────── │
 *   │  [L1] Symptom node (red)                       │
 *   │    └─ [L2] Proximate cause (orange)            │
 *   │        ├─ [L3] Contributing factor (yellow)    │
 *   │        │   └─ [L4] Root cause (purple)         │
 *   │        │       └─ [L5] Action (green button)   │
 *   │        └─ [L3] Another factor...               │
 *   └────────────────────────────────────────────────┘
 */

import React, { useState } from 'react';
import {
  Search,
  AlertTriangle,
  AlertOctagon,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Target,
  Layers,
  Zap,
} from 'lucide-react';
import { Card } from '../ui';

const LAYER_CONFIG = {
  symptom:      { icon: AlertOctagon, color: 'text-red-600 dark:text-red-400',     bg: 'bg-red-50 dark:bg-red-900/20',     border: 'border-red-200 dark:border-red-800' },
  proximate:    { icon: AlertTriangle, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-900/20', border: 'border-orange-200 dark:border-orange-800' },
  contributing: { icon: Layers,        color: 'text-amber-600 dark:text-amber-400',  bg: 'bg-amber-50 dark:bg-amber-900/20',  border: 'border-amber-200 dark:border-amber-800' },
  root:         { icon: Target,        color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-900/20', border: 'border-purple-200 dark:border-purple-800' },
  action:       { icon: Zap,           color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800' },
};

function CausalNode({ node, allNodes, depth = 0, onActionClick }) {
  const [expanded, setExpanded] = useState(depth < 3);
  const config = LAYER_CONFIG[node.layer] || LAYER_CONFIG.contributing;
  const Icon = config.icon;
  const children = (node.children || [])
    .map(childId => allNodes.find(n => n.id === childId))
    .filter(Boolean);

  const isAction = node.layer === 'action';

  return (
    <div className={`${depth > 0 ? 'ml-4 pl-3 border-l-2 border-slate-200 dark:border-slate-700' : ''}`}>
      <div
        className={`flex items-start gap-2 rounded-lg ${config.bg} ${config.border} border px-3 py-2 mb-1.5 ${isAction ? 'cursor-pointer hover:opacity-80' : ''}`}
        onClick={isAction && onActionClick ? () => onActionClick(node.title) : undefined}
      >
        <div className="shrink-0 mt-0.5">
          <Icon className={`w-3.5 h-3.5 ${config.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${config.color}`}>
              {node.layer_label || node.layer}
            </span>
            {node.metric_value != null && (
              <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                ({node.metric_value})
              </span>
            )}
          </div>
          <div className="text-xs font-medium text-slate-700 dark:text-slate-200 mt-0.5">
            {node.title}
          </div>
          {node.detail && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              {node.detail}
            </div>
          )}
          {node.entity && (
            <span className="inline-block mt-1 text-[10px] font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">
              {node.entity.type}: {node.entity.id}
            </span>
          )}
        </div>
        {children.length > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            className="shrink-0 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>

      {expanded && children.length > 0 && (
        <div className="mt-0.5">
          {children.map(child => (
            <CausalNode
              key={child.id}
              node={child}
              allNodes={allNodes}
              depth={depth + 1}
              onActionClick={onActionClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @param {Object} props
 * @param {Object} props.payload - Serialized causal graph { nodes, edges, roots }
 * @param {Function} [props.onActionClick] - Called with action title when action node clicked
 */
export default function CausalGraphCard({ payload, onActionClick }) {
  if (!payload || !payload.nodes || payload.nodes.length === 0) return null;

  const { nodes, roots } = payload;
  const rootNodes = (roots || [])
    .map(rootId => nodes.find(n => n.id === rootId))
    .filter(Boolean);

  const criticalCount = nodes.filter(n => n.severity === 'critical').length;
  const actionCount = nodes.filter(n => n.layer === 'action').length;

  return (
    <Card className="border border-purple-200 dark:border-purple-800 bg-gradient-to-br from-white to-purple-50/30 dark:from-slate-900 dark:to-purple-950/20">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30">
          <Search className="w-4 h-4 text-purple-600 dark:text-purple-400" />
        </div>
        <div>
          <span className="text-xs font-semibold text-purple-700 dark:text-purple-300 uppercase tracking-wider">
            Root Cause Analysis
          </span>
          <span className="ml-2 text-[10px] text-slate-500 dark:text-slate-400">
            {criticalCount > 0 ? `${criticalCount} critical` : ''} {actionCount > 0 ? `· ${actionCount} action(s)` : ''}
          </span>
        </div>
      </div>

      {/* Causal tree */}
      <div className="space-y-1">
        {rootNodes.map(root => (
          <CausalNode
            key={root.id}
            node={root}
            allNodes={nodes}
            depth={0}
            onActionClick={onActionClick}
          />
        ))}
      </div>
    </Card>
  );
}
