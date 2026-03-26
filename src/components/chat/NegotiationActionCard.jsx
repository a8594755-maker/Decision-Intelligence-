/**
 * NegotiationActionCard — Human-in-the-Loop Strategic Negotiation Copilot
 *
 * 3-section card rendered when message.type === 'negotiation_action_card':
 *
 *   Section 1: AI Strategy Insight (CFR-computed optimal action + position badge)
 *   Section 2: LLM Negotiation Drafts (3 tone variants, editable)
 *   Section 3: Human Decision Buttons (copy / edit / send / skip)
 *
 * Philosophy: 賦能而不越權 — Empower, don't override.
 * AI computes strategies and drafts, but the human makes the final call.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Shield,
  Target,
  Copy,
  Edit3,
  Send,
  SkipForward,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  MessageSquare,
  Zap,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const StrengthBadge = ({ strength }) => {
  const config = {
    VERY_WEAK:   { label: 'Very Weak',   color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
    WEAK:        { label: 'Weak',         color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300' },
    NEUTRAL:     { label: 'Neutral',      color: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300' },
    STRONG:      { label: 'Strong',       color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
    VERY_STRONG: { label: 'Very Strong',  color: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  };
  const c = config[strength] || config.NEUTRAL;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${c.color}`}>
      <Shield className="w-3 h-3" />
      {c.label}
    </span>
  );
};

const ActionProbBar = ({ action, prob, isTop }) => {
  const pct = Math.round((prob || 0) * 100);
  const barColor = isTop
    ? 'bg-blue-500 dark:bg-blue-400'
    : 'bg-slate-300 dark:bg-slate-600';
  const labelColor = isTop
    ? 'text-blue-700 dark:text-blue-300 font-semibold'
    : 'text-[var(--text-secondary)]';

  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs w-16 capitalize ${labelColor}`}>{action}</span>
      <div className="flex-1 h-2 bg-[var(--surface-subtle)] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs w-10 text-right ${labelColor}`}>{pct}%</span>
    </div>
  );
};

const ExploitabilityIndicator = ({ value }) => {
  if (value == null || !Number.isFinite(value)) return null;
  const isGood = value < 0.05;
  return (
    <div className="flex items-center gap-1 text-xs">
      {isGood ? (
        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
      ) : (
        <AlertTriangle className="w-3 h-3 text-amber-500" />
      )}
      <span className={isGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
        Exploitability: {value.toFixed(4)}
        {isGood ? ' (well-converged)' : ' (may refine)'}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section 1: AI Strategy Insight
// ---------------------------------------------------------------------------

const StrategyInsightSection = ({ cfrStrategy }) => {
  if (!cfrStrategy) {
    return (
      <div className="text-xs text-[var(--text-muted)] italic">
        CFR strategy not available — using rule-based recommendations only.
      </div>
    );
  }

  const {
    cfr_action_probs = {},
    position_strength,
    exploitability,
  } = cfrStrategy;

  const sortedActions = Object.entries(cfr_action_probs)
    .sort(([, a], [, b]) => b - a);
  const topAction = sortedActions[0];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            AI Strategy Insight
          </span>
        </div>
        <StrengthBadge strength={position_strength} />
      </div>

      {/* Top recommendation */}
      {topAction && (
        <div className="bg-blue-50/60 dark:bg-blue-900/20 border border-blue-200/60 dark:border-blue-700/40 rounded-lg p-3">
          <div className="text-xs text-blue-600 dark:text-blue-400 font-medium mb-1">
            GTO Recommendation
          </div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            {Math.round(topAction[1] * 100)}% probability: <span className="capitalize">{topAction[0]}</span>
          </div>
        </div>
      )}

      {/* Action probability bars */}
      <div className="space-y-1.5">
        {sortedActions.map(([action, prob]) => (
          <ActionProbBar
            key={action}
            action={action}
            prob={prob}
            isTop={action === topAction?.[0]}
          />
        ))}
      </div>

      <ExploitabilityIndicator value={exploitability} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section 2: LLM Negotiation Drafts
