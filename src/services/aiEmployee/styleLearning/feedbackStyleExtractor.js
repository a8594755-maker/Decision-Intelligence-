/**
 * Feedback → Style Rule Extractor
 *
 * Analyzes manager revision patterns to automatically extract style rules.
 * When a manager repeatedly makes similar corrections, the system identifies
 * the pattern and creates a formal style rule.
 *
 * Pipeline:
 *   1. Collect manager feedback + revisions from task memory
 *   2. Cluster similar feedback into themes
 *   3. Extract rules when evidence_count >= threshold
 *   4. Store rules in style_feedback_rules table
 *   5. Optionally promote rules to style_policies after verification
 */
import { supabase } from '../../supabaseClient.js';

const RULES_TABLE = 'style_feedback_rules';
const MEMORY_TABLE = 'ai_employee_task_memory';

const MIN_EVIDENCE_FOR_RULE = 3;        // minimum revision occurrences to create a rule
const MIN_CONFIDENCE_FOR_PROMOTION = 0.75;  // minimum confidence to auto-promote to policy

// ─── Rule Types ──────────────────────────────────────────────

export const RULE_TYPES = {
  STRUCTURE:   'structure',    // sheet layout, section ordering
  FORMATTING:  'formatting',   // colors, fonts, number formats
  WORDING:     'wording',      // specific word choices, phrases
  DATA:        'data',         // data presentation, rounding, units
  KPI:         'kpi',          // KPI definitions, targets, display
  CHART:       'chart',        // chart types, colors, labels
  TONE:        'tone',         // formality, voice, language
};

// ─── Extract Rules from Feedback History ─────────────────────

/**
 * Analyze all manager feedback for an employee and extract/update style rules.
 * This is the main entry point, typically called periodically or after N new feedbacks.
 *
 * @param {string} employeeId
 * @param {Function} llmFn - async (prompt) => string
 * @param {object} [opts]
 * @param {number} [opts.lookbackDays=90] - how far back to look
 * @returns {{ newRules: Array, updatedRules: Array, totalFeedbacks: number }}
 */
export async function extractRulesFromFeedback(employeeId, llmFn, opts = {}) {
  const lookbackDays = opts.lookbackDays || 90;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  // 1. Fetch all feedback entries
  const feedbacks = await fetchFeedbacks(employeeId, since);
  if (!feedbacks.length) return { newRules: [], updatedRules: [], totalFeedbacks: 0 };

  // 2. Cluster feedback into themes using LLM
  const clusters = await clusterFeedback(feedbacks, llmFn);

  // 3. For each cluster with enough evidence, create or update rules
  const existingRules = await listRules(employeeId, { activeOnly: false });
  const newRules = [];
  const updatedRules = [];

  for (const cluster of clusters) {
    if (cluster.evidence_count < MIN_EVIDENCE_FOR_RULE) continue;

    // Check if a similar rule already exists
    const existing = findSimilarRule(existingRules, cluster);
    if (existing) {
      // Update evidence count and confidence
      const updated = await updateRuleEvidence(existing.id, {
        evidence_count: existing.evidence_count + cluster.evidence_count,
        evidence_task_ids: [...new Set([...(existing.evidence_task_ids || []), ...cluster.task_ids])],
        confidence: Math.min(0.99, existing.confidence + 0.05 * cluster.evidence_count),
      });
      updatedRules.push(updated);
    } else {
      // Create new rule
      const rule = await createRule({
        employeeId,
        ruleType: cluster.rule_type,
        ruleText: cluster.rule_text,
        ruleStructured: cluster.structured || {},
        evidenceCount: cluster.evidence_count,
        evidenceTaskIds: cluster.task_ids,
        confidence: Math.min(0.95, 0.4 + 0.1 * cluster.evidence_count),
      });
      newRules.push(rule);
    }
  }

  return { newRules, updatedRules, totalFeedbacks: feedbacks.length };
}

/**
 * Extract rules from a single revision event (real-time extraction).
 * Called immediately when a manager revises a task output.
 *
 * @param {string} employeeId
 * @param {string} taskId
 * @param {object} revision - { original, revised, feedback, workflowType }
 * @param {Function} llmFn
 */
