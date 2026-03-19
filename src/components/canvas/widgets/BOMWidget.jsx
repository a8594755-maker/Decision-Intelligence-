/**
 * BOMWidget — Dual-mode canvas widget for BOM data.
 *
 * mode="artifact" (default): Pure props from canvas events (no internal fetching)
 * mode="live": Uses useBOMData hook for standalone page rendering with
 *              Supabase queries, pagination, filtering, and tab switching.
 *
 * Supports: bom_explosion, component_plan_table, bottlenecks
 */

import React, { useMemo, useState, memo } from 'react';
import {
  Network, ChevronRight, ChevronLeft, AlertTriangle,
  Database, Search, Filter, X, RefreshCw, Cloud, Loader2
} from 'lucide-react';

function DepthIndicator({ depth }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="w-3 border-l-2 h-4 inline-block" style={{ borderColor: 'var(--border-default)' }} />
      ))}
    </span>
  );
}

// ── Artifact Mode (original pure-props display) ─────────────────────────────

function BOMWidgetArtifact({ data = {} }) {
  const tree = data.tree || data.bom_tree || data.edges || [];
  const bottlenecks = Array.isArray(data.bottlenecks) ? data.bottlenecks : [];
  const componentDemands = data.component_demands || [];

  const bottleneckSet = new Set(bottlenecks.map(b => b.material_code));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <Network size={18} className="text-purple-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>BOM Structure</h3>
        </div>
        {bottlenecks.length > 0 && (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-600">
            <AlertTriangle size={14} /> {bottlenecks.length} bottleneck{bottlenecks.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* KPIs */}
      <div className="flex gap-3 px-4 py-3 overflow-x-auto">
        <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Components</span>
          <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{tree.length}</span>
        </div>
        <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Max Depth</span>
          <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {tree.length ? Math.max(...tree.map(n => n.depth || n.level || 0)) : 0}
          </span>
        </div>
        {componentDemands.length > 0 && (
          <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Demand Items</span>
            <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{componentDemands.length}</span>
          </div>
        )}
      </div>

      {/* Tree / Table */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {tree.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium">Material</th>
                <th className="pb-2 font-medium">Parent</th>
                <th className="pb-2 font-medium text-right">Qty/Unit</th>
                <th className="pb-2 font-medium text-right">Depth</th>
                <th className="pb-2 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {tree.map((row, i) => (
                <tr
                  key={i}
                  className="border-t hover:bg-indigo-50/30"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <td className="py-1.5">
                    <div className="flex items-center gap-1">
                      <DepthIndicator depth={row.depth || row.level || 0} />
                      <span className={`font-medium ${bottleneckSet.has(row.material_code || row.child) ? 'text-amber-600' : ''}`}>
                        {row.material_code || row.child || '-'}
                      </span>
                    </div>
                  </td>
                  <td className="py-1.5">{row.parent || '-'}</td>
                  <td className="py-1.5 text-right font-mono">{row.qty_per ?? row.quantity ?? '-'}</td>
                  <td className="py-1.5 text-right">{row.depth ?? row.level ?? '-'}</td>
                  <td className="py-1.5 text-center">
                    {bottleneckSet.has(row.material_code || row.child) ? (
                      <span className="text-amber-600 text-xs">bottleneck</span>
                    ) : (
                      <span className="text-emerald-600 text-xs">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No BOM data available
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live Mode (Supabase-backed paginated browser) ───────────────────────────

function BOMWidgetLiveInner({ user, globalDataSource, initialTab }) {
  const [activeTab, setActiveTab] = useState(initialTab || 'bom_edges');
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(true);

  const ITEMS_PER_PAGE = 100;

  const loadData = React.useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);

    try {
      const { supabase } = await import('../../../services/supabaseClient');
      const offset = (currentPage - 1) * ITEMS_PER_PAGE;

      let query = supabase
        .from(activeTab)
        .select('*', { count: 'exact' })
        .eq('user_id', user.id);

      if (globalDataSource === 'sap') {
        query = query.eq('source', 'sap_sync');
      } else {
        query = query.or('source.is.null,source.neq.sap_sync');
      }

      query = query.order('created_at', { ascending: false })
        .range(offset, offset + ITEMS_PER_PAGE - 1);

      // Apply filters
      const filterFields = activeTab === 'bom_edges'
        ? ['source', 'batch_id', 'plant_id', 'parent_material', 'child_material']
        : ['batch_id', 'plant_id', 'material_code', 'time_bucket'];

      for (const key of filterFields) {
        const val = filters[key];
        if (!val) continue;
        if (key === 'source') {
          query = query.eq('source', val);
        } else {
          query = query.ilike(key, `%${val}%`);
        }
      }

      const { data: result, error: queryError, count } = await query;
      if (queryError) throw queryError;

      setData(result || []);
      setTotalCount(count || 0);
    } catch (err) {
      console.error('BOMWidget live: error loading:', err);
      setError(err?.message || String(err));
      setData([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [user?.id, activeTab, currentPage, filters, globalDataSource]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleTabSwitch = (tab) => {
    setActiveTab(tab);
    setFilters({});
    setCurrentPage(1);
  };

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
    setCurrentPage(1);
  };

  const clearFilters = () => {
    setFilters({});
    setCurrentPage(1);
  };

  const filterFields = activeTab === 'bom_edges'
    ? [
        { key: 'source', label: 'Source', placeholder: 'Filter source...' },
        { key: 'batch_id', label: 'Batch ID', placeholder: 'Search batch ID...' },
        { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant...' },
        { key: 'parent_material', label: 'Parent', placeholder: 'Search parent...' },
        { key: 'child_material', label: 'Child', placeholder: 'Search child...' },
      ]
    : [
        { key: 'batch_id', label: 'Batch ID', placeholder: 'Search batch ID...' },
        { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant...' },
        { key: 'material_code', label: 'Material', placeholder: 'Search material...' },
        { key: 'time_bucket', label: 'Time Bucket', placeholder: 'Search bucket...' },
      ];

  const displayColumns = useMemo(() => {
    if (data.length === 0) return [];
    const exclude = ['id', 'user_id', 'created_at', 'updated_at'];
    return Object.keys(data[0]).filter(k => !exclude.includes(k)).slice(0, 12);
  }, [data]);

  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalCount);
  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <Database size={18} className="text-blue-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>BOM Data</h3>
        </div>
        <div className="flex items-center gap-2">
          {globalDataSource && (
            <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded ${
              globalDataSource === 'sap' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
            }`}>
              {globalDataSource === 'sap' ? <Cloud size={12} /> : <Database size={12} />}
              {globalDataSource === 'sap' ? 'SAP' : 'Local'}
            </span>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b" style={{ borderColor: 'var(--border-default)' }}>
        {['bom_edges', 'demand_fg'].map(tab => (
          <button
            key={tab}
            onClick={() => handleTabSwitch(tab)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'bom_edges' ? 'BOM Edges' : 'Demand FG'}
            {activeTab === tab && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">{totalCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="px-4 py-2 border-b" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-raised)' }}>
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-1 text-xs font-medium hover:text-blue-600"
            style={{ color: 'var(--text-muted)' }}
          >
            <Filter size={12} />
            {showFilters ? 'Hide' : 'Show'} Filters
          </button>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs text-blue-600 hover:underline">
              Clear
            </button>
          )}
        </div>
        {showFilters && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {filterFields.map(f => (
              <div key={f.key}>
                <label className="block text-xs font-medium mb-0.5" style={{ color: 'var(--text-muted)' }}>{f.label}</label>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    placeholder={f.placeholder}
                    value={filters[f.key] || ''}
                    onChange={e => handleFilterChange(f.key, e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 text-xs rounded border outline-none focus:ring-1 focus:ring-blue-500"
                    style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Data Table */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            <span className="ml-2 text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-40 text-sm text-red-500">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            <Database size={32} className="mb-2 opacity-30" />
            {hasActiveFilters ? 'No results — adjust filters' : 'No data — upload data first'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium text-xs">#</th>
                {displayColumns.map(col => (
                  <th key={col} className="pb-2 font-medium text-xs">{col.replace(/_/g, ' ')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => (
                <tr key={row.id || idx} className="border-t hover:bg-indigo-50/20" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>{startItem + idx}</td>
                  {displayColumns.map(col => (
                    <td key={col} className="py-1.5 text-xs">
                      {typeof row[col] === 'object' && row[col] !== null
                        ? JSON.stringify(row[col]).substring(0, 50) + '...'
                        : typeof row[col] === 'number'
                        ? row[col].toLocaleString()
                        : String(row[col] ?? '-').substring(0, 50)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-4 py-2 border-t flex items-center justify-between" style={{ borderColor: 'var(--border-default)' }}>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {startItem}–{endItem} of {totalCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-1 rounded border disabled:opacity-30"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 text-xs font-medium">{currentPage}/{totalPages}</span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-1 rounded border disabled:opacity-30"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Export ──────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {'artifact'|'live'} [props.mode='artifact'] - Widget display mode
 * @param {object} [props.data] - Artifact payload (artifact mode)
 * @param {object} [props.user] - Auth user (live mode)
 * @param {string} [props.globalDataSource] - 'sap' | 'local' (live mode)
 * @param {string} [props.initialTab] - initial tab for live mode
 */
function BOMWidget({ mode = 'artifact', data = {}, user, globalDataSource, initialTab }) {
  if (mode === 'live') {
    return <BOMWidgetLiveInner user={user} globalDataSource={globalDataSource} initialTab={initialTab} />;
  }
  return <BOMWidgetArtifact data={data} />;
}

export default memo(BOMWidget);
