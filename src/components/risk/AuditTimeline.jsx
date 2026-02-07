import React, { useState } from 'react';
import { Clock, Database, Calculator, Zap, ChevronDown, ChevronUp, RotateCcw, Eye, Copy, Check } from 'lucide-react';
import { Card, Badge } from '../ui';

/**
 * AuditTimeline - Display audit events timeline for Risk Dashboard
 * M7.3 WP3: Audit Trail and Replay
 * 
 * Props:
 * - events: Array of audit events
 * - loading: boolean
 * - onView: (event) => void - View event details
 * - onReplay: (event) => void - Replay what-if scenario (only for what_if_executed)
 */

const EVENT_TYPE_ICONS = {
  inventory_prob_ran: { icon: Database, color: 'text-blue-500', bg: 'bg-blue-50', label: 'Probabilistic MC' },
  risk_score_calculated: { icon: Calculator, color: 'text-purple-500', bg: 'bg-purple-50', label: 'Risk Score' },
  what_if_executed: { icon: Zap, color: 'text-amber-500', bg: 'bg-amber-50', label: 'What-if' }
};

const formatTime = (isoString) => {
  const date = new Date(isoString);
  return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
};

const formatDate = (isoString) => {
  const date = new Date(isoString);
  return date.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
};

const AuditEventCard = ({ event, onView, onReplay }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const config = EVENT_TYPE_ICONS[event.event_type] || { 
    icon: Clock, 
    color: 'text-slate-500', 
    bg: 'bg-slate-50',
    label: event.event_type 
  };
  const Icon = config.icon;
  
  const isWhatIf = event.event_type === 'what_if_executed';
  const key = event.key || event.payload?.outputs?.top_key || '-';
  
  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(event.payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <div className="border-l-2 border-slate-200 dark:border-slate-700 pl-4 py-2 relative">
      {/* Timeline dot */}
      <div className={`absolute -left-1.5 top-3 w-3 h-3 rounded-full ${config.bg} ${config.color} border-2 border-white dark:border-slate-800`}>
        <Icon className="w-2 h-2" />
      </div>
      
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.bg} ${config.color}`}>
            <Icon className="w-3 h-3" />
            {config.label}
          </span>
          <span className="text-xs text-slate-400">{key}</span>
        </div>
        <div className="text-xs text-slate-400 text-right">
          <div>{formatTime(event.created_at)}</div>
          <div>{formatDate(event.created_at)}</div>
        </div>
      </div>
      
      {/* Summary */}
      <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        {event.payload?.outputs?.kpis && (
          <div className="flex gap-3 text-xs">
            {event.payload.outputs.kpis.avgPStockout !== undefined && (
              <span>P(stockout): {(event.payload.outputs.kpis.avgPStockout * 100).toFixed(1)}%</span>
            )}
            {event.payload.outputs.kpis.keysAtRisk !== undefined && (
              <span>Keys at risk: {event.payload.outputs.kpis.keysAtRisk}</span>
            )}
            {event.payload.outputs.roi !== undefined && (
              <span className={event.payload.outputs.roi > 0 ? 'text-green-600' : 'text-red-600'}>
                ROI: {event.payload.outputs.roi > 0 ? '+' : ''}{event.payload.outputs.roi.toFixed(2)}
              </span>
            )}
          </div>
        )}
      </div>
      
      {/* Actions */}
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? 'Hide' : 'Details'}
        </button>
        
        {isWhatIf && onReplay && (
          <button
            onClick={() => onReplay(event)}
            className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" />
            Replay
          </button>
        )}
        
        {onView && (
          <button
            onClick={() => onView(event)}
            className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
          >
            <Eye className="w-3 h-3" />
            View
          </button>
        )}
      </div>
      
      {/* Expanded payload */}
      {expanded && (
        <div className="mt-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-medium text-slate-500">Payload</span>
            <button
              onClick={handleCopy}
              className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy JSON'}
            </button>
          </div>
          <pre className="text-xs text-slate-600 dark:text-slate-400 overflow-auto max-h-48 whitespace-pre-wrap">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

const AuditTimeline = ({ 
  events = [], 
  loading = false, 
  onView, 
  onReplay,
  filter = 'all' // 'all' | 'prob' | 'risk' | 'whatif'
}) => {
  const filteredEvents = filter === 'all' 
    ? events 
    : events.filter(e => {
        if (filter === 'prob') return e.event_type === 'inventory_prob_ran';
        if (filter === 'risk') return e.event_type === 'risk_score_calculated';
        if (filter === 'whatif') return e.event_type === 'what_if_executed';
        return true;
      });
  
  if (loading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-slate-500">
          <Clock className="w-4 h-4 animate-pulse" />
          <span className="text-sm">Loading audit events...</span>
        </div>
      </Card>
    );
  }
  
  if (filteredEvents.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-center text-slate-500">
          <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No audit events found</p>
          <p className="text-xs mt-1">Run Probabilistic MC, Risk Score, or What-if to generate events</p>
        </div>
      </Card>
    );
  }
  
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-600" />
          <h3 className="font-semibold text-slate-700 dark:text-slate-300">Audit Timeline</h3>
          <Badge variant="secondary" className="text-xs">{filteredEvents.length}</Badge>
        </div>
      </div>
      
      <div className="space-y-0 max-h-96 overflow-y-auto">
        {filteredEvents.map((event, index) => (
          <AuditEventCard 
            key={event.id || index} 
            event={event} 
            onView={onView}
            onReplay={onReplay}
          />
        ))}
      </div>
    </Card>
  );
};

export default AuditTimeline;
