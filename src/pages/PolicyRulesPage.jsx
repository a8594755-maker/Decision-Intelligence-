// @product: ai-employee
/**
 * PolicyRulesPage — No-code governance rule configuration UI.
 *
 * Features:
 *   - List active and inactive rules
 *   - Create rules from templates or from scratch
 *   - Edit rule conditions and actions
 *   - Toggle rules on/off
 *   - Delete custom rules
 *   - Preview which rules would trigger for a test context
 */
import { useState, useEffect, useCallback } from 'react';
import { Shield, Plus, Edit3, Trash2, ToggleLeft, ToggleRight, AlertTriangle, Check, X, Zap, Save } from 'lucide-react';
import { Card, Modal } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import {
  listRules, createRule, updateRule, deleteRule,
  RULE_TYPES, RULE_TEMPLATES,
} from '../services/governance/policyRuleService.js';
import { CAPABILITY_CLASS } from '../services/ai-infra/capabilityModelService.js';

const RULE_TYPE_LABELS = {
  [RULE_TYPES.APPROVAL_THRESHOLD]: 'Approval Threshold',
  [RULE_TYPES.AUTONOMY_GATE]:      'Autonomy Gate',
  [RULE_TYPES.REVIEW_REQUIRED]:    'Review Required',
  [RULE_TYPES.RATE_LIMIT]:         'Rate Limit',
  [RULE_TYPES.DATA_ACCESS]:        'Data Access',
  [RULE_TYPES.TIME_WINDOW]:        'Time Window',
};

const RULE_TYPE_COLORS = {
  [RULE_TYPES.APPROVAL_THRESHOLD]: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20',
  [RULE_TYPES.AUTONOMY_GATE]:      'text-purple-600 bg-purple-50 dark:bg-purple-900/20',
  [RULE_TYPES.REVIEW_REQUIRED]:    'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  [RULE_TYPES.RATE_LIMIT]:         'text-red-600 bg-red-50 dark:bg-red-900/20',
  [RULE_TYPES.DATA_ACCESS]:        'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
  [RULE_TYPES.TIME_WINDOW]:        'text-[var(--text-secondary)] bg-[var(--surface-subtle)]',
};

// ── Rule Card ────────────────────────────────────────────────────────────────

