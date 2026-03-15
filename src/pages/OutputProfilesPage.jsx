// @product: ai-employee
//
// OutputProfilesPage.jsx — Company Output Profile management page.
// Inspired by Jasper Brand IQ card gallery + Templafy version lifecycle + Frontify approval workflow.
// Lists all company output profiles, allows uploading exemplars, viewing profile detail,
// managing proposals (baseline vs suggested), and running onboarding pipeline.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileText, Upload, Plus, Search, Filter, ChevronRight, ChevronDown,
  CheckCircle2, Clock, Archive, XCircle, ArrowUpRight, RotateCcw,
  Layers, Eye, GitCompare, Sparkles, BookOpen, Shield, BarChart3,
  Play, Settings2, AlertTriangle,
} from 'lucide-react';
import {
  listCompanyOutputProfiles,
  listExemplars,
  approveOutputProfileProposal,
  rejectOutputProfileProposal,
  rollbackOutputProfile,
  getOnboardingStatus,
  runOnboarding,
  ONBOARDING_STAGES,
} from '../services/aiEmployee/styleLearning';
import ProfileCard from '../components/output-profile/ProfileCard';
import ExemplarUploadPanel from '../components/output-profile/ExemplarUploadPanel';
import ProfileDetailPanel from '../components/output-profile/ProfileDetailPanel';
import ProposalDiffPanel from '../components/output-profile/ProposalDiffPanel';
import OnboardingWizard from '../components/output-profile/OnboardingWizard';

// ── Status Config ──────────────────────────────────────────────
const STATUS_CONFIG = {
  draft:      { label: 'Draft',      color: '#f59e0b', icon: Clock },
  active:     { label: 'Active',     color: '#10b981', icon: CheckCircle2 },
  superseded: { label: 'Superseded', color: '#9ca3af', icon: Archive },
  archived:   { label: 'Archived',   color: '#6b7280', icon: Archive },
};

const DOC_TYPE_LABELS = {
  excel_mbr:        'Excel MBR',
  weekly_ops:       'Weekly Ops Summary',
  manager_email:    'Manager Email',
  qbr_deck:         'QBR Deck',
  risk_report:      'Risk Report',
  forecast_report:  'Forecast Report',
};

const TABS = [
  { id: 'profiles',  label: 'Output Profiles', icon: FileText },
  { id: 'exemplars', label: 'Exemplars',        icon: BookOpen },
  { id: 'proposals', label: 'Proposals',         icon: GitCompare },
  { id: 'onboarding', label: 'Learning',        icon: Sparkles },
];

