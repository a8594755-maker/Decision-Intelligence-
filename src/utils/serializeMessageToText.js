// ============================================
// serializeMessageToText — converts chat message payloads into plain text
// for clipboard copy. Handles agent_response with brief, thinking, QA,
// execution traces, and all sub-components.
// ============================================

/**
 * Serialize an evidence table to text (markdown-style table).
 */
function serializeTable(table) {
  if (!table || !Array.isArray(table.columns) || table.columns.length === 0) return '';
  const lines = [];
  if (table.title) lines.push(table.title);

  const cols = table.columns;
  const rows = table.rows || [];

  // Header
  lines.push(cols.join('\t'));

  // Rows
  for (const row of rows) {
    lines.push(row.map((v) => String(v ?? '')).join('\t'));
  }
  return lines.join('\n');
}

/**
 * Serialize chart data to a text table.
 */
function serializeChart(chart) {
  if (!chart || !Array.isArray(chart.data)) return '';
  const lines = [];
  if (chart.title) lines.push(`Chart: ${chart.title}`);

  const xKey = chart.xKey || 'x';
  const yKey = chart.yKey || 'y';

  // Detect all keys from the first data point
  const keys = chart.data.length > 0
    ? Object.keys(chart.data[0])
    : [xKey, yKey];

  lines.push(keys.join('\t'));
  for (const row of chart.data) {
    lines.push(keys.map((k) => String(row[k] ?? '')).join('\t'));
  }
  return lines.join('\n');
}

/**
 * Serialize a bullet list section (key_findings, implications, etc.)
 */
function serializeBulletSection(title, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = [title];
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

/**
 * Serialize metric pills.
 */
function serializeMetricPills(pills) {
  if (!Array.isArray(pills) || pills.length === 0) return '';
  return pills
    .filter((p) => p?.label && p?.value != null)
    .map((p) => `${p.label}\n${p.value}`)
    .join('\n');
}

/**
 * Serialize the AgentBrief section.
 */
function serializeBrief(brief, attribution) {
  if (!brief) return '';
  const lines = ['Agent Brief'];

  if (attribution) {
    const attrText = [attribution.label, attribution.provider, attribution.model].filter(Boolean).join(' · ');
    if (attrText) lines.push(attrText);
  }

  if (brief.headline) lines.push(brief.headline);
  if (brief.summary) lines.push(brief.summary);

  lines.push('');

  // Metric pills
  const pillsText = serializeMetricPills(brief.metric_pills);
  if (pillsText) lines.push(pillsText, '');

  // Charts
  const charts = Array.isArray(brief.charts) ? brief.charts.filter((c) => c?.type && Array.isArray(c?.data)) : [];
  for (const chart of charts) {
    lines.push(serializeChart(chart), '');
  }

  // Evidence tables
  const tables = Array.isArray(brief.tables) ? brief.tables.filter(Boolean) : [];
  if (tables.length > 0) {
    lines.push('Evidence');
    for (const table of tables) {
      lines.push(serializeTable(table), '');
    }
  }

  // Bullet sections
  const sections = [
    ['Key Findings', brief.key_findings],
    ['Implications', brief.implications],
    ['Caveats', brief.caveats],
    ['Next Steps', brief.next_steps],
  ];
  for (const [title, items] of sections) {
    const text = serializeBulletSection(title, items);
    if (text) lines.push(text, '');
  }

  return lines.join('\n');
}

/**
 * Serialize thinking steps.
 */
function serializeThinkingSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';

  const lines = ['Thinking'];

  // Group by agent
  const groups = {};
  for (const step of steps) {
    const key = step.agentKey || 'default';
    if (!groups[key]) {
      groups[key] = {
        label: step.agentLabel || 'Agent',
        provider: step.provider || '',
        model: step.model || '',
        status: '',
        steps: [],
      };
    }
    if (step.status) groups[key].status = step.status;
    groups[key].steps.push(step);
  }

  for (const group of Object.values(groups)) {
    const header = [group.label, group.provider, group.model].filter(Boolean).join(' · ');
    lines.push(header);
    if (group.status) lines.push(`Status: ${group.status}`);
    for (let i = 0; i < group.steps.length; i++) {
      lines.push(`${i + 1}\n${group.steps[i].content}`);
    }
    lines.push('');
  }

  lines.push('Reasoning complete');
  return lines.join('\n');
}

