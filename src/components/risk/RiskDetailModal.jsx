import { X, Zap, GitBranch, Package, Clock, DollarSign, TrendingUp, History, Box, CheckCircle, Loader2, ChevronRight, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import Button from '../ui/Button';
import { supabase } from '../../services/supabaseClient';
import AuditTimeline from './AuditTimeline';
import { simulateWhatIfExpedite } from '../../domains/risk/whatIfExpedite';

/**
 * Single BOM edge row — shows material code, qty/UOM, scrap rate, alt group.
 * direction: 'up' (where-used) | 'down' (component)
 */
function BomEdgeRow({ direction, edge, labelField }) {
  const material = edge[labelField];
  const scrap = edge.scrap_rate ? `${(edge.scrap_rate * 100).toFixed(1)}% scrap` : null;
  const altGroup = edge.alt_group ? `Alt ${edge.alt_group}` : null;

  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
      <ChevronRight
        className={`w-4 h-4 flex-shrink-0 ${direction === 'up' ? 'rotate-180 text-orange-400' : 'text-blue-400'}`}
      />
      <span className="flex-1 text-sm font-medium text-slate-900 dark:text-slate-100 font-mono">{material}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">
        ×{edge.qty_per ?? 1} {edge.uom || 'pcs'}
      </span>
      {scrap && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
          {scrap}
        </span>
      )}
      {altGroup && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">
          {altGroup}
        </span>
      )}
    </div>
  );
}

/**
 * RiskDetailModal Component
 * Drawer/Modal for displaying risk details
 * 
 * Desktop: Right-side drawer (480px width)
 * Mobile: Full-screen modal
 * 
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether modal is open
 * @param {Function} props.onClose - Close callback
 * @param {Object} props.riskData - Risk data to display
 * @param {Object} props.user - Current user
 * @param {number} props.horizonDays - Horizon in days
 * @param {Object} props.activeForecastRun - Active forecast run
 * @param {Object} props.probSeries - Probability series data
 * @param {Function} props.loadProbSeriesForKey - Function to load probability series
 * @param {boolean} props.hasProbResults - Whether probability results exist
 * @param {Object} props.revenueState - Revenue state data
 * @param {Object} props.riskScoreData - Risk score data
 * @param {Object} props.replayDraft - Replay draft data
 */
