// @product: ai-employee
/**
 * WorkerTemplatesPage — CRUD management for worker templates.
 *
 * Features:
 *   - List all templates (DB + hardcoded)
 *   - Create new custom templates
 *   - Edit template name, description, capabilities, autonomy levels
 *   - Toggle template active/inactive
 *   - View capability coverage per template
 */
import { useState, useEffect, useCallback } from 'react';
import { Bot, Plus, Edit3, Trash2, Shield, Check, X, ChevronRight, Save, RotateCcw } from 'lucide-react';
import { Card, Modal } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { listTemplatesFromDB } from '../services/aiEmployee/persistence/employeeRepo.js';
import { CAPABILITY_CLASS } from '../services/ai-infra/capabilityModelService.js';
import { supabase } from '../services/infra/supabaseClient';

const ALL_CAPABILITIES = Object.values(CAPABILITY_CLASS);

const AUTONOMY_LEVELS = ['A1', 'A2', 'A3', 'A4'];

// ── Template Form ────────────────────────────────────────────────────────────

function TemplateForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    id: initial?.id || '',
    name: initial?.name || '',
    description: initial?.description || '',
    allowed_capabilities: initial?.allowed_capabilities || initial?.capabilities || [],
    default_autonomy: initial?.default_autonomy || 'A1',
    max_autonomy: initial?.max_autonomy || 'A4',
  });

  const isNew = !initial?.id;

  const toggleCapability = (cap) => {
    setForm(prev => ({
      ...prev,
      allowed_capabilities: prev.allowed_capabilities.includes(cap)
        ? prev.allowed_capabilities.filter(c => c !== cap)
        : [...prev.allowed_capabilities, cap],
    }));
  };

  return (
    <div className="space-y-4">
      {/* ID (only for new templates) */}
      {isNew && (
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
            Template ID (lowercase, no spaces)
          </label>
          <input
            type="text"
            value={form.id}
            onChange={e => setForm(prev => ({ ...prev, id: e.target.value.replace(/[^a-z0-9_]/g, '') }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
            placeholder="e.g. logistics_coordinator"
          />
        </div>
      )}

      {/* Name */}
      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Name</label>
        <input
          type="text"
          value={form.name}
          onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          placeholder="e.g. Logistics Coordinator"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Description</label>
        <textarea
          value={form.description}
          onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          rows={2}
          placeholder="What does this worker type do?"
        />
      </div>

      {/* Capabilities */}
      <div>
        <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Allowed Capabilities</label>
        <div className="flex flex-wrap gap-2">
          {ALL_CAPABILITIES.map(cap => (
            <button
              key={cap}
              onClick={() => toggleCapability(cap)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                form.allowed_capabilities.includes(cap)
                  ? 'bg-[var(--brand-600)] text-white'
                  : 'border hover:bg-[var(--surface-subtle)]'
              }`}
              style={!form.allowed_capabilities.includes(cap) ? { borderColor: 'var(--border-default)', color: 'var(--text-secondary)' } : {}}
            >
              {cap}
            </button>
          ))}
        </div>
      </div>

      {/* Autonomy levels */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Default Autonomy</label>
          <select
            value={form.default_autonomy}
            onChange={e => setForm(prev => ({ ...prev, default_autonomy: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          >
            {AUTONOMY_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Max Autonomy</label>
          <select
            value={form.max_autonomy}
            onChange={e => setForm(prev => ({ ...prev, max_autonomy: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          >
            {AUTONOMY_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.name || (isNew && !form.id)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--brand-600)] text-white hover:bg-[var(--brand-700)] disabled:opacity-50 transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Template Card ────────────────────────────────────────────────────────────

function TemplateCard({ template, onEdit, onDelete }) {
  const caps = template.allowed_capabilities || template.capabilities || [];
  const isDB = template._source === 'db';

  return (
    <Card variant="elevated" className="p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[var(--accent-active)] flex items-center justify-center">
            <Bot className="w-4.5 h-4.5 text-[var(--brand-600)]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{template.name}</span>
              {isDB && (
                <span className="px-1.5 py-0.5 text-[9px] rounded bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 font-medium">DB</span>
              )}
              {!isDB && (
                <span className="px-1.5 py-0.5 text-[9px] rounded bg-[var(--surface-subtle)] font-medium" style={{ color: 'var(--text-muted)' }}>Built-in</span>
              )}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{template.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onEdit(template)} className="p-1.5 rounded-lg hover:bg-[var(--surface-subtle)] transition-colors">
            <Edit3 className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          </button>
          {isDB && (
            <button onClick={() => onDelete(template.id)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              <Trash2 className="w-3.5 h-3.5 text-red-500" />
            </button>
          )}
        </div>
      </div>

      {template.description && (
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{template.description}</p>
      )}

      {/* Capabilities */}
      <div className="flex flex-wrap gap-1.5">
        {caps.map(cap => (
          <span key={cap} className="px-2 py-0.5 text-[10px] rounded-full bg-[var(--accent-active)] text-[var(--brand-600)] font-medium">
            {cap}
          </span>
        ))}
      </div>

      {/* Autonomy range */}
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Shield className="w-3.5 h-3.5" />
        <span>Autonomy: {template.default_autonomy || 'A1'} → {template.max_autonomy || 'A4'}</span>
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WorkerTemplatesPage() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // template or 'new'
  const [saving, setSaving] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTemplatesFromDB();
      setTemplates(data);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleSave = async (form) => {
    setSaving(true);
    try {
      if (editing === 'new') {
        // Create new template in DB
        await supabase.from('worker_templates').insert({
          id: form.id,
          name: form.name,
          description: form.description,
          allowed_capabilities: form.allowed_capabilities,
          default_autonomy: form.default_autonomy,
          max_autonomy: form.max_autonomy,
          is_active: true,
          created_by: user?.id,
        });
      } else {
        // Update existing
        await supabase.from('worker_templates').upsert({
          id: form.id || editing.id,
          name: form.name,
          description: form.description,
          allowed_capabilities: form.allowed_capabilities,
          default_autonomy: form.default_autonomy,
          max_autonomy: form.max_autonomy,
          is_active: true,
        });
      }
      setEditing(null);
      await loadTemplates();
    } catch (err) {
      console.error('[WorkerTemplatesPage] Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (templateId) => {
    if (!confirm(`Delete template "${templateId}"?`)) return;
    try {
      await supabase.from('worker_templates').update({ is_active: false }).eq('id', templateId);
      await loadTemplates();
    } catch (err) {
      console.error('[WorkerTemplatesPage] Delete failed:', err);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* Header */}
      <div
        className="h-14 flex items-center justify-between px-6 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2.5">
          <Bot className="w-5 h-5 text-[var(--brand-600)]" />
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Worker Templates</span>
          {templates.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--accent-active)] text-[var(--brand-600)]">
              {templates.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--brand-600)] text-white hover:bg-[var(--brand-700)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New Template
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-[var(--brand-600)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="max-w-3xl space-y-4">
            {editing && (
              <Card variant="elevated" className="p-5">
                <p className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                  {editing === 'new' ? 'Create New Template' : `Edit: ${editing.name}`}
                </p>
                <TemplateForm
                  initial={editing === 'new' ? null : editing}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                  saving={saving}
                />
              </Card>
            )}

            {templates.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                onEdit={setEditing}
                onDelete={handleDelete}
              />
            ))}

            {templates.length === 0 && !editing && (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <Bot className="w-10 h-10 text-[var(--brand-500)]" />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No templates found.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