// ---------------------------------------------------------------------------

const TONE_META = {
  hardball:   { label: '強硬施壓', labelEn: 'Hardball',        icon: TrendingUp,   color: 'text-red-600 dark:text-red-400' },
  persuasion: { label: '數據說服', labelEn: 'Data-Persuasion', icon: Target,        color: 'text-blue-600 dark:text-blue-400' },
  win_win:    { label: '雙贏妥協', labelEn: 'Win-Win',         icon: TrendingDown,  color: 'text-emerald-600 dark:text-emerald-400' },
};

const DraftTab = ({ draft, isSelected, onClick }) => {
  const meta = TONE_META[draft.tone] || TONE_META.persuasion;
  const Icon = meta.icon || Minus;

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        isSelected
          ? 'bg-white dark:bg-slate-700 shadow-sm text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
      }`}
    >
      <Icon className={`w-3 h-3 ${isSelected ? meta.color : ''}`} />
      <span>{meta.label}</span>
      <span className="text-[var(--text-muted)]">({meta.labelEn})</span>
    </button>
  );
};

const DraftSection = ({ drafts, selectedDraftIndex, onSelectDraft, editedDrafts, onEditDraft }) => {
  if (!drafts || drafts.length === 0) {
    return (
      <div className="text-xs text-[var(--text-muted)] italic">
        No email drafts available.
      </div>
    );
  }

  const currentDraft = editedDrafts[selectedDraftIndex] || drafts[selectedDraftIndex];
  const isEditing = editedDrafts[selectedDraftIndex] !== undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Edit3 className="w-4 h-4 text-purple-500" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          Negotiation Drafts
        </span>
      </div>

      {/* Tone tabs */}
      <div className="flex gap-1 bg-[var(--surface-subtle)]/60 rounded-lg p-1">
        {drafts.map((draft, i) => (
          <DraftTab
            key={draft.tone}
            draft={draft}
            isSelected={i === selectedDraftIndex}
            onClick={() => onSelectDraft(i)}
          />
        ))}
      </div>

      {/* Subject line */}
      {currentDraft?.subject && (
        <div className="text-xs">
          <span className="font-semibold text-[var(--text-secondary)]">Subject: </span>
          <span className="text-[var(--text-primary)]">{currentDraft.subject}</span>
        </div>
      )}

      {/* Draft body (editable textarea) */}
      <textarea
        className="w-full min-h-[160px] p-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)]/40 text-sm text-[var(--text-secondary)] resize-y focus:ring-2 focus:ring-blue-400/50 focus:border-blue-400 outline-none transition-colors"
        value={currentDraft?.body || ''}
        onChange={(e) => onEditDraft(selectedDraftIndex, {
          ...currentDraft,
          body: e.target.value,
        })}
      />

      {/* Draft metadata */}
      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
        {currentDraft?.generated_by === 'llm' ? (
          <span className="flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            AI-generated, evidence-validated
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-amber-500" />
            Rule-based template
          </span>
        )}
        {isEditing && (
          <span className="text-blue-500">Modified</span>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section 3: Human Decision Buttons
// ---------------------------------------------------------------------------

const DecisionSection = ({ currentDraft, onCopy, onMarkSent, onSkip }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!currentDraft) return;
    const text = currentDraft.subject
      ? `Subject: ${currentDraft.subject}\n\n${currentDraft.body}`
      : currentDraft.body || '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopy?.();
    });
  }, [currentDraft, onCopy]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
      >
        <Copy className="w-3.5 h-3.5" />
        {copied ? 'Copied!' : 'Copy to Clipboard'}
      </button>

      <button
        onClick={onMarkSent}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
      >
        <Send className="w-3.5 h-3.5" />
        Mark as Sent
      </button>

      <button
        onClick={onSkip}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600 transition-colors"
      >
        <SkipForward className="w-3.5 h-3.5" />
        Skip Round
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section 4: Round History Timeline
// ---------------------------------------------------------------------------

const RoundBadge = ({ roundName, isCurrent }) => {
  const color = isCurrent
    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 ring-1 ring-purple-400/50'
    : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-[var(--text-muted)]';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {roundName}
      {isCurrent && <span className="ml-1 text-purple-500">●</span>}
    </span>
  );
};

const ActionEntry = ({ action }) => {
  const icons = {
    buyer: <Send className="w-3 h-3 text-blue-500" />,
    supplier: <MessageSquare className="w-3 h-3 text-amber-500" />,
  };
  const labels = {
    accept: 'Accepted',
    reject: 'Rejected',
    counter: 'Countered',
  };
  return (
    <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
      {icons[action.player] || <Minus className="w-3 h-3" />}
      <span className="capitalize font-medium">{action.player}</span>
      <span>{labels[action.action] || action.action}</span>
    </div>
  );
};

const RoundHistorySection = ({ negotiationState }) => {
  if (!negotiationState) return null;

  const {
    current_round_name,
    status,
    action_history = [],
    market_events = [],
  } = negotiationState;

  if (action_history.length === 0 && status === 'active') {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] italic">
        <Clock className="w-3 h-3" />
        Round 1 ({current_round_name}) — awaiting first action
      </div>
    );
  }

  // Group actions by round
  const rounds = [];
  let currentRound = -1;
  let roundEntry = null;

  for (const action of action_history) {
    if (action.round !== currentRound) {
      if (roundEntry) rounds.push(roundEntry);
      currentRound = action.round;
      roundEntry = { round: currentRound, round_name: action.round_name, actions: [] };
    }
    roundEntry.actions.push(action);
  }
  if (roundEntry) rounds.push(roundEntry);

  const isResolved = status !== 'active';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-[var(--text-muted)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          Negotiation Timeline
        </span>
        {isResolved && (
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
            status === 'resolved_agreement'
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
              : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
          }`}>
            {status === 'resolved_agreement' ? 'Agreement Reached' : 'Walk-Away'}
          </span>
        )}
      </div>

      <div className="space-y-2 pl-2 border-l-2 border-[var(--border-default)] ml-1">
        {rounds.map((round, i) => (
          <div key={i} className="pl-3 relative">
            <div className="absolute -left-[7px] top-1 w-3 h-3 rounded-full bg-[var(--surface-card)] border-2 border-[var(--border-default)]" />
            <RoundBadge
              roundName={round.round_name}
              isCurrent={round.round_name === current_round_name && !isResolved}
            />
            <div className="mt-1 space-y-0.5">
              {round.actions.map((action, j) => (
                <ActionEntry key={j} action={action} />
              ))}
            </div>
          </div>
        ))}

        {/* Market events indicator */}
        {market_events.length > 0 && (
          <div className="pl-3 relative">
            <div className="absolute -left-[7px] top-1 w-3 h-3 rounded-full bg-amber-400 dark:bg-amber-600 border-2 border-amber-300 dark:border-amber-500" />
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Zap className="w-3 h-3" />
              {market_events.length} market event{market_events.length > 1 ? 's' : ''} during negotiation
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main NegotiationActionCard
// ---------------------------------------------------------------------------

/**
 * NegotiationActionCard
 *
 * Props:
 *   payload.negotiation_id        - negotiation state tracker ID
 *   payload.cfr_strategy          - { cfr_action_probs, position_strength, exploitability }
 *   payload.drafts                - [{ tone, subject, body, generated_by }]
 *   payload.options               - DI negotiation options
 *   payload.solver_meta           - solver_meta artifact
 *   payload.supplier_kpis         - supplier KPIs
 *   payload.trigger               - 'infeasible' | 'kpi_shortfall'
 *   payload.planRunId             - plan run ID
 *   payload.negotiation_state     - current NegotiationState (from tracker)
 *   onAction                      - (action, details) => void
 */
export default function NegotiationActionCard({ payload = {}, onAction }) {
  const {
    negotiation_id,
    cfr_strategy,
    drafts = [],
    trigger,
    planRunId,
    negotiation_state,
  } = payload;

  const [selectedDraftIndex, setSelectedDraftIndex] = useState(1); // Default to 'persuasion'
  const [editedDrafts, setEditedDrafts] = useState({});
  const [expanded, setExpanded] = useState(true);
  const [actionTaken, setActionTaken] = useState(null);

  const handleEditDraft = useCallback((index, newDraft) => {
    setEditedDrafts((prev) => ({ ...prev, [index]: newDraft }));
  }, []);

  const currentDraft = useMemo(
    () => editedDrafts[selectedDraftIndex] || drafts[selectedDraftIndex],
    [editedDrafts, selectedDraftIndex, drafts]
  );

  const handleAction = useCallback((action) => {
    const draft = currentDraft;
    setActionTaken(action);
    onAction?.(action, {
      negotiation_id,
      draft,
      tone: draft?.tone,
      draftIndex: selectedDraftIndex,
      wasEdited: editedDrafts[selectedDraftIndex] !== undefined,
      planRunId,
      trigger,
    });
  }, [currentDraft, negotiation_id, selectedDraftIndex, editedDrafts, planRunId, trigger, onAction]);

  const triggerLabel = trigger === 'infeasible'
    ? 'Solver INFEASIBLE'
    : 'KPI Shortfall Detected';

  return (
    <div className="rounded-xl border border-purple-300 dark:border-purple-600/50 bg-gradient-to-br from-purple-50/40 via-white to-blue-50/30 dark:from-purple-900/10 dark:via-slate-900/30 dark:to-blue-900/10 border-l-[3px] border-l-[var(--cat-system)] p-4 space-y-4">
      {/* Card header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
            <Shield className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              Strategic Negotiation Copilot
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {triggerLabel}
              {planRunId ? ` · Run #${planRunId}` : ''}
            </div>
          </div>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-1 rounded hover:bg-[var(--accent-hover)] transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
          ) : (
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
          )}
        </button>
      </div>

      {expanded && (
        <>
          {/* Section 1: AI Strategy Insight */}
          <div className="border-t border-purple-200/50 dark:border-purple-700/30 pt-4">
            <StrategyInsightSection cfrStrategy={cfr_strategy} />
          </div>

          {/* Section 1.5: Round History Timeline */}
          {negotiation_state && negotiation_state.action_history?.length > 0 && (
            <div className="border-t border-purple-200/50 dark:border-purple-700/30 pt-4">
              <RoundHistorySection negotiationState={negotiation_state} />
            </div>
          )}

          {/* Section 2: LLM Negotiation Drafts */}
          <div className="border-t border-purple-200/50 dark:border-purple-700/30 pt-4">
            <DraftSection
              drafts={drafts}
              selectedDraftIndex={selectedDraftIndex}
              onSelectDraft={setSelectedDraftIndex}
              editedDrafts={editedDrafts}
              onEditDraft={handleEditDraft}
            />
          </div>

          {/* Section 3: Human Decision */}
          <div className="border-t border-purple-200/50 dark:border-purple-700/30 pt-4">
            {actionTaken ? (
              <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  {actionTaken === 'copy' && 'Draft copied to clipboard.'}
                  {actionTaken === 'sent' && 'Marked as sent — action recorded.'}
                  {actionTaken === 'skip' && 'Round skipped — hold action recorded.'}
                </span>
              </div>
            ) : (
              <DecisionSection
                currentDraft={currentDraft}
                onCopy={() => handleAction('copy')}
                onMarkSent={() => handleAction('sent')}
                onSkip={() => handleAction('skip')}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
