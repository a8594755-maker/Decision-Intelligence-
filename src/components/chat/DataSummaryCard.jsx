import React, { useMemo } from 'react';
import { CheckCircle2, AlertTriangle, Lock, Info } from 'lucide-react';
import { Card, Button, Badge } from '../ui';
import { evaluateCapabilities } from '../../config/capabilityMatrix';

const formatPct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

const IGNORED_SHEET_PATTERN = /^(readme|assumptions?|instructions?|guide|notes?|docs?|changelog|cover\s*sheet|template\s*notes?)$/i;

/**
 * Map capability keys to action button groups.
 */
const BUTTON_CAPABILITY_MAP = {
  forecast: ['forecast'],
  workflowA: ['basic_plan', 'inbound_aware_plan'],
  risk: ['shortage_risk', 'supplier_risk'],
};

/**
 * Derive button readiness from capability matrix evaluation.
 */
function computeReadiness(sheets = []) {
  // Build available datasets from sheets
  const availableDatasets = sheets
    .filter(s => s.upload_type && s.upload_type !== 'unknown' && !IGNORED_SHEET_PATTERN.test(s.sheet_name || ''))
    .map(s => ({
      type: s.upload_type,
      fields: s.mapped_fields || s.matched_fields || [],
    }));

  const capabilities = evaluateCapabilities(availableDatasets);

  // Map to button readiness
  const buttonReadiness = {};
  for (const [btnKey, capKeys] of Object.entries(BUTTON_CAPABILITY_MAP)) {
    const relevant = capKeys.map(k => capabilities[k]).filter(Boolean);
    const anyAvailable = relevant.some(c => c.available);
    const allMissing = relevant
      .filter(c => !c.available)
      .flatMap(c => c.missingDatasets);
    buttonReadiness[btnKey] = {
      ready: anyAvailable,
      missing: [...new Set(allMissing)],
    };
  }

  return { buttonReadiness, capabilities };
}

function ReadinessHint({ missing }) {
  if (!missing || missing.length === 0) return null;
  return (
    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
      Missing: {missing.join(', ')}
    </p>
  );
}

