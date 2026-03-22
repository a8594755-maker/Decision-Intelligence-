/**
 * AnalysisBlueprintCard.jsx
 *
 * Interactive card displaying an AI-generated analysis blueprint.
 * Visual style: dark background, colored tile grid grouped by category,
 * with divider between basic and advanced sections.
 *
 * Props:
 * - blueprint: { title, subtitle, categories, modules, relationships }
 * - onRunModule: async (module) => result
 * - onRunAll: async (modules) => void
 */

import React, { useState, useEffect } from 'react';
import {
  Play, CheckCircle2, Loader2,
  ArrowRight, Database, Sparkles, AlertCircle,
} from 'lucide-react';

// ── Color mappings (Tailwind static classes — no dynamic interpolation) ──────

const TILE_STYLES = {
  amber:   { border: 'border-amber-600',   bg: 'bg-amber-950/60',   text: 'text-amber-300',   sub: 'text-amber-400/70',   dot: 'bg-amber-400' },
  teal:    { border: 'border-teal-600',     bg: 'bg-teal-950/60',    text: 'text-teal-300',    sub: 'text-teal-400/70',    dot: 'bg-teal-400' },
  purple:  { border: 'border-purple-600',   bg: 'bg-purple-950/60',  text: 'text-purple-300',  sub: 'text-purple-400/70',  dot: 'bg-purple-400' },
  indigo:  { border: 'border-indigo-600',   bg: 'bg-indigo-950/60',  text: 'text-indigo-300',  sub: 'text-indigo-400/70',  dot: 'bg-indigo-400' },
  rose:    { border: 'border-rose-600',     bg: 'bg-rose-950/60',    text: 'text-rose-300',    sub: 'text-rose-400/70',    dot: 'bg-rose-400' },
  cyan:    { border: 'border-cyan-600',     bg: 'bg-cyan-950/60',    text: 'text-cyan-300',    sub: 'text-cyan-400/70',    dot: 'bg-cyan-400' },
  emerald: { border: 'border-emerald-600',  bg: 'bg-emerald-950/60', text: 'text-emerald-300', sub: 'text-emerald-400/70', dot: 'bg-emerald-400' },
  green:   { border: 'border-green-700',    bg: 'bg-green-950/60',   text: 'text-green-300',   sub: 'text-green-400/70',   dot: 'bg-green-400' },
  blue:    { border: 'border-blue-600',     bg: 'bg-blue-950/60',    text: 'text-blue-300',    sub: 'text-blue-400/70',    dot: 'bg-blue-400' },
  gray:    { border: 'border-slate-600',    bg: 'bg-slate-800/60',   text: 'text-slate-300',   sub: 'text-slate-400/70',   dot: 'bg-slate-400' },
};

const getStyle = (color) => TILE_STYLES[color] || TILE_STYLES.gray;

