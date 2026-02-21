import React from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, Button, Badge } from '../ui';

const formatPct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

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
          <div className="flex items-center gap-2">
            <Badge type="info">Profile #{profileId || 'N/A'}</Badge>
            <Button
              variant={isContextSelected ? 'secondary' : 'primary'}
              className="text-xs px-3 py-1"
              onClick={() => onUseContext?.(payload)}
            >
              {isContextSelected ? 'Context Selected' : 'Use this dataset context'}
            </Button>
            <Button
              variant="secondary"
              className="text-xs px-3 py-1"
              disabled={isForecastRunning}
              onClick={() => onRunForecast?.(payload)}
            >
              {isForecastRunning ? 'Running Forecast...' : 'Run Forecast'}
            </Button>
            <Button
              variant="secondary"
              className="text-xs px-3 py-1"
              disabled={isWorkflowRunning}
              onClick={() => onRunWorkflow?.(payload)}
            >
              {isWorkflowRunning ? 'Running Workflow...' : 'Run Workflow A'}
            </Button>
            <Button
              variant="secondary"
              className="text-xs px-3 py-1"
              disabled={isRiskRunning}
              onClick={() => onRunRisk?.(payload)}
            >
              {isRiskRunning ? 'Running Risk Scan...' : 'Run Risk Scan'}
            </Button>
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