export default function RiskDetailModal({
  isOpen,
  onClose,
  riskData,
  _user,
  _horizonDays,
  _activeForecastRun,
  _probSeries,
  _loadProbSeriesForKey,
  hasProbResults,
  _revenueState,
  _riskScoreData,
  _replayDraft,
  onExpedite,
  onSubstitute,
}) {
  const [activeTab, setActiveTab] = useState('inventory');
  const [actionFeedback, setActionFeedback] = useState(null);

  // Substitute panel state
  const [substituteLoading, setSubstituteLoading] = useState(false);
  const [substituteGroups, setSubstituteGroups] = useState(null); // null = not yet queried

  // BOM Trace state
  const [bomLoading, setBomLoading] = useState(false);
  const [bomError, setBomError] = useState(null);
  const [bomParents, setBomParents] = useState([]);   // where-used: this item is child_material
  const [bomChildren, setBomChildren] = useState([]); // components: this item is parent_material

  // Audit Timeline state
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);
  const [auditEvents, setAuditEvents] = useState([]);

  useEffect(() => {
    if (activeTab !== 'audit' || !riskData?.item) return;
    let cancelled = false;

    async function fetchAuditEvents() {
      setAuditLoading(true);
      setAuditError(null);

      // key format used by audit_events: "MATERIAL|PLANT"
      const key = `${riskData.item}|${riskData.plantId}`;

      const { data, error } = await supabase
        .from('audit_events')
        .select('id, event_type, key, payload, created_at, bom_run_id')
        .eq('key', key)
        .order('created_at', { ascending: false })
        .limit(50);

      if (cancelled) return;

      if (error) {
        setAuditError(error.message);
      } else {
        setAuditEvents(data || []);
      }
      setAuditLoading(false);
    }

    fetchAuditEvents();
    return () => { cancelled = true; };
  }, [activeTab, riskData?.item, riskData?.plantId]);

  useEffect(() => {
    if (activeTab !== 'bom' || !riskData?.item) return;
    let cancelled = false;

    async function fetchBomTrace() {
      setBomLoading(true);
      setBomError(null);

      const material = riskData.item;
      const plantId = riskData.plantId;

      // Where-used: this material appears as child_material
      let parentQuery = supabase
        .from('bom_edges')
        .select('parent_material, child_material, qty_per, uom, scrap_rate, yield_rate, plant_id, bom_version, alt_group, priority')
        .eq('child_material', material);
      if (plantId) parentQuery = parentQuery.eq('plant_id', plantId);

      // Components: this material appears as parent_material
      let childQuery = supabase
        .from('bom_edges')
        .select('parent_material, child_material, qty_per, uom, scrap_rate, yield_rate, plant_id, bom_version, alt_group, priority')
        .eq('parent_material', material);
      if (plantId) childQuery = childQuery.eq('plant_id', plantId);

      const [{ data: parents, error: parentsErr }, { data: children, error: childrenErr }] =
        await Promise.all([parentQuery, childQuery]);

      if (cancelled) return;

      if (parentsErr || childrenErr) {
        setBomError((parentsErr || childrenErr).message);
      } else {
        setBomParents(parents || []);
        setBomChildren(children || []);
      }
      setBomLoading(false);
    }

    fetchBomTrace();
    return () => { cancelled = true; };
  }, [activeTab, riskData?.item, riskData?.plantId]);

  if (!isOpen || !riskData) return null;

  // Status configuration
  const getStatusConfig = (riskLevel) => {
    const configs = {
      critical: {
        label: 'Critical',
        bgColor: 'bg-red-100 dark:bg-red-900/30',
        textColor: 'text-red-700 dark:text-red-400',
        borderColor: 'border-red-500',
        iconColor: 'text-red-600 dark:text-red-400'
      },
      warning: {
        label: 'Warning',
        bgColor: 'bg-orange-100 dark:bg-orange-900/30',
        textColor: 'text-orange-700 dark:text-orange-400',
        borderColor: 'border-orange-400',
        iconColor: 'text-orange-600 dark:text-orange-400'
      },
      ok: {
        label: 'OK',
        bgColor: 'bg-green-100 dark:bg-green-900/30',
        textColor: 'text-green-700 dark:text-green-400',
        borderColor: 'border-green-400',
        iconColor: 'text-green-600 dark:text-green-400'
      }
    };
    return configs[riskLevel?.toLowerCase()] || configs.ok;
  };

  const statusConfig = getStatusConfig(riskData.riskLevel);

  // Format currency
  const formatCurrency = (value, currency = 'USD') => {
    if (!value || value === 0) return '$0';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0
    }).format(value);
  };

  // Format number
  const formatNumber = (value) => {
    if (!value && value !== 0) return '—';
    return value.toLocaleString();
  };

  const showFeedback = (type, message) => {
    setActionFeedback({ type, message });
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const handleExpedite = () => {
    if (onExpedite) {
      onExpedite(riskData);
      return;
    }
    const result = simulateWhatIfExpedite({
      poLines: riskData.poDetails || [],
      rowContext: riskData,
      expediteBuckets: 1,
      horizonBuckets: 3,
    });
    if (!result.success) {
      showFeedback('expedite', `Cannot expedite: ${result.reason || 'no inbound PO found'}`);
      return;
    }
    const deltaGap = result.delta?.gapQty ?? 0;
    const deltaDays = result.delta?.daysToStockout ?? 0;
    const msg = deltaGap < 0
      ? `Expedite by 1 bucket: gap improves by ${Math.abs(deltaGap)} units, coverage +${deltaDays} days`
      : `Expedite shifts earliest inbound — gap unchanged within horizon (${deltaDays >= 0 ? '+' : ''}${deltaDays} days)`;
    showFeedback('expedite', msg);
  };

  const handleSubstitute = async () => {
    if (onSubstitute) {
      onSubstitute(riskData);
      return;
    }
    // Reset and show loading panel
    setSubstituteGroups(null);
    setSubstituteLoading(true);
    try {
      // Step 1: find parent edges where this item has an alt_group
      const { data: parentEdges, error: e1 } = await supabase
        .from('bom_edges')
        .select('parent_material, alt_group')
        .eq('child_material', riskData.item)
        .not('alt_group', 'is', null);
      if (e1) throw e1;

      if (!parentEdges?.length) {
        setSubstituteGroups([]);
        return;
      }

      // Step 2: for each parent+alt_group, find sibling children (substitutes)
      const groups = [];
      for (const edge of parentEdges) {
        const { data: siblings, error: e2 } = await supabase
          .from('bom_edges')
          .select('child_material, qty_per, uom, priority')
          .eq('parent_material', edge.parent_material)
          .eq('alt_group', edge.alt_group)
          .neq('child_material', riskData.item);
        if (e2) throw e2;
        if (siblings?.length) {
          groups.push({ parent: edge.parent_material, altGroup: edge.alt_group, substitutes: siblings });
        }
      }
      setSubstituteGroups(groups);
    } catch (err) {
      console.error('[RiskDetailModal] Substitute query failed:', err);
      setSubstituteGroups([]);
    } finally {
      setSubstituteLoading(false);
    }
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Container */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] bg-white dark:bg-slate-900 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col">
        
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-200 dark:border-slate-700">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusConfig.bgColor} ${statusConfig.textColor}`}>
                {statusConfig.label}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {riskData.plantId}
              </span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate">
              {riskData.item || '(unknown)'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {riskData.description || '—'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors ml-2"
          >
            <X className="w-5 h-5 text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Financial Summary */}
        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">Profit at Risk</p>
              <p className={`text-2xl font-bold ${statusConfig.iconColor}`}>
                {formatCurrency(riskData.profitAtRisk, riskData.currency)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500 dark:text-slate-400">Risk Score</p>
              <p className="text-lg font-semibold text-purple-600 dark:text-purple-400">
                {riskData.riskScore?.toLocaleString() || '—'}
              </p>
            </div>
          </div>
          
          {/* Revenue at Risk Row */}
          {(riskData.revMarginAtRisk || riskData.revPenaltyAtRisk || riskData.revTotalAtRisk) && (
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
              {riskData.revMarginAtRisk > 0 && (
                <div className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Margin:</span>
                  <span className="ml-1 font-medium text-rose-600 dark:text-rose-400">
                    ${riskData.revMarginAtRisk.toLocaleString()}
                  </span>
                </div>
              )}
              {riskData.revPenaltyAtRisk > 0 && (
                <div className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Penalty:</span>
                  <span className="ml-1 font-medium text-orange-600 dark:text-orange-400">
                    ${riskData.revPenaltyAtRisk.toLocaleString()}
                  </span>
                </div>
              )}
              {riskData.revTotalAtRisk > 0 && (
                <div className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Total:</span>
                  <span className="ml-1 font-medium text-red-600 dark:text-red-400">
                    ${riskData.revTotalAtRisk.toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700">
          {[
            { id: 'inventory', label: 'Inventory Status', icon: Package },
            { id: 'bom', label: 'BOM Trace', icon: Box },
            { id: 'audit', label: 'Audit', icon: History }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/20'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          
          {/* Inventory Tab */}
          {activeTab === 'inventory' && (
            <div className="space-y-6">
              {/* Key Metrics Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <Package className="w-4 h-4" />
                    <span className="text-xs">Net Available</span>
                  </div>
                  <p className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                    {formatNumber(riskData.netAvailable)}
                  </p>
                </div>
                
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <TrendingUp className="w-4 h-4" />
                    <span className="text-xs">Gap Qty</span>
                  </div>
                  <p className={`text-xl font-semibold ${riskData.gapQty > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
                    {formatNumber(riskData.gapQty)}
                  </p>
                </div>
                
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <Clock className="w-4 h-4" />
                    <span className="text-xs">Days to Stockout</span>
                  </div>
                  <p className={`text-xl font-semibold ${
                    riskData.daysToStockout === null ? 'text-slate-400 dark:text-slate-500' :
                    riskData.daysToStockout <= 0 ? 'text-red-600 dark:text-red-400' :
                    riskData.daysToStockout < 7 ? 'text-orange-600 dark:text-orange-400' :
                    'text-green-600 dark:text-green-400'
                  }`}>
                    {riskData.daysToStockout === null ? '—' :
                     riskData.daysToStockout <= 0 ? 'Stockout' :
                     `${riskData.daysToStockout} days`}
                  </p>
                </div>
                
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
                    <DollarSign className="w-4 h-4" />
                    <span className="text-xs">Next Bucket</span>
                  </div>
                  <p className="text-xl font-semibold text-slate-900 dark:text-slate-100 font-mono">
                    {riskData.nextTimeBucket || '—'}
                  </p>
                </div>
              </div>

              {/* Probabilistic Data */}
              {hasProbResults && riskData.pStockout !== undefined && (
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                  <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3">
                    Probabilistic Forecast
                  </h4>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">P(Stockout)</p>
                      <p className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                        {(riskData.pStockout * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">Stockout P50</p>
                      <p className="text-lg font-semibold text-blue-900 dark:text-blue-100 font-mono">
                        {riskData.stockoutBucketP50 || '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">Stockout P90</p>
                      <p className="text-lg font-semibold text-blue-900 dark:text-blue-100 font-mono">
                        {riskData.stockoutBucketP90 || '—'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Supply Breakdown */}
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
                  Supply Breakdown
                </h4>
                <div className="space-y-2">
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">On Hand</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.onHand)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Open PO</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.openPO)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Inbound (Horizon)</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.inboundQty)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Total Demand</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(riskData.totalDemand)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Net Available</span>
                    <span className={`text-sm font-bold ${riskData.netAvailable < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
                      {formatNumber(riskData.netAvailable)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* BOM Tab */}
          {activeTab === 'bom' && (
            <div className="space-y-5">
              {bomLoading && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500 mr-2" />
                  <span className="text-sm text-slate-500 dark:text-slate-400">Loading BOM trace…</span>
                </div>
              )}

              {bomError && (
                <div className="flex items-start gap-2 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Failed to load BOM: {bomError}</span>
                </div>
              )}

              {!bomLoading && !bomError && (
                <>
                  {/* Where-Used section */}
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                      Where Used — {riskData.item} is a component of
                    </h4>
                    {bomParents.length === 0 ? (
                      <p className="text-sm text-slate-400 dark:text-slate-500 italic">No parent materials found.</p>
                    ) : (
                      <div className="space-y-1">
                        {bomParents.map((edge, i) => (
                          <BomEdgeRow key={i} direction="up" edge={edge} labelField="parent_material" />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-slate-200 dark:border-slate-700" />

                  {/* Components section */}
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                      Components — {riskData.item} is made of
                    </h4>
                    {bomChildren.length === 0 ? (
                      <p className="text-sm text-slate-400 dark:text-slate-500 italic">No child components found.</p>
                    ) : (
                      <div className="space-y-1">
                        {bomChildren.map((edge, i) => (
                          <BomEdgeRow key={i} direction="down" edge={edge} labelField="child_material" />
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Audit Tab */}
          {activeTab === 'audit' && (
            <div className="space-y-3">
              {auditError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Failed to load audit events: {auditError}</span>
                </div>
              )}
              <div className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                key: {riskData.item}|{riskData.plantId}
              </div>
              <AuditTimeline
                events={auditEvents}
                loading={auditLoading}
                onReplay={onExpedite ? (event) => onExpedite({ ...riskData, _replayEvent: event }) : undefined}
              />
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          {actionFeedback && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg text-sm text-blue-700 dark:text-blue-300">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              {actionFeedback.message}
            </div>
          )}

          {/* Substitute results panel */}
          {(substituteLoading || substituteGroups !== null) && (
            <div className="mb-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                <GitBranch className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Substitute Materials (Alt Group)</span>
                <button
                  onClick={() => setSubstituteGroups(null)}
                  className="ml-auto text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {substituteLoading ? (
                <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Querying BOM alt groups…
                </div>
              ) : substituteGroups?.length === 0 ? (
                <p className="px-3 py-3 text-sm text-slate-400 dark:text-slate-500 italic">
                  No substitutes found — no alt_group entries in BOM for {riskData.item}.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-40 overflow-y-auto">
                  {substituteGroups.map((group, gi) => (
                    <div key={gi} className="px-3 py-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                        Parent: <span className="font-mono font-medium text-slate-700 dark:text-slate-300">{group.parent}</span>
                        {' · '}Alt Group: <span className="font-mono font-medium text-purple-600 dark:text-purple-400">{group.altGroup}</span>
                      </p>
                      <div className="space-y-0.5">
                        {group.substitutes.map((s, si) => (
                          <div key={si} className="flex items-center gap-2 text-sm">
                            <GitBranch className="w-3 h-3 text-blue-400 flex-shrink-0" />
                            <span className="font-mono text-slate-800 dark:text-slate-200">{s.child_material}</span>
                            <span className="text-xs text-slate-400">×{s.qty_per ?? 1} {s.uom || 'pcs'}</span>
                            {s.priority != null && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                                P{s.priority}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <Button
              onClick={handleExpedite}
              variant="primary"
              icon={Zap}
              className="flex-1"
            >
              Simulate Expedite
            </Button>
            <Button
              onClick={handleSubstitute}
              disabled={substituteLoading}
              variant="outline"
              icon={GitBranch}
              className="flex-1"
            >
              {substituteLoading ? 'Loading…' : 'View Substitutes'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
