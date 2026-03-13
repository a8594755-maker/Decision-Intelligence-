// @product: ai-employee
//
// RevisionLogCard.jsx — Displays the full revision history for a task step.
// Shows each round's score, feedback, difficulties, and fixes.

import React, { useState } from 'react';

/**
 * @param {object} props
 * @param {object} props.revisionLog - From aiReviewerService.buildRevisionLog()
 * @param {string} [props.stepName] - The step name
 */
export default function RevisionLogCard({ revisionLog, stepName }) {
  const [expanded, setExpanded] = useState(false);

  if (!revisionLog?.rounds?.length) return null;

  const { total_rounds, final_score, rounds } = revisionLog;
  const allPassed = rounds[rounds.length - 1]?.passed !== false;

  return (
    <div style={{
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 16,
      background: '#fafbff',
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 14 }}>Revision Log</strong>
          {stepName && <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>{stepName}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>
            {total_rounds} round{total_rounds > 1 ? 's' : ''}
          </span>
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '2px 10px',
            borderRadius: 12,
            background: allPassed ? '#dcfce7' : '#fee2e2',
            color: allPassed ? '#15803d' : '#b91c1c',
          }}>
            Final: {final_score}
          </span>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {rounds.slice(0, expanded ? undefined : 3).map((round, i) => {
          const scoreColor = round.score >= 70 ? '#10b981' : round.score >= 50 ? '#f59e0b' : '#ef4444';
          const isLast = i === rounds.length - 1;

          return (
            <div key={i} style={{ display: 'flex', gap: 12, position: 'relative' }}>
              {/* Timeline line */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 20 }}>
                <div style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: scoreColor,
                  border: '2px solid #fff',
                  boxShadow: '0 0 0 1px ' + scoreColor,
                  zIndex: 1,
                  marginTop: 4,
                }} />
                {!isLast && (
                  <div style={{ width: 2, flex: 1, background: '#e2e8f0', marginTop: 2 }} />
                )}
              </div>

              {/* Content */}
              <div style={{
                flex: 1,
                paddingBottom: isLast ? 0 : 12,
                fontSize: 13,
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>Round {round.round || i + 1}</span>
                  <span style={{ color: scoreColor, fontWeight: 600 }}>Score: {round.score}</span>
                  {round.threshold && (
                    <span style={{ color: '#999', fontSize: 11 }}>/ {round.threshold}</span>
                  )}
                  {round.passed && <span style={{ color: '#10b981', fontSize: 11 }}>Passed</span>}
                </div>

                {round.feedback && (
                  <div style={{ color: '#4b5563', fontSize: 12, marginBottom: 4 }}>
                    {round.feedback}
                  </div>
                )}

                {round.difficulty && (
                  <div style={{ fontSize: 11, color: '#b45309', background: '#fef3c7', padding: '2px 6px', borderRadius: 4, display: 'inline-block', marginBottom: 4 }}>
                    Difficulty: {round.difficulty}
                  </div>
                )}

                {round.fix_applied && (
                  <div style={{ fontSize: 11, color: '#15803d', background: '#f0fdf4', padding: '2px 6px', borderRadius: 4, display: 'inline-block' }}>
                    Fix: {round.fix_applied}
                  </div>
                )}

                {round.suggestions?.length > 0 && !round.passed && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11, color: '#666' }}>
                    {round.suggestions.map((s, j) => <li key={j}>{s}</li>)}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {rounds.length > 3 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ marginTop: 6, fontSize: 12, color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {expanded ? 'Show less' : `Show all ${rounds.length} rounds`}
        </button>
      )}
    </div>
  );
}
