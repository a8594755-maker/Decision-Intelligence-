// @product: ai-employee
//
// AIReviewCard.jsx — Renders an AI review result with score gauge and feedback.

import React from 'react';

/**
 * @param {object} props
 * @param {object} props.review - From aiReviewerService.reviewStepOutput()
 * @param {string} [props.stepName] - Name of the step being reviewed
 */
export default function AIReviewCard({ review, stepName }) {
  if (!review) return null;

  const { score, passed, threshold, feedback, categories, suggestions, revision_round, reviewer_model } = review;

  const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  const statusText = passed ? 'Passed' : 'Needs Revision';
  const statusColor = passed ? '#10b981' : '#ef4444';

  const categoryLabels = {
    correctness: 'Correctness',
    completeness: 'Completeness',
    formatting: 'Formatting',
    relevance: 'Relevance',
  };

  return (
    <div style={{
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 16,
      background: passed ? '#f0fdf4' : '#fef2f2',
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 14 }}>AI Review</strong>
          {stepName && <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>{stepName}</span>}
          {revision_round > 1 && (
            <span style={{ marginLeft: 8, fontSize: 11, color: '#f59e0b' }}>Round {revision_round}</span>
          )}
        </div>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: statusColor,
          padding: '2px 10px',
          borderRadius: 12,
          background: passed ? '#dcfce7' : '#fee2e2',
        }}>
          {statusText}
        </span>
      </div>

      {/* Score gauge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: `4px solid ${scoreColor}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: 18,
          color: scoreColor,
        }}>
          {score}
        </div>
        <div style={{ fontSize: 12, color: '#666' }}>
          <div>Threshold: {threshold}</div>
          {reviewer_model && <div>Model: {reviewer_model}</div>}
        </div>
      </div>

      {/* Category scores */}
      {categories && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {Object.entries(categories).map(([key, val]) => (
            <div key={key} style={{
              flex: '1 1 auto',
              minWidth: 80,
              padding: '4px 8px',
              background: '#fff',
              border: '1px solid #eee',
              borderRadius: 6,
              fontSize: 11,
              textAlign: 'center',
            }}>
              <div style={{ color: '#999' }}>{categoryLabels[key] || key}</div>
              <div style={{ fontWeight: 600, color: val >= 70 ? '#10b981' : val >= 50 ? '#f59e0b' : '#ef4444' }}>
                {val}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Feedback */}
      {feedback && (
        <div style={{ fontSize: 13, color: '#374151', marginBottom: 8 }}>
          {feedback}
        </div>
      )}

      {/* Suggestions */}
      {suggestions?.length > 0 && !passed && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#b91c1c', marginBottom: 4 }}>Suggestions:</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#666' }}>
            {suggestions.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