function CapabilityIndicator({ capabilities }) {
  if (!capabilities) return null;
  const entries = Object.entries(capabilities);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {entries.map(([key, cap]) => {
        const colors = {
          full: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
          partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
          unavailable: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
        };
        const icons = {
          full: <CheckCircle2 className="w-3 h-3" />,
          partial: <Info className="w-3 h-3" />,
          unavailable: <Lock className="w-3 h-3" />,
        };
        const tooltip = cap.level === 'unavailable'
          ? `Upload ${cap.missingDatasets.join(', ')} to unlock`
          : cap.level === 'partial'
            ? `Optional: ${cap.optionalMissing.join(', ')}`
            : 'All data available';

        return (
          <span
            key={key}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[cap.level]}`}
            title={tooltip}
          >
            {icons[cap.level]} {cap.label}
          </span>
        );
      })}
    </div>
  );
}

export default function DataSummaryCard({
  payload,
  onUseContext,
  isContextSelected = false,
  onRunForecast,
  isForecastRunning = false,
  onRunWorkflow,
  isWorkflowRunning = false,
  onRunRisk,
  isRiskRunning = false
}) {
  const workflow = payload?.workflow_guess || {};
  const timeRange = payload?.time_range_guess || {};
  const minimalQuestions = Array.isArray(payload?.minimal_questions) ? payload.minimal_questions : [];
  const profileId = payload?.dataset_profile_id;

  const { buttonReadiness, capabilities, sheets } = useMemo(() => {
    const s = Array.isArray(payload?.sheets) ? payload.sheets : [];
    if (!payload) return { buttonReadiness: {}, capabilities: {}, sheets: s };
    const result = computeReadiness(s);
    return { ...result, sheets: s };
  }, [payload]);

  if (!payload) return null;
  const readiness = {
    forecast: buttonReadiness.forecast || { ready: false, missing: [] },
    workflowA: buttonReadiness.workflowA || { ready: false, missing: [] },
    risk: buttonReadiness.risk || { ready: false, missing: [] },
  };
  const ignoredSheets = sheets.filter(s => IGNORED_SHEET_PATTERN.test(s.sheet_name || ''));

  return (
    <Card className="w-full border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/10">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm">Data Summary Card</h4>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Workflow guess: <strong>{workflow.label || 'unknown'}</strong> ({formatPct(workflow.confidence)})
            </p>
            <p className="text-xs text-slate-500">
              Time range: {timeRange.start || 'unknown'} to {timeRange.end || 'unknown'}
            </p>
            {workflow.reason && (
              <p className="text-xs text-slate-500">{workflow.reason}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge type="info">Profile #{profileId || 'N/A'}</Badge>
            <Button
              variant={isContextSelected ? 'secondary' : 'primary'}
              className="text-xs px-3 py-1"
              onClick={() => onUseContext?.(payload)}
            >
              {isContextSelected ? 'Context Selected' : 'Use this dataset context'}
            </Button>
            <div className="flex flex-col items-start gap-0">
              <Button
                variant="secondary"
                className="text-xs px-3 py-1"
                disabled={isForecastRunning || !readiness.forecast.ready}
                title={!readiness.forecast.ready ? `Missing: ${readiness.forecast.missing.join(', ')}` : undefined}
                onClick={() => onRunForecast?.(payload)}
              >
                {isForecastRunning ? 'Running Forecast...' : 'Run Forecast'}
              </Button>
              <ReadinessHint missing={!isForecastRunning ? readiness.forecast.missing : []} />
            </div>
            <div className="flex flex-col items-start gap-0">
              <Button
                variant="secondary"
                className="text-xs px-3 py-1"
                disabled={isWorkflowRunning || !readiness.workflowA.ready}
                title={!readiness.workflowA.ready ? `Missing: ${readiness.workflowA.missing.join(', ')}` : undefined}
                onClick={() => onRunWorkflow?.(payload)}
              >
                {isWorkflowRunning ? 'Running Workflow...' : readiness.workflowA.ready ? 'Run Workflow A' : <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" />Workflow A</span>}
              </Button>
              <ReadinessHint missing={!isWorkflowRunning ? readiness.workflowA.missing : []} />
            </div>
            <div className="flex flex-col items-start gap-0">
              <Button
                variant="secondary"
                className="text-xs px-3 py-1"
                disabled={isRiskRunning || !readiness.risk.ready}
                title={!readiness.risk.ready ? `Missing: ${readiness.risk.missing.join(', ')}` : undefined}
                onClick={() => onRunRisk?.(payload)}
              >
                {isRiskRunning ? 'Running Risk Scan...' : readiness.risk.ready ? 'Run Risk Scan' : <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" />Risk Scan</span>}
              </Button>
              <ReadinessHint missing={!isRiskRunning ? readiness.risk.missing : []} />
            </div>
          </div>
        </div>

        <CapabilityIndicator capabilities={capabilities} />

        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-slate-200 dark:border-slate-700">
            <thead className="bg-slate-100 dark:bg-slate-700">
              <tr>
                <th className="px-2 py-1 text-left">Sheet</th>
                <th className="px-2 py-1 text-left">Upload Type</th>
                <th className="px-2 py-1 text-left">Confidence</th>
                <th className="px-2 py-1 text-left">Missing Required</th>
                <th className="px-2 py-1 text-left">Validation</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((sheet) => (
                <tr key={`${sheet.sheet_name}-${sheet.upload_type}`} className="border-t border-slate-200 dark:border-slate-700">
                  <td className="px-2 py-1">{sheet.sheet_name}</td>
                  <td className="px-2 py-1">{sheet.upload_type || 'unknown'}</td>
                  <td className="px-2 py-1">{formatPct(sheet.confidence)}</td>
                  <td className="px-2 py-1">
                    {(sheet.missing_required_fields || []).length > 0
                      ? sheet.missing_required_fields.join(', ')
                      : 'None'}
                  </td>
                  <td className="px-2 py-1">
                    {sheet.validation_status === 'pass' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600">
                        <CheckCircle2 className="w-3 h-3" /> pass
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <AlertTriangle className="w-3 h-3" /> fail
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {ignoredSheets.length > 0 && (
          <p className="text-[11px] text-slate-400 italic">
            Skipped non-data sheets: {ignoredSheets.map(s => s.sheet_name).join(', ')}
          </p>
        )}

        {minimalQuestions.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Minimal questions</p>
            <ul className="list-disc list-inside text-xs text-slate-600 dark:text-slate-300 space-y-1">
              {minimalQuestions.map((question, index) => (
                <li key={`${question}-${index}`}>{question}</li>
              ))}
            </ul>
          </div>
        )}

      </div>
    </Card>
  );
}
