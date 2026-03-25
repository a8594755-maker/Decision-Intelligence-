/**
 * ChartCatalogPanel.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * A panel showing all 50 predefined chart recipes as clickable cards.
 * Each card shows: chart type icon, name, description, and dimension tags.
 * Grouped by category with filter tabs and search.
 *
 * Props:
 *   onSelect(recipe)  — called when user clicks a chart card
 *   onClose()         — called to dismiss the panel
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useMemo } from 'react';
import {
  X, Search,
  TrendingUp, BarChart3, PieChart, ScatterChart, Globe, Clock, Brain,
} from 'lucide-react';
import { getRecipeCatalogForUI, RECIPE_CATEGORIES } from '../../services/charts/chartRecipeCatalog.js';

// ── Category Icon Map ──────────────────────────────────────────────────────

const CATEGORY_ICONS = {
  TrendingUp, BarChart3, PieChart, ScatterChart, Globe, Clock, Brain,
};

// ── Chart Type Mini Icons (SVG thumbnails) ────────────────────────────────

const CHART_TYPE_COLORS = {
  line: '#3b82f6',
  area: '#3b82f6',
  bar: '#10b981',
  horizontal_bar: '#10b981',
  stacked_bar: '#10b981',
  grouped_bar: '#10b981',
  histogram: '#8b5cf6',
  pie: '#f59e0b',
  donut: '#f59e0b',
  scatter: '#ec4899',
  bubble: '#ec4899',
  heatmap: '#ef4444',
  treemap: '#06b6d4',
  radar: '#84cc16',
  funnel: '#f59e0b',
  sankey: '#8b5cf6',
  waterfall: '#10b981',
  pareto: '#ef4444',
  lorenz: '#8b5cf6',
};

// ── Main Component ──────────────────────────────────────────────────────────

export default function ChartCatalogPanel({ onSelect, onClose }) {
  const [activeCategory, setActiveCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const recipes = useMemo(() => getRecipeCatalogForUI(), []);

  const filtered = useMemo(() => {
    let result = recipes;
    if (activeCategory !== 'all') {
      result = result.filter(r => r.category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.name_zh.includes(q) ||
        r.description.toLowerCase().includes(q) ||
        (r.tags || []).some(t => t.includes(q))
      );
    }
    return result;
  }, [recipes, activeCategory, searchQuery]);

  return (
    <div className="bg-white dark:bg-gray-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-[70vh] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Chart Catalog</h3>
          <p className="text-[10px] text-slate-400">{recipes.length} charts available — click to generate</p>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search charts..."
            className="w-full pl-7 pr-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
      </div>

      {/* Category Tabs */}
      <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 overflow-x-auto">
        <div className="flex gap-1.5 min-w-max">
          <CategoryTab
            active={activeCategory === 'all'}
            onClick={() => setActiveCategory('all')}
            label="All"
            count={recipes.length}
          />
          {RECIPE_CATEGORIES.map(cat => {
            const count = recipes.filter(r => r.category === cat.id).length;
            return (
              <CategoryTab
                key={cat.id}
                active={activeCategory === cat.id}
                onClick={() => setActiveCategory(cat.id)}
                label={cat.name_zh}
                count={count}
                Icon={CATEGORY_ICONS[cat.icon]}
              />
            );
          })}
        </div>
      </div>

      {/* Card Grid */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 ? (
          <div className="text-xs text-slate-400 text-center py-8">No charts match your search</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {filtered.map((recipe, idx) => (
              <ChartCard
                key={recipe.id}
                recipe={recipe}
                index={idx}
                onClick={() => onSelect(recipe)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function CategoryTab({ active, onClick, label, count, Icon }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors whitespace-nowrap ${
        active
          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
      }`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
      <span className="text-[9px] opacity-60">({count})</span>
    </button>
  );
}

function ChartCard({ recipe, index, onClick }) {
  const color = CHART_TYPE_COLORS[recipe.chartType] || '#64748b';

  return (
    <button
      onClick={onClick}
      className="group text-left p-2.5 rounded-lg border border-slate-150 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all bg-white dark:bg-gray-800/40 hover:bg-blue-50/50 dark:hover:bg-blue-950/20"
    >
      {/* Number badge + chart type indicator */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[9px] font-mono text-slate-400">#{index + 1}</span>
        <span
          className="px-1.5 py-0.5 rounded text-[8px] font-medium text-white"
          style={{ backgroundColor: color }}
        >
          {recipe.chartType}
        </span>
      </div>

      {/* Name */}
      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-tight mb-0.5">
        {recipe.name_zh}
      </div>
      <div className="text-[9px] text-slate-400 leading-tight mb-1.5 line-clamp-1">
        {recipe.name}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-0.5">
        {(recipe.tags || []).slice(0, 3).map(tag => (
          <span
            key={tag}
            className="px-1 py-0 text-[8px] rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* v2 badge for geo/extended charts */}
      {recipe.requiresExtendedRenderer && (
        <div className="mt-1 text-[8px] text-amber-500 font-medium">table fallback (map in v2)</div>
      )}
    </button>
  );
}
