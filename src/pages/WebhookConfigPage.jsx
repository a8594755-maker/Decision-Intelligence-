// @product: ai-employee
/**
 * WebhookConfigPage — Manage webhook endpoints for external system integration.
 *
 * Features:
 *   - Register new webhooks (SAP, Oracle, Generic)
 *   - View webhook URL, API key, and stats
 *   - Test webhook with sample payload
 *   - Enable/disable webhooks
 *   - Configure field mapping for generic webhooks
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Webhook, Plus, Copy, Trash2, ToggleLeft, ToggleRight,
  CheckCircle2, AlertTriangle, ExternalLink, Shield, Activity,
} from 'lucide-react';
import { Card, Modal } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import {
  registerWebhook, listWebhooks, updateWebhook, deleteWebhook,
  processWebhook, WEBHOOK_SOURCES,
} from '../services/webhookIntakeService.js';
import { listEmployeesByManager } from '../services/aiEmployee/queries.js';

const SOURCE_LABELS = {
  [WEBHOOK_SOURCES.SAP_MM]:       'SAP MM',
  [WEBHOOK_SOURCES.SAP_PP]:       'SAP PP',
  [WEBHOOK_SOURCES.ORACLE_SCM]:   'Oracle SCM',
  [WEBHOOK_SOURCES.GENERIC_REST]: 'Generic REST',
};

const SOURCE_COLORS = {
  [WEBHOOK_SOURCES.SAP_MM]:       'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  [WEBHOOK_SOURCES.SAP_PP]:       'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  [WEBHOOK_SOURCES.ORACLE_SCM]:   'text-red-600 bg-red-50 dark:bg-red-900/20',
  [WEBHOOK_SOURCES.GENERIC_REST]: 'text-slate-600 bg-slate-100 dark:bg-slate-800',
};

// ── Webhook Card ─────────────────────────────────────────────────────────────

function WebhookCard({ webhook, onToggle, onDelete, onCopyKey, onTest }) {
  const [showKey, setShowKey] = useState(false);
  const label = SOURCE_LABELS[webhook.source_type] || webhook.source_type;
  const color = SOURCE_COLORS[webhook.source_type] || 'text-slate-600 bg-slate-100';

  return (
    <Card variant="elevated" className={`p-4 flex flex-col gap-3 ${!webhook.is_active ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{webhook.name}</span>
            <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${color}`}>{label}</span>
          </div>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Created {new Date(webhook.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onToggle(webhook)} className="p-1.5 rounded-lg hover:bg-[var(--surface-subtle)] transition-colors">
            {webhook.is_active
              ? <ToggleRight className="w-4 h-4 text-emerald-600" />
              : <ToggleLeft className="w-4 h-4 text-slate-400" />
            }
          </button>
          <button onClick={() => onDelete(webhook.id)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            <Trash2 className="w-3.5 h-3.5 text-red-500" />
          </button>
        </div>
      </div>

      {/* API Key */}
      <div className="flex items-center gap-2">
        <div className="flex-1 px-3 py-1.5 rounded border text-xs font-mono truncate"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-bg)', color: 'var(--text-secondary)' }}>
          {showKey ? webhook.api_key : `${'*'.repeat(16)}...${(webhook.api_key || '').slice(-8)}`}
        </div>
        <button
          onClick={() => setShowKey(!showKey)}
          className="px-2 py-1.5 rounded border text-xs transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
        >
          {showKey ? 'Hide' : 'Show'}
        </button>
        <button
          onClick={() => onCopyKey(webhook.api_key)}
          className="p-1.5 rounded-lg hover:bg-[var(--surface-subtle)] transition-colors"
        >
          <Copy className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>

      {/* Stats */}
      <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span className="flex items-center gap-1">
          <Activity className="w-3 h-3" />
          {webhook.total_received || 0} received
        </span>
        <span className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
          {webhook.total_processed || 0} processed
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle className="w-3 h-3 text-red-500" />
          {webhook.total_errors || 0} errors
        </span>
        {webhook.last_received_at && (
          <span>Last: {new Date(webhook.last_received_at).toLocaleString()}</span>
        )}
      </div>

      {/* Test button */}
      <button
        onClick={() => onTest(webhook)}
        className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
      >
        <ExternalLink className="w-3 h-3" />
        Send Test
      </button>
    </Card>
  );
}

// ── Create Webhook Modal ─────────────────────────────────────────────────────