export async function extractFromSingleRevision(employeeId, taskId, revision, llmFn) {
  if (!llmFn) return [];

  const prompt = `A manager revised an AI employee's output. Analyze the revision and identify style rules the AI should learn.

Original output summary: ${JSON.stringify(revision.original || '').slice(0, 1500)}
Revised output summary: ${JSON.stringify(revision.revised || '').slice(0, 1500)}
Manager feedback: ${revision.feedback || 'none'}
Workflow type: ${revision.workflowType || 'unknown'}

For each style lesson, return a JSON array of objects:
- rule_type: one of "structure", "formatting", "wording", "data", "kpi", "chart", "tone"
- rule_text: the rule in natural language (what the AI should do differently)
- structured: optional JSON with machine-readable rule details

Return ONLY valid JSON array. If no clear lessons, return [].`;

  try {
    const raw = await llmFn(prompt);
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    if (!Array.isArray(parsed)) return [];

    const rules = [];
    for (const r of parsed) {
      if (!r.rule_text) continue;

      // Check if similar rule exists, update evidence
      const existing = await findExistingRule(employeeId, r.rule_type, r.rule_text);
      if (existing) {
        const updated = await updateRuleEvidence(existing.id, {
          evidence_count: existing.evidence_count + 1,
          evidence_task_ids: [...new Set([...(existing.evidence_task_ids || []), taskId])],
          confidence: Math.min(0.99, existing.confidence + 0.05),
        });
        rules.push(updated);
      } else {
        const rule = await createRule({
          employeeId,
          ruleType: r.rule_type || 'custom',
          ruleText: r.rule_text,
          ruleStructured: r.structured || {},
          evidenceCount: 1,
          evidenceTaskIds: [taskId],
          confidence: 0.40,
        });
        rules.push(rule);
      }
    }
    return rules;
  } catch (err) {
    console.error('[FeedbackStyleExtractor] single revision extraction failed:', err);
    return [];
  }
}

// ─── Clustering ──────────────────────────────────────────────

async function clusterFeedback(feedbacks, llmFn) {
  if (!llmFn) return clusterFeedbackDeterministic(feedbacks);

  const feedbackSummary = feedbacks.map(f => ({
    task_id: f.task_id,
    workflow_type: f.workflow_type,
    feedback: f.manager_feedback,
    decision: f.manager_decision,
  }));

  const prompt = `Analyze the following manager feedback entries from an AI employee's task history. Cluster them into recurring themes/patterns.

Feedback entries:
${JSON.stringify(feedbackSummary.slice(0, 30), null, 2)}

For each cluster/theme, return:
- rule_type: one of "structure", "formatting", "wording", "data", "kpi", "chart", "tone"
- rule_text: a clear rule the AI should follow (natural language)
- structured: optional JSON for machine-readable version
- evidence_count: how many feedback entries support this pattern
- task_ids: array of task_ids in this cluster

Return ONLY valid JSON array. Group similar feedback into a single cluster.`;

  try {
    const raw = await llmFn(prompt);
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return clusterFeedbackDeterministic(feedbacks);
  }
}

/**
 * Deterministic fallback clustering using keyword matching.
 */
function clusterFeedbackDeterministic(feedbacks) {
  const clusters = {};

  const KEYWORD_MAP = {
    [RULE_TYPES.FORMATTING]: ['format', 'color', 'font', 'bold', 'align', '格式', '顏色', '字體'],
    [RULE_TYPES.WORDING]: ['word', 'phrase', 'name', 'term', 'label', '用語', '名稱', '詞'],
    [RULE_TYPES.STRUCTURE]: ['order', 'layout', 'section', 'sheet', 'move', '排列', '版面', '順序'],
    [RULE_TYPES.DATA]: ['number', 'decimal', 'round', 'unit', 'percent', '數字', '單位', '小數'],
    [RULE_TYPES.KPI]: ['kpi', 'metric', 'target', 'goal', '指標', '目標', '達成'],
    [RULE_TYPES.CHART]: ['chart', 'graph', 'axis', 'legend', '圖表', '圖', '軸'],
    [RULE_TYPES.TONE]: ['tone', 'formal', 'casual', 'voice', '語氣', '正式'],
  };

  for (const f of feedbacks) {
    const text = (f.manager_feedback || '').toLowerCase();
    if (!text) continue;

    for (const [type, keywords] of Object.entries(KEYWORD_MAP)) {
      if (keywords.some(kw => text.includes(kw))) {
        if (!clusters[type]) clusters[type] = { rule_type: type, feedbacks: [], task_ids: [] };
        clusters[type].feedbacks.push(text);
        clusters[type].task_ids.push(f.task_id);
      }
    }
  }

  return Object.values(clusters).map(c => ({
    rule_type: c.rule_type,
    rule_text: `Manager frequently corrects ${c.rule_type} issues (${c.feedbacks.length} occurrences). Sample: "${c.feedbacks[0]?.slice(0, 100)}"`,
    evidence_count: c.feedbacks.length,
    task_ids: c.task_ids,
  }));
}

