// @product: ai-employee
//
// ToolRegistryPage.jsx — Tool Library management page.
// Lists custom tools + built-in DI engine tools, with search, filter, and management actions.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { listTools, deprecateTool, approveTool, registerTool } from '../services/toolRegistryService';
import { listBuiltinTools, TOOL_CATEGORY } from '../services/builtinToolCatalog';

const CUSTOM_CATEGORIES = [
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

const BUILTIN_CATEGORY_LABELS = {
  core_planning: 'Core Planning',
  risk: 'Risk',
  scenario: 'Scenario',
  negotiation: 'Negotiation',
  cost_revenue: 'Cost & Revenue',
  bom: 'BOM',
  utility: 'Utility',
  analytics: 'Analytics',
  governance: 'Governance',
  data_access: 'Data Access',
  monitoring: 'Monitoring',
};

const TIER_LABELS = {
  tier_a: { label: 'Tier A', color: '#10b981', desc: 'Fast / Deterministic' },
  tier_b: { label: 'Tier B', color: '#3b82f6', desc: 'Moderate' },
  tier_c: { label: 'Tier C', color: '#8b5cf6', desc: 'Heavy / LLM+Solver' },
};

const CATEGORY_COLORS = {
  core_planning: '#2563eb',
  risk: '#dc2626',
  scenario: '#d97706',
  negotiation: '#7c3aed',
  cost_revenue: '#059669',
  bom: '#0891b2',
  utility: '#64748b',
  analytics: '#6366f1',
  governance: '#be185d',
  data_access: '#0d9488',
  monitoring: '#ea580c',
};

// ── Create Tool Form ──

function CreateToolForm({ onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('custom');
  const [code, setCode] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (!code.trim()) { setError('Code is required'); return; }

    setSaving(true);
    setError('');
    try {
      await registerTool({
        name: name.trim(),
        description: description.trim(),
        category,
        code: code.trim(),
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        input_schema: {},
      });
      onCreated();
    } catch (err) {
      setError(err?.message || 'Failed to create tool');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      border: '2px solid #6366f1',
      borderRadius: 10,
      padding: 20,
      background: '#fafafe',
      marginBottom: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <strong style={{ fontSize: 15 }}>Create Custom Tool</strong>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#999' }}>
          &times;
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>Tool Name *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. demand_forecaster_v2"
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>Category</label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
            >
              {CUSTOM_CATEGORIES.filter(c => c.value).map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>Description</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does this tool do?"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>Tags (comma-separated)</label>
          <input
            type="text"
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="e.g. forecast, ml, demand"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>Code *</label>
          <textarea
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="// Tool implementation code..."
            rows={8}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              fontSize: 12,
              fontFamily: 'monospace',
              resize: 'vertical',
            }}
          />
        </div>

        {error && (
          <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '6px 16px', borderRadius: 6,
              border: '1px solid #d1d5db', background: '#fff',
              fontSize: 13, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: '6px 16px', borderRadius: 6,
              border: 'none', background: saving ? '#999' : '#6366f1',
              color: '#fff', fontSize: 13, cursor: saving ? 'default' : 'pointer',
            }}
          >
            {saving ? 'Creating...' : 'Create Tool'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ToolRegistryPage() {
  const [tab, setTab] = useState('builtin'); // 'builtin' | 'custom'
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // ── Custom tools loading ──
  const loadCustomTools = useCallback(async () => {
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
    if (tab === 'custom') loadCustomTools();
  }, [tab, loadCustomTools]);

  // ── Builtin tools ──
  const builtinTools = useMemo(() => listBuiltinTools(), []);

  const filteredBuiltinTools = useMemo(() => {
    let result = builtinTools;
    if (categoryFilter) result = result.filter(t => t.category === categoryFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.keywords_en.some(k => k.includes(q)) ||
        t.keywords_zh.some(k => k.includes(q))
      );
    }
    return result;
  }, [builtinTools, categoryFilter, search]);

  const filteredCustomTools = tools.filter(t => {
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
    loadCustomTools();
  };

  const handleApprove = async (toolId) => {
    await approveTool(toolId, 'manager', 0.8);
    loadCustomTools();
  };

  const statusColors = {
    draft: '#f59e0b',
    active: '#10b981',
    deprecated: '#9ca3af',
  };

  const tabStyle = (active) => ({
    padding: '8px 20px',
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    color: active ? '#2563eb' : '#666',
    borderBottom: active ? '2px solid #2563eb' : '2px solid transparent',
    background: 'none',
    border: 'none',
    borderBottomStyle: 'solid',
    borderBottomWidth: 2,
    borderBottomColor: active ? '#2563eb' : 'transparent',
    cursor: 'pointer',
  });

  // ── Built-in category options for filter ──
  const builtinCategoryOptions = useMemo(() => {
    const cats = [...new Set(builtinTools.map(t => t.category))].sort();
    return [
      { value: '', label: 'All Categories' },
      ...cats.map(c => ({ value: c, label: BUILTIN_CATEGORY_LABELS[c] || c })),
    ];
  }, [builtinTools]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: '#1a1a2e' }}>
        Tool Library
      </h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        {tab === 'builtin'
          ? `${filteredBuiltinTools.length} built-in DI engine tools available for AI agents`
          : `${filteredCustomTools.length} custom tools created from AI-generated code`}
      </p>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', marginBottom: 16 }}>
        <button style={tabStyle(tab === 'builtin')} onClick={() => { setTab('builtin'); setCategoryFilter(''); }}>
          Built-in Tools ({builtinTools.length})
        </button>
        <button style={tabStyle(tab === 'custom')} onClick={() => { setTab('custom'); setCategoryFilter(''); }}>
          Custom Tools
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder={tab === 'builtin' ? 'Search tools (EN/ZH)...' : 'Search tools...'}
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
          {(tab === 'builtin' ? builtinCategoryOptions : CUSTOM_CATEGORIES).map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        {tab === 'custom' && (
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
          >
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        )}
      </div>

      {/* ── Built-in Tools Tab ── */}
      {tab === 'builtin' && (
        <>
          {filteredBuiltinTools.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              No matching built-in tools found.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filteredBuiltinTools.map(tool => {
              const isExpanded = expandedId === tool.id;
              const tierInfo = TIER_LABELS[tool.tier] || {};
              const catColor = CATEGORY_COLORS[tool.category] || '#666';

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
                  {/* Header row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{tool.name}</strong>
                      <span style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 12,
                        background: `${catColor}14`,
                        color: catColor,
                        border: `1px solid ${catColor}40`,
                      }}>
                        {BUILTIN_CATEGORY_LABELS[tool.category] || tool.category}
                      </span>
                      <span style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 10,
                        background: `${tierInfo.color || '#999'}14`,
                        color: tierInfo.color || '#999',
                        border: `1px solid ${tierInfo.color || '#999'}40`,
                      }}>
                        {tierInfo.label || tool.tier}
                      </span>
                      {tool.module === '__python_api__' && (
                        <span style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 10,
                          background: '#fef3c7',
                          color: '#92400e',
                        }}>
                          Python API
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: '#999' }}>{tool.id}</span>
                  </div>

                  {/* Description */}
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    {tool.description}
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div style={{ marginTop: 12, borderTop: '1px solid #eee', paddingTop: 12, fontSize: 12 }}>
                      {/* Module & Method */}
                      <div style={{ display: 'flex', gap: 20, marginBottom: 8, color: '#444' }}>
                        <span><strong>Module:</strong> {tool.module}</span>
                        <span><strong>Method:</strong> {tool.method}</span>
                      </div>

                      {/* Dependencies */}
                      {tool.depends_on.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Depends on: </strong>
                          {tool.depends_on.map(dep => (
                            <span key={dep} style={{
                              fontSize: 11,
                              padding: '1px 6px',
                              borderRadius: 8,
                              background: '#dbeafe',
                              color: '#1e40af',
                              marginRight: 4,
                            }}>
                              {dep}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Output artifacts */}
                      {tool.output_artifacts.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Produces: </strong>
                          {tool.output_artifacts.map(a => (
                            <span key={a} style={{
                              fontSize: 11,
                              padding: '1px 6px',
                              borderRadius: 8,
                              background: '#dcfce7',
                              color: '#166534',
                              marginRight: 4,
                            }}>
                              {a}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Required datasets */}
                      {tool.required_datasets.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>Requires datasets: </strong>
                          {tool.required_datasets.join(', ')}
                        </div>
                      )}

                      {/* Keywords */}
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                        {[...tool.keywords_en, ...tool.keywords_zh].map(kw => (
                          <span key={kw} style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 8,
                            background: '#f3f4f6',
                            color: '#666',
                          }}>
                            {kw}
                          </span>
                        ))}
                      </div>

                      {/* Input schema */}
                      {tool.input_schema && Object.keys(tool.input_schema).length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <strong>Input Schema:</strong>
                          <pre style={{
                            background: '#1e1e2e',
                            color: '#cdd6f4',
                            padding: 10,
                            borderRadius: 6,
                            fontSize: 11,
                            overflow: 'auto',
                            maxHeight: 180,
                            marginTop: 4,
                          }}>
                            {JSON.stringify(tool.input_schema, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Custom Tools Tab ── */}
      {tab === 'custom' && (
        <>
          {/* Create button */}
          {!showCreateForm && (
            <div style={{ marginBottom: 16 }}>
              <button
                onClick={() => setShowCreateForm(true)}
                style={{
                  padding: '8px 16px', borderRadius: 6,
                  border: 'none', background: '#6366f1',
                  color: '#fff', fontSize: 13, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                + Create Custom Tool
              </button>
            </div>
          )}

          {/* Create form */}
          {showCreateForm && (
            <CreateToolForm
              onCreated={() => { setShowCreateForm(false); loadCustomTools(); }}
              onCancel={() => setShowCreateForm(false)}
            />
          )}

          {loading && <div style={{ color: '#666', fontSize: 14 }}>Loading tools...</div>}

          {!loading && filteredCustomTools.length === 0 && !showCreateForm && (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🔧</div>
              <div>No tools found. Click "Create Custom Tool" to add one, or tools are automatically created when AI-generated code passes human review.</div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filteredCustomTools.map(tool => {
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
        </>
      )}
    </div>
  );
}