function CreateWebhookModal({ onClose, onCreated, workers }) {
  const [form, setForm] = useState({
    sourceType: WEBHOOK_SOURCES.SAP_MM,
    name: '',
    employeeId: workers[0]?.id || '',
  });
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await registerWebhook({
        sourceType: form.sourceType,
        name: form.name || `${SOURCE_LABELS[form.sourceType]} Webhook`,
        employeeId: form.employeeId,
        userId: workers[0]?.manager_user_id,
      });
      if (result.ok) onCreated(result.webhook);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Register Webhook">
      <div className="p-4 space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Source Type</label>
          <select
            value={form.sourceType}
            onChange={e => setForm(prev => ({ ...prev, sourceType: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          >
            {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Name</label>
          <input
            type="text" value={form.name}
            onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
            placeholder="e.g. Production SAP Alerts"
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Target Worker</label>
          <select
            value={form.employeeId}
            onChange={e => setForm(prev => ({ ...prev, employeeId: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
          >
            {workers.map(w => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}
          </select>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleCreate}
            disabled={creating || !form.employeeId}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {creating ? 'Creating...' : 'Register Webhook'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WebhookConfigPage() {
  const { user } = useAuth();
  const [webhooks, setWebhooks] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const [wh, wk] = await Promise.all([
        listWebhooks(user.id),
        listEmployeesByManager(user.id),
      ]);
      setWebhooks(wh);
      setWorkers(wk);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (webhook) => {
    await updateWebhook(webhook.id, { is_active: !webhook.is_active });
    await load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this webhook endpoint?')) return;
    await deleteWebhook(id);
    await load();
  };

  const handleCopyKey = (key) => {
    navigator.clipboard.writeText(key).catch(() => {});
  };

  const handleTest = async (webhook) => {
    setTestResult(null);
    const samplePayloads = {
      [WEBHOOK_SOURCES.SAP_MM]: { ALERT_TYPE: 'MATSHORT', MATNR: 'MAT-001', WERKS: 'PLT-A', MESSAGE: 'Material shortage detected', MENGE: 500 },
      [WEBHOOK_SOURCES.ORACLE_SCM]: { alertType: 'SUPPLY_ALERT', itemNumber: 'ITEM-001', message: 'Supply chain disruption', priority: 'high' },
      [WEBHOOK_SOURCES.GENERIC_REST]: { type: 'alert', title: 'Test Alert', message: 'Test webhook payload', priority: 'medium' },
    };

    const payload = samplePayloads[webhook.source_type] || samplePayloads[WEBHOOK_SOURCES.GENERIC_REST];
    const result = await processWebhook({
      sourceType: webhook.source_type,
      payload,
      employeeId: webhook.employee_id,
      userId: user.id,
      webhookConfig: webhook,
    });
    setTestResult(result);
    await load(); // refresh stats
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* Header */}
      <div
        className="h-14 flex items-center justify-between px-6 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2.5">
          <Webhook className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Webhook Endpoints</span>
          {webhooks.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20">
              {webhooks.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={workers.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Register Webhook
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="max-w-3xl space-y-4">
            {/* Test result banner */}
            {testResult && (
              <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                testResult.ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20' : 'bg-red-50 text-red-700 dark:bg-red-900/20'
              }`}>
                {testResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                {testResult.ok
                  ? `Test webhook processed (status: ${testResult.status})`
                  : `Test failed: ${testResult.error}`
                }
                <button onClick={() => setTestResult(null)} className="ml-auto p-1">
                  <span className="text-xs">Dismiss</span>
                </button>
              </div>
            )}

            {/* Usage guide */}
            <Card variant="elevated" className="p-4">
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>WEBHOOK ENDPOINT</p>
              <code className="block text-xs font-mono px-3 py-2 rounded bg-slate-100 dark:bg-slate-800"
                style={{ color: 'var(--text-secondary)' }}>
                POST /api/webhooks/intake
              </code>
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Send <code className="font-mono">X-API-Key</code> header with your webhook API key.
                Optionally include <code className="font-mono">X-Webhook-Signature</code> for HMAC verification.
              </p>
            </Card>

            {webhooks.map(wh => (
              <WebhookCard
                key={wh.id}
                webhook={wh}
                onToggle={handleToggle}
                onDelete={handleDelete}
                onCopyKey={handleCopyKey}
                onTest={handleTest}
              />
            ))}

            {webhooks.length === 0 && (
              <div className="flex flex-col items-center justify-center h-36 gap-3">
                <Webhook className="w-10 h-10 text-indigo-300" />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  No webhooks registered. Create one to receive alerts from SAP, Oracle, or other systems.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <CreateWebhookModal
          onClose={() => setShowCreate(false)}
          onCreated={(wh) => { setShowCreate(false); load(); }}
          workers={workers}
        />
      )}
    </div>
  );
}