export default function OutputProfilesPage() {
  // ── State ──────────────────────────────────────────────────
  const [tab, setTab] = useState('profiles');
  const [profiles, setProfiles] = useState([]);
  const [exemplars, setExemplars] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [docTypeFilter, setDocTypeFilter] = useState('');

  // Panel states
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [selectedProposal, setSelectedProposal] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // ── Data Loading ──────────────────────────────────────────
  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const filter = {};
      if (statusFilter) filter.status = statusFilter;
      if (docTypeFilter) filter.doc_type = docTypeFilter;
      const result = await listCompanyOutputProfiles(filter);
      setProfiles(result || []);
    } catch (err) {
      console.error('[OutputProfilesPage] Failed to load profiles:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, docTypeFilter]);

  const loadExemplars = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listExemplars({ limit: 100 });
      setExemplars(result || []);
    } catch (err) {
      console.error('[OutputProfilesPage] Failed to load exemplars:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'profiles' || tab === 'proposals') loadProfiles();
    if (tab === 'exemplars') loadExemplars();
  }, [tab, loadProfiles, loadExemplars]);

  // ── Filtering ─────────────────────────────────────────────
  const filteredProfiles = useMemo(() => {
    if (!search) return profiles;
    const q = search.toLowerCase();
    return profiles.filter(p =>
      (p.profile_name || '').toLowerCase().includes(q) ||
      (p.doc_type || '').toLowerCase().includes(q) ||
      (p.team_id || '').toLowerCase().includes(q)
    );
  }, [profiles, search]);

  const activeProfiles = filteredProfiles.filter(p => p.status === 'active');
  const draftProfiles = filteredProfiles.filter(p => p.status === 'draft');
  const otherProfiles = filteredProfiles.filter(p => !['active', 'draft'].includes(p.status));

  // Proposals are profiles with pending proposals
  const proposals = profiles.filter(p => p.pending_proposals?.length > 0);

  const filteredExemplars = useMemo(() => {
    if (!search) return exemplars;
    const q = search.toLowerCase();
    return exemplars.filter(e =>
      (e.label || '').toLowerCase().includes(q) ||
      (e.doc_type || '').toLowerCase().includes(q) ||
      (e.file_name || '').toLowerCase().includes(q)
    );
  }, [exemplars, search]);

  // ── Handlers ──────────────────────────────────────────────
  const handleApproveProposal = async (proposalId) => {
    try {
      await approveOutputProfileProposal(proposalId, 'manager');
      setSelectedProposal(null);
      loadProfiles();
    } catch (err) {
      console.error('[OutputProfilesPage] Approve failed:', err);
    }
  };

  const handleRejectProposal = async (proposalId, comment) => {
    try {
      await rejectOutputProfileProposal(proposalId, 'manager', comment);
      setSelectedProposal(null);
      loadProfiles();
    } catch (err) {
      console.error('[OutputProfilesPage] Reject failed:', err);
    }
  };

  const handleRollback = async (profileId) => {
    if (!confirm('Rollback to the previous version? The current active version will be superseded.')) return;
    try {
      await rollbackOutputProfile(profileId);
      loadProfiles();
    } catch (err) {
      console.error('[OutputProfilesPage] Rollback failed:', err);
    }
  };

  // ── Tab Style ─────────────────────────────────────────────
  const tabStyle = (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 18px',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? '#4f46e5' : '#666',
    borderBottom: `2px solid ${active ? '#4f46e5' : 'transparent'}`,
    background: 'none',
    border: 'none',
    borderBottomStyle: 'solid',
    borderBottomWidth: 2,
    borderBottomColor: active ? '#4f46e5' : 'transparent',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  });

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
            Output Profiles
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Learned company templates — versioned, auditable, and improvable
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowUpload(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 8,
              border: 'none',
              background: '#4f46e5', color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <Sparkles size={14} /> Bulk Upload & Learn
          </button>
        </div>
      </div>

      {/* ── KPI Tiles (like Jasper Brand IQ overview) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Active Profiles', value: profiles.filter(p => p.status === 'active').length, color: '#10b981', icon: CheckCircle2 },
          { label: 'Pending Proposals', value: proposals.length, color: '#f59e0b', icon: Clock },
          { label: 'Exemplars Ingested', value: exemplars.length, color: '#6366f1', icon: BookOpen },
          { label: 'Avg. Confidence', value: profiles.length > 0 ? `${Math.round(profiles.filter(p => p.status === 'active').reduce((s, p) => s + (p.confidence || 0), 0) / Math.max(1, activeProfiles.length) * 100)}%` : '—', color: '#0ea5e9', icon: BarChart3 },
        ].map((tile, i) => (
          <div key={i} style={{
            padding: '14px 16px', borderRadius: 10,
            border: '1px solid var(--border-default)',
            background: 'var(--surface-card)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <tile.icon size={14} style={{ color: tile.color }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {tile.label}
              </span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
              {tile.value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Tabs (like Templafy workflow tabs) ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-default)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.id} style={tabStyle(tab === t.id)} onClick={() => { setTab(t.id); setSearch(''); setStatusFilter(''); }}>
            <t.icon size={14} />
            {t.label}
            {t.id === 'proposals' && proposals.length > 0 && (
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 10,
                background: '#fef3c7', color: '#92400e', fontWeight: 600,
              }}>
                {proposals.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Filters ── */}
      {(tab === 'profiles' || tab === 'exemplars') && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#999' }} />
            <input
              type="text"
              placeholder="Search profiles..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px 8px 30px',
                borderRadius: 8, border: '1px solid var(--border-default)',
                fontSize: 13, background: 'var(--surface-card)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          {tab === 'profiles' && (
            <>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                style={{
                  padding: '8px 12px', borderRadius: 8,
                  border: '1px solid var(--border-default)', fontSize: 13,
                  background: 'var(--surface-card)', color: 'var(--text-primary)',
                }}
              >
                <option value="">All Statuses</option>
                {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <select
                value={docTypeFilter}
                onChange={e => setDocTypeFilter(e.target.value)}
                style={{
                  padding: '8px 12px', borderRadius: 8,
                  border: '1px solid var(--border-default)', fontSize: 13,
                  background: 'var(--surface-card)', color: 'var(--text-primary)',
                }}
              >
                <option value="">All Doc Types</option>
                {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      {/* ═══ Profiles Tab ═══ */}
      {tab === 'profiles' && (
        <>
          {loading && <LoadingState />}
          {!loading && filteredProfiles.length === 0 && (
            <EmptyState
              icon={FileText}
              title="No output profiles yet"
              description="Upload exemplar files and run the learning pipeline to create your first company output profile."
              actionLabel="Bulk Upload & Learn"
              onAction={() => setShowUpload(true)}
            />
          )}

          {/* Active profiles — hero section (like Jasper brand voice cards) */}
          {activeProfiles.length > 0 && (
            <ProfileSection title="Active Profiles" count={activeProfiles.length}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
                {activeProfiles.map(p => (
                  <ProfileCard
                    key={p.id}
                    profile={p}
                    statusConfig={STATUS_CONFIG}
                    docTypeLabels={DOC_TYPE_LABELS}
                    onClick={() => setSelectedProfile(p)}
                    onRollback={() => handleRollback(p.id)}
                  />
                ))}
              </div>
            </ProfileSection>
          )}

          {/* Draft profiles */}
          {draftProfiles.length > 0 && (
            <ProfileSection title="Drafts" count={draftProfiles.length}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
                {draftProfiles.map(p => (
                  <ProfileCard
                    key={p.id}
                    profile={p}
                    statusConfig={STATUS_CONFIG}
                    docTypeLabels={DOC_TYPE_LABELS}
                    onClick={() => setSelectedProfile(p)}
                  />
                ))}
              </div>
            </ProfileSection>
          )}

          {/* Superseded / Archived */}
          {otherProfiles.length > 0 && (
            <ProfileSection title="History" count={otherProfiles.length} defaultCollapsed>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
                {otherProfiles.map(p => (
                  <ProfileCard
                    key={p.id}
                    profile={p}
                    statusConfig={STATUS_CONFIG}
                    docTypeLabels={DOC_TYPE_LABELS}
                    onClick={() => setSelectedProfile(p)}
                  />
                ))}
              </div>
            </ProfileSection>
          )}
        </>
      )}

      {/* ═══ Exemplars Tab ═══ */}
      {tab === 'exemplars' && (
        <>
          {loading && <LoadingState />}
          {!loading && filteredExemplars.length === 0 && (
            <EmptyState
              icon={BookOpen}
              title="No exemplars uploaded yet"
              description="Upload approved company deliverables to start building output profiles."
              actionLabel="Bulk Upload & Learn"
              onAction={() => setShowUpload(true)}
            />
          )}
          {!loading && filteredExemplars.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredExemplars.map(e => (
                <ExemplarRow key={e.id} exemplar={e} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ═══ Proposals Tab ═══ */}
      {tab === 'proposals' && (
        <>
          {proposals.length === 0 && !loading && (
            <EmptyState
              icon={GitCompare}
              title="No pending proposals"
              description="Proposals are created automatically when the AI detects reusable patterns from manager reviews."
            />
          )}
          {proposals.map(p => (
            p.pending_proposals?.map(prop => (
              <ProposalRow
                key={prop.id}
                proposal={prop}
                profile={p}
                docTypeLabels={DOC_TYPE_LABELS}
                onView={() => setSelectedProposal(prop)}
                onApprove={() => handleApproveProposal(prop.id)}
                onReject={() => handleRejectProposal(prop.id, '')}
              />
            ))
          ))}
        </>
      )}

      {/* ═══ Learning / Onboarding Tab ═══ */}
      {tab === 'onboarding' && (
        <OnboardingWizard
          onComplete={() => { loadProfiles(); setTab('profiles'); }}
        />
      )}

      {/* ═══ Modals / Side Panels ═══ */}
      {selectedProfile && (
        <ProfileDetailPanel
          profile={selectedProfile}
          docTypeLabels={DOC_TYPE_LABELS}
          onClose={() => setSelectedProfile(null)}
          onRollback={() => handleRollback(selectedProfile.id)}
        />
      )}

      {selectedProposal && (
        <ProposalDiffPanel
          proposal={selectedProposal}
          onClose={() => setSelectedProposal(null)}
          onApprove={() => handleApproveProposal(selectedProposal.id)}
          onReject={(comment) => handleRejectProposal(selectedProposal.id, comment)}
        />
      )}

      {showUpload && (
        <ExemplarUploadPanel
          onClose={() => setShowUpload(false)}
          onUploaded={() => { loadExemplars(); setShowUpload(false); }}
        />
      )}

      {showOnboarding && (
        <OnboardingWizard
          asModal
          onClose={() => setShowOnboarding(false)}
          onComplete={() => { loadProfiles(); setShowOnboarding(false); }}
        />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────

function ProfileSection({ title, count, children, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          marginBottom: 10, padding: 0,
        }}
      >
        {collapsed ? <ChevronRight size={16} style={{ color: '#666' }} /> : <ChevronDown size={16} style={{ color: '#666' }} />}
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 400 }}>({count})</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function ExemplarRow({ exemplar }) {
  const e = exemplar;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 8,
      border: '1px solid var(--border-default)',
      background: 'var(--surface-card)',
    }}>
      <FileText size={18} style={{ color: '#6366f1', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {e.label || e.file_name || `Exemplar ${e.id?.slice(0, 8)}`}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          {e.doc_type || 'unknown'} · {e.quality_tier || 'ungraded'} · {e.created_at ? new Date(e.created_at).toLocaleDateString() : '—'}
        </div>
      </div>
      <span style={{
        fontSize: 10, padding: '2px 8px', borderRadius: 10,
        background: e.quality_tier === 'gold' ? '#dcfce7' : e.quality_tier === 'silver' ? '#dbeafe' : '#f3f4f6',
        color: e.quality_tier === 'gold' ? '#166534' : e.quality_tier === 'silver' ? '#1e40af' : '#666',
      }}>
        {e.quality_tier || 'ungraded'}
      </span>
    </div>
  );
}

function ProposalRow({ proposal, profile, docTypeLabels, onView, onApprove, onReject }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 16px', borderRadius: 10,
      border: '1px solid #fbbf24', borderLeftWidth: 3,
      background: 'var(--surface-card)', marginBottom: 10,
    }}>
      <GitCompare size={18} style={{ color: '#f59e0b', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {proposal.proposal_name || `Improvement for ${docTypeLabels[profile.doc_type] || profile.doc_type}`}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          {proposal.rationale?.slice(0, 120)}{proposal.rationale?.length > 120 ? '...' : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onView} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)' }}>
          <Eye size={12} style={{ marginRight: 4 }} /> View Diff
        </button>
        <button onClick={onApprove} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: '#10b981', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
          Approve
        </button>
        <button onClick={onReject} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 12, cursor: 'pointer' }}>
          Reject
        </button>
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, description, actionLabel, onAction }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16,
        background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 16px',
      }}>
        <Icon size={24} style={{ color: '#6366f1' }} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 400, margin: '0 auto 16px' }}>{description}</div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          style={{
            padding: '8px 16px', borderRadius: 8,
            background: '#4f46e5', color: '#fff',
            border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)', fontSize: 13 }}>
      Loading...
    </div>
  );
}