// ─── CRUD ────────────────────────────────────────────────────

async function createRule({ employeeId, teamId, ruleType, ruleText, ruleStructured, evidenceCount, evidenceTaskIds, confidence }) {
  const row = {
    employee_id: employeeId,
    team_id: teamId || null,
    rule_type: ruleType,
    rule_text: ruleText,
    rule_structured: ruleStructured || {},
    evidence_count: evidenceCount || 1,
    evidence_task_ids: evidenceTaskIds || [],
    confidence: confidence || 0.50,
    auto_extracted: true,
  };

  const { data, error } = await supabase.from(RULES_TABLE).insert(row).select().single();
  if (error) throw new Error(`createRule failed: ${error.message}`);
  return data;
}

async function updateRuleEvidence(ruleId, updates) {
  const { data, error } = await supabase
    .from(RULES_TABLE)
    .update(updates)
    .eq('id', ruleId)
    .select()
    .single();
  if (error) throw new Error(`updateRuleEvidence failed: ${error.message}`);
  return data;
}

export async function listRules(employeeId, { ruleType, activeOnly = true } = {}) {
  let query = supabase
    .from(RULES_TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .order('confidence', { ascending: false });

  if (activeOnly) query = query.eq('active', true);
  if (ruleType) query = query.eq('rule_type', ruleType);

  const { data, error } = await query;
  if (error) throw new Error(`listRules failed: ${error.message}`);
  return data || [];
}

export async function verifyRule(ruleId, userId) {
  const { data, error } = await supabase
    .from(RULES_TABLE)
    .update({ verified_by: userId, verified_at: new Date().toISOString() })
    .eq('id', ruleId)
    .select()
    .single();
  if (error) throw new Error(`verifyRule failed: ${error.message}`);
  return data;
}

export async function deactivateRule(ruleId) {
  const { error } = await supabase.from(RULES_TABLE).update({ active: false }).eq('id', ruleId);
  if (error) throw new Error(`deactivateRule failed: ${error.message}`);
}

/**
 * Get all high-confidence rules ready for promotion to policies.
 */
export async function getRulesReadyForPromotion(employeeId) {
  const { data, error } = await supabase
    .from(RULES_TABLE)
    .select('*')
    .eq('employee_id', employeeId)
    .eq('active', true)
    .gte('confidence', MIN_CONFIDENCE_FOR_PROMOTION)
    .gte('evidence_count', MIN_EVIDENCE_FOR_RULE)
    .is('verified_by', null) // not yet verified/promoted
    .order('confidence', { ascending: false });

  if (error) throw new Error(`getRulesReadyForPromotion failed: ${error.message}`);
  return data || [];
}

/**
 * Build a rules summary for LLM context injection.
 */
export function buildRulesSummary(rules) {
  if (!rules.length) return '';

  const lines = ['=== Learned Style Rules (from manager feedback) ==='];
  for (const r of rules) {
    const verified = r.verified_by ? ' [verified]' : '';
    lines.push(`- [${r.rule_type}] ${r.rule_text} (confidence: ${r.confidence}, evidence: ${r.evidence_count})${verified}`);
  }
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────

async function fetchFeedbacks(employeeId, since) {
  const { data, error } = await supabase
    .from(MEMORY_TABLE)
    .select('task_id, workflow_type, manager_decision, manager_feedback')
    .eq('employee_id', employeeId)
    .not('manager_feedback', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[FeedbackStyleExtractor] fetch failed:', error);
    return [];
  }
  return data || [];
}

function findSimilarRule(existingRules, cluster) {
  return existingRules.find(r =>
    r.rule_type === cluster.rule_type &&
    textSimilarity(r.rule_text, cluster.rule_text) > 0.6
  );
}

async function findExistingRule(employeeId, ruleType, ruleText) {
  const rules = await listRules(employeeId, { ruleType });
  return rules.find(r => textSimilarity(r.rule_text, ruleText) > 0.6);
}

/**
 * Simple text similarity (Jaccard on word sets).
 */
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export const _testExports = { clusterFeedbackDeterministic, textSimilarity, findSimilarRule, MIN_EVIDENCE_FOR_RULE };
