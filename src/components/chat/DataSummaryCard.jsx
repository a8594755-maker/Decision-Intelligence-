import React from 'react';
import { CheckCircle2, AlertTriangle, Lock } from 'lucide-react';
import { Card, Button, Badge } from '../ui';

const formatPct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

const IGNORED_SHEET_PATTERN = /^(readme|assumptions?|instructions?|guide|notes?|docs?|changelog|cover\s*sheet|template\s*notes?)$/i;

function computeReadiness(sheets = []) {
  const activeTypes = new Set(
    sheets
      .filter(s => s.upload_type && s.upload_type !== 'unknown' && !IGNORED_SHEET_PATTERN.test(s.sheet_name || ''))
      .map(s => s.upload_type)
  );
  const hasDemand = activeTypes.has('demand_fg');
  const hasInventory = activeTypes.has('inventory_snapshots');
  return {
    forecast:  { ready: hasDemand,                   missing: hasDemand ? [] : ['demand_fg'] },
    workflowA: { ready: hasDemand && hasInventory,    missing: [!hasDemand && 'demand_fg', !hasInventory && 'inventory_snapshots'].filter(Boolean) },
    risk:      { ready: hasDemand && hasInventory,    missing: [!hasDemand && 'demand_fg', !hasInventory && 'inventory_snapshots'].filter(Boolean) },
  };
}

function ReadinessHint({ missing }) {
  if (!missing || missing.length === 0) return null;
  return (
    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
      Missing: {missing.join(', ')}
    </p>
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
  if (!payload) return null;

  const workflow = payload.workflow_guess || {};
  const timeRange = payload.time_range_guess || {};
  const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
  const minimalQuestions = Array.isArray(payload.minimal_questions) ? payload.minimal_questions : [];
  const profileId = payload.dataset_profile_id;

  const readiness = computeReadiness(sheets);
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
