/**
 * AnalysisInsightCard.jsx
 *
 * Professional AI-generated analysis report card (v2).
 * Renders structured insight with inline citations, risk alerts,
 * deep dive buttons, and AI model attribution.
 *
 * Payload shape:
 *   { analysisType, sections: { executive_summary, key_findings[], risk_alerts[], recommendations[], data_sources[] },
 *     deepDives: [{ id, label, query }], model, provider, generatedAt, rawMarkdown? }
 */

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, BrainCircuit, Lightbulb, Target, AlertTriangle, Database, Search } from 'lucide-react';

export default function AnalysisInsightCard({ payload, onDeepDive }) {
  const [expandedSources, setExpandedSources] = useState(false);

  if (!payload) return null;
  const { analysisType, sections = {}, deepDives = [], model, provider, generatedAt } = payload;

  const modelLabel = model
    ? `${provider ? provider + ' / ' : ''}${model}`
    : 'AI';

  // ── Citation renderer — small inline superscript style ──────────────────
  const renderCitation = (text) => {
    if (!text) return null;
    // Match both [metric = value] and 【Data: metric = value】 formats
    const parts = text.split(/(\[([^\]]+)\]|【Data:[^】]+】)/g);
    return parts.map((part, i) => {
      if (!part) return null;
      if (part.startsWith('【Data:')) {
        const cite = part.slice(6, -1).trim();
        return (
          <sup key={i} className="text-[9px] text-blue-400 dark:text-blue-500 font-mono ml-0.5" title={cite}>
            [{cite}]
          </sup>
        );
      }
      if (part.startsWith('[') && part.endsWith(']') && part.includes('=')) {
        const cite = part.slice(1, -1).trim();
        return (
          <sup key={i} className="text-[9px] text-blue-400 dark:text-blue-500 font-mono ml-0.5" title={cite}>
            [{cite}]
          </sup>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  // ── Section renderers ──────────────────────────────────────────────────
  const renderExecutiveSummary = (content) => {
    if (!content) return null;
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <BrainCircuit className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
          <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">Executive Summary</h4>
        </div>
        <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed pl-5">
          {content}
        </p>
      </div>
    );
  };

  const renderBulletSection = (items, label, Icon, colorClass) => {
    if (!items?.length) return null;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${colorClass}`} />
          <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">{label}</h4>
        </div>
        <ul className="space-y-1 pl-5">
          {items.map((item, i) => (
            <li key={i} className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex items-start gap-1.5">
              <span className={`mt-0.5 shrink-0 ${colorClass}`}>▸</span>
              <span>{renderCitation(item)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const renderRiskAlerts = (alerts) => {
    if (!alerts?.length) return null;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-orange-500 dark:text-orange-400" />
          <h4 className="text-[11px] font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wide">Risk Alerts</h4>
        </div>
        <div className="space-y-1 pl-5">
          {alerts.map((alert, i) => (
            <div key={i} className="text-xs text-orange-700 dark:text-orange-300 leading-relaxed flex items-start gap-1.5 bg-orange-50/60 dark:bg-orange-900/20 rounded px-2 py-1 border border-orange-100 dark:border-orange-800/40">
              <span className="mt-0.5 shrink-0">⚠</span>
              <span>{renderCitation(alert)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderDataSources = (sources) => {
    if (!sources?.length) return null;
    return (
      <div className="border-t border-slate-100 dark:border-slate-700 pt-2">
        <button
          onClick={() => setExpandedSources(!expandedSources)}
          className="flex items-center gap-1 text-[10px] font-medium text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          <Database className="w-3 h-3" />
          Sources ({sources.length})
          {expandedSources ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {expandedSources && (
          <ul className="mt-1 space-y-0.5 pl-4">
            {sources.map((src, i) => (
              <li key={i} className="text-[10px] text-slate-400 dark:text-slate-500">• {src}</li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderDeepDives = () => {
    if (!deepDives?.length) return null;
    return (
      <div className="border-t border-purple-100 dark:border-purple-800/50 pt-3 px-4 pb-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Search className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
          <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">Suggested Deep Dives</h4>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {deepDives.map((dd) => (
            <button
              key={dd.id}
              onClick={() => onDeepDive?.(dd)}
              className="text-[11px] px-2.5 py-1 rounded-lg border border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors text-left leading-snug"
            >
              {dd.label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // ── Structured sections render ─────────────────────────────────────────
  const hasStructuredSections = sections.executive_summary || sections.key_findings;

  // Fallback: raw markdown in card frame
  if (!hasStructuredSections && payload.rawMarkdown) {
    return (
      <div className="w-full rounded-xl border border-purple-200 dark:border-purple-800 bg-gradient-to-br from-purple-50/60 to-white dark:from-purple-950/20 dark:to-gray-900 shadow-sm overflow-hidden">
        <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-purple-100 dark:border-purple-800/50">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-purple-100 dark:bg-purple-900/50">
              <BrainCircuit className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">AI Analysis Report</h3>
          </div>
          <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">{modelLabel}</span>
        </div>
        <div className="px-4 py-3 prose prose-xs dark:prose-invert max-w-none text-xs leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.rawMarkdown}</ReactMarkdown>
        </div>
        {renderDeepDives()}
        <div className="px-4 pb-2 text-[10px] text-slate-400 dark:text-slate-500">
          {modelLabel} • {generatedAt || new Date().toLocaleString()}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full rounded-xl border border-purple-200 dark:border-purple-800 bg-gradient-to-br from-purple-50/60 to-white dark:from-purple-950/20 dark:to-gray-900 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-purple-100 dark:border-purple-800/50">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-purple-100 dark:bg-purple-900/50">
            <BrainCircuit className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">AI Analysis Report</h3>
        </div>
        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">{modelLabel} • {generatedAt || ''}</span>
      </div>

      {/* Sections */}
      <div className="px-4 py-3 space-y-3">
        {renderExecutiveSummary(sections.executive_summary)}
        {renderBulletSection(sections.key_findings, 'Key Findings', Lightbulb, 'text-blue-500 dark:text-blue-400')}
        {renderRiskAlerts(sections.risk_alerts)}
        {renderBulletSection(sections.recommendations, 'Recommendations', Target, 'text-emerald-500 dark:text-emerald-400')}
        {renderDataSources(sections.data_sources)}
      </div>

      {/* Deep Dive Buttons */}
      {renderDeepDives()}
    </div>
  );
}
