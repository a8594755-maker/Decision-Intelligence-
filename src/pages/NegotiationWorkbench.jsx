/**
 * NegotiationWorkbench — Dedicated page for managing procurement negotiations.
 *
 * Layout:
 *   Left panel:  case list with status filter
 *   Right panel: selected case detail (reuses NegotiationActionCard + NegotiationPanel)
 *
 * Data source: negotiationPersistenceService (Supabase-backed)
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Handshake,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
  Filter,
  Loader2,
  Shield,
} from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import NegotiationActionCard from '../components/chat/NegotiationActionCard';
import * as persistence from '../services/negotiationPersistenceService';
import { determineStrategy, generateCounterOffer, evaluateOutcome } from '../services/negotiationStrategyEngine';

// ── Status config ───────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  active:               { label: 'Active',    icon: Clock,        color: 'text-blue-600 dark:text-blue-400',    bg: 'bg-blue-100 dark:bg-blue-900/40' },
  resolved_agreement:   { label: 'Agreement', icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  resolved_walkaway:    { label: 'Walk-Away', icon: XCircle,      color: 'text-red-600 dark:text-red-400',      bg: 'bg-red-100 dark:bg-red-900/40' },
  expired:              { label: 'Expired',   icon: AlertTriangle, color: 'text-slate-500 dark:text-slate-400',  bg: 'bg-slate-100 dark:bg-slate-700' },
};

const ROUND_LABELS = ['OPENING', 'CONCESSION', 'CLOSING'];

const FILTER_OPTIONS = [
  { value: '',                   label: 'All Cases' },
  { value: 'active',             label: 'Active' },
  { value: 'resolved_agreement', label: 'Agreements' },
  { value: 'resolved_walkaway',  label: 'Walk-Aways' },
];

// ── Case List Item ──────────────────────────────────────────────────────────

function CaseListItem({ c, isSelected, onClick }) {
  const cfg = STATUS_CONFIG[c.status] || STATUS_CONFIG.active;
  const StatusIcon = cfg.icon;
  const roundName = ROUND_LABELS[c.current_round] || c.current_round_name;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 rounded-lg transition-colors ${
        isSelected
          ? 'bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700/50'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
        <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
          Run #{c.plan_run_id}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cfg.bg} ${cfg.color}`}>
          {cfg.label}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="capitalize">{c.trigger}</span>
        <span className="text-slate-300 dark:text-slate-600">&middot;</span>
        <span>Round: {roundName}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        {new Date(c.created_at).toLocaleDateString()} {new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </button>
  );
}

// ── Case Detail Panel ───────────────────────────────────────────────────────

function CaseDetail({ caseData, events, onAction, onRefresh }) {
  if (!caseData) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500">
        <div className="text-center">
          <Handshake className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Select a negotiation case to view details</p>
        </div>
      </div>
    );
  }

  const cfg = STATUS_CONFIG[caseData.status] || STATUS_CONFIG.active;
  const StatusIcon = cfg.icon;

  // ── Strategy Engine Integration ─────────────────────────────────────────
  const strategyResult = determineStrategy({
    buyerPosition: caseData.buyer_position || {},
    supplierKpis: caseData.supplier_kpis || {},
    alternativeCount: caseData.buyer_position?.alternative_count ?? 0,
    urgency: caseData.buyer_position?.urgency ?? 50,
  });

  const counterOffer = caseData.status === 'active'
    ? generateCounterOffer({
        strategy: strategyResult.strategy,
        currentRound: caseData.current_round ?? 0,
        currentTerms: caseData.supplier_kpis || {},
        targetTerms: caseData.buyer_position?.target_terms || {},
        supplierLastOffer: (events || [])
          .filter((e) => e.player === 'supplier')
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]?.details || null,
      })
    : null;

  const outcomeScorecard = caseData.outcome?.agreed_terms
    ? evaluateOutcome({
        agreedTerms: caseData.outcome.agreed_terms,
        targetTerms: caseData.buyer_position?.target_terms || {},
        initialTerms: caseData.outcome.initial_terms || caseData.supplier_kpis || {},
        batna: strategyResult.batna,
      })
    : null;

  // Build payload shape that NegotiationActionCard expects
  const actionCardPayload = {
    negotiation_id: caseData.id,
    trigger: caseData.trigger,
    planRunId: caseData.plan_run_id,
    cfr_strategy: caseData.buyer_position ? {
      position_strength: caseData.buyer_position.name || 'NEUTRAL',
    } : null,
    negotiation_state: {
      status: caseData.status,
      current_round: caseData.current_round,
      current_round_name: caseData.current_round_name,
      action_history: (events || []).map((e) => ({
        round: e.round,
        round_name: e.round_name,
        player: e.player,
        action: e.action,
        timestamp: e.created_at,
        details: e.details,
      })),
      market_events: [],
    },
    drafts: [],
    strategy_engine: strategyResult,
    counter_offer: counterOffer,
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
            <Shield className="w-5 h-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
              Negotiation · Run #{caseData.plan_run_id}
            </h2>
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <StatusIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
              <span>{cfg.label}</span>
              <span className="text-slate-300 dark:text-slate-600">&middot;</span>
              <span className="capitalize">{caseData.trigger}</span>
              <span className="text-slate-300 dark:text-slate-600">&middot;</span>
              <span>Round: {caseData.current_round_name}</span>
            </div>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* Buyer position */}
      {caseData.buyer_position && caseData.buyer_position.name && (
        <Card variant="elevated" className="!p-4">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
            Buyer Position
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {caseData.buyer_position.name}
            </span>
            {caseData.buyer_position.risk_score != null && (
              <span className="text-xs text-slate-500">
                Risk score: {caseData.buyer_position.risk_score}
              </span>
            )}
            {caseData.scenario_id && (
              <span className="text-xs text-slate-500">
                Scenario: {caseData.scenario_id}
              </span>
            )}
          </div>
        </Card>
      )}

      {/* Supplier KPIs */}
      {caseData.supplier_kpis && Object.keys(caseData.supplier_kpis).length > 0 && (
        <Card variant="elevated" className="!p-4">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
            Supplier KPIs
          </div>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(caseData.supplier_kpis).map(([key, val]) => (
              <div key={key} className="text-sm">
                <span className="text-xs text-slate-500">{key}:</span>{' '}
                <span className="font-medium text-slate-800 dark:text-slate-200">
                  {typeof val === 'number' ? val.toFixed(3) : String(val)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Strategy Insight */}
      <Card variant="elevated" className="!p-4">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-3">
          AI Strategy Recommendation
        </div>
        <div className="flex items-center gap-3 mb-3">
          <span className={`text-sm font-bold px-2.5 py-1 rounded-full ${
            strategyResult.strategy === 'COMPETITIVE'
              ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
              : strategyResult.strategy === 'ACCOMMODATING'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          }`}>
            {strategyResult.strategy}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Position: <strong>{strategyResult.positionStrength}</strong> (Power Score: {strategyResult.powerScore})
          </span>
        </div>
        <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
          {strategyResult.reasoning.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className="text-slate-400 mt-0.5">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* BATNA Analysis */}
      <Card variant="elevated" className="!p-4">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-3">
          BATNA Analysis
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-xs text-slate-500">Alternative Available</span>
            <p className="font-medium text-slate-800 dark:text-slate-200">
              {strategyResult.batna.hasAlternative ? 'Yes' : 'No'}
            </p>
          </div>
          <div>
            <span className="text-xs text-slate-500">Alt. Premium</span>
            <p className="font-medium text-slate-800 dark:text-slate-200">
              +{(strategyResult.batna.alternativePremiumPct * 100).toFixed(0)}%
            </p>
          </div>
          <div>
            <span className="text-xs text-slate-500">Switching Cost</span>
            <p className="font-medium text-slate-800 dark:text-slate-200">
              ${strategyResult.batna.switchingCostUsd.toLocaleString()}
            </p>
          </div>
          <div>
            <span className="text-xs text-slate-500">Walk-Away Risk</span>
            <p className={`font-medium ${
              strategyResult.batna.walkawayRisk === 'high'
                ? 'text-red-600' : strategyResult.batna.walkawayRisk === 'medium'
                  ? 'text-amber-600' : 'text-emerald-600'
            }`}>
              {strategyResult.batna.walkawayRisk.toUpperCase()}
            </p>
          </div>
        </div>
      </Card>

      {/* Counter-Offer Recommendation (active negotiations only) */}
      {counterOffer && caseData.status === 'active' && (
        <Card variant="elevated" className="!p-4 border-l-4 border-indigo-400">
          <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide mb-2">
            Counter-Offer Recommendation · {counterOffer.roundName}
            {counterOffer.isLastRound && (
              <span className="ml-2 text-red-500 text-[10px]">(FINAL ROUND)</span>
            )}
          </div>
          <div className="text-sm text-slate-700 dark:text-slate-300 mb-2 italic">
            {counterOffer.tactic}
          </div>
          {counterOffer.explanation.length > 0 && (
            <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1 mb-2">
              {counterOffer.explanation.map((e, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-indigo-400 mt-0.5">→</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
          {counterOffer.walkawayThreshold?.explanation && (
            <div className="text-[10px] text-red-500 dark:text-red-400 mt-1 font-medium">
              ⚠ {counterOffer.walkawayThreshold.explanation}
            </div>
          )}
        </Card>
      )}

      {/* Event Timeline via NegotiationActionCard */}
      <NegotiationActionCard
        payload={actionCardPayload}
        onAction={onAction}
      />

      {/* Outcome Scorecard (resolved negotiations) */}
      {outcomeScorecard && (
        <Card variant="elevated" className="!p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
              Negotiation Scorecard
            </div>
            <div className={`text-2xl font-black ${
              outcomeScorecard.grade === 'A' ? 'text-emerald-600'
                : outcomeScorecard.grade === 'B' ? 'text-blue-600'
                  : outcomeScorecard.grade === 'C' ? 'text-amber-600'
                    : 'text-red-600'
            }`}>
              {outcomeScorecard.grade}
            </div>
          </div>
          <div className="text-sm text-slate-700 dark:text-slate-300 mb-3">
            Overall Score: <strong>{outcomeScorecard.score}</strong>/100
            {outcomeScorecard.better_than_batna != null && (
              <span className={`ml-3 text-xs font-medium ${
                outcomeScorecard.better_than_batna ? 'text-emerald-600' : 'text-red-600'
              }`}>
                {outcomeScorecard.better_than_batna ? '✓ Better than BATNA' : '✗ Worse than BATNA'}
              </span>
            )}
          </div>
          <div className="space-y-2">
            {outcomeScorecard.analysis.map((a, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-slate-500 w-20">{a.factor}</span>
                <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      a.score >= 80 ? 'bg-emerald-500' : a.score >= 60 ? 'bg-blue-500' : a.score >= 40 ? 'bg-amber-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${a.score}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-slate-600 dark:text-slate-400 w-8 text-right">{a.score}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Raw Outcome Data (if resolved and no scorecard) */}
      {caseData.outcome && !outcomeScorecard && (
        <Card variant="elevated" className="!p-4">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
            Outcome
          </div>
          <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono bg-slate-50 dark:bg-slate-800/50 rounded p-3">
            {JSON.stringify(caseData.outcome, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function NegotiationWorkbench() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [cases, setCases] = useState([]);
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [selectedCaseDetail, setSelectedCaseDetail] = useState(null);
  const [events, setEvents] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);

  // ── Load cases ──────────────────────────────────────────────────────────

  const loadCases = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const opts = statusFilter ? { status: statusFilter } : {};
      const data = await persistence.listCases(user.id, opts);
      setCases(data || []);

      const s = await persistence.getCaseStats(user.id);
      setStats(s);
    } catch (err) {
      console.warn('[NegotiationWorkbench] Failed to load cases:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id, statusFilter]);

  useEffect(() => {
    loadCases();
  }, [loadCases]);

  // ── Load selected case detail ───────────────────────────────────────────

  const loadCaseDetail = useCallback(async (caseId) => {
    if (!caseId) {
      setSelectedCaseDetail(null);
      setEvents([]);
      return;
    }
    try {
      const detail = await persistence.getCaseWithEvents(caseId);
      if (detail) {
        setSelectedCaseDetail(detail);
        setEvents(detail.events || []);
      }
    } catch (err) {
      console.warn('[NegotiationWorkbench] Failed to load case detail:', err);
    }
  }, []);

  useEffect(() => {
    loadCaseDetail(selectedCaseId);
  }, [selectedCaseId, loadCaseDetail]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleAction = useCallback(async (action, details) => {
    if (!selectedCaseId || !selectedCaseDetail) return;

    // Record the buyer action as an event
    await persistence.recordEvent(selectedCaseId, {
      round: selectedCaseDetail.current_round,
      roundName: selectedCaseDetail.current_round_name,
      player: 'buyer',
      action: action === 'sent' ? 'counter' : action === 'skip' ? 'reject' : 'counter',
      details: { ui_action: action, ...details },
      draftTone: details?.tone,
      draftBody: details?.draft?.body,
    });

    // Refresh
    loadCaseDetail(selectedCaseId);
  }, [selectedCaseId, selectedCaseDetail, loadCaseDetail]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* ── Left: Case List ── */}
      <div
        className="w-80 flex-shrink-0 border-r flex flex-col"
        style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
      >
        {/* Header */}
        <div className="p-4 border-b" style={{ borderColor: 'var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Handshake className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Negotiations
            </h1>
            <button
              onClick={loadCases}
              className="ml-auto p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Refresh list"
            >
              <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
            </button>
          </div>

          {/* Stats */}
          {stats && (
            <div className="flex gap-2 mb-3 text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                {stats.active} active
              </span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                {stats.resolved_agreement} agreed
              </span>
              <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                {stats.resolved_walkaway} walked
              </span>
            </div>
          )}

          {/* Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="flex-1 text-xs rounded-md border px-2 py-1.5 bg-white dark:bg-slate-800"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            >
              {FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Case list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          ) : cases.length === 0 ? (
            <div className="text-center py-12 text-sm text-slate-400 dark:text-slate-500">
              <Handshake className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No negotiation cases yet.</p>
              <p className="text-xs mt-1">Cases are created when a plan is infeasible or has KPI shortfall.</p>
            </div>
          ) : (
            cases.map((c) => (
              <CaseListItem
                key={c.id}
                c={c}
                isSelected={c.id === selectedCaseId}
                onClick={() => setSelectedCaseId(c.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Right: Case Detail ── */}
      <CaseDetail
        caseData={selectedCaseDetail}
        events={events}
        onAction={handleAction}
        onRefresh={() => loadCaseDetail(selectedCaseId)}
      />
    </div>
  );
}