export default function AnalysisBlueprintCard({ blueprint, onRunModule, onRunAll }) {
  const [modules, setModules] = useState([]);
  const [isRunningAll, setIsRunningAll] = useState(false);

  useEffect(() => {
    if (blueprint?.modules) {
      setModules(blueprint.modules.map(m => ({ ...m, status: m.status || 'pending' })));
    }
  }, [blueprint]);

  const updateModuleStatus = (id, status) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, status } : m));
  };

  const handleModuleClick = async (module) => {
    if (module.status === 'running' || module.status === 'done' || isRunningAll) return;
    updateModuleStatus(module.id, 'running');
    try {
      await onRunModule(module);
      updateModuleStatus(module.id, 'done');
    } catch (err) {
      console.error(`[Blueprint] Module ${module.id} failed:`, err);
      updateModuleStatus(module.id, 'error');
    }
  };

  const handleRunAll = async () => {
    if (isRunningAll) return;
    setIsRunningAll(true);
    const pending = modules.filter(m => m.status === 'pending' || m.status === 'error');
    // Execute in chunks of 3
    for (let i = 0; i < pending.length; i += 3) {
      const chunk = pending.slice(i, i + 3);
      await Promise.allSettled(chunk.map(m => handleModuleClick(m)));
    }
    setIsRunningAll(false);
  };

  if (!blueprint) return null;
  const { title, subtitle, categories = [], relationships = [] } = blueprint;

  // Group modules by category
  const groups = categories.map(cat => ({
    ...cat,
    items: modules.filter(m => m.category_id === cat.id),
  })).filter(g => g.items.length > 0);

  // Orphaned modules
  const orphaned = modules.filter(m => !categories.find(c => c.id === m.category_id));
  if (orphaned.length > 0) {
    groups.push({ id: 'other', label: 'Other', color: 'gray', items: orphaned });
  }

  // Split groups into basic (first half) and advanced (second half)
  const splitIdx = Math.ceil(groups.length / 2);
  const basicGroups = groups.slice(0, splitIdx);
  const advancedGroups = groups.slice(splitIdx);

  const doneCount = modules.filter(m => m.status === 'done').length;
  const progress = modules.length > 0 ? Math.round((doneCount / modules.length) * 100) : 0;

  return (
    <div className="w-full max-w-3xl rounded-2xl bg-gray-950 border border-gray-800 shadow-xl overflow-hidden">

      {/* ── Header ── */}
      <div className="px-6 pt-6 pb-4 text-center">
        <h2 className="text-xl font-bold text-gray-100 flex items-center justify-center gap-2">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 text-sm text-gray-400">{subtitle}</p>
        )}
      </div>

      {/* ── Action Bar ── */}
      <div className="px-6 pb-4 flex items-center gap-4">
        <button
          onClick={handleRunAll}
          disabled={isRunningAll || progress === 100}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            progress === 100
              ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800 cursor-default'
              : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg hover:shadow-indigo-500/25'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {isRunningAll ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing...</>
          ) : progress === 100 ? (
            <><CheckCircle2 className="w-4 h-4" /> All Complete</>
          ) : (
            <><Play className="w-4 h-4 fill-current" /> Run All</>
          )}
        </button>
        {/* Progress */}
        <div className="flex-1 flex items-center gap-2">
          <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-500 ease-out rounded-full"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 tabular-nums w-8 text-right">{progress}%</span>
        </div>
      </div>

      {/* ── Basic Groups (tile grid) ── */}
      <div className="px-6 pb-2 space-y-5">
        {basicGroups.map(group => (
          <CategorySection
            key={group.id}
            group={group}
            modules={group.items}
            onModuleClick={handleModuleClick}
            isRunningAll={isRunningAll}
          />
        ))}
      </div>

      {/* ── Divider ── */}
      {advancedGroups.length > 0 && (
        <div className="px-6 py-4 flex items-center gap-4">
          <div className="flex-1 border-t border-dashed border-gray-700" />
          <span className="text-xs text-gray-500 font-medium tracking-wider uppercase">
            {advancedGroups.length > 0 && advancedGroups[0].label?.includes('進階') ? '進階分析' : 'Advanced'}
          </span>
          <div className="flex-1 border-t border-dashed border-gray-700" />
        </div>
      )}

      {/* ── Advanced Groups ── */}
      {advancedGroups.length > 0 && (
        <div className="px-6 pb-4 space-y-5">
          {advancedGroups.map(group => (
            <CategorySection
              key={group.id}
              group={group}
              modules={group.items}
              onModuleClick={handleModuleClick}
              isRunningAll={isRunningAll}
              compact
            />
          ))}
        </div>
      )}

      {/* ── Data Relationships Footer ── */}
      {relationships.length > 0 && (
        <div className="px-6 py-4 bg-gray-900/50 border-t border-gray-800">
          <div className="rounded-lg border border-gray-800 bg-gray-900/80 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-3.5 h-3.5 text-gray-500" />
              <span className="text-xs font-semibold text-gray-400 tracking-wide">
                {relationships.some(r => /[\u4e00-\u9fff]/.test(r)) ? '可用資料表關聯' : 'Data Relationships'}
              </span>
            </div>
            <div className="space-y-1">
              {relationships.map((rel, i) => (
                <p key={i} className="text-xs text-gray-500 font-mono">{rel}</p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Category Section with 2-column tile grid ────────────────────────────────

function CategorySection({ group, modules, onModuleClick, isRunningAll, compact = false }) {
  const style = getStyle(group.color);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {modules.map(module => (
          <ModuleTile
            key={module.id}
            module={module}
            style={style}
            onClick={() => onModuleClick(module)}
            disabled={isRunningAll}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}

// ── Module Tile (colored block) ─────────────────────────────────────────────

function ModuleTile({ module, style, onClick, disabled, compact }) {
  const isDone = module.status === 'done';
  const isRunning = module.status === 'running';
  const isError = module.status === 'error';
  const isPending = module.status === 'pending';

  return (
    <button
      onClick={onClick}
      disabled={disabled || isDone}
      className={`
        group relative text-left w-full rounded-xl border-l-4 transition-all
        ${isDone ? 'border-emerald-600 bg-emerald-950/30 opacity-70' :
          isRunning ? `${style.border} ${style.bg} animate-pulse` :
          isError ? 'border-red-600 bg-red-950/30' :
          `${style.border} ${style.bg} hover:brightness-125 hover:scale-[1.02] cursor-pointer`}
        ${compact ? 'px-4 py-3' : 'px-5 py-4'}
      `}
    >
      {/* Status indicator */}
      <div className="absolute top-2 right-2">
        {isDone && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
        {isRunning && <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />}
        {isError && <AlertCircle className="w-4 h-4 text-red-400" />}
        {isPending && <ArrowRight className="w-3.5 h-3.5 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />}
      </div>

      {/* Number + Title */}
      <h4 className={`text-sm font-bold leading-snug ${isDone ? 'text-emerald-400/70' : style.text}`}>
        {module.number}. {module.title}
      </h4>
      <p className={`text-xs mt-0.5 leading-relaxed ${isDone ? 'text-emerald-500/50' : style.sub}`}>
        {module.subtitle}
      </p>
    </button>
  );
}