function RuleCard({ rule, onEdit, onToggle, onDelete }) {
  const typeLabel = RULE_TYPE_LABELS[rule.rule_type] || rule.rule_type;
  const typeColor = RULE_TYPE_COLORS[rule.rule_type] || 'text-slate-600 bg-slate-100';
  const isDefault = rule._source === 'default';

  return (
    <Card variant="elevated" className={`p-4 flex flex-col gap-2.5 ${!rule.is_active ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{rule.name}</span>
            <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${typeColor}`}>{typeLabel}</span>
            {rule.capability_class && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--accent-active)] text-[var(--brand-600)] font-medium">
                {rule.capability_class}
              </span>
            )}
            {isDefault && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--surface-subtle)] font-medium" style={{ color: 'var(--text-muted)' }}>Default</span>
            )}
          </div>
          {rule.description && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{rule.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-3">
          <button onClick={() => onToggle(rule)} className="p-1.5 rounded-lg hover:bg-[var(--surface-subtle)] transition-colors">
            {rule.is_active
              ? <ToggleRight className="w-4 h-4 text-emerald-600" />
              : <ToggleLeft className="w-4 h-4 text-slate-400" />
            }
          </button>
          <button onClick={() => onEdit(rule)} className="p-1.5 rounded-lg hover:bg-[var(--surface-subtle)] transition-colors">
            <Edit3 className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          </button>
          {!isDefault && (
            <button onClick={() => onDelete(rule.id)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              <Trash2 className="w-3.5 h-3.5 text-red-500" />
            </button>
          )}
        </div>
      </div>

      {/* Conditions & Actions summary */}
      <div className="flex gap-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <span><strong>Conditions:</strong> {summarizeConditions(rule)}</span>
        <span><strong>Action:</strong> {summarizeActions(rule)}</span>
      </div>

      {/* Priority */}
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Priority: {rule.priority}
      </div>
    </Card>
  );
}

function summarizeConditions(rule) {
  const cond = rule.conditions || {};
  const parts = [];
  if (cond.action_type) parts.push(`action=${cond.action_type}`);
  if (cond.cost_delta_gt != null) parts.push(`cost > $${cond.cost_delta_gt.toLocaleString()}`);
  if (cond.quantity_gt != null) parts.push(`qty > ${cond.quantity_gt}`);
  if (cond.min_autonomy) parts.push(`autonomy < ${cond.min_autonomy}`);
  if (cond.autonomy_below) parts.push(`autonomy < ${cond.autonomy_below}`);
  if (cond.allowed_hours) parts.push(`hours: ${cond.allowed_hours[0]}:00-${cond.allowed_hours[1]}:00`);
  if (cond.allowed_days) parts.push(`days: ${cond.allowed_days.join(',')}`);
  return parts.length > 0 ? parts.join(', ') : 'Always';
}

function summarizeActions(rule) {
  const act = rule.actions || {};
  const parts = [];
  if (act.require_approval) parts.push('Require approval');
  if (act.require_review) parts.push('Require review');
  if (act.block) parts.push('Block');
  return parts.length > 0 ? parts.join(', ') : 'None';
}

// ── Rule Form ────────────────────────────────────────────────────────────────

function RuleForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    description: initial?.description || '',
    rule_type: initial?.rule_type || RULE_TYPES.APPROVAL_THRESHOLD,
    capability_class: initial?.capability_class || '',
    priority: initial?.priority || 50,
    conditions: initial?.conditions || {},
    actions: initial?.actions || {},
  });

  const updateCondition = (key, value) =>
    setForm(prev => ({ ...prev, conditions: { ...prev.conditions, [key]: value } }));
  const updateAction = (key, value) =>
    setForm(prev => ({ ...prev, actions: { ...prev.actions, [key]: value } }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Name</label>
          <input
            type="text" value={form.name}
            onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Rule Type</label>
          <select
            value={form.rule_type}
            onChange={e => setForm(prev => ({ ...prev, rule_type: e.target.value, conditions: {}, actions: {} }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          >
            {Object.entries(RULE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Description</label>
        <input
          type="text" value={form.description}
          onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Capability Class (optional)</label>
          <select
            value={form.capability_class}
            onChange={e => setForm(prev => ({ ...prev, capability_class: e.target.value || null }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          >
            <option value="">All classes</option>
            {Object.values(CAPABILITY_CLASS).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Priority (lower = higher)</label>
          <input
            type="number" value={form.priority} min={1} max={100}
            onChange={e => setForm(prev => ({ ...prev, priority: parseInt(e.target.value, 10) || 50 }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      {/* Dynamic conditions based on rule type */}
      <div className="border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
        <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Conditions</p>
        {form.rule_type === RULE_TYPES.APPROVAL_THRESHOLD && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Action Type</label>
              <select value={form.conditions.action_type || ''} onChange={e => updateCondition('action_type', e.target.value || undefined)}
                className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
                <option value="">Any</option>
                <option value="writeback">Writeback</option>
                <option value="export">Export</option>
                <option value="notify">Notify</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Cost Delta &gt;</label>
              <input type="number" value={form.conditions.cost_delta_gt || ''} onChange={e => updateCondition('cost_delta_gt', parseInt(e.target.value, 10) || undefined)}
                className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }} placeholder="e.g. 10000" />
            </div>
          </div>
        )}
        {form.rule_type === RULE_TYPES.AUTONOMY_GATE && (
          <div>
            <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Minimum Autonomy</label>
            <select value={form.conditions.min_autonomy || 'A2'} onChange={e => updateCondition('min_autonomy', e.target.value)}
              className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
              {['A1', 'A2', 'A3', 'A4'].map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        )}
        {form.rule_type === RULE_TYPES.REVIEW_REQUIRED && (
          <div>
            <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Require review below autonomy</label>
            <select value={form.conditions.autonomy_below || 'A3'} onChange={e => updateCondition('autonomy_below', e.target.value)}
              className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
              {['A2', 'A3', 'A4'].map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        )}
        {form.rule_type === RULE_TYPES.TIME_WINDOW && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Start Hour</label>
              <input type="number" min={0} max={23} value={form.conditions.allowed_hours?.[0] ?? 8}
                onChange={e => updateCondition('allowed_hours', [parseInt(e.target.value, 10), form.conditions.allowed_hours?.[1] ?? 18])}
                className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }} />
            </div>
            <div>
              <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>End Hour</label>
              <input type="number" min={0} max={23} value={form.conditions.allowed_hours?.[1] ?? 18}
                onChange={e => updateCondition('allowed_hours', [form.conditions.allowed_hours?.[0] ?? 8, parseInt(e.target.value, 10)])}
                className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }} />
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
        <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Actions</p>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={!!form.actions.require_approval} onChange={e => updateAction('require_approval', e.target.checked)} />
            <span style={{ color: 'var(--text-secondary)' }}>Require Approval</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={!!form.actions.require_review} onChange={e => updateAction('require_review', e.target.checked)} />
            <span style={{ color: 'var(--text-secondary)' }}>Require Review</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={!!form.actions.block} onChange={e => updateAction('block', e.target.checked)} />
            <span style={{ color: 'var(--text-secondary)' }}>Block Action</span>
          </label>
        </div>
        <div className="mt-2">
          <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Reason message</label>
          <input type="text" value={form.actions.reason || ''} onChange={e => updateAction('reason', e.target.value)}
            className="w-full px-2 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
            placeholder="e.g. Cost threshold exceeded" />
        </div>
      </div>

      {/* Save/Cancel */}
      <div className="flex gap-2 pt-2">
        <button onClick={() => onSave(form)} disabled={saving || !form.name}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--brand-600)] text-white hover:bg-[var(--brand-700)] disabled:opacity-50 transition-colors">
          <Save className="w-3.5 h-3.5" />{saving ? 'Saving...' : 'Save Rule'}
        </button>
        <button onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
          <X className="w-3.5 h-3.5" />Cancel
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PolicyRulesPage() {
  const { user } = useAuth();
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // rule | 'new' | template
  const [saving, setSaving] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listRules({ activeOnly: false });
      setRules(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  const handleSave = async (form) => {
    setSaving(true);
    try {
      if (editing && editing !== 'new' && editing.id && editing._source !== 'default') {
        await updateRule(editing.id, form);
      } else {
        await createRule({
          ...form,
          capabilityClass: form.capability_class || null,
          ruleType: form.rule_type,
          createdBy: user?.id,
        });
      }
      setEditing(null);
      await loadRules();
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule) => {
    if (rule._source === 'default') return; // can't toggle defaults
    await updateRule(rule.id, { is_active: !rule.is_active });
    await loadRules();
  };

  const handleDelete = async (ruleId) => {
    if (!confirm('Delete this rule?')) return;
    await deleteRule(ruleId);
    await loadRules();
  };

  const handleUseTemplate = (tpl) => {
    setEditing({
      ...tpl,
      name: tpl.name,
      description: tpl.description,
      _isNew: true,
    });
    setShowTemplates(false);
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* Header */}
      <div
        className="h-14 flex items-center justify-between px-6 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2.5">
          <Shield className="w-5 h-5 text-[var(--brand-600)]" />
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Governance Rules</span>
          {rules.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--accent-active)] text-[var(--brand-600)]">
              {rules.filter(r => r.is_active).length} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTemplates(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
          >
            <Zap className="w-3.5 h-3.5" />
            Templates
          </button>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--brand-600)] text-white hover:bg-[var(--brand-700)] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Rule
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-[var(--brand-600)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="max-w-3xl space-y-3">
            {editing && (
              <Card variant="elevated" className="p-5">
                <p className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                  {editing === 'new' || editing._isNew ? 'Create Rule' : `Edit: ${editing.name}`}
                </p>
                <RuleForm
                  initial={editing === 'new' ? null : editing}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                  saving={saving}
                />
              </Card>
            )}

            {rules.map(r => (
              <RuleCard key={r.id} rule={r} onEdit={setEditing} onToggle={handleToggle} onDelete={handleDelete} />
            ))}

            {rules.length === 0 && !editing && (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <Shield className="w-10 h-10 text-[var(--brand-500)]" />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No governance rules configured.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Templates Modal */}
      {showTemplates && (
        <Modal isOpen onClose={() => setShowTemplates(false)} title="Rule Templates">
          <div className="p-4 space-y-3">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Quick-create a rule from a template.</p>
            {RULE_TEMPLATES.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => handleUseTemplate(tpl)}
                className="w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors hover:bg-[var(--surface-subtle)]"
                style={{ borderColor: 'var(--border-default)' }}
              >
                <Zap className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{tpl.name}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{tpl.description}</p>
                </div>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
