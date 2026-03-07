/**
 * MappingReviewPanel
 *
 * Allows users to review and correct auto-mapped field assignments.
 * Shows confidence badges, sample values, required/optional tags,
 * and dropdown selectors for reassignment.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, HelpCircle, ChevronDown } from 'lucide-react';
import { Card, Badge, Button } from './ui';
import { CONFIDENCE_THRESHOLDS } from '../utils/mappingValidation';

const ConfidenceBadge = ({ confidence, matchType }) => {
  if (confidence >= CONFIDENCE_THRESHOLDS.AUTO_ACCEPT) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 rounded">
        <CheckCircle2 className="w-3 h-3" />
        {Math.round(confidence * 100)}% {matchType}
      </span>
    );
  }
  if (confidence >= CONFIDENCE_THRESHOLDS.NEEDS_REVIEW) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded">
        <AlertTriangle className="w-3 h-3" />
        {Math.round(confidence * 100)}% {matchType}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 rounded">
      <HelpCircle className="w-3 h-3" />
      unmapped
    </span>
  );
};

const SampleValues = ({ values = [] }) => {
  const preview = values.slice(0, 3);
  if (preview.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
      {preview.map(v => String(v)).join(', ')}
      {values.length > 3 && '...'}
    </span>
  );
};

/**
 * @param {object}   props
 * @param {string}   props.sheetName       – Sheet being reviewed
 * @param {string}   props.uploadType      – Detected upload type
 * @param {object}   props.columnMapping   – Current mapping { sourceCol: targetField }
 * @param {object}   props.mappingMeta     – Per-source confidence { sourceCol: { confidence, matchType } }
 * @param {object[]} props.sampleRows      – First few rows for preview
 * @param {object[]} props.schemaFields    – Schema field definitions [{ key, label, required, type }]
 * @param {string[]} props.sourceHeaders   – All source column headers
 * @param {Function} props.onMappingChange – Called with updated { sourceCol: targetField }
 * @param {Function} props.onAcceptAll     – Called when user accepts all mappings
 */
export default function MappingReviewPanel({
  sheetName,
  uploadType,
  columnMapping = {},
  mappingMeta = {},
  sampleRows = [],
  schemaFields = [],
  sourceHeaders = [],
  onMappingChange,
  onAcceptAll,
}) {
  const [localMapping, setLocalMapping] = useState(() => ({ ...columnMapping }));

  // Available target fields (from schema)
  const targetOptions = useMemo(() => {
    const mapped = new Set(Object.values(localMapping).filter(Boolean));
    return schemaFields.map(f => ({
      ...f,
      alreadyMapped: mapped.has(f.key),
    }));
  }, [localMapping, schemaFields]);

  // Count fields needing review
  const reviewCount = useMemo(() => {
    return sourceHeaders.filter(h => {
      const meta = mappingMeta[h];
      return !meta || meta.confidence < CONFIDENCE_THRESHOLDS.AUTO_ACCEPT;
    }).length;
  }, [sourceHeaders, mappingMeta]);

  // Count missing required fields
  const missingRequired = useMemo(() => {
    const mapped = new Set(Object.values(localMapping).filter(Boolean));
    return schemaFields
      .filter(f => f.required && !mapped.has(f.key))
      .map(f => f.key);
  }, [localMapping, schemaFields]);

  const handleFieldChange = useCallback((sourceCol, newTarget) => {
    const updated = { ...localMapping };
    if (newTarget === '') {
      delete updated[sourceCol];
    } else {
      // Remove old mapping to this target (prevent duplicates)
      for (const [src, tgt] of Object.entries(updated)) {
        if (tgt === newTarget && src !== sourceCol) {
          delete updated[src];
        }
      }
      updated[sourceCol] = newTarget;
    }
    setLocalMapping(updated);
    onMappingChange?.(updated);
  }, [localMapping, onMappingChange]);

  const handleAcceptAll = useCallback(() => {
    onAcceptAll?.(localMapping);
  }, [localMapping, onAcceptAll]);

  // Build rows for the review table
  const rows = useMemo(() => {
    return sourceHeaders.map(header => {
      const target = localMapping[header] || '';
      const meta = mappingMeta[header] || {};
      const confidence = meta.confidence ?? 0;
      const matchType = meta.matchType ?? 'none';
      const values = sampleRows.map(row => row[header]).filter(v => v !== undefined && v !== null && v !== '');
      const targetField = schemaFields.find(f => f.key === target);

      return {
        header,
        target,
        confidence,
        matchType,
        isRequired: targetField?.required || false,
        sampleValues: values,
        needsReview: confidence < CONFIDENCE_THRESHOLDS.AUTO_ACCEPT,
      };
    });
  }, [sourceHeaders, localMapping, mappingMeta, sampleRows, schemaFields]);

  return (
    <Card className="w-full border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/10">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-semibold text-sm">Column Mapping Review</h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Sheet: <strong>{sheetName}</strong> &rarr; {uploadType}
              {reviewCount > 0 && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  ({reviewCount} field{reviewCount !== 1 ? 's' : ''} need review)
                </span>
              )}
            </p>
          </div>
          <Button
            variant="primary"
            className="text-xs px-3 py-1"
            onClick={handleAcceptAll}
            disabled={missingRequired.length > 0}
            title={missingRequired.length > 0 ? `Missing required: ${missingRequired.join(', ')}` : 'Accept all mappings'}
          >
            Accept All
          </Button>
        </div>

        {missingRequired.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Missing required fields: <strong>{missingRequired.join(', ')}</strong>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-slate-200 dark:border-slate-700">
            <thead className="bg-slate-100 dark:bg-slate-700">
              <tr>
                <th className="px-2 py-1.5 text-left">Source Column</th>
                <th className="px-2 py-1.5 text-left">Target Field</th>
                <th className="px-2 py-1.5 text-left">Confidence</th>
                <th className="px-2 py-1.5 text-left">Type</th>
                <th className="px-2 py-1.5 text-left">Sample Values</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.header}
                  className={`border-t border-slate-200 dark:border-slate-700 ${row.needsReview ? 'bg-amber-50/50 dark:bg-amber-900/5' : ''}`}
                >
                  <td className="px-2 py-1.5 font-mono">{row.header}</td>
                  <td className="px-2 py-1.5">
                    <div className="relative inline-block">
                      <select
                        value={row.target}
                        onChange={(e) => handleFieldChange(row.header, e.target.value)}
                        className="appearance-none bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded px-2 py-0.5 pr-6 text-xs focus:ring-1 focus:ring-indigo-400 focus:outline-none"
                      >
                        <option value="">(unmapped)</option>
                        {targetOptions.map(opt => (
                          <option
                            key={opt.key}
                            value={opt.key}
                            disabled={opt.alreadyMapped && opt.key !== row.target}
                          >
                            {opt.key} {opt.required ? '*' : ''} {opt.alreadyMapped && opt.key !== row.target ? '(used)' : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                    </div>
                    {row.isRequired && (
                      <Badge type="danger" className="ml-1 text-[9px]">required</Badge>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <ConfidenceBadge confidence={row.confidence} matchType={row.matchType} />
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {schemaFields.find(f => f.key === row.target)?.type || '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    <SampleValues values={row.sampleValues} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
