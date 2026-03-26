import React, { useMemo, useState } from 'react';
import { Card, Button, Badge } from '../ui';

const formatConfidence = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

export default function ContractConfirmationCard({ payload, onConfirm }) {
  const questions = useMemo(
    () => (Array.isArray(payload?.questions) ? payload.questions : []),
    [payload]
  );
  const initialSelections = useMemo(() => {
    return questions.reduce((acc, item) => {
      const preferred = item.current_type || item.options?.[0]?.upload_type || 'unknown';
      acc[item.sheet_name] = preferred;
      return acc;
    }, {});
  }, [questions]);
  const [selections, setSelections] = useState(initialSelections);
  const initialMappingSelections = useMemo(() => {
    return questions.reduce((acc, item) => {
      const missingFields = Array.isArray(item.missing_required_fields) ? item.missing_required_fields : [];
      const currentMapping = (item.current_mapping && typeof item.current_mapping === 'object') ? item.current_mapping : {};
      acc[item.sheet_name] = missingFields.reduce((sheetAcc, field) => {
        sheetAcc[field] = currentMapping[field] || '';
        return sheetAcc;
      }, {});
      return acc;
    }, {});
  }, [questions]);
  const [mappingSelections, setMappingSelections] = useState(initialMappingSelections);
  const [confirmed, setConfirmed] = useState(false);

  if (!payload || questions.length === 0) return null;

  return (
    <Card category="system" className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Contract Confirmation</h4>
          <Badge type="warning">Low confidence</Badge>
        </div>

        <p className="text-xs text-[var(--text-secondary)]">
          Confirm inferred roles before running execution. Only ambiguous sheets are shown.
        </p>

        <div className="space-y-2">
          {questions.map((question) => (
            <div key={question.sheet_name} className="rounded-lg border border-[var(--border-default)] p-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">{question.sheet_name}</p>
                <span className="text-xs text-[var(--text-muted)]">
                  confidence {formatConfidence(question.confidence)}
                </span>
              </div>
              <select
                className="mt-2 w-full text-xs px-2 py-1 rounded border border-[var(--border-default)] bg-transparent"
                value={selections[question.sheet_name] || question.current_type || 'unknown'}
                onChange={(event) => {
                  setSelections((prev) => ({
                    ...prev,
                    [question.sheet_name]: event.target.value
                  }));
                }}
                disabled={confirmed}
              >
                {(question.options || []).map((option) => (
                  <option key={`${question.sheet_name}_${option.upload_type}`} value={option.upload_type}>
                    {option.upload_type} ({formatConfidence(option.confidence)})
                  </option>
                ))}
              </select>

              {(question.missing_required_fields || []).length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Mapping Repair (missing required fields)
                  </p>
                  {(question.missing_required_fields || []).map((field) => (
                    <div key={`${question.sheet_name}_${field}`} className="grid grid-cols-1 md:grid-cols-2 gap-1 items-center">
                      <span className="text-[11px] text-[var(--text-secondary)]">{field}</span>
                      <select
                        className="text-xs px-2 py-1 rounded border border-[var(--border-default)] bg-transparent"
                        value={mappingSelections?.[question.sheet_name]?.[field] || ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          setMappingSelections((prev) => ({
                            ...prev,
                            [question.sheet_name]: {
                              ...(prev[question.sheet_name] || {}),
                              [field]: value
                            }
                          }));
                        }}
                        disabled={confirmed}
                      >
                        <option value="">Select column...</option>
                        {(question.available_columns || []).map((column) => (
                          <option key={`${question.sheet_name}_${field}_${column}`} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <Button
            variant={confirmed ? 'secondary' : 'primary'}
            className="text-xs"
            disabled={confirmed}
            onClick={() => {
              onConfirm?.({
                dataset_profile_id: payload.dataset_profile_id,
                selections,
                mapping_selections: mappingSelections
              });
              setConfirmed(true);
            }}
          >
            {confirmed ? 'Confirmed' : 'Confirm Mapping'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