/**
 * Serialize QA card.
 */
function serializeQA(qa, judgeDecision) {
  if (!qa) return '';

  const lines = ['Answer Quality'];

  const statusLine = [
    qa.status,
    `Score ${Number(qa.score || 0).toFixed(1)} / ${Number(qa.pass_threshold || 8).toFixed(1)}`,
    qa.repair_attempted ? 'Repair executed' : 'No repair needed',
    judgeDecision?.winnerLabel ? `Winner: ${judgeDecision.winnerLabel}` : null,
  ].filter(Boolean).join('\n');
  lines.push(statusLine);

  // Dimension scores
  const DIMENSIONS = {
    correctness: 'Correctness',
    completeness: 'Completeness',
    evidence_alignment: 'Evidence',
    visualization_fit: 'Viz Fit',
    caveat_quality: 'Caveats',
    clarity: 'Clarity',
  };
  const dimScores = qa.dimension_scores || {};
  const dimLines = Object.entries(DIMENSIONS)
    .map(([key, label]) => {
      const v = dimScores[key];
      return `${label}\n${v == null ? 'N/A' : Number(v).toFixed(1)}`;
    })
    .join('\n');
  lines.push(dimLines);

  // Issues
  const issues = Array.isArray(qa.issues) ? qa.issues.filter(Boolean) : [];
  if (issues.length > 0) {
    lines.push('Top Issues');
    for (const issue of issues.slice(0, 3)) {
      lines.push(`- ${issue}`);
    }
  }

  // Judge
  if (judgeDecision) {
    lines.push('Judge Verdict');
    const verdictParts = [
      judgeDecision.summary,
      ...(Array.isArray(judgeDecision.rationale) ? judgeDecision.rationale.slice(0, 3) : []),
    ].filter(Boolean);
    lines.push(verdictParts.join('\n'));

    const reviewerAttr = [judgeDecision?.reviewer?.provider, judgeDecision?.reviewer?.model].filter(Boolean).join(' · ');
    if (reviewerAttr) lines.push(reviewerAttr);
  }

  // Reviewers
  const reviewers = Array.isArray(qa.reviewers) ? qa.reviewers : [];
  if (reviewers.length > 0) {
    lines.push('Reviewer Details');
    for (const r of reviewers) {
      const rHeader = [
        r.stage === 'cross_model' ? 'Cross-model' : 'Self-review',
        r.provider,
        r.model,
      ].filter(Boolean).join('\n');
      const rScore = `Score ${Number(r.score || 0).toFixed(1)}`;
      lines.push(`${rHeader}\n${rScore}`);
      if (Array.isArray(r.issues) && r.issues.length > 0) {
        for (const issue of r.issues) {
          lines.push(`- ${issue}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Serialize execution trace.
 */
function serializeTrace(trace, agentLabel) {
  if (!trace) return '';

  const failed = Array.isArray(trace.failed_attempts) ? trace.failed_attempts : [];
  const success = Array.isArray(trace.successful_queries) ? trace.successful_queries : [];
  const narrative = typeof trace.raw_narrative === 'string' ? trace.raw_narrative.trim() : '';

  if (failed.length + success.length === 0 && !narrative) return '';

  const lines = [];
  const title = agentLabel ? `Execution Trace — ${agentLabel}` : 'Execution Trace';
  lines.push(title);
  lines.push(`${failed.length} failed • ${success.length} successful`);

  if (failed.length > 0) {
    lines.push('Failed Attempts');
    for (const a of failed) {
      const category = String(a?.category || '').trim().replace(/_/g, ' ');
      lines.push('');
      lines.push(a?.name || 'tool');
      lines.push(category ? `failed · ${category}` : 'failed');
      if (a?.error) lines.push(a.error);
      if (a?.sql) lines.push(`\n${a.sql}`);
    }
  }

  if (success.length > 0) {
    lines.push('Successful Steps');
    for (const a of success) {
      lines.push('');
      lines.push(a?.name || 'tool');
      if (a?.rowCount > 0) lines.push(`${a.rowCount} rows`);
      if (a?.summary) lines.push(a.summary);
      if (a?.sql) lines.push(`\n${a.sql}`);
    }
  }

  if (narrative) {
    lines.push('');
    lines.push('Full Narrative');
    lines.push(narrative);
  }

  return lines.join('\n');
}

/**
 * Serialize alternative candidate.
 */
function serializeAlternative(candidate) {
  if (!candidate) return '';
  const lines = ['Alternative Answer'];
  lines.push([candidate.label, candidate.provider, candidate.model].filter(Boolean).join(' · '));

  const status = candidate.status || 'completed';
  lines.push(`Status: ${status === 'timed_out' ? 'timed out' : status}`);

  if (candidate.brief) {
    lines.push('', serializeBrief(candidate.brief));
  } else if (candidate.failedReason) {
    lines.push(candidate.failedReason);
  }

  if (candidate.trace) {
    lines.push('', serializeTrace(candidate.trace));
  }

  return lines.join('\n');
}

/**
 * Main entry: serialize an agent_response message to plain text.
 */
export function serializeAgentResponseToText(message) {
  if (!message) return '';

  const payload = message.payload || {};
  const brief = payload.brief || null;
  const qa = payload.qa || null;
  const judgeDecision = payload.judgeDecision || null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const trace = payload.trace || null;
  const thinkingSteps = payload.thinkingSteps || null;

  const alternativeCandidate = judgeDecision?.winnerCandidateId && candidates.length > 1
    ? (candidates.find((c) => c?.candidateId !== judgeDecision?.winnerCandidateId) || null)
    : null;
  const winnerCandidate = judgeDecision?.winnerCandidateId
    ? candidates.find((c) => c?.candidateId === judgeDecision.winnerCandidateId) || null
    : (candidates[0] || null);

  const attribution = {
    label: judgeDecision?.winnerLabel || winnerCandidate?.label || '',
    provider: winnerCandidate?.provider || judgeDecision?.winnerProvider || '',
    model: winnerCandidate?.model || judgeDecision?.winnerModel || '',
  };

  const sections = [];

  // Thinking steps
  if (thinkingSteps) {
    sections.push(serializeThinkingSteps(thinkingSteps));
  }

  // Brief
  if (brief) {
    sections.push(serializeBrief(brief, attribution));
  }

  // QA
  if (qa) {
    sections.push(serializeQA(qa, judgeDecision));
  }

  // Alternative
  if (alternativeCandidate) {
    sections.push(serializeAlternative(alternativeCandidate));
  }

  // Execution traces (multi-candidate or single)
  const hasMultipleCandidates = candidates.length > 1;
  if (hasMultipleCandidates) {
    for (const c of candidates.filter((c) => c?.trace)) {
      const label = [c.label, c.provider, c.model].filter(Boolean).join(' · ');
      sections.push(serializeTrace(c.trace, label));
    }
  } else if (trace) {
    const winnerLabel = winnerCandidate
      ? [winnerCandidate.label, winnerCandidate.provider, winnerCandidate.model].filter(Boolean).join(' · ')
      : '';
    sections.push(serializeTrace(trace, winnerLabel));
  }

  // Markdown content
  if (message.content) {
    sections.push(message.content);
  }

  return sections.filter(Boolean).join('\n\n---\n\n');
}

/**
 * Serialize a plain chat message (user or AI text) to copyable text.
 */
export function serializePlainMessageToText(message) {
  if (!message) return '';
  return message.content || '';
}
