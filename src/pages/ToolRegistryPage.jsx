// @product: ai-employee
//
// ToolRegistryPage.jsx — Tool Library management page.
// Lists all registered tools, with search, filter, and management actions.

import React, { useState, useEffect, useCallback } from 'react';
import { listTools, deprecateTool, approveTool } from '../services/toolRegistryService';

const CATEGORIES = [
  { value: '', label: 'All Categories' },
  { value: 'solver', label: 'Solver' },
  { value: 'ml_model', label: 'ML Model' },
  { value: 'transform', label: 'Transform' },
  { value: 'report', label: 'Report' },
  { value: 'analysis', label: 'Analysis' },
  { value: 'custom', label: 'Custom' },
];

const STATUSES = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'deprecated', label: 'Deprecated' },
];

export default function ToolRegistryPage() {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const loadTools = useCallback(async () => {
    setLoading(true);
    try {
      const filter = {};
      if (categoryFilter) filter.category = categoryFilter;
      if (statusFilter) filter.status = statusFilter;
      const result = await listTools(filter);
      setTools(result);
    } catch (err) {
      console.error('[ToolRegistryPage] Failed to load tools:', err);
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, statusFilter]);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const filteredTools = tools.filter(t => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (t.name || '').toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q) ||
      (t.tags || []).some(tag => tag.toLowerCase().includes(q))
    );
  });

  const handleDeprecate = async (toolId) => {
    if (!confirm('Deprecate this tool? It will no longer be used for new tasks.')) return;
    await deprecateTool(toolId);
    loadTools();
  };

  const handleApprove = async (toolId) => {
    await approveTool(toolId, 'manager', 0.8);
    loadTools();
  };

  const statusColors = {
    draft: '#f59e0b',
    active: '#10b981',
    deprecated: '#9ca3af',
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16, color: '#1a1a2e' }}>
        Tool Library
      </h1>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search tools..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: '1 1 200px',
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #d1d5db',
            fontSize: 13,
          }}
        />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      {/* Loading */}
      {loading && <div style={{ color: '#666', fontSize: 14 }}>Loading tools...</div>}

      {/* Empty state */}
      {!loading && filteredTools.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔧</div>
          <div>No tools found. Tools are created when AI-generated code passes human review.</div>
        </div>
      )}

      {/* Tool list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filteredTools.map(tool => {
          const isExpanded = expandedId === tool.id;

          return (
            <div
              key={tool.id}
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: 14,
                background: '#fff',
                cursor: 'pointer',
              }}
              onClick={() => setExpandedId(isExpanded ? null : tool.id)}
            >
              {/* Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <strong style={{ fontSize: 14 }}>{tool.name}</strong>
                  <span style={{
                    fontSize: 11,
                    padding: '1px 8px',
                    borderRadius: 12,
                    background: '#ede9fe',
                    color: '#6d28d9',
                  }}>
                    {tool.category}
                  </span>
                  <span style={{
                    fontSize: 11,
                    padding: '1px 8px',
                    borderRadius: 12,
                    color: statusColors[tool.status] || '#999',
                    border: `1px solid ${statusColors[tool.status] || '#999'}`,
                  }}>
                    {tool.status}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#666' }}>
                  <span>Quality: {((tool.quality_score || 0) * 100).toFixed(0)}%</span>
                  <span>Uses: {tool.usage_count || 0}</span>
                </div>
              </div>

              {/* Description */}
              {tool.description && (
                <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  {tool.description}
                </div>
              )}

              {/* Tags */}
              {tool.tags?.length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  {tool.tags.map(tag => (
                    <span key={tag} style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 8,
                      background: '#f3f4f6',
                      color: '#666',
                    }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Expanded view */}
              {isExpanded && (
                <div style={{ marginTop: 12, borderTop: '1px solid #eee', paddingTop: 12 }}>
                  {tool.code && (
                    <pre style={{
                      background: '#1e1e2e',
                      color: '#cdd6f4',
                      padding: 12,
                      borderRadius: 6,
                      fontSize: 11,
                      overflow: 'auto',
                      maxHeight: 250,
                      margin: '0 0 10px',
                    }}>
                      {tool.code}
                    </pre>
                  )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    {tool.status === 'draft' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleApprove(tool.id); }}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 6,
                          border: 'none',
                          background: '#10b981',
                          color: '#fff',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        Approve
                      </button>
                    )}
                    {tool.status !== 'deprecated' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeprecate(tool.id); }}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 6,
                          border: '1px solid #ef4444',
                          background: '#fff',
                          color: '#ef4444',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        Deprecate
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
